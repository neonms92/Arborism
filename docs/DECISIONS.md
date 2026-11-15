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
