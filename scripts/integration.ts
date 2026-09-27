/**
 * Headless integration test for the application's own simulation layer.
 *
 * This drives the real SimWorld, the real example documents and the real joint
 * compiler through Node, using the base64-embedded `wasm-compat` build of Jolt.
 * It is not a reimplementation: scripts/smoke.mjs validates the solver settings,
 * this validates the app.
 *
 * Run: npm run test:sim
 */

import initJolt from 'jolt-physics/wasm-compat';
import { FIXED_DT, setJoltLoader, solver } from '../src/sim/jolt';
import { SimWorld } from '../src/sim/world';
import { EXAMPLES, buildExample } from '../src/scene/examples';
import { deserialize, serialize } from '../src/scene/serialize';
import { emptyScene, levelZ } from '../src/scene/types';

setJoltLoader(async () => (await initJolt()) as never);

const results: { name: string; pass: boolean; detail: string }[] = [];

function check(name: string, pass: boolean, detail = ''): void {
  results.push({ name, pass, detail });
}

function approx(a: number, b: number, tol: number): boolean {
  return Math.abs(a - b) <= tol;
}

/**
 * Steps the world. Angle metrics accumulate across readMetrics calls, so any
 * check that reads an angle has to sample during the run, exactly as the app's
 * instrumentation does at ~20 Hz. A single reading at the end would only
 * initialise the accumulator and report zero.
 */
function stepFor(world: SimWorld, seconds: number, sample = true): void {
  const steps = Math.round(seconds / FIXED_DT);
  for (let i = 0; i < steps; i++) {
    world.step();
    if (world.blownUp) return;
    if (sample && i % 6 === 5) world.readMetrics();
  }
  world.readMetrics();
  world.readPoses();
}

