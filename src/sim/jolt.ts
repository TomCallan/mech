export type JoltApi = Awaited<ReturnType<typeof import('jolt-physics/wasm').default>>;

/**
 * Jolt bootstrap.
 *
 * Two load paths, because they need different builds of the same library:
 *  - Browser: the `wasm` flavour with a bundler-resolved .wasm URL.
 *  - Tests/Node: whatever loader is injected (the `wasm-compat` flavour, whose
 *    .wasm is base64-embedded and therefore needs no asset pipeline).
 *
 * The injected-loader seam is what lets scripts/integration.ts drive the real
 * SimWorld under Node instead of a reimplementation of it.
 */
export type JoltLoader = () => Promise<JoltApi>;

let loader: JoltLoader | null = null;
let instance: JoltApi | null = null;
let loading: Promise<JoltApi> | null = null;

export function setJoltLoader(next: JoltLoader): void {
  loader = next;
  instance = null;
  loading = null;
}

/**
 * The single-threaded build is deliberate: no SharedArrayBuffer means no
 * COOP/COEP headers, so this stays embeddable in an iframe and hostable on any
 * static host. Hundreds of bodies at 120 Hz cost well under a millisecond.
 */
export async function getJolt(): Promise<JoltApi> {
  if (instance) return instance;
  if (!loading) {
    loading = (async () => {
      if (loader) {
        instance = await loader();
        return instance;
      }
      const [{ default: initJolt }, { default: url }] = await Promise.all([
        import('jolt-physics/wasm'),
        import('./wasmUrl'),
      ]);
      instance = (await initJolt({ locateFile: () => url })) as JoltApi;
      return instance;
    })();
  }
  return loading;
}

/**
 * Solver profile. Jolt's defaults target metre-scale objects: mPenetrationSlop
 * alone defaults to 0.02 m, which is 20% of a 100 mm link. These values were
 * validated by scripts/smoke.mjs, which holds a driven four-bar to about a
 * micrometre of joint drift over 60 s of simulated time.
 */
export const SOLVER_HZ = 120;
export const FIXED_DT = 1 / SOLVER_HZ;

/**
 * Solver configuration, mutable at runtime because these are exactly the knobs an
 * engineering sandbox should expose.
 *
 * The values were validated by scripts/smoke.mjs, which holds a driven four-bar
 * to about a micrometre of joint drift over 60 s of simulated time.
 */
export const solver = {
  /** Collision steps per outer step. 1 matches the validated configuration. */
  collisionSteps: 1,
  /** Higher is stiffer but costs more; 8 is already very tight for linkages. */
  velocitySteps: 8,
  /** Iterations of positional correction against drift. */
  positionSteps: 3,
  /** Kept low: high Baumgarte injects energy into fast closed loops. */
  baumgarte: 0.1,
  penetrationSlop: 0.0005,
  speculativeContactDistance: 0.001,
  minVelocityForRestitution: 0.1,
  /** A mechanism this far out has diverged; stop before it corrupts the heap. */
  divergenceLimit: 5,
};

export const LAYER_NON_MOVING = 0;
export const LAYER_MOVING = 1;
