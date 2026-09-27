import { useState } from 'react';
import { useEditor } from '../scene/store';
import type { Joint, Part } from '../scene/types';
import { MATERIALS } from '../scene/factories';
import { UNIT_LABEL, formatLength, type UnitSystem } from '../core/units';

/**
 * Property editor for the current selection, plus scene-wide settings. Live
 * fields (motor speed and torque, gravity) are pushed to the running solver
 * without a rebuild; everything else rebuilds so geometry and inertia stay true.
 */

function NumberField({
  label, value, onChange, step = 0.001, min, max, suffix,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  step?: number;
  min?: number;
  max?: number;
  suffix?: string;
}) {
  return (
    <div className="row">
      <label>{label}</label>
      <input
        type="number"
        value={Number.isFinite(value) ? +value.toFixed(6) : 0}
        step={step}
        min={min}
        max={max}
        onChange={(e) => {
          const v = Number(e.target.value);
          if (Number.isFinite(v)) onChange(v);
        }}
      />
      {suffix ? <span className="dim">{suffix}</span> : null}
    </div>
  );
}

function LengthField({
  label, metres, units, onChange,
}: {
  label: string;
  metres: number;
  units: UnitSystem;
  onChange: (metres: number) => void;
}) {
  const scale = units === 'mm' ? 1000 : units === 'cm' ? 100 : units === 'in' ? 1 / 0.0254 : 1;
  return (
    <div className="row">
      <label>{label}</label>
      <input
        type="number"
        value={+(metres * scale).toFixed(4)}
        step={units === 'm' ? 0.005 : 1}
        onChange={(e) => {
          const v = Number(e.target.value);
          if (Number.isFinite(v)) onChange(v / scale);
        }}
      />
      <span className="dim">{UNIT_LABEL[units]}</span>
    </div>
  );
}

function SceneSection() {
  const doc = useEditor((s) => s.doc);
  const setScene = useEditor((s) => s.setScene);
  const setUnits = useEditor((s) => s.setUnits);

  return (
    <div className="card">
      <header>Scene</header>
      <div className="body">
        <div className="row">
          <label>Name</label>
          <input type="text" value={doc.name} onChange={(e) => setScene({ name: e.target.value })} />
        </div>
        <div className="row">
          <label>Units</label>
          <select value={doc.units} onChange={(e) => setUnits(e.target.value as UnitSystem)}>
            {(['mm', 'cm', 'm', 'in'] as UnitSystem[]).map((u) => (
              <option key={u} value={u}>{UNIT_LABEL[u]}</option>
            ))}
          </select>
        </div>
        <div className="row">
          <label>Gravity</label>
          <input
            type="checkbox"
            checked={doc.gravityOn}
            onChange={(e) => setScene({ gravityOn: e.target.checked }, true)}
          />
          <input
            type="number"
            step={0.1}
            value={doc.gravity}
            disabled={!doc.gravityOn}
            onChange={(e) => setScene({ gravity: Number(e.target.value) || 0 }, true)}
          />
          <span className="dim">m/s²</span>
        </div>
        <div className="row">
          <label>Floor</label>
          <input
            type="checkbox"
            checked={doc.floor}
            onChange={(e) => setScene({ floor: e.target.checked })}
          />
          <span className="dim">static plane below the mechanism</span>
        </div>
        <LengthField
          label="Level gap"
          metres={doc.planeSpacing}
          units={doc.units}
          onChange={(v) => setScene({ planeSpacing: Math.max(0.001, v) })}
        />
        <div className="row">
          <label>New parts</label>
          <select
            value={doc.planeDofLock ? 'plane2d' : 'free'}
            onChange={(e) => setScene({ planeDofLock: e.target.value === 'plane2d' })}
          >
            <option value="plane2d">Locked to level plane</option>
            <option value="free">Free in 3D</option>
          </select>
        </div>
      </div>
    </div>
  );
}

