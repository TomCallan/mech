import type { Joint, Part, SceneDoc } from './types';
import { SCENE_VERSION, emptyScene } from './types';
import type { UnitSystem } from '../core/units';

const STORAGE_KEY = 'mech.autosave.v1';

export function serialize(doc: SceneDoc): string {
  return JSON.stringify(doc, null, 2);
}

/**
 * Parses and repairs a document. Invalid joints are dropped rather than throwing,
 * so a hand-edited or older file still loads with whatever is valid in it.
 */
export function deserialize(text: string): { doc: SceneDoc; warnings: string[] } {
  const warnings: string[] = [];
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('Not valid JSON');
  }
  if (!raw || typeof raw !== 'object') throw new Error('Not a scene file');
  const input = raw as Partial<SceneDoc>;

  if (input.version !== SCENE_VERSION) {
    warnings.push(`Scene version ${String(input.version)} differs from ${SCENE_VERSION}; loading best-effort.`);
  }

  const parts: Part[] = Array.isArray(input.parts)
    ? input.parts.filter((p): p is Part => !!p && typeof p.id === 'string' && typeof p.kind === 'string')
    : [];
  const partIds = new Set(parts.map((p) => p.id));

  const jointsInput: Joint[] = Array.isArray(input.joints) ? (input.joints as Joint[]) : [];
  const joints = jointsInput.filter((j) => {
    if (!j || typeof j.id !== 'string') return false;
    if (!partIds.has(j.b)) {
      warnings.push(`Dropped joint ${j.id}: unknown part ${j.b}`);
      return false;
    }
    if (j.a !== null && !partIds.has(j.a)) {
      warnings.push(`Dropped joint ${j.id}: unknown part ${j.a}`);
      return false;
    }
    return true;
  });

  // Gear couplings must still point at surviving pins.
  const jointIds = new Set(joints.map((j) => j.id));
  const finalJoints = joints.filter((j) => {
    if (j.kind !== 'gear') return true;
    const ok = !!j.couplingA && !!j.couplingB && jointIds.has(j.couplingA) && jointIds.has(j.couplingB);
    if (!ok) warnings.push(`Dropped gear coupling ${j.id}: its pin joints are missing`);
    return ok;
  });

  const base = emptyScene();
  const doc: SceneDoc = {
    ...base,
    ...input,
    version: SCENE_VERSION,
    units: (input.units as UnitSystem) ?? base.units,
    gravity: typeof input.gravity === 'number' ? input.gravity : base.gravity,
    gravityOn: typeof input.gravityOn === 'boolean' ? input.gravityOn : base.gravityOn,
    planeSpacing: typeof input.planeSpacing === 'number' ? input.planeSpacing : base.planeSpacing,
    planeDofLock: typeof input.planeDofLock === 'boolean' ? input.planeDofLock : base.planeDofLock,
    floor: typeof input.floor === 'boolean' ? input.floor : base.floor,
    name: typeof input.name === 'string' ? input.name : base.name,
    parts,
    joints: finalJoints,
  };
  return { doc, warnings };
}

export function downloadScene(doc: SceneDoc): void {
  const blob = new Blob([serialize(doc)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${doc.name.replace(/[^a-z0-9-_]+/gi, '_') || 'scene'}.mech.json`;
  a.click();
  URL.revokeObjectURL(url);
}

export function pickSceneFile(): Promise<{ doc: SceneDoc; warnings: string[] } | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return resolve(null);
      const text = await file.text();
      resolve(deserialize(text));
    };
    input.click();
  });
}

export function saveAutosave(doc: SceneDoc): void {
  try {
    localStorage.setItem(STORAGE_KEY, serialize(doc));
  } catch {
    // Storage may be unavailable or full; autosave is best-effort.
  }
}

export function loadAutosave(): SceneDoc | null {
  try {
    const text = localStorage.getItem(STORAGE_KEY);
    if (!text) return null;
    return deserialize(text).doc;
  } catch {
    return null;
  }
}

export function hasAutosave(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) !== null;
  } catch {
    return false;
  }
}

/**
 * Encodes a scene into a shareable URL hash. Kept as base64 of the JSON so it
 * round-trips exactly; scenes are small enough for a URL at this scale.
 */
export function encodeShareUrl(doc: SceneDoc): string {
  const json = serialize(doc);
  const b64 = btoa(unescape(encodeURIComponent(json)));
  return `${location.origin}${location.pathname}#scene=${b64}`;
}

export function readShareUrl(): { doc: SceneDoc; warnings: string[] } | null {
  const hash = location.hash;
  const marker = '#scene=';
  if (!hash.startsWith(marker)) return null;
  try {
    const json = decodeURIComponent(escape(atob(hash.slice(marker.length))));
    return deserialize(json);
  } catch {
    return null;
  }
}
