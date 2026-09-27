import { create } from 'zustand';
import type { Joint, Part, SceneDoc } from './types';
import { emptyScene } from './types';
import type { UnitSystem } from '../core/units';

export type Tool =
  | 'select'
  | 'link'
  | 'disc'
  | 'gear'
  | 'bevel'
  | 'worm'
  | 'pin'
  | 'join'
  | 'slider'
  | 'weld'
  | 'ball'
  | 'gearCoupling'
  | 'ground';

export const PART_TOOLS: Tool[] = ['link', 'disc', 'gear', 'bevel', 'worm'];
/** Tools that take one click. */
export const SINGLE_TOOLS: Tool[] = ['pin', 'ground'];
/** Tools that take two clicks on two different parts. */
export const PAIR_TOOLS: Tool[] = ['join', 'slider', 'weld', 'ball', 'gearCoupling'];
export const JOINT_TOOLS: Tool[] = ['pin', 'join', 'slider', 'weld', 'ball', 'gearCoupling'];

export function isPartTool(tool: Tool): boolean {
  return PART_TOOLS.includes(tool);
}
export function isJointTool(tool: Tool): boolean {
  return JOINT_TOOLS.includes(tool);
}
export function isPairTool(tool: Tool): boolean {
  return PAIR_TOOLS.includes(tool);
}

function cloneDoc(doc: SceneDoc): SceneDoc {
  return JSON.parse(JSON.stringify(doc)) as SceneDoc;
}

interface EditorState {
  doc: SceneDoc;
  past: SceneDoc[];
  future: SceneDoc[];

  tool: Tool;
  selection: string[];
  /** First part of a two-click tool, cleared when the gesture completes. */
  pending: string[];
  activePlane: number;
  running: boolean;
  /** Visual separation applied to levels while editing. Metres per level. */
  explode: number;
  /**
   * Increments on any change the simulation must react to by rebuilding.
   * Live parameter tweaks bump `liveRevision` instead so motion is not reset.
   */
  simRevision: number;
  liveRevision: number;

  setTool: (tool: Tool) => void;
  setPending: (ids: string[]) => void;
  setActivePlane: (plane: number) => void;
  setExplode: (explode: number) => void;
  select: (id: string | null, additive?: boolean) => void;
  selectMany: (ids: string[]) => void;

  addPart: (part: Part) => void;
  updatePart: (id: string, patch: Partial<Part>, live?: boolean) => void;
  removeParts: (ids: string[]) => void;
  addJoint: (joint: Joint) => void;
  updateJoint: (id: string, patch: Partial<Joint>, live?: boolean) => void;
  removeJoints: (ids: string[]) => void;

  setScene: (patch: Partial<SceneDoc>, live?: boolean) => void;
  setUnits: (units: UnitSystem) => void;

  undo: () => void;
  redo: () => void;
  loadDoc: (doc: SceneDoc) => void;
  newScene: () => void;
  resetToInitial: () => void;

  setRunning: (running: boolean) => void;
  toggleRunning: () => void;
}

let simRev = 0;
let liveRev = 0;

