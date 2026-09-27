import { LAYER_MOVING, LAYER_NON_MOVING, solver, getJolt, type JoltApi } from './jolt';

/* The Jolt WebIDL surface is effectively untyped; this is the one place where
 * `any` is pragmatic, and every call here is covered by the lifecycle tests in
 * scripts/lifecycle6.mjs and the integration tests in scripts/integration.ts. */
type Any = any;

/**
 * Process-wide physics engine.
 *
 * One JoltInterface is created and then reused for the whole session. Rebuilding
 * a mechanism only swaps its bodies and constraints, because:
 *
 *  - Jolt allocates one large block per JoltInterface and exposes instance-level
 *    statics, so churning interfaces is both wasteful and fragile.
 *  - Bodies and constraints are cheap to recreate, and a rebuild is already a
 *    full clear-and-rebuild.
 *
 * Ownership rules, established empirically (see scripts/lifecycle*.mjs):
 *  - `new Jolt.SomeShape(...)` starts at reference count 0. Call AddRef() to hold
 *    your own reference, or the shape is freed the moment its last body dies and
 *    a later CreateBody reads freed memory ("table index is out of bounds").
 *  - Release() is how you give that reference up. Never Jolt.destroy a Shape or
 *    a Constraint: those are RefTarget subclasses and destroy is a hard
 *    destructor, so it frees objects other code still references.
 *  - AddConstraint takes a reference and RemoveConstraint releases it, so
 *    constraints need no explicit teardown.
 *  - Plain structs (JoltSettings, SpringSettings, MotorSettings,
 *    BodyCreationSettings, ConstraintSettings, layer tables) are not RefTargets
 *    and are correct to Jolt.destroy once consumed.
 */

export interface Engine {
  Jolt: JoltApi;
  jolt: Any;
  system: Any;
  bi: Any;
  /** Plain, engine-lifetime structs; destroyed only if the engine is reset. */
  owned: Any[];
}

let engine: Engine | null = null;
let loading: Promise<Engine> | null = null;

export const ENGINE_CAPACITY = {
  maxBodies: 4096,
  maxBodyPairs: 16384,
  maxContactConstraints: 4096,
} as const;

export async function getEngine(): Promise<Engine> {
  if (engine) return engine;
  if (!loading) {
    loading = (async () => {
      const Jolt = await getJolt();

      const settings = new Jolt.JoltSettings();
      // Single-threaded: no SharedArrayBuffer, no COOP/COEP requirement.
      settings.mMaxWorkerThreads = 0;
      settings.mMaxBodies = ENGINE_CAPACITY.maxBodies;
      settings.mMaxBodyPairs = ENGINE_CAPACITY.maxBodyPairs;
      settings.mMaxContactConstraints = ENGINE_CAPACITY.maxContactConstraints;

      const pairFilter = new Jolt.ObjectLayerPairFilterTable(2);
      pairFilter.EnableCollision(LAYER_NON_MOVING, LAYER_MOVING);
      pairFilter.EnableCollision(LAYER_NON_MOVING, LAYER_NON_MOVING);
      // Moving parts pass through each other. Mechanisms are held by joints, and
      // contact manifolds fighting the constraint solver is a classic blow-up.
      pairFilter.DisableCollision(LAYER_MOVING, LAYER_MOVING);

      const bpInterface = new Jolt.BroadPhaseLayerInterfaceTable(2, 2);
      bpInterface.MapObjectToBroadPhaseLayer(LAYER_NON_MOVING, new Jolt.BroadPhaseLayer(0));
      bpInterface.MapObjectToBroadPhaseLayer(LAYER_MOVING, new Jolt.BroadPhaseLayer(1));

      settings.mObjectLayerPairFilter = pairFilter;
      settings.mBroadPhaseLayerInterface = bpInterface;
      settings.mObjectVsBroadPhaseLayerFilter = new Jolt.ObjectVsBroadPhaseLayerFilterTable(
        bpInterface,
        2,
        pairFilter,
        2,
      );

      const jolt = new Jolt.JoltInterface(settings);
      const system = jolt.GetPhysicsSystem();
      const ps = system.GetPhysicsSettings();
      ps.mPenetrationSlop = solver.penetrationSlop;
      ps.mSpeculativeContactDistance = solver.speculativeContactDistance;
      ps.mMinVelocityForRestitution = solver.minVelocityForRestitution;
      ps.mDeterministicSimulation = true;
      ps.mConstraintWarmStart = true;
      // Sleeping is off deliberately. A mechanism that briefly slows can fall
      // asleep and then ignore its motor forever, which reads as "my motor does
      // nothing". A sandbox has no shortage of solver headroom to spend here.
      ps.mAllowSleeping = false;
      applySolverSettings(system);

      engine = {
        Jolt,
        jolt,
        system,
        bi: system.GetBodyInterface(),
        owned: [settings, pairFilter, bpInterface],
      };
      return engine;
    })();
  }
  return loading;
}

/** Pushes the current solver configuration onto the live physics system. */
export function applySolverSettings(system: Any): void {
  const ps = system.GetPhysicsSettings();
  ps.mNumVelocitySteps = solver.velocitySteps;
  ps.mNumPositionSteps = solver.positionSteps;
  ps.mBaumgarte = solver.baumgarte;
  ps.mPenetrationSlop = solver.penetrationSlop;
}
