# Arborism — Design

Co-op tree-service game. Browser, GitHub Pages, peer-to-peer, host-simulated
physics. This document is the contract for everyone who works on the code
after the foundation. Where it says "must", later work should not redesign it
without recording why in `docs/DECISIONS.md`.

Section 9 is the build plan. Read sections 1–3 before touching anything.

---

## 1. Architecture

### 1.1 Three layers, one direction of data flow

```
            input (local)            input (remote, over net)
                 \                        /
                  v                      v
   +------------------------------------------------+
   |  SIM  (host only)            src/sim/          |
   |  Rapier world, structure analysis, players,    |
   |  saw, rope. Decides everything.                |
   +-----------------+------------------------------+
                     | emits EVENTS (discrete, reliable)
                     | exposes TRANSFORMS + AUX (continuous)
                     v
   +------------------------------------------------+
   |  MODEL (everyone)            src/model/        |
   |  Pure data: segments, their fibre bundles,     |
   |  rope layout. Mutated ONLY by apply(event).    |
   +-----------------+------------------------------+
                     | change notifications
                     v
   +------------------------------------------------+
   |  VIEW (everyone)             src/view/         |
   |  Three.js meshes built from the model, posed   |
   |  from transforms. HUD. No game rules.          |
   +------------------------------------------------+
```

- **Model** (`src/model/`) is plain data plus deterministic mutation
  functions. It has no physics and no rendering. The host and every client
  hold an identical copy. The *only* way it changes is `world.apply(event)`.
- **Sim** (`src/sim/`) exists only in the host's browser (and in solo play,
  which is just hosting with no clients). It owns the Rapier world. When it
  decides something structural happened (a kerf deepened, fibres tore, a
  limb separated, a rope was tied) it calls `emit(event)`, which applies the
  event to the host's model *and* queues it for the network. The sim never
  mutates the model directly.
- **View** (`src/view/`) listens for model changes and rebuilds the affected
  meshes. Each frame it asks a *transform source* where each piece and player
  is. On the host the source is the sim; on a client it is the snapshot
  interpolator. The view contains no game rules, so host and client rendering
  is one code path.

This split is the main thing that keeps networking tractable: anything that
"happens" is an event, anything that "moves" is a transform, and the two are
synced by different mechanisms (section 2).

### 1.2 Modules

| File | Role | Runs on |
|---|---|---|
| `index.html` | Canvas, HUD DOM, import map, lobby | all |
| `src/main.js` | Boot, lobby, main loop, wires everything | all |
| `src/config.js` | Every tunable number (material strengths, speeds, thresholds) | all |
| `src/input.js` | Gamepad + keyboard/mouse → one `InputState` | all |
| `src/model/world.js` | `World`: segments (each with its fibre bundle), pieces, rope; `apply(event)`; `serialize()` | all |
| `src/model/treegen.js` | Seeded tree generator → segment list | host |
| `src/model/fibres.js` | Fibre bundles: layout, severing, static load sharing (pure functions) | all (analysis host only) |
| `src/sim/sim.js` | Host simulation: Rapier world, fixed step, orchestration, `emit` | host |
| `src/sim/structure.js` | Beam pass, stiff bundles (static solve), live bundles (per-fibre springs, implicit solve) | host |
| `src/sim/players.js` | Player bodies, walking, climbing, lanyard, injury thresholds | host |
| `src/sim/saw.js` | The bar as a rod in the world: what it rests against, severing fibres, cutting ropes | host |
| `src/sim/rope.js` | Rigging line: tension path, block, friction device | host |
| `src/net/net.js` | PeerJS transport: host/join, reliable + unreliable channels | all |
| `src/net/snapshot.js` | Binary snapshot encode/decode, client interpolation | all |
| `src/view/view.js` | Three.js scene, bark and per-fibre meshes, players, rope and lanyard tubes, saw, first-person camera | all |
| `src/view/hud.js` | DOM HUD; turns `{tokens}` in prompts into key or button names for the device last used | all |
| `vendor/` | three, rapier3d-compat, peerjs — committed, no CDN | all |

Dependency rule: `model` imports nothing from `sim`, `net` or `view`.
`view` and `net` import `model`. `sim` imports `model`. Only `main.js`
imports everything.

