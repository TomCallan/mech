import type { Vec3 } from '../core/math';
import type { Joint, Part, SceneDoc } from './types';
import { SCENE_VERSION } from './types';
import { createJoint, createPart, MATERIALS } from './factories';
import type { UnitSystem } from '../core/units';

/**
 * Preset mechanisms. These are the same shapes used to validate the solver in
 * scripts/smoke.mjs: the four-bar in particular holds ~1 µm of pin drift over a
 * minute of driven motion.
 */

function mid(a: Vec3, b: Vec3): Vec3 {
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
}

function linkBetween(
  id: string,
  a: Vec3,
  b: Vec3,
  plane: number,
  opts: { width?: number; thickness?: number; color?: string; density?: number } = {},
): Part {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const dz = b[2] - a[2];
  const length = Math.hypot(dx, dy, dz);
  const angle = Math.atan2(dy, dx);
  const base = createPart({
    kind: 'link',
    position: mid(a, b),
    rotation: [0, 0, angle],
    plane,
    units: 'm',
    dofs: 'plane2d',
    color: opts.color,
    density: opts.density,
  });
  return {
    ...base,
    id,
    name: 'Link',
    length,
    width: opts.width ?? 0.012,
    thickness: opts.thickness ?? 0.008,
  };
}

function pin(id: string, a: string | null, b: string, anchor: Vec3, axis: Vec3, motorTorque?: number, targetVelocity?: number): Joint {
  const j = createJoint({ kind: 'pin', a, b, anchor, axis });
  j.id = id;
  if (motorTorque !== undefined) {
    j.motor = {
      enabled: true,
      mode: 'velocity',
      targetVelocity: targetVelocity ?? Math.PI,
      targetPosition: 0,
      maxTorque: motorTorque,
    };
    j.compliance = { enabled: true, frequency: 60, damping: 1 };
  }
  return j;
}

function doc(name: string, units: UnitSystem, parts: Part[], joints: Joint[], patch: Partial<SceneDoc> = {}): SceneDoc {
  return {
    version: SCENE_VERSION,
    name,
    units,
    gravity: 9.81,
    gravityOn: false,
    planeSpacing: 0.04,
    planeDofLock: true,
    floor: false,
    parts,
    joints,
    ...patch,
  };
}

// --- four-bar crank-rocker -------------------------------------------------
// Strictly Grashof with margin: s + l = 0.045 + 0.16 = 0.205 < p + q =
// 0.09 + 0.18 = 0.27. The equality case (s + l == p + q) is a change point, a
// real singular configuration where the linkage can lock or flip branches, so the
// default example deliberately avoids it.
//
// The mechanism is also assembled at a non-collinear starting angle, since
// starting with the crank along the ground line is itself a singularity.

const FOUR_BAR = { crank: 0.045, coupler: 0.16, rocker: 0.09, ground: 0.18 };
const FOUR_BAR_START = 0.6;

export function solveFourBar(theta: number) {
  const { crank, coupler, rocker, ground } = FOUR_BAR;
  const A: Vec3 = [crank * Math.cos(theta), crank * Math.sin(theta), 0];
  const O2: Vec3 = [ground, 0, 0];
  const dx = O2[0] - A[0];
  const dy = O2[1] - A[1];
  const d = Math.hypot(dx, dy);
  const a = (coupler * coupler - rocker * rocker + d * d) / (2 * d);
  const h = Math.sqrt(Math.max(0, coupler * coupler - a * a));
  const ux = dx / d;
  const uy = dy / d;
  const B: Vec3 = [A[0] + a * ux - h * uy, A[1] + a * uy + h * ux, 0];
  return { A, B, O2 };
}

export function fourBar(units: UnitSystem = 'mm'): SceneDoc {
  const { A, B, O2 } = solveFourBar(FOUR_BAR_START);
  const O: Vec3 = [0, 0, 0];
  // The crank is deliberately the heaviest link. A crank-rocker passes through a
  // dead point every revolution where the transmission angle drops to zero and no
  // finite torque can push the loop through: it is carried by the crank's
  // momentum. A featherweight crank stalls there, exactly like real hardware.
  const parts: Part[] = [
    { ...linkBetween('fb_crank', O, A, 0, { color: '#7dd3fc', width: 0.022, thickness: 0.012, density: MATERIALS.steel }), name: 'Crank' },
    { ...linkBetween('fb_coupler', A, B, 0, { color: '#fca5a5', width: 0.01, thickness: 0.008, density: MATERIALS.aluminium }), name: 'Coupler' },
    { ...linkBetween('fb_rocker', O2, B, 0, { color: '#86efac', width: 0.01, thickness: 0.008, density: MATERIALS.aluminium }), name: 'Rocker' },
  ];
  const joints: Joint[] = [
    pin('fb_j1', null, 'fb_crank', O, [0, 0, 1], 0.4, Math.PI * 1.2),
    pin('fb_j2', 'fb_crank', 'fb_coupler', A, [0, 0, 1]),
    pin('fb_j3', 'fb_coupler', 'fb_rocker', B, [0, 0, 1]),
    pin('fb_j4', null, 'fb_rocker', O2, [0, 0, 1]),
  ];
  // Enough torque to drive the loop through its loaded positions, but still a
  // finite limit: a real motor stalls rather than driving anything instantly.
  const j1 = joints.find((j) => j.id === 'fb_j1')!;
  j1.motor = { enabled: true, mode: 'velocity', targetVelocity: Math.PI * 1.2, targetPosition: 0, maxTorque: 2 };

  return doc('Four-bar crank-rocker', units, parts, joints, { planeDofLock: true });
}

