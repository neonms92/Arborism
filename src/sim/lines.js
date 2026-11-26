// Host only: the power lines (model/lines.js). Each line is a chain of points LINE_LINK apart, solved as XPBD
// distance links that pull but never push (a line goes slack), with gravity, the ground, and the wood that falls
// on it. A link whose tension passes LINE_BREAK_F snaps (a 'snap' event: everyone sees the flash). The tension at
// an end pulls on what that end is on: a woken pole's wood (a load while it stands, a force on its piece once it
// is loose), so the lines hold up a pole sawn off at its base. Dormant poles and houses take it without moving.
// Wood that meets a line pushes it aside, and the line pushes back on the wood with its tension.
// Lines at rest sleep: nothing is solved and nothing is sent. Every line is live: a player who touches one is
// shocked (players.shock), until LINE_DEAD_T after it first comes down, when it goes dead (a 'dead' event).

import * as THREE from '../../vendor/three/three.module.js';
import { CFG, INJ } from '../config.js';
import { endRest, restNodes, houseEnd } from '../model/lines.js';

const SUB = 4, ITER = 8;        // substeps per tick, solver sweeps per substep
const R_LINE = 0.015;           // m, radius of a line (what it collides as)
const DV_MAX = 1;
const LINE_REBOUND = 0.3;      // share of a line's push that wood moving back out the way it came gets (the rest is lost)               // m/s: most a line changes a loose piece's speed in one tick (keeps light sticks on a taut line calm)
const _v = new THREE.Vector3(), _f = new THREE.Vector3(), _p = new THREE.Vector3();

export class Lines {
  constructor(sim) {
    this.sim = sim;
    this.st = [];               // per line: its points and solver state
    this.shockT = new Map();    // player id -> s until they can be shocked again
    this.sphere = new Map();    // piece id -> {c: piece-local centre, r} (bounding sphere of its wood)
  }

  /** The lines for a new world: a line from pole to pole along each street, a drop from a pole to each house. */
  place(plan, base) {
    const sim = this.sim, w = sim.world, list = [];
    if (!plan.poles || !plan.poles.length || !w.stands) return;     // (no event: the engine tests' flat ground has none)
    const add = (a, b, kind) => {
      const A = endRest(w, a), B = endRest(w, b), c = Math.hypot(B[0] - A[0], B[1] - A[1], B[2] - A[2]);
      if (c < 1) return;
      list.push({ a, b, n: Math.max(2, Math.round(c / Math.max(0.5, CFG.LINE_LINK))), L0: +(c * (1 + Math.max(0, CFG.LINE_SLACK))).toFixed(4), kind });
    };
    for (const [i, j] of plan.spans) {
      const hi = w.stands.list[base + i].h - 0.08, hj = w.stands.list[base + j].h - 0.08;
      add({ st: base + i, h: +hi.toFixed(4) }, { st: base + j, h: +hj.toFixed(4) }, 0);
    }
    for (const [pi, bi] of plan.drops) {
      const b = w.builds[bi], s = w.stands.list[base + pi]; if (!b || !s || !plan.builds[bi]) continue;
      const he = houseEnd({ ...b, h: plan.builds[bi].h }, [s.x, s.z]); if (!he) continue;     // (the world's builds keep no house spec)
      add({ st: base + pi, h: +(s.h - 0.9).toFixed(4) }, { b: b.id, m: he.m, w: he.w }, 1);
    }
    sim.emit({ t: 'lines', list });
  }

  onEvent(ev, info) {
    if (ev.t === 'lines') this.build();
    else if (ev.t === 'reset') { this.st = []; this.sphere.clear(); }
    else if (ev.t === 'snap') { const S = this.st[ev.i]; if (S) this.wake(S); }
    if (ev.t === 'split' || ev.t === 'divide' || ev.t === 'chip' || ev.t === 'rmpiece' || ev.t === 'rip' || ev.t === 'reset') this.sphere.clear();
  }

