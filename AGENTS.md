# AGENTS.md

Guidance for agents working in this repository. Read this before changing anything
that touches physics.

## What this is

A browser sandbox for building mechanisms (links, gears, motors, joints) with real
physics, simulated as 2D mechanics but presented in 3D on stacked levels. Physics is
Jolt via `jolt-physics` (WASM), rendering is three.js, UI is React.

## Commands

```sh
npm run dev          # dev server on :5173
npm run typecheck    # tsc --noEmit — run this before claiming a change works
npm run test:sim     # 28 integration checks against the real SimWorld (headless Node)
npm run smoke        # 10 solver checks: joint stiffness, gear ratios, step cost
npm run build        # production bundle
```

`test:sim` and `smoke` run headlessly against the real WASM build via the
base64-embedded `wasm-compat` flavour. No browser needed. **Run both after any change
to `src/sim/`.** They are the only automated verification of the physics; there are
currently no UI tests, so a UI change is unverified until a human looks at it — say so
rather than claiming it works.

## Architecture

```
document (plain JSON)  ──rebuild──▶  SimWorld (Jolt bodies + constraints)
        ▲                                     │ pose buffer (Float32)
        │ edits                               ▼
   React panels  ◀──reads──  SimHost loop ──▶ Viewport (three.js)
```

- `src/scene/` — the document is the single source of truth. Undo/redo snapshots it;
  save/load and share links serialise it. All lengths in **SI metres**.
- `src/sim/` — `SimWorld` is a disposable projection of the document. `SimHost` owns
  the fixed-timestep loop and rebuilds only on structural change. Live edits (motor
  speed/torque, gravity) go through `applyLive` so tuning never resets motion.
- `src/render/` — three.js. The world is **Z-up**, so render coordinates are physics
  coordinates with no conversion. Do not introduce a coordinate swap.
- `src/ui/` — React renders only panels. The render loop reads store state directly
  and must never trigger a React render.

## Hard-won Jolt rules — do not break these

Each of these was established empirically and cost real debugging time. `README.md`
has the full write-up with measurements.

1. `new Jolt.SomeShape(...)` starts at **refcount 0**. Call `AddRef()` to hold your own
   reference, or the shape is freed when its last body dies and the next `CreateBody`
   reads freed memory. The symptom is a misleading `table index is out of bounds`.
2. **Never `Jolt.destroy()` a Shape or a Constraint.** They are `RefTarget` subclasses
   and `destroy` is a hard destructor, so it frees objects other code references. Use
   `Release()`. `RemoveConstraint` already releases.
3. `Body.GetPosition()` / `GetRotation()` return **pooled views, not owned
   allocations**. Free WASM heap is unchanged across 20,000 reads. `Jolt.destroy()` on
   them corrupts the heap. Read the components, drop the wrapper.
4. Teardown order is `RemoveConstraint` → `RemoveBody` → `DestroyBody`. Destroying a
   body without removing it first corrupts the heap.
5. `ShapeSettings.Create().Get()` returns a wrapper **without `Shape` methods**. For
   settings-built shapes, set density on the `ConvexShapeSettings` before `Create`.
6. Density lives on the **shape**, and shapes are cached and shared. Density is part of
   the cache key — setting it per part silently applies the last value to every body
   sharing that shape.
7. `HingeConstraintSettings` **defaults limits to ±π**, so a hinge with no authored
   limits still stops after half a turn. Limits are explicitly set to ±1e30 when
   disabled.
8. `Step(dt, 2)` destabilises closed loops. `solver.collisionSteps = 1` is validated.
9. **Ground-anchored joints must use `sGetFixedToWorldBody()`, never a physical body.**
   A collidable ground anchor sitting at a pivot means the mechanism collides with its
   own ground and contact forces fight the constraints (measured: 0.43 vs 4.76 turns).
10. Moving parts do not collide with each other, by design. Mechanisms are held by
    joints; contact manifolds fighting the solver is a classic blow-up.
11. Sleeping is off deliberately. A mechanism that briefly slows could otherwise sleep
    and ignore its motor forever.
12. There is **one `JoltInterface` per process** and it is never recreated. Creating a
    second one crashes. Rebuild = clear bodies/constraints, keep the interface.

## Conventions

- New parts default to `dofs: 'plane2d'`. This is load-bearing, not cosmetic: a
  four-bar with four full 3D hinges is over-constrained (mobility −2) and diverges in
  under a second. Only use `'free'` for genuinely spatial mechanisms.
- Angles for instrumentation are derived from body poses.
  `HingeConstraint.GetCurrentAngle()` returns 0 for world-space constraints in this
  build.
- Prefer a new example in `src/scene/examples.ts` over a one-off test scene; the
  examples are exercised by `test:sim` and double as regression coverage.
- Add a check to `scripts/integration.ts` for any bug you fix. A bug that was
  reproducible headlessly should stay reproducible.
- Keep the hot loop allocation-free. `SimWorld` uses a `Scratch` pool for Jolt
  temporaries; follow that pattern rather than allocating per frame.
- When a mechanism-behaviour bug appears, check the geometry first: compute the
  transmission angle. A 0° minimum means a genuine dead point, which is real
  mechanics, not a solver bug. `README.md` notes the analysis approach.

## Known gaps

See `TODO.md`. The most important one: the UI has never been verified in a real
browser from this environment, so rendering, picking and drag feel are unproven.