### 1.3 Main loop (`src/main.js`)

```
frame(now):
  input.poll()                                  # gamepad + kbm → InputState
  if host:
     sim.setInput(localPlayerId, input)
     acc += dt;  while acc >= 1/60 (max 4): sim.step()      # fixed 60 Hz
     every 3rd tick: net.broadcastSnapshot(sim)             # 20 Hz
     flush queued events to clients (reliable)
     transforms = sim
  else (client):
     net.sendInput(input)                       # 30 Hz, unreliable
     interp.advance(dt); transforms = interp
  view.update(world, transforms, localPlayer, dt)
  hud.update(...)
  renderer.render()
```

One sim tick (`sim.step`), in this order (order matters; do not shuffle):

1. `rope.step` — rope tension; forces on dynamic bodies, loads on the
   rooted tree.
2. `players.pre` — apply inputs: walking, climbing, lanyard, tools. Runs the
   saw (`saw.js`), which emits `cut` / `divide` events.
3. `structure.step` — live bundles first (their pull on the standing tree is
   a load), then the beam pass, then every stiff bundle. Emits `split`.
4. `rapier.step(eventQueue, hooks)` — integrate; drain contact-force events
   into the load list for the next tick.
5. `players.post` — landing/impact detection → injury thresholds.

### 1.4 Stack

Three.js r187 + Rapier 0.21 (`rapier3d-compat`, WASM inlined) + PeerJS 1.5.5.
All vendored under `vendor/` and loaded through an import map — no build
step, no CDN at runtime. I looked for a reason to switch and found none:
Rapier is the only free browser engine with good joints, contact-force
events and a small deterministic WASM core; Jolt's JS port is heavier and
buys nothing here because (section 3) the tree is *not* a jointed
multi-body.

---

## 2. Networking

### 2.1 Topology and transport

- Star: every client connects only to the host. The host's browser is the
  server. No client-to-client links.
- PeerJS over WebRTC data channels. The host registers the peer ID
  `arborism-<ROOM>` (ROOM = 5 letters) on the signaling server; a client
  connects to that ID. Signaling is only used to set up the connection.
- Each client opens **two** data connections to the host:
  - `rel` — reliable, ordered. JSON strings. Events, welcome, chat/toasts.
  - `fast` — unreliable, unordered. Snapshots (binary), aux state (JSON),
    client input (JSON).
- Both use PeerJS `serialization: 'raw'` so we control the bytes.
- Signaling server defaults to the public PeerJS cloud (`0.peerjs.com`).
  `?signal=host:port` overrides it (used for local testing with
  `npx peerjs --port 9000`, and as an escape hatch if the public server is
  down). `?ice=<json>` overrides the ICE server list (to add a TURN relay).

### 2.2 What is synced, and how

| Kind | Examples | Channel | Rate |
|---|---|---|---|
| **Events** (structure) | fibres severed (`cut`), segment divided, wood parted (`split`), rope tied/untied/cut, piece removed | `rel` | when they happen |
| **Snapshot** (transforms) | position + rotation of every awake dynamic piece and every player | `fast`, binary | 20 Hz |
| **Aux** (small continuous state) | per-player mode/tool/injury/lanyard position/saw bar endpoints; rope rest-length, tension, wraps; per-bundle stress plane and per-fibre forces of live bundles (for fibre colours) | `fast`, JSON | 10 Hz |
| **Input** (client → host) | sticks, triggers, look angles, saw swing angles, button press counters | `fast`, JSON | 30 Hz |
| **Welcome** (host → joining client) | `world.serialize()` + assigned player id + current tick | `rel` | once |

**Clients never simulate.** They have no Rapier world. A client's own avatar
is moved by the host from the client's input and comes back in snapshots like
every other body. The one exception is the camera: look angles are applied
locally, immediately, and *sent to* the host, so aiming never feels laggy.
(Decision D3; client-side prediction for walking is a later, optional task.)

### 2.3 Breaking branches, and why this is easy

A tree is a set of **segments** grouped into **pieces** (section 3). All
segment geometry is stored in *piece-local* coordinates. When a limb breaks
or is cut off, the host emits one event:

```
{ t:'split', seg, at, newSeg, newPiece }
```

`apply` on every machine does the same deterministic thing: optionally split
segment `seg` at fraction `at` into two segments (trimming each fibre to
where the saw left it), then move the whole distal subtree into a new piece
`newPiece`. Whether that piece is still held by fibres is the host's
business; clients only see it move. **The new piece is created with the
parent piece's transform, so no segment's local coordinates change.** The
client's view just re-buckets meshes; from then on snapshots carry the new
piece's transform.

Consequences:

- A break costs one small reliable message no matter how big the limb is.
- Snapshots and events can race (different channels). The rule: a snapshot
  entry for an unknown piece id is ignored; a new piece with no snapshot yet
  is drawn at its parent's transform. Both heal within one snapshot.
- Sleeping bodies are not sent. Every 60th tick the snapshot is "full" (all
  dynamic bodies) to heal anything lost on the unreliable channel.
- Late join = `welcome` carries the serialized model, which already has every
  split and kerf baked in. There is no event replay.

Client interpolation: each body keeps a short buffer of `(hostTime, pos,
quat)`; the client renders at `hostTime − 100 ms`. If two consecutive samples
are more than 200 ms apart (the body was asleep), the older one is treated as
held until 50 ms before the newer one, so a waking body does not creep.

### 2.4 Ropes over the network

Ropes are **not** particle chains (section 5). A rope is an ordered list of
nodes, each attached to a point on a segment (or to a player's hands), plus
scalars. So:

- Rope *layout* (which nodes, attached where) changes rarely → `rope` event.
- Rope *state* (rest length, tension, wraps, who is holding) → aux, 10 Hz.
- Rope *shape* is derived on each client from piece transforms it already
  has: straight spans when taut, a sagging curve when slack. Nothing else is
  sent.

### 2.5 Input robustness

Inputs go over the unreliable channel. Held values (sticks, triggers) are
"latest wins". Button *presses* are sent as **counters** (`interact: 17`
means "interact has been pressed 17 times since join"); the host acts on the
difference from the last value it saw. A lost packet therefore never loses a
press and never duplicates one.

---

## 3. Physics: the tree

### 3.1 Representation — wood is fibres

- A **segment** is a tapered length of stem: `{id, parent, piece, a, b, r0,
  r1, leaf, f}` — endpoints `a→b` in piece-local metres, base and tip radius,
  foliage mass, and its **fibre bundle** `f`. Children attach at the parent's
  tip. Segments are 0.4–1 m long.
- A **bundle** is a square grid of fibres across the stem, clipped to the
  circle: about one fibre per 3 cm, always an odd number across, from 3×3
  (9 fibres) on twigs to 17×17 (225) on the trunk. The demo tree is ≈ 2000
  fibres. Fibres run the length of their segment. Each is `INTACT` or `CUT`,
  and a cut fibre remembers the axial span the saw removed (`zmin..zmax`).
  This exists from the first tick, on every segment, cut or not.
- A **piece** is a rigid body: one connected subtree of segments. Piece 0 is
  the rooted tree, a *fixed* Rapier body; every other piece is *dynamic*, one
  cylinder collider per segment, mass set from the wood so Rapier and the
  fibre model agree on weight.

There are no "states" for wood (attached / hinged / free). There is only
what its fibres are doing. Two regimes compute that; they are the same model
at two stiffnesses.

### 3.2 Stiff regime — static load sharing

While every fibre in a bundle is inside its elastic range, the wood either
side of it moves as one body, and the fibres share the load the way parallel
springs between two rigid faces must: the stress varies as a plane across the
section. Each tick, for every rooted piece:

1. **Load list** — point forces (and moments) on segments: self-weight and
   foliage; each climber's weight at their spurs (× `CLIMB_BOUNCE` while
   moving); rope tension at each node (a block carries both legs); filtered
   contact forces from Rapier (a falling piece, a player landing); and the
   pull of any *live* bundle further out (3.3).
2. **Beam pass** — one reverse sweep over the segments accumulates the total
   force and moment carried past each segment's base. O(segments).
