# Fibre mechanics test manifest

**Status: implemented** (`src/test/`, the Testing button on the main menu).
Every test below runs; section 8 lists where the implementation had to pin
down something this manifest left open. Tolerances marked *(proposed)* are
still first guesses, to be tuned against the first real runs.

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
- **One fell per run (owner, 2026-11-23).** A run builds one world and does
  one thing to it, so what the viewer shows is the whole test. A variant (a
  direction, a depth) is a parameter, not a loop inside the run. Only tests
  that compare runs keep several worlds in a batch: FM-05 (finds `P_live`,
  then holds a fresh limb at k · `P_live`), FM-13 (hinge rows 1 – 4), FM-20
  (resolutions) and FM-21 (the same run twice). Each declares its runs as
  `steps`, and the viewer shows one step at a time. A test that needs
  another scenario checked names it in `dependsOn` instead, and running it
  runs that test too (FM-19 depends on FM-10).
- **Viewer sliders (owner, 2026-11-23).** The viewer's Params panel has a
  slider for every parameter and every step. Each track is coloured by the
  stored run nearest to that point: green passed, red failed, darker when
  the nearest run is some way off, grey where nothing has run. Letting go
  of a slider restarts the run there. For a comparison test, the checks
  across runs come from the latest batch and are listed under the sliders.

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
- **Pass if:** `maxT` and `|minC|` are each within 0.6 – 1.6 × the
  bimodular section's answer (owner's decision: tension and compression
  stiffness differ, so the symmetric `M·c/I` is the wrong reference);
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
  - step cost p95 ≤ 4 ms *(proposed)*;
  - no lengthwise split (an ordinary fell must not barber-chair; FM-19
    depends on this).
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

*Why:* DESIGN 4.4, D13 and D51: a kerf on the compression side closes, carries
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
  fibre at once at `h_c`. Half a second later a level push at the top, the
  way it leans, ramping by 2 % of the stem's weight per second until it has
  tilted 10° past its lean (owner's decision: a stem balanced on its stump
  gets a small push; one that overhangs needs none).
- **Parameters:** H 4 – 20, D 0.2 – 0.8, lean 0 – 10°.
- **Pass if:** one clean (not live) `split`; the stem falls (top < 1.5 m at
  the end) and, if lean ≥ 3°, within 30° of the lean; butt slides ≤ 2 m;
  INV-3 holds.
- **Time:** 20 s.

### FM-17 Straight stem, level cut: it stands

*Why (owner, 2026-11-23):* with nothing off-centre, nothing should tip it.

- **Scenario:** Stem(H, D, 0°). One level cut through every fibre at 0.5 m.
- **Parameters:** H 4 – 20, D 0.2 – 0.8.
- **Pass if:** one clean split; the top stays above 0.95 H and drifts
  less than 0.1 m over 20 s.

### FM-18 Straight stem, notch only: it leans into the notch

*Why (owner, 2026-11-23):* wood above a notch sits off-centre on what is
left, so the stem must lean the notch's way before anything lets go. Checks
that a partly cut bundle carries the weight of the wood above at that
wood's own centre of gravity.

- **Scenario:** Stem(H, D, 0°). A notch (upper face at `alpha`) at 0.5 m,
  deepened by 5 % of D every second until the stem goes live. One fell per
  run (owner, 2026-11-23); the direction the notch faces is a parameter.
- **Parameters:** H 4 – 20, D 0.2 – 0.8, alpha 45 – 70°, notch facing
  psi ∈ {0°, 90°, 180°, 270°}.
- **Measured:** the top's sideways movement just before release, its
  heading, the depth at release, the fall heading.
- **Pass if:** the top has moved more than 1 mm before release, within 30°
  of the way the notch faces.

### FM-19 Barber chair: a hard lean back-cut without a proper notch splits

*Why (owner, 2026-11-23):* a hard-leaning trunk back-cut without a proper
notch splits up the stem ahead of the saw. The engine has no barber-chair
rule: wood splits along the grain wherever severed fibres leave more shear
across a lengthwise plane than the wood can carry (DECISIONS D50), so this
test checks the general mechanism on its best-known case.

- **Scenario:** Stem(H, D, lean toward +x). A shallow notch (depth `dn`;
  none when 0) facing the lean at 0.5 m, then FM-10's back cut fed in from
  behind, level with the notch floor. One fell per run.
- **Depends on:** FM-10, which checks that an ordinary fell does not split.
  Running FM-19 from the menu runs FM-10 with it.
- **Parameters:** lean 15 – 25°, dn 0.05 – 0.12 D, H 12 – 20, D 0.4 – 0.7.
- **Measured:** lengthwise splits, how high above the cut the highest one
  reaches, how far the back cut had got when the first came.
- **Pass if:** the stem splits lengthwise at least 1 m above the cut, before
  the back cut is finished.

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

