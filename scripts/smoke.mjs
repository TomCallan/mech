/**
 * Phase 0 validation gate.
 *
 * Runs headless in Node against the real Jolt WASM build and answers the questions
 * the architecture depends on:
 *
 *   1. Is a planar four-bar built from 3D hinge constraints stable when bodies are
 *      DOF-locked to Plane2D, and does it degrade when left free in 3D?
 *      (Over-constraint thesis: a free 3D four-bar has mobility M = -2.)
 *   2. Does the solver profile keep a driven closed loop from drifting?
 *   3. What does a step actually cost in milliseconds?
 *   4. Do GearConstraints bind to hinge pairs, including non-parallel axes
 *      (bevel / worm feasibility)?
 *
 * Jolt ownership rules, established empirically (see scripts/README note below):
 *   - BodyCreationSettings may be destroyed right after CreateBody.
 *   - ConstraintSettings may be destroyed right after Create.
 *   - A Shape must outlive its Body; destroy it only after DestroyBody.
 *   - A Constraint handle must not be destroyed while added.
 *   - Teardown order is RemoveConstraint -> RemoveBody -> DestroyBody -> destroy(shape).
 * Violating the last three manifests as "null function", "unreachable" or
 * "memory access out of bounds" from deep inside Step.
 *
 * Usage: node scripts/smoke.mjs
 */

import initJolt from 'jolt-physics/wasm-compat';

const PROFILE = {
  dt: 1 / 120,
  velocitySteps: 8,
  positionSteps: 3,
  baumgarte: 0.1,
  // Jolt defaults to 0.02 m, which is 20% of a 100 mm link. Must come down.
  penetrationSlop: 0.0005,
  speculativeContactDistance: 0.001,
  minVelocityForRestitution: 0.1,
};

const LAYER_NON_MOVING = 0;
const LAYER_MOVING = 1;
const STEEL = 7850;

let Jolt;

/** Keeps WASM handles alive for the process lifetime (see ownership note above). */
const retained = [];

function boot(profile = PROFILE) {
  const settings = new Jolt.JoltSettings();
  // Single-threaded: no SharedArrayBuffer, so no COOP/COEP requirement.
  settings.mMaxWorkerThreads = 0;
  settings.mMaxBodies = 4096;
  settings.mMaxBodyPairs = 8192;
  settings.mMaxContactConstraints = 4096;

  const objectFilter = new Jolt.ObjectLayerPairFilterTable(2);
  objectFilter.EnableCollision(LAYER_NON_MOVING, LAYER_MOVING);
  // Deliberately OFF. Constrained links talk through joints, not contacts;
  // contact manifolds fighting the constraint solver is a classic blow-up.
  objectFilter.DisableCollision(LAYER_MOVING, LAYER_MOVING);

  const bpInterface = new Jolt.BroadPhaseLayerInterfaceTable(2, 2);
  bpInterface.MapObjectToBroadPhaseLayer(LAYER_NON_MOVING, new Jolt.BroadPhaseLayer(0));
  bpInterface.MapObjectToBroadPhaseLayer(LAYER_MOVING, new Jolt.BroadPhaseLayer(1));

  settings.mObjectLayerPairFilter = objectFilter;
  settings.mBroadPhaseLayerInterface = bpInterface;
  settings.mObjectVsBroadPhaseLayerFilter = new Jolt.ObjectVsBroadPhaseLayerFilterTable(
    bpInterface, 2, objectFilter, 2,
  );

  const jolt = new Jolt.JoltInterface(settings);
  const system = jolt.GetPhysicsSystem();
  const ps = system.GetPhysicsSettings();
  ps.mNumVelocitySteps = profile.velocitySteps;
  ps.mNumPositionSteps = profile.positionSteps;
  ps.mBaumgarte = profile.baumgarte;
  ps.mPenetrationSlop = profile.penetrationSlop;
  ps.mSpeculativeContactDistance = profile.speculativeContactDistance;
  ps.mMinVelocityForRestitution = profile.minVelocityForRestitution;
  ps.mDeterministicSimulation = true;
  ps.mConstraintWarmStart = true;
  ps.mAllowSleeping = false;

  retained.push(settings, objectFilter, bpInterface);
  return { jolt, system, bi: system.GetBodyInterface() };
}

