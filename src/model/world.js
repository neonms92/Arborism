// The shared world model. Plain data, identical on host and clients.
// It changes ONLY through apply(event). See docs/DESIGN.md 1.1 and 2.3.
//
// seg:   {id, parent, piece, a:[3], b:[3], r0, r1, leaf, f}   (a, b piece-local; f = fibre bundle)
// piece: {id, fixed}
// rope:  {state: 0 none | 1 block set | 2 tied, block, anchor, device}  nodes = {seg, p:[3] piece-local}
//        or, for an anchor the chipper has taken in, {chip: 1} (the rope runs into its infeed until it comes free)
// chipper: model/chipper.js
// builds: breakable structures (the shed), model/builds.js
// terrain: the ground, model/terrain.js (null = flat at y = 0)

import { makeBundle, cutFibres, packBundle, unpackBundle, gridFor, layout, bundleBasis, CUT, isGone, setGone, presence } from './fibres.js';
import { CFG } from '../config.js';
import { newPaving, crackPaver, packPaving, unpackPaving } from './pavers.js';
import { addChips } from './chipper.js';
import { makeTerrain } from './terrain.js';
import { newBuild, smashBuild } from './builds.js';

export const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const lerp3 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
export const len3 = (a) => Math.hypot(a[0], a[1], a[2]);

export function segLen(s) { return len3(sub(s.b, s.a)); }
export function segAxis(s) { const d = sub(s.b, s.a), l = len3(d) || 1; return [d[0] / l, d[1] / l, d[2] / l]; }
export function segRadius(s, t) { return s.r0 + (s.r1 - s.r0) * t; }
/** Wood mass of the part of a segment between fractions t0..t1 (no leaves). */
export function segMass(s, t0 = 0, t1 = 1) {
  const ra = segRadius(s, t0), rb = segRadius(s, t1), L = segLen(s) * (t1 - t0);
  return CFG.DENSITY * Math.PI * L / 3 * (ra * ra + ra * rb + rb * rb) * (s.f && s.f.ncut ? presence(s.f) : 1);   // a lengthwise half weighs its share
}
/** Fraction along t0..t1 of the centroid of that frustum. */
export function segCentroidT(s, t0 = 0, t1 = 1) {
  const ra = segRadius(s, t0), rb = segRadius(s, t1);
  const f = (ra * ra + 2 * ra * rb + 3 * rb * rb) / (4 * (ra * ra + ra * rb + rb * rb));
  return t0 + (t1 - t0) * f;
}
/** Fraction along segment s of the point closest to piece-local point p. */
export function segParam(s, p) {
  const d = sub(s.b, s.a), q = sub(p, s.a), l2 = d[0] * d[0] + d[1] * d[1] + d[2] * d[2] || 1;
  return (q[0] * d[0] + q[1] * d[1] + q[2] * d[2]) / l2;
}
/** Unit vector perpendicular to unit axis ax, as close as possible to v. */
export function perp(v, ax) {
  const d = v[0] * ax[0] + v[1] * ax[1] + v[2] * ax[2];
  let o = [v[0] - ax[0] * d, v[1] - ax[1] * d, v[2] - ax[2] * d], l = Math.hypot(o[0], o[1], o[2]);
  if (l < 1e-4) { o = Math.abs(ax[1]) < 0.9 ? [ax[2], 0, -ax[0]] : [1, 0, 0]; l = Math.hypot(o[0], o[1], o[2]); }
  return [o[0] / l, o[1] / l, o[2] / l];
}
/**
 * A climber's lanyard as a closed loop of piece-local points: round the stem
 * at fraction t and out to the climber on `side`. Used to draw it and to let
 * a saw cut it.
 */
