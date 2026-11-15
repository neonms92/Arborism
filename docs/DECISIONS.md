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