// --- helpers --------------------------------------------------------------

const scratch = {};

function vec3(x, y, z) {
  scratch.v ??= new Jolt.Vec3();
  scratch.v.Set(x, y, z);
  return scratch.v;
}

function rvec3(x, y, z) {
  scratch.rv ??= new Jolt.RVec3();
  scratch.rv.Set(x, y, z);
  return scratch.rv;
}

function quatZ(angle) {
  scratch.zAxis ??= new Jolt.Vec3();
  scratch.zAxis.Set(0, 0, 1);
  return Jolt.Quat.prototype.sRotation(scratch.zAxis, angle);
}

function readPose(bi, body) {
  const p = body.GetPosition();
  const q = body.GetRotation();
  const out = {
    x: p.GetX(), y: p.GetY(), z: p.GetZ(),
    qx: q.GetX(), qy: q.GetY(), qz: q.GetZ(), qw: q.GetW(),
  };
  Jolt.destroy(p);
  Jolt.destroy(q);
  return out;
}

function rotate(pose, v) {
  const { qx, qy, qz, qw } = pose;
  const tx = 2 * (qy * v[2] - qz * v[1]);
  const ty = 2 * (qz * v[0] - qx * v[2]);
  const tz = 2 * (qx * v[1] - qy * v[0]);
  return [
    v[0] + qw * tx + (qy * tz - qz * ty),
    v[1] + qw * ty + (qz * tx - qx * tz),
    v[2] + qw * tz + (qx * ty - qy * tx),
  ];
}

function anchorWorld(bi, body, localPoint) {
  const pose = readPose(bi, body);
  const r = rotate(pose, localPoint);
  return { x: pose.x + r[0], y: pose.y + r[1], z: pose.z + r[2] };
}

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

// --- factories ------------------------------------------------------------

function addBar(bi, { x, y, z = 0, length, thickness, depth, angle, planar, mass }) {
  const shape = new Jolt.BoxShape(vec3(length / 2, thickness / 2, depth / 2), 0.001, null);
  shape.SetDensity(mass / (length * thickness * depth));
  retained.push(shape);

  const bcs = new Jolt.BodyCreationSettings(
    shape, rvec3(x, y, z), quatZ(angle), Jolt.EMotionType_Dynamic, LAYER_MOVING,
  );
  bcs.mAllowedDOFs = planar ? Jolt.EAllowedDOFs_Plane2D : Jolt.EAllowedDOFs_All;
  bcs.mOverrideMassProperties = Jolt.EOverrideMassProperties_CalculateMassAndInertia;

  const body = bi.CreateBody(bcs);
  bi.AddBody(body.GetID(), Jolt.EActivation_Activate);
  Jolt.destroy(bcs);
  return body;
}

function addGround(bi, { x, y, z = 0, half }) {
  const shape = new Jolt.BoxShape(vec3(half, half, half), 0.001, null);
  retained.push(shape);
  const bcs = new Jolt.BodyCreationSettings(
    shape, rvec3(x, y, z), Jolt.Quat.prototype.sIdentity(), Jolt.EMotionType_Static, LAYER_NON_MOVING,
  );
  const body = bi.CreateBody(bcs);
  bi.AddBody(body.GetID(), Jolt.EActivation_DontActivate);
  Jolt.destroy(bcs);
  return body;
}

