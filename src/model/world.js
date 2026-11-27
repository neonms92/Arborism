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
// stands: the other trees in the yards, model/stands.js (null = none)
// lines: the power lines, model/lines.js (null = none)
// mark: the orange X sprayed on the job tree {c:[3] on its axis, n:[3] out to the paint}, piece-local (null = none)

import { makeBundle, cutFibres, packBundle, unpackBundle, gridFor, layout, bundleBasis, CUT, isGone, setGone, presence } from './fibres.js';
import { CFG } from '../config.js';
import { newPaving, crackPaver, packPaving, unpackPaving } from './pavers.js';
import { addChips } from './chipper.js';
import { makeTerrain } from './terrain.js';
import { newBuild, smashBuild, freezeBuild, packBuilds, unpackBuilds } from './builds.js';
import { cleanStickers } from './stickers.js';
import { newLines, snapLine, deadLine, wakeEnds, divideEnds } from './lines.js';

export const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const lerp3 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
export const len3 = (a) => Math.hypot(a[0], a[1], a[2]);

export function segLen(s) { return len3(sub(s.b, s.a)); }
/** A player's chosen name, made safe for toasts and name tags: no control characters, no markup or
 *  {tokens} (hud.js expands those), at most PLAYER_NAME_MAX characters. '' if nothing is left. */