async function main() {
  console.log('=== scene documents ===');

  // Every example must survive serialisation unchanged.
  for (const entry of EXAMPLES) {
    const doc = entry.build('mm');
    const round = deserialize(serialize(doc));
    check(
      `example "${entry.key}" round-trips through JSON`,
      round.warnings.length === 0 && round.doc.parts.length === doc.parts.length &&
        round.doc.joints.length === doc.joints.length,
      `${round.warnings.length} warnings`,
    );
  }

  console.log('=== every example simulates without diverging ===');

  for (const entry of EXAMPLES) {
    const doc = entry.build('mm');
    const world = await SimWorld.create(doc);
    const driven = entry.key !== 'pendulum';
    stepFor(world, entry.key === 'wormDrive' ? 4 : 6);
    const metrics = world.readMetrics();
    const moved = metrics.some((m) => Math.abs(m.value) > 0.01 || Math.abs(m.speed) > 0.001);
    check(
      `example "${entry.key}" runs 6 s without diverging`,
      !world.blownUp,
      world.blownUp ? 'blown up' : `${metrics.length} joints tracked`,
    );
    if (driven) {
      check(`example "${entry.key}" actually moves`, moved, moved ? 'motion detected' : 'nothing moved');
    }
    world.dispose();
  }

  console.log('=== four-bar accuracy ===');
  {
    const doc = buildExample('fourBar', 'mm');
    const world = await SimWorld.create(doc);
    const motor = doc.joints.find((j) => j.id === 'fb_j1')!;
    const target = motor.motor!.targetVelocity;

    const seconds = 10;
    stepFor(world, seconds);
    const metrics = world.readMetrics();
    const crank = metrics.find((m) => m.id === 'fb_j1')!;
    const expectedTurns = (target * seconds) / (2 * Math.PI);
    const actualTurns = crank.value / (2 * Math.PI);

    check(
      'four-bar crank tracks its commanded speed',
      approx(actualTurns, expectedTurns, Math.max(0.6, Math.abs(expectedTurns) * 0.1)),
      `${actualTurns.toFixed(2)} turns vs ${expectedTurns.toFixed(2)} expected`,
    );
    check(
      'four-bar reaction force is reported',
      metrics.some((m) => m.forceN > 0.01),
      `max ${Math.max(...metrics.map((m) => m.forceN)).toFixed(3)} N`,
    );
    world.dispose();
  }

  console.log('=== gear ratios ===');
  {
    const doc = buildExample('gearTrain', 'mm');
    const world = await SimWorld.create(doc);
    stepFor(world, 6);
    const metrics = world.readMetrics();
    const a = metrics.find((m) => m.id === 'gt_ja')!;
    const b = metrics.find((m) => m.id === 'gt_jb')!;
    const ratio = b.value / a.value;
    // 24T driven by 12T: half speed, reversed.
    check(
      'gear train 12T:24T gives -0.5 speed ratio',
      approx(ratio, -0.5, 0.05),
      `measured ${ratio.toFixed(3)}`,
    );
    world.dispose();
  }
  {
    const doc = buildExample('wormDrive', 'mm');
    const world = await SimWorld.create(doc);
    stepFor(world, 6);
    const metrics = world.readMetrics();
    const a = metrics.find((m) => m.id === 'wm_ja')!;
    const b = metrics.find((m) => m.id === 'wm_jb')!;
    const ratio = b.value / a.value;
    check(
      'worm drive 24:1 reduction',
      approx(Math.abs(ratio), 1 / 24, 0.02),
      `measured 1/${(1 / Math.abs(ratio)).toFixed(1)}`,
    );
    world.dispose();
  }
  {
    const doc = buildExample('bevelPair', 'mm');
    const world = await SimWorld.create(doc);
    stepFor(world, 6);
    const metrics = world.readMetrics();
    const a = metrics.find((m) => m.id === 'bv_ja')!;
    const b = metrics.find((m) => m.id === 'bv_jb')!;
    const ratio = b.value / a.value;
    check('bevel pair 1:1 reverses', approx(ratio, -1, 0.1), `measured ${ratio.toFixed(3)}`);
    world.dispose();
  }

  console.log('=== live edits do not rebuild or reset motion ===');
  {
    const doc = buildExample('fourBar', 'mm');
    const world = await SimWorld.create(doc);
    stepFor(world, 2);
    const before = world.readMetrics().find((m) => m.id === 'fb_j1')!.value;

    // Change the commanded speed in place, as the inspector does.
    const next = { ...doc, joints: doc.joints.map((j) => (j.id === 'fb_j1' ? { ...j, motor: { ...j.motor!, targetVelocity: -4 } } : j)) };
    world.applyLive(next);
    stepFor(world, 2);
    const after = world.readMetrics().find((m) => m.id === 'fb_j1')!.value;

    const forwardTwoSeconds = doc.joints.find((j) => j.id === 'fb_j1')!.motor!.targetVelocity * 2;
    check(
      'applyLive reverses the motor without losing accumulated angle',
      after < before && before > forwardTwoSeconds * 0.5,
      `angle ${before.toFixed(2)} -> ${after.toFixed(2)} rad (did not reset to 0)`,
    );
    world.dispose();
  }

  console.log('=== gravity and the floor ===');
  {
    const doc = emptyScene('mm');
    doc.floor = true;
    doc.gravityOn = true;
    doc.gravity = 9.81;
    // A free disc dropped from 0.2 m above the floor at y = -0.35.
    doc.parts = [{
      id: 'drop', kind: 'disc', name: 'Drop', plane: 0,
      position: [0, 0.05, 0], rotation: [0, 0, 0],
      density: 2700, color: '#ffffff', dofs: 'plane2d', fixed: false,
      radius: 0.02, thickness: 0.008,
    }];
    const world = await SimWorld.create(doc);
    const startY = world.poses[1];
    stepFor(world, 3);
    const endY = world.poses[1];
    check(
      'a dropped part falls and lands on the floor rather than through it',
      endY < startY && endY > -0.35,
      `y ${startY.toFixed(3)} -> ${endY.toFixed(3)} (floor contact at about -0.34)`,
    );
    world.dispose();
  }

  console.log('=== direct manipulation ===');
  {
    const doc = buildExample('pendulum', 'mm');
    doc.gravityOn = false; // isolate the servo from gravity
    const world = await SimWorld.create(doc);
    const bobIndex = doc.parts.findIndex((p) => p.id === 'pd_mass');
    const start = [world.poses[bobIndex * 7], world.poses[bobIndex * 7 + 1]];

    const target: [number, number, number] = [start[0] + 0.06, start[1] + 0.02, 0];
    world.grab('pd_mass', [start[0], start[1], 0]);
    world.moveGrab(target);
    stepFor(world, 1.5);
    const end = [world.poses[bobIndex * 7], world.poses[bobIndex * 7 + 1]];
    world.endGrab();

    const movedToward =
      Math.hypot(end[0] - target[0], end[1] - target[1]) <
      Math.hypot(start[0] - target[0], start[1] - target[1]);
    check(
      'grabbing drags the body toward the cursor through its constraints',
      movedToward,
      `moved ${(Math.hypot(end[0] - start[0], end[1] - start[1]) * 1000).toFixed(1)} mm of ${(0.06 * 1000).toFixed(0)} mm requested`,
    );
    world.dispose();
  }

  console.log('=== rebuild and teardown churn ===');
  {
    let ok = true;
    let detail = '';
    try {
      for (let i = 0; i < 6; i++) {
        const doc = buildExample(EXAMPLES[i % EXAMPLES.length].key, 'mm');
        const world = await SimWorld.create(doc);
        stepFor(world, 0.4);
        world.dispose();
      }
    } catch (err) {
      ok = false;
      detail = String(err instanceof Error ? err.message : err);
    }
    check('repeated build/step/dispose cycles do not corrupt the heap', ok, detail || '6 cycles clean');
  }

  console.log('=== level geometry ===');
  {
    const spacing = 0.04;
    check(
      'levels map to z offsets and back',
      approx(levelZ(2, spacing), 0.08, 1e-12) && approx(Math.round(0.081 / spacing), 2, 0),
      'levelZ(2) = 0.08 m',
    );
    check('divergence guard is configured', solver.divergenceLimit > 0, `limit ${solver.divergenceLimit} m`);
  }

  // --- report -------------------------------------------------------------
  console.log('');
  let failures = 0;
  for (const r of results) {
    if (!r.pass) failures += 1;
    console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? `  [${r.detail}]` : ''}`);
  }
  console.log(`\n${results.length - failures}/${results.length} checks passed`);
  if (failures > 0) process.exit(1);
}

main().catch((err) => {
  console.error('INTEGRATION TEST THREW');
  console.error(err);
  process.exit(1);
});
