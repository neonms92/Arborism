# Decisions

Calls that could have gone either way. Newest at the bottom. Add to this file
instead of silently changing direction.

**D1 — Keep Three.js + Rapier.** No clearly better free option. Babylon
bundles a heavier engine for no gain; Jolt's WASM port is larger and its
strength (many-body joints) is something we deliberately avoid (D2).

**D2 — The tree is one rigid body with analytic stress, not jointed bodies.**
Jointed segments would give visible flex for free, but cost hundreds of
bodies, solver jitter, and Rapier's JS API gives no reliable joint reaction
forces to break on. Analytic beam bending gives real numbers (MPa) per
section, is O(n), and is trivially explainable to the player through the
stress overlay. Cost: no physical flex. Cosmetic sway can be added in the
view from the utilisation value later.

**D3 — Clients do not simulate or predict.** The host moves everyone. Only
camera look is local. Cuts the netcode to "events + transforms" and removes
every desync class. Cost: a client's own movement lags by their ping.
Acceptable for a slow, deliberate game between friends; revisit (P2-9) only
if Deck testing says otherwise.

**D4 — Overload breaks and saw cuts share one section model.** A fibre-cell
grid per cross-section with tear / hinge / free rules. More work up front
than "if stress > limit, detach", but it is what makes notches, hinges,
pinching, peel-outs and green-wood breaks fall out of one mechanism instead
of seven scripted ones.

**D5 — Ropes are tension paths, not particle chains.** Pulleys and capstan
friction are exact and cheap in a path model and miserable in a particle
model. Cost: spans are straight and pass through branches. Accepted for the
demo.

**D6 — The lanyard is rules, not physics.** A flag plus "cannot pass a
union, needed for the saw, you ride what you are tied to". A simulated
flip-line around a trunk would be a large effort for little added drama.

**D7 — Libraries are vendored in the repo (≈6 MB).** No CDN dependency at
runtime, works offline/LAN, versions pinned by construction. Cost: repo
size. Update by re-copying from npm (see CLAUDE.md).

**D8 — Button presses travel as counters on the unreliable channel** rather
than as reliable commands. One channel for all input, no ordering questions,
loss-proof.

**D9 — Snapshots are hand-rolled binary; everything else is JSON.**
Transforms are the only high-rate data. JSON elsewhere keeps the protocol
readable for the next model.

**D10 — GitHub Pages serves the repo root from a branch, no Actions
workflow.** There is no build, so "deploy" is "push". `.nojekyll` stops
Jekyll from touching files. Pages has to be switched on once in repo
settings (see CLAUDE.md) — that cannot be done from code.

**D11 — PeerJS public signaling is assumed, not verified.** The development
sandbox blocks `0.peerjs.com`, so it could not be checked. Networking was
tested against a local `peerjs` server through the same code path
(`?signal=`). If the public server proves unreliable, the cheapest free
replacement is a Cloudflare Worker running PeerServer-compatible signaling;
that would need the owner's account, so it is not done here.

**D12 — The vendored PeerJS has a one-line patch.** PeerJS maps
`reliable:false` to `{ordered:false}`, which still retransmits; it offers no
way to request a lossy channel. `vendor/peerjs/peerjs.min.js` is patched so
`reliable:false` creates the channel with `{ordered:false, maxRetransmits:0}`.
Stale snapshots must be dropped, not queued. Re-apply the patch if PeerJS is
ever updated (the `sed` line is in CLAUDE.md).

**D13 — Kerfs close only when the wood beside them crushes.** (Extended by D51.) First version
let every closed kerf share compression elastically; that pinched every cut
on a big trunk just from the tree's weight. A real kerf is an 8 mm gap and
elastic strain is microns. Now the intact wood carries everything until it
passes `COMP`; only then do kerfs carry load and clamp the bar. Matches what
sawyers see (undercuts pinch past a third; back-leaners sit back late).

**D14 — Hinge resistance is tied to the moment that formed the hinge.**
A cap based only on strip dimensions could equal the driving moment and
leave a tree frozen on its hinge. Capping at half the driving moment means
a hinge always commits, slowly at first.

**D15 — Game `MOR` is 30 MPa, not clear-wood 50.** With real strength a
climber cannot break anything they can stand on, which is true to life but
leaves the climbing with no teeth. 30 MPa plus a bounce factor while moving
(`CLIMB_BOUNCE`) makes the last metre of a limb genuinely risky without
making big wood fragile.

**D16 — The demo tree leans 6–8°.** A balanced tree cannot be felled without
wedges or a pull line, neither of which exists yet. The lean gives felling a
right and a wrong direction today.

## Rework requested by the owner (fibres, saw, lanyard, first person)

**D17 — Wood is fibres from the first tick; D2 and D4 are superseded.**
The owner asked for fibre-based loading everywhere instead of discrete
attached / hinged / free states. Every segment now carries a fibre bundle.
The Rapier revolute "hinge" and its closing-angle and tear rules are gone.

**D18 — Stiff until a fibre yields, then live.** A tree that is per-fibre
springs everywhere, all the time, would need ~60 coupled stiff bodies; that
is the jitter D2 was avoiding. But parallel elastic fibres between rigid
faces have an exact static answer (the stress plane), so an intact bundle is
solved statically, and only a bundle with a fibre past its elastic limit
becomes a pair of bodies joined by individual fibre springs. Same fibres,
same numbers, two solvers. The switch happens once per bundle and is not a
behaviour change the player can see.

**D19 — Live bundles are solved implicitly with an active set.** First
attempt applied capped (plastic) fibre forces for a whole tick and kicked
pieces away; second let pre-existing penetration at kerf faces spring back
and launched a felled trunk. Fixes that are now load-bearing: (a) solve the
6-DOF system assuming fibres are in range, clamp, re-solve; (b) a fibre found
beyond its elastic range takes a permanent set *before* the solve; (c) wood
pushed into wood crushes to fit and only resists further closing. Do not
remove these without re-running a notch-and-back-cut fell.

**D20 — Fibres are elastic-plastic, not brittle.** Brittle fibres (snap at
MOR) make every hinge fail after ~2° because the real mechanism — fibres
bending and pulling out over a long length — is below the model's scale. A
plastic plateau with a stretch limit (`FIBRE_STRETCH`) reproduces it: thin
strips fold far, thick ones break early.

**D21 — The saw is a free rod; a cut has no parameters.** The owner asked
for mouse-swung, moveable cutting and per-fibre severing. The old kerf
(`phi, tilt, z0, depth`) is gone; fibres record where they were cut. The bar
is a rod, not a plate: it cuts in whatever direction it is pushed. A real
bar only cuts in its own plane; enforcing that would need a roll control and
was judged not worth a button yet.

**D22 — Raised saw is level and straight ahead by default,** regardless of
where the player is looking; looking up/down before raising sets its height.
Level cuts are the common case and should need no adjustment. The swing
angles reset when the saw is lowered.

**D23 — One grid of fibres per ~3 cm, capped at 17 across.** Fine enough
that a hinge on the trunk is 1–3 fibres thick; coarse enough that a limb is
5–7 across. `FIBRE_PITCH` / `GRID_MAX` trade resolution for cost.

**D24 — Cuts more than a diameter apart divide the segment.** One bundle
per segment means all its cuts would otherwise act in one plane. `divide`
gives each cut plane its own bundle.

**D25 — Lanyard: always on while climbing; interact re-throws it.** As
specified by the owner. Union blocking is kept (it is what makes re-throwing
necessary). The lanyard may only be thrown to rooted wood.

**D26 — The cross-section HUD diagram was removed.** The 3-D fibre view
shows the same information in place. Colours follow the owner's spec: red
compression, blue tension, green bending (the old diagram had red/blue the
other way round).

**D27 — Inverted vertical look is the default** (`INVERT_Y`), and applies to
swinging the saw too. There is no settings screen yet; it is a config flag.

**D28 — Prompts carry `{tokens}`, not key names.** The host does not know
what device each client is holding. Each client's HUD substitutes the name
for the device it last saw input from.

**D29 — Kickoff branch was renamed to `main` on GitHub.** Later pushes to
the session branch `ccr-7d8cc9c2-99719w` recreated it as a separate branch.
It needs merging into `main` (or Pages pointing at it) to go live.

## Second round of owner feedback (saw handling, menu, bark)