  /** Solver state for every line in the world, hanging at rest, asleep. */
  build() {
    const w = this.sim.world;
    this.st = [];
    if (!w.lines) return;
    for (const L of w.lines.list) {
      const A = endRest(w, L.a), B = endRest(w, L.b), x = restNodes(A, B, L.L0, L.n);
      const S = { x, px: x.slice(), lam: new Float64Array(L.n), T: new Float64Array(L.n), awake: false, still: 0, moved: false, last: -1e9,
        pin: [A, B], touch: new Int32Array(L.n + 1).fill(-1), tp: new Float64Array((L.n + 1) * 3), box: [0, 0, 0, 0, 0, 0] };
      this.bound(S);
      this.st.push(S);
    }
  }

  wake(S) { S.awake = true; S.still = 0; }

  /** Points of line i (world, [x, y, z] per point), for the view on the host. */
  nodes(i) { const S = this.st[i]; return S ? S.x : null; }

  /** Where end e of a line is now (a world [x, y, z]), or null when it has come away from what held it. */
  endNow(e) {
    const sim = this.sim, w = sim.world;
    if (e.seg !== undefined) {
      const s = w.segs.get(e.seg); if (!s || !sim.bodies.get(s.piece)) return null;
      return sim.segToWorld(s, e.p, _p).toArray();
    }
    if (e.st !== undefined) return endRest(w, e);
    const b = w.builds.find((x) => x.id === e.b), m = b && b.mods[e.m];
    if (!m || m.ids || m.body !== b.id) return null;          // that room broke, or came loose
    return e.w;
  }

  /** The bounding sphere of a loose piece's wood, in its own frame. */
  sphereOf(id) {
    let sp = this.sphere.get(id);
    if (sp) return sp;
    const segs = this.sim.world.segsOf(id); if (!segs.length) return null;
    const c = [0, 0, 0];
    for (const s of segs) for (let k = 0; k < 3; k++) c[k] += (s.a[k] + s.b[k]) / (2 * segs.length);
    let r = 0;
    for (const s of segs) for (const [q, rr] of [[s.a, s.r0], [s.b, s.r1]]) r = Math.max(r, Math.hypot(q[0] - c[0], q[1] - c[1], q[2] - c[2]) + rr);
    this.sphere.set(id, sp = { c, r });
    return sp;
  }

  bound(S) {
    const x = S.x, b = S.box;
    b[0] = b[1] = b[2] = Infinity; b[3] = b[4] = b[5] = -Infinity;
    for (let j = 0; j < x.length; j += 3) for (let k = 0; k < 3; k++) { const v = x[j + k]; if (v < b[k]) b[k] = v; if (v > b[k + 3]) b[k + 3] = v; }
  }
  static near(b, c, r) {
    const dx = Math.max(b[0] - c[0], 0, c[0] - b[3]), dy = Math.max(b[1] - c[1], 0, c[1] - b[4]), dz = Math.max(b[2] - c[2], 0, c[2] - b[5]);
    return dx * dx + dy * dy + dz * dz < r * r;
  }

