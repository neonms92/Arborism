# Fibre mechanics test manifest

**Status: proposal, awaiting the owner's approval.** Nothing here is
implemented. Once approved, each test below becomes one data entry in a test
list read by the Testing menu (see "Runner notes" at the end), and the
tolerances marked *(proposed)* get tuned against the first real runs.

Scope: the fibre model of `docs/DESIGN.md` section 3: the stiff regime
(`fibres.analyse`, `model/flex.js`), the live regime (`structure.liveStep`),
cuts (`cut` / `divide` / `split` events) and the tree generator
(`model/treegen.js`). Players, rope and networking are out of scope here.

---

## 1. How to read a test

Every test has the same parts.

| Part | Meaning |
|---|---|
| **ID** | `FM-nn`. Stable forever; results are tracked by it. A test whose meaning changes gets a new ID. |
| **Scenario** | What is built and what is done to it. Built from events only (`tree`, `cut`, ...), never by poking the model, so a run can be replayed from its event log. |
| **Parameters** | Every value the test varies. `CFG.*` keys use config.js units (SI). Scenario values (lean, notch angle...) are local to the test. |
| **Must-pass range** | The envelope where every sample must pass. A failure here is a regression. |
| **Explore range** | Wider envelope that is run and recorded but not judged. Its job is to map where the model stops behaving, so the must-pass range and the Tab-menu slider limits can be set from data. |
| **Measured** | Numbers the runner records for every run, pass or fail. |
| **Pass if** | Automatic criteria on those numbers. All must hold. |
| **Time** | Simulated seconds: the run stops at the time limit or when the pass/fail outcome is settled. |
| **View** | What the graphical view of a single run should frame and highlight. |

Defaults for every parameter not listed in a test are the values in
`src/config.js` at the commit under test. The run records a copy of the full
`CFG` it used, so a result can always be reproduced.

### 1.1 Sampling a range

A range is `lo – hi` (continuous) or a list `{a, b, c}` (discrete).

- **Must-pass:** the runner runs every corner of the box (all lo/hi
  combinations, capped at 64 by taking a random subset of corners), the centre,
  and 16 further points from a Latin hypercube. Every one must pass. Seeds:
  the first 3 seeds listed in the test unless it says otherwise.
- **Explore:** a Latin hypercube of N points (N given per test, default 200),
  one seed each, no verdict. Results feed the boundary report (section 6).
- A **sweep** marked `axis` runs one parameter at a time from its default to
  each end of the explore range, others at default, bisecting to locate the
  first failure to within 5 % of the range.

### 1.2 Invariants checked in every run

These are checked every tick in every test. Any breach fails the run
immediately, whatever the test, and the breach is recorded with its tick.

| ID | Check |
|---|---|
| INV-1 | No `NaN` or `Infinity` in any body transform, velocity, strain plane (`f.e0..e2`) or live fibre force. |
| INV-2 | No uncaught exception in the sim. |
| INV-3 | No dynamic piece moves faster than free fall from where it started, plus a margin: `|v| ≤ sqrt(2·g·h₀) + 2 m/s`, where `h₀` is the height of its centre of mass when it became a piece. Catches pieces launched by the live solver (DECISIONS D19). |
| INV-4 | No piece's centre of mass below `−0.5 m` (sunk through the ground). |
| INV-5 | No rooted (fixed) piece has moved (its transform is the identity). |
| INV-6 | Every intact stiff bundle is in equilibrium: the fibre forces from its strain plane give back the axial force and the two moments it was solved for, to 1 % (or 1 N / 1 N·m, whichever is larger). Checked on every bundle every 30 ticks. |

### 1.3 Shared measurements

Defined once, used by many tests.

- **Tip displacement** of a segment: distance between `segToWorld(s, s.b)` now
  and at tick 0.
- **Settled:** every tip displacement changes by less than 1 mm over the last
  1 s, no live bundle exists, and every dynamic piece is slower than 0.05 m/s.
- **Worst utilisation** `U`: the largest of `f.maxT / MOR` and
  `−f.minC / COMP` over all stiff bundles.
- **Event counts:** `split` events (separate live and clean), fibres sawn
  (from `cut` events), fibres snapped (live fibres that reached `BROKEN`).
- **Fall heading** of a felled stem: azimuth of the horizontal vector from its
  butt (`a` of its root segment) to its top (`b` of its last trunk segment),
  measured when it has settled. 0° = +x, counted towards +z.