**D30 — The saw plants, pivots and presses; D21's free rod and D22 are
superseded.** As specified by the owner. Choices made inside that:
the bar plants *across* the stem with the feed pointing at its heart (a
square cut is the default from any stance); the planted point is the middle
of the bar's leading edge; left/right pivots in the plane of the cut and
up/down tilts that plane (so a notch's sloping cut is "plant higher, tilt
down, press"); the chain runs only while pressing. The bar is still a rod
for collision purposes: it severs whatever fibres it is pushed against.

**D31 — Cutting speed is an area rate (`CUT_RATE`), not a time per fibre.**
A fixed time per fibre made oblique cuts (one fibre touched at a time)
crawl and square cuts (a whole row at once) fly. Sharing a fixed
cross-section per second between the fibres under the bar makes cutting
time proportional to wood removed, whatever the angle.

**D32 — Bark is generated from the fibres.** Asked how bark could show cut
damage: any bark mesh that is authored separately will drift from the
fibres. So each bark panel is owned by the outermost fibre behind it and is
drawn only where that fibre still exists. Options not taken: decals (do not
show depth or missing wood), boolean-cutting a cylinder (expensive and still
a second source of truth).

**D33 — Fibre boxes were mirrored, not rotated.** The fibre instances were
built from the basis (u, axis, v), which is left-handed, so the "rotation"
extracted from it was wrong for every stem that was not near-vertical; the
physics was right and the picture was not. Now (v, axis, u). Lesson recorded
in the code: check handedness before `setFromRotationMatrix`.

**D34 — Tab is the settings menu; the fibre/bark toggle became a slider.**
Menu rows write straight into `CFG` and persist in localStorage, so there is
one place for tunables (config.js) and one line per exposed variable.

## Third round: bending

**D35 — Standing wood bends elastically; D2's "no physical flex" is over.**
The owner found fibres "too stiff, or no bending at all" — correct: until a
fibre yielded, the tree was one rigid body. Rather than make the whole tree
live (D18's reasons still hold), the stress plane each stiff bundle already
has is turned into a tilt across that bundle and accumulated along the stem
(`model/flex.js`). The stiffness is the live regime's own (`FIBRE_YIELD`),
so the two regimes agree and going live is continuous.
Costs accepted: loads are computed on the unbent shape; the bounce is a
damped spring on each joint's angle, not real inertia; a piece that has just
parted relaxes its inner bend by a fade, not by physics.

**D36 — Default `FIBRE_YIELD` raised from 1.5 mm to 4 mm.** At 1.5 mm a limb
at breaking load had moved a few centimetres. 4 mm gives a visible droop
under a climber. It also softens live bundles, which the solver likes.

## Fourth round: fibres that change length, tree settings

**D37 — Bending is now fibre strain, with separate tension and compression
deformation; D35's single springiness is superseded.** The owner asked for
each fibre to stretch or shorten against its natural length, with the disc
at a bundle's end tilting from those lengths, severed fibres having no say,
and the tilt able to cascade. Implemented as: strain plane per bundle with
each fibre's stiffness chosen by the sign of its own strain (`TENS_STRAIN`,
`COMP_STRAIN`); fibre length = segment length, so a fibre's change of length
is strain × L; tip disc placed from those lengths; loads taken on the bent
shape so tilt feeds moment. `FIBRE_YIELD` is gone; live fibres use the same
two numbers and the fibre's length, so the regimes still agree.
What was *not* done: fibres do not individually buckle or curve between
their ends; they are straight between two flat discs, and a segment's
curvature is even along it. Getting fibres to curve within a segment means
shorter segments (the "fibre segment length" slider), not a different model.

**D38 — A severed fibre is out for its whole segment.** That is the owner's
model and it is what makes "fibre segment length" meaningful: it is the
length over which a cut weakens the stem. Shorter segments localise damage
(and cost more).

**D39 — Tree settings apply on "Grow", not live.** They change the model
(segments, bundles), which only changes by events; growing is `reset` +
`tree`. Segment data carries its bundle's fibre count so clients never
depend on their own density setting. Generation is capped at `SEG_CAP`
segments, and long twigs are thickened so a tree does not break under its
own weight at extreme slider values.

## Testing

**D40 — Automated tests, in the browser, after all.** The owner asked for a
Testing menu that runs engine tests in parallel with trackable results; this
supersedes "no automated tests" for the fibre model. The tests run the real
sim headless in Web Workers (one per run, because `CFG` is a shared module
object), are defined as data in a manifest (`docs/TESTS.md`), and judge
outcomes over parameter ranges rather than single values, so they also map
where the model stops behaving. Still no build step and no Node test runner.

**D41 — Code that runs in a worker imports by relative path.** Import maps do
not apply inside Web Workers, so `src/sim/*.js` now import
`../../vendor/three/three.module.js` and `../../vendor/rapier/rapier.mjs`
directly (the same URLs the map resolves to, so the main thread still gets one
instance of each). The view keeps the bare `three` specifier.

**D42 — The engine gained three small hooks for the tests, nothing else.**
`Sim.create(world, { tree: false })` starts with no wood; `sim.onLoads(dt)` is
called each tick where point loads go in (after players, before the
structure); `fibres.analyse` keeps what it solved for in `b.load` (INV-6
checks equilibrium against it); `saw.sever` is exported so scripted cuts take
the saw's path; `config.js` exports `CFG_DEFAULTS`. Tests never write to the
model: wood comes from `tree` events, cuts from `sever()` / `cutLive()`.

**D43 — A failing test is a finding, not a reason to bend the test.** The
first runs fail in places (see STATUS.md); the manifest's criteria were
implemented as written, and where it was silent the choice is in TESTS.md
section 8. Tuning the tolerances, or the engine, is the owner's call.

**D44 — A fibre that will not settle sits on the neutral axis.** The stiff
solve in `fibres.analyse` could oscillate for ever (INV-6, 438 runs in the
first must-pass run): a fibre whose strain is ≈ 0 flips between tension and
compression stiffness, and the flip moves the section's centroid enough to
flip it back. After two changes in one solve a fibre takes the mean of the two
stiffnesses (`b.sgn = 0`) and stays there; a closed kerf fibre that keeps
toggling stays in contact. The physics is unchanged, the iteration converges.

**D45 — The live active set cannot cycle.** `structure.liveStep` could also
fail to converge: two fibres traded between their tension and compression
caps every iteration, and after the last one the impulse it applied was from
a set that was never consistent, launching an 8 kg piece at 83 m/s (INV-3).
Now a fibre goes from one cap to the other only through linear, and one that
has changed three times in a step is held in the conservative state (elastic
fibres linear, since a stiff implicit spring only dissipates; broken faces
let go); up to 12 iterations. D19's rules (a, b, c) are untouched.

**D46 — Loose wood on the ground has rolling resistance.** Rapier contacts are
points on a rigid plane, so a round felled log rolled for as long as the test
watched (FM-10 "settled" failed in most runs). Real ground gives under a log.
Each tick every awake dynamic piece touching the ground gets a torque
`ROLL_RESIST` (m) times the ground's normal force against its spin, never
more than stops it. 2 cm is a soft forest floor; 0 restores the old
behaviour. In the Tab menu.

## Fifth round: controls

**D47 — ESDF, no tools, context-aware buttons, held actions for anything that
can kill.** Owner's scheme. Movement moved to ESDF; R is interact, W is
rigging (block / tie / untie), G is punch, C is let go. Tool switching is
gone: the saw is always on the mouse buttons, and the rest is decided by what
is looked at. Spurring in / moving the lanyard and letting go of the tree are
channelled for `LANYARD_TIME` / `LETGO_TIME` (4 s each, both in the Tab menu)
so a stray press cannot drop a climber. The owner asked for C to use "the
same time" as the lanyard; it is a separate number with the same default so
either can be tuned. Grabbing or letting go of the rope tail stays an
instant R press (it cannot hurt anyone). Taking the block down stays on C on
the ground. Gamepad: Y rigging, RB punch (picked here, not by the owner).
Punch: each press adds `PUNCH_FORCE` along the look direction at the point
hit, fading with time constant `PUNCH_DECAY`; a new press adds to what is
left, capped at `PUNCH_MAX`. It goes through `sim.applyForce` like the
climber's weight, so it loads standing wood's fibres and shoves loose pieces.

**D48 — Block removal on W; R on the ground grabs wood.** Owner's answers to
D47's open points. W while looking at the hung block (within reach, 0.7 m of
it) takes it down; C no longer does anything on the ground. A press of R on
the ground grabs the wood looked at and a second press lets go. The hold is
a tension-only rope from the hands to the grabbed point (`GRAB_K`, damped
like the rigging line, stiffness capped on light pieces); past `GRAB_MAX`
the wood tears out of the hands rather than the hold acting as an anchor.
The force goes into the wood through `sim.applyForce`, and back into the
player as an impulse (which walking mostly overrides: feet win). A press
that grabs standing wood and is held on goes on into the 4 s lanyard throw,
so spurring in is still "hold R"; the press that lets go locks the throw
until R is released.

## Concrete pavers

**D49 — Pavers crack by impact energy, are flush with the ground, and are
re-laid with each tree.** The owner asked for a "tunable
threshold" on impacts from wood or a player; energy (½·m_eff·v_n² at the
contact) was picked over Δv or force because it separates a twig from a log
at the same speed and ignores wood that is only resting, and m_eff makes an
end-first landing count for less than a flat one. Above the threshold a hit
adds energy / threshold, so one unit of damage is one cracking impact.
Defaults: 800 J (a jump or a half-metre drop does nothing, 1 m is right at
the threshold, a fall from about
3 m does about 3 units), gravel at 30 units. The slabs are drawn on top of the
existing ground collider instead of being colliders of their own, so nothing
about how wood rolls or slides changes (the engine branch's rolling
resistance works on the ground collider) and there are no internal edges
between slabs to snag on. The owner picked basket weave and a
paved circle of radius half the tree height (`PAVER_RADIUS`, whole pavers
only), so a felled tree's crown lands past the paving; damage is lost when a
new tree is grown.

**D47 — Owner's calls on two test criteria.** FM-02 checks root stress
against the bimodular section, not `M·c/I`: green wood is softer in
compression, so the symmetric formula overstates compression stress (77 / 81
pass; the rest fail "rises monotonically"). FM-16 pushes a stem that sits
balanced on its stump after the cut, as a feller would: the least push that
tips it (25 / 25 pass).

**D48 — The tests hang real weights and time alone.** FM-04 / FM-05 load
the limb with a point mass on a ball joint once it is live (a capped force
faded as the limb moved and never tore it off). Honest loading makes FM-05
fail: a limb loaded just past first yield tears off instead of holding, a
finding for the fibre law. FM-22 runs after every other test, alone.

**D49 — Live fibres are bonded to their neighbours.** The owner's call after
hinges and straps would not tune. Fibres joined by an unbroken bond fold as
one strip: a fibre's fold strain is the fold angle times (half its own
thickness + its distance past the middle of its strip), so a thick strip
tears sooner than a thin one. A fibre that snaps unloads into its bonded
neighbours: if what it carried exceeds `SHEAR × pitch × BOND_LEN` the bond
splits and the crack turns along the grain; otherwise a neighbour in tension
snaps too. Stiffness is unchanged: the fibre springs between two rigid
bodies already keep plane sections plane. Measured (must-pass): FM-04
23 / 49 (with D48's weight), FM-11 68 / 81, others unchanged. What it showed:
the 3 – 4 row hinges of FM-13 never go live at all — the hinge is strong
enough to hold the stem (a 12 cm hinge on FM-10's stem has ≈ 4× the moment
the lean puts on it), which is a scenario question, not a fibre-law one.

**D50 — Wood splits along the grain, by one general rule.** The owner asked
for barber chairs without a barber-chair rule. Where some fibres of a bundle
are severed, the rest carry their share; a little way along the grain the
load has spread over the whole section again. So across any lengthwise plane
the difference has to pass as shear. Each tick, for every stiff bundle with
severed fibres, `Structure.ripCheck` compares each fibre's force with the
same load on the same section uncut. It does this over chords in 8
directions between every pair of fibre rows: τ = |Σ one side (F − F_uncut)| /
(chord length × `BOND_LEN`). Past `SHEAR`, the wood splits on the worst
chord, if one side of it is severed right across (wood held at both ends
by intact fibres can crack, but nothing moves; and in the tree a segment
has one parent). Of those chords, the crack is the one that frees the most
load. The severed side leaves the segment as a new segment that
hangs from the top end (new `rip` event). Its parent is the segment the stem
carries on into. That segment's fibres over the split-off part now end at its
base, so the next segment up can split in turn, and the crack runs up the
stem until the shear falls below strength. A fibre that left is stored as
severed over the whole length (`GONE_Z`): it carries nothing, is not drawn
and does not stop a saw. A half weighs its share, and its collider is a
thinner rod through the middle of the wood that is left. `BOND_LEN` (5 cm)
is the length the shear acts over. That is short next to the stem's
diameter, which is how the stress concentrating at a kerf's end shows up.
With `SHEAR` it decides how readily wood splits; both are in the menu.
Measured (must-pass): FM-19's default (20° lean, 0.1 D notch) splits
1.7 m up the stem with the back cut 38 % in, and FM-10's default fell
never splits. FM-19 passes 16 / 33: thin stems (D 0.4) at the lighter leans
never split, and in most other misses the crack stops under 1 m. FM-10
42 / 113, FM-11 68 / 81 and FM-18 25 / 25 are unchanged, and none of their
runs split.

The owner wants a passing barber chair to leave a lean-side slab standing on
the stump. It does not yet: the front strip left beside the split carries
the whole trunk, and it is the same section from the cut to the top of the
split, so it gives way at the cut, where the bending is largest. The trunk
then falls with the slab attached. What decides it in a real tree is how
the crack runs while the trunk is already moving; here only standing wood
can split. This is an open question for the owner.
Limits: the split runs whole segments at a time (0.8 m on the test stems), a
segment that has split is not joined again, and a half that hangs from a
live (moving) piece is not checked again because live bundles have no shear
check yet.

**D51 — A kerf also closes when the stem rotates its gap shut.** The owner
asked for cuts into the lean to pinch the bar (FM-12). Under D13 that never
happened: the wood beside the kerf has to crush first, and at FM-12's leans
it sits under a tenth of `COMP`. Now `fibres.analyse` is given the
segment's length, the same length `flex.js` bends over, and a severed fibre
touches across its kerf when the plane strain at its place shortens it by
more than its gap (`eps · L + gap < 0`). Such a face (`act` 2) pushes only
with what is left once the gap has closed (`kerfStrain`: `eps + gap / L`),
so contact starts from zero instead of jumping. The crushing rule of D13
stays as it was (`act` 1). The saw's pinch probe, the FM-12 hook and the
INV-6 equilibrium check all go through `kerfStrain`.
Measured on FM-12's stem (H 11 m, D 0.5 m): the bar now pinches when the
back cut reaches about 0.68 D at 4–10° leans (0.62 D at 15–20°, 0.74 D at
2°), before the stem goes live at about 0.79 D. Before this it never pinched.
At 0.4 D and 6° the kerf closes only 0.9 mm of its 8 mm, so FM-12's bound
of 0.5 D still fails; that bound is the owner's call. The engine's wood is
already about six times softer than real wood (`COMP / COMP_STRAIN`
≈ 1.3 GPa), so a real stem would close even less by bending alone: what
makes real kerfs close early (creep, crushing right at the notch tip) is not
modelled. FM-10 must-pass went from 41 to 39 / 113 (three softer-wood fells
at 8° lean now hold on their closed kerfs, one other now passes).

**D52 — A folded fibre bends like thin plies, and keeps its fold.** The
owner found FM-14's strap rigid. Measured on its default limb: the whole
120 N·m the limb hangs by was carried by the three strap fibres' own
bending, each treated as a solid 2.2 cm block (no axial force at all), and
that fold sprang back elastically, so the limb bounced back to 9°. Now:
(a) a fibre's own fold is as stiff and as strong as layers `FIBRE_PLY`
thick (real fibres slide on each other when a bundle folds), and its outer
fold strain is taken over the ply too; (b) the fold's plastic moment uses
tension on the outside and crushing (`COMP`) on the inside; (c) a fold past
that moment takes a permanent set, like a fibre's stretch (D20).
`FIBRE_PLY` 10 mm (menu). Must-pass, solid → 10 mm → 5 mm: FM-10
39 → 50 → 53, FM-11 69 → 61 → 56, FM-14 2 → 1 → 1, FM-15 81 → 81 → 80.
FM-14's limb now folds to about 92° (it stopped at 14° before), where
`BEND_MAX` snaps every fibre at once, so it holds ~0.3 s instead of 1 s.
The FM-11 losses are trunks left hanging on a folded hinge.

**D53 — Fibres can fold right over, and folding is damped.** The owner:
with no bottom cut the bottom fibres are free to fold completely over
(important for trunks), and folded fibres should still damp the motion.
`BEND_MAX` is now 3.14 rad (180°, was 1.6). Folding fibres now feel a drag
on their fold rate, as their plies rub: `FOLD_DAMP` (0.1 s, menu) times a
solid fibre's bending stiffness, solved implicitly with the rest of the
joint. FM-14's default limb now folds to 73° in 2.5 s and hangs there (no
damping: it swings to 99°). Must-pass: FM-14 1 → 20 / 81, FM-10 50 → 49,
FM-11 61 → 60, FM-15 80 / 81; smoke FM-04 now passes. Peeling (a strap
tearing back along the stem) is not modelled.