export function lanyardLoop(s, t, side, standoff) {
  const ax = segAxis(s), c = lerp3(s.a, s.b, t), r = segRadius(s, t) + 0.025;
  const w = [ax[1] * side[2] - ax[2] * side[1], ax[2] * side[0] - ax[0] * side[2], ax[0] * side[1] - ax[1] * side[0]];
  const pts = [];
  const hip = (sg) => [c[0] + side[0] * (r + standoff - 0.25) + w[0] * 0.18 * sg, c[1] + side[1] * (r + standoff - 0.25) + w[1] * 0.18 * sg, c[2] + side[2] * (r + standoff - 0.25) + w[2] * 0.18 * sg];
  pts.push(hip(1));
  for (let i = 0; i <= 8; i++) {                       // three quarters of the way round the far side
    const a = Math.PI * 0.4 + i / 8 * Math.PI * 1.2, cs = Math.cos(a) * r, sn = Math.sin(a) * r;
    pts.push([c[0] + side[0] * cs + w[0] * sn, c[1] + side[1] * cs + w[1] * sn, c[2] + side[2] * cs + w[2] * sn]);
  }
  pts.push(hip(-1));
  return pts;
}

export class World {
  constructor() {
    this.segs = new Map();
    this.pieces = new Map();
    this.rope = { state: 0 };
    this.players = new Map();     // id -> {id, name}
    this.paving = null;           // concrete pavers round the tree (model/pavers.js)
    this.chipper = null;          // the wood chipper and its chip piles (model/chipper.js)
    this.builds = [];             // breakable structures: the shed (model/builds.js)
    this.terrain = null;          // the ground (model/terrain.js); null = flat at y = 0
    this.nextId = 1;              // host allocates all ids
    this.listeners = [];
    this._kids = null; this._order = null;
  }

  on(fn) { this.listeners.push(fn); }
  newId() { return this.nextId++; }

  // ---- queries ----
  kids(id) {
    if (!this._kids) {
      this._kids = new Map();
      for (const s of this.segs.values()) {
        if (s.parent < 0) continue;
        let k = this._kids.get(s.parent); if (!k) this._kids.set(s.parent, k = []);
        k.push(s.id);
      }
    }
    return this._kids.get(id) || EMPTY;
  }
  /** Segments of a piece, parents before children. */
  segsOf(pieceId) {
    if (!this._order) this._order = new Map();
    let o = this._order.get(pieceId);
    if (!o) {
      o = [];
      for (const s of this.segs.values()) if (s.piece === pieceId && s.parent < 0) o.push(s);
      for (let i = 0; i < o.length; i++) for (const k of this.kids(o[i].id)) o.push(this.segs.get(k));
      this._order.set(pieceId, o);
    }
    return o;
  }
  subtree(rootId) {
    const out = [rootId];
    for (let i = 0; i < out.length; i++) for (const k of this.kids(out[i])) out.push(k);
    return out;
  }
  /** A child that still counts as a branch (stops a lanyard). */
  isRealBranch(id) {
    const s = this.segs.get(id);
    return this.kids(id).length > 0 || segLen(s) >= CFG.STUB_LEN;
  }
  _dirty() { this._kids = null; this._order = null; }