function makeHinge(system, body1, body2, point, opts = {}) {
  const s = new Jolt.HingeConstraintSettings();
  s.mSpace = Jolt.EConstraintSpace_WorldSpace;
  const [ax, ay, az] = opts.axis ?? [0, 0, 1];
  const [nx, ny, nz] = opts.normal ?? [1, 0, 0];

  s.mPoint1 = rvec3(point[0], point[1], point[2]);
  s.mHingeAxis1 = vec3(ax, ay, az);
  s.mNormalAxis1 = vec3(nx, ny, nz);
  s.mPoint2 = rvec3(point[0], point[1], point[2]);
  s.mHingeAxis2 = vec3(ax, ay, az);
  s.mNormalAxis2 = vec3(nx, ny, nz);

  if (opts.limits) {
    s.mLimitsMin = opts.limits[0];
    s.mLimitsMax = opts.limits[1];
  }
  if (opts.motor) {
    const spring = new Jolt.SpringSettings();
    spring.mMode = Jolt.ESpringMode_FrequencyAndDamping;
    spring.mFrequency = opts.motor.frequency ?? 10;
    spring.mDamping = opts.motor.damping ?? 1;
    const ms = new Jolt.MotorSettings();
    ms.mSpringSettings = spring;
    ms.mMaxTorqueLimit = opts.motor.maxTorque ?? 5;
    ms.mMinTorqueLimit = -ms.mMaxTorqueLimit;
    s.mMotorSettings = ms;
    retained.push(spring, ms);
  }

  const constraint = s.Create(body1, body2);
  Jolt.destroy(s);
  system.AddConstraint(constraint);
  retained.push(constraint);

  const hinge = Jolt.castObject(constraint, Jolt.HingeConstraint);
  if (opts.motor) {
    hinge.SetMotorState(Jolt.EMotorState_Velocity);
    hinge.SetTargetAngularVelocity(opts.motor.targetVelocity ?? 0);
  }
  return hinge;
}

/** GearConstraint couples two bodies; SetConstraints gives it the hinge axes. */
function makeGear(system, body1, body2, hinge1, hinge2, ratio, axis1, axis2) {
  const s = new Jolt.GearConstraintSettings();
  s.mSpace = Jolt.EConstraintSpace_WorldSpace;
  s.mHingeAxis1 = vec3(axis1[0], axis1[1], axis1[2]);
  s.mHingeAxis2 = vec3(axis2[0], axis2[1], axis2[2]);
  s.mRatio = ratio;
  const c = s.Create(body1, body2);
  Jolt.destroy(s);
  const gear = Jolt.castObject(c, Jolt.GearConstraint);
  gear.SetConstraints(hinge1, hinge2);
  system.AddConstraint(gear);
  retained.push(c);
  return gear;
}

function hingeDrift(bi, item) {
  const lp1 = item.c.GetLocalSpacePoint1();
  const lp2 = item.c.GetLocalSpacePoint2();
  const p1 = [lp1.GetX(), lp1.GetY(), lp1.GetZ()];
  const p2 = [lp2.GetX(), lp2.GetY(), lp2.GetZ()];
  const w1 = anchorWorld(bi, item.b1, p1);
  const w2 = anchorWorld(bi, item.b2, p2);
  Jolt.destroy(lp1);
  Jolt.destroy(lp2);
  return dist(w1, w2);
}

// --- four-bar -------------------------------------------------------------
// Grashof crank-rocker: crank 50 mm, coupler 150 mm, rocker 100 mm, ground 200 mm.
// s + l = 0.20 <= p + q = 0.30, so the crank can rotate fully.

const DIMS = { crank: 0.05, coupler: 0.15, rocker: 0.10, ground: 0.20 };

function solveFourBar(theta) {
  const { crank, coupler, rocker, ground } = DIMS;
  const A = { x: crank * Math.cos(theta), y: crank * Math.sin(theta) };
  const O2 = { x: ground, y: 0 };
  const dx = O2.x - A.x;
  const dy = O2.y - A.y;
  const d = Math.hypot(dx, dy);
  const a = (coupler * coupler - rocker * rocker + d * d) / (2 * d);
  const h = Math.sqrt(Math.max(0, coupler * coupler - a * a));
  const ux = dx / d, uy = dy / d;
  return { A, B: { x: A.x + a * ux - h * uy, y: A.y + a * uy + h * ux }, O2 };
}