  // ---- per tick, before the structure solve and the physics step ----
  step(dt) {
    const sim = this.sim, w = sim.world;
    if (!w.lines || !this.st.length) return;
    // loose wood that could be touching a line: each piece's bounding sphere, where it is now
    const bods = [];
    for (const [id, body] of sim.bodies) {
      const pc = w.pieces.get(id); if (!pc || pc.fixed) continue;
      const sp = this.sphereOf(id); if (!sp) continue;
      const c = sim.toWorld(id, sp.c, _v);
      bods.push({ id, body, c: [c.x, c.y, c.z], r: sp.r, asleep: body.isSleeping(), segs: null });
    }
    const check = sim.tick % 15 === 0;
    w.lines.list.forEach((L, i) => {
      const S = this.st[i]; if (!S) return;
      // a line that has been down LINE_DEAD_T goes dead (the tick it came down is in the model, so a new host keeps it)
      if (!L.dead && (L.brk.length || L.off[0] || L.off[1])) {
        const t0 = L.down !== undefined ? L.down : (S.down ??= sim.tick);   // (a world saved before snaps carried it)
        if (sim.tick - t0 >= CFG.LINE_DEAD_T / CFG.TICK) sim.emit({ t: 'dead', i });
      }
      const A = L.off[0] ? null : this.endNow(L.a), B = L.off[1] ? null : this.endNow(L.b);
      if (check) {           // an end whose wood is gone, or whose room broke: the line comes away there
        if (!L.off[0] && !A) { sim.emit({ t: 'snap', i, end: 0, tk: sim.tick, p: [S.x[0], S.x[1], S.x[2]].map((v) => +v.toFixed(3)) }); this.blamed(S); return; }
        const j = 3 * L.n;
        if (!L.off[1] && !B) { sim.emit({ t: 'snap', i, end: 1, tk: sim.tick, p: [S.x[j], S.x[j + 1], S.x[j + 2]].map((v) => +v.toFixed(3)) }); this.blamed(S); return; }
      }
      if (!S.awake) {
        for (const [P, q] of [[A, S.pin[0]], [B, S.pin[1]]]) if (P && q && Math.abs(P[0] - q[0]) + Math.abs(P[1] - q[1]) + Math.abs(P[2] - q[2]) > 1e-3) this.wake(S);
        if (!S.awake) for (const o of bods) if (!o.asleep && Lines.near(S.box, o.c, o.r + 0.3)) { this.wake(S); break; }
        if (!S.awake) return;
      }
      const own = new Set();
      for (const e of [L.a, L.b]) if (e.seg !== undefined) { const s = w.segs.get(e.seg); if (s) own.add(s.piece); }
      const near = bods.filter((o) => !own.has(o.id) && Lines.near(S.box, o.c, o.r + 0.3));
      // whose wood is on the line, or holds an end that has come loose: theirs if it snaps soon (a sticker, D111)
      for (const id of [...near.map((o) => o.id), ...own]) { const by = sim.awards.by.get(id); if (by !== undefined && by >= 0) S.blame = { id: by, t: sim.tick }; }
      this.solve(L, S, A, B, near, dt);
      this.push(L, S, near, dt);
      // the ends pull on what holds them
      for (const [end, k0, k1, e] of [[0, 0, 1, L.a], [1, L.n, L.n - 1, L.b]]) {
        const link = end ? L.n - 1 : 0, T = S.T[link];
        if (!(T > 0) || L.off[end] || e.seg === undefined) continue;
        const x = S.x;
        _f.set(x[3 * k1] - x[3 * k0], x[3 * k1 + 1] - x[3 * k0 + 1], x[3 * k1 + 2] - x[3 * k0 + 2]).normalize().multiplyScalar(T);
        const s = w.segs.get(e.seg), body = s && sim.bodies.get(s.piece); if (!body) continue;
        _p.set(x[3 * k0], x[3 * k0 + 1], x[3 * k0 + 2]);
        if (w.pieces.get(s.piece).fixed) { sim.applyForce(e.seg, _p, _f); continue; }
        // on loose wood the line is also a damper (half critical, for the wood's mass at that end), so a pole
        // hanging on its lines settles instead of bouncing on them
        const v = body.velocityAtPoint(_p), u = _f.clone().divideScalar(T), along = v.x * u.x + v.y * u.y + v.z * u.z;
        const c = Math.sqrt(CFG.LINE_EA / L.L0 * body.mass() / 3), Td = Math.max(0, T - c * along);
        this.impulse(body, u.multiplyScalar(Td * dt), _p);
      }
      // a link pulled past its strength snaps (one a tick)
      let kmax = -1, tmax = 0;
      for (let k = 0; k < L.n; k++) if (S.T[k] > tmax) { tmax = S.T[k]; kmax = k; }
      S.tmax = tmax;
      if (tmax > CFG.LINE_BREAK_F) {
        const x = S.x, p = [0, 1, 2].map((c) => +((x[3 * kmax + c] + x[3 * kmax + 3 + c]) / 2).toFixed(3));
        sim.emit({ t: 'snap', i, k: kmax, tk: sim.tick, p });
        this.blamed(S);
      }
    });
  }