**D54 — Owner's FM-10 experiment: rigid compression, long stretch, jerk
breaks.** The owner watched FM-10's hinge give out by plain crushing and
stretching once thin, and asked for: wood 1000× more resistant to
compression, fibres that stretch to 1.4× their length before breaking, and
a second break when a fibre's pull doubles within 0.2 s. All tunable, in
the menu and the viewer's Tune panel:
`LIVE_COMP_X` 1000 (live fibres only: the standing strain plane is
unchanged, so kerf closing and pinch are as before), `BREAK_STRAIN` 0.4 of
the fibre's length (0 = back to `FIBRE_STRETCH`), `SURGE_RATIO` 2 within
`SURGE_TIME` 0.2 s, counted only from a pull of at least `SURGE_MIN` 0.1 of
the fibre's strength (my addition, so a fibre going from almost nothing to
a little does not count as doubling).
Must-pass with all three, and with each one left out:

| | all three | no 1000× | no 1.4× | no surge | before |
|---|---|---|---|---|---|
| FM-10 | 49 | 52 | 52 | 46 | 49 |
| FM-11 | 46 | 45 | 55 | 41 | 60 |
| FM-14 | 13 | 27 | 11 | 11 | 20 |
| FM-15 | 74 | | | | 80 |

On FM-10's default fell every hinge fibre that broke did so by the surge
rule (15, then 5 by their neighbours); none reached 40 % stretch (30 cm on
a 0.75 m fibre). 19 of 39 hinge fibres survive, so the trunk lies on the
ground still joined to its stump. Smoke: FM-10, FM-11 and FM-14 now fail,
and FM-23 skips (its trunk never comes free).

**D55 — The test viewer has a Tune panel.** The owner tunes from a phone.
Every simulation row of the Tab menu (wood first, controls left out) is a
slider plus a number box; a change restarts the run. Tunings are kept in
the browser and go into every run started from the Testing menu, viewer and
batches, as `job.cfg` (applied after the defaults, before the test's own
parameters, which win; those rows are greyed). Records keep them as
`tuned`.

**D56 — D54 retuned: old stretch, 1× compression, surge kept.** Owner
approved. Must-pass (FM-10 / FM-11 / FM-14) with `BREAK_STRAIN` 0 (back to
`FIBRE_STRETCH`) and surge 2× in 0.2 s: `LIVE_COMP_X` 1 → 52 / 64 / 20,
10 → 51 / 62 / 13, 30 → 50 / 63 / 10, so compression stays 1× (slider
kept). Surge variants at 1×: ratio 1.5 → 52 / 64 / 20, window 0.5 s →
53 / 63 / 21, both → 50 / 64 / 21, `SURGE_MIN` 0.03 → 54 / 66 / 20 (chosen).
FM-10's default fell passes again: half its hinge surviving was the 1.4×
stretch, not the surge rule. The surge rule costs FM-15 (80 → 74 at
`SURGE_MIN` 0.03, 77 at 0.1). FM-14 snaps by stretch (47 fibres over 81
runs, against 17 surge and 16 slip): the heavy limbs on thin straps tear
by stretch within a second of folding, which is where a too-small
`FIBRE_STRETCH` would show.

## Wood chipper

