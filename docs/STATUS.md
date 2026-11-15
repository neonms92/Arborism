# Status

Last updated at the end of the foundation session. Keep this file current.

## How things were checked

There is no test suite (owner's choice). Everything below marked "verified"
was exercised in headless Chromium by scripts that drove the real sim, either
through the same input structure a gamepad produces or by calling the sim
directly. **Nothing has been played by a human or run on a Steam Deck yet.**
Feel, camera, control comfort and tuning are therefore unknown.

## What works (verified)

| Prototype step | State |
|---|---|
| 1. Skeleton: ground, tree, camera | Loads with a clean console. |
| 2. Two browsers, same physics | Host + client + late joiner agree on pieces, kerfs, rope and transforms. Client input drives its own avatar on the host. Tested against a **local** PeerJS server (`?signal=`), not the public one. |
| 3. Branches break from load | Beam analysis → section tear → hinge → release. A climber's weight, rope loads and impacts all feed it. Overloading a limb gives crack → hinge → swing → break; the climber falls (or rides it if lanyarded) and takes an injury state from the impact speed. |
| 4. Spurs and lanyard | Spur in at the base, climb along/around stems, pick branches by looking, clip/unclip; lanyard stops at unions; saw needs the lanyard; step off; fall injuries. |
| 5. Chainsaw | Aim → precision mode → slide/rotate/tilt → feed. Top cut only = limb hinges on the bottom strip and swings; undercut + top cut = clean drop; notch + back cut = trunk hinges over and releases when the notch closes; back cut against the lean = saw pinches; cut straight through = no control. |
| 6. Rigging | Block + tie-off + friction device. Snug rope ≈ 1.9 kN peak on a 55 kg limb, 1.5 m slack ≈ 5.3 kN. Tied off when unattended; a ground player takes the tail, sets wraps, eases to lower, hauls to take up slack. Rope loads go into the tree's stress analysis. |

Sim cost on the dev machine: ≈ 0.1 ms per step, including with seven fallen
limbs. Rendering was only run in software GL, so real frame rate is unknown.

## What is rough

- **Unverified against the public PeerJS server** (`0.peerjs.com` was blocked
  in the dev sandbox). If Host says "Could not reach the signaling server",
  that is this. See DESIGN.md risks 1–2 and DECISIONS D11.
- **Not deployed by me.** Pages must be switched on in repo settings
  (CLAUDE.md → Deploy). The work is on branch `ccr-7d8cc9c2-99719w`.
- Tuning is first-guess. All numbers are in `src/config.js`. Likely first
  knobs: `MOR`, `COMP`, `FEED`, `PINCH_STUCK`, `HINGE_RESIST`, `ROPE_MU`,
  `GRIP_MAX`, `DV_*`.
- Section grid is 17 cells across, so hinge thickness moves in ~6 % steps.
  A hinge is "one row" or "two rows". Raise `GRID` if that feels coarse.
- Camera: no collision, foliage can fill the view when climbing in the
  crown. Third-person aim is offset over the right shoulder, so the
  crosshair ray is not through the player.
- Visuals are placeholders: players are capsules and do not face the stem
  when climbing; the lanyard is only a yellow belt; the rope is a 1 px line;
  torn wood has no special look; kerfs are thin dark fans.
- Rope spans are straight lines and pass through branches (by design, D5).
  A hanging piece can rest against the trunk and read a higher tension than
  its weight.
- A hinged piece has collisions with its parent piece switched off until the
  hinge breaks (by design); it can visibly pass through the stump.
- A side-leaning trunk can end up standing on a few crushed fibres with the
  saw pinched and nothing more the player can do (no wedges or pull line
  yet — task P2-6).
- Clients feel their ping in their own movement (no prediction, D3).
- Host tab hidden = game paused for everyone (task P2-8). A toast says so
  when the host comes back.
- `players.impact` for a climber hit by a falling piece uses contact force ×
  dt / mass; not yet seen in a real scenario.
- Injury `DOWN` only shows a toast and tips the capsule over; Start/Enter
  respawns. No job-failed state yet.

## Known broken / not built

- Bucking on the ground: sections on fallen pieces carry no load, so every
  cut is a plain cut-through (task P2-3).
- Stuck saw does not stay in the tree; the saw cannot cut ropes (task P2-2).
- Only one rigging line; no climbing line; no natural-crotch rigging.
- Dynamic pieces never break on landing.
- No sound.

## Next task

**P2-1 in DESIGN.md section 9: play it on a real Steam Deck and tune
`config.js`.** Before that, the owner needs to (1) enable GitHub Pages and
(2) try Host/Join over the public signaling server with a second device.
If hosting fails at step 2, the first code task is P2-10 (lobby errors) plus
choosing a signaling fallback (DECISIONS D11).

After that, take Phase 3 tasks in order: P2-2, P2-3, P2-4, …