3. **Bundle solve** (`fibres.analyse`) — at each bundle's weakest plane
   (`f.at`: the base joint, or wherever it has been sawn) solve for the
   stress plane `σ(x, y) = c0 + s1·x + s2·y` over the *intact fibres only*,
   from the three equilibrium equations. This is not an approximation of the
   fibre model: it is its exact answer when the fibres are stiff.
   A saw kerf is an 8 mm gap and carries nothing — unless the intact fibres
   are past compressive yield (`COMP`), in which case they crush, the kerf
   closes, and severed fibres carry compression too (never tension). That is
   what clamps a saw bar.

Every fibre therefore has a stress every tick, and the debug view draws it
(3.5). Numbers on the demo tree: the 19 cm limb carries itself at a few MPa;
an 85 kg climber far out on 6 cm wood brings the top fibres to roughly half
of `MOR`; a 55 kg limb snatched on 1.5 m of slack rope puts ≈ 5 kN into the
rigging point.

`MOR` is 30 MPa (clear green hardwood is ≈ 50; the difference stands in for
knots and unions).

### 3.3 Live regime — every fibre is a spring

The moment any fibre's tension passes `MOR`, that bundle goes **live**: the
wood beyond it becomes its own dynamic body (a `split` event), joined to its
parent by nothing except the bundle's fibres. Each fibre is then an
individual element between the two bodies:

```
force along the grain   f = k · (elongation − permanent set)      k = MOR·A / FIBRE_YIELD
                        capped at  +MOR·A  (it stretches, taking a set)
                        capped at  −COMP·A (it crushes, taking a set)
it snaps when           elongation (incl. bending over its own width) > FIBRE_STRETCH,
                        or sideways slip > FIBRE_SLIP, or the joint folds past BEND_MAX
sideways                a shear spring, 0.4·k
bending                 each fibre resists being bent over its own thickness (k·h²/12,
                        capped at MOR·A·h/4) — this is all a one-fibre-thick strip has
severed fibres          bear compression once their gap (kerf, or notch opening) has
                        closed; wood pushed into wood crushes to fit and never springs back
snapped fibres          the same, with no gap
```

Nothing else is decided anywhere. What used to be rules are now outcomes:

| What you see | Why the fibres do it |
|---|---|
| A limb cracks and sags but holds | top fibres stretched past yield took a set; the rest still carry it |
| Green-wood break: tears from the top, hangs by the bottom, rips off | fibres snap in order of elongation; the last row only bends |
| A hinge steers a falling trunk | a strip of fibres is stiff across its length and floppy across its thickness |
| The hinge lets go as the notch closes | closed notch faces become the pivot; the strip is now far from it and stretches |
| A thick hinge breaks early, a thin one folds far | elongation = angle × distance from the pivot |
| Side lean tears a hinge from one end | the fibres at that end reach their stretch limit first |
| A top-cut limb swings down on a strap | the uncut bottom fibres are a hinge that nothing closes on |
| A "hanger" | fibres that have not been stretched or folded enough to snap. Cut them. |

Stiff fibres between light bodies cannot be integrated explicitly at 60 Hz,
so a live bundle is solved **implicitly, per bundle, each tick** in the
6-DOF space of the two bodies' relative motion: assume every fibre is inside
its limits, solve the 6×6 system for the impulse, clamp the fibres that end
up outside their limits, repeat until none change (≤ 6 passes). Derivation
is in `structure.js`. The reaction on a rooted parent goes into its load
list (smoothed), so a swinging hanger loads the limb it hangs from.

While two pieces are joined by a live bundle their colliders overlap at the
joint (colliders know nothing about notches), so contact between the distal
piece's root segment and the parent piece, and between the distal piece and
the stub, is filtered out (`PhysicsHooks`). The filter stays until the last
fibre has gone *and* the two have moved apart.

A bundle that has gone live stays live. Fully severed bundles skip all this:
the wood is simply free.

Dynamic (already-fallen) pieces are not analysed in the stiff regime yet:
their bundles carry no load until fully severed, so bucking a log is a plain
cut-through (task P2-3).

Debris: pieces under 2 kg are removed 10 s after creation.

### 3.4 Segment bookkeeping