  // ---- the only mutation path ----
  apply(ev) {
    const info = {};
    switch (ev.t) {
      case 'tree':
        for (const s of ev.segs) this.segs.set(s.id, { ...s, piece: ev.piece, f: makeBundle(s.N || gridFor(s.r0)) });
        this.pieces.set(ev.piece, { id: ev.piece, fixed: true });
        this._dirty();
        break;
      case 'reset':                 // all wood gone (a new tree follows)
        this.segs.clear(); this.pieces.clear(); this.rope = { state: 0 };
        this._dirty();
        break;
      case 'cut': {                 // the saw severed fibres i[] at z[] (m from the segment base)
        const s = this.segs.get(ev.seg); if (!s) break;
        if (ev.at !== undefined) s.f.at = ev.at;
        cutFibres(s.f, ev.i, ev.z);
        break;
      }
      case 'divide': {              // one segment becomes two (same piece), so each cut plane has its own bundle
        const s = this.segs.get(ev.seg); if (!s) break;
        const root = this._divide(s, ev.at, ev.newSeg, false);
        root.parent = s.id; this._dirty();
        info.newSeg = root.id;
        break;
      }
      case 'split': this._split(ev, info); break;
      case 'rip': this._rip(ev, info); break;
      case 'rmpiece': {
        for (const s of [...this.segs.values()]) if (s.piece === ev.piece) this.segs.delete(s.id);
        this.pieces.delete(ev.piece);
        this._dirty();
        this._ropeCheck(info);
        break;
      }
      case 'chipper':               // parked fresh, whole (keep: a respawn, which leaves the chip piles where they are)
        this.chipper = { p: ev.p, q: ev.q, piles: ev.keep && this.chipper ? this.chipper.piles : [], wreck: null };
        break;
      case 'chipwreck': if (this.chipper) this.chipper.wreck = { at: ev.at, ids: ev.ids }; break;   // it crumpled
      case 'chips':                 // a player took V m3 off pile i (take: [i, V]), or put V m3 down at (x, z) (drop: [x, z, V])
        if (!this.chipper) break;
        if (ev.take) { const pl = this.chipper.piles[ev.take[0]]; if (pl) pl[2] = Math.max(0, +(pl[2] - ev.take[1]).toFixed(5)); }
        if (ev.drop) addChips(this.chipper, ev.drop[0], ev.drop[1], ev.drop[2]);
        break;
      case 'chip': {                // the chipper took in segments segs[] and blew V m3 of chips out at (x, z)
        const gone = new Set(ev.segs), touched = new Set();
        for (const id of ev.segs) { const s = this.segs.get(id); if (s) { touched.add(s.piece); this.segs.delete(id); } }
        for (const s of this.segs.values()) if (gone.has(s.parent)) s.parent = -1;     // what was held on by them is loose in the same piece
        this._dirty();
        info.gone = []; info.touched = [...touched];
        for (const pc of touched) if (!this.segsOf(pc).length) { this.pieces.delete(pc); info.gone.push(pc); }
        this._dirty();
        if (this.chipper && ev.V > 0) addChips(this.chipper, ev.x, ev.z, ev.V);
        this._ropeCheck(info);
        break;
      }
      case 'builds': this.builds = ev.list.map(newBuild); break;   // put up fresh (all intact)
      case 'smash': smashBuild(this.builds, ev); break;           // a module came apart (sim/builds.js)
      case 'rope': this.rope = ev.rope; break;
      case 'terrain': this.terrain = makeTerrain(ev.spec); break;   // the ground, made from its spec on every machine
      case 'pavers': this.paving = newPaving(ev.c, ev.r, ev.pit); break;   // laid fresh (no damage)
      case 'crack':                 // impacts on pavers this tick: h = [[paver, x, z, damage added], ...]
        if (this.paving) for (const [i, x, z, add] of ev.h) crackPaver(this.paving, i, x, z, add);
        break;
      case 'player':
        if (ev.leave) this.players.delete(ev.id); else this.players.set(ev.id, { id: ev.id, name: ev.name });
        break;
      case 'toast': break;
    }
    for (const fn of this.listeners) fn(ev, info);
  }

  /** A rope node whose wood is gone loses the rope. */
  _ropeCheck(info) {
    for (const n of ['block', 'anchor', 'device']) {
      const node = this.rope[n];
      if (node && node.seg !== undefined && !this.segs.has(node.seg)) { this.rope = { state: 0 }; info.ropeLost = true; break; }
    }
  }