- **Step cost:** wall-clock time of `sim.step()`, mean and 95th percentile.

### 1.4 Scenario building blocks

Tests that do not use the tree generator build their wood from these.

- **Stem(H, D, taper, lean, leanAz, SEG_LEN):** a branchless rooted trunk.
  Base at the origin, base diameter `D`, tip diameter `taper·D` (default 0.4),
  straight, tilted `lean` from vertical towards azimuth `leanAz`, divided into
  `round(H / SEG_LEN)` segments. No foliage. Emitted as one `tree` event.
- **Limb(L, D, angle):** a 0.5 m vertical stub of diameter `1.5·D` rooted at the
  origin, with a straight branchless limb of length `L`, base diameter `D`,
  tip `0.4·D`, leaving the stub's tip at `angle` above horizontal. The stub
  exists because the root segment of a rooted piece is never released by
  overload (`structure.bundleStep` requires a parent or a cut), so the limb's
  first segment must have a parent.
- **Plane cut(seg, height, direction, depth, slope):** sever, with one `cut`
  event, every intact fibre of the segment whose position across the stem lies
  more than `R − depth` along `direction`, at axial position `height` (+ the
  slope rise for that fibre). This is how the earlier scripted felling tests
  cut, and it skips the saw (DESIGN 4) on purpose: these tests are about the
  wood, not the saw. If two cut planes are more than a diameter apart the
  existing `divide` logic applies, as in play.
- **Progressive cut:** the same, but fibres are severed a few at a time in
  order of distance from the starting face, at a rate of `CUT_RATE`
  (m² per s), as the saw would. Used for back cuts, where the timing matters.
- **Point load(seg, t, F, ramp):** a force added to `sim.loads` each tick at a
  fraction `t` along the segment, ramped linearly from 0 over `ramp` seconds.

---

## 2. Stiff regime: standing wood under its own weight and loads

### FM-01 Cantilever sags as beam theory says

*Why:* the strain plane and the disc tilts are the whole of standing-wood
bending (DESIGN 3.2, 3.2a). This pins them to a textbook answer.

- **Scenario:** Limb(L, D, 0°), self-weight only. Run until settled.
- **Parameters:**

  | Parameter | Must-pass | Explore |
  |---|---|---|
  | L (m) | 1.5 – 6 | 0.5 – 10 |
  | D (m) | 0.06 – 0.30 | 0.03 – 0.6 |
  | `SEG_LEN` (m) | 0.3 – 1.0 | 0.15 – 2 |
  | `FIBRE_PITCH` (m) | 0.02 – 0.04 | 0.008 – 0.1 |
  | `TENS_STRAIN` | 0.004 – 0.01 | 0.0005 – 0.1 |
  | `COMP_STRAIN` | 0.006 – 0.015 | 0.0005 – 0.1 |
  | `DENSITY` (kg/m³) | 600 – 1000 | 200 – 1400 |

- **Measured:** tip sag `δ`; analytic sag of a tapered cantilever under
  self-weight, computed twice, with `E = MOR/TENS_STRAIN` (stiff bound) and
  `E = COMP/COMP_STRAIN` (soft bound); root-bundle `maxT` and `minC`; time to
  settle.
- **Pass if:** `δ` lies between the two analytic bounds, widened by 20 %
  *(proposed)* for the coarse fibre grid and even curvature per segment;
  settles within 5 s; no `split`; INV-6 holds.
- **Time:** 10 s.
- **View:** side-on camera at limb height, fibres coloured, the two analytic
  sag curves drawn as thin lines.

### FM-02 Fibre stress matches beam theory at the root

*Why:* fibre colours and every failure decision come from `maxT` / `minC`.

- **Scenario:** as FM-01, plus a point load P at the tip (ramp 0.5 s).
- **Parameters:** as FM-01, plus P (N): must-pass 0 – 50 % of the analytic
  breaking load; explore 0 – 95 %.
- **Measured:** root `maxT`, `minC`; the analytic `M·c/I` for a solid circle
  at the root; the neutral-axis offset implied by the strain plane.
- **Pass if:** `maxT` and `|minC|` are each within 0.6 – 1.6 × `M·c/I`
  *(proposed: the model is bimodular, so tension and compression differ from
  the symmetric formula; the band brackets the exact bimodular answer)*;
  `maxT` increases monotonically with P across the sweep; no `split`.
