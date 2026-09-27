# Mech — a 3D linkage sandbox

Build planar and spatial mechanisms out of rigid links, gears, pulleys and motors,
drive them, and watch real physics. Everything is simulated in 2D mechanics but
presented in a 3D scene on stacked levels, so a crank on one level can drive a gear
train on another.

Physics is [Jolt](https://github.com/jrouwe/JoltPhysics) via `jolt-physics` (WASM),
rendering is three.js, UI is React. The simulation runs single-threaded on the main
thread, which needs no `SharedArrayBuffer` and therefore no COOP/COEP headers, so
the app stays embeddable in an iframe and hostable on any static host.

## Running

```sh
npm install
npm run dev          # http://localhost:5173

npm run typecheck    # tsc --noEmit
npm run test:sim     # integration tests against the real SimWorld (28 checks)
npm run smoke        # solver validation: joint stiffness, gear ratios, step cost
npm run build        # production bundle
```

`npm run test:sim` and `npm run smoke` run headless in Node against the real WASM
build using the base64-embedded `wasm-compat` flavour, so no browser is required.

## Architecture

```
document (plain JSON)  ──rebuild──▶  SimWorld (Jolt bodies + constraints)
        ▲                                     │ pose buffer (Float32)
        │ edits                               ▼
   React panels  ◀──reads──  SimHost loop ──▶ Viewport (three.js)
```

- **`src/scene/`** — the document is the single source of truth: parts, joints,
  units, levels. Undo/redo snapshots it, save/load and share links serialise it.
- **`src/sim/`** — `SimWorld` is a disposable projection of the document. `SimHost`
  owns the fixed-timestep loop and rebuilds the world only when the document's
  structure changes; live edits (motor speed, torque, gravity) are applied in place
  so tuning a motor never resets the motion.
- **`src/render/`** — three.js. The world is **Z-up**, so physics coordinates map to
  render coordinates with no conversion. Gear and worm geometry is generated
  procedurally; gear teeth are visual only.
- **`src/ui/`** — React renders only the panels. The render loop reads store state
  directly and never triggers a React render.

### Units

All lengths are stored in **SI metres**. The scene's unit selection (`mm`/`cm`/`m`/`in`)
affects display, input parsing and grid labels only. This removes an entire class of
"the physics is subtly wrong" bugs.

### Levels and the planar default

A part's `plane` is an authoring level rendered as a Z offset. New parts default to
`dofs: 'plane2d'`, which locks the body to its level.

This is not a convenience, it is load-bearing. A four-bar built from four full 3D
revolute joints has Grübler mobility `6(4−1) − 4×5 = −2`: it is over-constrained by
two redundant equations, and a rigid iterative solver responds to contradictory
constraints with escalating internal forces. Measured with `npm run smoke`:

| Configuration | Result |
|---|---|
| Four-bar with Plane2D bodies, driven 60 s | 60 revolutions, **0.00095 mm** pin drift, exactly in-plane |
| Same four-bar left free in 3D | **diverges after 0.25 revolutions** |

So planar mechanisms are exact by default, and `dofs: 'free'` is available when you
genuinely want a spatial mechanism (the bevel and worm examples use it).

## Jolt integration rules

These were established empirically against the published build, and each one cost
real debugging time. They are enforced in `src/sim/engine.ts` and
`src/sim/world.ts`.

**Ownership and reference counting**

1. `new Jolt.SomeShape(...)` starts at **reference count 0**. Call `AddRef()` to hold
   your own reference. Without it the shape is freed the moment its last body is
   destroyed, and the next `CreateBody` reads freed memory — which surfaces as a
   misleading `table index is out of bounds` from deep inside the solver.
2. `Release()` is how you give that reference up. **Never `Jolt.destroy()` a Shape or
   a Constraint**: they are `RefTarget` subclasses and `destroy` is a hard
   destructor, so it frees objects other code still references.
3. `AddConstraint` takes a reference and `RemoveConstraint` releases it, so
   constraints need no explicit teardown.
4. Plain structs (`JoltSettings`, `SpringSettings`, `MotorSettings`,
   `BodyCreationSettings`, `ConstraintSettings`, layer tables) are not refcounted
   and are correct to `Jolt.destroy` once consumed.
5. Teardown order is `RemoveConstraint` → `RemoveBody` → `DestroyBody`. Destroying a
   body without removing it first corrupts the heap.

**Reading transforms**

6. `Body.GetPosition()` and `GetRotation()` return **pooled value views, not owned
   allocations**. Free WASM heap is unchanged across 20,000 reads, and
   `Jolt.destroy()` on them corrupts the heap. Read the components and drop the
   wrapper.

**Shapes**

7. `ShapeSettings.Create().Get()` returns a wrapper **without `Shape` methods** (no
   `SetDensity`). For shapes built from settings, set density on the
   `ConvexShapeSettings` before `Create`. Directly constructed shapes (`BoxShape`,
   `CylinderShape`) do have `SetDensity`.
8. Density lives on the *shape*. Since shapes are cached and shared, density is part
   of the cache key: setting it per part would silently apply the last value written
   to every body sharing that shape.
9. A cylinder's native axis is Y. Round parts wrap it in a
   `RotatedTranslatedShapeSettings` so body-local Z is the axle and matches the
   hinge axis.

**Simulation configuration**

10. `JoltInterface.Step(dt, collisionSteps)` with `collisionSteps = 2` made a driven
    four-bar degrade from 2.4 turns to 0.36 over 12 s. `collisionSteps = 1` is the
    validated configuration.
11. A `HingeConstraintSettings` **defaults its limits to ±π**, so a hinge with no
    authored limits still stops after half a turn. Limits are explicitly opened to
    ±1e30 when disabled.
12. Sleeping is **off**. A mechanism that briefly slows can fall asleep and then
    ignore its motor forever, which reads as "my motor does nothing".
13. **Ground-anchored joints use Jolt's fixed-to-world body, never a physical body.**
    A small static box at the origin sat inside the swept volume of a crank pivoting
    there, so the crank collided with its own ground anchor and the contact forces
    fought the hinge constraints: the four-bar stuck at the same phase every
    revolution with reaction forces climbing past 300 N, and *more* solver effort
    made it worse. Measured before and after the fix, same mechanism and motor:

    | Ground anchor | Turns in 4.8 s (target 4.80) |
    |---|---|
    | collidable static box at the origin | 0.43 |
    | fixed-to-world body | **4.76** |

14. Moving parts do not collide with each other. Mechanisms are held by joints, and
    contact manifolds fighting the constraint solver is a classic blow-up.

## Instrumentation

The readouts show joint angle and speed, plus reaction force and motor torque derived
from `GetTotalLambdaPosition()` and `GetTotalLambdaMotor()` divided by the step. Read
them as **per-step average reaction**, not instantaneous peak.

Note that `HingeConstraint.GetCurrentAngle()` reported 0 for constraints created in
world space in this build, so angles are derived from body poses instead.

## Known limitations

- Solver capacity is fixed at engine creation (4096 bodies), so extreme scenes are
  rejected rather than grown into.
- Belts and pulleys are not implemented. Jolt's `PulleyConstraint` is a
  block-and-tackle rope, *not* a closed transmission belt, so shipping it as a belt
  would produce visibly wrong behaviour. A belt drive is a `GearConstraint` with a
  positive ratio; that is the right basis.
- No timeline scrub or replay. The simulation is irreversible (friction, restitution),
  so scrubbing would need ring-buffer snapshots.
- Links are box shapes. Convex-hull links would give truer inertia for asymmetric
  parts.
- The renderer draws one mesh per part. Instanced rendering is the next step for very
  large scenes.

## Credits

Physics: [JoltPhysics.js](https://github.com/jrouwe/JoltPhysics.js) (MIT).