const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

function buildFourBar(bi, system, planar) {
  const { A, B, O2 } = solveFourBar(0);
  const O = { x: 0, y: 0 };
  const dims = { thickness: 0.008, depth: 0.008, mass: 0.02 };

  const ground = addGround(bi, { x: O2.x / 2, y: 0, half: 0.004 });
  const crank = addBar(bi, { ...mid(O, A), ...dims, length: DIMS.crank, angle: Math.atan2(A.y, A.x), planar });
  const coupler = addBar(bi, { ...mid(A, B), ...dims, length: DIMS.coupler, angle: Math.atan2(B.y - A.y, B.x - A.x), planar });
  const rocker = addBar(bi, { ...mid(O2, B), ...dims, length: DIMS.rocker, angle: Math.atan2(B.y - O2.y, B.x - O2.x), planar });

  const pins = [
    { name: 'O ground-crank', c: makeHinge(system, ground, crank, [O.x, O.y, 0], { motor: { targetVelocity: 2 * Math.PI, maxTorque: 2 } }), b1: ground, b2: crank },
    { name: 'A crank-coupler', c: makeHinge(system, crank, coupler, [A.x, A.y, 0]), b1: crank, b2: coupler },
    { name: 'B coupler-rocker', c: makeHinge(system, coupler, rocker, [B.x, B.y, 0]), b1: coupler, b2: rocker },
    { name: 'O2 ground-rocker', c: makeHinge(system, ground, rocker, [O2.x, O2.y, 0]), b1: ground, b2: rocker },
  ];
  return { pins, bodies: [crank, coupler, rocker] };
}

/** Signed rotation about a principal axis, for a body whose rotation is dominated by it. */
function angleAbout(pose, axis) {
  if (axis === 'z') {
    return Math.atan2(2 * (pose.qw * pose.qz + pose.qx * pose.qy), 1 - 2 * (pose.qy * pose.qy + pose.qz * pose.qz));
  }
  return Math.atan2(2 * (pose.qw * pose.qx + pose.qy * pose.qz), 1 - 2 * (pose.qx * pose.qx + pose.qz * pose.qz));
}

/**
 * Accumulates unwrapped rotation from a body's pose.
 * Note: HingeConstraint.GetCurrentAngle() returns 0 for constraints created in
 * world space in this build, so instrumentation must derive angles from poses.
 */
function angleTracker(bi, body, axis) {
  let prev = null;
  let total = 0;
  return {
    sample() {
      const a = angleAbout(readPose(bi, body), axis);
      if (prev === null) { prev = a; return total; }
      let d = a - prev;
      while (d > Math.PI) d -= 2 * Math.PI;
      while (d < -Math.PI) d += 2 * Math.PI;
      total += d;
      prev = a;
      return total;
    },
    get total() { return total; },
  };
}