### FM-23 A felled trunk does not pass through its stump

*Why (owner, 2026-11-23):* a felled trunk was seen sinking through its stump.
Where they were joined the colliders overlap a little after the hinge lets
go (colliders know nothing of the notch); the two pieces may come apart
through that overlap, but never sink further in.

- **Scenario:** FM-10's fell. Each tick, the deepest overlap between any
  free piece and the rooted wood.
- **Parameters:** lean 0 – 8°, D 0.3 – 0.7, hc 0.3 – 1.0, dn 0.2 – 0.33 D.
- **Pass if:** once free, the trunk never sits more than 2 cm deeper in the
  stump than it was the moment it came free. Runs where the trunk never
  comes free are skipped (FM-10 covers that).
- **Measured on 2026-11-23:** 5 / 21 before the fix (36 cm deep at FM-10's
  default point), 21 / 21 after it.

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

## 5b. Machines

### FM-50 Grapple loader: drive up, grab a round, put it in the truck

*Why (owner, 2026-11-28):* they had not managed to grab a log in play. This
drives the loader the way a player does, with every control going through
the player's input (`players.setInput`, button presses as counters), as a
client's would.

- **Scenario:** flat ground. The loader at the origin facing +x, the log
  truck ahead and to its left (`'loader'` event), a round lying 6.5 m ahead
  and 0.8 m to the right, turned from square to the loader. A player behind
  the loader looks at it and presses {interact} (gets on). Stick and
  throttle only: turn toward the round and drive at half throttle until the
  prompt offers "grab and lift"; press {interact}; wait for the arms to be
  up; drive to a spot in front of the truck's side, turn to face it, drive
  in at 0.4 until stopped for 0.5 s; press {interact} (let go and lower).
  The held round's free-fall height (INV-3) is taken from where the claw
  let it go.
- **Parameters:** radius 0.3 – 0.55 m, length 0.8 – 1.6 m, turned 0 – 40°.
- **Pass if:** got on; the prompt offered the round and the press took it;
  it went up overhead (centre of mass ≥ 2 m); let go over the truck, it was
  hauled away.
- **Measured on 2026-11-28:** 25 / 25 (667 kg at the default point). Before
  the D137 fix the turned rounds broke INV-3 while the claw squared them up.

### FM-51 Grapple loader: rip out a stump and put it in the truck

*Why (owner, 2026-11-28, D139):* a short stump comes out roots and all and
goes on the truck.

- **Scenario:** as FM-50, with a rooted stump (one upright segment, no
  roots) standing 6.5 m ahead and 0.8 m to the right in place of the round.
  Drive up until the prompt offers "rip out the stump", press, drive to the
  truck, let go. While wood is held INV-3 takes its free-fall height from
  the claw (it moves at about 2 m/s, not falling).
- **Parameters:** radius 0.12 – 0.6 m, height 0.1 – 1.2 m.
- **Pass if:** got on; the prompt offered the stump and the press took it
  out (no longer fixed); it went up (top ≥ 1.6 m); it was hauled; one dirt
  patch.
- **Measured on 2026-11-28:** 21 / 21 must points. In game on the felled
  `?solo` job oak (cut at 0.6 m): a 1 862 kg stump came out with its roots.

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

## 7. Runner notes (written before the runner; section 8 says what was built)

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

---

## 8. Implementation notes

Where the code is: `src/test/harness.js` (one run: building blocks of 1.4,
the invariants of 1.2, the measurements of 1.3), `tests.js` (every test as
data + a scenario), `sampling.js` (1.1), `runcase.js` (one record, section 6),
`worker.js` + `pool.js` (parallel runs), `store.js` (IndexedDB, JSON
export/import), `report.js` (summaries, boundary report), `ui.js` (the menu
and the graphical view).

**Running.** Main menu → Testing. Pick tests and a mode, Run selected. Modes:

| Mode | Runs |
|---|---|
| Smoke | the default point (or the box centre), first seed only: a quick "does it still work" |
| Must-pass | the box of 1.1, judged; a failure is a regression |
| Explore | N Latin-hypercube points over the explore box (the box beside the mode sets N), recorded with `wouldPass`, feeding the boundary report |
| Axis sweep | 1.1's bisection per parameter; stores the passing interval around the default |

Click a test for its latest batch: failures per criterion with the worst
margin, every run (failures first) with a **View** button that re-runs that
exact case on the main thread with the game's renderer (speed ¼× – max,
pause, drag to orbit). Results stay in the browser (IndexedDB) and can be
exported/imported as JSON. "better / same / worse than before" compares the
pass rate with the previous batch of the same test and mode.

**Headless.** `?test=FM-10,FM-40` (or `?test=all`) with `&mode=smoke|must|explore|sweep`,
optional `&n=`, `&workers=` (fixed count instead of adaptive) and
`&commit=<sha>` (stored in each record; a static page cannot read git).
Prints `ARBTEST {record}` per run and `ARBTEST-DONE {summary}` at the end;
`window.arbTests` holds the same. Records printed to the console leave out
`cfg` (it is in the stored copy).

