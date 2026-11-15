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
   |  Pure data: segments, pieces, cut sections,    |
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
| `src/model/world.js` | `World`: segments, pieces, sections, rope; `apply(event)`; `serialize()` | all |
| `src/model/treegen.js` | Seeded tree generator → segment list | host |
| `src/model/section.js` | Cut cross-section: fibre grid, kerfs, stress analysis (pure functions) | all (analysis host only) |
| `src/sim/sim.js` | Host simulation: Rapier world, fixed step, orchestration, `emit` | host |
| `src/sim/structure.js` | Beam analysis, section failure, splitting pieces, hinge joints | host |
| `src/sim/players.js` | Player bodies, walking, climbing, lanyard, injury thresholds | host |
| `src/sim/saw.js` | Aiming and feeding the chainsaw into a section | host |
| `src/sim/rope.js` | Rigging line: tension path, block, friction device | host |
| `src/net/net.js` | PeerJS transport: host/join, reliable + unreliable channels | all |
| `src/net/snapshot.js` | Binary snapshot encode/decode, client interpolation | all |
| `src/view/view.js` | Three.js scene, piece meshes, players, rope, saw, kerfs, camera | all |
| `src/view/hud.js` | DOM HUD, cross-section diagram, prompts | all |
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

1. `players.preStep` — apply inputs: walking velocities, climb motion, tool
   actions. Emits rope/tool events.
2. `saw.step` — advance any kerf being cut; emits `kerf` events.
3. `rope.step` — compute rope tension, apply forces to dynamic bodies,
   record loads on the rooted tree.
4. `structure.step` — gather loads (gravity, players, rope, last tick's
   contact forces), run beam analysis, run section analysis, emit `tear` /
   `split` / `hinge` / `release` events, create/destroy bodies and joints.
5. `rapier.step(eventQueue)` — integrate; drain contact-force events into the
   load list for the next tick.
