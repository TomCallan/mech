import type { Vec3 } from '../core/math';
import type { UnitSystem } from '../core/units';

/**
 * The document is the single source of truth for the editor. It is plain,
 * serialisable data; the physics world in the simulation layer is a derived,
 * disposable projection of it.
 */

export type PartKind = 'link' | 'disc' | 'gear' | 'bevel' | 'worm';

export interface Part {
  id: string;
  kind: PartKind;
  name: string;
  /** Authoring level. Levels are z offsets; motion within a level is planar. */
  plane: number;
  /** Metres, world space. */
  position: Vec3;
  /** Euler XYZ, radians. */
  rotation: Vec3;
  /** kg/m^3. Steel is 7850, aluminium 2700, nylon 1150. */
  density: number;
  color: string;
  /**
   * 'plane2d' locks the body to its level (translation X/Y + rotation Z only).
   * A planar four-bar built with free 3D pins is over-constrained (mobility -2)
   * and diverges within a fraction of a second, so this is the default.
   * 'free' unlocks all six degrees of freedom for spatial mechanisms.
   */
  dofs: 'plane2d' | 'free';
  /** Static: cannot move, used for grounded structure. */
  fixed: boolean;

  // Geometry, metres. Which fields apply depends on `kind`.
  /** link */
  length?: number;
  /** link */
  width?: number;
  /** all */
  thickness: number;
  /** disc, gear, bevel, worm */
  radius?: number;
  /** gear, bevel, worm */
  teeth?: number;
  /** bevel: pitch cone half-angle in degrees. */
  coneAngle?: number;
  /** worm: lead angle in degrees. */
  leadAngle?: number;
}

export type JointKind = 'pin' | 'slider' | 'weld' | 'ball' | 'gear';

export interface JointLimits {
  enabled: boolean;
  min: number;
  max: number;
}

export interface JointMotor {
  enabled: boolean;
  mode: 'velocity' | 'position';
  targetVelocity: number;
  targetPosition: number;
  /** N·m for rotational joints, N for translational. */
  maxTorque: number;
  /**
   * Motor response, as a spring driving the joint toward its target. A stiff
   * motor (high frequency) slams a light linkage and tears the pins apart; a soft
   * one is gentler and more forgiving. This is a real drive parameter, not a hack.
   */
  frequency?: number;
  damping?: number;
}

export interface JointCompliance {
  enabled: boolean;
  /** Hz. Lower is softer and more forgiving of over-constrained loops. */
  frequency: number;
  damping: number;
}

export interface Joint {
  id: string;
  kind: JointKind;
  /** null means anchored to the world (ground). */
  a: string | null;
  b: string;
  /** Anchor point in world space, metres, at authoring time. */
  anchor: Vec3;
  /** Primary axis (hinge axis, slider direction, gear axis). World space, unit. */
  axis: Vec3;
  limits?: JointLimits;
  motor?: JointMotor;
  compliance?: JointCompliance;
  friction?: number;

  /** kind === 'gear': the two pin joints this coupling ties together. */
  couplingA?: string;
  couplingB?: string;
  /**
   * kind === 'gear': Jolt ratio. Observed behaviour is driven = -driver / ratio
   * for external mesh, so a 2:1 reduction is ratio 2 and reverses direction.
   * Use ratio -1 for a rigid shaft coupling between two levels.
   */
  ratio?: number;
}

export interface SceneDoc {
  version: 1;
  name: string;
  units: UnitSystem;
  /** m/s^2 along -Y. */
  gravity: number;
  gravityOn: boolean;
  /** Visual/authoring spacing between levels, metres. */
  planeSpacing: number;
  /** Default for newly placed parts. */
  planeDofLock: boolean;
  /** Static floor so unpinned parts have something to rest on. */
  floor: boolean;
  parts: Part[];
  joints: Joint[];
}

export const SCENE_VERSION = 1 as const;

export function emptyScene(units: UnitSystem = 'mm'): SceneDoc {
  return {
    version: SCENE_VERSION,
    name: 'Untitled mechanism',
    units,
    gravity: 9.81,
    gravityOn: true,
    planeSpacing: 0.04,
    planeDofLock: true,
    floor: false,
    parts: [],
    joints: [],
  };
}

/** Z coordinate of an authoring level. Used for snapping and placement. */
export function levelZ(plane: number, spacing: number): number {
  return plane * spacing;
}

