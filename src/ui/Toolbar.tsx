import { useEditor, type Tool } from '../scene/store';
import { EXAMPLES, buildExample } from '../scene/examples';
import { downloadScene, encodeShareUrl, loadAutosave, pickSceneFile } from '../scene/serialize';

interface ToolDef {
  tool: Tool;
  label: string;
  sub?: string;
}

const TOOL_GROUPS: { title: string; tools: ToolDef[] }[] = [
  {
    title: 'Inspect',
    tools: [{ tool: 'select', label: 'Select', sub: 'drag / orbit' }],
  },
  {
    title: 'Parts',
    tools: [
      { tool: 'link', label: 'Link', sub: 'rigid bar' },
      { tool: 'disc', label: 'Disc', sub: 'flywheel' },
      { tool: 'gear', label: 'Gear', sub: 'spur' },
      { tool: 'bevel', label: 'Bevel', sub: 'right angle' },
      { tool: 'worm', label: 'Worm', sub: 'high ratio' },
    ],
  },
  {
    title: 'Mechanisms',
    tools: [
      { tool: 'pin', label: 'Ground pin', sub: 'part to world' },
      { tool: 'join', label: 'Pin two', sub: 'hinge pair' },
      { tool: 'slider', label: 'Slider', sub: 'prismatic' },
      { tool: 'weld', label: 'Weld', sub: 'rigid' },
      { tool: 'ball', label: 'Ball', sub: 'spherical' },
      { tool: 'gearCoupling', label: 'Gear ratio', sub: 'couple two' },
      { tool: 'ground', label: 'Toggle fixed', sub: 'static body' },
    ],
  },
];

export function Toolbar() {
  const tool = useEditor((s) => s.tool);
  const setTool = useEditor((s) => s.setTool);
  const running = useEditor((s) => s.running);
  const toggleRunning = useEditor((s) => s.toggleRunning);
  const resetToInitial = useEditor((s) => s.resetToInitial);
  const undo = useEditor((s) => s.undo);
  const redo = useEditor((s) => s.redo);
  const canUndo = useEditor((s) => s.past.length > 0);
  const canRedo = useEditor((s) => s.future.length > 0);
  const units = useEditor((s) => s.doc.units);

  return (
    <div className="toolbar">
      <h1>Mech</h1>

      <div className="tool-section">
        <label>Simulation</label>
        <div className="tool-grid">
          <button className={`tool ${running ? 'active' : ''}`} onClick={toggleRunning}>
            {running ? 'Pause' : 'Run'}
            <small>space</small>
          </button>
          <button className="tool" onClick={resetToInitial}>
            Reset
            <small>r</small>
          </button>
          <button className="tool" onClick={undo} disabled={!canUndo}>
            Undo
            <small>⌘Z</small>
          </button>
          <button className="tool" onClick={redo} disabled={!canRedo}>
            Redo
            <small>⇧⌘Z</small>
          </button>
        </div>
      </div>

      {TOOL_GROUPS.map((group) => (
        <div className="tool-section" key={group.title}>
          <label>{group.title}</label>
          <div className="tool-grid">
            {group.tools.map((t) => (
              <button
                key={t.tool}
                className={`tool ${tool === t.tool ? 'active' : ''}`}
                onClick={() => setTool(t.tool)}
                title={t.sub}
              >
                {t.label}
                {t.sub ? <small>{t.sub}</small> : null}
              </button>
            ))}
          </div>
        </div>
      ))}

      <div className="tool-section">
        <label>Scene</label>
        <div className="btn-row">
          <button className="action" onClick={() => downloadScene(useEditor.getState().doc)}>Save</button>
          <button
            className="action"
            onClick={async () => {
              const loaded = await pickSceneFile();
              if (!loaded) return;
              useEditor.getState().loadDoc(loaded.doc);
              if (loaded.warnings.length) console.warn('Scene warnings:', loaded.warnings);
            }}
          >
            Open
          </button>
          <button
            className="action"
            onClick={() => {
              const url = encodeShareUrl(useEditor.getState().doc);
              navigator.clipboard?.writeText(url).catch(() => {});
              history.replaceState(null, '', `#scene=${url.split('#scene=')[1]}`);
            }}
            title="Copy a shareable link to the clipboard"
          >
            Share
          </button>
          <button className="action" onClick={() => useEditor.getState().newScene()}>New</button>
          <button
            className="action"
            disabled={!loadAutosave()}
            onClick={() => {
              const doc = loadAutosave();
              if (doc) useEditor.getState().loadDoc(doc);
            }}
          >
            Restore
          </button>
        </div>
      </div>

      <div className="tool-section">
        <label>Examples</label>
        <select
          value=""
          onChange={(e) => {
            if (!e.target.value) return;
            useEditor.getState().loadDoc(buildExample(e.target.value, units));
          }}
        >
          <option value="">Load an example…</option>
          {EXAMPLES.map((ex) => (
            <option key={ex.key} value={ex.key} title={ex.summary}>
              {ex.label}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}
