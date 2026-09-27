import { add, quatConjugate, quatFromEuler, quatRotate, sub, type Vec3 } from '../core/math';
import type { PartHit } from '../render/viewport';
import { createJoint, createPart } from '../scene/factories';
import { isPairTool, isPartTool, useEditor, type Tool } from '../scene/store';
import type { Joint, Part, PartKind } from '../scene/types';

/**
 * Tool behaviour. Placement and joint authoring both snap to a part's features
 * (link ends, gear centres), because eyeballing a pin onto a hole is the single
 * biggest source of frustration in a linkage builder.
 */

const pendingPoint = new Map<string, Vec3>();

function findPart(id: string): Part | undefined {
  return useEditor.getState().doc.parts.find((p) => p.id === id);
}

/** Nearest feature point of a part: link ends or centre, otherwise the centre. */
export function snapFeature(part: Part, renderPoint: Vec3): Vec3 {
  const rotation = quatFromEuler(part.rotation);
  const local = quatRotate(quatConjugate(rotation), sub(renderPoint, part.position));

  if (part.kind === 'link') {
    const halfLength = (part.length ?? 0.08) / 2;
    // Snap along the link's axis; the pin then lies exactly on the bar's centreline.
    const candidates = [-halfLength, 0, halfLength];
    let best = 0;
    let bestDistance = Infinity;
    for (const c of candidates) {
      const d = Math.abs(local[0] - c);
      if (d < bestDistance) {
        bestDistance = d;
        best = c;
      }
    }
    local[0] = best;
    local[1] = 0;
    local[2] = 0;
  } else {
    local[0] = 0;
    local[1] = 0;
    local[2] = 0;
  }

  const snapped = add(part.position, quatRotate(rotation, local));
  // Z always comes from the part record, which is in physics space, never the
  // exploded render space the click arrived in.
  snapped[2] = part.position[2];
  return snapped;
}

function anchorForPairFirst(part: Part, point: Vec3): Vec3 {
  const snapped = snapFeature(part, point);
  pendingPoint.set(part.id, snapped);
  return snapped;
}

function pinJointFor(partId: string): Joint | undefined {
  return useEditor.getState().doc.joints.find(
    (j) => j.kind === 'pin' && (j.b === partId || j.a === partId),
  );
}

function pairAnchor(a: Vec3, b: Vec3): Vec3 {
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
}

export function handlePartClick(hit: PartHit | null, additive: boolean): void {
  const store = useEditor.getState();
  const tool = store.tool;

  if (tool === 'select' || isPartTool(tool)) {
    // In a part tool, clicking existing geometry just selects, so the user can
    // inspect before placing the next part.
    store.select(hit ? hit.partId : null, additive);
    return;
  }

  if (!hit) {
    store.setPending([]);
    return;
  }

  const part = findPart(hit.partId);
  if (!part) return;

  if (tool === 'ground') {
    store.updatePart(part.id, { fixed: !part.fixed });
    store.select(part.id);
    return;
  }

  if (tool === 'pin') {
    const anchor = snapFeature(part, hit.point);
    store.addJoint(
      createJoint({ kind: 'pin', a: null, b: part.id, anchor, axis: [0, 0, 1] }),
    );
    store.select(part.id);
    return;
  }

  if (isPairTool(tool)) {
    const first = store.pending[0];
    if (!first) {
      const anchor = anchorForPairFirst(part, hit.point);
      store.setPending([part.id]);
      store.select(part.id);
      void anchor;
      return;
    }
    if (first === part.id) {
      // Clicking the same part twice means "I changed my mind".
      store.setPending([]);
      pendingPoint.clear();
      return;
    }
    const firstPart = findPart(first);
    if (!firstPart) {
      store.setPending([]);
      return;
    }
    const firstAnchor = pendingPoint.get(first) ?? snapFeature(firstPart, hit.point);
    const secondAnchor = snapFeature(part, hit.point);
    const anchor = pairAnchor(firstAnchor, secondAnchor);

    if (tool === 'join') {
      store.addJoint(createJoint({ kind: 'pin', a: firstPart.id, b: part.id, anchor, axis: [0, 0, 1] }));
    } else if (tool === 'slider') {
      // Slide along the line joining the two parts, which is what the user drew.
      const axis: Vec3 = [secondAnchor[0] - firstAnchor[0], secondAnchor[1] - firstAnchor[1], secondAnchor[2] - firstAnchor[2]];
      const len = Math.hypot(axis[0], axis[1], axis[2]) || 1;
      store.addJoint(
        createJoint({ kind: 'slider', a: firstPart.id, b: part.id, anchor, axis: [axis[0] / len, axis[1] / len, axis[2] / len] }),
      );
    } else if (tool === 'weld') {
      store.addJoint(createJoint({ kind: 'weld', a: firstPart.id, b: part.id, anchor, axis: [0, 0, 1] }));
    } else if (tool === 'ball') {
      store.addJoint(createJoint({ kind: 'ball', a: firstPart.id, b: part.id, anchor, axis: [0, 0, 1] }));
    } else if (tool === 'gearCoupling') {
      const pinA = pinJointFor(firstPart.id);
      const pinB = pinJointFor(part.id);
      if (!pinA || !pinB) {
        store.setPending([]);
        pendingPoint.clear();
        return;
      }
      // Driver is whichever was clicked first. Driven = -driver / ratio, so
      // ratio = teethDriven / teethDriver gives correct meshing speeds.
      const teethA = Math.max(1, firstPart.teeth ?? 1);
      const teethB = Math.max(1, part.teeth ?? 1);
      const coupling = createJoint({
        kind: 'gear',
        a: firstPart.id,
        b: part.id,
        anchor,
        axis: [0, 0, 1],
        ratio: teethB / teethA,
        couplingA: pinA.id,
        couplingB: pinB.id,
      });
      store.addJoint(coupling);
    }

    store.setPending([]);
    pendingPoint.clear();
  }
}

export function handleEmptyClick(planePoint: [number, number, number], additive: boolean): void {
  const store = useEditor.getState();
  const tool = store.tool;

  if (!isPartTool(tool)) {
    if (tool === 'select') store.select(null, additive);
    else store.setPending([]);
    return;
  }

  const z = store.activePlane * store.doc.planeSpacing;
  const part = createPart({
    kind: tool as PartKind,
    position: [planePoint[0], planePoint[1], z],
    rotation: [0, 0, 0],
    plane: store.activePlane,
    units: store.doc.units,
    dofs: store.doc.planeDofLock ? 'plane2d' : 'free',
  });
  store.addPart(part);
  store.select(part.id);
}

/** Human-readable prompt for the current tool and its click progress. */
export function toolHint(tool: Tool, pendingCount: number): string {
  if (tool === 'select') return 'Drag a part to move it, or drag empty space to orbit';
  if (isPartTool(tool)) return 'Click the work plane to place a part';
  if (tool === 'ground') return 'Click a part to toggle fixed (grounded)';
  if (tool === 'pin') return 'Click a part at a hole to pin it to the ground';
  if (!isPairTool(tool)) return '';
  const names: Partial<Record<Tool, string>> = {
    join: 'pin two parts together',
    slider: 'let a part slide along the line between two clicks',
    weld: 'rigidly weld two parts',
    ball: 'add a ball joint between two parts',
    gearCoupling: 'couple two geared parts (both need a pin first)',
  };
  const verb = names[tool] ?? 'connect two parts';
  return pendingCount === 0 ? `${verb}: click the first part` : `${verb}: click the second part (Esc to cancel)`;
}
