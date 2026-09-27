import { FIXED_DT, LAYER_MOVING, LAYER_NON_MOVING, solver } from './jolt';
import { ENGINE_CAPACITY, getEngine, type Engine } from './engine';
import type { Joint, Part, SceneDoc } from '../scene/types';
import {
  dot,
  length as vlen,
  normalize,
  quatConjugate,
  quatMul,
  quatRotate,
  scale as vscale,
  sub,
  type Quat,
  type Vec3,
} from '../core/math';

/* Jolt's WebIDL surface is effectively untyped; this is the one place where
 * `any` is pragmatic, and every call here is covered by scripts/integration.ts. */
type Any = any;

interface PartRuntime {
  id: string;
  index: number;
  kind: Part['kind'];
  plane: number;
  fixed: boolean;
  dofs: 'plane2d' | 'free';
  body: Any;
}

interface JointRuntime {
  id: string;
  kind: Joint['kind'];
  a: PartRuntime | null;
  b: PartRuntime;
  constraint: Any;
  /** Hinge actuator for a pin, slider actuator for a slider. */
  actuator: Any | null;
  axis: Vec3;
  /** Radians for rotational joints, metres for sliders. */
  value: number;
  prevRaw: number | null;
  speed: number;
  forceN: number;
  torqueNm: number;
}

export interface JointMetric {
  id: string;
  kind: Joint['kind'];
  value: number;
  speed: number;
  forceN: number;
  torqueNm: number;
}

interface Grip {
  part: PartRuntime;
  /** Grab point in the body's local frame. */
  localOffset: Vec3;
  target: Vec3;
  maxSpeed: number;
}

/**
 * Physics shapes are cached and reference-held for the lifetime of the engine.
 *
 * Two reasons. Correctness: `new Jolt.BoxShape()` starts at reference count 0, so
 * without an AddRef the shape is freed as soon as its last body is destroyed and
 * the next CreateBody reads freed memory. Speed: a rebuild then reuses shapes
 * instead of reallocating them, and identical parts share one shape.
 */
const shapeCache = new Map<string, Any>();

/** Allocation-free scratch slots. Setters copy, so slots can be reused freely. */
class Scratch {
  readonly v1: Any;
  readonly v2: Any;
  readonly rv1: Any;
  readonly rv2: Any;
  readonly q1: Any;

  constructor(Jolt: Any) {
    this.v1 = new Jolt.Vec3(0, 0, 0);
    this.v2 = new Jolt.Vec3(0, 0, 0);
    this.rv1 = new Jolt.RVec3(0, 0, 0);
    this.rv2 = new Jolt.RVec3(0, 0, 0);
    this.q1 = new Jolt.Quat(0, 0, 0, 1);
  }

  vec(slot: 'v1' | 'v2', x: number, y: number, z: number): Any {
    const o = this[slot];
    o.Set(x, y, z);
    return o;
  }

  rvec(slot: 'rv1' | 'rv2', x: number, y: number, z: number): Any {
    const o = this[slot];
    o.Set(x, y, z);
    return o;
  }

  quat(x: number, y: number, z: number, w: number): Any {
    this.q1.Set(x, y, z, w);
    return this.q1;
  }
}

/** Signed angle of a quaternion about an arbitrary unit axis. */
function angleAboutAxis(q: Quat, axis: Vec3): number {
  return 2 * Math.atan2(dot([q[0], q[1], q[2]], axis), q[3]);
}

/** Jolt's sentinel for "no limit". */
const UNLIMITED = 1e30;

const round5 = (x: number) => Math.round(x * 1e5) / 1e5;

