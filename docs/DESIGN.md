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
| `src/model/flex.js` | Elastic bending: per-segment frames from the bundles' stress planes | all |
| `src/model/treegen.js` | Seeded tree generator → segment list | host |
| `src/model/terrain.js` | The ground: seeded height field from a spec (hills, ledges, level pads); `heightAt`, `normalAt`, `slopeAt`, `range` | all |
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
   (`f.at`: the base joint, or wherever it has been sawn). Every fibre
   changes length in proportion to the force on it: it has stretched by
   `TENS_STRAIN` of its length when it reaches `MOR`, and shortened by
   `COMP_STRAIN` of its length when it reaches `COMP`. Those two numbers are
   the wood's stiffness in tension and in compression (they need not be
   equal). The faces the fibres run between stay flat, so the fibres' strains
   lie on a plane, `ε(x, y) = e0 + e1·x + e2·y`, found from the three
   equilibrium equations over the *intact fibres only* — each weighted by
   its own stiffness, which depends on whether it turns out stretched or
   squeezed (a short iteration). Severed fibres carry nothing and have no
   say in the plane.
   A saw kerf is an 8 mm gap — unless the fibres beside it are squeezed past
   `COMP_STRAIN`, in which case they crush, the kerf closes, and its faces
   carry compression too (never tension). That is what clamps a saw bar.

Loads are worked out **on the bent shape** (3.2a): weights act where the
wood actually is. A lean therefore adds to the moment that caused it.

Every fibre therefore has a stress every tick, and the debug view draws it
(3.5). Numbers on the demo tree: the 19 cm limb carries itself at a few MPa;
an 85 kg climber far out on 6 cm wood brings the top fibres to roughly half
of `MOR`; a 55 kg limb snatched on 1.5 m of slack rope puts ≈ 5 kN into the
rigging point.

`MOR` is 30 MPa (clear green hardwood is ≈ 50; the difference stands in for
knots and unions).

### 3.2a Fibres change length; discs tilt

The fibres of a segment run from the disc at its base to the disc at its tip.
With strain plane `ε = e0 + e1·x + e2·y` and segment length `L`, each fibre is
`ε·L` longer or shorter than it grew, and the tip disc sits wherever those
lengths put it (`model/flex.js`):

```
moved along the stem by     e0 · L                      (the fibres' mean change)
tilted by                   phi = (e2·u − e1·v) · L     (their differences)
```

Child segments grow from the tip disc, so tilts add up along the stem. Because
a severed fibre is not in the plane, cutting fibres on one side shifts load
onto the rest, lengthening or shortening them more, and the disc tilts
further. And because loads are taken on the tilted shape (3.2), the tilt
raises the moment, which raises the strains, which raises the tilt. With
enough fibres left that settles after a small lean; with too few it runs
until a fibre passes `MOR` and the bundle goes live. (Measured: back-cutting
80 % of the demo trunk's fibres with no notch took the worst fibre from 8 MPa
to 30 MPa as the top swung 1.2 m, with no further cutting.)

Each segment has a frame for its base disc and one for its tip disc;
`flex.at(seg, t)` gives the frame of the cross-section a fraction `t` along
it (the stem curves evenly between its discs). Everything that touches
standing wood goes through those frames: the drawing — every fibre is redrawn
between its own two ends, so fibres visibly lean, stretch and shorten
individually, and bark and foliage follow — the Rapier colliders (moved every
other tick, only if they have shifted), the climber, rope nodes, the lanyard,
the saw's probe and planting, and the parent side of a live bundle.
`sim.segToWorld / segToLocal / segDirToWorld` are the only way sim code should
place a point on a segment.

`phi` and the stretch follow their targets like a damped spring (`FLEX_FREQ`,
`FLEX_DAMP`), so wood bounces when a load comes on or off; that lag is also
what gives the cascade above its pace.