  /** XPBD: integrate the free points, pin the ends, then sweep the links (pull only), the wood and the ground. */
  solve(L, S, A, B, near, dt) {
    const sim = this.sim, x = S.x, px = S.px, n = L.n, h = dt / SUB, l0 = L.L0 / n;
    const m = Math.max(0.05, CFG.LINE_KG_M * l0), wFree = 1 / m, alpha = l0 / (Math.max(1, CFG.LINE_EA) * h * h);
    const brk = L.brk, gh = -CFG.GRAVITY * h * h, pinA = !L.off[0] && A, pinB = !L.off[1] && B;
    const wt = (k) => ((k === 0 && pinA) || (k === n && pinB) ? 0 : wFree);
    const before = x.slice();
    const pa0 = S.pin[0], pb0 = S.pin[1];
    S.touch.fill(-1);
    // wood near the line this tick: each segment's axis in the world and its radii
    // (and where it was a tick ago, from its speed: which side of the wood a line is on is decided by where it was
    // then, so a thin stick falling fast cannot pass through a line between two ticks)
    for (const o of near) if (!o.segs) o.segs = sim.world.segsOf(o.id).map((s) => {
      const a = sim.segToWorld(s, s.a, new THREE.Vector3()), b = sim.segToWorld(s, s.b, new THREE.Vector3());
      const va = o.body.velocityAtPoint(a), pa = [a.x - va.x * dt, a.y - va.y * dt, a.z - va.z * dt];
      const vb = o.body.velocityAtPoint(b), pb = [b.x - vb.x * dt, b.y - vb.y * dt, b.z - vb.z * dt];
      return { a: [a.x, a.y, a.z], b: [b.x, b.y, b.z], pa, pb, r0: s.r0, r1: s.r1, s };
    });
    S.before = before;
    for (let sub = 0; sub < SUB; sub++) {
      const f = (sub + 1) / SUB;
      for (let k = 0; k <= n; k++) {
        const j = 3 * k;
        const pin = k === 0 ? pinA : k === n ? pinB : null;
        if (pin) {
          const q = k === 0 ? pa0 : pb0;
          for (let c = 0; c < 3; c++) { px[j + c] = x[j + c]; x[j + c] = q ? q[c] + (pin[c] - q[c]) * f : pin[c]; }
          continue;
        }
        for (let c = 0; c < 3; c++) { const v = (x[j + c] - px[j + c]) * 0.995; px[j + c] = x[j + c]; x[j + c] += v; }
        x[j + 1] += gh;
      }
      S.lam.fill(0);
      for (let it = 0; it < ITER; it++) {
        const fwd = it % 2 === 0;
        for (let q = 0; q < n; q++) {
          const k = fwd ? q : n - 1 - q;
          if (brk.length && brk.includes(k)) continue;
          const i0 = 3 * k, i1 = i0 + 3, w0 = wt(k), w1 = wt(k + 1);
          if (w0 + w1 === 0) continue;
          const dx = x[i1] - x[i0], dy = x[i1 + 1] - x[i0 + 1], dz = x[i1 + 2] - x[i0 + 2], d = Math.hypot(dx, dy, dz);
          if (d < 1e-9) continue;
          const C = d - l0;
          let dl = (-C - alpha * S.lam[k]) / (w0 + w1 + alpha);
          const nl = Math.min(0, S.lam[k] + dl); dl = nl - S.lam[k]; S.lam[k] = nl;     // a line pulls, never pushes
          if (!dl) continue;
          const sx = dl * dx / d, sy = dl * dy / d, sz = dl * dz / d;
          x[i0] -= w0 * sx; x[i0 + 1] -= w0 * sy; x[i0 + 2] -= w0 * sz;
          x[i1] += w1 * sx; x[i1 + 1] += w1 * sy; x[i1 + 2] += w1 * sz;
        }
      }
      if (near.length) this.collide(L, S, near, wt, h);
      // the ground: nothing goes under it, and what lies on it drags
      for (let k = 0; k <= n; k++) {
        if (!wt(k)) continue;
        const j = 3 * k, g = sim.groundY(x[j], x[j + 2]) + R_LINE;
        if (x[j + 1] < g) {
          x[j + 1] = g; px[j + 1] = Math.min(px[j + 1], g);
          px[j] = x[j] - (x[j] - px[j]) * 0.3; px[j + 2] = x[j + 2] - (x[j + 2] - px[j + 2]) * 0.3;
        }
      }
    }
    for (let k = 0; k < n; k++) S.T[k] = -S.lam[k] / (h * h);
    S.pin[0] = pinA ? pinA.slice() : null; S.pin[1] = pinB ? pinB.slice() : null;
    // asleep again once nothing has moved for a second
    let mv = 0;
    for (let j = 0; j < x.length; j++) mv = Math.max(mv, Math.abs(x[j] - before[j]));
    if (mv > 0.01) { S.moved = true; }
    if (mv > 5e-4) { S.last = sim.tick; S.still = 0; } else if (++S.still > 60 && !S.touch.some((t) => t >= 0)) { S.awake = false; px.set(x); }
    this.bound(S);
  }