function linkShape(Jolt: Any, length: number, width: number, thickness: number, density: number): Any {
  const key = `box:${round5(length)}:${round5(width)}:${round5(thickness)}:${round5(density)}`;
  const hit = shapeCache.get(key);
  if (hit) return hit;
  const half: [number, number, number] = [
    Math.max(1e-4, length / 2),
    Math.max(1e-4, width / 2),
    Math.max(1e-4, thickness / 2),
  ];
  const convexRadius = Math.min(0.001, Math.min(...half) * 0.2);
  const shape = new Jolt.BoxShape(new Jolt.Vec3(half[0], half[1], half[2]), convexRadius, undefined);
  // Density lives on the shape, so it is baked in at creation and forms part of
  // the cache key. Setting it per part instead would silently apply the last
  // value written to every body sharing that shape.
  shape.SetDensity(density);
  shape.AddRef();
  shapeCache.set(key, shape);
  return shape;
}

/**
 * Round parts share one physics shape: a cylinder whose axis is body-local Z, so
 * the authored rotation and the hinge axis agree. Gear teeth are visual only, and
 * inertia from a solid disc is the right idealisation anyway.
 */
function cylinderShape(Jolt: Any, radius: number, thickness: number, density: number): Any {
  const key = `cyl:${round5(radius)}:${round5(thickness)}:${round5(density)}`;
  const hit = shapeCache.get(key);
  if (hit) return hit;

  const halfHeight = Math.max(1e-4, thickness / 2);
  const convexRadius = Math.min(0.0005, halfHeight * 0.2);
  // Shapes built from settings come back without Shape methods (no SetDensity),
  // so density has to be set on the convex settings before Create.
  const settings = new Jolt.CylinderShapeSettings(halfHeight, Math.max(1e-4, radius), convexRadius, undefined);
  settings.mDensity = density;
  // Rotate the cylinder's native Y axis onto body-local Z, so the axle matches the
  // hinge axis and the authored rotation.
  const rotated = new Jolt.RotatedTranslatedShapeSettings(
    new Jolt.Vec3(0, 0, 0),
    new Jolt.Quat(0.7071067811865476, 0, 0, 0.7071067811865476),
    settings,
  );
  const shape = rotated.Create().Get();
  shape.AddRef();
  // The settings chain is deliberately left alone: these are RefTarget subclasses
  // whose lifetime is entangled with the shape they produced.
  shapeCache.set(key, shape);
  return shape;
}

export class SimWorld {
  readonly parts: PartRuntime[] = [];
  private readonly partIndex = new Map<string, PartRuntime>();
  private readonly joints: JointRuntime[] = [];
  private readonly jointIndex = new Map<string, JointRuntime>();

  /** 7 floats per part: x, y, z, qx, qy, qz, qw. */
  readonly poses: Float32Array;

  gravity: number;
  gravityOn: boolean;
  blownUp = false;

  private readonly Jolt: Any;
  private readonly jolt: Any;
  private readonly system: Any;
  private readonly bi: Any;
  private readonly scratch: Scratch;

  /** Temporaries whose assignment semantics are unverified; kept alive, not freed. */
  private readonly keepAlive: Any[] = [];

  private ground: Any = null;
  private floor: Any = null;
  private grip: Grip | null = null;
  private disposed = false;

  private constructor(doc: SceneDoc, engine: Engine) {
    this.Jolt = engine.Jolt;
    this.jolt = engine.jolt;
    this.system = engine.system;
    this.bi = engine.bi;
    this.scratch = new Scratch(engine.Jolt);
    this.gravity = doc.gravity;
    this.gravityOn = doc.gravityOn;
    this.poses = new Float32Array(doc.parts.length * 7);

    for (const part of doc.parts) this.createPart(part);
    if (doc.floor) this.createFloor();

    // Non-gear joints first: gear couplings reference their pin joints.
    for (const joint of doc.joints) {
      if (joint.kind !== 'gear') this.createJoint(joint);
    }
    for (const joint of doc.joints) {
      if (joint.kind === 'gear') this.createJoint(joint);
    }
  }