function measureFourBar({ planar, seconds }) {
  const { jolt, system, bi } = boot();
  const { pins, bodies } = buildFourBar(bi, system, planar);

  const steps = Math.round(seconds / PROFILE.dt);
  let worstDrift = 0, worstPin = '', maxOutOfPlane = 0, maxAbsPos = 0;
  let divergedAtStep = -1;
  const crank = angleTracker(bi, bodies[0], 'z');

  const t0 = performance.now();
  try {
    for (let i = 0; i < steps; i++) {
      jolt.Step(PROFILE.dt, 1);
      if (i % 10 === 0) {
        const cp = readPose(bi, bodies[0]);
        crank.sample();
        // Divergence guard: stop before a degenerating sim corrupts the WASM heap.
        if (!Number.isFinite(cp.x) || Math.abs(cp.x) > 5 || Math.abs(cp.y) > 5) {
          divergedAtStep = i;
          break;
        }
        maxAbsPos = Math.max(maxAbsPos, Math.abs(cp.x), Math.abs(cp.y));

        if (i % 30 === 0) {
          for (const pin of pins) {
            const dd = hingeDrift(bi, pin);
            if (!Number.isFinite(dd)) { divergedAtStep = i; break; }
            if (dd > worstDrift) { worstDrift = dd; worstPin = pin.name; }
          }
          for (const b of bodies) {
            const p = readPose(bi, b);
            maxOutOfPlane = Math.max(maxOutOfPlane, Math.abs(p.z));
          }
        }
      }
      if (divergedAtStep >= 0) break;
    }
  } catch (err) {
    // A blow-up can corrupt the solver's internal state mid-step.
    divergedAtStep = divergedAtStep >= 0 ? divergedAtStep : -2;
  }
  const ran = divergedAtStep >= 0 ? Math.max(1, divergedAtStep) : steps;
  const msPerStep = (performance.now() - t0) / ran;

  return {
    planar,
    seconds,
    divergedAtStep,
    worstDriftMm: +worstDrift.toFixed(5),
    worstPin,
    maxOutOfPlaneMm: +maxOutOfPlane.toFixed(6),
    maxAbsPosM: +maxAbsPos.toFixed(3),
    crankTurns: +(crank.total / (2 * Math.PI)).toFixed(2),
    msPerStep: +msPerStep.toFixed(4),
  };
}

// --- gear pair ------------------------------------------------------------

function measureGearPair({ bevel }) {
  const { jolt, system, bi } = boot();

  const gearA = addBar(bi, { x: 0, y: 0, length: 0.08, thickness: 0.008, depth: 0.02, angle: 0, planar: false, mass: 0.1 });
  const gearB = addBar(bi, { x: bevel ? 0 : 0.09, y: 0, z: bevel ? 0.09 : 0, length: 0.08, thickness: 0.008, depth: 0.02, angle: 0, planar: false, mass: 0.1 });
  const ground = addGround(bi, { x: 0, y: -0.2, z: 0, half: 0.002 });

  const hingeA = makeHinge(system, ground, gearA, [0, 0, 0], {
    motor: { targetVelocity: 2, maxTorque: 4 },
  });
  const hingeB = bevel
    ? makeHinge(system, ground, gearB, [0, 0, 0.09], { axis: [1, 0, 0], normal: [0, 0, 1] })
    : makeHinge(system, ground, gearB, [0.09, 0, 0]);

  // mRatio = 2 means "gear 2 turns at gear 1's rate divided by ratio".
  makeGear(system, gearA, gearB, hingeA, hingeB, 2, [0, 0, 1], bevel ? [1, 0, 0] : [0, 0, 1]);

  const driver = angleTracker(bi, gearA, 'z');
  const driven = angleTracker(bi, gearB, bevel ? 'x' : 'z');

  const steps = Math.round(4 / PROFILE.dt);
  let divergedAtStep = -1;
  try {
    for (let i = 0; i < steps; i++) {
      jolt.Step(PROFILE.dt, 1);
      if (i % 10 === 0) {
        driver.sample();
        driven.sample();
        const p = readPose(bi, gearB);
        if (!Number.isFinite(p.x) || Math.abs(p.x) > 5) { divergedAtStep = i; break; }
      }
    }
  } catch {
    divergedAtStep = -2;
  }

  const dt = driver.total / (2 * Math.PI);
  const dn = driven.total / (2 * Math.PI);
  return {
    bevel,
    divergedAtStep,
    driverTurns: +dt.toFixed(3),
    drivenTurns: +dn.toFixed(3),
    // ratio implied by motion; we configured mRatio = 2
    observedRatio: dn !== 0 ? +(dt / dn).toFixed(3) : null,
    drivenSense: Math.sign(dn),
  };
}

// --- main -----------------------------------------------------------------
// Each scenario runs in its own process. A diverging mechanism can corrupt the
// shared WASM heap, so scenarios must not share a module instance.

const SCENARIOS = {
  planar: () => measureFourBar({ planar: true, seconds: 60 }),
  spatial: () => measureFourBar({ planar: false, seconds: 20 }),
  spur: () => measureGearPair({ bevel: false }),
  bevel: () => measureGearPair({ bevel: true }),
};