**D57 — The chipper is an ordinary body with modelled tyres; feeding and
the rope feed are forces, chipping is removal past the drum.** The owner
asked for a chipper that eats a grabbed limb on {interact}, takes in a rope
tied to it and then never stops reeling it ("it climbs the tree or weighs it
down; only a reset fixes it"), leaves a reasonable pile of chips, has a grip
at the non-chipping end to move it by hand, and is put back with the pavers
on a reset. Following the owner's preference for general physics: the rollers
are a capped force (`CHIP_PULL`, 15 kN, under `ROPE_BREAK`) with an equal
reaction on the chipper, so whether the tree bends or the chipper is dragged
and hoisted is decided by the bodies, not by a rule. In the first test a
600 kg chipper with the rope over a block at 4.7 m was dragged 9 m to the
trunk and lifted 2.2 m. The rope is "taken" when its knot reaches the drum,
not when its segment is chipped, because a tied-off rope would otherwise stall
the rollers before the wood it is tied to could pass the drum. The only rules
that are not physics: a fed rope cannot be cut, untied or snapped (the
owner's "only a reset"), only loose wood can be fed, and the brake is on
whenever nobody holds the grip (without it the rollers' reaction rolled the
chipper about while feeding). The tyres are modelled in `sim/chipper.js`
because Rapier's balls would slide, not roll, and friction is isotropic. Chips
are a volume per landing spot drawn as a cone; they are not particles.

2026-11-25, owner: a fed rope can be cut by the saw, and taking the block
down or the block's wood tearing free ends the feed too; whatever rope is
left is pulled in and chipped (`Rope.swallow`). It also snaps past
`ROPE_BREAK` like any rope. Damage to the chipper from this is ignored for
now.

2026-11-25, owner: feeding looked wrong (wood chipped 2 m beside the truck,
pulled straight at a point inside it). The rollers now pull the wood to the
hopper mouth first, round behind it if needed, then down the throat; only
then does it pass through the chipper's colliders, and a segment is chipped
only with all of it inside the hopper and body. Checked with a limb started
2.2 m beside the truck: every chipped segment ended within the chassis width.

**D58 — Feet lean into a moving load.** Towing a 600 kg chipper with the
existing grab tore the hold in one tick (walking speed against a 20 kN/m hold
with damping). Rather than a special rule for the chipper, holding anything
that can move (loose wood too) now limits how fast the feet go away from it
to how fast it follows, plus 0.15 m/s while the pull is under half of
`GRAB_MAX`. Standing wood is unchanged: walking away still tears it out of
the hands. Dragging a heavy log is now slow instead of an instant tear-out.

## Shed

**D59 — Breakable structures are glued rigid modules that turn into loose
boards past a force.** The owner asked for a shed near the tree, about the
chipper's distance from it, with no physics but simple collision until wood
hits it hard enough, then loose pieces that "scatter terrifically"; bigger
structures will be sheds glued together that break apart separately. So an
intact module is just colliders on a fixed body (or on a loose body, once
cut off from the ground), and the test is the summed contact force on it in
one tick from wood (or other structure bodies), against `SHED_BREAK_F`. Force
rather than energy because the owner said force; Rapier reports it as the
impulse of the step / dt, so it is about m·v·60 for a hard hit: 25 kN (the
default) is a 42 kg limb at ≈ 10 m/s or a 127 kg log dropped ≈ 0.5 m. A
127 kg log dropped 0.3 m measured 20 kN, and a 42 kg one dropped 1 m 12.5 kN.
Players and the chipper do not count (a walking player shoving a wall would
otherwise break it).

What is not plain physics, all for the "terrific" scatter: the body that hit
it keeps its velocity from before the step (the module gave way), the boards
get a velocity kick out from the hit point (`SHED_SCATTER` × closing speed,
plus half that upward), and the boards of a module that has just broken do
not collide with each other for `SHED_APART` (0.3 s). Without the last, the
boards, which start touching, lost two thirds of their speed to each other
within four ticks and the shed just slumped. Loose boards are not wood: they
cannot be cut, grabbed or chipped, and do not crack pavers.

**D60 — No scatter kick: a broken module slumps; fences are glued sections.**
Owner, after trying D59: "go with slumping … I'd expect the force of the wood
to produce sufficient breakage", and ideally a structure switched to physics
holds together. So `SHED_SCATTER`, `SHED_REACH` and `SHED_APART` are gone:
the parts start where they were, with the module's velocity, a few mm apart
(nothing overlaps, so nothing is pushed out), and only the impactor keeping
its pre-step velocity remains. The same 127 kg log from 3 m now leaves the
shed in a heap within 2.6 m of its centre. Fences (two-rail, split rail,
6 ft privacy) use the same model, one module per section between posts, so
a log takes out the section it hits and the rest of the run stands. Their
own threshold, `FENCE_BREAK_F` 10 kN: a 127 kg log from 3–4 m (50 kN) broke
one section of the privacy and of the two-rail fence; a 42 kg log from 1.6 m
(8.5 kN) did not break the two-rail.

**D61 — Touch is a third input device; the saw by finger is a viewer prototype.**
Owner asked for true phone controls and approved: "build idea 1 first, since
it's cheap and makes everything playable. At the same time, try the
draw-to-cut saw from idea 2 in the test viewer." Idea 1 is `src/touch.js`:
it fills the same InputState as the keyboard and the pad, so `sim/` has no
idea a finger was used (the only sim change is `Sim.ray`, split out of
`aim` for the viewer). Judgment calls, none reviewed by the owner yet:
the left 42 % of the screen is the floating stick and the rest drags to
look; one big context button is `{interact}` and is labelled with the words
after `{interact}` in the host's prompt; Rig, Punch, Let go and Saw show
only while the prompt names their token, Jump only on the ground; Saw is a
**toggle** on touch (a thumb cannot hold it and pivot and cut at once) and
Cut sits on the left, above the stick; on the rope tail a spring-centred
slider replaces the saw's buttons (up = `lt` haul, down = `rt` ease). Touch
look uses `INVERT_Y` like the mouse. Prompt, rope line and toasts move to the
top of the screen while touch controls are shown. On by default when the
primary pointer is coarse and there is no fine pointer; `?touch` forces it on,
`?touch=0` off, and a finger on the canvas turns it on on other touch screens.
The Tab menu gained a Close button (phones have no Tab key).
Follow-up (owner: "no button for tying a branch to a block which has been
set"): the Rig button is labelled with what it will do (hang / tie / untie /
take the block down), since looking within 0.7 m of the block turns the tie
into a take-down; with a block hung and no wood in reach it stays up, dimmed,
reading "Tie: get closer", and the host prompt now says "within reach".
Idea 2 lives only in the test viewer (`Saw` button): a stand-in climber with
no body, its eyes 1 m back along the finger's ray, drives the real
`sawStep`, so bar, pivot limits, cutting rate and pinch are the game's own.
With Saw on, the viewer keeps simulating after the test ends, at the test's
settings.

## Ground

**D62 — Terrain is one seeded height field with level pads; things are seated on it, not the other way round.**
The owner asked for hills and ledges before procedural yards. A Rapier
heightfield, generated from a small spec, so only the spec crosses the
network and late joiners rebuild it. Ledges are a stair over a noise field
rather than placed features, so they wind and nest like natural benches;
part of each ledge eases into a walkable slope (`TERRAIN_LEDGE_GAPS`) because
with 0.8 m ledges and a 0.59 m jump a pure stair walls players into hollows.
The default ledge is 0.8 m because stepping off one lands at about 4 m/s,
the `DV_SHAKEN` threshold; a 1 m ledge shook a walker.
Anything that needs level ground asks for a **pad** in the spec rather than
the ground being flattened by special cases: the tree's yard, the shed and
the parked chipper today, houses later. Fences do not get pads (a flat strip
through a hill looks wrong): each section is level at its lower post, so a
run steps.

Two physics notes. Rapier's `FIX_INTERNAL_EDGES` flag on the heightfield let
5 cm sticks slide through the crease at the foot of a ledge even when dropped
from rest, so it is off. And a heightfield has no thickness, so a stick at
12 m/s could pass through in one step where the old 1 m slab stopped it:
every dynamic body gets soft CCD (`TERRAIN_CCD`, 0.5 m) on terrain; Rapier's
hard CCD did not stop it. The engine tests keep the flat slab so their
results stay comparable; the smoke run is unchanged (18 / 22, the same four
failing as before).

**D63 — The chipper crumples like a shed; chips can be carried.** The owner
asked for the chipper to "crumple like sheds do if it takes a strong hit",
for a "Respawn chipper" button that removes the old one, broken or not, and
for players to pick up and drop a limited amount of chips with {interact}.
The crumple uses the shed's model (D59 and D60: a summed contact force in one
step, from wood or structures; the parts slump with no scatter kick; the
impactor keeps its pre-step velocity). The threshold is 120 kN rather than
the shed's 25 kN. At 40 kN, the chipper was wrecked just by being dragged into
the trunk at about 1 m/s by the rope feed (66 kN, because force is impulse
per step on a 600 kg body). A 1 t log dropped from 4 m measured 256 kN and
crumpled it. For its first second after being put down, it cannot crumple,
because a new chipper placed under a log measured a large spurious push.
Carrying is a volume, `CHIP_CARRY` (40 L), shown on the status line. The
chips are not drawn in the hands. Respawning keeps the chip piles. A new tree
still clears them.

## Bark

**D64 — Bark is circumscribed about the fibre boxes as drawn; it is on by default except in the test viewer.**
Fibres showed through the bark on thin upper segments. Two causes, both in
how the bark ring was fitted, both worst where a bundle has few fibres:
the ring's corners were placed at how far the fibre outline reaches in
their own direction, so each flat panel between two corners cut across the
outline (a 3 × 3 bundle got only 7 panels, and its square corners poked
out by up to 38 % of the radius); and the reach was scaled with the radius
along the segment while the fibre boxes keep one width all along, so on a
strongly tapering twig the boxes stood out at the thin end. The bark was
not "too tight" by a constant: a bigger margin would only have hidden it
on some segments. Now each panel lies on the line that just touches the
boxes in its own direction, at their real width, and its corners are where
neighbouring panels' lines meet, so no box can stick out whatever the
number of sides; both terms are linear along the segment, so straight
panels contain them end to end. Every fibre box in a segment now has one
width (from the middle radius), so the bark and the fibres agree.
Checked on the demo tree: no box corner outside the bark on any of 83
segments (54 / 54 thin ones poked before). The cost is that 3-fibre twigs
read a little blockier: their bark corners reach up to 1.7 × the radius.

Defaults (owner, 2026-11-25): `BARK_OPACITY` 1, `LEAF_OPACITY` 0.7. The
test runner and viewer start from `TEST_DEFAULTS`, which is the same with
`BARK_OPACITY` 0, so tests are still watched by their fibres; the viewer's
Tune panel can change it.

## Yards

**D65 — Yards are a pure, seeded plan put up through the existing events; houses are rooms glued on a foundation.**
The owner asked for procedurally generated obstacles: pavers, sheds, houses
and fences made into yards, including the tree's, sometimes fenced, houses
with paver sidewalks or porches, density tunable, and yards smaller as
density rises. Then, after trying the terrain: "don't feel the need to make
the work area flat. Complexity creates intrigue." So:

- The plan (`model/yards.js`) is a pure function of a seed and the `YARD_*`
  settings. It is made before the ground, because the ground carries the
  pads the plan asks for; then the builds and pavers go out as the usual
  `builds` and `pavers` events, so nothing new crosses the network.
- The tree's paving, the chipper and the tree itself no longer get a pad
  (`TERRAIN_YARD` is gone). Houses (out to the porch), sheds and patios
  still do, a patio at its house's height (pad `yAt`), because a house on a
  raw ledge would need a foundation taller than a person. Fences and
  sidewalks follow the ground.
- Lots come in blocks of two back-to-back rows sharing lot lines, so a lot
  line is one fence; a run is a whole number of sections stretched to fit
  the line, and a corner post two runs share is put up once.
- A house is one module per room, so a falling tree takes out the rooms it
  hits. Upper rooms are glued to the room below and their neighbours, and
  the ground floor to a concrete foundation that never breaks; this is the
  same glue rule as the `stack` of sheds (D59), so a room comes loose only
  when it has no glued path to the ground. `HOUSE_BREAK_F` 40 kN, between a
  shed (25 kN) and the felled-tree forces seen on fences (50 kN), a guess.
- Intact modules collide as their parts merged where they line up face to
  face (`modProxies`). 4 000 fixed cuboids cost Rapier ≈ 0.45 ms a step even
  with nothing touching them; merged, 1 800 cost ≈ 0.15 ms. The drawn boards
  and the loose parts after a break are unchanged.
- The view merges each intact body's boards into one mesh per material, and
  redraws only the build that changed on a `smash`.
- Flat ground (the engine tests) gets no yards and no shed, so the tests do
  not depend on the yard settings.

Not plain physics, found on the way: on a slope the parked chipper crept
(0.04 m/s on 6.5°) because its tyre grips cancel velocity before the step
and the step's contact forces leave a little drift every time. A braked tyre
now sticks: it is pulled back toward the spot where it stopped, up to the
same friction cap, and that spot moves with it when it slips. The grips are
also solved together over a few passes. Towed, the tyres roll as before.

**D66 — The chipper's rollers seize on heavy pieces.** The owner asked that
when wood would be chipped, the rollers check the weight of the contiguous
piece and seize above a tunable capacity, so the player has to saw it smaller
before chipping resumes on its own. The check runs when a segment reaches
the drum; "contiguous" is the fed piece plus every piece joined to it by live
fibres, so a half-sawn cut does not count as free until the fibres part, and
wood still part of the standing tree counts as too heavy. Seized, the rollers
hold the wood still (the same servo with zero speed) and stay seized until
the piece is light enough or out of the chipper; without that latch the wood
rocked across the drum line and the toast repeated every few ticks. Seized
rollers stop reeling a fed rope as well. When a fed piece is split, a side
with no wood inside the chipper is dropped from the rollers, so a sawn-off
outer end falls instead of being dragged in. `CHIP_CAPACITY` defaults to
150 kg. On the default tree, the branches that hang from a single segment
weigh 25 kg or less except for about a dozen, and those dozen range from
136 kg up to the whole 1.2 t tree, so small limbs go straight in and big
leaders and logs need sawing first.

**D67 — The chipper cracks pavers and breaks structures; paver cracking works again on hilly ground.** The
owner asked for pavers and structures to react to a falling chipper, and said
that structures flattened by the rope feed (66 kN of drag, above every
module's break force) are a feature, so no separate threshold. The chipper's
colliders and its wreck parts now count in `builds.hurts` and in
`pavers.impact`, with the same rules as wood: summed contact force against
the module's break force, and impact energy against `PAVER_CRACK_E`. A parked,
respawned or rolling chipper closes on the ground at about 0 m/s and cracks
nothing; dropped 0.3 m it cracked one paver, dropped 1.5 m two. While testing,
it turned out no paver had cracked since the heightfield ground (D62): on a
heightfield Rapier's `contactImpulse` is always 0, though the contact force
event fires, so `impact` found no points. Without impulses, the contact points
within 1 cm of the nearest now share the impact equally (with soft CCD the
push can come before they touch). A 1 t log dropped 3 m cracks pavers again.
`rollResist` in `sim.js` reads the same impulses, so loose wood has had no
rolling resistance on hilly ground since D62 either; it is not fixed here
because that changes how logs roll.

**D68 — A jump pushes off steep ground you are sliding on.** Owner: the jump
was "frustratingly close" to clearing a 0.8 m ledge; allow another jump while
sliding on the ledge. Rather than a ledge rule, jumping now needs only
footing: any contact under the player whose normal is within `JUMP_SLOPE`
(70°) of straight up. Standing (the ray down) jumps as before. Off steeper
footing the jump is the walking velocity plus `JUMP` up, less any part going
into the face, so the feet push off it, not through it. Walls (shed, house,
fences, the trunk) are steeper than 70°, so they cannot be climbed by
jumping: jumping at a shed wall for 5 s got no higher than one jump. Scripted
runs at 30 ledges, jumping every 0.4 s while walking at them: 23 got up
(0 before). About a third of attempts left the player briefly shaken (3 of 30
before, with no climbing): landing at a little over `DV_SHAKEN` (4 m/s) after
slamming into the face or falling back off it. The threshold was left alone.


**D69 — The tree's lot is an ordinary lot; its paving, shed and chipper come from the same rules.**
Owner: "Lot width doesn't seem to be applying to the tree's own lot, as it
should. The paver circle and prototype shed are not meant to be hard-coded
features and should instead be part of the generative system." So the tree's
lot now has the width and depth every lot has at that density, with the tree
somewhere in its back half. Everything on any lot is placed only where it
fits, clear of what is already there, so on a small lot things shrink or are
left out instead of the lot growing. The tree's lot reserves the trunk's
clear ground (`YARD_TREE_CLEAR`, 4 m by default, so the 4 m player spawn
stays clear), then usually gets paving round the trunk: a circle or a
square, up to `PAVER_RADIUS` × `TREE_HEIGHT` and only as big as the lot
allows. Its shed and house follow the ordinary rules. Judgment calls, not
reviewed: the chipper still belongs to the tree's lot, parked after the house
(so the house gets the front yard first) in whichever direction around the
tree it fits, and in the street in front of the lot when it fits nowhere in
it, which happens on the small lots of high density. Flat ground (the engine
tests) keeps the old circle and parking so the tests do not change.
`SHED_GAP` is gone.

**D70 — The chipper's rollers: a speed drive with a capped motor, a straight throat, and no snags at the mouth.**
The owner reported that logs that are too big jam the chipper and that small
branches easily make the physics go wild, and asked whether collision should
be relaxed while chipping. Fed one at a time, a 5 kg and a 25 kg branch were
flung about at 42 to 58 m/s, and an 81 kg log and a 136 kg limb never went in.
There were four causes, and each is fixed by a general rule:
- Wood lined up with the mouth but 0.3 m short of it flipped each tick
  between "go round" and "go in", so it stayed there. Now the path round is
  followed all the way to the axis behind the mouth, and only wood off the
  axis goes round.
- A wood's end met the hopper's face while its centre line, by which entry
  was judged, was still its radius short of the mouth, so a log over about
  0.1 m in radius never counted as in. Entry now counts the radius, and fed
  wood never collides with the hopper (it is a funnel; side branches fold
  in). The truck's other parts still stop it until its end is in.
- The motor term wound up to 15 kN whenever the wood lagged, and flung small
  branches when what held them let go. The drive now takes the point halfway
  to roller speed each tick through its effective mass. The motor term
  only builds while the smoothed speed is short, drops to nothing when the
  wood keeps up or a segment is chipped, and is capped at ten times the
  wood's weight plus the tension of a rope tied to it. A rope still goes into
  the rollers as before.
- Wood that passed through the chipper pivoted on the one point held and
  folded out through the sides and floor into the ground, where segments
  were never "inside" and were never chipped. Now the throat carries the
  weight and draws the far end of the held segment onto its axis, a segment
  is chipped once its front end is past the drum (side branches go with the
  stem), and bits left unconnected after chipping become separate pieces
  (until now they stayed rigidly fixed out beside the truck).

The rollers take the wood's end nearest the mouth, not the point the player
held. After the change, the same branches peaked at 1 to 4 m/s (mostly while
falling into place), and the 81 kg log and the 136 kg limb were chipped
completely. A 307 kg log went in and seized (D66), as it should. The rope
feed, the seize-and-saw test and the smoke run are unchanged. One case
remains: a thin twig tip that has already sunk below the ground holds a
branch short of the mouth. That is the heightfield letting small tips through
(D62), not the chipper.

**D71 — Polish round (owner list of 2026-11-25).** Defaults: mouse look 8,
new tree 22 m by 1.2 m, cutting rate 200 cm²/s, `STUB_LEN` 0.8 m. The
bigger default tree has about five times the fibres of the old one (≈ 350
segments, ≈ 13 700 fibres): FM-22, which grows the default tree, now
reports an idle step p95 of 2 to 6 ms against its 1 ms limit (0.9 ms on
main before). Left as a finding, not loosened. Other choices:
- *Lanyard stays on its stem.* It used to slide onto whichever child pointed
  most where the player looked, which could be a short branch. Now it only
  slides onto the child that turns least from the segment it is on, and only
  if that turn is under `STEM_BEND` (20°; branches leave the trunk at 25° or
  more off its axis). Going down, it stops where the segment below does not
  continue the same stem. A general geometric rule, not a "trunk" flag.
- *Jut is trigonometric.* A branch blocks the lanyard when the farthest
  point of its wood from the parent stem's axis line, less the stem radius,
  is at least `STUB_LEN`. The old test was one segment's length, or any
  branch with more than one segment. On the default tree 62 of 69 branches
  block.
- *Off the end releases.* Climbing up past a segment with no children, or
  down past the bottom of a piece that is not on the ground, drops the
  climber (with the piece's velocity if it moves) and says so.
- *Pull force.* Walking away from held wood stopped pulling harder at half of
  `GRAB_MAX` (300 N). That is now its own setting, `PULL_FORCE`, at 600 N
  (twice), and `GRAB_MAX` doubles to 1200 N so the margin before wood tears
  out of the hands is unchanged.
- *Diagonals.* Two movement keys move at the speed of one: the host scales
  (mx, my) down to length 1. This also applies to climbing.
- *Paver slope.* No paver is laid where the ground under its middle is
  steeper than `PAVER_MAX_SLOPE` (30°). The host sends the limit in the
  `pavers` event so every machine lays the same set. Default yards: 17 of
  482 pavers were steeper than 30° on main (up to 66°).
- Injury thresholds `DV_SHAKEN`, `DV_HURT`, `DV_DOWN` and `SHAKEN_TIME` are
  in the Tab menu.

**D72 — Polish round, part two: shaken view, down view, imperial HUD, damage
costs, settings search.**
- *Every injury shakes first.* A hurt or down impact now also sets
  `SHAKEN_TIME` of no control, as a shaken one does. While it lasts the
  view swims: roll, pitch and yaw sines of `WOBBLE` (0.08 rad) at about
  `WOBBLE_HZ`, easing in and out over 0.4 s. The host sends `sk` (shaken
  now) in each player's aux, and the view does the rest.
- *Down.* The eyes are `DOWN_EYE` (6 in) above the ground under the player
  and the view is rolled 90°. The look still turns it.
- *Imperial.* `IMPERIAL` (on) changes only HUD text: the status line, the
  rope panel and toasts. Host text writes quantities as `{speed:4.2}`,
  `{len:…}`, `{mass:…}`, `{force:…}`, `{vol:…}`, `{money:…}` in SI, and
  `hud.describe` formats them for each client, like the control tokens.
  The settings menu stays in SI.
- *Damage.* `sim/damage.js` charges `PAVER_COST` per paver the first time it
  cracks, and `FENCE_COST`, `SHED_COST`, `HOUSE_COST` per module of that
  kind broken apart (a fence section, the shed, one room). It charges
  `CHIPPER_COST` for a wrecked chipper. Each charge is a `damage` event (the
  running total `world.damage` is in snapshots for late joiners, cleared
  with a new tree) and one toast with the price and the total. The
  chipper's own "wrecked" toast was folded into it. Dollar figures are
  placeholders to tune.
- *Settings menu.* Sections are collapsible (closed by default, and the
  open ones are remembered), with a search box that shows only the
  settings whose label or config name contains every word typed.

**D73 — Adaptive draw distance, with fog over the edge.**
- The camera's far plane is the draw distance, `DRAW_DIST` (150 m). Each
  machine adapts its own (view only, nothing on the network): the frame
  time is smoothed over about 20 frames, and while that is under
  `DRAW_FPS` (40 fps) the distance shrinks by `DRAW_ADAPT` (25%) of itself
  per second, down to `DRAW_DIST_MIN` (50 m). Once the frame rate is 10%
  over the target it grows back five times slower. The gap and the slow
  rise stop it hunting. Frames over 250 ms (a hidden tab, a load) are not
  counted.
- Cutting the far plane saves what three.js frustum-culls (whole houses,
  sheds, fences and pieces past it) and the pixels of ground past it. It
  cannot help a slow simulation on the host, so there it rides to the
  minimum and stays: the person asked for frame rate as the signal.
- Fog is linear, in the sky's colour, from `FOG_START` (0.3) of the
  distance to 98% of it, so anything the far plane cuts has already faded
  into the sky. `AUTO_FOG` off removes the fog entirely (the distance still
  adapts, and its edge shows).
- Defaults keep the old look: the fixed fog was 40 to 140 m.

**D74 — Other trees in the yards: drawn until touched, wood once sawn or climbed; an orange X on the job tree.**
- *Dormant.* The yard plan puts `YARD_TREES` trees per lot on average
  (1.5), `YARD_TREES_HMIN` to `YARD_TREES_HMAX` tall (8 to 16 m), trunk
  `YARD_TREES_THICK` × height across, wherever they fit: clear of the lot's
  edges by 1 m and of everything else by a fifth of their height. They use
  their own random numbers seeded by the lot, so adding them moved nothing
  else in the plan. A dormant tree has no wood in the model: `world.stands`
  holds only its place and its shape numbers (one small `stands` event).
  Every machine grows the same skeleton from those numbers
  (`generateTree` now takes an explicit shape, so a client's own menu cannot
  change it) and draws bark and foliage from bundles made just for drawing.
  All dormant trees are one bark mesh and one foliage mesh. The host gives
  each only fixed colliders along its trunk, so players bump into it and can
  look at it. The crown catches nothing: a felled tree passes through
  another's branches and stops only on its trunk.
- *Waking.* A player who starts sawing one (holding the saw trigger within
  saw reach), presses {interact} on it (grab, or hold to spur in) or {rig}
  wakes it: the host grows its wood with the same numbers and
  `YARD_TREES_PITCH`-wide fibres (60 mm, against 30 mm on the job tree:
  about a quarter of the fibres), as an ordinary rooted tree (a `tree` event
  with `stand` set). It is then wood like the job tree in every way. Rapier
  finds new colliders only after a step, so the press that woke it is
  replayed on the next tick. Looking at one is not enough, so walking about
  wakes nothing.
- *Cost (headless, default yards, 15 trees).* Dormant: no step cost that
  could be measured, about 70 ms more to grow the world, 191 trunk
  colliders. All 15 awake: 816 more segments and 11 600 more fibres, step
  median 1.5 → 3.9 ms. Waking one is about 11 ms on the host.
- *The X.* The host sprays it on the job tree `MARK_HEIGHT` (1.4 m) up,
  on the trunk segment nearest that height, on the side facing the tree
  lot's street (`world.mark`, piece-local). It is paint on the bark: drawn
  in the bark mesh of the segment it is on, it bends with the bark, a kerf
  through it is a gap in it, and the part on a piece that falls goes with
  that piece. Engine tests (flat ground) get no X and no other trees.

**D75 — Tests keep the old tree size.** Owner: keep the 22 m × 1.2 m tree
for play only. `TEST_DEFAULTS` (the test runner, its viewer, and the
defaults of every test parameter in `tests.js`, which used to read
`CFG_DEFAULTS`) sets `TREE_HEIGHT` 11 and `TREE_DIAMETER` 0.54 again. Play
and "Grow a new tree" still start from `CFG_DEFAULTS` (22 m, 1.2 m). This
brings FM-22, which grows the default tree, back to the tree it was written
for (see D71).

**D76 — Day, night and the moon.** Owner asked for a simple sun and moon
cycle "similar to Minecraft", moonlight that follows how bright the moon is,
and headlamps at night.

- *Clock.* The host keeps it (`sim.days`, days since the first midnight,
  advancing `1 / DAY_LENGTH` per second) and sends `sky: [days, DAY_LENGTH]`
  in aux. A client runs its own copy between packets, eases onto the host's
  and jumps if it is more than 0.005 days off (a skip). It is a small
  continuous value, so aux, not an event. It is not reset by a new tree.
  The lobby behind the main menu keeps its own clock.
- *Default length 20 minutes* (`DAY_LENGTH` 1200 s), the same as
  Minecraft's day, starting at `DAY_START` 0.3 (mid-morning) so a game
  starts in daylight. 0 stops time. Tab menu: Day, night and moon.
- *Sky.* The sun rises in +x, leans `TILT` (0.45 rad) towards +z at noon and
  sets in −x. The moon is always opposite the sun, as in Minecraft (so it is
  up all night whatever its phase; a real new moon would rise with the sun).
  The phase changes each noon, never during a night, and runs through
  `MOON_DAYS` (8) from full to new and back. The look is our own: a soft
  glowing sun disc, a moon drawn per phase on a canvas with a soft
  terminator, faint dark side and grey seas, and 900 stars that turn with
  the sky. They sit at 0.9 of the far plane, ignore fog and are depth-tested,
  so wood and ground in front hide them.
- *Light.* lit = (1 + cos(2π k / MOON_DAYS)) / 2. Moonlight =
  `MOON_LIGHT` × lit, sky glow = `NIGHT_AMBIENT` + `MOON_AMBIENT` × lit, both
  faded in with the moon's height. The scene's one shadow-casting
  directional light is the sun by day and the moon by night (whichever is
  brighter), so moonlit wood casts faint shadows. Sky and fog share one
  colour, from night blue (lighter under a bright moon) through a warm band
  at sunrise and sunset to the old day blue, so the fog of D73 still meets
  the sky with no seam.
- *Headlamps.* Every player has one: a spot light (`HEADLAMP` 14 cd, beam
  half-width `HEADLAMP_ANGLE` 0.45 rad, no shadows) that fades in as the sun
  nears the horizon (`HEADLAMPS` off = never). Your own follows the camera;
  others' follow their yaw and pitch (pitch `pt` added to the player aux).
  The light is in the scene, not the body, because your own body is hidden.
  A small lamp on the helmet glows while it is on. Each player adds a light,
  so a player joining makes three.js recompile shaders once (a short hitch).
- *Not done.* Cloud cover (described to the owner, not built), weather,
  seasons, the moon's position following its phase.

**D77 — Frosted windows and weeds.** Owner asked for windows "frosted to
opaque" and a toggle for weeds growing next to fences, structures and trees.

- *Windows.* House glass is drawn opaque and pale (no transparency, casts a
  shadow like the walls), so nobody sees into the empty rooms. Only houses
  have glass; sheds have none.
- *Weeds* (`view/weeds.js`, drawing only, no colliders, no events). Every
  part of an intact module that stands on the ground and reaches within
  0.3 m of it gives its footprint; tufts go just outside its outline,
  `WEEDS_DENSITY` (8) per metre, skipping spots inside another footprint
  (between pickets, between a foundation's rooms). A ring of them goes round
  the base of every rooted trunk and every dormant yard tree. Where each tuft
  stands and how it looks is hashed from the model, so every machine draws
  the same weeds. A broken module's weeds go (rebuilt on the next
  `builds`/`tree`/`terrain` event, not on the smash itself, so they stay
  until then: cheap, and nobody looks at the grass under a wreck).
- *Cost.* About 10 400 tufts at the default yards (10 triangles each),
  instanced, one batch per 24 m square; squares past `WEEDS_DIST` (60 m) are
  not drawn, under the frame-rate draw distance of D73. Building them takes
  about 30 ms on a grow. In software GL the render-time difference with
  them on or off was inside the run-to-run noise. Tab menu, View: `WEEDS`
  (on by default), density, height, distance.

**D78 — Back and swipe-back ask before leaving a game.** Owner: players
lose the game to swipe-back gestures. No browser lets a page turn the
gesture off, so: (1) CSS `overscroll-behavior: none` on the page (stops
pull-to-refresh and Chrome / Edge's overscroll swipe-back, touch and
trackpad) and `touch-action: none` on the game canvas. (2) `src/leave.js`
keeps one history entry of its own on top while in a game: Back, the
Android back gesture and iOS Safari's edge swipe pop that entry instead of
leaving, and an in-game "Leave the game? Stay / Leave" box comes up. When
the last of ours is popped another goes straight back on, so a second swipe
is caught too. Entries are pushed only from a tap, click or key (Chrome
skips, on Back, entries the user never touched), so `?solo` arms at the
first tap; Stay pushes one more, never more than two of ours. Leave goes
back past them; with nothing before the game (fresh tab) it says to close
the tab. (3) `beforeunload` asks on closing the tab or anything that gets
past the trap (Chrome / Firefox / Edge only; iOS Safari has none). (4)
`apple-mobile-web-app-capable`: added to the home screen on iOS it opens
full screen without Safari's back swipe. `LEAVE_GUARD` (Tab menu,
Controls) turns all of it off for anyone reloading a lot while working on
the game. What remains: on iOS Safari in a tab the edge swipe still plays
its slide animation and then lands back in the game with the box up;
quitting through the app switcher or closing the tab on iOS is not asked
about. The test viewer's own Back handling (it closes on Back) is
unchanged; the guard is only armed in a game.

**D79 — Variable cloud cover.** Owner approved the plan given with D76,
without rain ("No rain please... Yet...").

- *Weather.* The host keeps one number, cover (0 clear, 1 overcast;
  `sim.cloud`), and sends it as the third item of `sky` in aux. With
  `CLOUDS` at -1 a new target is drawn about every `CLOUD_HOURS` (3) game
  hours: a quarter of the time clear (under 0.1), a fifth overcast (over
  0.8), otherwise broken. Cover moves towards it at full range per
  `CLOUD_CHANGE` (120 s). `CLOUDS` 0..1 in the Tab menu holds it there. A
  game starts at 0.25. Host-side randomness only touches this number, never
  physics.
- *Light.* Cover blocks up to `CLOUD_DIM` (0.85) of sunlight and moonlight,
  and the night glow from the moon by the same share, so a cloudy full moon
  is about as dark as a new moon. The sky's own glow by day drops by at
  most 30%. Shadows fade to a quarter (`shadow.intensity`). The sky and fog
  colour fades towards grey, the dusk band weakens, and the sun, moon and
  stars fade out.
- *Cloud layer.* One flat layer, a shader of fractal value noise on world
  x-z, at the lower of 80 m and 0.4 of the draw distance above the eye,
  following the eye, as wide as the view and faded out towards its rim so it
  meets the fogged horizon. Cover lowers the noise level that counts as
  cloud. Thin edges take the sun's or moon's colour (warm at dusk), thick
  parts a darker grey of the sky. It drifts at `CLOUD_WIND` (6 m/s) on each
  machine's own time, so two players see the same amount of cloud but not
  the same shapes. Cheap: one quad.
- *Not done.* Rain, real 3-D clouds, clouds casting moving shadows.

**D80 — Whole bundles under solid bark are not drawn.** Owner asked to stop
drawing fibre bundles that are fully intact and to measure it.
- *Rule* (`view.js` `sealed`). With `BARK_OPACITY` at 0.99 or more, a
  segment's fibres are skipped when it is whole (no fibre cut, none trimmed
  by a split), its base is shut (a parent in the same piece, or the ground
  under the standing trunk), its top is shut (a child in the same piece
  starting where it ends), and that parent and continuing child are whole
  too. So any kerf, notch, split end, twig tip or piece end, and the
  segments either side of it, keep their fibres. The bark is built only from
  the model, so nothing else can open it. Crossing the 0.99 line in the menu
  redraws every piece's fibres; the test viewer (bark 0) draws them all.
- *Not counted as damage:* fibres a live bundle has snapped (aux.live).
  The bark over them is still whole, so they could not be seen anyway; they
  show once the segment divides or rips.
- *Measured* (22 m × 1.2 m play tree, seed 1, headless Chromium,
  SwiftShader software GL, 1280×720, 300 frames, medians, render timed
  to a 1-pixel readback): fibre boxes 13 558 → 748; looking at the trunk
  from the ground, frame 150 → 117 ms, render 137 → 108 ms; looking up into
  the crown, frame 133 → 83 ms, render 115 → 76 ms; colouring fibres
  0.8 → 0.1 ms. A real GPU will gain far less in milliseconds (the boxes are
  one instanced draw), but the CPU work per aux tick and per bend scales with
  the boxes drawn. The fibre lines that used to poke through the bark at
  segment joints are gone too.

**D81 — Legs push and pull with one force; the arms hold both ways.** Owner:
pulling was far weaker than pushing even with 50 kN of pull force set, and
both must move the chipper truck over rough ground (its weight may come
down).
- *Why pulling was weak.* Walking set the body's velocity outright every
  tick, and the hold's pull on the player went in as an impulse after it, so
  the rope dragged the player back each step. The pull settled near
  0.15 m/s × 85 kg / tick ≈ 760 N, whatever `PULL_FORCE` said. Measured with
  50 kN set: 756 N at most. Pushing went through the same velocity
  overwrite, so it was unlimited: it shoved a 600 kg chipper with its brake
  on, and ramming it left the player shaken.
- *Legs.* Standing players get no friction of their own (friction 0,
  combine Min). Each tick the legs push the body toward the walking velocity
  with at most `LEG_FORCE` (1000 N, which replaces `PULL_FORCE`) across the
  ground. That is all their traction, so pushing with the body and pulling
  through the hands are both capped at `LEG_FORCE`, and a hold pulling on
  the player moves them only past it. Standing counts the ground under the
  middle, or anything under the body no steeper than `WALK_SLOPE` (45°, so
  the sides of a ditch). Walking reaches 3.5 m/s in about 0.2 s and stops as
  fast. Standing still on a 34° slope drifts 0.1 m in 3 s. The "lean" rule,
  which limited walking speed away from held wood, is gone: the legs give
  way first.
- *Arms.* The hold is now a spring both ways: it pulls when stretched and
  pushes when squeezed (a push goes level, not down into the ground through
  the drawbar). Squeezed past `GRAB_MAX` the arms fold. Only a pull averaged
  over `GRAB_TAU` (0.1 s) above `GRAB_MAX` (2500 N) tears the hold out, so a
  one-tick jolt does not. While walking with something that can move, the
  arms also keep it on the line of the walk (`GRAB_STEER`, 3000 N/m, at most
  `LEG_FORCE`): behind when towing, ahead when pushing. A drawbar held at one
  point otherwise jackknifes.
- *Chipper.* `CHIP_MASS` 600 → 350 kg (a small towable chipper).
- *Measured* (headless; default yards; the chipper placed on the three
  steadiest rises found; one player, 15 s, the drawbar held). Before: 9.3°
  did not move it. After: towing up 9.3° covered 53 m, 3.2° 30 m, 2.3° 12 m
  (stopped by something in the way), with the pull near `LEG_FORCE`.
  Pushing the drawbar uphill, a scripted walk toward the grip moved it 2 to
  9 m: it is faster where the player keeps behind the drawbar, which the
  script steers only crudely.

**D82 — One readable world seed; slower clouds; no running total in damage toasts.**
Owner (2026-11-25): show a seed text box for the procedural generation,
prefilled with a random eight-character word of alternating consonants and
vowels, with letter pairs (ph, ch, th...) as consonants and a rudimentary bad
word filter that rerolls (ph counting as f); show it in the settings menu.
Slow the clouds 10x. Take the running total out of the damage toasts.
- *One word for everything.* `model/seed.js` hashes the word (FNV-1a,
  salted per use, lower-cased and trimmed) into `TREE_SEED`, `TERRAIN_SEED`
  and `YARD_SEED` (1..1e6) just before a tree grows, on the host. The yard
  trees already follow `YARD_SEED`. The three numeric rows left the Tab
  menu; an empty word keeps them as configured, which the engine tests rely
  on (their `WORLD_SEED` is '').
- *Where it shows.* A box beside Host / Solo in the lobby and at the top of
  the Tab menu, each with a New button; both edit the same value. The
  menu's line "This world: ..." is the seed of the world in play, carried on
  the `terrain` event and in the welcome, so a joined client sees the
  host's seed. My choices: the word is not saved between visits (each visit
  starts with a fresh word, or `?seed=word`), and words are shown lower
  case. `?seed=` now takes a word, not a tree number.