**Workers.** Each worker has its own module instance, so its own `CFG`;
every run starts from `CFG_DEFAULTS` (config.js as shipped, not the Tab
menu's saved values) plus the run's parameters. The pool starts at
`hardwareConcurrency − 1` workers and every 4 s moves the count up or down by
one, reversing when simulated-seconds-per-second fell, and stepping down
while the page's frames are slower than 20 ms. Workers cannot see the import
map, so `src/sim/` imports three and Rapier by relative path (D41).

**Choices the manifest left open:**

- **Limb (1.4):** the stub stands on a rooted base at height `L + 1 m`, so a
  limb can hang straight down without reaching the ground (FM-14 needs it to
  droop past 45°). The analytic sag in FM-01 includes the stub's own bending.
- **Point loads on live wood** fade with the speed of the loaded point (0 at
  2 m/s), as a climber's weight does, and is capped at what would accelerate
  the point it acts on at 2 g by itself (the piece's effective mass there,
  rotation included: a load near the tip of a light limb also spins it): a force cannot be allowed to drive wood past
  free fall (one tick of FM-04's 2x load on a freshly live limb launched it
  at hundreds of m/s), or INV-3 would catch the test, not the engine. The
  cost: once live, a limb feels less than the full load, so "comes free" in
  FM-04 and the held load in FM-05 are weaker than a real hanging weight.
- **Viewer:** re-runs the case on the main thread with the view attached.
  It works on a phone: one finger orbits, a pinch dollies the camera
  forward or back (the camera moves, the lens does not zoom; once it reaches
  the target it carries the target ahead), two fingers pan, a double tap
  resets the camera to the test's view. Replay starts the run again and
  keeps the camera where you put it; "‹ Tests" or the phone's back gesture
  returns to the list. `?view=FM-10` opens a test's default point directly.
- **FM-04 / FM-05 load** is a real hanging weight once the limb goes live:
  a point mass of P / g on a ball joint at the tip (still ramping with P),
  released when the limb comes free. The capped force before it faded as
  the limb moved, so FM-04's limbs hung and never tore off. FM-22 runs last,
  alone, so other workers do not inflate its timings.
- **Cuts** go through the saw's own `sever()`. Fibres within
  `max(2 r, 0.15 m)` of a live joint's plane are that joint's fibres (cut with
  `cutLive`), the same distance `sever()` uses to keep one cut plane.
- **"Analytic" loads** (FM-02, FM-04) use the exact bimodular section
  (`analytic.js`), integrated independently of the fibre grid; FM-02's band is
  still against the symmetric `M·c/I`, as written, and also records the
  bimodular prediction.
- **FM-02** steps the load through 20 / 40 / 60 / 80 / 100 % of P within one
  run (1 s each) to judge "monotonic".
- **FM-05** finds `P_live` with an FM-04 run, then repeats the ramp in a
  fresh world, holding at `k · P_live`. Kinetic energy uses `m (L/2)²` for the
  rotational inertia.
- **FM-10:** "settled" is its own criterion, separate from "lies on the
  ground", so a rolling log does not hide where it fell. "Notch closed" means
  a severed *notch* fibre bearing in compression in the live joint (back-cut
  kerf contact is recorded separately as `kerfContact`). The hinge is
  `max(t_h · D, one fibre pitch)` thick across the notch apex.
- **FM-12:** the stem is FM-10's default (H 11 m, D 0.5 m), cut at 0.5 m.
  `KERF_CONTACT` ranges 0.3 – 0.7 (explore 0.05 – 1).
- **FM-13** is a grid test: the 9 combinations of the listed values, each
  running FM-10's default four times (1 – 4 rows of hinge).
- **FM-14 / FM-15:** cut at `min(0.4 m, L/3)` from the limb's base. FM-15's
  undercut is made at once and the top cut progressively, 5 cm further out.
- **FM-21** runs each scenario twice, each time in a fresh `World` and Rapier
  world, one after the other in the same worker (a worker's module state is
  only caches and scratch that is rewritten before use).
- **FM-22** cuts the generated tree's root segment (generated trunks are
  not straight, so FM-10's cuts are placed on that one segment), notch
  towards the trunk's lean.
- **FM-40:** a tree with no split that has not settled by 10 s is graded
  `restless` (not `stable`). Trunk segments are the generator's first
  `round(TREE_HEIGHT / SEG_LEN)` segments. `GRID_MAX` samples are rounded to
  odd numbers. Slenderness is enforced by clamping the diameter.
- **FM-41** loads each limb (a chain that starts on the trunk) at 2/3 of its
  length for 3 s, then waits 1 s before the next.
