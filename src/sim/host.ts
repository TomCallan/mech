import { SimWorld, type JointMetric } from './world';
import { FIXED_DT, SOLVER_HZ } from './jolt';
import type { SceneDoc } from '../scene/types';

/**
 * Owns the SimWorld and the fixed-timestep loop.
 *
 * The document is the source of truth; the world is a projection that is rebuilt
 * only when the document's `simRevision` changes. Live parameter tweaks travel
 * through `applyLive` so adjusting a motor does not reset the motion.
 *
 * Frames render the newest state rather than interpolating between two: at
 * 120 Hz the worst-case staleness is under 8 ms, which is imperceptible and
 * avoids an entire class of interpolation bugs around jointed geometry.
 */
export class SimHost {
  world: SimWorld | null = null;
  metrics: JointMetric[] = [];
  lastStepMs = 0;
  stepsThisSecond = 0;
  blownUp = false;

  private building = false;
  private builtRevision = -1;
  private liveRevision = -1;
  private accumulator = 0;
  private index = new Map<string, number>();
  private metricCountdown = 0;
  private stepCounter = 0;
  private rateWindowStart = 0;
  private rateSteps = 0;

  get poses(): Float32Array | null {
    return this.world ? this.world.poses : null;
  }

  get ready(): boolean {
    return this.world !== null;
  }

  get busy(): boolean {
    return this.building;
  }

  indexOf(partId: string): number {
    return this.index.get(partId) ?? -1;
  }

  /**
   * Rebuild the world when the document's structure changes. Awaits Jolt's
   * first-time WASM load, which is why this is async.
   */
  async sync(doc: SceneDoc, simRevision: number, liveRevision: number): Promise<void> {
    if (this.building) return;
    if (this.builtRevision === simRevision && this.world) {
      if (this.liveRevision !== liveRevision) {
        this.world.applyLive(doc);
        this.liveRevision = liveRevision;
      }
      return;
    }

    this.building = true;
    try {
      // The physics engine is shared for the process, so the old world must be
      // cleared before the new one is built into the same body space.
      const old = this.world;
      this.world = null;
      old?.dispose();

      const next = await SimWorld.create(doc);
      this.world = next;
      this.index.clear();
      doc.parts.forEach((p, i) => this.index.set(p.id, i));

      this.builtRevision = simRevision;
      this.liveRevision = liveRevision;
      this.accumulator = 0;
      this.blownUp = false;
      this.metrics = [];
      this.stepCounter = 0;
    } finally {
      this.building = false;
    }
  }

  /** Advance the simulation by wall-clock time. Call once per animation frame. */
  advance(dtSeconds: number, running: boolean): void {
    const world = this.world;
    if (!world) return;

    this.blownUp = world.blownUp;

    if (running && !world.blownUp) {
      // Clamp so a backgrounded tab cannot produce a burst of catch-up steps.
      this.accumulator += Math.min(dtSeconds, 0.1);
      let steps = 0;
      while (this.accumulator >= FIXED_DT && steps < 8) {
        world.step();
        this.accumulator -= FIXED_DT;
        steps += 1;
        this.stepCounter += 1;
        this.rateSteps += 1;
      }
      if (steps > 0) {
        const now = performance.now();
        if (this.rateWindowStart === 0) this.rateWindowStart = now;
        if (now - this.rateWindowStart >= 1000) {
          this.stepsThisSecond = this.rateSteps;
          this.rateSteps = 0;
          this.rateWindowStart = now;
        }
      }
      if (steps >= 8) this.accumulator = 0; // drop the backlog rather than spiral
      world.readPoses();
      this.blownUp = world.blownUp;
    } else {
      this.accumulator = 0;
    }

    // Instrumentation is comparatively expensive; sample it at about 20 Hz.
    if (this.metricCountdown <= 0) {
      this.metrics = world.readMetrics();
      this.metricCountdown = SOLVER_HZ / 20;
    } else {
      this.metricCountdown -= 1;
    }
  }

  // --- direct manipulation -------------------------------------------------

  grab(partId: string, point: [number, number, number]): void {
    this.world?.grab(partId, point);
  }

  moveGrab(point: [number, number, number]): void {
    this.world?.moveGrab(point);
  }

  endGrab(): void {
    this.world?.endGrab();
  }

  partPose(partId: string): { pos: [number, number, number]; rot: [number, number, number, number] } | null {
    const p = this.world?.poseOf(partId);
    return p ? { pos: p.pos, rot: p.rot } : null;
  }

  dispose(): void {
    this.world?.dispose();
    this.world = null;
  }
}