export function cleanName(n) {
  return typeof n === 'string' ? n.replace(/[\u0000-\u001f\u007f<>{}]/g, '').replace(/\s+/g, ' ').trim().slice(0, CFG.PLAYER_NAME_MAX) : '';
}
/** A shirt colour as 0xRRGGBB, or -1 when it is not one. */
export function cleanColor(c) { return Number.isInteger(c) && c >= 0 && c <= 0xffffff ? c : -1; }
/** What toasts call a player: their name, or "Player 2" when they gave none. */
export function playerName(world, id) { const p = world.players.get(id); return (p && p.name) || `Player ${id}`; }

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
    this.chipper = null;          // the wood chippers and their chip piles: {piles, units: [{p, q, wreck}]} (model/chipper.js)
    this.bins = [];               // the chip bins: [{p, q} where each was put down] (model/bin.js)
    this.prog = newProg();        // how far the job has got: the job tree chipped, and its chips gone into bins
    this.builds = [];             // breakable structures: the shed (model/builds.js)
    this.terrain = null;          // the ground (model/terrain.js); null = flat at y = 0
    this.stands = null;           // the other trees in the yards (model/stands.js)
    this.lines = null;            // the power lines along the streets and to the houses (model/lines.js)
    this.mark = null;             // the orange X on the job tree
    this.damage = 0;              // $, running cost of what the job broke (sim/damage.js)
    this.job = null;              // the job's budget and how it was worked out: {budget, h, d, lot} (sim/damage.js)
    this.wages = 0;               // $ paid out in wages so far; cash = job.budget - damage - wages - spent
    this.spent = 0;               // $ spent on purchases (another chipper) this job
    this.awards = newAwards();    // stickers handed out this job (sim/awards.js, model/stickers.js)
    this.seed = '';               // the world's seed word, '' when none (model/seed.js; set by the 'terrain' event)
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
  /**
   * The child of segment id that carries on the same stem: the one whose axis turns least from id's, if it turns
   * no more than STEM_BEND. null where the stem ends (only branches, or nothing, go on from there).
   */
  stemNext(id) {
    const s = this.segs.get(id); if (!s) return null;
    const ax = segAxis(s), minCos = Math.cos(CFG.STEM_BEND);
    let best = null, bc = -Infinity;
    for (const k of this.kids(id)) {
      const kx = segAxis(this.segs.get(k)), c = kx[0] * ax[0] + kx[1] * ax[1] + kx[2] * ax[2];
      if (c >= minCos && c > bc) { bc = c; best = k; }
    }
    return best;
  }
  /**
   * How far the branch that starts with child segment id juts out past the bark of its parent stem, at right
   * angles to that stem: the farthest any of the branch's wood gets from the parent's axis line, less the parent's
   * radius there. A branch leaving at angle θ reaches L sin θ from the axis per metre L of its length, so a long
   * branch lying close along the stem juts out little. Stops counting once past `stop`.
   */
  jut(id, stop = Infinity) {
    const k = this.segs.get(id), s = k && this.segs.get(k.parent); if (!s) return 0;
    const ax = segAxis(s), o = s.b;
    const off = (q, r) => {
      const d = sub(q, o), along = d[0] * ax[0] + d[1] * ax[1] + d[2] * ax[2];
      return Math.sqrt(Math.max(0, d[0] * d[0] + d[1] * d[1] + d[2] * d[2] - along * along)) + r;
    };
    let far = 0;
    for (const sid of this.subtree(id)) {
      const g = this.segs.get(sid);
      far = Math.max(far, off(g.a, g.r0), off(g.b, g.r1));
      if (far - s.r1 >= stop) break;
    }
    return Math.max(0, far - s.r1);
  }
  /** A child that still counts as a branch (stops a lanyard): it juts out at least STUB_LEN past the bark. */
  isRealBranch(id) { return this.jut(id, CFG.STUB_LEN) >= CFG.STUB_LEN; }
  _dirty() { this._kids = null; this._order = null; }

  // ---- the only mutation path ----
  apply(ev) {
    const info = {};
    switch (ev.t) {
      case 'tree':
        for (const s of ev.segs) this.segs.set(s.id, { ...s, piece: ev.piece, f: makeBundle(s.N || gridFor(s.r0)) });
        this.pieces.set(ev.piece, { id: ev.piece, fixed: true });
        if (ev.stand !== undefined) for (const s of ev.segs) this.segs.get(s.id).yd = 1;   // a yard tree's wood: not the job's
        else for (const s of ev.segs) { const g = this.segs.get(s.id); this.prog.M += segMass(g) + g.leaf; }
        if (ev.mark) this.mark = ev.mark;
        if (ev.stand !== undefined && this.stands) this.stands.list[ev.stand].piece = ev.piece;    // one of the other trees came to life
        if (ev.stand !== undefined && this.stands && this.stands.list[ev.stand].k === 1) wakeEnds(this.lines, ev.stand, ev.segs);   // a pole: its lines are on its wood now
        this._dirty();
        break;
      case 'stands':                // the other trees in the yards, all dormant
        this.stands = ev.list.length ? { g: ev.g, list: ev.list.map(([x, y, z, seed, h, d, k]) => ({ x, y, z, seed, h, d, piece: 0, ...(k ? { k } : {}) })) } : null;
        break;
      case 'prune':                 // branches of the other trees that grew into something, cut off (model/prune.js)
        if (this.stands) for (const [i, cut] of ev.cut) if (this.stands.list[i]) this.stands.list[i].cut = cut;
        break;
      case 'reset':                 // all wood gone (a new tree follows)
        this.segs.clear(); this.pieces.clear(); this.rope = { state: 0 }; this.damage = 0; this.wages = 0; this.spent = 0; this.job = null; this.stands = null; this.mark = null; this.lines = null;
        this.prog = newProg();
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
      case 'rmpiece': {             // swept away as debris: twigs too light to bother with (not chipped, so not counted)
        for (const s of [...this.segs.values()]) if (s.piece === ev.piece) { if (!s.yd) this.prog.lost += segMass(s) + s.leaf; this.segs.delete(s.id); }
        this.pieces.delete(ev.piece);
        this._dirty();
        this._ropeCheck(info);
        break;
      }
      case 'chipper':               // a chipper parked fresh, whole. With every new tree the only one (and no chip piles);
        // add: one more bought (unit k), the others and the chip piles left as they are
        if (ev.add && this.chipper) this.chipper.units[ev.k] = { p: ev.p, q: ev.q, wreck: null };
        else this.chipper = { piles: [], units: [{ p: ev.p, q: ev.q, wreck: null }] };
        break;
      case 'chipwreck': { const u = this.chipper && this.chipper.units[ev.k || 0]; if (u) u.wreck = { at: ev.at, ids: ev.ids }; break; }   // it crumpled
      case 'buy': this.spent += ev.cost; break;       // something bought for the job (sim/chippers.js: another chipper)
      case 'chips':                 // a player took V m3 off pile i (take: [i, V]), or put V m3 down at (x, z) (drop: [x, z, V])
        if (!this.chipper) break;
        if (ev.take) { const pl = this.chipper.piles[ev.take[0]]; if (pl) pl[2] = Math.max(0, +(pl[2] - ev.take[1]).toFixed(5)); }
        if (ev.drop) addChips(this.chipper, ev.drop[0], ev.drop[1], ev.drop[2]);
        if (ev.dump) this.prog.gone += ev.dump;        // a player tipped the chips they carried into a bin
        break;
      case 'bins': this.bins = ev.list.map(([p, q]) => ({ p, q })); break;   // put down fresh with a new tree
      case 'bin': this.bins.push({ p: ev.p, q: ev.q }); break;              // one more (bought)
      case 'chip': {                // the chipper took in segments segs[] and blew V m3 of chips out at (x, z)
        const gone = new Set(ev.segs), touched = new Set();
        for (const id of ev.segs) {
          const s = this.segs.get(id); if (!s) continue;
          if (!s.yd) this.prog.chipped += segMass(s) + s.leaf;
          touched.add(s.piece); this.segs.delete(id);
        }
        for (const s of this.segs.values()) if (gone.has(s.parent)) s.parent = -1;     // what was held on by them is loose in the same piece
        this._dirty();
        info.gone = []; info.touched = [...touched];
        for (const pc of touched) if (!this.segsOf(pc).length) { this.pieces.delete(pc); info.gone.push(pc); }
        this._dirty();
        // the chips land on a pile, or in the open mouth of bin ev.bin (bottomless: they are gone)
        if (ev.V > 0) this.prog.made += ev.V;
        if (ev.V > 0 && ev.bin !== undefined) this.prog.gone += ev.V;
        else if (this.chipper && ev.V > 0) addChips(this.chipper, ev.x, ev.z, ev.V);
        this._ropeCheck(info);
        break;
      }
      case 'builds': this.builds = ev.list.map(newBuild); break;   // put up fresh (all intact)
      case 'smash': smashBuild(this.builds, ev); break;           // a module came apart (sim/builds.js)
      case 'freeze': freezeBuild(this.builds, ev); break;         // its debris came to rest long enough ago: scenery now
      case 'rope': this.rope = ev.rope; break;
      case 'lines': this.lines = newLines(ev.list, ev.hw, ev.src); break;    // the power lines, put up whole with a new tree
      case 'snap': snapLine(this.lines, ev); break;            // a power line parted (k: link) or came away at an end (end)
      case 'dead': deadLine(this.lines, ev); break;           // a downed line went dead: no more sparks or shocks
      case 'zap': break;                                       // someone touched a live line (drawn as a flash)
      case 'damage': this.damage += ev.cost; break;   // the price of something broken (sim/damage.js)
      case 'budget': this.job = ev.job; this.wages = 0; this.spent = 0; break;   // a new job: what it pays to start with (sim/damage.js)
      case 'wages': this.wages += ev.cost; break;     // the crew's pay since the last of these
      case 'terrain': this.terrain = makeTerrain(ev.spec); this.seed = ev.seed || ''; break;   // the ground, made from its spec on every machine; seed: the world's word (model/seed.js)
      case 'pavers': this.paving = newPaving(ev.c, ev.areas, this.terrain, ev.slope); break;   // laid fresh (no damage): the tree's circle and the yards' paving
      case 'crack':                 // impacts on pavers this tick: h = [[paver, x, z, damage added], ...]
        if (this.paving) for (const [i, x, z, add] of ev.h) crackPaver(this.paving, i, x, z, add);
        break;
      case 'player':
        // joining, or changing name / shirt colour (the same event again): name and color are already cleaned by the host
        if (ev.leave) this.players.delete(ev.id); else this.players.set(ev.id, { id: ev.id, name: ev.name, color: ev.color, st: cleanStickers(ev.st), ...(ev.bot ? { bot: 1 } : {}) });   // bot: G.O.E. (sim/goe.js)
        break;
      case 'job': this.awards = { ...newAwards(), job: ev.id }; break;   // a new job: no stickers handed out yet
      case 'award': {                                                    // players ev.to got sticker k at this tier (main.js hands it out)
        const g = this.awards.got[ev.k] || (this.awards.got[ev.k] = {});
        for (const id of ev.to || []) g[id] = ev.tier;
        break;
      }
      case 'ate': this.awards.ate[ev.id] = (this.awards.ate[ev.id] || 0) + 1; break;   // player id ate a tube salad (theirs or one handed to them)
      case 'work':                                                       // who sawed (m² cut) and fed (kg chipped) since the last of these
        for (const k of ['chop', 'chip', 'bin']) { const W = this.awards.work[k] || (this.awards.work[k] = {}); for (const id in ev[k] || {}) W[id] = (W[id] || 0) + ev[k][id]; }
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
    if (s.yd) root.yd = 1;
    if (s.pl) root.pl = 1;
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
    divideEnds(this.lines, s, at, root.id);
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
    if (s.yd) h.yd = 1;
    if (s.pl) h.pl = 1;
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

  /** $ left of the job's budget (null before a job is set). */
  cash() { return this.job ? this.job.budget - this.damage - this.wages - this.spent : null; }

  // ---- welcome ----
  serialize() {
    return {
      segs: [...this.segs.values()].map((s) => ({ ...s, f: packBundle(s.f) })), pieces: [...this.pieces.values()],
      rope: this.rope, players: [...this.players.values()], paving: packPaving(this.paving), chipper: this.chipper, builds: packBuilds(this.builds),
      terrain: this.terrain ? this.terrain.spec : null, damage: this.damage, job: this.job, wages: this.wages, spent: this.spent, stands: this.stands, mark: this.mark, seed: this.seed || '', lines: this.lines,
      bins: this.bins, prog: this.prog, awards: this.awards,
    };
  }
  load(o) {
    this.segs.clear(); this.pieces.clear(); this.players.clear();
    for (const s of o.segs) this.segs.set(s.id, { ...s, f: unpackBundle(s.f) });
    for (const p of o.pieces) this.pieces.set(p.id, p);
    for (const p of o.players) this.players.set(p.id, p);
    this.rope = o.rope;
    this.terrain = makeTerrain(o.terrain || null);
    this.paving = unpackPaving(o.paving, this.terrain);
    this.chipper = o.chipper || null;
    if (this.chipper && !this.chipper.units) this.chipper = { piles: this.chipper.piles || [], units: [{ p: this.chipper.p, q: this.chipper.q, wreck: this.chipper.wreck || null }] };
    this.builds = unpackBuilds(o.builds);
    this.damage = o.damage || 0; this.job = o.job || null; this.wages = o.wages || 0; this.spent = o.spent || 0;
    this.stands = o.stands || null; this.mark = o.mark || null; this.seed = o.seed || ''; this.lines = o.lines || null;
    this.bins = o.bins || []; this.prog = o.prog || newProg(); this.awards = { ...newAwards(), ...(o.awards || {}) };
    this._dirty();
    for (const fn of this.listeners) fn({ t: 'load' }, {});
  }
}

const EMPTY = [];
/** M: kg of the job tree (wood and leaves) as grown; chipped: kg of it chipped; lost: kg of it swept away as debris
 * (twigs under DEBRIS_MASS, which nobody could chip: the share chipped is of M - lost); made: m3 of chips blown out by
 * the chippers; gone: m3 of chips that went into bins. */
/** job: id of this job ('' before one, as in the engine tests: nothing is handed out); got: kind -> {player id:
 * highest tier handed to them}; ate: player id -> tube salads eaten this job; work: {chop: id -> m² of the job tree
 * sawn through, chip: id -> kg of it they fed that was chipped, bin: id -> m³ of chips they put in bins}. In the world so a host taking over (D104) carries on. */
function newAwards() { return { job: '', got: {}, ate: {}, work: { chop: {}, chip: {}, bin: {} } }; }
function newProg() { return { M: 0, chipped: 0, lost: 0, made: 0, gone: 0 }; }