  /**
   * Builds a world. The caller must dispose any previous world first: the engine
   * is shared for the process, so two live worlds would share one body space.
   */
  static async create(doc: SceneDoc): Promise<SimWorld> {
    if (doc.parts.length > ENGINE_CAPACITY.maxBodies / 2) {
      throw new Error(
        `scene has ${doc.parts.length} parts, beyond the engine capacity of ${ENGINE_CAPACITY.maxBodies}`,
      );
    }
    const engine = await getEngine();
    const world = new SimWorld(doc, engine);
    world.pushGravity();
    world.readPoses();
    return world;
  }

  // --- construction -------------------------------------------------------

  /**
   * The body used as "the world" for ground-anchored joints.
   *
   * It must not be a collidable body near the mechanism. It used to be a small
   * static box at the origin, which put it inside the swept volume of a crank
   * pivoting there: the crank collided with its own ground anchor and the contact
   * forces fought the hinge constraints, so the four-bar stuck at the same phase
   * every revolution with reaction forces climbing into the hundreds of newtons,
   * and more solver effort made it worse. Jolt's fixed-to-world body has no shape,
   * so it can never collide with anything.
   */
  private get groundBody(): Any {
    if (!this.ground) {
      this.ground = this.Jolt.JoltInterface.prototype.sGetFixedToWorldBody.call(this.jolt);
    }
    return this.ground;
  }

  private createFloor(): void {
    const { Jolt, bi } = this;
    const shape = linkShape(Jolt, 4, 0.02, 4, 1000);
    const bcs = new Jolt.BodyCreationSettings(
      shape,
      this.scratch.rvec('rv1', 0, -0.35, 0),
      this.scratch.quat(0, 0, 0, 1),
      Jolt.EMotionType_Static,
      LAYER_NON_MOVING,
    );
    const body = bi.CreateBody(bcs);
    bi.AddBody(body.GetID(), Jolt.EActivation_DontActivate);
    Jolt.destroy(bcs);
    this.floor = body;
  }

  private createPart(part: Part): void {
    const { Jolt, bi } = this;

    const density = Math.max(50, part.density || 2700);
    const shape = part.kind === 'link'
      ? linkShape(Jolt, part.length ?? 0.08, part.width ?? 0.02, part.thickness, density)
      : cylinderShape(Jolt, part.radius ?? 0.03, part.thickness, density);

    const motion = part.fixed ? Jolt.EMotionType_Static : Jolt.EMotionType_Dynamic;
    const bcs = new Jolt.BodyCreationSettings(
      shape,
      this.scratch.rvec('rv1', part.position[0], part.position[1], part.position[2]),
      this.eulerQuat(part.rotation),
      motion,
      part.fixed ? LAYER_NON_MOVING : LAYER_MOVING,
    );
    if (!part.fixed) {
      bcs.mAllowedDOFs = part.dofs === 'plane2d' ? Jolt.EAllowedDOFs_Plane2D : Jolt.EAllowedDOFs_All;
      bcs.mOverrideMassProperties = Jolt.EOverrideMassProperties_CalculateMassAndInertia;
    }

    const body = bi.CreateBody(bcs);
    bi.AddBody(body.GetID(), part.fixed ? Jolt.EActivation_DontActivate : Jolt.EActivation_Activate);
    Jolt.destroy(bcs);

    const runtime: PartRuntime = {
      id: part.id,
      index: this.parts.length,
      kind: part.kind,
      plane: part.plane,
      fixed: part.fixed,
      dofs: part.dofs,
      body,
    };
    this.parts.push(runtime);
    this.partIndex.set(part.id, runtime);
  }

  private eulerQuat(e: Vec3): Any {
    const [x, y, z] = e;
    const c1 = Math.cos(x / 2), c2 = Math.cos(y / 2), c3 = Math.cos(z / 2);
    const s1 = Math.sin(x / 2), s2 = Math.sin(y / 2), s3 = Math.sin(z / 2);
    return this.scratch.quat(
      s1 * c2 * c3 + c1 * s2 * s3,
      c1 * s2 * c3 - s1 * c2 * s3,
      c1 * c2 * s3 + s1 * s2 * c3,
      c1 * c2 * c3 - s1 * s2 * s3,
    );
  }