- `cut` — fibres `i[]` of a segment severed at axial positions `z[]`. The
  first cut on a pristine bundle also fixes its weak plane `f.at`.
- `divide` — a second cut plane more than a stem diameter from the first
  gets its own bundle: the segment becomes two (same piece), and each severed
  fibre stays severed on the side its cut is on.
- `split` — the wood parts at the weak plane: the segment is divided there,
  every fibre is trimmed to where it was sawn (so the stump shows the notch
  and the back cut as cut), and the distal subtree becomes a new piece at the
  parent's transform. Both halves get fresh, intact bundles.

### 3.5 Debug fibre view

On by default (`DEBUG_FIBRES`; Tab / Back toggles): bark hidden, foliage
ghosted, every fibre drawn as its own unlit box, split in two where sawn.

| Colour | Meaning |
|---|---|
| woody yellow | no load |
| → red | compression, 0 → `COMP` (crushing) |
| → blue | tension, 0 → `MOR` (breaking) |
| → green | being bent over in a live bundle |
| dark brown | snapped |

Stiff bundles are coloured from their stress plane (three numbers per
segment in aux); live bundles fibre by fibre. `COLOR_GAMMA` lifts small
loads into view.

---

## 4. The chainsaw

### 4.1 The bar is a rod in the world

There is no "cut" object and no cutting mode with its own coordinates. The
saw is a 0.5 m rod (`BAR_LEN`). Raising it (hold right mouse / LT) holds it
`SAW_HOLD` in front of the eyes — so looking up and down before raising sets
its height — pointing level and straight ahead. While it is raised the view
holds still and the look controls swing the bar about the hands instead:
left/right ±90°, up/down ±90°, with one screen-width of mouse travel equal
to half a turn. Walking and climbing still work, so the bar can also be
carried through the wood.

### 4.2 Wood stops it; throttle severs what it rests on

Each tick the bar tries to follow the hands (at most `BAR_SPEED`). `probe()`
finds every fibre the bar would touch at its next position. If there are
none, it moves. If there are, it stays where it is, resting on them, and with
throttle those fibres accumulate cutting time; after `CUT_TIME` at full
throttle they are severed at the point of contact (`cut` event) and the bar
can advance into the kerf it just made. A fibre that is already severed there
does not stop the bar; nor does the empty space inside a notch.

So a cut is whatever surface the bar was swept through, fibre by fibre, as
fast as the chain can clear them. Hands that get more than `SAW_YANK` away
from a blocked bar pull it free.

### 4.3 Why placement and angle matter

Nothing special is coded for any kind of cut. Because each severed fibre
remembers *where* it was cut:

- two cuts that meet (a flat one and a sloping one) leave fibres with a wide
  removed span — an open notch that a hinging trunk can rotate into;
- a single kerf is an 8 mm gap that closes almost at once;
- which side is cut decides whether the remaining fibres are the ones in
  tension (they fail early and the limb tears) or compression (they crush
  and the kerf grabs the bar);
- how many fibres are left, and in what shape, is the hinge.

### 4.4 Pinch

In a stiff bundle whose kerf has closed (3.2 step 3), the compression carried
by the severed fibres the bar is lying between clamps it: above
`PINCH_STUCK` the bar will not cut. It can still be backed out. (A bar that
stays trapped in the tree is task P2-2.)

### 4.5 Ropes and lanyards

A running chain parts any rope it touches for `ROPE_CUT_TIME`: the rigging
line, or a climber's lanyard — including your own, in which case you fall.

---

## 5. Ropes and friction devices

### 5.1 Tension path, not particles

A rope is an ordered **path of nodes**:

```
anchor (knot on the limb) → block (redirect on the tree) → device (friction, at the base) → tail (hands)
```

Each node is a point on a segment (so it moves with its piece). State:
`L0` = rest length between anchor and device, `wraps`, `holder`.
Each tick:

```
s        = Σ |span lengths| anchor→device          (geometric length)
stretch  = s − L0
k        = min(EA / L0, K_CAP · m_load / dt²)      (stiffness; clamp keeps explicit integration stable)
T        = max(0, k·stretch + c·d(stretch)/dt)     (tension)
```