- **Time:** 5 s.
- **View:** close-up of the root bundle, fibres coloured, stress values
  labelled.

### FM-03 A plain stem stands and settles

*Why:* loads are taken on the bent shape, so a lean feeds itself (3.2a). An
uncut stem must find a resting lean, not creep or run away.

- **Scenario:** Stem(H, D, lean), self-weight only.
- **Parameters:**

  | Parameter | Must-pass | Explore |
  |---|---|---|
  | H (m) | 4 – 20 | 2 – 35 |
  | D (m) | 0.2 – 0.8 | 0.05 – 1.5 |
  | H / D (derived, must hold) | 15 – 60 | 5 – 200 |
  | lean (°) | 0 – 10 | 0 – 30 |
  | `SEG_LEN` (m) | 0.3 – 1.0 | 0.15 – 2 |
  | `FLEX_FREQ`, `FLEX_DAMP` | defaults ± 50 % | menu range |
  | `TENS_STRAIN`, `COMP_STRAIN` | as FM-01 | as FM-01 |

- **Measured:** top displacement over time; extra lean at rest (top
  displacement / H); `U`; settle time; peak overshoot.
- **Pass if:** settles within 8 s; extra lean at rest < 2 % of H; peak
  overshoot < 3 × the resting displacement (the bounce is damped); no `split`;
  `U` < 0.5.
- **Time:** 15 s.
- **View:** whole stem side-on, perpendicular to the lean; trace of the top.

### FM-04 Overload: breaks at the right load, in the right order

*Why:* the switch from stiff to live (D18) must happen where the stiff
solve says the first fibre passes `MOR`, and the green-wood break must come
out of the fibres (DESIGN 3.3 table).

- **Scenario:** Limb(L, D, 0°). Tip load P ramped slowly (`Pmax` over 10 s)
  to 2 × the analytic load that brings the root to `MOR`.
- **Parameters:**

  | Parameter | Must-pass | Explore |
  |---|---|---|
  | L (m) | 1.5 – 5 | 0.5 – 10 |
  | D (m) | 0.06 – 0.25 | 0.03 – 0.5 |
  | `MOR` (MPa) | 20 – 50 | 2 – 80 |
  | `FIBRE_STRETCH` (m) | 0.01 – 0.04 | 0.002 – 0.08 |
  | `FIBRE_PITCH` (m) | 0.02 – 0.04 | 0.008 – 0.1 |

- **Measured:** load at the first live `split` (`P_live`); which side the
  first snapped fibre is on (top = tension side); the order fibres snapped in
  (distance from the neutral axis); time and droop angle between going live
  and coming free; whether it came free.
- **Pass if:** `P_live` within ± 25 % *(proposed)* of the analytic first-yield
  load; the first fibre to snap is on the tension face; fibres snap in
  order of decreasing tension-side distance (Spearman rank correlation
  > 0.8); the limb comes free before the run ends; INV-3 holds while it falls.
- **Time:** 20 s.
- **View:** close-up of the breaking bundle, fibres coloured; snapped fibres
  dark.

### FM-05 Cracked but holding

*Why:* "A limb cracks and sags but holds" (DESIGN 3.3) needs the live solver
to come to rest, not jitter.

- **Scenario:** as FM-04, but the load stops rising at k × `P_live` (k from
  the parameter list) and is then held.
- **Parameters:** k: must-pass 1.0 – 1.1; explore 1.0 – 1.5. Others as FM-04
  must-pass.
- **Measured:** droop angle; kinetic energy of the limb over time; fibres
  snapped after the load stopped rising.
- **Pass if (must-pass range):** the limb is still held at the end; its
  kinetic energy falls below 1 % of its peak within 5 s and stays there; no
  fibre snaps in the last 5 s.
- **Time:** 20 s.
- **View:** as FM-04.

---

## 3. Cuts: notches, hinges and limbs

### FM-10 A notch steers a leaning trunk away from its lean

*The owner's example.* A branchless trunk leans one way; a notch faces
another; a back cut leaves a hinge. The trunk must fall the way the notch
faces, not the way it leans, over the useful range of wood properties and
geometry.