// --- slider-crank ----------------------------------------------------------

export function sliderCrank(units: UnitSystem = 'mm'): SceneDoc {
  const crankR = 0.04;
  const rodL = 0.14;
  const theta = 0;
  const A: Vec3 = [crankR * Math.cos(theta), crankR * Math.sin(theta), 0];
  const O: Vec3 = [0, 0, 0];
  // Crank angle 0 puts the rod along +X; the piston sits at A + rodL.
  const P: Vec3 = [A[0] + rodL, 0, 0];

  const piston: Part = {
    ...createPart({ kind: 'link', position: P, rotation: [0, 0, Math.PI / 2], plane: 0, units: 'm', dofs: 'plane2d', color: '#fcd34d' }),
    id: 'sc_piston',
    name: 'Piston',
    length: 0.05,
    width: 0.03,
    thickness: 0.012,
  };

  const parts: Part[] = [
    { ...linkBetween('sc_crank', O, A, 0, { color: '#7dd3fc' }), name: 'Crank' },
    { ...linkBetween('sc_rod', A, P, 0, { color: '#c4b5fd' }), name: 'Con rod' },
    piston,
  ];

  const joints: Joint[] = [
    pin('sc_j1', null, 'sc_crank', O, [0, 0, 1], 0.3, Math.PI * 1.5),
    pin('sc_j2', 'sc_crank', 'sc_rod', A, [0, 0, 1]),
    pin('sc_j3', 'sc_rod', 'sc_piston', P, [0, 0, 1]),
  ];
  // Guide the piston along X with a slider that has travel either side.
  const guide = createJoint({ kind: 'slider', a: null, b: 'sc_piston', anchor: P, axis: [1, 0, 0] });
  guide.id = 'sc_slide';
  guide.limits = { enabled: true, min: -0.16, max: 0.02 };
  joints.push(guide);

  return doc('Slider-crank', units, parts, joints);
}

// --- gear train ------------------------------------------------------------

function gearPart(
  id: string,
  name: string,
  radius: number,
  teeth: number,
  position: Vec3,
  plane: number,
  color: string,
  kind: Part['kind'] = 'gear',
  extra: Partial<Part> = {},
): Part {
  const p = createPart({
    kind,
    position,
    rotation: [0, 0, 0],
    plane,
    units: 'm',
    dofs: 'plane2d',
    color,
    density: MATERIALS.brass,
  });
  return { ...p, ...extra, id, name, radius, teeth, thickness: 0.008 };
}

export function gearTrain(units: UnitSystem = 'mm'): SceneDoc {
  const tA = 12, tB = 24, tC = 12;
  const module_ = 0.0025; // pitch diameter = teeth * module
  const rA = (tA * module_) / 2;
  const rB = (tB * module_) / 2;
  const rC = (tC * module_) / 2;

  const pA: Vec3 = [0, 0, 0];
  const pB: Vec3 = [rA + rB, 0, 0];
  const pC: Vec3 = [rA + 2 * rB + rC, 0, 0];

  const parts: Part[] = [
    gearPart('gt_a', 'Gear A (12T)', rA, tA, pA, 0, '#7dd3fc'),
    gearPart('gt_b', 'Gear B (24T)', rB, tB, pB, 0, '#fcd34d'),
    gearPart('gt_c', 'Gear C (12T)', rC, tC, pC, 0, '#86efac'),
  ];

  const jA = pin('gt_ja', null, 'gt_a', pA, [0, 0, 1], 0.35, Math.PI * 0.8);
  const jB = pin('gt_jb', null, 'gt_b', pB, [0, 0, 1]);
  const jC = pin('gt_jc', null, 'gt_c', pC, [0, 0, 1]);

  // External mesh: driven = -driver / ratio, so ratio = teethDriven / teethDriver.
  const gAB = createJoint({ kind: 'gear', a: 'gt_a', b: 'gt_b', anchor: pA, axis: [0, 0, 1], ratio: tB / tA, couplingA: 'gt_ja', couplingB: 'gt_jb' });
  gAB.id = 'gt_g1';
  const gBC = createJoint({ kind: 'gear', a: 'gt_b', b: 'gt_c', anchor: pB, axis: [0, 0, 1], ratio: tC / tB, couplingA: 'gt_jb', couplingB: 'gt_jc' });
  gBC.id = 'gt_g2';

  return doc('Gear train', units, parts, [jA, jB, jC, gAB, gBC]);
}

