# Arborism — working notes for Claude

Co-op arborist game. Browser only, GitHub Pages, peer-to-peer (host simulates).
**Read `docs/DESIGN.md` before changing anything** and `docs/STATUS.md` for
what to do next. Decisions and their reasons: `docs/DECISIONS.md`.

## Run locally

```
python3 -m http.server 8123        # from the repo root; any static server works
# open http://localhost:8123/?solo
```

No build, no npm install. ES modules are served as-is; libraries are in
`vendor/` and mapped in the import map in `index.html`.

URL parameters: `?solo` (start immediately), `?host=CODE`, `?join=CODE`,
`?seed=N` (tree), `?signal=host:port` (own PeerJS server), `?ice=<json>`
(extra STUN/TURN servers), `?test=FM-10,...|all&mode=smoke|must|explore|sweep`
(engine tests, headless; docs/TESTS.md section 8).

Two-player test on one machine without the public signaling server:

```
npx peerjs --port 9000             # local PeerServer
# tab 1: http://localhost:8123/?host=TEST&signal=localhost:9000
# tab 2: http://localhost:8123/?join=TEST&signal=localhost:9000
```

Console handle for poking at state: `arb.sim`, `arb.world`, `arb.aux`,
`arb.CFG` (live-editable tunables).

## Deploy

GitHub Pages, "Deploy from a branch", root folder. There is no build, so a
push to the Pages branch is a deploy. `.nojekyll` must stay. One-time setup
by the repo owner: Settings → Pages → Source: Deploy from a branch → pick the
branch → `/ (root)`. The game is then at
`https://<owner>.github.io/Arborism/`.

## Conventions

- Plain JavaScript ES modules, no build step, no framework, no TypeScript.
- **Three layers** (DESIGN.md 1.1): `src/model` (pure shared data),
  `src/sim` (host only, Rapier), `src/view` (rendering only).
  - The model changes only through `world.apply(event)`.
  - The sim never mutates the model directly: it calls `sim.emit(event)`.
  - The view has no game rules. Clients never simulate.
  - `model` must not import from `sim`, `view` or `net`.
- Anything structural that happens is an **event** (reliable). Anything that
  moves is a **transform** in the snapshot. Small continuous values go in
  **aux**. Adding a feature usually means: one new event type in
  `world.apply`, host logic in `sim/`, drawing in `view/`.
- Every tunable number goes in `src/config.js`, SI units. To let the owner
  iterate on one in game, add a line to `ROWS` in `src/view/menu.js` (the
  Tab menu); code must read `CFG.X` at use, not copy it at load.
- Bark and fibres are both drawn from `seg.f` (DESIGN.md 3.5). Never add
  wood geometry that is not derived from the bundles.
- Model geometry is piece-local plain arrays `[x,y,z]`; sim/view use
  `THREE.Vector3` for world-space maths. Rooted (fixed) pieces sit at the
  origin with identity rotation — `structure.js` relies on it.
- Standing wood bends (DESIGN.md 3.2a). In `sim/`, place any point that is
  on a segment with `sim.segToWorld / segToLocal / segDirToWorld`, never
  `toWorld(piece, ...)`. In `view/`, go through `flexNow.frame(seg)`.
- **Wood is fibres** (DESIGN.md 3). Every segment has a bundle `seg.f`.
  Do not add states or rules for how wood fails (hinge, tear, peel...): if a
  behaviour is missing, it belongs in the fibre force law in
  `structure.liveStep` or in `fibres.analyse`. Read DECISIONS D19 before
  touching the live solver.
- Host-side prompt and toast text uses `{tokens}` for controls
  (`{interact}`, `{throttle}`...); `hud.js` maps them per input device.
  Never write a key or button name in `sim/`.
- Rapier getters that return vectors or matrices may hand back a reused
  buffer: read the numbers out before calling Rapier again.
- No HP anywhere. Harm is a delta-v threshold crossing → injury state
  (`players.impact`).
- Engine tests live in `src/test/` and run from the main menu's Testing
  button or headless with `?test=all&mode=smoke` (docs/TESTS.md section 8).
  Before committing: run the smoke tests, load `?solo`, check the console is
  clean, and check a second tab can join. A test that fails is a finding to
  report, not something to loosen without the owner.
- Code under `src/sim/`, `src/model/` and `src/test/` (except the menu's
  `ui.js`, `pool.js`, `store.js`) must run in a Web Worker: no DOM, no bare
  `three` / `rapier` imports (DECISIONS D41).
- Keep `docs/STATUS.md` current. Record judgment calls in
  `docs/DECISIONS.md`. Commit and push after every working step.

## Vendored libraries

`vendor/three` (r187), `vendor/rapier` (rapier3d-compat 0.21, WASM inlined),
`vendor/peerjs` (1.5.5, **patched**). To update, copy the same files from the
npm packages. Re-apply the PeerJS patch (DECISIONS D12):

```
sed -i 's/r={ordered:!!e.reliable}/r=e.reliable?{ordered:!0}:{ordered:!1,maxRetransmits:0}/' vendor/peerjs/peerjs.min.js
```
