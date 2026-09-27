import { useEffect, useRef, useState } from 'react';
import { useEditor } from '../scene/store';
import { handleEmptyClick, handlePartClick } from '../app/interaction';
import { Viewport } from '../render/viewport';
import { sim } from '../sim/instance';
import { Toolbar } from './Toolbar';
import { Inspector } from './Inspector';
import { Readouts } from './Readouts';
import { StatusBar } from './StatusBar';
import { readShareUrl, saveAutosave } from '../scene/serialize';

/**
 * Owns the imperative viewport and simulation. React renders only the panels;
 * the render loop reads store state directly and never triggers a React render.
 */
export function App() {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<Viewport | null>(null);
  const builtRevision = useRef(-1);
  const docRevision = useRef(-1);
  const [blownUp, setBlownUp] = useState(false);
  const [bootError, setBootError] = useState<string | null>(null);

  const tool = useEditor((s) => s.tool);
  const pending = useEditor((s) => s.pending);
  const running = useEditor((s) => s.running);

  // --- viewport + loop ----------------------------------------------------
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const viewport = new Viewport(container, {
      onPartClick: (hit, additive) => handlePartClick(hit, additive),
      onEmptyClick: (point, additive) => handleEmptyClick(point, additive),
      onGrab: (partId, point) => sim.grab(partId, point),
      onDrag: (point) => sim.moveGrab(point),
      onRelease: () => sim.endGrab(),
      onHover: () => {},
    });
    viewportRef.current = viewport;

    const onResize = () => viewport.resize();
    window.addEventListener('resize', onResize);

    let raf = 0;
    let last = performance.now();
    let frames = 0;
    let frameWindow = last;
    let frameRate = 0;

    const frame = () => {
      raf = requestAnimationFrame(frame);
      const now = performance.now();
      const dt = Math.min((now - last) / 1000, 0.25);
      last = now;

      const state = useEditor.getState();

      // Rebuild the physics world only when the document structure changed, and
      // never start a second build while one is in flight.
      if (state.simRevision !== builtRevision.current && !sim.busy) {
        builtRevision.current = state.simRevision;
        docRevision.current = state.simRevision;
        viewport.setDoc(state.doc);
        void sim.sync(state.doc, state.simRevision, state.liveRevision).catch((err) => setBootError(String(err?.message ?? err)));
      } else if (state.simRevision !== docRevision.current && !sim.busy) {
        docRevision.current = state.simRevision;
        viewport.setDoc(state.doc);
      }

      viewport.setActivePlane(state.activePlane);
      viewport.setExplode(state.explode);
      viewport.setDragEnabled(state.tool === 'select');
      viewport.setSelection(state.selection);

      sim.advance(dt, state.running);

      const poses = sim.poses;
      if (poses) {
        viewport.setPoses(poses);
        viewport.applyPoses((id) => sim.indexOf(id));
      }
      viewport.render();

      frames += 1;
      if (now - frameWindow >= 500) {
        frameRate = (frames * 1000) / (now - frameWindow);
        frames = 0;
        frameWindow = now;
        window.dispatchEvent(new CustomEvent('mech:stats', {
          detail: { fps: frameRate, stepsPerSecond: sim.stepsThisSecond, blownUp: sim.blownUp },
        }));
      }
      setBlownUp((prev) => (prev === sim.blownUp ? prev : sim.blownUp));
    };
    raf = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', onResize);
      viewport.dispose();
      viewportRef.current = null;
    };
  }, []);

  // --- load a shared scene, or the last autosave --------------------------
  useEffect(() => {
    const shared = readShareUrl();
    if (shared) {
      useEditor.getState().loadDoc(shared.doc);
      if (shared.warnings.length) console.warn('Scene loaded with warnings:', shared.warnings);
      history.replaceState(null, '', location.pathname);
    }
  }, []);

  // --- autosave -----------------------------------------------------------
  useEffect(() => {
    let timer: number | undefined;
    const unsub = useEditor.subscribe((state, prev) => {
      if (state.doc === prev.doc) return;
      window.clearTimeout(timer);
      timer = window.setTimeout(() => saveAutosave(state.doc), 800);
    });
    return () => {
      unsub();
      window.clearTimeout(timer);
    };
  }, []);

  // --- keyboard -----------------------------------------------------------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'SELECT')) return;
      const state = useEditor.getState();

      if (e.key === 'Escape') {
        state.setPending([]);
        state.setTool('select');
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) state.redo();
        else state.undo();
        return;
      }
      if (e.metaKey || e.ctrlKey) return;

      if (e.code === 'Space') {
        e.preventDefault();
        state.toggleRunning();
        return;
      }
      if (e.key === 'r' || e.key === 'R') {
        state.resetToInitial();
        return;
      }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (state.selection.length) {
          state.removeParts(state.selection);
          state.removeJoints(state.selection);
        }
        return;
      }
      const shortcuts: Record<string, string> = {
        '1': 'select', '2': 'link', '3': 'disc', '4': 'gear', '5': 'bevel',
        '6': 'worm', '7': 'pin', '8': 'join', '9': 'slider', '0': 'ground',
      };
      const next = shortcuts[e.key];
      if (next) state.setTool(next as never);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="app">
      <Toolbar />
      <div className="viewport" ref={containerRef}>
        <div className="overlay-views">
          <button className="action" onClick={() => viewportRef.current?.setView('front')}>Front</button>
          <button className="action" onClick={() => viewportRef.current?.setView('iso')}>Iso</button>
          <button className="action" onClick={() => viewportRef.current?.setView('top')}>Top</button>
        </div>
        {blownUp && (
          <div className="overlay-warn">
            <span>The mechanism diverged — the solver was stopped to protect the simulation.</span>
            <button className="action" onClick={() => useEditor.getState().resetToInitial()}>Reset</button>
          </div>
        )}
        {bootError && (
          <div className="overlay-warn">
            <span>Physics failed to start: {bootError}</span>
          </div>
        )}
      </div>
      <div className="sidebar">
        <Inspector />
        <Readouts running={running} />
      </div>
      <StatusBar
        running={running}
        tool={tool}
        pendingCount={pending.length}
        blownUp={blownUp}
      />
    </div>
  );
}