- *Filter.* A short list of rude stems matched anywhere in a normalised
  spelling: ph → f, th → its own letter (so "bathoruk" does not read
  "hor"), ck / c / q → k, ch → tsh, wh → w, x → ks, z → s, y → i, doubled
  letters once. Rough on purpose: about 6% of random words are rerolled.
  Typed seeds are not filtered.
- *Clouds.* `CLOUD_WIND` 6 → 0.6 m/s; the slider now runs 0..4.
- *Damage toasts* say only what broke and its cost; the running total stays
  on the status line.


**D83 — Weight on the grab button and the "came free" toast; two-word captions.**
Owner (2026-11-25): show how heavy a piece is in the action button text when
grabbing; show the weight in the "it came free" toast; apart from the weight,
cut every button caption to two words at most.
- *Weight.* `sim.weightOf(piece)` (moved from the chipper's capacity check,
  same rule): the piece plus everything still joined to it by live fibres,
  Infinity if that reaches the tree. The {interact} caption carries it as
  `{mass:N}` on "grab" (loose wood looked at), "let go" (wood in hand) and
  "feed" (at the chipper); wood still on the tree shows no number. The toast
  is "It came free: 95 lb" (HUD units).
- *Captions.* The host prompts' action phrases are what the touch buttons
  and the desktop prompt line show, so they were cut: grab, let go, feed,
  plant saw, hang block, tie rope, remove block, untie, take tail, take
  chips, more chips, drop chips, grab chipper, tow, spur in, move lanyard,
  tie off, pivot, cut, lift. A held touch action shows ⏳ instead of the
  word "Hold:". Fixed touch buttons: "⏳ Let go", "Lift saw", "Wrap +",
  "Get closer". Menu buttons: Grow tree, New chipper, Skip ahead, Reset all
  (the long text is the tooltip and still searchable); Testing: Main menu,
  View default, "Click again". Hints and help text that are not on a button
  (the lobby help, "Look at wood within reach...") are unchanged.


