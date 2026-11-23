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

**D13 — Kerfs close only when the wood beside them crushes.** First version
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

