import type { Vec3 } from '../core/math';
import type { Joint, JointKind, Part, PartKind } from './types';
import type { UnitSystem } from '../core/units';

let counter = 0;

export function newId(prefix: string): string {
  counter += 1;
  return `${prefix}_${counter.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export const MATERIALS: Record<string, number> = {
  steel: 7850,
  stainless: 8000,
  aluminium: 2700,
  brass: 8500,
  nylon: 1150,
  acrylic: 1180,
};

export const PALETTE = [
  '#7dd3fc', '#fca5a5', '#86efac', '#fcd34d',
  '#c4b5fd', '#f9a8d4', '#a5f3fc', '#fdba74',
  '#93c5fd', '#bef264',
];

function pickColor(): string {
  return PALETTE[Math.floor(Math.random() * PALETTE.length)];
}

export interface PartInit {
  kind: PartKind;
  position: Vec3;
  rotation?: Vec3;
  plane: number;
  units: UnitSystem;
  dofs: 'plane2d' | 'free';
  color?: string;
  density?: number;
}

const THICKNESS: Record<UnitSystem, number> = { mm: 0.008, cm: 0.008, m: 0.008, in: 0.0079 };
const LINK_LEN: Record<UnitSystem, number> = { mm: 0.08, cm: 0.08, m: 0.08, in: 0.0762 };

function base(init: PartInit, name: string): Omit<Part, 'kind' | 'thickness'> & { kind: PartKind } {
  return {
    id: newId('p'),
    kind: init.kind,
    name,
    plane: init.plane,
    position: init.position,
    rotation: init.rotation ?? [0, 0, 0],
    density: init.density ?? MATERIALS.aluminium,
    color: init.color ?? pickColor(),
    dofs: init.dofs,
    fixed: false,
  };
}

export function createPart(init: PartInit): Part {
  const t = THICKNESS[init.units];
  switch (init.kind) {
    case 'link':
      return {
        ...base(init, 'Link'),
        kind: 'link',
        length: LINK_LEN[init.units],
        width: LINK_LEN[init.units] * 0.22,
        thickness: t,
      };
    case 'disc':
      return {
        ...base(init, 'Disc'),
        kind: 'disc',
        radius: LINK_LEN[init.units] * 0.5,
        thickness: t,
      };
    case 'gear':
      return {
        ...base(init, 'Gear'),
        kind: 'gear',
        radius: LINK_LEN[init.units] * 0.45,
        teeth: 18,
        thickness: t * 1.5,
      };
    case 'bevel':
      return {
        ...base(init, 'Bevel gear'),
        kind: 'bevel',
        radius: LINK_LEN[init.units] * 0.45,
        teeth: 18,
        coneAngle: 45,
        thickness: t * 1.5,
      };
    case 'worm':
      return {
        ...base(init, 'Worm'),
        kind: 'worm',
        radius: LINK_LEN[init.units] * 0.18,
        teeth: 2,
        leadAngle: 12,
        thickness: t * 3,
      };
  }
}

export interface JointInit {
  kind: JointKind;
  a: string | null;
  b: string;
  anchor: Vec3;
  axis: Vec3;
  ratio?: number;
  couplingA?: string;
  couplingB?: string;
}

export function createJoint(init: JointInit): Joint {
  const j: Joint = {
    id: newId('j'),
    kind: init.kind,
    a: init.a,
    b: init.b,
    anchor: init.anchor,
    axis: init.axis,
  };
  if (init.kind === 'gear') {
    j.ratio = init.ratio ?? 2;
    j.couplingA = init.couplingA;
    j.couplingB = init.couplingB;
  }
  if (init.kind === 'pin') {
    j.motor = {
      enabled: false,
      mode: 'velocity',
      targetVelocity: Math.PI,
      targetPosition: 0,
      maxTorque: 0.5,
    };
    j.limits = { enabled: false, min: -Math.PI, max: Math.PI };
  }
  if (init.kind === 'slider') {
    j.limits = { enabled: false, min: -0.05, max: 0.05 };
    j.motor = {
      enabled: false,
      mode: 'velocity',
      targetVelocity: 0.05,
      targetPosition: 0,
      maxTorque: 5,
    };
  }
  return j;
}

export function defaultJointAxis(): Vec3 {
  // Rotation axes default to Z so new pins are perpendicular to the work plane.
  return [0, 0, 1];
}