6. `players.postStep` — landing/impact detection → injury thresholds.

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
| **Events** (structure) | kerf progress, fibre tear, split, hinge, release, rope tied/untied, piece removed | `rel` | when they happen |
| **Snapshot** (transforms) | position + rotation of every awake dynamic piece and every player | `fast`, binary | 20 Hz |
| **Aux** (small continuous state) | per-player mode/tool/injury/lanyard/saw pose; rope rest-length, tension, wraps | `fast`, JSON | 10 Hz |
| **Input** (client → host) | sticks, triggers, look angles, aim ray, button press counters | `fast`, JSON | 30 Hz |
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
{ t:'split', seg, at, newSeg, newPiece, hinge? }
```

`apply` on every machine does the same deterministic thing: optionally split
segment `seg` at fraction `at` into two segments, then move the whole distal
subtree into a new piece `newPiece`. **The new piece is created with the
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

### 3.1 Representation

- A **segment** is a tapered cylinder of wood: `{id, parent, piece, a, b,
  r0, r1, leafMass}` — endpoints `a→b` in piece-local metres, base and tip
  radius, extra foliage mass. Children attach at the parent's tip `b`.
  Segments are 0.4–1.5 m long. A demo tree is 100–200 segments.
- A **piece** is a rigid body: a set of segments forming one connected
  subtree. Piece 0 is the rooted tree, a *fixed* Rapier body. Every other
  piece is a *dynamic* body with one cylinder collider per segment (collider
  mass set explicitly from segment volume × green density + leaf mass, so
  Rapier and the analysis agree on weight).
- The tree is **not** a chain of jointed bodies. Hundreds of jointed bodies
  are slow, jittery, and Rapier's JS API does not expose usable joint
  reaction forces. Instead:

### 3.2 Load and stress — analytic beam analysis on a rigid tree

Every tick, for each *rooted* piece, the host computes what each
cross-section is carrying, the way an engineer would:

1. Build the **load list** — point forces on segments, in world space:
   - self-weight of each segment (at its centroid) and its foliage;
   - each climbing player's weight at their spur point;
   - rope tension at each node on this piece (a block carries the vector sum
     of both rope legs — roughly double the load, as in real rigging);
   - contact forces from last tick's Rapier contact-force events (a falling
     piece or a player landing on a limb), low-pass filtered (τ ≈ 40 ms).
2. One reverse pass over the segment array (children before parents)
   accumulates for each segment the total force `F` and moment `M₀` (about
   the piece origin) of everything distal to its base. O(segments).
3. At the base of each segment: moment about the joint
   `M = M₀ − p × F`; split into bending `M_b` (⊥ axis), torsion `T`
   (‖ axis), axial `N`. For a round section of radius r:

   ```
   σ_bend  = 4·|M_b| / (π r³)
   σ_axial = N / (π r²)
   τ_tors  = 2·|T| / (π r³)
   utilisation u = (σ_bend + max(σ_axial,0)) / MOR + (τ_tors / S)²
   ```

   `MOR` (modulus of rupture, green hardwood ≈ 50 MPa) and `S` (shear) live
   in `config.js`. This is per-tick, cheap, and gives a number per segment
   that the view can show as a colour (the **stress overlay**, the main
   teaching tool).

Sanity check that the numbers produce the right drama: a 10 cm limb, 4 m
long, carries its own weight at u ≈ 0.1. Put a 90 kg climber 3 m out and
u ≈ 0.65; bounce on it and it goes. A 150 kg piece dropped 1 m onto a rope
through a block on that same limb pulls ≈ 10 kN at the block and snaps it.
Nobody scripted any of that.

### 3.3 How wood fails — the section model

Any place where wood can part is a **section**: a cross-section of one
segment at fraction `at` along it, discretised as a 13×13 grid of **fibre
cells** inside the circle (~137 cells). Each cell is `INTACT`, `CUT` (a saw
kerf passed through it) or `TORN` (it broke). Sections are created lazily:

- by the saw, where the player cuts (section 4);
- by overload: when a segment's base utilisation u > 0.8, a section is
  created at its base with all cells intact.

So an overloaded uncut limb and a sawn limb fail through **the same code**.
Each tick, for every section on a rooted piece, `section.analyse()`:

1. Takes the distal load at the section (`F`, `M` from the beam pass,
   adjusted to the section's position along the segment).
2. Computes the *actual* section properties of the remaining wood — area,
   centroid, second moments `Ixx, Iyy, Ixy` — from the cells. Closed saw
   kerfs can carry compression but not tension, at reduced stiffness
   (`KERF_CONTACT = 0.15`), found with a small active-set iteration.
3. Gets the stress in every cell from the unsymmetric bending formula
   (derivation in `section.js`).
4. Applies the failure rules:
   - **Tear.** Intact cells whose tension exceeds `MOR` tear, most-stressed
     first, a few per tick. Tearing raises stress on the neighbours, so it
     either stops (a *crack* — audible/visible warning, the limb holds) or
     runs. If tension exceeds 3×MOR everything tears at once (a clean snap
     from a shock load).
   - **Hinge.** If cells must tear but the remaining intact wood is a thin
     strip (thickness ≤ 20 % of diameter, at least twice as long as thick),
     the fibres *bend* instead: the distal subtree becomes a dynamic piece
     attached to its parent by a Rapier **revolute joint** along the strip's
     long axis, through the strip's centroid.
   - **Free.** No intact cells → the distal subtree becomes a free dynamic
     piece.
5. For a hinged piece, each tick:
   - **Closing.** Rotation closes the gap on one side of the hinge. Each
     `CUT` cell has a gap (kerf width, or the opening between two kerfs —
     i.e. a notch). The hinge breaks when rotation reaches
     `θ_close = min over closing-side cells of gap / distance-from-hinge`.
     A proper open notch gives 45–70°; a single flat kerf gives ~2°.
   - **Fibre limit.** `θ_fibre = clamp(0.12 / (thickness/diameter), 0.2,
     1.6)` rad. Thin hinges flex far; thick ones snap early.
   - **Side load.** Moment about the strip's strong axis, torsion, and
     tension are checked against the strip's capacity. Side lean or a
     swinging load beyond it tears the hinge and the piece goes where gravity
     takes it.
   - The joint has a velocity-damping motor scaled by strip strength, so a
     thick hinge lets the tree over slowly and a thin one lets it go.

What emerges without special cases:

| Player does | Model does | Reads as |
|---|---|---|
| Stands too far out on a thin limb | section at base tears from the top, bottom strip hinges, limb swings down and rips off | green-wood break |
| Top-cuts a limb with no undercut | bottom strip hinges; limb swings down into the trunk (and the climber) before tearing | "should have undercut" |
| Undercut, then top cut | strip between kerfs; closing side has only a kerf-width gap → releases almost at once, limb drops flat | clean snap cut |
| Notch + back cut leaving a hinge | revolute about the hinge, opens to the notch angle, then releases | controlled fell |
| Back cut right through the hinge | no intact cells → free body | no control |
| Flat cut past the notch apex ("Dutchman") | small-gap cells near the hinge → closes early, hinge breaks early | lost steering |
| Cuts the compression side | closed kerf picks up compression → clamps the bar | pinched saw |

Dynamic (already-fallen) pieces are not stress-analysed in the prototype:
sections on them carry zero load, so bucking a log is a plain cut-through.
(Task P2-3 adds ground reactions.)

Debris: pieces under 2 kg are removed 10 s after creation.

---

## 4. The chainsaw cut

### 4.1 What a cut is

A **kerf** belongs to a section and is four numbers:

```
{ phi,    // direction the saw enters from, as an angle in the section plane
  tilt,   // slope of the cut plane relative to the cross-section (0 = square)
  z0,     // axial offset of the entry line from the section (metres)
  depth } // how far the bar has advanced into the wood (metres)
