// Structure: what every fibre of every piece of wood is carrying, and what
// happens when fibres give way. Host only. See docs/DESIGN.md 3.
//
// Two regimes, one fibre model:
//  * STIFF  - while every fibre of a bundle is elastic, the wood on both sides
//    is one rigid body and load is shared between fibres by a static solve
//    (fibres.analyse). That solve is the exact stiff limit of the fibre model.
//  * LIVE   - the moment a fibre passes its elastic limit, the wood beyond
//    that bundle becomes its own rigid body, held to its parent by nothing but
//    the bundle's fibres acting as individual elastic-plastic springs (plus
//    contact where saw kerfs close). Hinging, tearing, peeling, twisting off
//    and coming free are not states: they are whatever the surviving fibres do.
//
// Rooted (fixed) pieces are created at the origin with identity rotation, so
// for them piece-local coordinates ARE world coordinates. The beam pass relies
// on that.

import * as THREE from 'three';
import { CFG } from '../config.js';
import { segAxis, segMass, segCentroidT, segParam, segRadius, lerp3 } from '../model/world.js';
import { analyse, bundleBasis, layout, gapOf, INTACT, CUT } from '../model/fibres.js';
import { segDist } from './saw.js';

const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const G = CFG.GRAVITY;
const ELASTIC = 0, CONTACT = 1, BROKEN = 2;     // live fibre states (BROKEN = splintered: still bears on its stump)
const OFF = 0, LIN = 1, CAP = 2;                // how a fibre is treated within one implicit step

export class Structure {
  constructor(sim) {
    this.sim = sim;
    this.beam = new Map();      // seg id -> {F:[3], M:[3]}  (distal force, moment about origin)
    this.live = new Map();      // distal piece id -> live joint
    this.noHit = new Map();     // seg id -> Set of piece ids it must not collide with (the wood it is still joined to)
    this.parting = [];          // joints that have let go but whose bodies have not moved apart yet
    this.rootOf = new Map();    // root seg of a live distal piece -> the parent piece (they overlap at the joint)
  }

  onRemove(piece) {
    for (const [id, j] of [...this.live]) if (id === piece || j.parent === piece) this.endJoint(id, j);
  }

  step(dt) {
    const w = this.sim.world;
    for (const [id, j] of [...this.live]) this.liveStep(id, j, dt);
    if (this.parting.length && this.sim.tick % 6 === 0) this.checkParting();
    for (const piece of w.pieces.values()) {
      if (!piece.fixed) continue;
      this.beamPass(piece);
      for (const s of [...w.segsOf(piece.id)]) if (w.segs.has(s.id) && s.piece === piece.id) this.bundleStep(s);
    }
  }

  // ---- beam analysis: total force and moment carried past each segment's base ----
  beamPass(piece) {
    const w = this.sim.world, order = w.segsOf(piece.id), beam = this.beam;
    for (const s of order) {
      let b = beam.get(s.id); if (!b) beam.set(s.id, b = { F: [0, 0, 0], M: [0, 0, 0] });
      b.F[0] = b.F[1] = b.F[2] = b.M[0] = b.M[1] = b.M[2] = 0;
    }
    for (const l of this.sim.loads) { const b = beam.get(l.seg); if (b) addLoad(b, l); }
    for (let i = order.length - 1; i >= 0; i--) {
      const s = order[i], b = beam.get(s.id);
      addWeight(b, lerp3(s.a, s.b, segCentroidT(s)), segMass(s));
      if (s.leaf) addWeight(b, s.b, s.leaf);
      if (s.parent >= 0) {
        const pb = beam.get(s.parent);
        pb.F[0] += b.F[0]; pb.F[1] += b.F[1]; pb.F[2] += b.F[2];
        pb.M[0] += b.M[0]; pb.M[1] += b.M[1]; pb.M[2] += b.M[2];
      }
    }
  }