- **Scenario:**
  1. Stem(H, D, lean, leanAz = 0°). Settle for 2 s.
  2. Notch facing azimuth `ψ = Δ` (Δ = how far the intended fall is turned
     away from the lean). Conventional notch: a flat bottom cut at height
     `h_c` and a sloping top cut at `notch angle α` above it, meeting at depth
     `d_n` (fraction of D). Applied as two plane cuts, at once.
  3. Settle for 1 s.
  4. Back cut from the opposite side, level with the notch apex plus a step
     `s`, as a progressive cut at `CUT_RATE`, stopping when the uncut strip
     (the hinge) is `t_h` thick (fraction of D).
  5. Run until the stem is on the ground and settled.
- **Parameters:**

  | Parameter | Must-pass | Explore |
  |---|---|---|
  | H (m) | 8 – 20 | 4 – 30 |
  | D (m) | 0.3 – 0.7 | 0.15 – 1.2 |
  | lean (°) | 0 – 8 | 0 – 20 |
  | Δ, notch away from lean (°) | {0, ±15, ±30} if lean ≤ 5; {0, ±15} if lean ≤ 8 | −90 – 90 |
  | notch angle α (°) | 45 – 70 | 20 – 90 |
  | notch depth `d_n` (× D) | 0.2 – 0.33 | 0.1 – 0.5 |
  | hinge `t_h` (× D) | 0.06 – 0.12, and ≥ 1 full row of fibres | 0 – 0.3 |
  | back-cut step `s` (m) | 0 – 0.03 | −0.05 – 0.1 |
  | cut height `h_c` (m) | 0.3 – 1.0 | 0.1 – 1.5 |
  | `MOR` (MPa) | 25 – 50 | 5 – 80 |
  | `COMP` (MPa) | 8 – 20 | 2 – 60 |
  | `DENSITY` (kg/m³) | 600 – 1000 | 200 – 1400 |
  | `TENS_STRAIN` | 0.004 – 0.01 | 0.0005 – 0.05 |
  | `COMP_STRAIN` | 0.006 – 0.015 | 0.0005 – 0.05 |
  | `FIBRE_STRETCH` (m) | 0.015 – 0.04 | 0.002 – 0.08 |
  | `FIBRE_SLIP` (m) | 0.02 – 0.05 | 0.005 – 0.1 |
  | `BEND_MAX` (rad) | 1.2 – 2.0 | 0.2 – 3.1 |
  | `FIBRE_PITCH` (m) | 0.02 – 0.04 | 0.008 – 0.1 |
  | `SEG_LEN` (m) | 0.4 – 1.0 | 0.15 – 2 |

  Seeds: not used (no generator); the must-pass box is sampled as in 1.1
  with 48 interior points instead of 16, because this is the test the game
  is built around.

- **Measured:**
  - fall heading and its error from the notch, `e = heading − ψ`;
  - how far the fall was turned from the lean (`heading − leanAz`);
  - time from back-cut start to first live `split`, and from that to the last
    hinge fibre letting go (**hinge life**);
  - trunk rotation (from vertical) at the moment the last hinge fibre let go
    (**hinge-release angle**);
  - whether the notch closed before the hinge released (any severed notch
    fibre in contact, DESIGN 3.3);
  - butt displacement from the stump when settled (kick-back);
  - hinge fibres at the start (count), snapped, and still intact at the end;
  - peak `U` on the stump while the hinge holds;
  - step cost during the fall.
- **Pass if:**
  - the stem came free and lies on the ground: top height < 1.5 m, settled;
  - `|e| ≤ 15°` *(proposed)*;
  - when Δ ≠ 0: the heading is turned from the lean by at least `|Δ| − 15°`
    on the notch's side (the hinge, not the lean, chose the direction);
  - hinge life ≥ 0.5 s and hinge-release angle ≥ 10° (the hinge actually
    steered, rather than snapping at once);
  - butt displacement from the stump ≤ 1.5 m towards the notch, ≤ 0.5 m
    back over the stump;
  - INV-3 holds throughout (nothing launched);
  - step cost p95 ≤ 4 ms *(proposed)*.
- **Time:** back cut takes what it takes at `CUT_RATE`; then 25 s.
- **View:** two cameras: one looking down the intended fall line with the
  notch, lean and actual heading drawn as ground arrows; one close-up on the
  hinge, fibres coloured, with the hinge-fibre count on screen.

### FM-11 No notch: the trunk goes with its lean

*Why:* the control for FM-10. If this also falls towards the "notch", the
notch is not what steers.

- **Scenario:** as FM-10 with no notch. Straight back cut, level, as a
  progressive cut from the side opposite the lean, to leave `t_h` × D.
