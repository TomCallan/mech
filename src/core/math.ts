/**
 * Minimal 3D math. Deliberately dependency-free so the simulation layer never
 * imports the renderer.
 */

export type Vec3 = [number, number, number];
export type Quat = [number, number, number, number]; // x, y, z, w

export const DEG = Math.PI / 180;
export const RAD = 180 / Math.PI;

export function v3(x = 0, y = 0, z = 0): Vec3 {
  return [x, y, z];
}

export function add(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

export function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

export function scale(a: Vec3, s: number): Vec3 {
  return [a[0] * s, a[1] * s, a[2] * s];
}

export function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

export function cross(a: Vec3, b: Vec3): Vec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

export function length(a: Vec3): number {
  return Math.hypot(a[0], a[1], a[2]);
}

export function normalize(a: Vec3): Vec3 {
  const l = length(a);
  return l > 1e-12 ? scale(a, 1 / l) : [0, 0, 1];
}

export function distance(a: Vec3, b: Vec3): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

export function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

// --- quaternions ----------------------------------------------------------

export const QUAT_IDENTITY: Quat = [0, 0, 0, 1];

export function quatFromEuler(e: Vec3): Quat {
  // XYZ order, matching three.js Euler default.
  const [x, y, z] = e;
  const c1 = Math.cos(x / 2), c2 = Math.cos(y / 2), c3 = Math.cos(z / 2);
  const s1 = Math.sin(x / 2), s2 = Math.sin(y / 2), s3 = Math.sin(z / 2);
  return [
    s1 * c2 * c3 + c1 * s2 * s3,
    c1 * s2 * c3 - s1 * c2 * s3,
    c1 * c2 * s3 + s1 * s2 * c3,
    c1 * c2 * c3 - s1 * s2 * s3,
  ];
}

export function quatMul(a: Quat, b: Quat): Quat {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

export function quatRotate(q: Quat, v: Vec3): Vec3 {
  const [qx, qy, qz, qw] = q;
  const tx = 2 * (qy * v[2] - qz * v[1]);
  const ty = 2 * (qz * v[0] - qx * v[2]);
  const tz = 2 * (qx * v[1] - qy * v[0]);
  return [
    v[0] + qw * tx + (qy * tz - qz * ty),
    v[1] + qw * ty + (qz * tx - qx * tz),
    v[2] + qw * tz + (qx * ty - qy * tx),
  ];
}

export function quatConjugate(q: Quat): Quat {
  return [-q[0], -q[1], -q[2], q[3]];
}

/** Signed rotation about a principal axis, for bodies whose motion is dominated by it. */
export function angleAbout(q: Quat, axis: 'x' | 'y' | 'z'): number {
  const [x, y, z, w] = q;
  if (axis === 'z') return Math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z));
  if (axis === 'x') return Math.atan2(2 * (w * x + y * z), 1 - 2 * (x * x + z * z));
  return Math.atan2(2 * (w * y - z * x), 1 - 2 * (x * x + y * y));
}

/** Accumulates unwrapped rotation from a stream of sampled quaternions. */
export class AngleTracker {
  private prev: number | null = null;
  private accumulated = 0;

  constructor(private readonly axis: 'x' | 'y' | 'z') {}

  push(q: Quat): number {
    const a = angleAbout(q, this.axis);
    if (this.prev === null) {
      this.prev = a;
      return this.accumulated;
    }
    let d = a - this.prev;
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    this.accumulated += d;
    this.prev = a;
    return this.accumulated;
  }

  get value(): number {
    return this.accumulated;
  }

  reset(): void {
    this.prev = null;
    this.accumulated = 0;
  }
}

/** Rotate an offset into world space and add a base position. */
export function transformPoint(base: Vec3, rotation: Quat, offset: Vec3): Vec3 {
  return add(base, quatRotate(rotation, offset));
}