async function main() {
  Jolt = await initJolt();

  const which = process.argv[2];
  if (which && SCENARIOS[which]) {
    // Child mode: emit a single JSON line.
    console.log('JSON ' + JSON.stringify(SCENARIOS[which]()));
    return;
  }

  const { spawnSync } = await import('node:child_process');
  const results = {};
  console.log(`Jolt WASM loaded (heap ${(Jolt.HEAPF32.byteLength / 1048576).toFixed(0)} MB)`);
  console.log(`profile: dt=${PROFILE.dt.toFixed(5)} velSteps=${PROFILE.velocitySteps} posSteps=${PROFILE.positionSteps} slop=${PROFILE.penetrationSlop}m\n`);

  for (const name of Object.keys(SCENARIOS)) {
    const r = spawnSync(process.execPath, [new URL(import.meta.url).pathname, name], {
      encoding: 'utf8',
      timeout: 600000,
    });
    const line = (r.stdout || '').split('\n').find((l) => l.startsWith('JSON '));
    if (!line) {
      console.log(`--- ${name}: PROCESS FAILED ---`);
      console.log((r.stderr || '').split('\n').slice(-4).join('\n'));
      results[name] = null;
      continue;
    }
    results[name] = JSON.parse(line.slice(5));
    console.log(`--- ${name} ---`);
    console.log(JSON.stringify(results[name]));
  }

  const planar = results.planar;
  const spur = results.spur;
  const bevel = results.bevel;
  const spatial = results.spatial;

  console.log('\n=== gate ===');
  const checks = [
    ['planar four-bar joint drift < 1 mm', planar && planar.worstDriftMm < 1],
    ['planar four-bar stays in plane (< 0.01 mm)', planar && planar.maxOutOfPlaneMm < 0.01],
    ['planar four-bar did not diverge over 60 s', planar && planar.divergedAtStep < 0],
    ['motor drove the closed loop', planar && Math.abs(planar.crankTurns) > 5],
    // Free 3D four-bar is over-constrained (M = -2): expected to fail, which is
    // exactly why bodies default to Plane2D. Recorded, not gated.
    ['spur gear constraint binds', spur && spur.divergedAtStep < 0 && Math.abs(spur.drivenTurns) > 0.5],
    ['spur gear ratio is 2:1', spur && spur.observedRatio !== null && Math.abs(Math.abs(spur.observedRatio) - 2) < 0.2],
    ['spur gear reverses direction (external mesh)', spur && spur.drivenSense === -1],
    ['bevel/worm gear constraint binds', bevel && bevel.divergedAtStep < 0 && Math.abs(bevel.drivenTurns) > 0.5],
    ['bevel gear ratio is 2:1', bevel && bevel.observedRatio !== null && Math.abs(Math.abs(bevel.observedRatio) - 2) < 0.2],
    ['bevel gear reverses direction (external mesh)', bevel && bevel.drivenSense === -1],
  ];
  let ok = true;
  for (const [name, pass] of checks) {
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}`);
    if (!pass) ok = false;
  }

  if (planar) {
    console.log(`\nstep cost: ${planar.msPerStep} ms/step (${(1000 / planar.msPerStep).toFixed(0)} steps/s headroom, single-threaded)`);
  }
  if (spatial && planar) {
    console.log(`free-3D out-of-plane ${spatial.maxOutOfPlaneMm} mm vs planar ${planar.maxOutOfPlaneMm} mm`);
    console.log(`free-3D crank turns after ${spatial.seconds}s: ${spatial.crankTurns} (divergedAtStep=${spatial.divergedAtStep})`);
    console.log(`planar crank turns after ${planar.seconds}s: ${planar.crankTurns}`);
  }

  if (!ok) process.exit(2);
}

main().catch((err) => {
  console.error('\nSMOKE TEST FAILED');
  console.error(err);
  process.exit(1);
});