export const useEditor = create<EditorState>()((set, get) => {
  /** Applies a mutation to the document, pushing an undo entry. */
  const commit = (mutate: (doc: SceneDoc) => void, opts: { live?: boolean } = {}) => {
    const { doc, past } = get();
    const next = cloneDoc(doc);
    mutate(next);
    liveRev += 1;
    // `live` edits (motor speed, gravity) are replayed onto the running world
    // without a rebuild, so tuning a motor does not reset the mechanism.
    if (!opts.live) simRev += 1;
    set({
      doc: next,
      past: [...past.slice(-99), doc],
      future: [],
      simRevision: simRev,
      liveRevision: liveRev,
    });
  };

  return {
    doc: emptyScene(),
    past: [],
    future: [],
    tool: 'select',
    selection: [],
    pending: [],
    activePlane: 0,
    running: false,
    explode: 0,
    simRevision: 0,
    liveRevision: 0,

    setTool: (tool) => set({ tool, pending: [] }),
    setPending: (pending) => set({ pending }),
    setActivePlane: (activePlane) => set({ activePlane }),
    setExplode: (explode) => set({ explode }),

    select: (id, additive = false) => {
      if (id === null) return set({ selection: [] });
      const { selection } = get();
      if (additive) {
        set({
          selection: selection.includes(id)
            ? selection.filter((s) => s !== id)
            : [...selection, id],
        });
      } else {
        set({ selection: [id] });
      }
    },
    selectMany: (ids) => set({ selection: ids }),

    addPart: (part) =>
      commit((doc) => {
        doc.parts.push(part);
      }),

    updatePart: (id, patch, live = false) =>
      commit((doc) => {
        const p = doc.parts.find((x) => x.id === id);
        if (p) Object.assign(p, patch);
      }, { live }),

    removeParts: (ids) =>
      commit((doc) => {
        const set_ = new Set(ids);
        doc.parts = doc.parts.filter((p) => !set_.has(p.id));
        // Drop joints that referenced removed parts.
        doc.joints = doc.joints.filter(
          (j) => !set_.has(j.b) && !(j.a && set_.has(j.a)),
        );
        // Drop gear couplings whose pins are gone.
        const jointIds = new Set(doc.joints.map((j) => j.id));
        doc.joints = doc.joints.filter(
          (j) =>
            j.kind !== 'gear' ||
            (j.couplingA && jointIds.has(j.couplingA) && j.couplingB && jointIds.has(j.couplingB)),
        );
      }),

    addJoint: (joint) =>
      commit((doc) => {
        doc.joints.push(joint);
      }),

    updateJoint: (id, patch, live = false) =>
      commit((doc) => {
        const j = doc.joints.find((x) => x.id === id);
        if (j) Object.assign(j, patch);
      }, { live }),

    removeJoints: (ids) =>
      commit((doc) => {
        const set_ = new Set(ids);
        doc.joints = doc.joints.filter((j) => !set_.has(j.id));
        const jointIds = new Set(doc.joints.map((j) => j.id));
        doc.joints = doc.joints.filter(
          (j) =>
            j.kind !== 'gear' ||
            (j.couplingA && jointIds.has(j.couplingA) && j.couplingB && jointIds.has(j.couplingB)),
        );
      }),

    setScene: (patch, live = false) => commit((doc) => Object.assign(doc, patch), { live }),
    setUnits: (units) => commit((doc) => { doc.units = units; }),

    undo: () => {
      const { past, doc, future } = get();
      if (past.length === 0) return;
      const prev = past[past.length - 1];
      simRev += 1;
      set({
        doc: prev,
        past: past.slice(0, -1),
        future: [doc, ...future].slice(0, 100),
        simRevision: simRev,
      });
    },

    redo: () => {
      const { future, doc, past } = get();
      if (future.length === 0) return;
      const next = future[0];
      simRev += 1;
      set({
        doc: next,
        past: [...past, doc].slice(-100),
        future: future.slice(1),
        simRevision: simRev,
      });
    },

    loadDoc: (doc) => {
      simRev += 1;
      set({ doc, past: [], future: [], selection: [], pending: [], simRevision: simRev, running: false });
    },

    newScene: () => {
      simRev += 1;
      set({
        doc: emptyScene(get().doc.units),
        past: [],
        future: [],
        selection: [],
        pending: [],
        simRevision: simRev,
        running: false,
        activePlane: 0,
      });
    },

    /** Restart the mechanism from its authored pose without changing the document. */
    resetToInitial: () => {
      simRev += 1;
      set({ simRevision: simRev });
    },

    setRunning: (running) => set({ running }),
    toggleRunning: () => set({ running: !get().running }),
  };
});
