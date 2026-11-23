# Status

Last updated after the fourth round of owner feedback (fibres that change
length, tree generation settings, regrow).
Keep this file current.

## How things were checked

There is no test suite (owner's choice). Everything marked "verified" was
exercised in headless Chromium by scripts driving the real sim — through the
same input structure a gamepad or mouse produces where noted, otherwise by
calling the sim directly. **Nothing has been played by a human or run on a
Steam Deck.** Feel, comfort and tuning are unknown; in particular nobody has
yet swung the saw with a real mouse.

## What works (verified)

| Area | State |
|---|---|
| Page | Loads with a clean console; starts in first person with fibres drawn and bark hidden. |
| Fibres everywhere | Every segment has a bundle (≈ 2000 fibres on the demo tree), solved every tick, drawn and coloured per fibre: yellow → red (compression), → blue (tension), → green (bending in a live bundle), dark (snapped). |
| Bending | Every fibre stretches or shortens with the force on it (separate tension and compression deformation); each segment's end disc is placed and tilted from its fibres' lengths; severed fibres do not count; loads are taken on the bent shape, so tilt can cascade. Demo limb tip: ≈ 3 cm low at rest, ≈ 11 cm with an 85 kg climber far out, ≈ 60 cm with both deformations at 3 %. Back-cutting 80 % of the trunk with no notch: the lean fed itself and the worst fibre went from 8 to 30 MPa with no further cutting. Fibres are drawn individually between their own ends. Clients compute the same shape. |
| New tree | Height, trunk diameter, branch density, branch length, fibre density, fibre segment length and seed are in the Tab menu; "Clear all wood and grow a new tree" rebuilds the world from them. Host, client and late joiner agree afterwards. Tried: an 18 m, 0.9 m, dense tree (capped at ≈ 900 segments, 13 000 fibres, ≈ 3 ms per step) and a 6 m sapling with 21 fibres across. |
| Lanyard union length | In the menu ("Shortest branch that stops the lanyard"). |
| Overload | A 400 kg test load far out a limb: bundle goes live, limb bends ~0.25 rad on stretched fibres, the next bundle in goes, it comes free; climber rides it down at free-fall speed and is hurt. |
| Limb cuts (direct fibre severing) | Top cut only: bottom fibres hold as a strap and the limb swings. Undercut then top cut: parts clean. |
| Felling (direct fibre severing) | Notch toward the lean + back cut: tips over on an 11-fibre hinge over ~2.5 s, fibres snap progressively, comes free, lands along the notch line. Back cut against the lean: kerf closes (pinch), tree stands. Straight through: free, slides off toward the lean. |
| Saw (through input) | Plant on the wood looked at (bar across the stem, feed toward its heart); press feeds it in and severs fibres at `CUT_RATE`; pivoting swings the bar in the cut and tilts the cut plane. A square cut pressed and pivoted through the trunk took ≈ 15 s and the tree came down. Plants on a rope when looking at one and cuts it; cuts lanyards. |
| Fibre drawing | Fixed: fibres were drawn mis-rotated on every stem that was not near-vertical (crown looked disconnected). They now sit exactly where the physics has them. |
| Bark | Built from the fibres: a kerf is a slot, a notch is a missing wedge with pale wood inside. `Bark visibility` in the menu blends bark over fibres. |
| Tab menu | Sliders + number boxes for sensitivity, inverted look, bark/foliage/fibre display, fibre strengths, cutting rate, climber and rope values. Changes apply live and persist across reloads. |
| Lanyard (through input) | Spur in = lanyard on. Stops at unions. Hands + interact on another stem moves it there. Let go = fall. |
| Rigging | Block, tie-off, friction device as before. 55 kg limb with 1 m slack peaks ≈ 5.3 kN, is caught, and lowers when the tail is eased. Rope is a 3-D tube. |
| Network | Host, client and a late joiner agree on fibres cut, pieces, live bundles and rope. Tested against a **local** PeerJS server only. |
| Concrete pavers (D50) | Basket weave in a circle of half the tree height (5.5 m on the demo tree). Numbers below were measured on an earlier, larger square: A player dropped from 1 m: no damage; from ≈ 4 m: 4 units on one paver and DOWN. A 93 kg limb cut at 4 m: 2 units. Felled demo tree: the crown tip hit one paver for 28 units. Cracks at 1, 2, 4, 8, 14, 20, 27 units grow as intended; 35 and 80 are gravel. Host, client and a late joiner agree on damage and draw the same cracks. Headless only. |
| Controls text | Lobby help, HUD hint line, prompts and toasts name keys or buttons for the device last touched. |
| Look | First person. Vertical look inverted (`INVERT_Y`). |

Sim cost on the dev machine: ≈ 0.1 ms per step idle, ≈ 0.2 ms with the saw
against the trunk; colouring all fibres ≈ 0.2 ms. Rendering has only run in
software GL.

## What is rough

- **Bending is quasi-static.** The shape follows the fibres' strains through
  a damped spring per segment (bounce speed and damping are in the menu); it
  is not inertia, so a limb does not keep swaying like a real one, and there
  is no wind. Fallen pieces do not deform.
- Fibres are straight between the two flat discs at their segment's ends.
  They lean, stretch and shorten individually, but do not curve or buckle
  on their own; finer bending comes from a shorter fibre segment length.
- A severed fibre is out for its whole segment, so with long segments a cut
  weakens (and bends) a long stretch of stem.
- Extreme tree settings are only lightly guarded: very dense or very long
  branches hit the segment cap, and a tree can still be grown that sheds a
  twig or two under its own weight. Many fibres across a big tree is slow.
- Growing a new tree leaves players where they stand (anyone climbing is
  put on the ground); it does not clear injuries.
- Sawing into bent wood has only been checked for errors, not for feel.
- **Saw feel is still a guess.** Nobody has used it with a real mouse. The
  pivot directions (which way left/right and up/down turn the bar) were
  chosen by reasoning, not by feel. Sensitivity and cutting rate are in the
  Tab menu.
- A notch has not been made by hand yet. The scripted felling and limb tests
  still sever fibres directly in a plane.
- The bar is 0.5 m and the trunk is 0.52 m across, so one press does not
  cross the trunk: pivot, or come at it from both sides.
- The saw's pinch only works on stiff bundles, and a pinched bar can simply
  be lifted off.
- The menu cannot be driven with a gamepad (touch or mouse only). On the
  Deck use the touchscreen.
- Menu changes to wood strength apply to the standing tree immediately:
  dropping `Tension strength` far enough makes limbs let go on the spot.
- Bark and fibres are both flat-shaded boxes and panels; where bark is
  semi-transparent it does not sort perfectly against foliage.
- The hinge on the demo trunk breaks at ≈ 0.4 rad of lean, before a 50° notch
  closes. `FIBRE_STRETCH` sets this. The notch-closing path (closed faces
  becoming the pivot) is in and stable but has only been seen with the
  earlier, smaller stretch value.
- A live bundle never goes back to stiff. A cracked limb stays a separate
  body for good. Several live bundles in a chain are only loosely coupled
  (DESIGN.md risk 7).
- Pieces joined (or just un-joined) by a live bundle do not collide at the
  joint, so a butt can sink through its stump.
- Fibre colours are faint at everyday loads (a healthy tree is at a few
  percent of its strength). "Load colour contrast" in the menu lifts them.
- First person: the camera can clip into the trunk when pressed against it;
  the player's own body is not drawn; foliage is ghosted in the debug view
  and opaque in bark view.
- A climber is a force on the wood, not a mass. Their weight fades as the
  wood under them accelerates (so it cannot be driven faster than free
  fall), which is a patch, not physics.
- Rope spans are straight lines and pass through branches (D5).
- Clients feel their ping in their own movement and in the saw (D3).
- Host tab hidden = game paused for everyone (task P2-8).
- **Unverified against the public PeerJS server** (blocked in the dev
  sandbox). See DECISIONS D11.
- **Branches:** work is pushed to `ccr-7d8cc9c2-99719w`; `main` gets it when
  the owner merges (the previous round was merged as PR #1).

## Known broken / not built

- Bucking: bundles on fallen pieces carry no load, so every cut on the
  ground is a plain cut-through (task P2-3).
- Fallen pieces never break on landing.
- A trapped saw does not stay in the tree (task P2-2).
- One rigging line; no climbing line; no natural-crotch rigging.
- Injury `DOWN` is a toast and a tipped-over capsule; Start / Enter respawns.
- No sound.
- Pavers: gravel is still flat to the physics, nothing scatters or moves,
  and wood resting on a log on the pavers passes no impact to them.

## Next task

**P2-1 in DESIGN.md section 9: play it and tune `config.js`.** First things
to try with a real mouse and a real gamepad:

1. Is planting and pivoting the saw comfortable, do the pivot directions
   feel right, and can a notch be made with it?
2. Does a notched trunk go where the notch points? Adjust `FIBRE_STRETCH`.
3. Are the fibre colours readable at normal loads? Adjust the contrast
   slider.

Then Phase 3 in order: P2-2, P2-3, P2-4, …