`T` is applied along each span: on a dynamic piece as an impulse at the node;
on a rooted piece as an entry in the load list (so rigging loads break
rigging points). `T > ROPE_BREAK` snaps the rope.

Why not a particle rope: pulleys and friction wraps are exactly the things
particle ropes do badly, and exactly the things this game is about. A
tension path is cheap, unconditionally controllable, and trivially synced.
The cost is that rope spans are straight lines that do not collide with
branches. Natural-crotch rigging is added later as an explicit high-friction
node type, not as collision (task P2-5).

### 5.2 The friction device (port-a-wrap)

Capstan equation: the device holds `T_cap = T_hand · e^(μ·2π·wraps)`.
`T_hand` is the ground worker's grip (max ≈ 250 N), eased by their trigger.
If `T > T_cap` the rope slips: `L0 += v0·(T/T_cap − 1)·dt` (friction rises
with speed, so there is a terminal lowering speed the player controls).
Hauling shortens `L0` while tension is below what a person can pull.
With nobody on the tail the device is tied off (holds anything up to rope
strength).

This gives the real trade-off for free: too few wraps and the load runs
away; too many and the rope cannot run, so a dropped piece stops dead and
the shock goes into the rigging point — which section 3 may then break.
"Letting it run" is a skill, and it belongs to the ground player.

### 5.3 The lanyard

The lanyard is logical, not simulated: being on spurs and being lanyarded are
the same state (section 6.2). It is *drawn* as a loop round the stem
(`world.lanyardLoop`) and that same loop is what a saw can cut. A climbing
line / belay (later) reuses the tension path with a player body as the end
node.

---

## 6. Players

### 6.1 Body and modes

Each player is one Rapier capsule with rotation locked.

- **ground** — dynamic body; horizontal velocity set from the stick; jump.
- **climb** — kinematic body; position is *derived* from `(segment, t along
  it, side direction)` in that segment's piece frame, standing off the bark.
  Stick Y moves along the stem, stick X moves around it. At a segment end the
  player continues onto the child most aligned with where they are looking.
  The player's weight is a force on whatever wood the spurs are in.
- **rope** — on the friction device tail (ground mode, movement locked).

A player who is not climbing is always a plain dynamic body, so "falling" is
not a mode: it is the ground mode with nothing underfoot.

The view is first person: the camera is `EYE` above the body centre.

### 6.2 Spurs and lanyard rules

- **Spurring in** (interact at a stem with hands) puts the lanyard round the
  stem. Climbing *is* being lanyarded; there is no unclipped climbing.
- **Letting go** (B / C) drops the lanyard. The player falls from wherever
  they are.
- The lanyard cannot slide past a union (a joint where another branch longer
  than `STUB_LEN` still attaches). To get past, look at the stem you want —
  the trunk above, or the limb — and **interact with hands: the lanyard is
  thrown round that stem** and the player moves to it. (A real climber throws
  a second lanyard, clips it, and unclips the first; this is that, in one
  press.) Cutting a limb flush also removes the obstruction.
- Spurs need a stem of radius ≥ 3 cm (`SPUR_MIN_R`).
- If the wood the lanyard is on cracks but is still held by fibres, the
  climber stays on it and can keep moving. If it comes free, they ride it
  down and take whatever it hits — unless they let go first.
- A saw cuts lanyards (4.5).

### 6.3 No HP — thresholds and consequences

One measure: **Δv**, the velocity change a body undergoes in an impact (for a
kinematic climber: contact force × dt / body mass).

| Δv | State | Consequence |
|---|---|---|
| < 4 m/s | ok | — |
| 4–7 | `shaken` | 2 s stagger |
| 7–11 | `hurt` | limps, cannot climb, for the rest of the job |
| > 11 | `down` | incapacitated → job failure (prototype: respawn key) |

Tool misuse feeds the same states (later tasks): rope running through
gripping hands, saw pinch release, cutting your own lanyard.

---

## 7. Controls

Vertical look is **inverted** (`INVERT_Y`): pushing the mouse or stick
forward looks down. The same applies to swinging the saw.