  // ---- one bundle in the stiff regime ----
  bundleStep(s) {
    const sim = this.sim, w = sim.world, f = s.f;
    if (f.ncut === f.n) { this.separate(s, false); return; }
    let F, M;
    if (f.at <= 0) { const b = this.beam.get(s.id); F = b.F; M = b.M; }
    else {
      // distal load at the cut plane: children + the rest of this segment + point loads beyond it
      F = [0, 0, 0]; M = [0, 0, 0]; const acc = { F, M };
      for (const k of w.kids(s.id)) {
        const b = this.beam.get(k); if (!b) continue;
        F[0] += b.F[0]; F[1] += b.F[1]; F[2] += b.F[2]; M[0] += b.M[0]; M[1] += b.M[1]; M[2] += b.M[2];
      }
      addWeight(acc, lerp3(s.a, s.b, segCentroidT(s, f.at, 1)), segMass(s, f.at, 1));
      if (s.leaf) addWeight(acc, s.b, s.leaf);
      for (const l of sim.loads) if (l.seg === s.id && segParam(s, l.p) >= f.at) addLoad(acc, l);
    }
    const ax = segAxis(s), { u, v } = bundleBasis(ax), C = lerp3(s.a, s.b, f.at), cxF = cross(C, F);
    const Mc = [M[0] - cxF[0], M[1] - cxF[1], M[2] - cxF[2]];
    if (!analyse(f, segRadius(s, f.at), dot(F, ax), dot(Mc, u), dot(Mc, v))) { this.separate(s, false); return; }
    // a fibre past its elastic limit: from here on the fibres themselves decide
    if (f.maxT > CFG.MOR && (s.parent >= 0 || f.ncut > 0)) this.separate(s, true);
  }

  /** Called by the saw after it severs fibres. */
  afterCut(s) { if (s.f.ncut === s.f.n) this.separate(s, false); }

  /** The wood beyond this bundle becomes its own body; live = still held by the bundle's fibres. */
  separate(s, live) {
    const sim = this.sim, w = sim.world, f = s.f;
    let at = f.at;
    if (at < 0.03) at = s.parent >= 0 ? 0 : 0.03;
    if (at > 0.97) at = 0.97;
    const ax = segAxis(s), { u, v } = bundleBasis(ax), O = lerp3(s.a, s.b, at), R = segRadius(s, at);
    const L = layout(f.N), n = f.n;
    const parent = s.piece, parentSeg = at > 0 ? s.id : s.parent;
    const newPiece = w.newId(), newSeg = at > 0 ? w.newId() : s.id;
    const j = live ? {
      parent, parentSeg, rootSeg: newSeg, O, n: ax, u, v, R, N: f.N, count: n,
      st: Uint8Array.from(f.state, (x) => (x === CUT ? CONTACT : ELASTIC)),
      gap: Float32Array.from({ length: n }, (_, i) => (f.state[i] === CUT ? gapOf(f, i) : 0)),
      p: new Float32Array(n), force: new Float32Array(n), angle: 0, age: 0,
    } : null;
    sim.emit({ t: 'split', seg: s.id, at, newSeg, newPiece });
    if (!j) return;
    this.live.set(newPiece, j);
    let set = this.noHit.get(parentSeg); if (!set) this.noHit.set(parentSeg, set = new Set());
    set.add(newPiece);
    this.rootOf.set(newSeg, parent);
    sim.segCol.get(parentSeg)?.setActiveHooks(sim.R.ActiveHooks.FILTER_CONTACT_PAIRS);
    sim.segCol.get(newSeg)?.setActiveHooks(sim.R.ActiveHooks.FILTER_CONTACT_PAIRS);
    sim.toast('fibres are giving way');
  }