- **Parameters:** lean 4 – 10° must-pass (2 – 20° explore); `t_h` 0.06 – 0.12;
  wood parameters as FM-10 must-pass.
- **Measured:** fall heading relative to the lean; hinge life.
- **Pass if:** comes free; `|heading − leanAz| ≤ 25°`.
- **Time:** as FM-10.

### FM-12 Cutting into the lean pinches and the tree stands

*Why:* DESIGN 4.4 and D13: a kerf on the compression side closes, carries
load, and clamps the bar.

- **Scenario:** Stem(H, D, lean). A level progressive cut entering from the
  side the tree leans towards (the compression side), to depth `d`.
- **Parameters:** lean 4 – 10°; `d` 0.2 – 0.5 × D must-pass (0.1 – 0.8
  explore); `COMP`, `COMP_STRAIN`, `KERF_CONTACT` as FM-10 must-pass and menu
  range explore.
- **Measured:** `f.closed` on the cut bundle; compression carried by severed
  fibres (the pinch force the saw would see); `U`; any `split`.
- **Pass if (must-pass):** the kerf is reported closed; the pinch force
  exceeds `PINCH_STUCK` before `d` reaches 0.5 × D; no `split`; settles.
- **Explore records** the depth at which the stem first goes live, for each
  lean: the "how far into the lean can you cut" curve.
- **Time:** cut duration + 10 s.

### FM-13 A thicker hinge holds longer (monotonic)

*Why:* "A thick hinge breaks early, a thin one folds far" (DESIGN 3.3). A
trend test: it catches regressions that move every number but keep each one
inside its band.

- **Scenario:** FM-10 at its default point (H 11, D 0.5, lean 5°, Δ 0,
  α 55°, `d_n` 0.25) with `t_h` stepped through {1, 2, 3, 4} rows of fibres.
- **Parameters:** `FIBRE_STRETCH` and `FIBRE_PITCH` at three values each
  across FM-10's must-pass range (9 sweeps of 4 runs).
- **Measured:** hinge-release angle and hinge life per `t_h`.
- **Pass if:** in every sweep, hinge-release angle decreases as the hinge
  thickens (thin folds far), and the 1-row hinge reaches at least 20°.
- **Time:** as FM-10.

### FM-14 Top cut only: the limb hangs on a strap

*Why:* "A top-cut limb swings down on a strap" (DESIGN 3.3), and the
underside fibres must act as a hinge that nothing closes on.

- **Scenario:** Limb(L, D, angle). A level plane cut from the top, at `x` m
  from the limb's base, leaving the bottom `t` × D uncut.
- **Parameters:** L 2 – 5 m; D 0.08 – 0.25 m; angle 0 – 30°; `t` 0.1 – 0.3
  must-pass (0 – 0.6 explore); wood as FM-04.
- **Measured:** time from the cut to the first live `split`; peak droop
  angle; whether and when it came free; fibres torn (snapped) vs sawn.
- **Pass if:** the limb goes live; it swings below horizontal (droop
  ≥ 45° + angle) while still held; the strap holds for at least 1 s after
  reaching that droop.
- **Time:** 15 s.

### FM-15 Undercut then top cut: a clean part

*Why:* the counterpart to FM-14; the arborist's way of avoiding a tear.

- **Scenario:** Limb(L, D, angle). An undercut from below to `u` × D, then a
  top cut 0.05 m further out, through to meet it.
- **Parameters:** as FM-14, `u` 0.2 – 0.35.
- **Measured:** fibres torn vs sawn; time the limb stayed held after the top
  cut completed; whether bark/fibres were stripped beyond the cuts (any
  snapped fibre on a segment other than the cut one).
- **Pass if:** the limb comes free within 0.5 s of the top cut; torn fibres
  ≤ 10 % of the bundle; no fibre snaps on any other segment.
- **Time:** 10 s.

### FM-16 Straight through: free, no launch

- **Scenario:** Stem(H, D, lean). A single level plane cut through every
  fibre at once at `h_c`.
- **Parameters:** H 4 – 20, D 0.2 – 0.8, lean 0 – 10°.
- **Pass if:** one clean (not live) `split`; the stem falls (top < 1.5 m at
  the end) and, if lean ≥ 3°, within 30° of the lean; butt slides ≤ 2 m;
  INV-3 holds.
- **Time:** 20 s.

---