**D84 — Fibres are lit.** Owner (2026-11-25): at night the fibres stayed
super bright. They were `MeshBasicMaterial` (unlit) so the stress colour
read the same from every side. Now `MeshLambertMaterial`, like the bark:
they follow the sun, the moon and the headlamps. By day the colours are the
same, with a little face shading that helps tell neighbouring fibres apart;
at night stress colours are read by headlamp.

**D85 — The end of the wood stops a climber once.** Owner (2026-11-25): on
a LAN a client climbing a limbless trunk kept going over the top without
noticing, because they see themselves 0.1–0.2 s late (D3). Climbing past
the free end of the wood (the top of a stem with nothing above it, or the
bottom of a hanging piece) now stops at the end with a toast; letting go of
{move} (or pushing the other way) and pushing on again climbs off as before.
Moving 0.3 m back from the end forgets the stop. This is a host rule, so it
holds whatever the network does. Unions and stem changes are unchanged.

**D86 — Network statistics on the client; inputs carry a sequence number.**
Owner (2026-11-25): show at least ping and packet loss when joined. See
DESIGN 2.6. Ping rides the unreliable channel on purpose, so it measures
what snapshots and inputs see and its own loss is a third loss figure.
Inputs now carry `n`; the host drops one older than the newest it has used,
so a reordered "still climbing" packet cannot restart a climb after a stop
(old clients without `n` are accepted as before). `INTERP_DELAY` moved into
the Tab menu (View) as the one lever a player has on a LAN.
Prediction (D3, task P2-9) is not built; the plan is in STATUS "Next".