  private partRuntime(id: string | null): PartRuntime | null {
    if (id === null) return null;
    const p = this.partIndex.get(id);
    if (!p) throw new Error(`joint references unknown part ${id}`);
    return p;
  }

  private axisBasis(axis: Vec3): [Vec3, Vec3] {
    const a = normalize(axis);
    const n: Vec3 = Math.abs(a[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    return [a, n];
  }

  private createJoint(joint: Joint): void {
    const { Jolt, system } = this;
    const a = this.partRuntime(joint.a);
    const b = this.partRuntime(joint.b);
    if (!b) throw new Error(`joint ${joint.id} has no second body`);
    const bodyA = a ? a.body : this.groundBody;
    const [ax, ay, az] = normalize(joint.axis);

    if (joint.kind === 'gear') {
      const pinA = joint.couplingA ? this.jointIndex.get(joint.couplingA) : null;
      const pinB = joint.couplingB ? this.jointIndex.get(joint.couplingB) : null;
      if (!pinA?.actuator || !pinB?.actuator) return; // needs two pin joints
      const s = new Jolt.GearConstraintSettings();
      s.mSpace = Jolt.EConstraintSpace_WorldSpace;
      const a1 = normalize(pinA.axis);
      const a2 = normalize(pinB.axis);
      s.mHingeAxis1 = this.scratch.vec('v1', a1[0], a1[1], a1[2]);
      s.mHingeAxis2 = this.scratch.vec('v2', a2[0], a2[1], a2[2]);
      // Jolt constrains driven = -driver / ratio, i.e. external mesh reverses.
      s.mRatio = joint.ratio ?? 2;
      const constraint = s.Create(pinA.b.body, pinB.b.body);
      Jolt.destroy(s);
      const gear = Jolt.castObject(constraint, Jolt.GearConstraint);
      gear.SetConstraints(pinA.actuator, pinB.actuator);
      system.AddConstraint(constraint);
      this.pushJoint(joint, a, b, constraint, null, a1);
      return;
    }

    let actuator: Any = null;
    let constraint: Any;

    if (joint.kind === 'pin') {
      const s = new Jolt.HingeConstraintSettings();
      s.mSpace = Jolt.EConstraintSpace_WorldSpace;
      s.mPoint1 = this.scratch.rvec('rv1', joint.anchor[0], joint.anchor[1], joint.anchor[2]);
      s.mPoint2 = this.scratch.rvec('rv2', joint.anchor[0], joint.anchor[1], joint.anchor[2]);
      const [axis, normal] = this.axisBasis(joint.axis);
      s.mHingeAxis1 = this.scratch.vec('v1', axis[0], axis[1], axis[2]);
      s.mNormalAxis1 = this.scratch.vec('v2', normal[0], normal[1], normal[2]);
      s.mHingeAxis2 = this.scratch.vec('v1', axis[0], axis[1], axis[2]);
      s.mNormalAxis2 = this.scratch.vec('v2', normal[0], normal[1], normal[2]);
      // Jolt's HingeConstraintSettings defaults to a +/- PI limit, so a hinge
      // with no authored limits still stops after half a turn unless the limits
      // are explicitly opened up. +/- FLT_MAX is Jolt's own "unlimited" sentinel.
      if (joint.limits?.enabled) {
        s.mLimitsMin = joint.limits.min;
        s.mLimitsMax = joint.limits.max;
      } else {
        s.mLimitsMin = -UNLIMITED;
        s.mLimitsMax = UNLIMITED;
      }
      if (joint.compliance?.enabled) {
        const spring = new Jolt.SpringSettings();
        spring.mMode = Jolt.ESpringMode_FrequencyAndDamping;
        spring.mFrequency = joint.compliance.frequency;
        spring.mDamping = joint.compliance.damping;
        s.mLimitsSpringSettings = spring;
        this.keepAlive.push(spring);
      }
      if (joint.motor?.enabled) s.mMotorSettings = this.motorSettings(joint);
      constraint = s.Create(bodyA, b.body);
      Jolt.destroy(s);
      actuator = Jolt.castObject(constraint, Jolt.HingeConstraint);
    } else if (joint.kind === 'slider') {
      const s = new Jolt.SliderConstraintSettings();
      s.mSpace = Jolt.EConstraintSpace_WorldSpace;
      s.mPoint1 = this.scratch.rvec('rv1', joint.anchor[0], joint.anchor[1], joint.anchor[2]);
      s.mPoint2 = this.scratch.rvec('rv2', joint.anchor[0], joint.anchor[1], joint.anchor[2]);
      const [axis, normal] = this.axisBasis(joint.axis);
      s.mSliderAxis1 = this.scratch.vec('v1', axis[0], axis[1], axis[2]);
      s.mNormalAxis1 = this.scratch.vec('v2', normal[0], normal[1], normal[2]);
      s.mSliderAxis2 = this.scratch.vec('v1', axis[0], axis[1], axis[2]);
      s.mNormalAxis2 = this.scratch.vec('v2', normal[0], normal[1], normal[2]);
      if (joint.limits?.enabled) {
        s.mLimitsMin = joint.limits.min;
        s.mLimitsMax = joint.limits.max;
      } else {
        s.mLimitsMin = -UNLIMITED;
        s.mLimitsMax = UNLIMITED;
      }
      if (joint.motor?.enabled) s.mMotorSettings = this.motorSettings(joint);
      constraint = s.Create(bodyA, b.body);
      Jolt.destroy(s);
      actuator = Jolt.castObject(constraint, Jolt.SliderConstraint);
    } else if (joint.kind === 'ball') {
      const s = new Jolt.PointConstraintSettings();
      s.mSpace = Jolt.EConstraintSpace_WorldSpace;
      s.mPoint1 = this.scratch.rvec('rv1', joint.anchor[0], joint.anchor[1], joint.anchor[2]);
      s.mPoint2 = this.scratch.rvec('rv2', joint.anchor[0], joint.anchor[1], joint.anchor[2]);
      constraint = s.Create(bodyA, b.body);
      Jolt.destroy(s);
    } else {
      // weld
      const s = new Jolt.FixedConstraintSettings();
      s.mSpace = Jolt.EConstraintSpace_WorldSpace;
      s.mAutoDetectPoint = false;
      s.mPoint1 = this.scratch.rvec('rv1', joint.anchor[0], joint.anchor[1], joint.anchor[2]);
      s.mPoint2 = this.scratch.rvec('rv2', joint.anchor[0], joint.anchor[1], joint.anchor[2]);
      const [, weldNormal] = this.axisBasis(joint.axis);
      s.mAxisX1 = this.scratch.vec('v1', ax, ay, az);
      s.mAxisY1 = this.scratch.vec('v2', weldNormal[0], weldNormal[1], weldNormal[2]);
      s.mAxisX2 = this.scratch.vec('v1', ax, ay, az);
      s.mAxisY2 = this.scratch.vec('v2', weldNormal[0], weldNormal[1], weldNormal[2]);
      constraint = s.Create(bodyA, b.body);
      Jolt.destroy(s);
    }

    system.AddConstraint(constraint);
    this.pushJoint(joint, a, b, constraint, actuator, [ax, ay, az]);
    if (actuator && joint.motor?.enabled) this.applyMotor(actuator, joint, joint.kind === 'pin' ? 'pin' : 'slider');
  }

  private pushJoint(
    joint: Joint,
    a: PartRuntime | null,
    b: PartRuntime,
    constraint: Any,
    actuator: Any,
    axis: Vec3,
  ): void {
    const runtime: JointRuntime = {
      id: joint.id,
      kind: joint.kind,
      a,
      b,
      constraint,
      actuator,
      axis,
      value: 0,
      prevRaw: null,
      speed: 0,
      forceN: 0,
      torqueNm: 0,
    };
    this.joints.push(runtime);
    this.jointIndex.set(joint.id, runtime);
  }

  private motorSettings(joint: Joint): Any {
    const { Jolt } = this;
    const spring = new Jolt.SpringSettings();
    spring.mMode = Jolt.ESpringMode_FrequencyAndDamping;
    spring.mFrequency = joint.motor!.frequency ?? 10;
    spring.mDamping = joint.motor!.damping ?? 1;
    const ms = new Jolt.MotorSettings();
    ms.mSpringSettings = spring;
    ms.mMaxForceLimit = joint.motor!.maxTorque;
    ms.mMinForceLimit = -joint.motor!.maxTorque;
    ms.mMaxTorqueLimit = joint.motor!.maxTorque;
    ms.mMinTorqueLimit = -joint.motor!.maxTorque;
    // Kept alive: whether these setters copy or retain a pointer is unverified,
    // and a dangling settings pointer inside a constraint is very hard to debug.
    this.keepAlive.push(spring, ms);
    return ms;
  }

  /**
   * Hinges speak angles, sliders speak distances: the hinge setters are
   * SetTargetAngularVelocity / SetTargetAngle, not the generic target setters.
   */
  private applyMotor(actuator: Any, joint: Joint, kind: 'pin' | 'slider'): void {
    const { Jolt } = this;
    const motor = joint.motor;
    if (!motor) return;
    if (!motor.enabled) {
      actuator.SetMotorState(Jolt.EMotorState_Off);
      return;
    }
    if (kind === 'pin') {
      if (motor.mode === 'position') {
        actuator.SetMotorState(Jolt.EMotorState_Position);
        actuator.SetTargetAngle(motor.targetPosition);
      } else {
        actuator.SetMotorState(Jolt.EMotorState_Velocity);
        actuator.SetTargetAngularVelocity(motor.targetVelocity);
      }
    } else if (motor.mode === 'position') {
      actuator.SetMotorState(Jolt.EMotorState_Position);
      actuator.SetTargetPosition(motor.targetPosition);
    } else {
      actuator.SetMotorState(Jolt.EMotorState_Velocity);
      actuator.SetTargetVelocity(motor.targetVelocity);
    }
  }

  // --- live updates -------------------------------------------------------

  /**
   * Applies parameter changes to the running world without rebuilding, so tuning
   * a motor or flipping gravity never resets the mechanism.
   */
  applyLive(doc: SceneDoc): void {
    this.gravity = doc.gravity;
    this.gravityOn = doc.gravityOn;
    this.pushGravity();

    for (const joint of doc.joints) {
      if (joint.kind !== 'pin' && joint.kind !== 'slider') continue;
      const runtime = this.jointIndex.get(joint.id);
      const actuator = runtime?.actuator;
      if (!actuator) continue;

      if (joint.limits) {
        actuator.SetLimits(
          joint.limits.enabled ? joint.limits.min : -UNLIMITED,
          joint.limits.enabled ? joint.limits.max : UNLIMITED,
        );
      }
      if (joint.motor) {
        // Verified: this writes through to the live constraint, not to a copy.
        const ms = actuator.GetMotorSettings();
        ms.mMaxTorqueLimit = joint.motor.maxTorque;
        ms.mMinTorqueLimit = -joint.motor.maxTorque;
        ms.mMaxForceLimit = joint.motor.maxTorque;
        ms.mMinForceLimit = -joint.motor.maxTorque;
      }
      this.applyMotor(actuator, joint, joint.kind);
    }
  }

  // --- stepping -----------------------------------------------------------

  step(): void {
    if (this.blownUp || this.disposed) return;
    this.applyGrip();
    try {
      this.jolt.Step(FIXED_DT, solver.collisionSteps);
    } catch {
      this.blownUp = true;
    }
  }

  private pushGravity(): void {
    this.system.SetGravity(this.scratch.vec('v1', 0, this.gravityOn ? -this.gravity : 0, 0));
  }

  /**
   * Reads body transforms into the render buffer and doubles as the divergence
   * guard: a mechanism that has left the world is stopped before the solver's
   * internal state is corrupted.
   */
  readPoses(): void {
    const limit = solver.divergenceLimit;
    for (const part of this.parts) {
      // These getters return pooled value views, not owned allocations: the WASM
      // heap does not move across reads, and Jolt.destroy on them corrupts the
      // heap. Read the components and drop the wrapper.
      const p = part.body.GetPosition();
      const q = part.body.GetRotation();
      const x = p.GetX(), y = p.GetY(), z = p.GetZ();
      const o = part.index * 7;
      this.poses[o] = x;
      this.poses[o + 1] = y;
      this.poses[o + 2] = z;
      this.poses[o + 3] = q.GetX();
      this.poses[o + 4] = q.GetY();
      this.poses[o + 5] = q.GetZ();
      this.poses[o + 6] = q.GetW();
      if (!Number.isFinite(x) || Math.abs(x) > limit || Math.abs(y) > limit) {
        this.blownUp = true;
      }
    }
  }

  /**
   * Instrumentation. Force and torque are solver reaction impulses divided by the
   * step, so they read as per-step average reactions rather than instantaneous
   * peaks. Angles are derived from body poses: HingeConstraint.GetCurrentAngle()
   * reported 0 for constraints created in world space in this build.
   */
  readMetrics(): JointMetric[] {
    const out: JointMetric[] = [];
    for (const j of this.joints) {
      const qa = j.a ? this.readQuat(j.a) : ([0, 0, 0, 1] as Quat);
      const qb = this.readQuat(j.b);
      const raw = angleAboutAxis(quatMul(quatConjugate(qa), qb), j.axis);
      if (j.prevRaw === null) {
        j.prevRaw = raw;
      } else {
        let d = raw - j.prevRaw;
        while (d > Math.PI) d -= 2 * Math.PI;
        while (d < -Math.PI) d += 2 * Math.PI;
        j.value += d;
        j.prevRaw = raw;
      }

      const wa = j.a ? this.readVec(this.bi.GetAngularVelocity(j.a.body.GetID())) : ([0, 0, 0] as Vec3);
      const wb = this.readVec(this.bi.GetAngularVelocity(j.b.body.GetID()));
      j.speed = dot([wb[0] - wa[0], wb[1] - wa[1], wb[2] - wa[2]], j.axis);

      try {
        if (j.kind === 'pin' && j.actuator) {
          const lam = j.actuator.GetTotalLambdaPosition();
          j.forceN = Math.hypot(lam.GetX(), lam.GetY(), lam.GetZ()) / FIXED_DT;
          j.torqueNm = Math.abs(j.actuator.GetTotalLambdaMotor()) / FIXED_DT;
        } else if (j.kind === 'slider' && j.actuator) {
          const lam = j.actuator.GetTotalLambdaPosition();
          j.forceN = Math.hypot(lam.GetX(), lam.GetY()) / FIXED_DT;
          j.torqueNm = Math.abs(j.actuator.GetTotalLambdaMotor()) / FIXED_DT;
        }
      } catch {
        // Not every joint type exposes lambda accessors.
      }

      out.push({ id: j.id, kind: j.kind, value: j.value, speed: j.speed, forceN: j.forceN, torqueNm: j.torqueNm });
    }
    return out;
  }

  private readQuat(part: PartRuntime): Quat {
    const q = part.body.GetRotation();
    return [q.GetX(), q.GetY(), q.GetZ(), q.GetW()];
  }

  private readVec(v: Any): Vec3 {
    return [v.GetX(), v.GetY(), v.GetZ()];
  }

  private readPose(part: PartRuntime): { pos: Vec3; rot: Quat } {
    const p = part.body.GetPosition();
    const q = part.body.GetRotation();
    return {
      pos: [p.GetX(), p.GetY(), p.GetZ()],
      rot: [q.GetX(), q.GetY(), q.GetZ(), q.GetW()],
    };
  }

  // --- direct manipulation ------------------------------------------------

  /**
   * Grab a part at a world point. Driven as a capped velocity servo rather than a
   * teleport, so a dragged linkage backdrives through its constraints instead of
   * exploding, and the user cannot inject unbounded energy.
   */
  grab(partId: string, worldPoint: Vec3, maxSpeed = 1.5): void {
    const part = this.partIndex.get(partId);
    if (!part || part.fixed) return;
    const { pos, rot } = this.readPose(part);
    const localOffset = quatRotate(quatConjugate(rot), sub(worldPoint, pos)) as Vec3;
    this.grip = { part, localOffset, target: worldPoint, maxSpeed };
    this.bi.ActivateBody(part.body.GetID());
  }

  moveGrab(worldPoint: Vec3): void {
    if (this.grip) this.grip.target = worldPoint;
  }

  endGrab(): void {
    this.grip = null;
  }

  private applyGrip(): void {
    const grip = this.grip;
    if (!grip) return;
    const { pos, rot } = this.readPose(grip.part);
    const grabbed = quatRotate(rot, grip.localOffset);
    const current: Vec3 = [pos[0] + grabbed[0], pos[1] + grabbed[1], pos[2] + grabbed[2]];

    const delta = sub(grip.target, current);
    let v: Vec3 = vscale(delta, 14);
    const speed = vlen(v);
    if (speed > grip.maxSpeed) v = vscale(v, grip.maxSpeed / speed);

    this.bi.SetLinearVelocity(grip.part.body.GetID(), this.scratch.vec('v1', v[0], v[1], v[2]));
    this.bi.ActivateBody(grip.part.body.GetID());

    // Bleed off spin so a grabbed link does not windmill.
    const w = grip.part.body.GetAngularVelocity();
    this.bi.SetAngularVelocity(
      grip.part.body.GetID(),
      this.scratch.vec('v2', w.GetX() * 0.85, w.GetY() * 0.85, w.GetZ() * 0.85),
    );
  }

  /** Per-part mass properties, for diagnosing a loop that refuses to move. */
  poseOf(partId: string): { pos: Vec3; rot: Quat } | null {
    const part = this.partIndex.get(partId);
    return part ? this.readPose(part) : null;
  }

  get partCount(): number {
    return this.parts.length;
  }

  // --- teardown -----------------------------------------------------------
  /**
   * Clears this world's bodies and constraints. The shared engine survives, and
   * so do the cached, reference-held shapes.
   *
   * Order matters. AddConstraint took a reference to the constraint and
   * RemoveConstraint gives it back, which frees it; destroying the constraint
   * handle directly would be a double free. Bodies must be removed before they
   * are destroyed.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.grip = null;

    for (const j of this.joints) {
      try {
        this.system.RemoveConstraint(j.constraint);
      } catch {
        // Already gone with its bodies.
      }
    }
    this.joints.length = 0;
    this.jointIndex.clear();

    for (const part of this.parts) {
      const id = part.body.GetID();
      this.bi.RemoveBody(id);
      this.bi.DestroyBody(id);
    }
    this.parts.length = 0;
    this.partIndex.clear();

    if (this.floor) {
      const id = this.floor.GetID();
      this.bi.RemoveBody(id);
      this.bi.DestroyBody(id);
      this.floor = null;
    }
    // The ground body belongs to the engine; it is not ours to destroy.
    this.ground = null;
    this.keepAlive.length = 0;
  }
}

export { FIXED_DT };