## 4. Solver robustness

### FM-20 Results do not depend on the discretisation

*Why:* `SEG_LEN` and `FIBRE_PITCH` are resolution knobs (D23, D37, D38). A
coarser or finer tree should behave the same within reason.

- **Scenario:** FM-10 at its default point, and FM-04 at its default point,
  each run at every combination of `SEG_LEN` {0.3, 0.5, 0.8} and
  `FIBRE_PITCH` {0.02, 0.03, 0.04}.
- **Measured:** FM-10 fall heading and hinge-release angle; FM-04 `P_live`.
- **Pass if:** spread (max − min) across the 9 runs: heading ≤ 10°,
  hinge-release angle ≤ 50 % of its median, `P_live` ≤ 20 % of its median
  *(all proposed)*.

### FM-21 Same input, same result

*Why:* results are only trackable if a run can be repeated.

- **Scenario:** FM-10 and FM-40 at their default points, each run twice in
  separate workers.
- **Pass if:** identical event logs (same events, same order, same ticks)
  and final body transforms equal to 1e-6 m / 1e-6 rad. If Rapier or
  floating-point order makes this impossible across workers, the fallback
  criterion is the FM-20 tolerances, and the reason goes in DECISIONS.md.

### FM-22 Step cost stays in budget

- **Scenario:** the generated tree at default settings: idle for 10 s; then
  FM-10's cuts applied to its trunk; then 20 s.
- **Measured:** `sim.step()` mean and p95, idle and during the fall; segment
  and fibre counts.
- **Pass if:** idle p95 ≤ 1 ms, falling p95 ≤ 4 ms *(proposed; measured on
  the reference machine, recorded per machine so a slow laptop does not fail
  a good commit)*.
- **Also recorded** for the boundary report: step cost against fibre count
  across all FM-40 runs.

---

## 5. Tree generation

### FM-40 A generated tree stands up

*The owner's second example.* Grow a tree from the generator settings and
leave it alone. It must stand: nothing breaks off, nothing goes live, it
settles. The main product of this test is the **explore map**: which
combinations of the "New tree" settings give trees that do not fall apart,
so the menu limits and defaults can be set from it.

- **Scenario:** `regrow()` with the parameters below, no players, no rope.
  Run 30 s.
- **Parameters:** (the "New tree" and "Wood fibres" menu rows)

  | Parameter | Default | Must-pass | Explore |
  |---|---|---|---|
  | `TREE_HEIGHT` (m) | 11 | 6 – 18 | 3 – 30 |
  | `TREE_DIAMETER` (m) | 0.54 | 0.3 – 0.8 | 0.1 – 1.5 |
  | slenderness `TREE_HEIGHT / TREE_DIAMETER` (derived) | 20 | 15 – 35 | any |
  | `BRANCH_DENSITY` | 1 | 0.5 – 1.5 | 0 – 3 |
  | `BRANCH_LENGTH` | 1 | 0.6 – 1.5 | 0.2 – 3 |
  | `FIBRE_PITCH` (m) | 0.03 | 0.02 – 0.04 | 0.008 – 0.1 |
  | `GRID_MAX` | 17 | 11 – 21 | 3 – 25 |
  | `SEG_LEN` (m) | 0.8 | 0.4 – 1.0 | 0.15 – 2 |
  | `MOR` (MPa) | 30 | 25 – 50 | 2 – 80 |
  | `DENSITY` (kg/m³) | 900 | 600 – 1000 | 200 – 1400 |
  | `TENS_STRAIN` | 0.006 | 0.004 – 0.01 | 0.0005 – 0.1 |
  | `COMP_STRAIN` | 0.009 | 0.006 – 0.015 | 0.0005 – 0.1 |
  | `TREE_SEED` | 7 | 1 – 20 (all 20, not 3) | 1 – 200 |

  Explore: N = 2000 points, plus an `axis` sweep on every parameter.

- **Measured, per run:**
  - **grade** (the headline result):
    - `stable` — no `split` of any kind, settled by 10 s;
    - `sheds` — only pieces under `DEBRIS_MASS` came off;
    - `limb loss` — a piece over `DEBRIS_MASS` came off, but less than 25 %
      of the tree's mass;
    - `collapse` — 25 % or more of the mass came off, or the trunk went live;
    - `invalid` — an invariant broke (always a failure);
  - time to the first `split`, and the segment where it happened (trunk /
    limb / twig, depth from the root, its diameter);
  - worst utilisation `U` at 10 s and where it is (the margin a stable tree
    has left);
  - largest limb-tip sag as a fraction of limb length;
  - segment count, fibre count, whether `SEG_CAP` was hit;
  - step cost;
  - generator outputs: actual lean, number of limbs.