  // The last fibre has gone. The two bodies still overlap where they were joined (colliders know nothing
  // of notches), so they only start colliding with each other once they have actually moved apart.
  endJoint(id, j) {
    this.live.delete(id);
    this.parting.push({ id, j });
  }
  unfilter(id, j) {
    this.rootOf.delete(j.rootSeg);
    const set = this.noHit.get(j.parentSeg);
    if (set) { set.delete(id); if (!set.size) this.noHit.delete(j.parentSeg); }
  }
  checkParting() {
    const sim = this.sim, w = sim.world;
    this.parting = this.parting.filter(({ id, j }) => {
      const a = w.segs.get(j.rootSeg), b = w.segs.get(j.parentSeg);
      if (a && b && sim.bodies.has(a.piece) && sim.bodies.has(b.piece)) {
        const d = segDist(sim.toWorld(a.piece, a.a), sim.toWorld(a.piece, a.b), sim.toWorld(b.piece, b.a), sim.toWorld(b.piece, b.b)).d;
        if (d < Math.max(a.r0, a.r1) + Math.max(b.r0, b.r1) + 0.03) return true;      // still overlapping
      }
      this.unfilter(id, j);
      return false;
    });
  }

  /** Saw severed fibres of a live bundle. */
  cutLive(id, idx) {
    const j = this.live.get(id); if (!j) return;
    for (const i of idx) if (j.st[i] === ELASTIC) { j.st[i] = CONTACT; j.gap[i] = CFG.KERF_WIDTH; }
  }