function PartSection({ part }: { part: Part }) {
  const units = useEditor((s) => s.doc.units);
  const updatePart = useEditor((s) => s.updatePart);
  const doc = useEditor((s) => s.doc);

  const set = (patch: Partial<Part>) => updatePart(part.id, patch);
  const isRound = part.kind !== 'link';

  return (
    <div className="card">
      <header>
        <span>Part</span>
        <span className="dim">{part.kind}</span>
      </header>
      <div className="body">
        <div className="row">
          <label>Name</label>
          <input type="text" value={part.name} onChange={(e) => set({ name: e.target.value })} />
        </div>
        <div className="row">
          <label>Colour</label>
          <input type="color" value={part.color} onChange={(e) => set({ color: e.target.value })} />
          <label style={{ flex: '0 0 auto' }}>Level</label>
          <input
            type="number"
            value={part.plane}
            step={1}
            onChange={(e) =>
              set({
                plane: Math.round(Number(e.target.value) || 0),
                position: [part.position[0], part.position[1], (Math.round(Number(e.target.value) || 0)) * doc.planeSpacing],
              })
            }
          />
        </div>

        {part.kind === 'link' ? (
          <>
            <LengthField label="Length" metres={part.length ?? 0.08} units={units} onChange={(v) => set({ length: Math.max(0.001, v) })} />
            <LengthField label="Width" metres={part.width ?? 0.02} units={units} onChange={(v) => set({ width: Math.max(0.001, v) })} />
          </>
        ) : (
          <LengthField
            label={part.kind === 'worm' ? 'Worm radius' : 'Pitch radius'}
            metres={part.radius ?? 0.03}
            units={units}
            onChange={(v) => set({ radius: Math.max(0.002, v) })}
          />
        )}
        <LengthField
          label={part.kind === 'worm' ? 'Length' : 'Thickness'}
          metres={part.kind === 'worm' ? part.thickness * 2 : part.thickness}
          units={units}
          onChange={(v) => set({ thickness: part.kind === 'worm' ? v / 2 : Math.max(0.001, v) })}
        />

        {isRound && part.kind !== 'disc' ? (
          <NumberField
            label={part.kind === 'worm' ? 'Starts' : 'Teeth'}
            value={part.teeth ?? 16}
            step={1}
            min={1}
            onChange={(v) => set({ teeth: Math.max(1, Math.round(v)) })}
          />
        ) : null}

        {part.kind === 'bevel' ? (
          <NumberField label="Cone angle" value={part.coneAngle ?? 45} step={1} min={5} max={85} suffix="deg" onChange={(v) => set({ coneAngle: v })} />
        ) : null}
        {part.kind === 'worm' ? (
          <NumberField label="Lead angle" value={part.leadAngle ?? 12} step={1} min={1} max={45} suffix="deg" onChange={(v) => set({ leadAngle: v })} />
        ) : null}

        <div className="row">
          <label>Material</label>
          <select
            value={String(part.density)}
            onChange={(e) => set({ density: Number(e.target.value) })}
          >
            {Object.entries(MATERIALS).map(([name, density]) => (
              <option key={name} value={density}>{name} ({density})</option>
            ))}
          </select>
        </div>
        <NumberField label="Density" value={part.density} step={10} suffix="kg/m³" onChange={(v) => set({ density: Math.max(50, v) })} />

        <div className="row">
          <label>Degrees of freedom</label>
          <select value={part.dofs} onChange={(e) => set({ dofs: e.target.value as Part['dofs'] })}>
            <option value="plane2d">Locked to level (2D)</option>
            <option value="free">Free (6 DOF)</option>
          </select>
        </div>
        <div className="row">
          <label>Fixed</label>
          <input type="checkbox" checked={part.fixed} onChange={(e) => set({ fixed: e.target.checked })} />
          <span className="dim">static, immovable</span>
        </div>

        <div className="btn-row" style={{ marginTop: 6 }}>
          <button
            className="action danger"
            onClick={() => {
              const s = useEditor.getState();
              s.removeParts([part.id]);
            }}
          >
            Delete part
          </button>
          <button className="action" onClick={() => useEditor.getState().select(null)}>Deselect</button>
        </div>
      </div>
    </div>
  );
}