**D87 — Hopper winch; a job budget that wages drain.**
Owner (2026-11-25): when we deposit into the chipper, transfer our grab rope
to a winch at the top of the hopper; once a piece passes the front of the
hopper the rollers can start pulling it in, with no wait for it to hit the
back of the hopper. Turn the damage counter into a cash balance: a budget at
the start of the job of $5,000 for an 18 ft tree 0.8 m across, scaling up
with tree size and with smaller lots, $30,000 at the current defaults; drain
it by the U.S. federal minimum wage, $7.50 per player per scaled hour of the
20-minute day, and show the math.
- *Winch.* `SHAPE.WINCH` (a drum on two posts just inside the hopper's top
  lip; the rope must end inside the hopper, or wood hung from a drum above
  the mouth dangled there and never went in). Pull only along the rope, half
  the gap to `CHIP_FEED_V` per tick plus the rollers' motor term, capped at
  `CHIP_WINCH_F` (6 kN, my choice) and ten times the wood's weight. The
  rollers take over at the deepest point of the wood inside the hopper
  (sampled at five points per segment), and the winch keeps pulling until
  its knot is 0.3 m from the drum. Half the wood's weight rides on the tray
  until it is in, as the rollers did (D70): without it the winch's pull swung
  long branches and drove their tips under the heightfield, where they held
  the wood short of the drum. The rollers' guide now aligns whichever end of
  the held segment is further out (their point can be mid-segment now).
  Headless: four branches (0.3, 15, 33, 57 kg) left 2 m behind or beside the
  chipper all went in and the 57 kg one was chipped to nothing in about
  9 s of sim time.
- *Budget* (`sim/damage.js job`): `BUDGET_BASE` × (height × diameter) /
  (`BUDGET_REF_H` × `BUDGET_REF_D`) × `BUDGET_LOT_REF` / lot width, to the
  nearest `BUDGET_ROUND` ($500). Height × diameter gives ×6.01 from the
  reference tree to the 22 m × 1.2 m default, which is the owner's $5,000 →
  $30,000. Lot width is the nominal width for the yard density (22 m at the
  default 0.5), not the jittered width of this seed's lot, so the default is
  always $30,000 (my choice; the actual lot varies ±15%). Reference tree at
  density 0 / 0.5 / 1: $3,500 / $5,000 / $8,000. Flat test ground counts as
  the reference lot.
- *Wages* (`Damage.step`): `WAGE` × players × dt / (`DAY_LENGTH` / 24),
  paid in whole dollars by a `wages` event. Counted on play time, not on the
  clock, so the Tab menu's skip-ahead does not charge for skipped hours (my
  choice). No wages when `DAY_LENGTH` is 0.
- *Cash* = budget − damage − wages (`world.cash()`), may go negative. The
  status line shows "cash $29,870, wages 2 × $7.50 per game hour ÷ 50 s =
  $0.30/s". The budget's own math is in the Tab menu under the seed ("Budget
  $30,000 = $5,000 (for a tree 18 ft x 2.6 ft) × 6.01 (this tree is ...) ×
  1.00 (lots ... wide against ...), to the nearest $500") and a toast says
  the budget when a job starts. Damage toasts are unchanged. Settings in the
  Tab menu under "Money: budget, wages and damage".

**D88 — The ground is solid: wood inside it is pushed back out.** Owner
(2026-11-25): parts of branches get stuck under the ground and are hard to
move. The heightfield (D62) has nothing under it, and a segment whose axis is
under the surface is pushed further down by it while the rest of the piece
is pushed up, so the piece is pinned through the ground. Headless, a 25 kg,
2.6 m branch put down with its butt 0.3 m under the surface sank to 0.9 m and
a pull of 1.5 times its weight moved it 0 to 0.12 m. The owner chose one
general rule over a minimum twig thickness or teleporting: `sim/ground.js`
checks the axis of each segment on a moving body (ends and middle) against
`groundY` before each step. If any of it is under the surface, that
collider's collision groups leave out the ground and the ground pushes back
at the deepest point along its normal as a damped spring, sharing the body's
mass between its sunk points (`GROUND_PUSH_K` 1000/s², about 1 cm under its
own weight; `GROUND_PUSH_MAX` 0.05 m; `GROUND_PUSH_DAMP` 40/s; it never
pulls). Once the whole axis is half a radius above the surface, the ordinary
contact takes over again. A first version pushed with the segment's own mass
and let a twig under an 11.6 t felled tree sink 0.3 m where the old contact
had held it, so the spring uses the body's mass. The same branch now
comes out within 3 s and drags as it does on open ground. Fells on three
seeds land as before. The check costs about 0.05 ms a step with a whole
felled tree awake (segments too high to reach the ground are skipped). Flat
ground (the engine tests) has a solid slab and skips it. Only wood is
covered: players, chips and loose shed or chipper parts are not.

**D89 — Stale updates are skipped instead of queued.** Owner (2026-11-25):
the lag seen on a LAN was 1–2 s, not the ~130 ms that ping and the render
delay explain. Nothing in the game delays data by seconds, but the
transport could: PeerJS's `send` hands messages to the data channel until
8 MB is buffered and keeps the rest in its own array, and an unreliable
channel still sends everything it was given, in turn. On any link slower
than the ~30–100 kB/s the host sends (aux alone is ~7 kB at 10 Hz), the
queue and the lag grow without limit. A likely way to get such a link on a
LAN: the direct connection fails (Wi-Fi client isolation, mDNS addresses
not resolved) and WebRTC falls back to PeerJS's free public TURN relay.
Emulated 6–10 kB/s link, headless: snapshots arrived 12 s late after 15 s
and 24 s late after 30 s with no limit; with the limit, 0.4 s, steady.
`Net.backed` skips a snapshot / aux / input while more than `NET_QUEUE_MAX`
(64 kB) waits or the wait at the link's measured drain rate passes
`NET_LAG_MAX` (0.25 s); both in the Tab menu. The network box now shows
the route, the network's own round trip (so a slow machine and a slow link
can be told apart), how late snapshots arrive and the host's queue.
Also: the client's estimate of the host clock is now the quickest packet of
the last 2 s; it used to creep down 0.5 ms a packet, so after the host ran
in slow motion bodies were drawn unblended at their last sample for minutes.
Not verified on a real LAN: the cause there is a hypothesis until the box
shows it.


**D90 — Players have heads, faces and names.** Owner (2026-11-25): shorter
tube torso with a round head, keep the helmet and headlamp, 2-D eyes that
blink / wince when shaken / worry when hurt / are crosses when down, saw in
the shirt colour, and a name and shirt colour chosen in the lobby that
replace "Player N" in toasts, sit on a name tag over the left breast
pocket (upper chest, off to one side; owner follow-up) and across the back of
the helmet. Choices: the name and colour travel as the existing `player`
event (sent again to change them); a joiner sends them in a `me` message
right after `welcome`, so the host's "joined" toast waits for it. The host
cleans names (`cleanName`: no control characters, no `< > { }` because
`hud.js` expands `{tokens}`, at most `PLAYER_NAME_MAX` = 16) and colours.
Name and colour are remembered in the browser; a first visit gets a random
shirt from the old palette, and anyone who sends none still gets the
palette colour by id and "Player N". Wince follows the shaken pause (`aux.sk`),
worry follows the HURT level; the lingering SHAKEN level shows normal eyes.
Faces and tags are canvas textures, drawn again only when they change.
The physics capsule is unchanged; only the drawing changed.


**D91 — The chipper rights itself: a spiralled roll cage and a low centre
of mass.** Owner (2026-11-26): give the chipper a dome-shaped top so it
rolls back onto its wheels after flipping. Rule used (no righting torque, only
shape and mass): a body on flat ground rests only where its centre of mass is
over the contact, so the chipper's outline seen end on must have no resting
place but its wheels. A round dome does that only if it is smooth, and its
centre is above the centre of mass; Rapier has no curved half-cylinder, and a
round arc laid out in flat steps (a convex hull) rests on any step it lands
on, which the first try showed. So the dome is a spiral about the centre of
mass instead: every 2° step toward the top lies a little farther out
(`SHAPE.CAGE.k`, 5% per radian), and the weight is then always a few cm
outboard of the contact, toward the wheels. With the wheels' collider balls
reaching 1.1 m out, the dome has to be as wide as them (1.24 m half width)
and its top is 1.15 m over the chassis centre (0.7 m over the chassis top);
lowering the centre of mass from 0.06 to 0.19 m under the chassis centre (a
`BALLAST` share of the mass: drum, flywheel and engine block low in the
chassis; chassis share 0.8 → 0.45 + 0.34) keeps it from having to be taller.
The collider is the hull of two hoops at x = ±1.25 (the chassis length,
clear of the hopper); it is drawn as a steel roll cage (two hoops, five rails,
struts to the chassis), so nothing invisible stands out. It is one of the
chipper's colliders like the rest: it pushes, cracks pavers and flattens
structures like the body. Choices the owner hasn't reviewed: the cage's look
and size, the mass shift, and the yard plan now keeping room for the cage's
width (`hz` 1.1 → 1.24 m), which can move where the chipper is parked on a
given seed. Rapier put the slowly rolling chipper to sleep (below 0.5 rad/s
for 2 s) mid-roll, so it now never sleeps (`setCanSleep(false)`; one body; its
tyre model holds it parked). Checked headless: dropped onto its roof (0°, 20°,
40° either way) and sides (90°, 120° either way) on open flat ground and
across a 6° slope, 18 of 18 ended back on its wheels, in 2.5–11.5 s. Next to
a fence or house it can come to rest leaning on it. Its chute still pokes
into the ground while it is on its roof (the chute is drawn, not a collider).
Not changed: stood on its hopper end (nose down) it still stays
there, as before; a cage over the hopper would block feeding.

**D92 — Streets are flat asphalt.** Owner (2026-11-26): the street between
blocks was grass and followed the hills; make it road coloured and flat. The
yard plan now lists its streets (`plan.streets`, strips along x the whole
width of the ground, one per street a row of lots faces) and they travel in
the terrain spec. The terrain makes each street level across, and along it
the natural ground averaged over `STREET_SMOOTH` (30 m) either way, two
passes, so hills and ledges become grades of about 2 % at most rather than a
dead-level road with deep cuts. Streets blend into the ground over
`STREET_BLEND` (3 m) and are applied after the pads, so a street stays
smooth where a house pad's blend reaches it. The view draws the street as
speckled asphalt with a dashed yellow centre line (vertex colours on the
ground grid, so the line is one 0.5 m grid row). Unreviewed: the 30 m and
3 m, the colours, the centre line, no kerbs or sidewalks along it, and the
street being as grippy as grass.

