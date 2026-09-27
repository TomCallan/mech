# TODO

Ordered by what actually blocks confidence in the project, not by what is fun.

## Verification gaps (highest priority)

- [ ] **The UI has never been run in a real browser.** Physics, serialisation and the
      module graph are verified headlessly, but rendering, camera behaviour, picking,
      the depth-disambiguation path and drag feel are all unproven. First job: open it,
      click every tool, and fix what breaks.
- [ ] Add a browser smoke test (Playwright): load the app, wait for the first frame,
      assert the canvas is non-blank, place a link, drag it, run 2 s, assert the pose
      buffer moved. This is the cheapest way to stop UI regressions.
- [ ] Add a rendering assertion for the examples: each example produces a non-empty
      draw list and at least one visible mesh per part.
- [ ] Verify touch/pointer behaviour on a tablet, or explicitly declare desktop-only.

## Correctness

- [ ] Wire the solver panel to the UI. `src/sim/jolt.ts` already exposes a mutable
      `solver` object and `engine.ts` has `applySolverSettings`; nothing calls it from
      the UI yet.
- [ ] Model a real drive's torque-speed curve: τ = τ_stall(1 − ω/ω_no_load), by
      modulating `mMaxTorqueLimit` from the current ω each step. Today the motor is a
      constant-torque clamp, which lets it accelerate anything.
- [ ] Report joint reaction force for `weld` and `ball` joints. Only hinge and slider
      expose lambda accessors today, so those readouts are silently zero.
- [ ] Cross-check a solved linkage against closed-form kinematics. Position analysis
      for a four-bar is a few lines; asserting the solver matches it would turn
      "looks right" into "is right".
- [ ] Decide and document mass-ratio limits. High ratios destabilise the solver; either
      clamp them with a warning or surface them in the inspector.

## Missing mechanisms

- [ ] **Belts.** A belt drive is a `GearConstraint` with a positive ratio (crossed belt
      = negative), plus a visual spline over the pulleys. Do not use
      `PulleyConstraint` for this — it is a block-and-tackle rope, not a transmission
      belt. Expose it separately and label it correctly as a rope/tackle.
- [ ] Rack and pinion via `RackAndPinionConstraint`, which needs a hinge plus a slider.
      The authoring flow has to create those two pins automatically.
- [ ] Cams and followers. Needs per-part collision opt-in, since moving parts do not
      collide by design.

## Fidelity

- [ ] Convex-hull links instead of boxes, so inertia is true for asymmetric parts
      (Jolt computes products of inertia from the shape, so modelling the real profile
      is what buys the accuracy).
- [ ] Per-part friction and restitution, with combine rules exposed.
- [ ] A measure tool: pick two points, get distance/angle; pick a joint, get a live
      plot with units. Engineering users need to read numbers off the mechanism.
- [ ] Export instrumented traces to CSV.

## Levels and authoring UX

- [ ] Depth disambiguation is currently "active level wins, else nearest". Add the
      radial stack picker for when three levels overlap: click shows `[L2][L1][L0]`,
      hovering highlights, clicking selects and switches the active level.
- [ ] A movable slice plane so you can cut into a stack and reach an interior level.
- [ ] Ghost neighbouring levels (fade non-active parts) so the active level reads
      clearly in the iso view.
- [ ] Coalesce undo entries: dragging a part currently pushes one snapshot per frame.
      Group a drag into one undo step.
- [ ] Snapping hints and a dimension readout while placing parts.

## Performance

- [ ] Profile against a stress scene (~500 parts) and record real numbers. The current
      0.09 ms/step figure is for a handful of bodies.
- [ ] Instanced or batched rendering for large scenes. One mesh per part is fine to a
      few hundred parts and is simpler; measure before changing it.
- [ ] Audit the pose readback: two pooled-view reads per part per frame. If profiling
      shows it matters, a custom Jolt build exposing a bulk transform dump into a flat
      `Float32Array` is the escape hatch (JoltPhysics.js is MIT and buildable).
      `src/sim/wasmUrl.ts` exists precisely to keep that swap contained.

## Product

- [ ] Raise the engine body capacity or make it growable. 4096 is fixed at engine
      creation and larger scenes are rejected rather than grown into.
- [ ] Timeline scrub and replay via ring-buffer snapshots. Physics is irreversible, so
      this needs snapshots, not reverse simulation. Deliberately out of scope for now.
- [ ] Deterministic record/replay: fixed timestep plus `mDeterministicSimulation` already
      makes this plausible, and it would let a scene be shared as a seed plus inputs.
- [ ] Prompt to restore the autosave on load instead of requiring a button.
- [ ] A gallery of physics-education examples: crank-slider, Geneva mechanism,
      escapement, Jansen leg, planetary gear set.
