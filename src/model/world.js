// The shared world model. Plain data, identical on host and clients.
// It changes ONLY through apply(event). See docs/DESIGN.md 1.1 and 2.3.
//
// seg:   {id, parent, piece, a:[3], b:[3], r0, r1, leaf, f}   (a, b piece-local; f = fibre bundle)
// piece: {id, fixed}
// rope:  {state: 0 none | 1 block set | 2 tied, block, anchor, device}  nodes = {seg, p:[3] piece-local}

import { makeBundle, cutFibres, packBundle, unpackBundle, gridFor, CUT } from './fibres.js';
import { CFG } from '../config.js';

export const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const lerp3 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
export const len3 = (a) => Math.hypot(a[0], a[1], a[2]);

export function segLen(s) { return len3(sub(s.b, s.a)); }
export function segAxis(s) { const d = sub(s.b, s.a), l = len3(d) || 1; return [d[0] / l, d[1] / l, d[2] / l]; }
export function segRadius(s, t) { return s.r0 + (s.r1 - s.r0) * t; }
/** Wood mass of the part of a segment between fractions t0..t1 (no leaves). */
export function segMass(s, t0 = 0, t1 = 1) {
  const ra = segRadius(s, t0), rb = segRadius(s, t1), L = segLen(s) * (t1 - t0);
  return CFG.DENSITY * Math.PI * L / 3 * (ra * ra + ra * rb + rb * rb);
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
      case 'rmpiece': {
        for (const s of [...this.segs.values()]) if (s.piece === ev.piece) this.segs.delete(s.id);
        this.pieces.delete(ev.piece);
        this._dirty();
        for (const n of ['block', 'anchor', 'device']) {
          const node = this.rope[n];
          if (node && !this.segs.has(node.seg)) { this.rope = { state: 0 }; info.ropeLost = true; break; }
        }
        break;
      }
      case 'rope': this.rope = ev.rope; break;
      case 'player':
        if (ev.leave) this.players.delete(ev.id); else this.players.set(ev.id, { id: ev.id, name: ev.name });
        break;
      case 'toast': break;
    }
    for (const fn of this.listeners) fn(ev, info);
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
        for (let i = 0; i < n; i++) if (f.state[i] === CUT) { f.lo[i] = f.zmax[i]; f.state[i] = 0; }
        f.ncut = 0; f.at = 0;
      }
    }
    this._dirty();
    const moved = this.subtree(root.id);
    for (const id of moved) this.segs.get(id).piece = ev.newPiece;
    this.pieces.set(ev.newPiece, { id: ev.newPiece, fixed: false });
    this._dirty();
    info.oldPiece = oldPiece; info.moved = moved; info.root = root.id; info.cutSeg = s.id;
  }

  // ---- welcome ----
  serialize() {
    return {
      segs: [...this.segs.values()].map((s) => ({ ...s, f: packBundle(s.f) })), pieces: [...this.pieces.values()],
      rope: this.rope, players: [...this.players.values()],
    };
  }
  load(o) {
    this.segs.clear(); this.pieces.clear(); this.players.clear();
    for (const s of o.segs) this.segs.set(s.id, { ...s, f: unpackBundle(s.f) });
    for (const p of o.pieces) this.pieces.set(p.id, p);
    for (const p of o.players) this.players.set(p.id, p);
    this.rope = o.rope;
    this._dirty();
    for (const fn of this.listeners) fn({ t: 'load' }, {});
  }
}

const EMPTY = [];
