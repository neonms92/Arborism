# Status

Last updated after the fibre / saw / lanyard / first-person rework.
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
| Page | Loads with a clean console; starts in first person with the fibre debug view on. |
| Fibres everywhere | Every segment has a bundle (≈ 2000 fibres on the demo tree), solved every tick, drawn and coloured per fibre: yellow → red (compression), → blue (tension), → green (bending in a live bundle), dark (snapped). Tab / Back switches to bark. |
| Overload | A 400 kg test load far out a limb: bundle goes live, limb bends ~0.25 rad on stretched fibres, the next bundle in goes, it comes free; climber rides it down at free-fall speed and is hurt. |
| Limb cuts (direct fibre severing) | Top cut only: bottom fibres hold as a strap and the limb swings. Undercut then top cut: parts clean. |
| Felling (direct fibre severing) | Notch toward the lean + back cut: tips over on an 11-fibre hinge over ~2.5 s, fibres snap progressively, comes free, lands along the notch line. Back cut against the lean: kerf closes (pinch), tree stands. Straight through: free, slides off toward the lean. |
| Free-form saw (through input) | Raise, throttle, sweep with the swing angles: bar rests on wood, severs the fibres it touches after `CUT_TIME`, advances. Cuts the rigging rope and lanyards (including the user's own → fall). |
| Lanyard (through input) | Spur in = lanyard on. Stops at unions. Hands + interact on another stem moves it there. Let go = fall. |
| Rigging | Block, tie-off, friction device as before. 55 kg limb with 1 m slack peaks ≈ 5.3 kN, is caught, and lowers when the tail is eased. Rope is a 3-D tube. |
| Network | Host, client and a late joiner agree on fibres cut, pieces, live bundles and rope. Tested against a **local** PeerJS server only. |
| Controls text | Lobby help, HUD hint line, prompts and toasts name keys or buttons for the device last touched. |
| Look | First person. Vertical look inverted (`INVERT_Y`). |

Sim cost on the dev machine: ≈ 0.1 ms per step idle, ≈ 0.2 ms with the saw
against the trunk; colouring all fibres ≈ 0.2 ms. Rendering has only run in
software GL.

## What is rough

- **Saw feel is a guess.** Sweep sensitivity (half a turn per screen width),
  `CUT_TIME`, `BAR_SPEED`, where the hands hold it (`SAW_HOLD`) — all untried
  by a person. The bar is a rod and cuts in any direction it is pushed
  (DECISIONS D21); there is no roll.
- The saw's pinch only works on stiff bundles. A bar in a *live* bundle's
  kerf is never clamped. A pinched bar can simply be backed out.
- The scripted felling and limb tests sever fibres directly in a plane; the
  free-form saw has been verified to cut, but nobody has made a real notch
  with it yet. It may turn out to be fiddly to line two cuts up.
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
  percent of its strength). `COLOR_GAMMA` lifts them; lower it for more.
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
- **Branches:** the kickoff branch was renamed to `main` on GitHub. This
  rework is on `ccr-7d8cc9c2-99719w` and is not on `main` until merged
  (D29). Pages must point at whichever branch should be live.

## Known broken / not built

- Bucking: bundles on fallen pieces carry no load, so every cut on the
  ground is a plain cut-through (task P2-3).
- Fallen pieces never break on landing.
- A trapped saw does not stay in the tree (task P2-2).
- One rigging line; no climbing line; no natural-crotch rigging.
- Injury `DOWN` is a toast and a tipped-over capsule; Start / Enter respawns.
- No sound. No settings screen (inverted look and the debug view are config
  flags).

## Next task

**P2-1 in DESIGN.md section 9: play it and tune `config.js`.** First things
to try with a real mouse and a real gamepad:

1. Is swinging the saw comfortable, and can a notch be made with it?
2. Does a notched trunk go where the notch points? Adjust `FIBRE_STRETCH`.
3. Are the fibre colours readable at normal loads? Adjust `COLOR_GAMMA`.

Then Phase 3 in order: P2-2, P2-3, P2-4, …