  // ---- one bundle in the live regime: every fibre is a spring between two bodies ----
  liveStep(id, j, dt) {
    const sim = this.sim, B = sim.bodies.get(id), P = sim.bodies.get(j.parent);
    if (!B || !P) { this.endJoint(id, j); return; }
    j.age++;
    const L = layout(j.N), n = L.n, R = j.R, X = L.X, Y = L.Y;
    const A = L.dA * R * R, h = L.cs * R;
    const Ft = CFG.MOR * A, Fc = CFG.COMP * A, k = Ft / CFG.FIBRE_YIELD, ks = 0.4 * k, ey = CFG.FIBRE_YIELD, ec = Fc / k;
    // frames: the bundle face on the parent (O, u, v, nrm) and the same face carried by the distal body
    const Ow = sim.toWorld(j.parent, j.O, _O), nw = sim.dirToWorld(j.parent, j.n, _n), uw = sim.dirToWorld(j.parent, j.u, _u), vw = sim.dirToWorld(j.parent, j.v, _v);
    const Ob = sim.toWorld(id, j.O, _Ob), ub = sim.dirToWorld(id, j.u, _ub), vb = sim.dirToWorld(id, j.v, _vb);
    // relative rotation of the distal body, as a rotation vector
    const qp = P.rotation(), qb = B.rotation();
    _qa.set(qb.x, qb.y, qb.z, qb.w).multiply(_qb.set(qp.x, qp.y, qp.z, qp.w).invert());
    if (_qa.w < 0) { _qa.x = -_qa.x; _qa.y = -_qa.y; _qa.z = -_qa.z; _qa.w = -_qa.w; }
    const sh = Math.hypot(_qa.x, _qa.y, _qa.z), ang = 2 * Math.atan2(sh, _qa.w), sc = sh > 1e-9 ? ang / sh : 2;
    const th = [_qa.x * sc, _qa.y * sc, _qa.z * sc], nv = [nw.x, nw.y, nw.z];
    const tn = dot(th, nv), thp = [th[0] - tn * nv[0], th[1] - tn * nv[1], th[2] - tn * nv[2]];
    const bend = Math.hypot(thp[0], thp[1], thp[2]);
    j.angle = bend;

    // Fibre force law over this step (implicit):  f = k (e + (dt + damp) * rate),  clamped to [-Fc, Ft]
    // (severed faces: [-Fc, 0]).  e = elongation now (less plastic set), rate = elongation rate at the END
    // of the step. The end-of-step motion depends on all the forces, so: assume every fibre is inside its
    // limits, solve the 6-DOF system, clamp the ones that are not, and repeat (active set).
    const dOx = Ob.x - Ow.x, dOy = Ob.y - Ow.y, dOz = Ob.z - Ow.z;
    const E = _E, RX = _RX, RY = _RY, RZ = _RZ, SX = _SX, SY = _SY, SZ = _SZ, mode = _mode, capF = _capF;
    let alive = 0, kOwn = 0, mOwn = 0;
    for (let i = 0; i < n; i++) {
      const x = X[i] * R, y = Y[i] * R;
      // d = where this fibre's end on the distal body is, relative to its root on the parent
      const dx = dOx + x * (ub.x - uw.x) + y * (vb.x - vw.x), dy = dOy + x * (ub.y - uw.y) + y * (vb.y - vw.y), dz = dOz + x * (ub.z - uw.z) + y * (vb.z - vw.z);
      const del = dx * nv[0] + dy * nv[1] + dz * nv[2];          // elongation along the grain
      SX[i] = dx - del * nv[0]; SY[i] = dy - del * nv[1]; SZ[i] = dz - del * nv[2];   // sideways slip
      RX[i] = dOx + x * ub.x + y * vb.x; RY[i] = dOy + x * ub.y + y * vb.y; RZ[i] = dOz + x * ub.z + y * vb.z;   // lever from O
      if (j.st[i] === ELASTIC && (del - j.p[i] > CFG.FIBRE_STRETCH - bend * h / 2 || del + bend * h / 2 > CFG.FIBRE_STRETCH
        || Math.hypot(SX[i], SY[i], SZ[i]) > CFG.FIBRE_SLIP || bend > CFG.BEND_MAX)) j.st[i] = BROKEN;
      if (j.st[i] === ELASTIC) {
        alive++; kOwn += k * h * h / 12; mOwn += Ft * h / 4;
        // a fibre found beyond its elastic range has already stretched or crushed that far: it takes a set
        if (del - j.p[i] > ey) j.p[i] = del - ey; else if (del - j.p[i] < -ec) j.p[i] = del + ec;
        E[i] = del - j.p[i];
      } else {
        // severed faces: touching once the gap has closed. Wood that has been pushed into wood has crushed
        // to fit, so contact only ever resists further closing - it never springs back.
        if (del + j.gap[i] < 0) j.gap[i] = -del;
        E[i] = del + j.gap[i];
      }
      mode[i] = j.st[i] === ELASTIC || E[i] <= 0 ? LIN : OFF;    // OFF = not touching
      DEL[i] = del;
    }
    if (!alive) { this.endJoint(id, j); if (j.age > 1) sim.toast('it came free'); return; }

    const W = _W; for (let a = 0; a < 36; a++) W[a] = 0;
    addInvMass(W, B, Ow); addInvMass(W, P, Ow);
    const vB = B.linvel(), wB = B.angvel(), cB = B.worldCom(), vP = P.linvel(), wP = P.angvel(), cP = P.worldCom();
    const uu = [
      vB.x + (wB.y * (Ow.z - cB.z) - wB.z * (Ow.y - cB.y)) - vP.x - (wP.y * (Ow.z - cP.z) - wP.z * (Ow.y - cP.y)),
      vB.y + (wB.z * (Ow.x - cB.x) - wB.x * (Ow.z - cB.z)) - vP.y - (wP.z * (Ow.x - cP.x) - wP.x * (Ow.z - cP.z)),
      vB.z + (wB.x * (Ow.y - cB.y) - wB.y * (Ow.x - cB.x)) - vP.z - (wP.x * (Ow.y - cP.y) - wP.y * (Ow.x - cP.x)),
      wB.x - wP.x, wB.y - wP.y, wB.z - wP.z,
    ];
    if (!P.isDynamic()) uu[1] -= G * dt;                 // gravity is about to act on the distal body only
    const coef = dt + CFG.FIBRE_DAMP, K = _K, D = _D, Am = _A, ue = [0, 0, 0, 0, 0, 0];
    let lam = null, ownCap = false, mcx = 0, mcy = 0, mcz = 0;
    for (let iter = 0; iter < 6; iter++) {
      for (let a = 0; a < 36; a++) K[a] = 0;
      const wr = [0, 0, 0, 0, 0, 0];
      for (let i = 0; i < n; i++) {
        const m = mode[i], el = j.st[i] === ELASTIC;
        if (m === OFF && !el) continue;
        const fa = m === LIN ? k * E[i] : m === CAP ? capF[i] : 0, kl = el ? ks : 0;
        const fx = -fa * nv[0] - kl * SX[i], fy = -fa * nv[1] - kl * SY[i], fz = -fa * nv[2] - kl * SZ[i];
        wr[0] += fx; wr[1] += fy; wr[2] += fz;
        wr[3] += RY[i] * fz - RZ[i] * fy; wr[4] += RZ[i] * fx - RX[i] * fz; wr[5] += RX[i] * fy - RY[i] * fx;
        addStiffness(K, nv, m === LIN ? k : 0, kl, RX[i], RY[i], RZ[i]);
      }
      // each fibre also resists being bent over its own thickness (what a thin hinge strip has left)
      if (ownCap) { wr[3] += mcx; wr[4] += mcy; wr[5] += mcz; }
      else {
        wr[3] -= kOwn * thp[0]; wr[4] -= kOwn * thp[1]; wr[5] -= kOwn * thp[2];
        for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) K[(3 + a) * 6 + 3 + b] += kOwn * ((a === b ? 1 : 0) - nv[a] * nv[b]);
      }
      //   lambda = dt (w0 - D (u + W lambda))    =>   (I + dt D W) lambda = dt (w0 - D u),   D = (dt + damp) K
      const rhs = [0, 0, 0, 0, 0, 0];
      for (let a = 0; a < 36; a++) D[a] = coef * K[a];
      for (let a = 0; a < 6; a++) {
        let du = 0;
        for (let b = 0; b < 6; b++) {
          du += D[a * 6 + b] * uu[b];
          let acc = 0; for (let c = 0; c < 6; c++) acc += D[a * 6 + c] * W[c * 6 + b];
          Am[a * 6 + b] = (a === b ? 1 : 0) + dt * acc;
        }
        rhs[a] = dt * (wr[a] - du);
      }
      lam = solve6(Am, rhs);
      if (!lam) { this.endJoint(id, j); return; }
      for (let a = 0; a < 6; a++) { let acc = uu[a]; for (let b = 0; b < 6; b++) acc += W[a * 6 + b] * lam[b]; ue[a] = acc; }
      // which fibres does that put outside their limits?
      let changed = false;
      for (let i = 0; i < n; i++) {
        const el = j.st[i] === ELASTIC;
        if (!el && mode[i] === OFF && E[i] > 0.002) continue;
        const rate = nv[0] * (ue[0] + ue[4] * RZ[i] - ue[5] * RY[i]) + nv[1] * (ue[1] + ue[5] * RX[i] - ue[3] * RZ[i]) + nv[2] * (ue[2] + ue[3] * RY[i] - ue[4] * RX[i]);
        RATE[i] = rate;
        const f = k * (E[i] + coef * rate);
        let want = LIN, cf = 0;
        if (el) { if (f > Ft) { want = CAP; cf = Ft; } else if (f < -Fc) { want = CAP; cf = -Fc; } }
        else if (f >= 0) want = OFF; else if (f < -Fc) { want = CAP; cf = -Fc; }
        if (want !== mode[i] || (want === CAP && cf !== capF[i])) { mode[i] = want; capF[i] = cf; changed = true; }
      }
      if (!ownCap && mOwn > 0) {
        const ex = thp[0] + coef * ue[3], ey = thp[1] + coef * ue[4], ez = thp[2] + coef * ue[5];
        const en = ex * nv[0] + ey * nv[1] + ez * nv[2], px = ex - en * nv[0], py = ey - en * nv[1], pz = ez - en * nv[2];
        const mm = kOwn * Math.hypot(px, py, pz);
        if (mm > mOwn) { const q = -mOwn / Math.hypot(px, py, pz); mcx = px * q; mcy = py * q; mcz = pz * q; ownCap = true; changed = true; }
      }
      if (!changed) break;
    }
    // what each fibre ended up carrying; fibres at a limit take a permanent set
    for (let i = 0; i < n; i++) {
      if (j.st[i] === BROKEN && mode[i] === OFF) { j.force[i] = NaN; continue; }
      const f = mode[i] === LIN ? k * (E[i] + coef * RATE[i]) : mode[i] === CAP ? capF[i] : 0;
      j.force[i] = j.st[i] === BROKEN ? NaN : f / Ft;
      if (j.st[i] === ELASTIC && mode[i] === CAP) j.p[i] = DEL[i] + dt * RATE[i] - capF[i] / k;
    }
    B.applyImpulseAtPoint({ x: lam[0], y: lam[1], z: lam[2] }, Ow, true);
    B.applyTorqueImpulse({ x: lam[3], y: lam[4], z: lam[5] }, true);
    if (P.isDynamic()) {
      P.applyImpulseAtPoint({ x: -lam[0], y: -lam[1], z: -lam[2] }, Ow, true);
      P.applyTorqueImpulse({ x: -lam[3], y: -lam[4], z: -lam[5] }, true);
    } else if (sim.world.segs.has(j.parentSeg)) {
      // what the fibres pull on the standing tree with goes into its own load sharing
      // (smoothed: a stiff solve chatters from tick to tick, and the tree's fibres should feel the load, not the chatter)
      const rf = j.rf || (j.rf = [0, 0, 0, 0, 0, 0]), kf = Math.min(1, dt / CFG.CONTACT_TAU);
      for (let a = 0; a < 6; a++) rf[a] += (-lam[a] / dt - rf[a]) * kf;
      sim.loads.push({ seg: j.parentSeg, p: [Ow.x, Ow.y, Ow.z], f: [rf[0], rf[1], rf[2]], m: [rf[3], rf[4], rf[5]] });
    }
  }

  /** Per-fibre stress for the clients' fibre colours: stiff bundles as a plane, live ones fibre by fibre. */
  aux() {
    const w = this.sim.world, fs = [], live = [];
    for (const piece of w.pieces.values()) {
      if (!piece.fixed) continue;
      for (const s of w.segsOf(piece.id)) fs.push(s.id, Math.round(s.f.c0 / 1e4), Math.round(s.f.s1 / 1e4), Math.round(s.f.s2 / 1e4));
    }
    for (const j of this.live.values()) {
      live.push({ seg: j.rootSeg, stub: j.parentSeg, a: +j.angle.toFixed(2), f: Array.from(j.force, (x) => (Number.isNaN(x) ? -128 : Math.max(-127, Math.min(127, Math.round(x * 100))))) });
    }
    return { fs, live };
  }
}