// --- bevel pair ------------------------------------------------------------

export function bevelPair(units: UnitSystem = 'mm'): SceneDoc {
  const r = 0.028;
  const driver = {
    ...gearPart('bv_a', 'Bevel driver (axis Z)', r, 16, [0, 0, 0], 0, '#7dd3fc', 'bevel', { coneAngle: 45 }),
    dofs: 'free' as const,
  };
  const driven = {
    ...gearPart('bv_b', 'Bevel driven (axis X)', r, 16, [0, 0, r], 0, '#fdba74', 'bevel', { coneAngle: 45 }),
    dofs: 'free' as const,
  };

  const jA = pin('bv_ja', null, 'bv_a', [0, 0, 0], [0, 0, 1], 0.35, Math.PI);
  const jB = pin('bv_jb', null, 'bv_b', [0, 0, r], [1, 0, 0]);

  const g = createJoint({ kind: 'gear', a: 'bv_a', b: 'bv_b', anchor: [0, 0, 0], axis: [0, 0, 1], ratio: 1, couplingA: 'bv_ja', couplingB: 'bv_jb' });
  g.id = 'bv_g1';

  // Note: right-angle axes, so the two levels are genuinely different.
  return doc('Bevel pair (right-angle)', units, [driver, driven], [jA, jB, g], { planeSpacing: 0.05 });
}

// --- worm drive ------------------------------------------------------------

export function wormDrive(units: UnitSystem = 'mm'): SceneDoc {
  const rWorm = 0.008;
  const rGear = 0.04;
  const teeth = 24;

  const worm = {
    ...gearPart('wm_a', 'Worm (1 start)', rWorm, 1, [0, -(rGear + rWorm), 0], 0, '#c4b5fd', 'worm', { leadAngle: 8 }),
    thickness: 0.03,
    dofs: 'free' as const,
  };
  const wheel = {
    ...gearPart('wm_b', 'Worm wheel (24T)', rGear, teeth, [0, 0, 0], 0, '#fcd34d', 'gear'),
    dofs: 'free' as const,
  };

  const jA = pin('wm_ja', null, 'wm_a', [0, -(rGear + rWorm), 0], [1, 0, 0], 0.5, Math.PI * 2);
  const jB = pin('wm_jb', null, 'wm_b', [0, 0, 0], [0, 0, 1]);
  // A single-start worm advances the wheel one tooth per revolution.
  const g = createJoint({ kind: 'gear', a: 'wm_a', b: 'wm_b', anchor: [0, 0, 0], axis: [1, 0, 0], ratio: teeth, couplingA: 'wm_ja', couplingB: 'wm_jb' });
  g.id = 'wm_g1';

  return doc('Worm drive', units, [worm, wheel], [jA, jB, g], { planeSpacing: 0.05 });
}

// --- pendulum under gravity ------------------------------------------------

export function pendulum(units: UnitSystem = 'mm'): SceneDoc {
  const O: Vec3 = [0, 0.18, 0];
  const bob: Vec3 = [0.04, -0.1, 0];
  const parts: Part[] = [
    { ...linkBetween('pd_arm', O, bob, 0, { color: '#7dd3fc', width: 0.014 }), name: 'Arm' },
    { ...gearPart('pd_mass', 'Bob', 0.022, 12, bob, 0, '#fca5a5', 'disc'), dofs: 'plane2d' as const },
  ];
  const joints: Joint[] = [
    pin('pd_j1', null, 'pd_arm', O, [0, 0, 1]),
    pin('pd_j2', 'pd_arm', 'pd_mass', bob, [0, 0, 1]),
  ];
  return doc('Pendulum', units, parts, joints, { gravityOn: true });
}

// --- catalogue -------------------------------------------------------------

export interface ExampleEntry {
  key: string;
  label: string;
  summary: string;
  build: (units: UnitSystem) => SceneDoc;
}

export const EXAMPLES: ExampleEntry[] = [
  { key: 'fourBar', label: 'Four-bar crank-rocker', summary: 'Driven closed loop; the reference case for pin stiffness', build: fourBar },
  { key: 'sliderCrank', label: 'Slider-crank', summary: 'Rotary to linear, with a guided piston', build: sliderCrank },
  { key: 'gearTrain', label: 'Gear train', summary: 'Two meshes, 2:1 then 1:2, teeth-proportional sizes', build: gearTrain },
  { key: 'bevelPair', label: 'Bevel pair', summary: 'Right-angle axes on separate levels', build: bevelPair },
  { key: 'wormDrive', label: 'Worm drive', summary: '24:1 reduction across perpendicular axes', build: wormDrive },
  { key: 'pendulum', label: 'Pendulum', summary: 'Gravity, no motor: a sanity check', build: pendulum },
];

export function buildExample(key: string, units: UnitSystem): SceneDoc {
  const entry = EXAMPLES.find((e) => e.key === key) ?? EXAMPLES[0];
  return entry.build(units);
}