The HUD and lobby name controls for whichever device was touched last
(`Input.device`); host-side prompts use `{tokens}` (`hud.js`).

| Action | Keyboard / mouse | Gamepad (standard mapping) |
|---|---|---|
| Move; climb along / around the stem | WASD | left stick |
| Look | mouse (click to capture) | right stick |
| Use: spur in, move the lanyard, grab the rope tail, place rope | E | X |
| Let go of the tree (fall) | C | B |
| Jump | Space | A |
| Tool: hands / chainsaw / rigging rope | Q, R | LB, RB |
| Raise the saw (hold); the look controls then swing the bar | right mouse | LT |
| Run the chain | left mouse | RT |
| On the rope tail: ease grip / haul in / wraps | left mouse / right mouse / ↑ ↓ | RT / LT / D-pad ↑ ↓ |
| Fibre view ↔ bark | Tab | Back |
| Respawn (prototype) | Enter | Start |

Y is unused.

Tools: with the rope tool, *use* on a stem hangs the block first, then *use*
on another stem ties the end; *use* on the knot unties.

---

## 8. Known risks

1. **Players who cannot connect directly.** WebRTC needs a relay (TURN) when
   both sides are behind symmetric NAT / CGNAT (mobile hotspots, some ISPs,
   offices, campuses). PeerJS's default config includes its own free TURN
   servers, but they are best-effort and unguaranteed. Mitigations in order:
   `?ice=` lets a group paste in a free TURN service's credentials (e.g.
   Cloudflare's or Metered's free tier) without code changes; a VPN overlay
   (Tailscale/ZeroTier) always works; same-LAN play always works. The lobby
   must show connection state and a plain-language failure message, never
   hang silently.
2. **The public PeerJS signaling server** is a free community service: it can
   be down or rate-limited, and room IDs are guessable. `?signal=` is the
   escape hatch. It could not be reached from the development sandbox, so
   its availability is **unverified** — first real test is on the Deck.
3. **Host tab in the background.** Browsers stop `requestAnimationFrame` and
   throttle timers in hidden tabs; the host's sim would freeze for everyone.
   Prototype: the HUD warns. Fix (task P2-8): drive `sim.step` from a Web
   Worker timer when hidden.
4. **Steam Deck performance.** Budget at 60 Hz: sim ≤ 4 ms, render ≤ 8 ms.
   - Sim: the stiff solve touches every fibre of the rooted tree each tick
     (≈ 2000) and costs ≈ 0.1 ms on the dev machine; a live bundle is one
     6×6 solve over ≤ 225 fibres. The saw probe is per-fibre only near the
     bar. Rapier cost is dominated by dynamic pieces with many cylinder
     colliders in contact. Mitigations: debris removal, sleeping.
   - Render: per piece, one merged bark geometry and one instanced mesh of
     fibre boxes (debug view); one 1024² shadow map; pixel ratio capped at 1.
   - WASM is single-threaded; that is fine at this scale.
5. **Steam Deck input.** In Desktop Mode the Deck's controls are mapped to
   mouse/keyboard and the Gamepad API sees nothing. The browser must be added
   to Steam as a non-Steam game and launched from Game Mode (or have a
   gamepad layout applied). This goes in the README, not the code.
6. **Latency on the client's own avatar.** No prediction, so a client feels
   their ping in movement (not in looking). Fine on good links for a slow
   game; if it is not, add prediction for ground walking only (task P2-9).
7. **Live-bundle solver.** Each live bundle is solved on its own; a chain
   of several live bundles in a row (a hanger hanging from a cracked limb)
   is only loosely coupled and could chatter. Loads fed back to the tree are
   smoothed for that reason. If it misbehaves, raise `FIBRE_YIELD` (softer
   fibres) before touching the solver.
8. **Explicit rope spring stability.** Light loads on short stiff ropes can
   oscillate; stiffness is clamped by load mass. If rope jitter shows up,
   lower `K_CAP` before changing the model.
9. **Joint overlap.** Pieces joined by a live bundle do not collide at the
   joint, and do not start to until they have moved apart, so a butt can
   pass through its own stump.
10. **Fibre count.** ≈ 2000 fibre instances for one tree is nothing; a site
    with ten trees needs the debug view limited to nearby trees.