  // Cut segment s in two at fraction `at`. Returns the new distal segment
  // (parent not yet set). parting = true: the wood parts at this plane (every
  // fibre ends here, trimmed to where it was sawn). parting = false: a
  // bookkeeping division; each severed fibre stays severed on its own side.
  _divide(s, at, newId, parting) {
    const L = segLen(s), zc = at * L, p = lerp3(s.a, s.b, at), r = segRadius(s, at), old = s.f, n = old.n;
    const root = { id: newId, parent: -1, piece: s.piece, a: p, b: s.b, r0: r, r1: s.r1, leaf: s.leaf, f: makeBundle(old.N) };
    for (const k of this.kids(s.id)) this.segs.get(k).parent = root.id;
    this.segs.set(root.id, root);
    const P = makeBundle(old.N), D = root.f;
    P.lo = new Float32Array(n); P.hi = new Float32Array(n); D.lo = new Float32Array(n); D.hi = new Float32Array(n);
    let zp = 0, np = 0, zd = 0, nd = 0;
    for (let i = 0; i < n; i++) {
      P.lo[i] = old.lo ? old.lo[i] : 0; P.hi[i] = zc;
      D.lo[i] = 0; D.hi[i] = (old.hi ? old.hi[i] : L) - zc;
      if (old.state[i] !== CUT) continue;
      if (isGone(old, i)) { setGone(P, i); setGone(D, i); continue; }      // not in this wood on either side
      const mid = (old.zmin[i] + old.zmax[i]) / 2;
      if (parting) { P.hi[i] = old.zmin[i]; D.lo[i] = old.zmax[i] - zc; }
      else if (mid < zc) { P.state[i] = CUT; P.zmin[i] = old.zmin[i]; P.zmax[i] = old.zmax[i]; P.ncut++; zp += mid; np++; }
      else { D.state[i] = CUT; D.zmin[i] = old.zmin[i] - zc; D.zmax[i] = old.zmax[i] - zc; D.ncut++; zd += mid - zc; nd++; }
    }
    if (np) P.at = Math.min(0.96, zp / np / zc);
    if (nd) D.at = Math.min(0.96, zd / nd / (L - zc));
    s.f = P;
    for (const nm of ['block', 'anchor', 'device']) {
      const node = this.rope[nm];
      if (node && node.seg === s.id && segParam(s, node.p) > at) node.seg = root.id;
    }
    s.b = p; s.r1 = r; s.leaf = 0;
    this._dirty();
    return root;
  }

  // The wood parts at fraction ev.at of segment ev.seg: the distal subtree
  // becomes a new piece. at <= 0 means "at the base joint of this segment".
  // The new piece starts at the parent piece's transform, so local coords persist.
  _split(ev, info) {
    const s = this.segs.get(ev.seg); if (!s) return;
    const oldPiece = s.piece;
    let root;
    if (ev.at > 0) root = this._divide(s, ev.at, ev.newSeg, true);
    else {
      root = s; root.parent = -1;
      const f = s.f, n = f.n, L = segLen(s);            // sawn fibres start where the saw left them
      if (f.ncut) {
        if (!f.lo) { f.lo = new Float32Array(n); f.hi = new Float32Array(n).fill(L); }
        let gone = 0;
        for (let i = 0; i < n; i++) if (f.state[i] === CUT) { if (isGone(f, i)) { gone++; continue; } f.lo[i] = f.zmax[i]; f.state[i] = 0; }
        f.ncut = gone; f.at = 0;
      }
    }
    this._dirty();
    const moved = this.subtree(root.id);
    for (const id of moved) this.segs.get(id).piece = ev.newPiece;
    this.pieces.set(ev.newPiece, { id: ev.newPiece, fixed: false });
    this._dirty();
    info.oldPiece = oldPiece; info.moved = moved; info.root = root.id; info.cutSeg = s.id;
  }