  /** Wood pushes the line out of itself: each link against each segment of each piece near, as a cylinder. */
  collide(L, S, near, wt, h) {
    const x = S.x, px = S.px, n = L.n, brk = L.brk;
    for (let oi = 0; oi < near.length; oi++) {
      const o = near[oi];
      for (let k = 0; k < n; k++) {
        if (brk.length && brk.includes(k)) continue;
        const i0 = 3 * k, i1 = i0 + 3;
        // quick: is the link anywhere near the piece?
        const mx = (x[i0] + x[i1]) / 2 - o.c[0], my = (x[i0 + 1] + x[i1 + 1]) / 2 - o.c[1], mz = (x[i0 + 2] + x[i1 + 2]) / 2 - o.c[2];
        const hl = Math.hypot(x[i1] - x[i0], x[i1 + 1] - x[i0 + 1], x[i1 + 2] - x[i0 + 2]) / 2;
        if (mx * mx + my * my + mz * mz > (o.r + hl + R_LINE) ** 2) continue;
        for (const g of o.segs) {
          const c = closest(x, i0, i1, g.a, g.b);
          const r = g.r0 + (g.r1 - g.r0) * c.t + R_LINE;
          if (c.d >= r + 0.3) continue;
          // the side the line was on a tick ago, if it was clear of the wood then: it is pushed back out that way
          const c0 = closest(S.before, i0, i1, g.pa, g.pb);
          let nx = c.nx, ny = c.ny, nz = c.nz, sep = c.d;
          if (c0.d >= r - 0.002 || c.d < 1e-6) {
            nx = c0.d > 1e-6 ? c0.nx : 0; ny = c0.d > 1e-6 ? c0.ny : 1; nz = c0.d > 1e-6 ? c0.nz : 0;
            sep = (c.qx - c.ax) * nx + (c.qy - c.ay) * ny + (c.qz - c.az) * nz;
          }
          if (sep >= r) continue;
          const pen = r - sep, u = c.u, s2 = (1 - u) * (1 - u) + u * u;
          const w0 = wt(k) ? 1 : 0, w1 = wt(k + 1) ? 1 : 0;
          if (!w0 && !w1) continue;
          const f0 = w0 * (1 - u) / s2, f1 = w1 * u / s2;
          x[i0] += nx * pen * f0; x[i0 + 1] += ny * pen * f0; x[i0 + 2] += nz * pen * f0;
          x[i1] += nx * pen * f1; x[i1 + 1] += ny * pen * f1; x[i1 + 2] += nz * pen * f1;
          // the wood carries the line along with it (friction): half the speed it has against the wood is lost
          const v = o.body.velocityAtPoint({ x: c.qx, y: c.qy, z: c.qz }), vx = v.x * h, vy = v.y * h, vz = v.z * h;
          for (const [j, ff] of [[i0, f0], [i1, f1]]) {
            if (!ff) continue;
            px[j] += ((x[j] - px[j]) - vx) * 0.5 * Math.min(1, ff); px[j + 1] += ((x[j + 1] - px[j + 1]) - vy) * 0.5 * Math.min(1, ff); px[j + 2] += ((x[j + 2] - px[j + 2]) - vz) * 0.5 * Math.min(1, ff);
          }
          const tk = u < 0.5 ? k : k + 1;
          S.touch[tk] = oi; S.tp[3 * tk] = c.ax; S.tp[3 * tk + 1] = c.ay; S.tp[3 * tk + 2] = c.az;
        }
      }
    }
  }