function addWeight(b, p, m) {
  const f = -m * G;                       // force (0, f, 0) at p; moment = p x f
  b.F[1] += f; b.M[0] += -p[2] * f; b.M[2] += p[0] * f;
}
function addLoad(b, l) {
  const m = cross(l.p, l.f);
  b.F[0] += l.f[0]; b.F[1] += l.f[1]; b.F[2] += l.f[2];
  b.M[0] += m[0]; b.M[1] += m[1]; b.M[2] += m[2];
  if (l.m) { b.M[0] += l.m[0]; b.M[1] += l.m[1]; b.M[2] += l.m[2]; }
}

// K += J^T (kl I + (kt - kl) n n^T) J   with J = [I, -[r]x]  (velocity of the point at lever r)
function addStiffness(K, n, kt, kl, rx, ry, rz) {
  const J = _J;
  J[3] = 0; J[4] = rz; J[5] = -ry; J[9] = -rz; J[10] = 0; J[11] = rx; J[15] = ry; J[16] = -rx; J[17] = 0;
  const dk = kt - kl;
  for (let c = 0; c < 3; c++) for (let b = 0; b < 6; b++) {
    // (Kf J)[c][b] = kl J[c][b] + dk n[c] (n . J[:,b])
    const nJ = n[0] * J[b] + n[1] * J[6 + b] + n[2] * J[12 + b];
    _M[c * 6 + b] = kl * J[c * 6 + b] + dk * n[c] * nJ;
  }
  for (let a = 0; a < 6; a++) for (let b = 0; b < 6; b++)
    K[a * 6 + b] += J[a] * _M[b] + J[6 + a] * _M[6 + b] + J[12 + a] * _M[12 + b];
}