11. **Cheating/trust.** None. The host is trusted. Friends-only game.

---

## 9. Build plan

Phase 2 (the risky core) was built in the foundation session; its state is in
`docs/STATUS.md`. Everything below is sized for one sitting by a model that
should **not** need to redesign anything. Rules for every task:

- Read `CLAUDE.md` first. Tunables go in `config.js`. Structural changes are
  events. The view contains no rules.
- Finish = the page loads with no console errors, solo host works, and a
  second tab can join and see the change. Update `docs/STATUS.md`.
- If a task seems to need a change to sections 1–5, stop and write the
  problem in `docs/DECISIONS.md` instead of improvising.

### Phase 3 — make the core solid

| ID | Task | Where | Done when |
|---|---|---|---|
| P2-1 | **Tune on a real Deck.** Play each prototype step; adjust only `config.js` (`MOR`, `COMP`, `FIBRE_*`, `CUT_TIME`, thresholds, rope μ). Record changes. | `config.js` | A top-cut swings, a snap cut drops, a notched trunk falls on line. |
| P2-2 | **Stuck saw.** A pinched bar stays in the kerf as a prop until the load changes, instead of backing out freely. Pinch for live bundles (contact force on the fibres the bar lies between). (Cutting ropes and lanyards is done.) | `saw.js` | Demonstrable. |
| P2-3 | **Loads on fallen pieces.** For dynamic pieces, build the load list from gravity + contact-force events and run the same beam pass and bundle solve, so logs pinch when bucked and limbs snap on landing. | `structure.js` | Bucking a log supported at both ends pinches a top cut. |
| P2-4 | **Climbing line.** A second tension path: anchor in the tree, end node on the player body. Lets a climber hang, descend, and be caught. Reuses `rope.js`; player gets a `hang` mode. | `rope.js`, `players.js` | Unclipped fall is arrested; shock feeds Δv. |
| P2-5 | **Multiple ropes; natural-crotch node.** Generalise the single rigging line to a list. Add a node type with fixed μ and wrap angle from span geometry. | `rope.js`, `world.js` | Two lines at once; crotch-rigged load is harder to lower. |
| P2-6 | **Pull line.** A rope whose tail node is a walking player: tension pulls the player and the tree. Used to commit a back-leaning fell. | `rope.js`, `players.js` | Ground player pulls a hinged trunk over. |
| P2-7 | **Injury consequences.** `hurt` limp, `down` state with carry/rescue stub, job-failed banner. Rope-burn and struck-by wired to Δv. | `players.js`, `hud.js` | Each state reachable and visible to both players. |
| P2-8 | **Hidden-tab host.** Worker-timer fallback for `sim.step`. | `main.js` | Host tab hidden, client keeps moving. |
| P2-9 | **(Only if needed) predict ground walking** on clients; host stays authoritative, client blends to snapshots. | `main.js`, `snapshot.js` | — |
| P2-10 | **Lobby polish.** Connection state, readable errors, copy-link, TURN field. | `index.html`, `net.js` | A failed join says why. |

### Phase 4 — the job loop (vision items; design room already left)

| ID | Task | Hook that already exists |
|---|---|---|
| P3-1 | Site props: house, fence, car, lines as fixed bodies with damage thresholds on contact force | contact-force events → thresholds, same as players |
| P3-2 | Second and third tree species: generator presets, per-species `MOR`/density | `treegen.js` params, `config.js` materials |
| P3-3 | Dead/defective wood: per-fibre strength (rot pockets, included bark) | a strength array on the bundle, used in `analyse` and `liveStep` |
| P3-4 | Job clock: daylight, fuel, saw wear, wages | new `src/sim/job.js`; state in aux |
| P3-5 | Procedural sites, slopes | `World` already takes any segment list; ground becomes a heightfield collider |
| P3-6 | Bidding, economy, hiring, vehicles, skid steer, neighbours, weather (wind = distributed load on foliage in the load list) | out of prototype scope |

### Not planned, on purpose

Automated tests; a build step; a server; soft-body ropes; a tree that is
live (per-fibre springs) everywhere all the time; client-side simulation.
