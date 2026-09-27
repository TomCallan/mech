import * as THREE from 'three';
import type { Part } from '../scene/types';

/**
 * Procedural geometry for mechanism parts. Gears get real toothed silhouettes
 * because a gear train that looks like plain cylinders reads as abstract; the
 * physics only ever sees a cylinder, so this is purely presentational.
 */

const cache = new Map<string, THREE.BufferGeometry>();

function cached(key: string, build: () => THREE.BufferGeometry): THREE.BufferGeometry {
  const hit = cache.get(key);
  if (hit) return hit;
  const geo = build();
  cache.set(key, geo);
  return geo;
}

const round = (x: number) => Math.round(x * 1e5) / 1e5;

export function linkGeometry(length: number, width: number, thickness: number): THREE.BufferGeometry {
  return cached(`link:${round(length)}:${round(width)}:${round(thickness)}`, () => {
    // Link runs along local X, matching the physics box half-extents.
    const g = new THREE.BoxGeometry(length, width, thickness);
    return g;
  });
}

export function discGeometry(radius: number, thickness: number): THREE.BufferGeometry {
  return cached(`disc:${round(radius)}:${round(thickness)}`, () => {
    const g = new THREE.CylinderGeometry(radius, radius, thickness, 40, 1);
    // Cylinders are Y-axis by default; rotate so the axle is local Z.
    g.rotateX(Math.PI / 2);
    return g;
  });
}

/**
 * Builds a toothed silhouette and extrudes it along Z.
 * Teeth are trapezoidal rather than true involute: at sandbox scale the
 * difference is invisible, and this keeps the geometry honest about being a
 * visual approximation.
 */
function gearProfile(
  radius: number,
  teeth: number,
  thickness: number,
  taper = 0,
): THREE.BufferGeometry {
  const shape = new THREE.Shape();
  const toothHeight = Math.min(radius * 0.22, radius * (2 * Math.PI) / teeth * 0.7);
  const rootR = radius - toothHeight * 0.5;
  const tipR = radius + toothHeight * 0.5;
  const step = (Math.PI * 2) / teeth;

  const pt = (r: number, a: number) => new THREE.Vector2(Math.cos(a) * r, Math.sin(a) * r);

  for (let i = 0; i < teeth; i++) {
    const a0 = i * step;
    // Four points per tooth: root, rise, tip, fall.
    const pts = [
      pt(rootR, a0 + step * 0.00),
      pt(tipR, a0 + step * 0.22),
      pt(tipR, a0 + step * 0.48),
      pt(rootR, a0 + step * 0.70),
    ];
    for (const p of pts) {
      if (i === 0 && p === pts[0]) shape.moveTo(p.x, p.y);
      else shape.lineTo(p.x, p.y);
    }
  }
  shape.closePath();

  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: thickness,
    bevelEnabled: false,
    curveSegments: 1,
  });
  geo.translate(0, 0, -thickness / 2);

  if (taper !== 0) {
    // Taper the extrusion so the far face is smaller: a bevel-ish cone.
    const pos = geo.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      const z = pos.getZ(i);
      const t = thickness > 0 ? z / thickness + 0.5 : 0;
      const s = 1 - taper * (1 - t);
      pos.setXY(i, pos.getX(i) * s, pos.getY(i) * s);
    }
    pos.needsUpdate = true;
    geo.computeVertexNormals();
  }
  return geo;
}

export function gearGeometry(radius: number, teeth: number, thickness: number): THREE.BufferGeometry {
  return cached(`gear:${round(radius)}:${teeth}:${round(thickness)}`, () => {
    const geo = gearProfile(radius, teeth, thickness);
    // A hub so it reads as a mounted gear rather than a flat disc.
    return geo;
  });
}

export function bevelGearGeometry(
  radius: number,
  teeth: number,
  thickness: number,
  coneAngleDeg: number,
): THREE.BufferGeometry {
  return cached(`bevel:${round(radius)}:${teeth}:${round(thickness)}:${round(coneAngleDeg)}`, () => {
    const taper = Math.min(0.75, Math.max(0.15, Math.tan((coneAngleDeg * Math.PI) / 180) * 0.6));
    return gearProfile(radius, teeth, thickness, taper);
  });
}

/** A worm: a cylinder with a helical thread wrapped around it. */
export function wormGeometry(radius: number, length: number, leadAngleDeg: number): THREE.BufferGeometry {
  // The lead angle shapes the visual thread pitch; the helix below is derived from
  // the length and turn count.
  const leadBias = 1 + Math.max(0, Math.min(30, leadAngleDeg)) / 60;
  return cached(`worm:${round(radius)}:${round(length)}:${round(leadAngleDeg)}`, () => {
    const body = new THREE.CylinderGeometry(radius, radius, length, 28, 1);
    body.rotateZ(Math.PI / 2); // axle along X

    const turns = Math.max(2, Math.round((length / Math.max(radius * 1.2, 1e-3)) / leadBias));
    const threadRadius = radius * 0.28;
    const helixPoints: THREE.Vector3[] = [];
    const steps = turns * 24;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const x = -length / 2 + t * length;
      const a = t * turns * Math.PI * 2;
      helixPoints.push(new THREE.Vector3(x, Math.cos(a) * radius, Math.sin(a) * radius));
    }
    const curve = new THREE.CatmullRomCurve3(helixPoints);
    const thread = new THREE.TubeGeometry(curve, steps, threadRadius, 8, false);
    return mergeGeometries([body, thread]);
  });
}

/**
 * Minimal merge for non-indexed geometry pairs, avoiding a dependency on
 * three/examples BufferGeometryUtils.
 */
function mergeGeometries(list: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const nonIndexed = list.map((g) => (g.index ? g.toNonIndexed() : g));
  const total = nonIndexed.reduce((n, g) => n + g.attributes.position.count, 0);
  const position = new Float32Array(total * 3);
  const normal = new Float32Array(total * 3);
  let offset = 0;
  for (const g of nonIndexed) {
    const p = g.attributes.position as THREE.BufferAttribute;
    const n = g.attributes.normal as THREE.BufferAttribute;
    position.set(p.array as Float32Array, offset * 3);
    normal.set(n.array as Float32Array, offset * 3);
    offset += p.count;
  }
  const merged = new THREE.BufferGeometry();
  merged.setAttribute('position', new THREE.BufferAttribute(position, 3));
  merged.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
  merged.computeBoundingSphere();
  return merged;
}

export function geometryForPart(part: Part): THREE.BufferGeometry {
  switch (part.kind) {
    case 'link':
      return linkGeometry(part.length ?? 0.08, part.width ?? 0.02, part.thickness);
    case 'disc':
      return discGeometry(part.radius ?? 0.03, part.thickness);
    case 'gear':
      return gearGeometry(part.radius ?? 0.03, part.teeth ?? 16, part.thickness);
    case 'bevel':
      return bevelGearGeometry(part.radius ?? 0.03, part.teeth ?? 16, part.thickness, part.coneAngle ?? 45);
    case 'worm':
      return wormGeometry(part.radius ?? 0.02, (part.thickness ?? 0.02) * 2, part.leadAngle ?? 12);
  }
}

export function disposeGeometryCache(): void {
  for (const g of cache.values()) g.dispose();
  cache.clear();
}