// W += inverse mass of a body as seen at world point O:  [[1/m - S I^-1 S, S I^-1], [-I^-1 S, I^-1]],  S = [com - O]x
function addInvMass(W, body, O) {
  if (!body.isDynamic()) return;
  const im = body.invMass(), c = body.worldCom();
  // read the matrix out at once: `elements` is a view Rapier reuses on its next call
  const e = body.effectiveWorldInvInertia().elements;
  const I = [e[0], e[1], e[2], e[1], e[3], e[4], e[2], e[4], e[5]];
  const cx = c.x - O.x, cy = c.y - O.y, cz = c.z - O.z;
  const S = [0, -cz, cy, cz, 0, -cx, -cy, cx, 0];
  const SI = mul3(S, I), SIS = mul3(SI, S), IS = mul3(I, S);
  for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) {
    W[a * 6 + b] += (a === b ? im : 0) - SIS[a * 3 + b];
    W[a * 6 + 3 + b] += SI[a * 3 + b];
    W[(3 + a) * 6 + b] -= IS[a * 3 + b];
    W[(3 + a) * 6 + 3 + b] += I[a * 3 + b];
  }
}
function mul3(a, b) {
  const o = new Array(9);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) o[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j];
  return o;
}
/** Solve the 6x6 system A x = b (A row-major, destroyed). Returns x or null. */
function solve6(A, b) {
  for (let c = 0; c < 6; c++) {
    let p = c, best = Math.abs(A[c * 6 + c]);
    for (let r = c + 1; r < 6; r++) { const v = Math.abs(A[r * 6 + c]); if (v > best) { best = v; p = r; } }
    if (!(best > 1e-12)) return null;
    if (p !== c) { for (let k = 0; k < 6; k++) { const t = A[c * 6 + k]; A[c * 6 + k] = A[p * 6 + k]; A[p * 6 + k] = t; } const t = b[c]; b[c] = b[p]; b[p] = t; }
    for (let r = c + 1; r < 6; r++) {
      const m = A[r * 6 + c] / A[c * 6 + c]; if (!m) continue;
      for (let k = c; k < 6; k++) A[r * 6 + k] -= m * A[c * 6 + k];
      b[r] -= m * b[c];
    }
  }
  for (let c = 5; c >= 0; c--) {
    let s = b[c]; for (let k = c + 1; k < 6; k++) s -= A[c * 6 + k] * b[k];
    b[c] = s / A[c * 6 + c];
    if (!Number.isFinite(b[c])) return null;
  }
  return b;
}

const _K = new Float64Array(36), _W = new Float64Array(36), _D = new Float64Array(36), _A = new Float64Array(36);
const _J = new Float64Array(18), _M = new Float64Array(18);
const NF = 300;   // >= the most fibres in a bundle
const _E = new Float64Array(NF), DEL = new Float64Array(NF), RATE = new Float64Array(NF), _RX = new Float64Array(NF), _RY = new Float64Array(NF), _RZ = new Float64Array(NF);
const _SX = new Float64Array(NF), _SY = new Float64Array(NF), _SZ = new Float64Array(NF), _mode = new Uint8Array(NF), _capF = new Float64Array(NF);
_J[0] = 1; _J[7] = 1; _J[14] = 1;
const _qa = new THREE.Quaternion(), _qb = new THREE.Quaternion();
const _O = new THREE.Vector3(), _n = new THREE.Vector3(), _u = new THREE.Vector3(), _v = new THREE.Vector3();
const _Ob = new THREE.Vector3(), _ub = new THREE.Vector3(), _vb = new THREE.Vector3();
