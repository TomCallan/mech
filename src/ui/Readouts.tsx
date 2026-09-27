import { useEffect, useRef, useState } from 'react';
import { sim } from '../sim/instance';
import { useEditor } from '../scene/store';
import type { JointMetric } from '../sim/world';

const SERIES_COLORS = ['#4a9eff', '#ffb454'];
const MAX_SAMPLES = 360;
const SAMPLE_MS = 60;

/**
 * Live instrumentation. Deliberately decoupled from the render loop: numbers and
 * the graph refresh on their own timer so a 120 Hz simulation never drives React
 * renders.
 *
 * The force and torque figures are solver reaction impulses divided by the step,
 * so read them as per-step average reaction, not instantaneous peak.
 */
export function Readouts({ running }: { running: boolean }) {
  const doc = useEditor((s) => s.doc);
  const selection = useEditor((s) => s.selection);
  const [metric, setMetric] = useState<JointMetric | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const buffers = useRef<number[][]>([[], []]);
  const scaleRef = useRef(1);

  const jointId = selection.find((id) => doc.joints.some((j) => j.id === id)) ?? doc.joints[0]?.id ?? null;
  const joint = doc.joints.find((j) => j.id === jointId) ?? null;
  const isRotational = joint?.kind === 'pin' || joint?.kind === 'gear';

  useEffect(() => {
    buffers.current = [[], []];
    scaleRef.current = 1;
  }, [jointId]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      const all = sim.metrics;
      const found = jointId ? all.find((m) => m.id === jointId) ?? null : null;
      setMetric(found);

      if (!running) return;
      if (found) {
        buffers.current[0].push(found.value);
        buffers.current[1].push(found.speed);
        for (const buf of buffers.current) {
          if (buf.length > MAX_SAMPLES) buf.splice(0, buf.length - MAX_SAMPLES);
        }
        const peak = Math.max(
          1e-6,
          ...buffers.current[0].map(Math.abs),
          ...buffers.current[1].map(Math.abs),
        );
        scaleRef.current = scaleRef.current * 0.9 + peak * 0.1;
      }
      draw();
    }, SAMPLE_MS);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jointId, running]);

  function draw() {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = Math.min(window.devicePixelRatio, 2);
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
      canvas.width = w * dpr;
      canvas.height = h * dpr;
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    // Zero line
    ctx.strokeStyle = '#1b2432';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, h / 2);
    ctx.lineTo(w, h / 2);
    ctx.stroke();

    const scale = scaleRef.current || 1;
    buffers.current.forEach((buf, seriesIndex) => {
      if (buf.length < 2) return;
      ctx.strokeStyle = SERIES_COLORS[seriesIndex];
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      const step = w / (MAX_SAMPLES - 1);
      buf.forEach((v, i) => {
        const x = i * step;
        const y = h / 2 - (v / scale) * (h / 2 - 4);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();
    });
  }

  const unit = isRotational ? 'rad' : 'm';
  const rateUnit = isRotational ? 'rad/s' : 'm/s';

  return (
    <div className="card">
      <header>
        <span>Instrumentation</span>
        <span className="dim">{joint ? `${joint.kind} · ${joint.id}` : 'no joints'}</span>
      </header>
      <div className="body">
        {metric ? (
          <div className="readouts">
            <div className="readout">
              <span>{isRotational ? 'Angle' : 'Travel'}</span>
              <span>{metric.value.toFixed(3)} {unit}</span>
            </div>
            <div className="readout">
              <span>Speed</span>
              <span>{metric.speed.toFixed(3)} {rateUnit}</span>
            </div>
            <div className="readout">
              <span>Reaction force</span>
              <span>{metric.forceN.toFixed(2)} N</span>
            </div>
            <div className="readout">
              <span>Motor torque</span>
              <span>{metric.torqueNm.toFixed(3)} N·m</span>
            </div>
          </div>
        ) : (
          <p className="dim" style={{ margin: 0 }}>
            Place or select a joint to see angle, speed and reaction force.
          </p>
        )}

        <canvas ref={canvasRef} className="graph" style={{ height: 90, marginTop: 8 }} />
        <div className="legend">
          <span><i style={{ background: SERIES_COLORS[0] }} />{isRotational ? 'angle' : 'travel'}</span>
          <span><i style={{ background: SERIES_COLORS[1] }} />speed</span>
          <span className="grow" style={{ textAlign: 'right' }}>±{scaleRef.current.toFixed(2)}</span>
        </div>
      </div>
    </div>
  );
}