  // The wood of segment ev.seg splits lengthwise (DECISIONS D50). Fibres ev.h[] leave it and become a new
  // segment ev.newSeg over the same length, hanging from the top end (it is still joined to the wood above,
  // not below): its base is the old top, it runs back down, and its parent is ev.cont (the segment the stem
  // carries on into; this one if there is none). The stem carries on into ev.cont through the fibres that
  // stayed, so ev.cont's own fibres over the split-off part no longer reach down: they end at its base.
  _rip(ev, info) {
    const s = this.segs.get(ev.seg); if (!s) return;
    const f = s.f, N = f.N, L = segLen(s), lay = layout(N);
    const ax = segAxis(s), b0 = bundleBasis(ax), bh = bundleBasis([-ax[0], -ax[1], -ax[2]]);
    const cont = ev.cont >= 0 ? this.segs.get(ev.cont) : null;
    const h = { id: ev.newSeg, parent: cont ? cont.id : s.id, piece: s.piece, a: s.b.slice(), b: s.a.slice(), r0: s.r1, r1: s.r0, leaf: 0, f: makeBundle(N) };
    const H = h.f;
    for (let i = 0; i < H.n; i++) setGone(H, i);
    const off = (bb, i) => [bb.u[0] * lay.X[i] + bb.v[0] * lay.Y[i], bb.u[1] * lay.X[i] + bb.v[1] * lay.Y[i], bb.u[2] * lay.X[i] + bb.v[2] * lay.Y[i]];
    const nearest = (l, bb, o) => {
      const x = o[0] * bb.u[0] + o[1] * bb.u[1] + o[2] * bb.u[2], y = o[0] * bb.v[0] + o[1] * bb.v[1] + o[2] * bb.v[2];
      let best = 0, bd = Infinity;
      for (let k = 0; k < l.n; k++) { const d = (l.X[k] - x) ** 2 + (l.Y[k] - y) ** 2; if (d < bd) { bd = d; best = k; } }
      return best;
    };
    H.lo = new Float32Array(H.n); H.hi = new Float32Array(H.n);
    for (const i of ev.h) {
      if (isGone(f, i)) continue;
      const k = nearest(lay, bh, off(b0, i));
      // the new segment runs the other way (z' = L - z). A fibre the saw severed near the bottom of this wood
      // is severed near the free end of the hanging half: it still holds at the top, and stops at the kerf.
      H.state[k] = 0; H.ncut--;
      H.lo[k] = L - (f.hi ? f.hi[i] : L); H.hi[k] = L - (f.state[i] === CUT ? f.zmax[i] : f.lo ? f.lo[i] : 0);
      setGone(f, i);
    }
    H.at = 0; f.load = null;          // host scratch: what it was last solved for no longer applies
    if (cont) {
      cont.f.load = null;
      let real = 0;
      for (let i = 0; i < cont.f.n; i++) if (cont.f.state[i] === CUT && !isGone(cont.f, i)) real++;
      if (!real) cont.f.at = 0;
      const cl = layout(cont.f.N), cb = bundleBasis(segAxis(cont)), rr = (cont.r0 || 1) / (s.r1 || 1);
      for (const i of ev.h) {
        const o = off(b0, i).map((v) => v / rr), k = nearest(cl, cb, o);
        if (cont.f.state[k] === CUT) continue;
        cont.f.state[k] = CUT; cont.f.zmin[k] = 0; cont.f.zmax[k] = 0; cont.f.ncut++;
      }
    }
    // a half that hung from the bottom of this wood was joined to the wood that has just split away: it now
    // hangs from the end of the new half (the split is running up the stem through both)
    for (const k of this.kids(s.id)) {
      const c = this.segs.get(k);
      if (Math.abs(c.a[0] - s.a[0]) + Math.abs(c.a[1] - s.a[1]) + Math.abs(c.a[2] - s.a[2]) < 1e-4) c.parent = h.id;
    }
    this.segs.set(h.id, h);
    this._dirty();
    info.seg = s.id; info.newSeg = h.id; info.cont = cont ? cont.id : -1;
  }

  // ---- welcome ----
  serialize() {
    return {
      segs: [...this.segs.values()].map((s) => ({ ...s, f: packBundle(s.f) })), pieces: [...this.pieces.values()],
      rope: this.rope, players: [...this.players.values()], paving: packPaving(this.paving), chipper: this.chipper, builds: this.builds,
      terrain: this.terrain ? this.terrain.spec : null,
    };
  }
  load(o) {
    this.segs.clear(); this.pieces.clear(); this.players.clear();
    for (const s of o.segs) this.segs.set(s.id, { ...s, f: unpackBundle(s.f) });
    for (const p of o.pieces) this.pieces.set(p.id, p);
    for (const p of o.players) this.players.set(p.id, p);
    this.rope = o.rope;
    this.paving = unpackPaving(o.paving);
    this.chipper = o.chipper || null;
    this.builds = o.builds || [];
    this.terrain = makeTerrain(o.terrain || null);
    this._dirty();
    for (const fn of this.listeners) fn({ t: 'load' }, {});
  }
}

const EMPTY = [];