  /** The line pushes back on the wood it touches: at each point touching, the pull of its two links. */
  push(L, S, near, dt) {
    const x = S.x, n = L.n, m = CFG.LINE_KG_M * L.L0 / n;
    for (let k = 0; k <= n; k++) {
      const oi = S.touch[k]; if (oi < 0) continue;
      const o = near[oi], j = 3 * k;
      _f.set(0, -m * CFG.GRAVITY, 0);
      for (const [link, kk] of [[k - 1, k - 1], [k, k + 1]]) {
        if (link < 0 || link >= n || L.brk.includes(link)) continue;
        const T = S.T[link]; if (!(T > 0)) continue;
        const dx = x[3 * kk] - x[j], dy = x[3 * kk + 1] - x[j + 1], dz = x[3 * kk + 2] - x[j + 2], d = Math.hypot(dx, dy, dz) || 1;
        _f.x += T * dx / d; _f.y += T * dy / d; _f.z += T * dz / d;
      }
      _p.set(S.tp[j], S.tp[j + 1], S.tp[j + 2]);
      // a line is no trampoline: wood on its way back out (moving along the push) gets only part of it back
      const v = o.body.velocityAtPoint(_p), F = _f.length();
      if (F > 0 && (v.x * _f.x + v.y * _f.y + v.z * _f.z) > 0) _f.multiplyScalar(LINE_REBOUND);
      this.impulse(o.body, _f.multiplyScalar(dt), _p);
    }
  }

  /** An impulse J (Vector3, changed) on a loose body at p, at most what changes its speed by DV_MAX. */
  impulse(body, J, p) {
    const cap = body.mass() * DV_MAX, l = J.length();
    if (l > cap) J.multiplyScalar(cap / l);
    body.applyImpulseAtPoint({ x: J.x, y: J.y, z: J.z }, p, true);
  }

  // ---- after the players have moved: anyone touching a line is shocked ----
  shocks(dt) {
    const sim = this.sim, w = sim.world;
    for (const [id, t] of this.shockT) { if (t - dt <= 0) this.shockT.delete(id); else this.shockT.set(id, t - dt); }
    if (!w.lines || !this.st.length) return;
    const reach = CFG.P_RADIUS + 0.1;            // (a line lying on the ground under your boots counts)
    for (const p of sim.players.list.values()) {
      if (p.inj >= INJ.DOWN || this.shockT.has(p.id)) continue;
      const c = p.body.translation(), a = [c.x, c.y - CFG.P_HALF, c.z], b = [c.x, c.y + CFG.P_HALF, c.z];
      const mid = [c.x, c.y, c.z];
      let hit = null;
      for (let i = 0; i < this.st.length && !hit; i++) {
        const S = this.st[i], L = w.lines.list[i];
        if (L.dead || !Lines.near(S.box, mid, CFG.P_HALF + reach)) continue;
        for (let k = 0; k < L.n && !hit; k++) {
          if (L.brk.includes(k)) continue;
          const q = closest(S.x, 3 * k, 3 * k + 3, a, b);
          if (q.d < reach) hit = [q.qx, q.qy, q.qz];
        }
      }
      if (hit) { this.shockT.set(p.id, CFG.SHOCK_AGAIN); sim.players.shock(p, hit); }
    }
  }