function JointSection({ joint }: { joint: Joint }) {
  const updateJoint = useEditor((s) => s.updateJoint);
  const doc = useEditor((s) => s.doc);
  const partName = (id: string | null) =>
    id === null ? 'world' : (doc.parts.find((p) => p.id === id)?.name ?? id);

  const set = (patch: Partial<Joint>, live = false) => updateJoint(joint.id, patch, live);
  const isShaft = joint.kind === 'pin' || joint.kind === 'slider';
  const isRotational = joint.kind === 'pin';

  return (
    <div className="card">
      <header>
        <span>Joint</span>
        <span className="dim">{joint.kind}</span>
      </header>
      <div className="body">
        <div className="row">
          <label>Between</label>
          <span className="grow">{partName(joint.a)} ↔ {partName(joint.b)}</span>
        </div>

        {joint.kind === 'gear' ? (
          <>
            <NumberField
              label="Ratio"
              value={joint.ratio ?? 2}
              step={0.5}
              onChange={(v) => set({ ratio: v })}
            />
            <p className="dim" style={{ margin: '2px 0 6px' }}>
              The driven part turns at -1/{joint.ratio?.toFixed(2)} of the driver, which is what
              external meshing does. Teeth counts set this automatically when you use the gear tool.
            </p>
          </>
        ) : null}

        <div className="row">
          <label>Axis</label>
          <input
            type="text"
            value={joint.axis.map((v) => +v.toFixed(3)).join(', ')}
            onChange={(e) => {
              const parts = e.target.value.split(',').map((s) => Number(s.trim()));
              if (parts.length === 3 && parts.every(Number.isFinite)) set({ axis: parts as Joint['axis'] });
            }}
          />
        </div>

        {isShaft ? (
          <>
            <div className="row">
              <label>Limits</label>
              <input
                type="checkbox"
                checked={joint.limits?.enabled ?? false}
                onChange={(e) => set({ limits: { enabled: e.target.checked, min: joint.limits?.min ?? -1, max: joint.limits?.max ?? 1 } })}
              />
              <input
                type="number"
                step={0.05}
                value={joint.limits?.min ?? -1}
                disabled={!joint.limits?.enabled}
                onChange={(e) => set({ limits: { enabled: true, min: Number(e.target.value), max: joint.limits?.max ?? 1 } })}
              />
              <input
                type="number"
                step={0.05}
                value={joint.limits?.max ?? 1}
                disabled={!joint.limits?.enabled}
                onChange={(e) => set({ limits: { enabled: true, min: joint.limits?.min ?? -1, max: Number(e.target.value) } })}
              />
            </div>

            <div className="row">
              <label>Motor</label>
              <input
                type="checkbox"
                checked={joint.motor?.enabled ?? false}
                onChange={(e) => set({ motor: { ...(joint.motor ?? { mode: 'velocity', targetVelocity: 1, targetPosition: 0, maxTorque: 0.2 }), enabled: e.target.checked } }, true)}
              />
              <select
                value={joint.motor?.mode ?? 'velocity'}
                onChange={(e) => set({ motor: { ...(joint.motor ?? { enabled: true, targetVelocity: 1, targetPosition: 0, maxTorque: 0.2 }), mode: e.target.value as 'velocity' | 'position' } }, true)}
              >
                <option value="velocity">velocity</option>
                <option value="position">position</option>
              </select>
            </div>

            {joint.motor?.enabled ? (
              <>
                {joint.motor.mode === 'velocity' ? (
                  <div className="row">
                    <label>{isRotational ? 'Speed' : 'Speed'}</label>
                    <input
                      type="range"
                      min={isRotational ? -20 : -0.5}
                      max={isRotational ? 20 : 0.5}
                      step={isRotational ? 0.1 : 0.005}
                      value={joint.motor.targetVelocity}
                      onChange={(e) => set({ motor: { ...joint.motor!, targetVelocity: Number(e.target.value) } }, true)}
                    />
                    <output>
                      {joint.motor.targetVelocity.toFixed(2)} {isRotational ? 'rad/s' : 'm/s'}
                    </output>
                  </div>
                ) : (
                  <NumberField
                    label="Target"
                    value={joint.motor.targetPosition}
                    step={isRotational ? 0.1 : 0.005}
                    suffix={isRotational ? 'rad' : 'm'}
                    onChange={(v) => set({ motor: { ...joint.motor!, targetPosition: v } }, true)}
                  />
                )}
                <div className="row">
                  <label>{isRotational ? 'Max torque' : 'Max force'}</label>
                  <input
                    type="range"
                    min={0.01}
                    max={isRotational ? 5 : 50}
                    step={0.01}
                    value={joint.motor.maxTorque}
                    onChange={(e) => set({ motor: { ...joint.motor!, maxTorque: Number(e.target.value) } }, true)}
                  />
                  <output>
                    {joint.motor.maxTorque.toFixed(2)} {isRotational ? 'N·m' : 'N'}
                  </output>
                </div>
                <div className="row">
                  <label title="Lower is gentler. A stiff motor can tear apart a light linkage.">Response</label>
                  <input
                    type="range"
                    min={0.5}
                    max={30}
                    step={0.5}
                    value={joint.motor.frequency ?? 10}
                    onChange={(e) => set({ motor: { ...joint.motor!, frequency: Number(e.target.value) } }, true)}
                  />
                  <output>{(joint.motor.frequency ?? 10).toFixed(1)} Hz</output>
                </div>
                <p className="dim" style={{ margin: '2px 0 0' }}>
                  A real drive stalls: set the torque to its stall torque and it will refuse to push
                  past that. Response is how sharply it chases the target — lower is gentler, and a
                  very stiff motor can shake a light linkage apart.
                </p>
              </>
            ) : null}
          </>
        ) : null}

        <div className="btn-row" style={{ marginTop: 6 }}>
          <button className="action danger" onClick={() => useEditor.getState().removeJoints([joint.id])}>
            Delete joint
          </button>
          <button className="action" onClick={() => useEditor.getState().select(null)}>Deselect</button>
        </div>
      </div>
    </div>
  );
}