When a bundle goes live, the new body starts in the pose those fibre lengths
describe (`flex.joint`), and its fibres there have the same stiffness
(3.3), so they are already carrying what they carried a tick earlier. Wood
beyond that bundle keeps its shape relative to the new body and relaxes
straight over ~0.3 s (dynamic pieces are not analysed, so they have no strain
to hold a bend).

Clients compute the same frames from the strain planes in aux.

On the demo tree at the defaults (0.6 % / 0.9 %): the big limb's tip sits
≈ 3 cm low under its own weight and ≈ 11 cm low with an 85 kg climber far
out; with both deformations at 3 % that is ≈ 60 cm.

### 3.3 Live regime — every fibre is a spring

The moment any fibre's tension passes `MOR`, that bundle goes **live**: the
wood beyond it becomes its own dynamic body (a `split` event), joined to its
parent by nothing except the bundle's fibres. Each fibre is then an
individual element between the two bodies:

```
force along the grain   f = k · (elongation − permanent set)      k = MOR·A / (TENS_STRAIN·L) stretched,
                                                                    COMP·A / (COMP_STRAIN·L) squeezed  (L = fibre length)
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

- `tree` — a new rooted piece; each segment carries `N`, the fibres across
  its bundle, so clients build the same bundles whatever their own settings.
- `reset` — all wood gone (the host is about to send a new `tree`).
- `cut` — fibres `i[]` of a segment severed at axial positions `z[]`. The
  first cut on a pristine bundle also fixes its weak plane `f.at`.
- `divide` — a second cut plane more than a stem diameter from the first
  gets its own bundle: the segment becomes two (same piece), and each severed
  fibre stays severed on the side its cut is on.
- `split` — the wood parts at the weak plane: the segment is divided there,
  every fibre is trimmed to where it was sawn (so the stump shows the notch
  and the back cut as cut), and the distal subtree becomes a new piece at the
  parent's transform. Both halves get fresh, intact bundles.

### 3.5 Drawing wood: fibres and bark

Both are built from the bundles, so neither can disagree with the physics.

**Fibres** — every fibre is its own unlit box, converging with the stem's
taper exactly as the physics has it, split in two where sawn.
With `STRESS_COLORS`:

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

**Bark** — a skin of panels just outside the bundle's outline: a polygon
circumscribed about the fibre boxes at their drawn width, so no fibre shows
through, however few the panels or steep the taper (DECISIONS D64). Each panel is
owned by the outermost fibre behind it and is drawn only where that fibre
still exists. A kerf is therefore a slot in the bark, a notch is a missing
wedge with pale wood inside, and a stump's bark ends where its fibres end.
There are no end caps: the fibre ends are the cut face.

`BARK_OPACITY` (0 = fibres only, 1 = solid bark; 1 in the game, 0 in the test viewer) blends the two; it and the
other view switches are in the Tab menu (section 7).

---

## 4. The chainsaw

### 4.1 Plant, pivot, press

There is no "cut" object and no cutting mode with its own coordinates. The
saw is a 0.5 m bar (`BAR_LEN`) with a planted point `A` at the middle of its
leading edge, a bar direction `b` and a feed direction `f`.

- **Plant** (hold right mouse / LT while looking at wood within
  `SAW_REACH`): `A` goes on the bark where the player is looking, the bar
  lies across the stem and square to it, and the feed points at the heart of
  the stem. So the default, from any stance, is a square cut. (Looking at a
  rope or a lanyard plants the bar across that instead.)
- **Pivot** (the look controls, while planted; the view holds still):
  left/right swings the bar about `A` in the plane of the cut; up/down tilts
  that plane about the bar — the slope of a notch's top cut. `SAW_SENS` is
  the angle per screen-width of mouse travel.
- **Press** (left mouse / RT): the bar moves forward along `f` from wherever
  it is, and `A` goes with it. The chain runs while this is held.

Releasing plant lifts the saw off; the next plant starts fresh. The planted
point stays in the wood, not in the player's hands, so walking or climbing a
little does not disturb the cut; walking away lifts it off.

### 4.2 Wood stops it; the chain works through what it rests on

Each tick the bar tries to pivot and to advance. `probe()` finds every fibre
it would touch at the new position. If there are none, it moves. If there
are, it stays where it is, resting on them, and — while pressed — the chain
clears wood at `CUT_RATE` (cross-section per second), shared between the
fibres it is on. A fibre is severed at the point of contact (`cut` event)
when its share is done; then the bar can move into the kerf it just made. A
single twig fibre goes at once; a full row across the trunk takes a while.
A fibre that is already severed there does not stop the bar; nor does the
empty space inside a notch.

So a cut is whatever surface the bar was pressed and pivoted through, fibre
by fibre. Pivoting into wood without pressing does nothing: the bar just
rests there.

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
`PINCH_STUCK` the bar will not cut. It can still be lifted off. (A bar that
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

### 6.4 Concrete pavers

The tree stands in a paved circle (`model/pavers.js`): a basket weave of
`PAVER_SIZE` × `PAVER_SIZE`/2 slabs, whole slabs only, within
`PAVER_RADIUS` × `TREE_HEIGHT` of the trunk (half the height by default), with
a square pit of open soil at least `PAVER_PIT` wider than the trunk. The
yards (6.8) add patios, porches and sidewalks: paving is a list of **areas**
(a circle with a pit, or a turned rectangle), each laid in its own basket
weave, whole slabs only, an area laid later leaving out slabs an earlier one
already covers. A lookup grid finds the paver under a point. The layout is
generated from the cell size and the areas in the `pavers` event, so a
client never depends on its own settings. They are laid fresh with every new
tree, and each slab lies on the ground under its middle, tilted with it: the
tree's circle is not levelled, so on a ledge it steps with the ground.

The slabs are flush with the ground, so physics is unchanged: wood and
players land on the ground collider, and the host (`sim/pavers.js`) works out
which paver is under each contact point. An impact's energy is
½·m_eff·v_n², with v_n the closing speed at the contact before the step and
m_eff the mass the body presents there (a log landing on its end hits with
less than its whole mass). It is shared out between the pavers under the
contact by impulse. A paver whose share is at least `PAVER_CRACK_E` gains
share / `PAVER_CRACK_E` damage (`crack` event). Damage has no cap. Resting or
rolling wood closes at ≈ 0 and does nothing.

The view grows cracks from each hit point with a seeded generator, so every
machine draws the same cracks and more damage only lengthens and adds to
them: radial cracks, then branches and a crushed spot, then loose chips;
from `PAVER_GRAVEL` the slab is drawn as a low heap of gravel (finer the
further past it). Gravel is still flat ground to the physics.

### 6.5 The wood chipper

A towable chipper (`model/chipper.js` shape and chip piles, `sim/chipper.js`,
`view/chipper.js`) is parked `CHIP_GAP` outside the paving with its infeed
hopper toward the trunk and its discharge chute to the side. It is an
ordinary heavy dynamic body (`CHIP_MASS`) on two frictionless wheel balls and
a jockey wheel; the sim models the tyres: under the axle they grip sideways
(`CHIP_GRIP` × the weight on them) and roll with `CHIP_ROLL`, or with
`CHIP_BRAKE` (axle and jockey wheel) whenever nobody holds the grip. So it
can be towed by hand and turned about its axle, and rope, wood or a falling
log can still drag, tip or hoist it.

- **Grip.** The ring at the end of the drawbar is grabbed like wood
  ({interact}); the hold is the same short rope from the hands. Dragging
  anything that can move, the feet go no faster away from it than it follows
  (plus a creep while the pull is under half of `GRAB_MAX`), so the player
  leans into the load instead of walking out of the hold.
- **Feeding.** Holding loose wood, {interact} while looking at the chipper
  hands the piece to the feed rollers. They drive the point held at
  `CHIP_FEED_V`: first to the hopper mouth (round behind it when the wood is
  beside or ahead of it, and colliding with the chipper until then), then
  centred down the throat to the drum: a stiff velocity servo plus a motor term that rises
  to `CHIP_PULL` within about a second of being held back. The reaction goes
  into the chipper. Once in the mouth a fed piece passes through the chipper's colliders;
  a segment that has reached the drum with both ends inside the hopper and
  the chipper's body (and in no live joint) is removed by a `chip` event, and its wood (plus leaves) × `CHIP_SWELL` lands as chips at the
  discharge point. Standing wood cannot be fed.
- **Seizing.** When wood would be chipped, the rollers weigh the
  contiguous piece: the fed piece plus anything still joined to it by live
  fibres (wood still part of the standing tree counts as too heavy). Above
  `CHIP_CAPACITY` they seize: no chipping, the motor stops and the rollers
  clamp the wood where it is, and a seized chipper stops reeling a fed rope
  too. Sawing the piece smaller is the fix: once it weighs no more than
  `CHIP_CAPACITY` (or has left the chipper) they run again. A piece sawn off
  outside the chipper (no wood left inside it) is let go.
- **Chip piles** are cones at a fixed angle of repose whose volume is the
  chips' volume, one pile per landing spot (a new pile when the chipper has
  moved a metre); each is a fixed cone collider. The view adds loose chips
  and a stream from the chute while chipping.
- **Rope feed.** When the knot of the rigging line on a fed piece reaches the
  drum, the rope goes into the rollers (`world.rope.anchor = {chip: 1}`). From
  then on they reel it in at `CHIP_FEED_V` and slip past `CHIP_PULL`; the
  tension acts on the block and device as usual and on the chipper's
  infeed, so the tree is pulled down or the chipper is dragged to the tree
  and hoisted toward the block. It goes on until the rope comes free: cut by
  the saw, snapped, the block taken down ({rig} on it), the block's wood torn
  free, or a reset. Then whatever rope is left is pulled in and chipped (the
  rope is gone; the rollers are not harmed).
- **Carrying chips.** {interact} at a pile picks up chips, up to `CHIP_CARRY`
  (an armful, 40 L by default). With chips in hand, {interact} takes more
  while there is room, or else puts them all down where the player looks
  (within reach) or at their feet. They land on a pile there, or start a new
  one (`chips` event). An emptied pile stays in the list at zero volume, so
  pile indices never shift.
- **Crumpling (D63).** Like a shed module (6.6): when the summed contact force
  on it in one step, from wood or from a structure's parts or modules, reaches
  `CHIP_BREAK_F` (120 kN), it gives way. The body goes and each `WRECK` part
  (chassis panels, engine, hopper plates, wheels, drawbar, grip, chute) is a
  loose body where it was, moving as the chipper was. Whatever hit it keeps
  its velocity from before the step (`chipwreck` event). A rope in the rollers
  comes free. Players, the ground and chips do not count toward the hit. A
  chipper that has just been put down cannot crumple for its first second,
  while it is pushed out of anything it was placed in.
- **Respawn.** The Tab menu's "Respawn chipper" (host only) frees a fed rope,
  takes away the chipper or its wreck, and parks a new one. Chip piles stay.
- **Reset.** A new tree re-lays the pavers fresh and re-parks the chipper
  (`chipper` event): default pose, brakes on, nothing feeding, no chips.

### 6.6 Breakable structures: sheds, fences and houses

Structures (`model/builds.js`, `sim/builds.js`, `view/builds.js`) are built
from **modules** glued together. A module is one unit, made of parts
(boards: boxes in the module's frame, from the module's `shape`). The shed
is one module, put up `SHED_GAP` outside the paving on the far side of the
trunk from the chipper's chute, door toward the trunk: about the chipper's
distance from the tree. A fence (`fence:<style>`, n sections) is one module
per section, each with its first post (the last also has the closing post;
a run that starts or ends on a post another run already put up leaves that
one out), each glued to the next and standing on the ground. Styles: `rail2`
(two-rail: square posts, two boards on edge, 2.44 m sections), `split` (split
rail: rough posts, three split logs, 3 m), `privacy` (6 ft: three rails,
pickets on the good face, 2.44 m). A run on a lot line has as many whole
sections as come closest to the style's span, stretched to fit (`span`).

A **house** (`kind: 'house'`, spec `h`) is a grid of rooms, `nx` × `nz`, one
or two storeys, sometimes with a front corner left out (an L), with a gable
roof whose ridge runs along its length. Each room is a module: a floor, walls
of panels on its outside edges with a window (the front room in the door's
column has the door and a window), an inside wall with a doorway on its +x
and +z edges where it has a neighbour, and on the top storey the walls go up
to the roof (stepped strips under a gable) and it carries its own roof
boards. Rooms are glued to their neighbours on the storey and to the room
below; the ground floor is glued to the **foundation**, a module of concrete
slabs that stands on the ground and never breaks (`breakForce` ∞). So a room
only comes loose when every glued path from it to the foundation is gone.
Siding and roof colours are picked per house in the view.

- **Intact** modules have no physics of their own: their parts are colliders
  on the body the module is in, so things bump into them and nothing else.
  Parts turned alike that line up face to face are merged into one collider
  (`modProxies`: wall panels into a wall, pickets into a panel, a window's
  sill, glass and lintel into a column), because Rapier's step grows with the
  number of colliders even when they never move: a neighbourhood is about
  4 000 boards but 1 800 colliders. The parts come back when it breaks.
  Modules joined to a module that stands on the ground (`ground`), directly
  or through intact glue, are in the build's fixed body.
- **Breaking.** Each tick the contact forces on an intact module from wood,
  or from loose parts and bodies of a build, are added up; players and the
  chipper do not count. At `SHED_BREAK_F` (shed), `FENCE_BREAK_F` (one
  fence section) or `HOUSE_BREAK_F` (one room) the module breaks (`smash` event) and each part becomes a
  loose body where it was, moving as the module was. It gives way rather than
  stopping what hit it: that body gets back its velocity from before the step,
  so it ploughs on into the boards. Everything after is ordinary physics: the
  boards start a few millimetres apart, so with nothing pushing they would
  stand; hit, they slump and are knocked about by what hit them.
- **Glue.** After a break, intact modules no longer held by the ground
  through intact glue move together as one loose body (new id), with the
  velocity of the body they were in. A loose body also breaks on the ground,
  so a storey whose lower storey was smashed falls and comes apart where it
  lands. Kind `stack` (two sheds, one glued on the other) exercises this; it
  is not put up by default.
- **Sync.** Loose bodies and parts are ordinary snapshot transforms; the
  `smash` event carries their ids and the pose the module's body had, so a
  client draws the parts where they were until their first transform.
- **Reset.** A new tree puts the builds up again, intact (`builds` event).
- **Welcome.** Parts are left out of the welcome's builds; every machine makes
  them again from the module's shape (`packBuilds` / `unpackBuilds`).
- **On the ground.** A shed or house gets a level pad (6.7) and stands at
  the highest ground under its footprint, a house `HOUSE_RAISE` above it on
  its foundation, which reaches 0.3 m below the lowest ground under it. A fence follows the ground in steps: each
  section is level at the lower of its two posts (`ys` in the `builds` list),
  so its posts sink deeper on the uphill side.

### 6.7 The ground: hills and ledges

The ground (`model/terrain.js`) is a square height field, `TERRAIN_SIZE`
across with a height every `TERRAIN_CELL`, centred on the tree. It is made
from a **spec** (seed, the `TERRAIN_*` settings and a list of pads), sent in
a `terrain` event and in the welcome; every machine builds the same grid from
it. `world.terrain` null is flat ground at y = 0 (the slab the engine tests
use: the harness keeps it, `Sim` option `terrain: true` turns it on).

- **Hills**: three octaves of seeded gradient noise, about `TERRAIN_HILL_H`
  high and `TERRAIN_HILL_W` from top to top.
- **Ledges**: a stair over a second noise field, `TERRAIN_LEDGES` levels of
  `TERRAIN_LEDGE_H`: flat treads, and a riser (`TERRAIN_LEDGE_SHARP` of the
  gap between ledges, so about a cell wide) wherever the field crosses a
  level; they wind about `TERRAIN_LEDGE_W` apart. A third field eases about
  `TERRAIN_LEDGE_GAPS` of each ledge's length into a slope you can walk up,
  so no hollow is walled in.
- **Pads**: level ground `{x, z, r, blend, y, yAt}`, flat within r and
  blending into the natural ground over `blend`, at y, or the natural height
  at `yAt`, or at its own middle. Houses (out to their porch), sheds and
  patios get one (a patio at its house's height), from the yard plan (6.8).
  The tree, its paving and the chipper do not: the work area is the natural
  ground, ledges and all (the owner: "complexity creates intrigue").
- **Queries**: `heightAt(x, z)`, `normalAt`, `slopeAt` and `range(points)`
  (lowest and highest ground over a footprint) on the model, and
  `sim.groundY` / `sim.groundN`, which also work on flat ground. Heights
  between grid points follow the collider's own triangles (each cell split
  along its (x1, z0)–(x0, z1) diagonal), so `heightAt` is exactly the surface
  things rest on.
- **Physics**: a Rapier heightfield collider. A heightfield is a surface
  with nothing under it, unlike the 1 m slab of the flat ground, so every
  dynamic body looks `TERRAIN_CCD` ahead for contacts (soft CCD) on terrain.
  Without it, sticks dropped at 12 m/s went through.
- **What sits on it**: pavers lie on the ground under their middle (the
  physics surface is the ground itself, as before); the chipper is parked
  with its wheels on the ground and its tyre model works in the ground's
  tangent plane (a braked tyre sticks to the spot where it stopped until its
  grip is exceeded, so it does not creep down a slope); chip piles sit on the ground; players spawn 1.2 m
  above it, and a new ground lifts anyone it would bury.
- **Reset.** A new tree makes the ground again from the current settings
  (and the menu's `TERRAIN_SEED`), before the pavers, chipper and builds.

### 6.8 Yards

`model/yards.js` plans a neighbourhood round the tree from a seed
(`YARD_SEED`) and the `YARD_*` settings, as a pure function: the host plans
it before the ground is made (the plan's pads go into the terrain spec), then
puts it up through the ordinary `builds` and `pavers` events. Flat ground
(the engine tests) gets no yards.

- **Lots**: blocks of lots along x, separated by `YARD_STREET` streets; a
  block is two rows back to back, each facing its own street, sharing their
  lot lines. Lot width goes from `YARD_LOT_MAX` at density 0 to
  `YARD_LOT_MIN` at density 1 (±15 %), depth about 1.4 × width. Lots reach
  `YARD_EXTENT` from the tree (0: only the tree's lot).
- **The tree's lot** is wide enough for the paving and the parked chipper,
  deep enough behind the tree for the shed, and has its house in front of
  the paving, toward the street. Its shed stays where it was (6.6).
- **Each lot**, with chances that rise with `YARD_DENSITY`: a house facing
  the street (always on the tree's lot), set back 3–6 m, with a paver porch
  at the door, a paver sidewalk to the street, or both; a patio behind it; a
  shed in a back corner, door toward the house; and, with chance
  `YARD_FENCE`, a fence of one style round its sides and back, sometimes
  along the front too with a gap at the path. A lot line is fenced once.

---

## 7. Controls

Vertical look is **inverted** (`INVERT_Y`): pushing the mouse or stick
forward looks down. The same applies to tilting the saw.

The HUD and lobby name controls for whichever device was touched last
(`Input.device`); host-side prompts use `{tokens}` (`hud.js`).

| Action | Keyboard / mouse | Gamepad (standard mapping) |
|---|---|---|
| Move; climb along / around the stem | ESDF (E forward, S left, D back, F right) | left stick |
| Look | mouse (click to capture) | right stick |
| Lanyard (hold `LANYARD_TIME`, 4 s): spur in on the wood looked at, or move the lanyard there | R | X |
| On the ground (press): grab the wood looked at / let go of it (a short rope from the hands to that point; pulled harder than `GRAB_MAX`, it tears out of the hands). Near the lowering device: grab or let go of the rope tail. At the chipper: with wood in hand, feed it in; at its grip, take hold of it to tow it | R | X |
| Rigging (press): hang the block on the wood looked at; with a block hung, tie the rope to the wood looked at, or take the block down when looking at it; looking at the knot, untie | W | Y |
| Punch the wood looked at (press; presses faster than `PUNCH_DECAY` stack up to `PUNCH_MAX`) | G | RB |
| Let go of the tree (hold `LETGO_TIME`, 4 s) | C | B |
| Jump | Space | A |
| Plant the saw on the wood looked at (hold); the look controls then pivot the bar | right mouse | LT |
| Press the bar forward (chain runs) | left mouse | RT |
| On the rope tail: ease grip / haul in / wraps | left mouse / right mouse / ↑ ↓ | RT / LT / D-pad ↑ ↓ |
| Settings menu | Tab | Back |
| Respawn (prototype) | Enter | Start |

**Touch** (`src/touch.js`, D61): a floating stick under the left thumb;
drag on the right to look (or pivot the planted bar); one big context
button for interact, labelled with what it will do now (hold it to spur in
or move the lanyard); Rig, Punch, Let go (hold) and Saw appear only while
the prompt offers them; Saw is a toggle, and Cut (hold) appears on the left
while it is on; on the rope tail a spring-centred slider hauls (up) and
eases (down), with Wrap + / − beside it; ⚙ and ↺ top right. On by default
on touch-first screens; `?touch` / `?touch=0` force it.

There are no tools to switch between: the chainsaw, the rigging and the
lanyard are all to hand, and what a button does depends on what is looked
at. A held action shows a ring filling round the reticle (`ch` in the
player's aux); letting go of the button or looking away cancels it, and the
button has to be released before it can start again. LB, Q and A are free.

**The Tab menu** (`src/view/menu.js`) has a slider and a number box for
every variable worth iterating on: chainsaw and look sensitivity, inverted
look, bark and foliage visibility, fibre drawing and colouring, fibre
strengths, tension and compression deformation, stretch limits, cutting
rate, climber mass, the shortest branch that stops a lanyard, rope friction.
A **New tree** section holds height, trunk diameter, branch density, branch
length, fibre density (fibre width, and the most fibres across a stem),
fibre segment length and a shape seed, with a button that clears all wood
and grows a tree from them (host only; it reaches clients as `reset` +
`tree`).
Each row edits one key of `CFG` in place and is remembered in localStorage.
Wood, saw, climber and rope values only act on the host. Adding a variable
is one line in `ROWS`.

Rigging: *rig* on a stem hangs the block first, then *rig* on another stem
ties the end; *rig* on the knot unties.

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
   smoothed for that reason. If it misbehaves, raise the deformation settings (softer
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
| P2-1 | **Tune on a real Deck.** Play each prototype step; adjust with the Tab menu, then copy the values into `config.js` (`MOR`, `COMP`, `FIBRE_*`, `CUT_RATE`, thresholds, rope μ). Record changes. | `config.js` | A top-cut swings, a snap cut drops, a notched trunk falls on line. |
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

Automated tests outside the browser (in-game tests are proposed in
`docs/TESTS.md`); a build step; a server; soft-body ropes; a tree that is
live (per-fibre springs) everywhere all the time; client-side simulation.