  /** Links near world point o (within r), for anything that can cut a line: [from, to, {line, k}]. */
  spans(o, r) {
    const w = this.sim.world, out = [];
    if (!w.lines) return out;
    const c = [o.x, o.y, o.z];
    this.st.forEach((S, i) => {
      const L = w.lines.list[i];
      if (!Lines.near(S.box, c, r)) return;
      for (let k = 0; k < L.n; k++) {
        if (L.brk.includes(k)) continue;
        out.push([new THREE.Vector3(S.x[3 * k], S.x[3 * k + 1], S.x[3 * k + 2]), new THREE.Vector3(S.x[3 * k + 3], S.x[3 * k + 4], S.x[3 * k + 5]), { line: i, k }]);
      }
    });
    return out;
  }
  /** Line S snapped by itself: the player whose wood was on it lately gets the ghost bolt. */
  blamed(S) {
    const b = S.blame;
    if (b && this.sim.tick - b.t <= CFG.STICKER_LINE_T / CFG.TICK) this.sim.awards.line(b.id);
  }
  /** A saw went through link k of line i (player p held it): it parts, and p takes the shock. */
  cut(i, k, p) {
    const S = this.st[i]; if (!S) return;
    const x = S.x, at = [0, 1, 2].map((c) => +((x[3 * k + c] + x[3 * k + 3 + c]) / 2).toFixed(3));
    const live = !this.sim.world.lines.list[i].dead;
    this.sim.emit({ t: 'snap', i, k, tk: this.sim.tick, p: at });
    if (p) this.sim.awards.line(p.id);
    if (p && live && !this.shockT.has(p.id) && p.inj < INJ.DOWN) { this.shockT.set(p.id, CFG.SHOCK_AGAIN); this.sim.players.shock(p, at); }
  }

  /** aux.ln: the points of every line that moved lately, and every 3 s of every line that is not as it was put up (in cm). */
  aux() {
    const sim = this.sim, out = [], recent = sim.tick - 2 * CFG.AUX_EVERY, all = sim.tick % 180 < CFG.AUX_EVERY;
    this.st.forEach((S, i) => {
      if (!(S.last >= recent || (all && S.moved))) return;
      const r = [i];
      for (let j = 0; j < S.x.length; j++) r.push(Math.round(S.x[j] * 100));
      out.push(r);
    });
    return out;
  }

  /** Host handover (sim/resume.js): points of lines as the last host sent them (LinePoses). */
  restore(poses) {
    if (!poses) return;
    this.st.forEach((S, i) => {
      const x = poses.get(i); if (!x || x.length !== S.x.length) return;
      S.x.set(x); S.px.set(x); S.moved = true; this.bound(S); this.wake(S);
    });
  }
}

/**
 * Closest points between link x[i0]..x[i1] (in flat array x) and segment a..b: u along the link, t along a..b,
 * d the distance, n the unit direction from the segment's point to the link's, q the link's point, a* the segment's.
 */
function closest(x, i0, i1, a, b) {
  const p0x = x[i0], p0y = x[i0 + 1], p0z = x[i0 + 2];
  const d1x = x[i1] - p0x, d1y = x[i1 + 1] - p0y, d1z = x[i1 + 2] - p0z;
  const d2x = b[0] - a[0], d2y = b[1] - a[1], d2z = b[2] - a[2];
  const rx = p0x - a[0], ry = p0y - a[1], rz = p0z - a[2];
  const A = d1x * d1x + d1y * d1y + d1z * d1z, E = d2x * d2x + d2y * d2y + d2z * d2z, F = d2x * rx + d2y * ry + d2z * rz;
  let u, t;
  if (A < 1e-12 && E < 1e-12) { u = 0; t = 0; }
  else if (A < 1e-12) { u = 0; t = clamp(F / E); }
  else {
    const C = d1x * rx + d1y * ry + d1z * rz;
    if (E < 1e-12) { t = 0; u = clamp(-C / A); }
    else {
      const B = d1x * d2x + d1y * d2y + d1z * d2z, den = A * E - B * B;
      u = den > 1e-12 ? clamp((B * F - C * E) / den) : 0;
      t = (B * u + F) / E;
      if (t < 0) { t = 0; u = clamp(-C / A); } else if (t > 1) { t = 1; u = clamp((B - C) / A); }
    }
  }
  const qx = p0x + d1x * u, qy = p0y + d1y * u, qz = p0z + d1z * u;
  const ax = a[0] + d2x * t, ay = a[1] + d2y * t, az = a[2] + d2z * t;
  const vx = qx - ax, vy = qy - ay, vz = qz - az, d = Math.hypot(vx, vy, vz);
  return { u, t, d, nx: d ? vx / d : 0, ny: d ? vy / d : 1, nz: d ? vz / d : 0, qx, qy, qz, ax, ay, az };
}
const clamp = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