- **Pass if (must-pass range):** grade `stable` for all 20 seeds; `U` < 0.7
  at 10 s *(proposed: a tree must have room for a climber)*; `SEG_CAP` not
  hit.
- **Time:** 30 s (stops early once `collapse` or `invalid`).
- **View:** whole tree, fibres coloured by load, the first segment to go
  live highlighted; when picked from the explore map, the view regrows that
  exact tree.

### FM-41 A generated tree can be climbed

*Why:* a tree that only just carries itself is useless in play. Measures the
margin FM-40's `U` hints at.

- **Scenario:** each FM-40 must-pass tree that graded `stable`. A point load
  of `P_MASS · g · CLIMB_BOUNCE` placed in turn at 2/3 of the length of every
  limb, 3 s each, then removed.
- **Measured:** for each limb, `U` under the load and whether it went live.
- **Pass if:** no limb with a base diameter ≥ 0.12 m goes live; the fraction
  of thinner limbs that go live is recorded, not judged (that is the climbing
  risk D15 wants).
- **Time:** 3 s per limb.

### FM-42 Generator output is well formed

Cheap static checks on every FM-40 tree, before simulating:

- parents come before children, every `parent` exists, exactly one root;
- every `r0, r1 > 0`, every segment longer than 5 cm;
- `N` odd, `3 ≤ N ≤ GRID_MAX`, and equal to `gridFor(r0)`;
- segment count ≤ `SEG_CAP` plus one limb's worth;
- the same seed and settings give the same segments (deep equal).

---

## 6. What the runner reports

Per run, one record (JSON):

```
{ test: "FM-10", run: <uuid>, commit: <git sha or "local">, machine: <ua + cores>,
  params: {...}, cfg: {...full CFG...}, seed,
  verdict: "pass" | "fail" | "explore" | "invalid",
  failed: ["e <= 15deg", ...],          // which criteria, by their text
  metrics: {...},                        // every "Measured" value
  simTime, wallTime, ticks, stepMs: {mean, p95},
  breach: null | {inv: "INV-3", tick, detail} }
```

Per test, a summary: pass count / total over the must-pass box, worst
margin per criterion, and the change since the previous recorded run of
the same test (better / same / worse).

**Boundary report** (from explore runs, mainly FM-10 and FM-40): for each
parameter, the widest interval around its default where ≥ 95 % of runs pass
(or grade `stable`), holding the others at default; and two-parameter maps
(height × diameter, branch density × branch length, `MOR` × `DENSITY`,
lean × Δ for FM-10). These are what the must-pass ranges and the Tab-menu
slider limits should be updated from.

---

## 7. Runner notes (for later; not part of this approval)

Things the implementation will have to deal with, found while writing this:

- **`CFG` is one shared module object** and the sim reads it live. Runs with
  different parameters cannot share a JavaScript context, so each concurrent
  run needs its own Web Worker (its own module instance and Rapier world).
  The sim has no view dependency, so it can run in a worker as-is.
- **`Sim` grows the default tree in its constructor.** Scenario tests need to
  start from their own `tree` event: `reset` then `tree` works today without
  code changes; a constructor option to skip the first grow would be cleaner.
- **Players and rope** are created by the sim; test runs simply add no
  players.
- **Concurrency:** start with `navigator.hardwareConcurrency − 1` workers,
  and adjust from measured sim speed (simulated seconds per wall second) and
  the main thread's frame time: add a worker while total throughput rises
  and frames stay under ~20 ms, drop one when it does not.
- **Graphical view of one run:** the selected run's event log plus its
  transforms (a snapshot stream, as clients already receive) are enough for
  the existing `View` to replay it on the main thread, with the test's camera
  and overlays. Alternatively, re-run that one case on the main thread with
  the view attached; FM-21 says whether the two agree.
- **Trackable results:** keep records in IndexedDB keyed by test, commit and
  run, with export/import as a JSON file, so runs from different machines
  and sessions can be compared. A URL such as `?test=FM-10` running headless
  and printing JSON to the console would let a script (or Claude, in a
  headless browser) run the suite without the menu.