```

The bar lies across the stem, perpendicular to the stem axis and to the
entry direction, and advances inward. In the section's 2-D coordinates a
kerf removes every cell whose inward distance `x = R − c·e(phi)` is
`≤ depth`. Each cut cell records the axial height the kerf passed at:
`z = z0 + x·tan(tilt)`, keeping the min and max over all kerfs that hit it.
`gap = zMax − zMin + KERF_WIDTH`. Two kerfs entering from the same side at
different tilts therefore leave cells with a wedge-shaped gap between them:
**a notch is not a special object, it is two kerfs.**

A new cut within one stem-diameter (axially) of an existing section joins
that section; otherwise it starts a new one.

`kerf` events carry these numbers; clients run the same `applyKerf` and get
the same cell grid (for the cross-section HUD and the visible kerf mesh).
Depth is re-sent at ≤10 Hz while cutting.

### 4.2 What placement and angle change

Everything in the table in 3.3 follows from *which cells are gone and what
gap they left*:

- **Entry side (`phi`)** decides whether you are cutting tension wood (the
  kerf opens, cuts freely, the piece will go early) or compression wood (the
  kerf closes on the bar).
- **Notch angle (`tilt` of the second face cut)** sets `θ_close`: how far the
  hinge steers before it lets go.
- **Notch direction** sets the hinge axis, and the piece falls perpendicular
  to the hinge — unless side load exceeds the strip's strength.
- **Back-cut depth** sets hinge thickness: too thick and the tree will not
  commit (or needs a pull line — a ground-crew job); too thin and it tears
  under side lean; zero and there is no steering at all.
- **Back-cut height (`z0`)** relative to the notch apex changes the gap on
  the closing side behind the hinge.

### 4.3 Pinch

While a kerf is being cut, the analysis reports the compressive force
carried by that kerf's closed cells. Feed rate is multiplied by
`1 − F/PINCH_STUCK`; at `F ≥ PINCH_STUCK` the bar is stuck: the saw stops
cutting and cannot be withdrawn until the load changes (someone pulls a
rope, or the wood fails). In the prototype a stuck saw can be abandoned by
releasing precision mode (it returns to hand); task P2-6 makes it stay in
the tree.

### 4.4 Feedback

Whenever the player is in precision mode on a section, the HUD shows the
**cross-section diagram**: the cell grid coloured by state and stress
(intact wood by tension-red / compression-blue, cut cells dark, torn cells
splintered, the hinge strip outlined, the saw's entry direction marked).
This is the "read and learn" surface; treat it as a first-class feature.

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

The climbing lanyard is logical, not simulated: it is a flag on the climbing
player plus rules (section 6.2). A climbing line / belay (later) reuses the
tension path with a player body as the end node.

---

## 6. Players

### 6.1 Body and modes

Each player is one Rapier capsule with rotation locked.

- **ground** — dynamic body; horizontal velocity set from the stick; jump.
- **climb** — kinematic body; position is *derived* from `(segment, t along
  it, side direction)` in that segment's piece frame, standing off the bark.
  Stick Y moves along the stem, stick X moves around it. At a segment end the
  player continues onto the child most aligned with where they are looking.
  The player's weight is a load on the tree at the spur point.
- **fall** — dynamic body, no control, until it lands.
- **rope** — on the friction device tail (ground mode, movement locked).

### 6.2 Spurs and lanyard rules

- Spurs need a stem of radius ≥ 4 cm.
- **Lanyard on** (clipped round the stem): both hands free → the saw can be
  used. The lanyard cannot pass a union (a joint where another branch longer
  than 0.3 m still attaches): the player must unclip, step past, re-clip.
  Cutting a limb flush removes the obstruction.
- **Lanyard off**: can move freely, cannot run the saw, and falls if struck
  or if the wood they are on breaks away.
- If the wood the player is lanyarded to becomes a falling piece, they ride
  it down, and take whatever it hits.

### 6.3 No HP — thresholds and consequences

One measure: **Δv**, the velocity change a body undergoes in an impact (for a
kinematic climber: contact force × dt / body mass).

| Δv | State | Consequence |
|---|---|---|
| < 4 m/s | ok | — |
| 4–7 | `shaken` | 2 s stagger, drops off spurs if unclipped |
| 7–11 | `hurt` | limps, cannot climb, for the rest of the job |
| > 11 | `down` | incapacitated → job failure (prototype: respawn key) |

Tool misuse feeds the same states (later tasks): rope running through
gripping hands, saw pinch release, cutting your own lanyard.

---

## 7. Controls

Standard-mapping gamepad (the Deck presents one when the browser is launched
through Steam — see Risks). Keyboard/mouse in brackets.

| Control | Ground | Climbing | Precision cutting (hold LT) | On the rope tail |
|---|---|---|---|---|
| Left stick [WASD] | move | Y: along stem, X: around stem | Y: slide bar along stem, X: rotate entry side | — |
| Right stick [mouse] | look | look | X: look, Y: tilt the bar | look |
| RT [LMB] | — | — | throttle = feed | ease grip (let it run) |
| LT [RMB] | precision mode (with saw) | precision mode (with saw) | — | haul in |
| A [Space] | jump | — | — | — |
| X [E] | interact: spur in / grab rope tail / place rope | interact | — | let go (ties off) |
| Y [F] | — | clip / unclip lanyard | — | — |
| B [C] | — | step off / let go | — | — |
| LB / RB [Q / R, 1-3] | previous / next tool | same | — | — |
| D-pad ↑↓ [wheel] | — | — | — | add / remove a wrap |
| Back [Tab] | stress overlay | same | same | same |
| Start [Enter] | respawn (prototype) | | | |

Precision cutting is deliberately a *mode*: pressing LT while looking at wood
within reach freezes the player, snaps the bar to the bark where they are
looking, and re-purposes the sticks for millimetre work. The bar's entry
line is drawn on the bark and the cross-section diagram appears. RT is
analog: a light squeeze feeds slowly. Releasing LT withdraws the bar and
leaves the kerf.

Tools: hands, chainsaw, rigging rope. With the rope tool, X on a stem sets
the block first, then X on another stem ties the end; X on the knot unties.

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
   - Sim: analysis is O(segments) plus ~137 cells per *active* section;
     negligible. Rapier cost is dominated by dynamic pieces with many
     cylinder colliders in contact. Mitigations: debris removal, sleeping,
     and (if needed) dropping colliders for twigs under 2 cm on dynamic
     pieces.
   - Render: one merged geometry per piece (one draw call each), instanced
     foliage, one 1024² shadow map, pixel ratio capped at 1.
   - WASM is single-threaded; that is fine at this scale.
5. **Steam Deck input.** In Desktop Mode the Deck's controls are mapped to
   mouse/keyboard and the Gamepad API sees nothing. The browser must be added
   to Steam as a non-Steam game and launched from Game Mode (or have a
   gamepad layout applied). This goes in the README, not the code.
6. **Latency on the client's own avatar.** No prediction, so a client feels
   their ping in movement (not in looking). Fine on good links for a slow
   game; if it is not, add prediction for ground walking only (task P2-9).
7. **Explicit rope spring stability.** Light loads on short stiff ropes can
   oscillate; stiffness is clamped by load mass. If rope jitter shows up,
   lower `K_CAP` before changing the model.
8. **Hinge release overlap.** A hinged piece has contacts with its parent
   disabled; on release it may overlap the stump and get pushed out. Reads as
   the butt kicking, which real butts do, but watch for explosions.
9. **Cheating/trust.** None. The host is trusted. Friends-only game.

---

## 9. Build plan

Phase 2 (the risky core) is the foundation session's job; its state is in
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
| P2-1 | **Tune on a real Deck.** Play each prototype step; adjust only `config.js` (`MOR`, feed speed, thresholds, rope μ). Record changes. | `config.js` | A top-cut swings, a snap cut drops, a notched trunk falls on line. |
| P2-2 | **Stuck saw, cut ropes.** A pinched saw stays in the kerf as a prop until load changes. A kerf whose plane sweeps a rope span cuts the rope (and a lanyard: the player falls). | `saw.js`, `rope.js` | Both demonstrable. |
| P2-3 | **Loads on fallen pieces.** For dynamic pieces, build the load list from gravity + contact-force events and run the same beam/section analysis, so logs pinch when bucked and limbs snap on landing. | `structure.js` | Bucking a log supported at both ends pinches a top cut. |
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
| P3-3 | Dead/defective wood: per-segment strength factor | multiply `MOR` per segment in `structure.js` |
| P3-4 | Job clock: daylight, fuel, saw wear, wages | new `src/sim/job.js`; state in aux |
| P3-5 | Procedural sites, slopes | `World` already takes any segment list; ground becomes a heightfield collider |
| P3-6 | Bidding, economy, hiring, vehicles, skid steer, neighbours, weather (wind = distributed load on foliage in the load list) | out of prototype scope |

### Not planned, on purpose

Automated tests; a build step; a server; soft-body ropes; a jointed
multi-body tree; client-side simulation.
