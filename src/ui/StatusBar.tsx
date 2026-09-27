import { useEffect, useState } from 'react';
import { sim } from '../sim/instance';
import { toolHint } from '../app/interaction';
import { useEditor } from '../scene/store';
import { UNIT_LABEL } from '../core/units';

interface Stats {
  fps: number;
  stepsPerSecond: number;
  blownUp: boolean;
}

export function StatusBar({
  running, tool, pendingCount, blownUp,
}: {
  running: boolean;
  tool: Parameters<typeof toolHint>[0];
  pendingCount: number;
  blownUp: boolean;
}) {
  const [stats, setStats] = useState<Stats>({ fps: 0, stepsPerSecond: 0, blownUp: false });
  const partCount = useEditor((s) => s.doc.parts.length);
  const jointCount = useEditor((s) => s.doc.joints.length);
  const units = useEditor((s) => s.doc.units);
  const activePlane = useEditor((s) => s.activePlane);

  useEffect(() => {
    const onStats = (e: Event) => {
      const detail = (e as CustomEvent<Stats>).detail;
      setStats(detail);
    };
    window.addEventListener('mech:stats', onStats);
    return () => window.removeEventListener('mech:stats', onStats);
  }, []);

  return (
    <div className="statusbar">
      <span>
        {running ? <strong className={blownUp ? 'bad' : 'good'}>running</strong> : <strong>paused</strong>}
      </span>
      <span>{stats.fps.toFixed(0)} fps</span>
      <span>
        {running ? `${stats.stepsPerSecond || sim.stepsThisSecond} steps/s` : '—'}
      </span>
      <span>{sim.lastStepMs.toFixed(2)} ms/step</span>
      <span className="spacer" />
      <span>{toolHint(tool, pendingCount)}</span>
      <span className="spacer" />
      <span>level <strong>{activePlane}</strong></span>
      <span>{partCount} parts · {jointCount} joints</span>
      <span>{UNIT_LABEL[units]}</span>
    </div>
  );
}
