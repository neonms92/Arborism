# Status

Last updated after the engine tests (Testing menu, docs/TESTS.md) and the
fifth round of owner feedback (ESDF controls, no tools, held lanyard / let
go, punch).
Keep this file current.

## How things were checked

The fibre model now has automated tests: main menu → Testing, or headless
`?test=all&mode=must` (docs/TESTS.md section 8). The rest of the game still
has none. Everything marked "verified" below was
exercised in headless Chromium by scripts driving the real sim — through the
same input structure a gamepad or mouse produces where noted, otherwise by
calling the sim directly. **Nothing has been played by a human or run on a
Steam Deck.** Feel, comfort and tuning are unknown; in particular nobody has
yet swung the saw with a real mouse.

## What works (verified)

| Area | State |
|---|---|
| Page | Loads with a clean console; starts in first person with bark on and foliage at 0.7 (the test viewer starts with bark hidden, D64). |
| Fibres everywhere | Every segment has a bundle (≈ 2000 fibres on the demo tree), solved every tick, drawn and coloured per fibre: yellow → red (compression), → blue (tension), → green (bending in a live bundle), dark (snapped). |
| Bending | Every fibre stretches or shortens with the force on it (separate tension and compression deformation); each segment's end disc is placed and tilted from its fibres' lengths; severed fibres do not count; loads are taken on the bent shape, so tilt can cascade. Demo limb tip: ≈ 3 cm low at rest, ≈ 11 cm with an 85 kg climber far out, ≈ 60 cm with both deformations at 3 %. Back-cutting 80 % of the trunk with no notch: the lean fed itself and the worst fibre went from 8 to 30 MPa with no further cutting. Fibres are drawn individually between their own ends. Clients compute the same shape. |
| New tree | Height, trunk diameter, branch density, branch length, fibre density, fibre segment length and seed are in the Tab menu; "Grow tree" rebuilds the world from them. Host, client and late joiner agree afterwards. Tried: an 18 m, 0.9 m, dense tree (capped at ≈ 900 segments, 13 000 fibres, ≈ 3 ms per step) and a 6 m sapling with 21 fibres across. |
| Lanyard union length | In the menu ("Shortest branch that stops the lanyard"). |
| Overload | A 400 kg test load far out a limb: bundle goes live, limb bends ~0.25 rad on stretched fibres, the next bundle in goes, it comes free; climber rides it down at free-fall speed and is hurt. |
| Limb cuts (direct fibre severing) | Top cut only: bottom fibres hold as a strap and the limb swings. Undercut then top cut: parts clean. |
| Felling (direct fibre severing) | Notch toward the lean + back cut: tips over on an 11-fibre hinge over ~2.5 s, fibres snap progressively, comes free, lands along the notch line. Back cut against the lean: kerf closes (pinch), tree stands. Straight through: free, slides off toward the lean. |
| Saw (through input) | Plant on the wood looked at (bar across the stem, feed toward its heart); press feeds it in and severs fibres at `CUT_RATE`; pivoting swings the bar in the cut and tilts the cut plane. A square cut pressed and pivoted through the trunk took ≈ 15 s and the tree came down. Plants on a rope when looking at one and cuts it; cuts lanyards. |
| Fibre drawing | Fixed: fibres were drawn mis-rotated on every stem that was not near-vertical (crown looked disconnected). They now sit exactly where the physics has them. |
| Bark | Built from the fibres: a kerf is a slot, a notch is a missing wedge with pale wood inside. `Bark visibility` in the menu blends bark over fibres. Fitted around the fibre boxes as drawn (D64): no fibre shows through on thin twigs (checked on every segment of the demo tree). |
| Tab menu | Sliders + number boxes for sensitivity, inverted look, bark/foliage/fibre display, fibre strengths, cutting rate, climber and rope values. Changes apply live and persist across reloads. |
| Draw distance (D73) | `DRAW_DIST` (150 m) is the far plane. While the smoothed frame rate is under `DRAW_FPS` (40) it rides down towards `DRAW_DIST_MIN` (50 m) and grows back once over by 10%; the HUD shows the distance while it is cut. Sky-coloured fog from `FOG_START` (0.3) of the distance hides the clipped edge; `AUTO_FOG` off removes the fog. All in the Tab menu under View. Headless (software GL, ~10 fps): fell to 50 m, came back when the target was lowered, a joined client adapts on its own. Not tried on real hardware. |
| Day, night and moon (D76) | Host clock, 20 min a day by default (`DAY_LENGTH`), synced to clients in aux. Sun and moon cross the sky; the moon goes through 8 phases (`MOON_DAYS`) and moonlight and night glow scale with how much of it is lit; stars at night; sky and fog colour follow the time of day. Headlamps on every player at night. Tab menu: Day, night and moon (with a skip-ahead button). Headless: full, crescent and new-moon nights drawn as intended, a joined client stayed within a second of the host's clock and lit both headlamps. Not tried on real hardware. |
| World seed (D82) | One word (random eight letters, alternating consonants and vowels, rerolled past a rough word filter) drives the tree, ground and yards. Lobby and Tab menu boxes, New button, "This world" line. Checked headless: the word sets all three seeds; host and client (local PeerJS) agree on the world and both menus show the host's word; smoke 18 / 22 (FM-05, 12, 13, 20 as before). Clouds drift at 0.6 m/s. |
| Streets (D92) | Asphalt-coloured with a dashed centre line, level across and at most about a 2 % grade along (seed bamitoro and a test spec), blending into the hills over 3 m. Host and a joined client build the same streets. Smoke 18 / 22 as before (FM-05, 12, 13, 20). |
| Clouds (D79) | Host drifts cloud cover between clear and overcast (`CLOUDS` -1) or holds it (`CLOUDS` 0..1), sent with the clock. Cover dims sun and moon light, softens shadows, greys the sky and fog, hides sun, moon and stars, and thickens a drifting cloud layer. Tab menu: Day, night and moon. No rain. Headless: clear, broken, overcast, sunset and night all render as intended. |
| Far tree line (D98) | A dark band of tree crowns round the horizon, with a hazier ridge behind, so the yard reads as a clearing in a wooded valley. Its colour is the sky's darkened (`FOREST_DARK`), so it is dark at night and silhouetted at dusk; its foot fades into the fog. `FOREST_HEIGHT` 25 m at `FOREST_DIST` 300 m (about 5 degrees), `FOREST_MIST`. Tab menu: Day, night and moon. Headless: day, dusk, night and overcast render as intended. Not tried on real hardware. |
| Lanyard (through input) | Spur in = lanyard on. Stops at unions. Hands + interact on another stem moves it there. Let go = fall. Reaching the ground takes the lanyard off and puts you down standing 4 m from the stem, clear of everything, with no fall (D100). |
| Rigging | Block, tie-off, friction device as before. 55 kg limb with 1 m slack peaks ≈ 5.3 kN, is caught, and lowers when the tail is eased. Rope is a 3-D tube. |
| Network | Host, client and a late joiner agree on fibres cut, pieces, live bundles and rope. Tested against a **local** PeerJS server only. |
| Concrete pavers (D49) | Basket weave in a circle of half the tree height (5.5 m on the demo tree). Numbers below were measured on an earlier, larger square: A player dropped from 1 m: no damage; from ≈ 4 m: 4 units on one paver and DOWN. A 93 kg limb cut at 4 m: 2 units. Felled demo tree: the crown tip hit one paver for 28 units. Cracks at 1, 2, 4, 8, 14, 20, 27 units grow as intended; 35 and 80 are gravel. Host, client and a late joiner agree on damage and draw the same cracks. Headless only. |
| Tube salads, more chippers (D95) | Headless (Playwright, solo with a second player added on the host): looking at the rack, R took a salad (prompt "take salad"), left mouse ate it and HURT went to ok; another salad given with R to a DOWN second player brought them to ok with one toast. Phone (Pixel 7 emulation, ?touch): Action said "Take salad", then an "Eat salad" button appeared and a tap ate it. Buy a new chipper: cash -$5,000, a second and third chipper parked 5-6 m from the first, clear of fences and the house; grabbing chipper 2's grip towed it (its brakes off); wrecking it left chipper 1 whole; a world packed for a joiner kept both units and the spend. Respawn player from the Tab menu got a DOWN player up. Not checked: two real tabs over PeerJS (no local PeerServer here), feeding wood into a bought chipper. |
| Wood chipper (D57, D58, D63, D66, D67, D70, D91) | Parked 3 m outside the paving, hopper toward the tree. Holding loose wood, R at the chipper feeds it: a 25 kg limb went in and was chipped in ≈ 2.5 s, leaving a 0.07 m³ pile. A rigging line tied to it went into the rollers when its knot reached the drum; with the rope over a block 4.7 m up the trunk, the rollers dragged the 600 kg chipper 9 m to the trunk and hoisted it 2.2 m, holding 15 kN until the rope came free. Cutting the fed rope, taking the block down, or the block's limb tearing off each ended the feed, and the rest of the rope went into the chipper. A new tree put it back, with no chips and no rope, and fresh pavers. R at the grip tows it (1.7 m in 5 s from rest, turns about its axle); let go and the brakes hold it. Host, client and a late joiner agree on piles, the fed rope and the chipper's pose. Headless only. Feeding pulls wood to the hopper mouth first, then down the throat. A limb started 2.2 m beside the truck was only chipped inside it. Picking up chips: 40 L came off a pile with R, and R again put them down. A 1 t log dropped 4 m on the chipper crumpled it into 17 loose parts (256 kN against 120 kN). Being dragged into the trunk by the rope feed (66 kN) did not. Respawn chipper in the Tab menu gave a whole one back and kept the piles. With the capacity set just under a 25 kg limb, the rollers seized at the drum and held it still (under 0.08 m in 2 s) with one toast; splitting it into 7 kg and 9 kg parts let the inner part chip at once and dropped the sawn-off outer part. Dropped 0.3 m onto the paving it cracked one paver, from 1.5 m two; parked, respawned or rolled across it, none. Dropped on the shed it smashed it. Fed from 1.2 m behind the mouth: 5 kg and 25 kg branches, an 81 kg log and a 136 kg limb all chipped completely with the wood peaking at 1-4 m/s (before D70: flung at 42-58 m/s, and the log and limb never went in); a 307 kg log went in and seized. Self-righting (D91): a roll cage dome and a low centre of mass; dropped on its roof or side on open ground (flat or a 6° slope) it rolled back onto its wheels 18 of 18 times, in 2.5–11.5 s; on its hopper end it still stays. |
| Chip bins and progress (D93) | A 96 gal bin is parked by the chipper's drawbar on the chute side. {interact} on the lid swings it open (it comes to rest on the handle bar, ≈ 198°) or shut; it flops when the bin is shoved. {interact} on the handle bar holds it; walking away tips it onto its wheels and tows it (9 m in 6 s). Chips landing in an open bin's mouth (bin wheeled under the chute) went in: 9.6 kg branch, 0.027 m³ made, 0.027 m³ gone, no pile; shut, they made a pile as before. Carrying chips at an open bin, {interact} tips them in; at a shut one it opens the lid. Tab menu "Buy a new chip bin" puts one down in front of whoever pressed it (a joined client's press worked). HUD under the status line: "Tree chipped x %" and "Chips in bins y %", red / amber / green / blue at 60 / 90 / 99 %. Host, client and a late joiner agree on bins, lid poses and progress (local PeerJS server). Smoke 18 / 22 as on main. Headless only. |
| Shed (D59) | Put up 3 m outside the paving opposite the chipper's chute, door toward the tree: 40 boards, one module. A 127 kg log dropped 3 m onto the roof (62 kN) smashed it (boards then landed up to 4.4 m away with the D59 scatter kick, since removed); dropped 0.5 m (27 kN) it still broke; a 42 kg log from 1 m (12.5 kN) did not. Two sheds glued one on the other (kind `stack`, console only): a log thrown into the lower one smashed it, the upper one fell intact and broke where it landed. A new tree put it back intact. Host, client and a late joiner agree on where the boards are. Headless only. |
| Fences (D60) | A run each of two-rail (4 sections), split rail (3) and 6 ft privacy (4), 3 m outside the paving. A 127 kg log dropped 3–4 m on a section broke that section only (50 kN); a 42 kg log from 1.6 m (8.5 kN) broke nothing. Broken modules (shed and fences) now slump with no scatter kick (D60). A new tree puts them back. Headless only. |
| Ground: hills and ledges (D62) | A seeded height field (200 m, 0.5 m cells) with hills, winding 0.8 m ledges that ease into walkable slopes in places, and level pads for the tree's yard, the shed and the chipper. Settings under "Ground" in the Tab menu, applied by Grow. The collider matches `heightAt` to 2e-5 m over 2000 rays. Sticks, poles and logs dropped at 0–20 m/s on about 20 steep spots per run, 4 runs: none fell through (they did before soft CCD). The tree cut straight through on 13 grounds lands on the slopes; the worst wood point was under 0.05 m into the ground on 12 of them and 0.32 m (a thin twig tip, pressed in under the crown) on one. A walker crossed 58° ledge faces; stepping off one ledge shook them once. Jumping again while sliding on a ledge face (D68): 23 of 30 scripted ledges climbed by walking at them and jumping every 0.4 s; about a third of tries got briefly shaken by hitting the face or falling back; shed walls still can't be jumped up. A log dropped on the privacy fence on a slope broke 3 sections, boards settled on the ground. Chipper settles on its wheels on its pad. Solid ground (D88, D96): a branch put down with its butt 0.3 m under the surface was lifted out at 0.6 m/s within 3 s and dragged normally (before: it sank to 0.9 m and a pull of 1.5 times its weight barely moved it); full-tree fells on 3 seeds land as before. Host, client and a late joiner build the same ground, also after Grow with a new seed (local PeerJS server). Engine tests keep flat ground; smoke run 18 / 22 before and after (FM-05, 12, 13, 20 fail as before). Headless only. |
| Debris freezes (D94) | Loose boards and groups from a broken structure become scenery `DEBRIS_FREEZE` s (60) after the break, once slower than 0.3 m/s (at 120 s regardless): no body, no collision, drawn where they lie. Smashed shed: 77 → 37 Rapier bodies. Host, client and late joiner agree on the frozen poses (local PeerJS server). Smoke 18 / 22 as before. Headless only. |
| Yards (D65, D69) | The tree's lot is now an ordinary lot (width 26 / 19 / 12 m at density 0 / 0.5 / 1, seed 1), with paving round the trunk only when the plan gives it (a circle or a square), a shed by the ordinary rules, and the chipper parked where it fits, or in the street on small lots (density 1). Checked headless: smoke 18 / 22 as before, host / client / late joiner agree.  A neighbourhood round the tree, planned from `YARD_SEED` and `YARD_DENSITY` (Tab menu, "Yards"): blocks of lots between streets; houses (one or two storeys, some L-shaped) as one glued module per room on a concrete foundation, with paver porches and sidewalks; patios; sheds; fences of one style per lot round sides and back, sometimes the front. Density 0 / 0.5 / 1 at the defaults: 5 / 10 / 15 houses, 17 / 37 / 49 builds, about 4 000 boards as 1 800 colliders. A 300 kg log dropped 3 m onto a roof broke the two rooms it hit; the rest of the house stood. A 60 kg log from 1 m broke nothing. The tree, its paving and the chipper now sit on the natural ground (no pad); the chipper's brakes hold it on a 6.5° slope (it crept 0.8 m in 20 s before). Step cost with the default yards ≈ 0.45 ms against ≈ 0.25 ms on main. Smoke run 18 / 22 (FM-05, 12, 13, 20 as before; tests keep flat ground, now with no builds). Host, client and a late joiner agree on the builds and on rooms broken (local PeerJS server). Headless only. |
| Other trees in the yards, the X (D74) | 15 trees at the default yards (8–16 m), drawn on every machine from their shape numbers, with only trunk colliders. A bot holding the saw at one 1.1 m away woke it (23 segments, 339 fibres at 60 mm) and planted the bar; 10 s of pressing cut 35 fibres. Holding {interact} at another woke it and spurred in. The wood grown on the host matched the skeleton drawn on a client exactly. Host, client and a late joiner agree on which trees are awake and on the X (local PeerJS server). Step cost: none measurable while dormant; all 15 awake, median 1.5 → 3.9 ms. The orange X sits 1.2 m up the job tree on the street side and follows the bark. Smoke run: FM-05, 12, 13, 20, 22 fail as on main (FM-10 failed once in the full run and passed 2 of 2 alone, timing). Headless only. |
| Frosted windows, weeds (D77) | House windows are opaque frosted glass. Tufts of long grass along the foot of fences, sheds, houses and round every trunk (job tree and the other trees), on by default, Tab menu → View: Weeds, density, height, distance. About 10 400 tufts at the default yards, built in ≈ 30 ms, not drawn past 60 m. Host and a joined client draw the same 10 418 tufts (local PeerJS server). Smoke run: FM-05, 12, 13, 20, 22 fail as on main; FM-10 failed (timing, as before). Headless only. |
| Leaving (D78) | In a game, Back / swipe-back pops an entry of the game's own and asks "Leave the game?" (Stay / Leave); a second Back is asked too; closing the tab asks through the browser (not on iOS). Pull-to-refresh and Chrome's overscroll swipe-back are blocked in CSS. Checked in headless Chromium: Back asked, Stay kept the game, Leave went to the previous page, `?solo` armed at the first tap, the test viewer still closes on Back. Not tried on a real phone. |
| Hidden whole bundles (D80) | Under solid bark, fibre bundles that are whole and shut in on both ends are not drawn; a cut, a split end, a twig tip and their neighbours still are, and see-through bark (test viewer) draws everything. Play tree: 13 558 → 748 fibre boxes; software GL frame 150 → 117 ms at the trunk, 133 → 83 ms looking into the crown. A third of one trunk segment cut: 748 → 1 498 boxes on host and joined client alike (local PeerJS server). Smoke run 18 / 22 (FM-05, 12, 13, 20 as before). Headless only. |
| Hopper winch, budget and wages (D87) | Feeding puts the grab rope on a winch inside the hopper's top lip; the rollers take the wood as soon as any of it is past the mouth. Headless: 0.3-57 kg branches from 2 m behind or beside all went in; 57 kg chipped in ≈ 9 s sim time. Budget $30,000 at defaults, $5,000 for 18 ft × 0.8 m ($3,500 / $8,000 at density 0 / 1); wages $7.50 per player per game hour (100 s of play at 1 player: $15). Status line shows cash and the wage math, Tab menu the budget math. Smoke 18 / 22 as on main; host and joined client agree on cash. Headless only. |
| Neighbours' trees cost money (D97) | Once a yard tree has woken into wood, sawing into it costs `YARD_CUT_COST` ($3,000 per m² sawn through, each fibre once), wood that comes off it for good costs `YARD_LOSS_COST` ($3 per kg, with the sawing that took it off on the same toast), and the first time half its wood is off it counts as felled: `YARD_FELL_COST` ($5,000) more. All three in the Tab menu under Money. Headless (seed oak): an 11 kg limb sawn off $60, a third of a stem sawn $294, the 2,109 kg tree sawn through at the base $12,350. Smoke 18 / 22 as on main; host and joined client agree on cash. Headless only. |
| Quieter HUD, stacked on phones (D99) | Network and debug figures (fps, ping, loss, wage math, network box) are off by default behind "Network and debug info on the HUD" in the Tab menu. HUD lines stack in a top-left column, and on touch the prompt, rope line, network box and toasts join it under the status lines, clear of the gear. Checked headless at 864x400 and 390x844 with every line showing; smoke 18 / 22 as on main (FM-05, 12, 13, 20); a second tab joins. |
| Continue as host (D104) | When the host goes (6 s of silence, or the connection closes) every player gets "Continue as host" and keeps trying to rejoin. The one who takes over rebuilds the sim from their copy of the world and registers the same room code (or `CODE-2` while the old one is held); the others come back as themselves. Headless, 3 tabs, local PeerJS: host tab closed, the taker hosted in the same room, the third player rejoined with their own player, a climber kept climbing, a limb on a live hinge still hung. Not restored: speeds, a chipper mid-feed, broken-structure debris collisions, rope or wood in hand. Smoke 18 / 22 as on main (FM-10 failed once in the full run, passed 2 of 2 alone). Not tried on the public signaling server or a real LAN. |
| Stickers (D105–D109) | The start screen shows you (whole body, blinking, swaying; drag turns it) with your name, shirt and stickers as you type. The host hands out stickers: tree (brown / yellow / green at 60 / 90 / 99 % of the job tree chopped into pieces the chipper can take; only players who did 10 % of the sawing), chipper (bronze / silver / gold at the same shares chipped; only players who fed 10 % of it), 100% (99 % chipped and in bins; only players who put 10 % of the chips in bins), Sorry, House! / Shed! / Fence! / Chipper! ghosts (your wood or runaway chipper broke one), Oops! and Sorry! (you sawed through your own / someone else's lanyard; Sorry! once ever), Rigged (on spurs, sawed free rigged wood), Soft landing (on the rope, let 600 kg+ down with nothing damaged for 10 s), Going down! and Look out! (sawed free wood you / someone else was lanyarded to; Look out! once ever), Sorry, Tree! (sawed down a neighbour's tree), Bankrupt (cash below zero, everyone, once a job); 100% is gold if cash is still above zero, skull (you went DOWN, once a job), salad (you ate 3 tube salads; one handed to you counts for you). A glowing button top right (Q, or tap) opens the dialog: your helmet close up with the sticker's shadow where it will go, dashed guide lines, rotate arrows (drag, arrows or arrow keys), Discard and Stick!. Stuck stickers are kept in localStorage and sent with your name and shirt; others see them on your helmet. A tree / chipper sticker stuck this job changes colour when the crew reaches the next mark. Headless, 2 tabs, local PeerJS: both got the same stickers, the joiner's stuck sticker showed on the host, an upgrade changed it there, the joiner took over as host and carried on without awarding anything twice. Smoke 18 / 22 as on main. Not tried on a real phone. |
| Climb prediction (D103) | A joined client moves its own climber (camera, body, lanyard) on the frame the stick moves, with the host's own rule, and fades in the host's corrections. Headless with 150 ms added each way (sandbox host at ~40% speed): first movement next frame (was 6 frames), 7 cm past the release point (was 33 cm); at the top of a limbless stem the drawn climber stayed at the host's stop. Host climbing unchanged (end stop, push again to climb off). Smoke 18 / 22 as on main; a second tab joins. Not tried on a real LAN. |
| Lag cap, route in the network box (D89) | Snapshots, aux and inputs are skipped while the link is more than 0.25 s behind, instead of PeerJS queueing up to 8 MB. Emulated slow link (headless, 6–10 kB/s): lag 12 s → 24 s growing without the cap, 0.4 s steady with it; on a healthy link nothing is skipped. The box adds route (direct LAN / internet / relay), the network's own round trip, how late snapshots arrive, and the host's send queue. Right after joining, snapshots run ~3 s late for a few seconds while the joiner builds the world, then settle (~0.1 s here). Smoke 18 / 22 as on main. Not tried on a real LAN or through a real relay. |
| Network box, end-of-wood stop (D85, D86) | A joined client shows ping (last, average, jitter), loss down (snapshots) / up (inputs) / ping, the estimated delay before your own moves show, kB/s in, and warnings when the host runs below real time or below 40 fps; the host's status line lists each player's ping and loss. Inputs carry a sequence number and stale ones are dropped. Climbing off the free end of wood takes a second push. Checked headless with a local PeerJS server: host, client and a late joiner (software GL: host 11 fps, 18% sim speed, ping ≈ 350 ms, all of it the host's frame time; loss 0%). A scripted climber held "up" for 4 s stopped at the top, released, pushed again and fell off. Smoke 17 / 22: FM-05, 12, 13, 20 as on main, FM-10 timing (passed 3 of 3 alone). Not tried on a real LAN. |
| Weight and captions (D83) | Grab / let go / feed captions carry the loose wood's weight; "It came free: 1898 lb". Button captions two words at most. Checked headless (touch layout): a freed limb toasted its weight and the held piece showed "Let go 1898 lb" on the action button; smoke 18 / 22 as on main; a second tab joined (local PeerJS). |
| Controls text | Lobby help, HUD hint line, prompts and toasts name keys or buttons for the device last touched. |
| Grab assist (D101) | Looking just past loose wood within reach, {interact} still grabs it: the piece nearest the reticle within `GRAB_CONE` (5°, Tab menu "Grab assist") whose surface the eyes can see, scored by angle off the reticle and then distance (`GRAB_CONE_DIST`). The exact look ray still wins when it hits wood in reach. The wood that would be grabbed glows faintly (a sleeve round that segment) for its own player only, so the target shows before the press. Touch uses the same aim (the Action button appears for a cone target). Headless: looking 0-6° off a thin twig (probe made the tree count as loose) picked that twig, 8° off picked its neighbour; the prompt said grab and the highlight drew. Smoke 18 / 22 as on main (FM-05, 12, 13, 20); a second tab joined over a local PeerServer. Not tried by hand. |
| Controls (D47) | ESDF; R hold 2 s spurs in (was 4 s until 2026-11-25, owner) (ring round the reticle fills), C hold 4 s lets go, a tap of either does nothing; W hangs the block, ties, unties, takes the block down when looking at it; R on the ground grabs / lets go of wood (a short rope; pulled out of the hands past `GRAB_MAX`); G punches and stacks; saw always on the mouse. Checked in headless Chromium through real key presses; a second tab joins and sees the new HUD. Gamepad mapping (Y rigging, RB punch) not tried on a pad. |
| Standing on slopes (D102) | The legs work along the ground and hold against the slope: on fixed 30°, 40° and 44° ramps a standing player drifted 0.000 m in 4 s (before: up to 0.3 m), and walking across a 40° ramp drifted nothing downhill; 50° still slides. Smoke run as on main; a second tab joined (local PeerJS server). Headless only. |
| Players (D90) | Tube torso, round head, helmet and headlamp, flat eyes (blink, wince when shaken, worry when hurt, X when down), saw in the shirt colour. Lobby name and shirt colour; names in toasts, on a name tag over the left breast pocket and the back of the helmet; seen by a second tab (local PeerJS server, headless). |
| Look | First person. Vertical look inverted (`INVERT_Y`). |
| Touch controls (D61) | Floating stick, drag to look, context button labelled from the prompt, Rig / Punch / Let go / Saw shown only when they apply, Saw toggle + Cut, rope slider and wraps, ⚙ / ↺. Checked in headless Chromium at Pixel 7 size through real touch events: walked, looked, planted the saw and cut 55 fibres, held the action button 4 s and spurred in (ring filled); a phone tab joined a desktop host and moved. Not tried on a real phone. |
| Saw by finger (prototype, test viewer) | `?view=FM-03` → Saw: a finger on the wood plants the bar, drag pivots, a second finger held cuts (mouse: drag, Space). Drives the real `sawStep`; cut 66 fibres headless. Not tried on a real phone; not in the game yet. |

Sim cost on the dev machine: ≈ 0.1 ms per step idle, ≈ 0.2 ms with the saw
against the trunk; colouring all fibres ≈ 0.2 ms. Rendering has only run in
software GL.

## Engine tests: must-pass run

All 18 tests of docs/TESTS.md, must-pass box, 5 613 runs, ≈ 7 min on the dev
container (4 cores, adaptive workers). A failure here is a finding about the
engine or about the manifest's criteria; nothing was loosened to pass.
"First" is the first run; "now" is after D44–D46 (solver oscillation, live
solver launches, rolling resistance), D49 (fibre adhesion) and D50
(lengthwise splitting; FM-10, FM-11, FM-18, FM-19, FM-40 and FM-41 re-run
for it).

| Test | First | Now | What fails now |
|---|---|---|---|
| FM-01 beam sag | 81 / 81 | 81 / 81 | — (sag sits between the two bounds, close to the bimodular answer) |
| FM-02 root stress | 43 / 81 | 43 / 81 | `|minC| ≥ 0.6 M·c/I` at stiffness-ratio corners: the bimodular section genuinely carries less compression stress; the manifest's band does not bracket it there (the bimodular prediction is recorded alongside) |
| FM-03 plain stem | 75 / 81 | 75 / 81 | extra lean at rest > 2 % H for slender, soft corners |
| FM-04 overload | 0 / 49 | 0 / 49 | mostly: the limb goes live near the analytic load (good) but then hangs and never comes free, so no fibre ever snaps; where it does come free, every fibre often goes in one tick (no ordered tearing) |
| FM-05 cracked, holding | 19 / 19 | 19 / 19 | — |
| FM-10 notch steers | 11 / 113 (+9 invalid) | 54 / 113 | hinge often lets go below 10°; heading error > 15° in many corners; 3+ rows of hinge never release at all (logs now settle) |
| FM-11 no notch | 61 / 81 (+3) | 66 / 81 | some corners do not come free (more since D52: the trunk hangs on a folded hinge) or go > 25° off the lean |
| FM-12 pinch | 0 / 49 | 0 / 49 | the kerf now closes as the stem rotates over the cut (D51), but only once the back cut is about 0.68 D deep; the test asks for 0.5 D |
| FM-13 hinge trend | 0 / 9 | 0 / 9 | 1 and 2 rows behave alike; 3 – 4 rows never release |
| FM-14 top cut strap | 2 / 81 | 20 / 81 | 37 thick straps stay stiff (never live: the standing strap is strong enough); 19 heavy limbs on thin straps fold but tear off within 1 s |
| FM-15 undercut + top cut | 80 / 81 (+1) | 74 / 81 | — |
| FM-16 straight through | 5 / 25 | 16 / 25 | a stem with no lean balances on its stump |
| FM-17 straight, level cut (new) | — | 21 / 21 | — |
| FM-18 straight, notch only (new; one notch direction per run since 2026-11-23) | — | 33 / 33 | — |
| FM-19 barber chair (new, D50; depends on FM-10, which now also checks an ordinary fell does not split) | — | 16 / 33 | thin stems at light leans never split; elsewhere the split often stops under 1 m. Where it passes, the trunk still breaks at the cut and takes the split slab with it (no standing slab yet) |
| FM-23 no stump phasing (new) | 5 / 21 before the parting fix | 21 / 21 (12 skipped: the trunk never came free) | — |
| FM-20 discretisation | 0 / 1 | 0 / 1 | fall heading, hinge angle and P_live all move with SEG_LEN / FIBRE_PITCH |
| FM-21 determinism | 1 / 1 | 1 / 1 | identical event logs and transforms |
| FM-22 step cost | 1 / 1 | 0 / 1 | idle p95 1.2 ms against a 1 ms bound while 3 other workers ran; alone it measures 0.7 – 1.0 ms with or without rolling resistance, so this one is timing noise at the edge of its bound |
| FM-40 tree stands | 1 174 / 1 620 (+150) | 1 221 / 1 620 | worst utilisation > 0.7 at 10 s, twigs shed, SEG_CAP hit |
| FM-41 climbable | 892 / 1 268 (+289, 352 skipped) | 1 089 / 1 205 (415 skipped) | limbs ≥ 12 cm that go live under a climber |
| FM-42 generator | 1 620 / 1 620 | 1 620 / 1 620 | — |

No run is invalid any more. The 438 INV-6 runs were `fibres.analyse`
oscillating on a fibre at the neutral axis (D44); the INV-3 runs were one
live-solver active set cycling between caps and launching a piece (D45), and
the test's own load spinning a light limb (load cap now uses the effective
mass, TESTS.md section 8).

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
- **Lengthwise splits (D50)** run a whole segment at a time, only in
  standing (stiff) wood, and are never joined again. The split-off half is
  drawn from its fibres but collides as a thinner rod. Only checked headless
  and by FM-19; nobody has watched a barber chair in game yet.
- A live bundle never goes back to stiff. A cracked limb stays a separate
  body for good. Several live bundles in a chain are only loosely coupled
  (DESIGN.md risk 7).
- Pieces joined by a live bundle do not collide at the joint, so a butt can
  sink through its stump while the hinge holds. Once it lets go they collide
  again as soon as their colliders overlap by less than `PART_OVERLAP`
  (1 cm), or sink further into each other than they already were (FM-23).
  Before 2026-11-23 this used the distance between stem axes, which let a
  felled butt sink 36 cm into its stump.
- Fibre colours are faint at everyday loads (a healthy tree is at a few
  percent of its strength). "Load colour contrast" in the menu lifts them.
- First person: the camera can clip into the trunk when pressed against it;
  the player's own body is not drawn; foliage is ghosted in the debug view
  and opaque in bark view.
- A climber is a force on the wood, not a mass. Their weight fades as the
  wood under them accelerates (so it cannot be driven faster than free
  fall), which is a patch, not physics.
- Rope spans are straight lines and pass through branches (D5).
- Clients feel their ping in their own movement and in the saw (D3). The network box (D86) shows how much; prediction plan under Next.
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
- Injury `DOWN` is a toast and a tipped-over capsule. Another player gives a tube salad to get them up (D95); the Tab menu's Respawn player button respawns.
- No sound.
- Pavers: gravel is still flat to the physics, nothing scatters or moves,
  and wood resting on a log on the pavers passes no impact to them.
- Chipper: wood being fed passes through the chipper's body and is chipped
  whole segments at a time; chip piles are cones, not particles; nothing
  about its feel has been tried by a person. Dragging loose wood is now slower
  (feet lean into the load, D58).
- Ground: a heightfield is a surface with nothing under it. Wood whose axis
  ends up under it is lifted out at 0.6 m/s, 0.2 s at a time (D88, D96), rather than pinned;
  only wood is covered, not loose shed or chipper parts. Ledge faces are about one 0.5 m cell wide, so
  they are steep slopes (about 60°), not vertical walls, and their edges show
  the grid's zigzag. Nobody has walked it by hand yet. Houses, sheds and patios sit
  on level pads; the tree's paving, the chipper, fences, sidewalks and loose
  things meet real slopes.
- Yards: nobody can go into a house (the door is a closed board) and there are
  no stairs; the street is grass; the gable ends are stepped strips; towing
  the chipper was not re-tried after its brake change (D65). Houses have not
  been hit by a felled tree yet, only by dropped logs.
- Shed and fences: loose boards are not wood (no saw, grab, chipper or paver cracks);
  the threshold has not been tried against a felled tree; only one kind of
  module (the shed) exists.

## Proposed: automated fibre tests

The owner wants a "Testing" button on the main menu that runs engine tests
in parallel and tracks results. The first step is a manifest of the fibre
mechanics tests, `docs/TESTS.md`, **awaiting approval**. Nothing is
implemented yet; do not build the runner until the manifest is approved.

## Next task

**Owner: look at the first test results above** and decide which are
engine problems to fix and which manifest criteria to retune (FM-02's band,
FM-16 with no lean, FM-10's "settled"). Then **P2-1 in DESIGN.md section 9:
play it and tune `config.js`**, re-running the must-pass tests after each
change. First things
to try with a real mouse and a real gamepad:

1. Is planting and pivoting the saw comfortable, do the pivot directions
   feel right, and can a notch be made with it?
2. Does a notched trunk go where the notch points? Adjust `FIBRE_STRETCH`.
3. Are the fibre colours readable at normal loads? Adjust the contrast
   slider.

Then Phase 3 in order: P2-2, P2-3, P2-4, …

### Client prediction (P2-9): what it would take

**2026-11-26: option 2 (climbing) is built (D103).** Next: walking prediction only if still needed. "Continue as host" is built (D104).

Owner asked (2026-11-25). Where a joined client's own delay comes from:
ping + ~17 ms waiting for the next input packet + up to one host frame +
`INTERP_DELAY` (100 ms). On a good LAN that is about 130 ms, and the render
delay is most of it; a host drawing at 20 fps adds up to 50 ms more and
shows up in the network box. Options, cheapest first:

1. **Tune, no code** (minutes). Lower "Render delay when joined" in the Tab
   menu to 50–60 ms; on a LAN with 0% loss the view stays smooth. Snapshots
   at 30 Hz (`SNAP_EVERY` 2) and inputs at 60 Hz would let it go to ~40 ms
   for 1.5x the bandwidth (≈ 20 kB/s per client).
2. **Predict climbing only** (about 1–2 days). Climbing is kinematic: the
   pose is (segment, t, side) on wood the client already has. Move the
   along/around-the-stem rule (`players.climb`, ends, unions, too thin) into
   a pure function in `model/`, run it on the client from its own inputs,
   draw its own climber from that, and correct to the host's (seg, t, side)
   for the last input number the host used (aux would carry both), replaying
   the newer inputs. Flex and moving pieces still come from snapshots, so a
   climber on swaying wood would see small corrections. Lanyard moves,
   riding a falling piece and injuries stay host-only.
3. **Predict walking** (several days, more risk). Needs a Rapier world on
   the client with the ground, builds and copies of every piece, and the
   walker pushes logs (`LEG_FORCE`) which the client cannot predict, so
   corrections would be visible whenever you touch wood. This is the
   reversal of D3 that DESIGN.md risk 6 warns about.

Recommendation: 1 now, 2 if climbing still feels late afterwards.