**D93 — Chip bins, and how far the job has got.** Owner (2026-11-26): a 96
gallon bin by the chipper; chips landing on it go in, players can tip chips
in by hand; no capacity, a bottomless disposal; indestructible; "Buy a new
chip bin" in the settings menu; a floppy lid that collects nothing while shut,
opened and shut by interacting with it; the handles move it. Track how much of
the target tree has been chipped and how much of the chips have been disposed
of, coloured red under 60 %, amber from 60, green from 90, blue from 99.
Built as physics: the bin is a 15 kg box with two frictionless wheel balls at
the bottom of its back and a handle bar; the lid is its own 2 kg body on a
hinge joint (Rapier's revolute limits and motor only work within ±180°, so the
hinge has none: shut, the lid lies on the rim; swung back it rests on the
handle bar, at about 198°). A press on the lid drives the hinge toward the
other end for up to 1.5 s (`BIN_LID_K`, an acceleration spring), then lets it
swing on its own with a little friction (`BIN_HINGE_DAMP`); the lid flops when
the bin is knocked, tipped or bumped by a player. The handle is held like the
chipper's grip; pulled back, the bin tips onto its wheels and rolls (a scripted
tow: 9 m in 6 s). Chips go into a bin when the point they land on (the
chipper's discharge point, or where a player puts down what they carry) is
within its mouth plus `BIN_CATCH` (0.15 m; 1 m from 2026-11-26, owner), with the bin upright and its lid
more than 1.2 rad open. They are gone (`world.prog.gone`). Progress lives in
the model (`world.prog`), counted by `world.apply` on every machine: the job
tree's mass when it grows (wood and leaves); every chipped segment that is not
a yard tree's (segments of woken yard trees carry `yd`); chips made and chips
gone into bins. Twigs swept away as debris (under `DEBRIS_MASS`) cannot be
chipped, so the tree's share is chipped / (grown − swept); the HUD shows both
shares to a tenth of a percent, rounded down. Choices the owner hasn't
reviewed: where the bin is parked (chipper-local x 1.6, z 1.7: by the drawbar
on the chute side, 1.5 m from where chips land, so it has to be wheeled under
the chute), a bought bin is put down 1.5 m in front of the buyer, its price
($100, `BIN_PRICE`), the swept-debris rule, colours (red #ff5a4e, amber
#ffb326, green #52d468, blue #5ab4ff), and "Chips in bins: none yet" before any
are made. A player standing behind an open bin pushes the lid shut (it sticks
out 0.7 m behind).

**D94 — Broken structure pieces freeze into scenery after a minute.** Owner
(2026-11-26): smashed structure pieces become permanently frozen in place and
intangible one minute after destruction, for performance. Built: every loose
body a `smash` makes (each part, and each loose group of intact modules) is
timed from that tick; at `DEBRIS_FREEZE` (60 s, Tab menu "Houses, sheds and
fences") the host emits a `freeze` event with its pose, removes the body and
its colliders, and the model keeps the pose in `b.still`, so clients and late
joiners draw it there without snapshots. A piece still moving faster than
`DEBRIS_FREEZE_V` (0.3 m/s) waits until it slows, so boards are not frozen
mid-fall or while riding a log; at twice the delay it freezes regardless. A
frozen loose group's intact modules cannot break again. Choices the owner
hasn't reviewed: frozen debris is fully intangible, so wood, players and the
chipper pass through it (the chipper still flattens standing structures and
fresh debris as before); debris resting on a log that is later dragged away
stays floating where it was; the timer runs from the smash, not from when a
piece came to rest. Checked headless: a smashed shed (40 boards) dropped from
77 to 37 Rapier bodies after the delay with every board drawn where it lay;
host, client and a late joiner agree on all 40 frozen poses (local PeerJS
server). Smoke 18 / 22 (FM-05, 12, 13, 20 fail as on main; engine tests have
no builds).

**D95 — Tube salads, buying chippers, respawn only in the menu.** Owner
(2026-11-26): the chipper reset button becomes "Buy a new chipper" and keeps
the ones there; a small rack of three green "tube salads" on the non-chute
side; interact takes one into the hand (endless supply); left mouse eats it,
interact gives it to another player; either restores full health, even DOWN;
no "job failed" with DOWN; no key or phone button for respawn, a Respawn
player button in the Tab menu. How: several chippers (`world.chipper.units`,
`sim.chipper` a manager, each with its own feed and tyres); the menu buttons
are input counters (`buyChip`, `respawn`, as D93's `buyBin`) so joined players
can press them; the salad is `{eat}` in prompts so touch shows an "Eat salad"
button (keyboard and pad: left mouse / RT). Healing sets `ok` and clears the
shaken pause; it is not physics, there is nothing to derive it from. Choices
the owner hasn't reviewed: price $5,000 (`CHIPPER_PRICE`; the wreck still costs
`CHIPPER_COST` $45,000), at most 6 (`CHIP_MAX`), where a bought one parks
(nearest clear spot round the first one's spot, rack side first; dropped in
from 2.5 m beside it if nowhere is clear), a downed player cannot eat a salad
they hold (someone else has to), the rack sits inside the roll cage and has no
collider, one salad in hand at a time, the salad drawn low right in first
person.

**D96 — Wood in the ground is lifted at a fixed speed, not sprung out.**
Owner (2026-11-26): the push out of the ground (D88) is too aggressive.
Instead, wood found inside the ground should get a fixed upward velocity for
a set time, starting at the chipper rollers' speed for 0.2 s at a time, as
needed. So the spring and its three tunables are gone. When a body has a
segment inside the ground, its upward velocity is raised to at least
`GROUND_LIFT_V` (0.6 m/s, `CHIP_FEED_V`) for `GROUND_LIFT_TIME` (0.2 s). If it
is still in when that time ends, another lift starts. Its spin and sideways
velocity are left alone. A first try raised only the sunk point to 0.6 m/s,
correcting for the body's spin. On a pivoting branch that drove the body up at
2.9 m/s and spun it at 18 rad/s, so the whole body is lifted instead. The
sunk segment still stops colliding with the ground until its axis is back
above it (D88).

Headless, with a 25 kg branch put down with its butt 0.3 m under:
- It is out within 3 s and drags as on open ground.
- Its upward speed peaked at 0.44 to 0.86 m/s; the spring gave 0.57 to 0.6.
- Its overall speed peaked at 1.4 to 1.7 m/s as it fell flat; the spring
  gave about 0.6.

Felling whole trees on two seeds, the 11.6 t tree got two lifts in 40 s and
came to rest.

**D97 — Damaging the neighbours' trees costs money.** Owner (2026-11-26):
enact a monetary penalty for damage to non-target trees. Built in
sim/damage.js, through the same `damage` event and toasts as the structures.
Only a yard tree that has woken into wood (D74) can be damaged; a dormant one
has nothing to hurt. Three charges, all placeholders the owner has not
reviewed: sawing costs `YARD_CUT_COST` ($3,000) per m² of cross-section sawn
through, each fibre counted the first time it is severed (a second kerf
through the same fibre is free), added up and charged once the saw has been
out of that tree for `YARD_CUT_QUIET` (1.5 s); wood that comes off the tree for
good (a piece no longer held to the rooted tree by any live bundle, checked
four times a second) costs `YARD_LOSS_COST` ($3/kg, wood and leaves), with any
sawing not yet charged folded into the same toast; and the first time half
the tree's wood has come off it counts as felled, `YARD_FELL_COST` ($5,000)
once. So a tree is not charged twice for one fell, and cutting up a fallen
yard log costs nothing more. Damage from any cause counts (a job tree landing
on an awake yard tree and breaking a limb is charged too). Toast wording
says "a neighbour's tree". At defaults a 12 m yard tree felled costs about
$12,000 of a $30,000 budget. Not done: twigs swept away as debris within the
same quarter second they broke off are not charged.

D93 follow-up (owner, 2026-11-26): the bin's mouth z-fought (the black rim band's
top shared a plane with the body's top face): the body mesh now has no top face
and the rim sits 5 mm lower. Let go of (by hand or pulled out of the hands),
the bin stands itself back up for `BIN_RIGHT_T` (3 s): a damped spring on its
lean (`BIN_RIGHT_K` 30 /s², at most `BIN_RIGHT_MAX` 300 N m) about the axis it
leans over, pivoting on whatever it rests on. Headless: released tipped well
back after a tow, it was upright (up·y 0.99) in about 4 s. Unreviewed: only
after a release, not when knocked over by wood (it lies where it lands until
someone grabs and lets go of it).

**D98 — A far tree line round the horizon.** Owner asked for darkness low in
the sky, about as high as trees grow, so the yard reads as a forest valley
rather than a mountaintop. It is drawing only (`view/sky.js`): a ring round
the eye just inside the far plane, carrying a silhouette of overlapping crowns
(pointed and round, about one per 7 m) `FOREST_HEIGHT` (25 m) tall at
`FOREST_DIST` (300 m), over a hazier, taller ridge of hillside wood behind.
Its colour is the sky's colour darkened by `FOREST_DARK` (0.65), plus a touch
of green by day, so it follows dusk, cloud and night and can never glow. The
lowest `FOREST_MIST` (0.45) of it fades back into the sky's colour, which is
also the fog's, so the fogged ground meets it without a seam and the valley
floor reads as haze. It is placed by the eye's height above y = 0, so climbing
lowers it. Sun, moon and stars are drawn first so they set behind it, and the
stars low in the sky are hidden by it at night. Unreviewed choices: all four
numbers, the crown spacing, the ridge shape (fixed sines, the same for every
seed), and that it is a picture at a fixed distance rather than geometry.

**D99 — A quieter HUD that stacks on phones.** Owner (2026-11-26, phone
screenshot): hide network debug info unless switched on, and stop the HUD
lines overlapping on mobile. `NET_STATS` (Tab menu, View: "Network and debug
info on the HUD") now defaults off and covers more than the network box: fps,
the draw-distance note, the wage math after the cash, and ping / loss on a
joined client's status line all hide with it (the wage math stays in the Tab
menu's job section). The room code and who joined stay, since players need
them. Layout: the status and progress lines live in one top-left flex column
(`#top`), so a line that wraps pushes the next down instead of drawing over
it. With the touch controls up, `hud.stack` moves the prompt, rope line,
network box and toasts into that column too, in that order, and the column
stops 62 px short of the right edge to stay clear of the gear. Unreviewed
choices: which figures count as debug, and keeping "on the ground | ok" on the
status line.
D100 (owner, 2026-11-26): a climber who came down to the ground glitched into
it and was often hurt or downed. Cause: a climber is a kinematic body placed
beside the stem, and on uneven ground (or at the stem's foot) that place can be
inside the terrain or pressed against the trunk; switching it to a dynamic body
let Rapier push it out at speed, which `post` read as an impact. Now reaching
the ground lands the climber instead (`players.land`): the lanyard comes off
and they are put down standing `LAND_DIST` (4 m, the spawn ring's radius) from
the stem on the side they were climbing, at `SPAWN_HEIGHT` (1.2 m, the old
respawn height) over the ground, with zero velocity, so no impact. Reaching the
ground means either stepping off the bottom of the wood (as before) or, while
moving on the spurs, the feet coming within 5 cm of the ground under them and
getting closer. The spot is the nearest one clear of anything but the ground
(a capsule query), swinging round the stem in steps and then further out; the
Respawn button and falling out of the world use the same search round the
player's own spawn point. Unreviewed: the 4 m, landing while riding a falling
piece is unchanged (that is still an impact), a toast says the lanyard is off.
