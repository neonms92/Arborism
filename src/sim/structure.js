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

import * as THREE from '../../vendor/three/three.module.js';
import { CFG } from '../config.js';
import { segAxis, segLen, segMass, segCentroidT, segParam, segRadius, lerp3 } from '../model/world.js';
import { analyse, bundleBasis, layout, gapOf, makeBundle, fibreForces, isGone, INTACT, CUT } from '../model/fibres.js';
import { segDist } from './saw.js';
import { Flex, frameApply, frameDir } from '../model/flex.js';

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
    this.flex = new Flex(sim.world);   // elastic bending of the standing tree
    this.parting = [];          // joints that have let go but whose bodies have not moved apart yet
    this.rootOf = new Map();    // root seg of a live distal piece -> the parent piece (they overlap at the joint)
  }

  /** Is this piece the standing tree, or still joined to it by fibres (through any number of live bundles)? */
  isHeld(piece) {
    for (let n = 0; n < 8; n++) {
      if (this.sim.world.pieces.get(piece)?.fixed) return true;
      const j = this.live.get(piece); if (!j) return false;
      piece = j.parent;
    }
    return false;
  }

  reset() {
    this.beam.clear(); this.live.clear(); this.noHit.clear(); this.rootOf.clear(); this.parting.length = 0; this.flex.clear();
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
    // every fibre's change of length moves and tilts the disc at the end of its segment (model/flex.js)
    this.flex.update(dt, (s) => [s.f.e0, s.f.e1, s.f.e2]);
  }

  // ---- beam analysis: total force and moment carried past each segment's base ----
  // Weights act where the wood actually is (bent shape, from the last tick), so a lean adds to the moment
  // that caused it. That feedback is what lets a tilt run away when too few fibres are left to resist it.
  beamPass(piece) {
    const w = this.sim.world, order = w.segsOf(piece.id), beam = this.beam;
    for (const s of order) {
      let b = beam.get(s.id); if (!b) beam.set(s.id, b = { F: [0, 0, 0], M: [0, 0, 0] });
      b.F[0] = b.F[1] = b.F[2] = b.M[0] = b.M[1] = b.M[2] = 0;
    }
    for (const l of this.sim.loads) { const b = beam.get(l.seg); if (b) addLoad(b, l); }
    for (let i = order.length - 1; i >= 0; i--) {
      const s = order[i], b = beam.get(s.id);
      const tc = segCentroidT(s);
      addWeight(b, frameApply(this.flex.at(s.id, tc), lerp3(s.a, s.b, tc)), segMass(s));
      if (s.leaf) addWeight(b, frameApply(this.flex.at(s.id, 1), s.b), s.leaf);
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
      const tc = segCentroidT(s, f.at, 1);
      addWeight(acc, frameApply(this.flex.at(s.id, tc), lerp3(s.a, s.b, tc)), segMass(s, f.at, 1));
      if (s.leaf) addWeight(acc, frameApply(this.flex.at(s.id, 1), s.b), s.leaf);
      for (const l of sim.loads) if (l.seg === s.id && segParam(s, l.p) >= f.at) addLoad(acc, l);
    }
    // resolve the load in the bundle's own (bent) position and directions
    const fr = this.flex.at(s.id, f.at), a0 = segAxis(s), b0 = bundleBasis(a0);
    const ax = frameDir(fr, a0), u = frameDir(fr, b0.u), v = frameDir(fr, b0.v), C = frameApply(fr, lerp3(s.a, s.b, f.at)), cxF = cross(C, F);
    const Mc = [M[0] - cxF[0], M[1] - cxF[1], M[2] - cxF[2]];
    const R = segRadius(s, f.at), Nax = dot(F, ax), Mu = dot(Mc, u), Mv = dot(Mc, v);
    if (!analyse(f, R, Nax, Mu, Mv)) { this.separate(s, false); return; }
    if (f.ncut > 0 && this.ripCheck(s, R, Nax, Mu, Mv)) return;
    // a fibre past its elastic limit: from here on the fibres themselves decide
    if (f.maxT > CFG.MOR && (s.parent >= 0 || f.ncut > 0)) this.separate(s, true);
  }

  // ---- splitting along the grain (DECISIONS D50) ----
  // Where fibres have been severed, the ones left carry what the severed ones did. Away from the cut the
  // load spreads back over the whole section, so along any lengthwise plane through the wood the difference
  // has to cross from one side to the other as shear, within BOND_LEN of the cut. If that shear is more
  // than the wood's SHEAR strength, the wood splits along that plane: the side that was carrying less comes
  // away from the side carrying the load, and stays joined only to the wood above. Nothing here knows about
  // notches, back cuts or barber chairs: it is the same check for any pattern of severed fibres.
  ripCheck(s, R, Nax, Mu, Mv) {
    const f = s.f, n = f.n, Ly = layout(f.N), X = Ly.X, Y = Ly.Y;
    let real = 0, zlo = Infinity;
    for (let i = 0; i < n; i++) if (f.state[i] === CUT && !isGone(f, i)) { real++; if (f.zmin[i] < zlo) zlo = f.zmin[i]; }
    f.ripTau = 0;
    if (!real) return false;
    // the same wood and load with nothing severed (what it is like a little way above the cut)
    let ref = REF.get(f.N); if (!ref) REF.set(f.N, ref = makeBundle(f.N));
    ref.ncut = 0;
    for (let i = 0; i < n; i++) { const g = isGone(f, i); ref.state[i] = g ? CUT : INTACT; ref.zmin[i] = f.zmin[i]; ref.zmax[i] = f.zmax[i]; if (g) ref.ncut++; }
    if (ref.sgn) ref.sgn.fill(0);
    if (!analyse(ref, R, Nax, Mu, Mv)) return false;
    const T = fibreForces(f, R, _T), Tr = fibreForces(ref, R, _Tr), cs = Ly.cs;
    let best = 0, big = 0, bc = 0, bs = 0, bd = 0;
    for (let o = 0; o < 8; o++) {
      const c = Math.cos(o * Math.PI / 8), sn = Math.sin(o * Math.PI / 8);
      for (let k = 1; k < f.N; k++) {
        const d = -1 + cs * k;
        let dA = 0, nA = 0, nB = 0, on = 0;
        for (let i = 0; i < n; i++) {
          if (isGone(f, i)) continue;
          const p = X[i] * c + Y[i] * sn;
          if (p > d) { dA += T[i] - Tr[i]; nA++; } else nB++;
          if (Math.abs(p - d) < cs / 2) on++;            // fibres along the plane: about one per fibre pitch of its width
        }
        if (!nA || !nB || !on) continue;
        const tau = Math.abs(dA) / (on * cs * R * CFG.BOND_LEN);
        if (tau > best) best = tau;
        // of the planes that give way, the crack is the one that frees the most load (a sliver along the bark
        // can be the most stressed plane without being where the wood comes apart)
        if (tau > CFG.SHEAR && Math.abs(dA) > big) { big = Math.abs(dA); bc = c; bs = sn; bd = d; }
      }
    }
    f.ripTau = best;
    if (best <= CFG.SHEAR) return false;
    const sim = this.sim, w = sim.world, L = segLen(s);
    if (zlo > 0.1) {
      // the cut is partway along this segment: first give the wood above it a segment of its own (next tick it splits)
      sim.emit({ t: 'divide', seg: s.id, at: Math.min(0.95, (zlo - 0.02) / L), newSeg: w.newId() });
      return true;
    }
    // the side of the plane that was carrying less load comes away
    let la = 0, lb = 0; const ia = [], ib = [];
    for (let i = 0; i < n; i++) {
      if (isGone(f, i)) continue;
      if (X[i] * bc + Y[i] * bs > bd) { la += Math.abs(T[i]); ia.push(i); } else { lb += Math.abs(T[i]); ib.push(i); }
    }
    // the stem carries on above this segment into its biggest child that starts at its top
    let cont = -1, cr = 0;
    for (const k of w.kids(s.id)) {
      const c = w.segs.get(k);
      if (Math.abs(c.a[0] - s.b[0]) + Math.abs(c.a[1] - s.b[1]) + Math.abs(c.a[2] - s.b[2]) < 1e-3 && c.r0 > cr) { cr = c.r0; cont = k; }
    }
    sim.emit({ t: 'rip', seg: s.id, h: la <= lb ? ia : ib, newSeg: w.newId(), cont });
    sim.toast('the wood is splitting along the grain');
    return true;
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
      Lg: Math.max(0.15, segLen(s) * (1 - at)),      // length of the fibres across this bundle: what they stretch over
    } : null;
    const fr = at > 0 ? this.flex.at(s.id, at) : this.flex.joint(s.id);
    sim.partFrame = fr ? { q: fr.q.slice(), t: fr.t.slice() } : null;      // where this wood is right now, bend included
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
        const d = segDist(sim.segToWorld(a, a.a), sim.segToWorld(a, a.b), sim.segToWorld(b, b.a), sim.segToWorld(b, b.b)).d;
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
    // a fibre reaches MOR having stretched TENS_STRAIN of its length, and COMP having shortened COMP_STRAIN of it
    const Ft = CFG.MOR * A, Fc = CFG.COMP * A, ey = CFG.TENS_STRAIN * j.Lg, ec = CFG.COMP_STRAIN * j.Lg;
    const kt = Ft / ey, kc = Fc / ec, ks = 0.4 * kt;
    // frames: the bundle face on the parent (O, u, v, nrm) and the same face carried by the distal body
    // the parent's side of the bundle rides on the (possibly bent) segment it grows from
    const ps = sim.world.segs.get(j.parentSeg) || { id: -1, piece: j.parent };
    const Ow = sim.segToWorld(ps, j.O, _O), nw = sim.segDirToWorld(ps, j.n, _n, 1), uw = sim.segDirToWorld(ps, j.u, _u, 1), vw = sim.segDirToWorld(ps, j.v, _v, 1);
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
    // Fibres are bonded to their neighbours (the wood between them). A bonded strip folds as one piece, so a
    // fibre's fold strain grows with its distance from the middle of its strip, not just its own thickness:
    // thick hinges are quicker to tear, thin strips still fold far (D49).
    const nb = neighbours(j.N), bond = j.bond || (j.bond = new Uint8Array(2 * n).fill(1));
    const grp = groupStrips(n, nb, bond, j.st);
    // fold direction across the face: a fibre at s = r . (n x axis) > 0 is on the stretched side of the fold
    let fu = 0, fv = 0;
    if (bend > 1e-9) {
      const bx = thp[0] / bend, by = thp[1] / bend, bz = thp[2] / bend;
      const dx = nv[1] * bz - nv[2] * by, dy = nv[2] * bx - nv[0] * bz, dz = nv[0] * by - nv[1] * bx;
      fu = dx * uw.x + dy * uw.y + dz * uw.z; fv = dx * vw.x + dy * vw.y + dz * vw.z;
    }
    const SF = _SF, GC = _GC, GN = _GN;
    for (let g = 0; g < grp.count; g++) { GC[g] = 0; GN[g] = 0; }
    for (let i = 0; i < n; i++) { SF[i] = (X[i] * fu + Y[i] * fv) * R; const g = grp.of[i]; if (g >= 0) { GC[g] += SF[i]; GN[g]++; } }
    for (let g = 0; g < grp.count; g++) GC[g] /= GN[g];
    const snapped = _snapped; let nSnap = 0;
    for (let i = 0; i < n; i++) {
      const x = X[i] * R, y = Y[i] * R;
      // d = where this fibre's end on the distal body is, relative to its root on the parent
      const dx = dOx + x * (ub.x - uw.x) + y * (vb.x - vw.x), dy = dOy + x * (ub.y - uw.y) + y * (vb.y - vw.y), dz = dOz + x * (ub.z - uw.z) + y * (vb.z - vw.z);
      const del = dx * nv[0] + dy * nv[1] + dz * nv[2];          // elongation along the grain
      SX[i] = dx - del * nv[0]; SY[i] = dy - del * nv[1]; SZ[i] = dz - del * nv[2];   // sideways slip
      RX[i] = dOx + x * ub.x + y * vb.x; RY[i] = dOy + x * ub.y + y * vb.y; RZ[i] = dOz + x * ub.z + y * vb.z;   // lever from O
      DEL[i] = del;
      if (j.st[i] !== ELASTIC) continue;
      const fold = bend * (h / 2 + (grp.of[i] >= 0 ? Math.max(0, SF[i] - GC[grp.of[i]]) : 0));
      if (del - j.p[i] > CFG.FIBRE_STRETCH - fold || del + fold > CFG.FIBRE_STRETCH
        || Math.hypot(SX[i], SY[i], SZ[i]) > CFG.FIBRE_SLIP || bend > CFG.BEND_MAX) { j.st[i] = BROKEN; snapped[nSnap++] = i; }
    }
    // A fibre that snaps unloads into the fibres bonded to it. If a bond cannot carry what that fibre was
    // pulling, it splits and the crack turns along the grain (the neighbour lives on: green wood tears
    // fibrously); if it can, the stress goes into the neighbour and the crack runs across it, as long as that
    // neighbour is itself in tension.
    const cap = CFG.SHEAR * h * CFG.BOND_LEN;
    for (let q = 0; q < nSnap; q++) {
      const i = snapped[q], Fi = Math.max(0, (j.force[i] || 0) * Ft);
      for (let e = 0; e < 4; e++) {
        const k = e === 0 ? nb.px[i] : e === 1 ? nb.py[i] : e === 2 ? nb.mx[i] : nb.my[i];
        if (k < 0) continue;
        const bi = e === 0 ? 2 * i : e === 1 ? 2 * i + 1 : e === 2 ? 2 * k : 2 * k + 1;
        if (!bond[bi]) continue;
        if (j.st[k] !== ELASTIC || Fi > cap) { bond[bi] = 0; continue; }
        if ((j.force[k] || 0) > 0) { j.st[k] = BROKEN; snapped[nSnap++] = k; }
      }
    }
    for (let i = 0; i < n; i++) {
      const del = DEL[i];
      if (j.st[i] === ELASTIC) {
        alive++; kOwn += kt * h * h / 12; mOwn += Ft * h / 4;
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
      KF[i] = j.st[i] === ELASTIC && E[i] > 0 ? kt : kc;      // stiffer or softer depending on which way it is strained
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
    const flips = _flips; flips.fill(0, 0, n);
    for (let iter = 0; iter < 12; iter++) {
      for (let a = 0; a < 36; a++) K[a] = 0;
      const wr = [0, 0, 0, 0, 0, 0];
      for (let i = 0; i < n; i++) {
        const m = mode[i], el = j.st[i] === ELASTIC;
        if (m === OFF && !el) continue;
        const fa = m === LIN ? KF[i] * E[i] : m === CAP ? capF[i] : 0, kl = el ? ks : 0;
        const fx = -fa * nv[0] - kl * SX[i], fy = -fa * nv[1] - kl * SY[i], fz = -fa * nv[2] - kl * SZ[i];
        wr[0] += fx; wr[1] += fy; wr[2] += fz;
        wr[3] += RY[i] * fz - RZ[i] * fy; wr[4] += RZ[i] * fx - RX[i] * fz; wr[5] += RX[i] * fy - RY[i] * fx;
        addStiffness(K, nv, m === LIN ? KF[i] : 0, kl, RX[i], RY[i], RZ[i]);
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
        const f = KF[i] * (E[i] + coef * rate);
        let want = LIN, cf = 0;
        if (el) { if (f > Ft) { want = CAP; cf = Ft; } else if (f < -Fc) { want = CAP; cf = -Fc; } }
        else if (f >= 0) want = OFF; else if (f < -Fc) { want = CAP; cf = -Fc; }
        if (want !== mode[i] || (want === CAP && cf !== capF[i])) {
          // An active set can cycle (a fibre flips between its two caps, or two fibres trade places) and
          // leave an inconsistent impulse that launches a piece. A fibre goes from one cap to the other
          // only through LIN, and one that keeps changing is held in the conservative state: elastic
          // fibres stay linear (a stiff implicit spring only dissipates), broken faces let go.
          if (flips[i] >= 3) continue;
          if (mode[i] === CAP && want === CAP) { want = LIN; cf = 0; }
          if (++flips[i] >= 3) { want = el ? LIN : OFF; cf = 0; }
          mode[i] = want; capF[i] = cf; changed = true;
        }
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
      const f = mode[i] === LIN ? KF[i] * (E[i] + coef * RATE[i]) : mode[i] === CAP ? capF[i] : 0;
      j.force[i] = j.st[i] === BROKEN ? NaN : f / Ft;
      if (j.st[i] === ELASTIC && mode[i] === CAP) j.p[i] = DEL[i] + dt * RATE[i] - capF[i] / (capF[i] > 0 ? kt : kc);
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

  /** For the clients' fibre colours and bending: stiff bundles' strain planes (x 1e7), live ones fibre by fibre. */
  aux() {
    const w = this.sim.world, fs = [], live = [];
    for (const piece of w.pieces.values()) {
      if (!piece.fixed) continue;
      for (const s of w.segsOf(piece.id)) fs.push(s.id, Math.round(s.f.e0 * 1e7), Math.round(s.f.e1 * 1e7), Math.round(s.f.e2 * 1e7));
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

const REF = new Map();             // N -> scratch bundle for ripCheck
const _K = new Float64Array(36), _W = new Float64Array(36), _D = new Float64Array(36), _A = new Float64Array(36);
const _J = new Float64Array(18), _M = new Float64Array(18);
const NF = 520;   // >= the most fibres in a bundle
const _T = new Float64Array(NF), _Tr = new Float64Array(NF);
const KF = new Float64Array(NF);
const _E = new Float64Array(NF), DEL = new Float64Array(NF), RATE = new Float64Array(NF), _RX = new Float64Array(NF), _RY = new Float64Array(NF), _RZ = new Float64Array(NF);
const _SF = new Float64Array(NF), _GC = new Float64Array(NF), _GN = new Float64Array(NF), _snapped = new Int32Array(NF), _UF = new Int32Array(NF), _GID = new Int32Array(NF), _ROOT = new Int32Array(NF);
const _SX = new Float64Array(NF), _SY = new Float64Array(NF), _SZ = new Float64Array(NF), _mode = new Uint8Array(NF), _capF = new Float64Array(NF), _flips = new Uint8Array(NF);
_J[0] = 1; _J[7] = 1; _J[14] = 1;
const _qa = new THREE.Quaternion(), _qb = new THREE.Quaternion();
const _O = new THREE.Vector3(), _n = new THREE.Vector3(), _u = new THREE.Vector3(), _v = new THREE.Vector3();
const _Ob = new THREE.Vector3(), _ub = new THREE.Vector3(), _vb = new THREE.Vector3();

/** Grid neighbours of each fibre in an N-across bundle: +x, +y, -x, -y (index or -1). */
const NBRS = new Map();
function neighbours(N) {
  let r = NBRS.get(N);
  if (r) return r;
  const L = layout(N), n = L.n, at = new Map(), key = (x, y) => Math.round((x + 1) * N / 2 - 0.5) + ',' + Math.round((y + 1) * N / 2 - 0.5);
  for (let i = 0; i < n; i++) at.set(key(L.X[i], L.Y[i]), i);
  r = { px: new Int32Array(n), py: new Int32Array(n), mx: new Int32Array(n), my: new Int32Array(n) };
  for (let i = 0; i < n; i++) {
    const gx = Math.round((L.X[i] + 1) * N / 2 - 0.5), gy = Math.round((L.Y[i] + 1) * N / 2 - 0.5), g = (a, b) => at.get(a + ',' + b) ?? -1;
    r.px[i] = g(gx + 1, gy); r.py[i] = g(gx, gy + 1); r.mx[i] = g(gx - 1, gy); r.my[i] = g(gx, gy - 1);
  }
  NBRS.set(N, r);
  return r;
}

/** Strips of intact fibres still bonded together: of[i] = strip index (-1 for a broken or cut fibre). */
function groupStrips(n, nb, bond, st) {
  const uf = _UF, of = _GID;
  const find = (a) => { while (uf[a] !== a) { uf[a] = uf[uf[a]]; a = uf[a]; } return a; };
  for (let i = 0; i < n; i++) uf[i] = i;
  for (let i = 0; i < n; i++) {
    if (st[i] !== 0) continue;
    const a = nb.px[i], b = nb.py[i];
    if (a >= 0 && bond[2 * i] && st[a] === 0) uf[find(a)] = find(i);
    if (b >= 0 && bond[2 * i + 1] && st[b] === 0) uf[find(b)] = find(i);
  }
  let count = 0;
  const root = _ROOT;
  for (let i = 0; i < n; i++) { of[i] = -1; root[i] = -1; }
  for (let i = 0; i < n; i++) {
    if (st[i] !== 0) continue;
    const r = find(i);
    if (root[r] < 0) root[r] = count++;
    of[i] = root[r];
  }
  return { of, count };
}

