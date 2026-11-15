// The shared world model. Plain data, identical on host and clients.
// It changes ONLY through apply(event). See docs/DESIGN.md 1.1 and 2.3.
//
// seg:   {id, parent, piece, a:[3], b:[3], r0, r1, leaf}   (a, b piece-local)
// piece: {id, fixed}
// rope:  {state: 0 none | 1 block set | 2 tied, block, anchor, device}  nodes = {seg, p:[3] piece-local}

import { makeSection, applyKerf, packSection, unpackSection, intactCount, TORN, INTACT } from './section.js';
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

export class World {
  constructor() {
    this.segs = new Map();
    this.pieces = new Map();
    this.sections = new Map();
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
  /** A child that still counts as a branch (blocks a lanyard). */
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
        for (const s of ev.segs) this.segs.set(s.id, { ...s, piece: ev.piece });
        this.pieces.set(ev.piece, { id: ev.piece, fixed: true });
        this._dirty();
        break;
      case 'section': {
        const s = this.segs.get(ev.seg); if (!s) break;
        this.sections.set(ev.id, makeSection(ev.id, ev.seg, ev.at, segRadius(s, ev.at)));
        break;
      }
      case 'kerf': {
        const sec = this.sections.get(ev.sec); if (!sec) break;
        sec.kerfs[ev.k] = { phi: ev.phi, tilt: ev.tilt, z0: ev.z0, depth: ev.depth };
        applyKerf(sec, ev.k);
        break;
      }
      case 'tear': {
        const sec = this.sections.get(ev.sec); if (!sec) break;
        if (ev.all) { for (let c = 0; c < sec.state.length; c++) if (sec.state[c] === INTACT) sec.state[c] = TORN; }
        else for (const c of ev.cells) sec.state[c] = TORN;
        sec.intact = intactCount(sec);
        break;
      }
      case 'split': this._split(ev, info); break;
      case 'rmpiece': {
        for (const s of [...this.segs.values()]) if (s.piece === ev.piece) {
          this.segs.delete(s.id);
          for (const sec of [...this.sections.values()]) if (sec.seg === s.id) this.sections.delete(sec.id);
        }
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

  // Split segment ev.seg at fraction ev.at and move the distal subtree to a
  // new piece. at <= 0 means "detach the whole segment at its base joint".
  // New piece starts at the parent piece's transform, so local coords persist.
  _split(ev, info) {
    const s = this.segs.get(ev.seg); if (!s) return;
    const oldPiece = s.piece;
    let root;
    if (ev.at > 0) {
      const p = lerp3(s.a, s.b, ev.at), r = segRadius(s, ev.at);
      root = { id: ev.newSeg, parent: -1, piece: oldPiece, a: p, b: s.b, r0: r, r1: s.r1, leaf: s.leaf };
      for (const k of this.kids(s.id)) this.segs.get(k).parent = root.id;
      this.segs.set(root.id, root);
      s.b = p; s.r1 = r; s.leaf = 0;
      for (const sec of this.sections.values()) {
        if (sec.seg !== s.id) continue;
        if (sec.id === ev.sec || sec.at <= ev.at) sec.at = Math.min(1, sec.at / ev.at);
        else { sec.seg = root.id; sec.at = (sec.at - ev.at) / (1 - ev.at); }
      }
      for (const n of ['block', 'anchor', 'device']) {
        const node = this.rope[n];
        if (node && node.seg === s.id && segParamRaw(s.a, root.b, node.p) > ev.at) node.seg = root.id;
      }
    } else {
      root = s; root.parent = -1;
    }
    this._dirty();
    const moved = this.subtree(root.id);
    for (const id of moved) this.segs.get(id).piece = ev.newPiece;
    this.pieces.set(ev.newPiece, { id: ev.newPiece, fixed: false });
    const sec = this.sections.get(ev.sec); if (sec) sec.sep = ev.newPiece;
    this._dirty();
    info.oldPiece = oldPiece; info.moved = moved; info.root = root.id; info.cutSeg = s.id;
  }

  // ---- welcome ----
  serialize() {
    return {
      segs: [...this.segs.values()], pieces: [...this.pieces.values()],
      sections: [...this.sections.values()].map(packSection),
      rope: this.rope, players: [...this.players.values()],
    };
  }
  load(o) {
    this.segs.clear(); this.pieces.clear(); this.sections.clear(); this.players.clear();
    for (const s of o.segs) this.segs.set(s.id, s);
    for (const p of o.pieces) this.pieces.set(p.id, p);
    for (const s of o.sections) this.sections.set(s.id, unpackSection(s));
    for (const p of o.players) this.players.set(p.id, p);
    this.rope = o.rope;
    this._dirty();
    for (const fn of this.listeners) fn({ t: 'load' }, {});
  }
}

const EMPTY = [];
function segParamRaw(a, b, p) {
  const d = sub(b, a), q = sub(p, a);
  return (q[0] * d[0] + q[1] * d[1] + q[2] * d[2]) / (d[0] * d[0] + d[1] * d[1] + d[2] * d[2] || 1);
}