export function Inspector() {
  const doc = useEditor((s) => s.doc);
  const selection = useEditor((s) => s.selection);
  const select = useEditor((s) => s.select);
  const activePlane = useEditor((s) => s.activePlane);
  const explode = useEditor((s) => s.explode);
  const [tab, setTab] = useState<'selection' | 'outline'>('selection');

  const selectedPart = doc.parts.find((p) => p.id === selection[0]);
  const selectedJoint = doc.joints.find((j) => j.id === selection[0]);

  return (
    <>
      <SceneSection />

      <div className="card">
        <header>
          <span>Levels</span>
          <span className="dim">{doc.planeSpacing > 0 ? formatLength(doc.planeSpacing, doc.units) : ''} apart</span>
        </header>
        <div className="body">
          <div className="row">
            <label>Active level</label>
            <button className="action" onClick={() => useEditor.getState().setActivePlane(activePlane - 1)}>−</button>
            <output style={{ flex: '0 0 40px', textAlign: 'center' }}>{activePlane}</output>
            <button className="action" onClick={() => useEditor.getState().setActivePlane(activePlane + 1)}>+</button>
          </div>
          <div className="row">
            <label>Explode</label>
            <input
              type="range"
              min={0}
              max={0.12}
              step={0.002}
              value={explode}
              onChange={(e) => useEditor.getState().setExplode(Number(e.target.value))}
            />
            <output>{explode.toFixed(3)}</output>
          </div>
          <p className="dim" style={{ margin: '2px 0 0' }}>
            Explode is a view-only spread between levels. It never changes the simulation.
          </p>
        </div>
      </div>

      <div className="card">
        <header>
          <span>Outline</span>
          <div className="btn-row">
            <button className={`action ${tab === 'selection' ? 'primary' : ''}`} onClick={() => setTab('selection')}>
              Selection
            </button>
            <button className={`action ${tab === 'outline' ? 'primary' : ''}`} onClick={() => setTab('outline')}>
              All
            </button>
          </div>
        </header>
        <div className="body">
          {tab === 'selection' ? (
            selectedPart ? (
              <PartSection part={selectedPart} />
            ) : selectedJoint ? (
              <JointSection joint={selectedJoint} />
            ) : (
              <p className="dim" style={{ margin: 0 }}>
                Nothing selected. Click a part or a joint in the list.
              </p>
            )
          ) : null}

          {tab === 'outline' ? (
            <>
              <div className="list">
                {doc.parts.map((p) => (
                  <div
                    key={p.id}
                    className={`list-item ${selection.includes(p.id) ? 'selected' : ''}`}
                    onClick={() => select(p.id)}
                  >
                    <span className="swatch" style={{ background: p.color }} />
                    <span className="grow">{p.name}</span>
                    <span className="dim">L{p.plane}</span>
                  </div>
                ))}
                {doc.joints.map((j) => (
                  <div
                    key={j.id}
                    className={`list-item ${selection.includes(j.id) ? 'selected' : ''}`}
                    onClick={() => select(j.id)}
                  >
                    <span className="swatch" style={{ background: '#5b6b7d' }} />
                    <span className="grow">{j.kind} joint</span>
                    <span className="dim">
                      {j.a === null ? 'world' : ''}→{doc.parts.find((p) => p.id === j.b)?.name ?? '?'}
                    </span>
                  </div>
                ))}
                {doc.parts.length === 0 ? (
                  <p className="dim" style={{ margin: 4 }}>
                    Empty scene. Pick a tool and click the work plane, or load an example.
                  </p>
                ) : null}
              </div>
            </>
          ) : null}
        </div>
      </div>
    </>
  );
}
