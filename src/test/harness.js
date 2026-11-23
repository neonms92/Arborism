// Test harness: one scripted run of the real sim, with the manifest's
// invariants checked every tick and its shared measurements on hand.
// See docs/TESTS.md sections 1.2 - 1.4. Runs in a Web Worker (headless) or on
// the main thread with a View attached (the graphical view of one run).
//
// Wood is built from `tree` events and cut through the same `sever()` the saw
// uses, so a run is the engine's own behaviour, not a re-implementation of it.
// Nothing here writes to the model directly.

import { CFG } from '../config.js';
import { World, segLen, segAxis, segRadius, lerp3 } from '../model/world.js';
import { layout, bundleBasis, gridFor, INTACT } from '../model/fibres.js';
import { frameApply } from '../model/flex.js';
import { Sim } from '../sim/sim.js';
import RAPIER from '../../vendor/rapier/rapier.mjs';
import { sever } from '../sim/saw.js';

export const DEG = Math.PI / 180;
const L_ELASTIC = 0, L_CONTACT = 1, L_BROKEN = 2;     // live fibre states (structure.js)

export class Breach extends Error {
  constructor(inv, tick, detail) { super(`${inv} at tick ${tick}: ${detail}`); this.inv = inv; this.tick = tick; this.detail = detail; }
}

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const norm = (v) => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const fin = (...xs) => xs.every(Number.isFinite);

export function p95(arr) {
  if (!arr.length) return 0;
  const a = Float64Array.from(arr).sort();
  return a[Math.min(a.length - 1, Math.floor(a.length * 0.95))];
}
export function mean(arr) { let s = 0; for (const x of arr) s += x; return arr.length ? s / arr.length : 0; }

/**
 * A straight run of wood (a stem or a limb) in piece-local coordinates: every
 * segment lying on the line base + h * axis, whichever piece it now belongs to
 * (local coordinates survive a split). Cuts are placed by height h along it.
 */
export class Member {
  constructor(ctx, base, axis, length, r0, r1) {
    this.ctx = ctx; this.base = base; this.axis = norm(axis); this.length = length; this.r0 = r0; this.r1 = r1;
  }
  R(h) { return this.r0 + (this.r1 - this.r0) * Math.min(1, Math.max(0, h / this.length)); }
  /** Segments on this line, with h0 = height of their base. */
  segs() {
    const out = [];
    for (const s of this.ctx.world.segs.values()) {
      const ax = segAxis(s);
      if (dot(ax, this.axis) < 0.9999) continue;
      const d = sub(s.a, this.base), h0 = dot(d, this.axis);
      const off = [d[0] - this.axis[0] * h0, d[1] - this.axis[1] * h0, d[2] - this.axis[2] * h0];
      if (Math.hypot(off[0], off[1], off[2]) > 1e-4) continue;
      out.push({ s, h0, L: segLen(s) });
    }
    return out.sort((a, b) => a.h0 - b.h0);
  }
  segAt(h) { const ss = this.segs(); for (const e of ss) if (h >= e.h0 - 1e-6 && h <= e.h0 + e.L + 1e-6) return e; return ss[ss.length - 1]; }
  /** World position of the point at height h on the axis (bent, on whichever piece it is now). */
  pointAt(h) {
    const e = this.segAt(h), t = Math.min(1, Math.max(0, (h - e.h0) / e.L));
    return this.ctx.sim.segToWorld(e.s, lerp3(e.s.a, e.s.b, t));
  }
  butt(piece) { const ss = this.segs().filter((e) => e.s.piece === piece); return ss.length ? this.ctx.sim.segToWorld(ss[0].s, ss[0].s.a) : null; }
  top() { const ss = this.segs(), e = ss[ss.length - 1]; return { seg: e.s, p: this.ctx.sim.segToWorld(e.s, e.s.b) }; }
  /** The piece the top of this member is on now. */
  topPiece() { const ss = this.segs(); return ss[ss.length - 1].s.piece; }
  /** World direction butt -> top of the part of this member that is on `piece`. */
  dirOf(piece) {
    const ss = this.segs().filter((e) => e.s.piece === piece); if (!ss.length) return null;
    const a = this.ctx.sim.segToWorld(ss[0].s, ss[0].s.a), b = this.ctx.sim.segToWorld(ss[ss.length - 1].s, ss[ss.length - 1].s.b);
    return b.sub(a).normalize();
  }
  /**
   * Every fibre of the segment at height hRef, with its position across the
   * stem: o = unit-radius offset (world-local direction), r = radius there.
   */
  fibresAt(hRef) {
    const e = this.segAt(hRef), s = e.s, lay = layout(s.f.N), { u, v } = bundleBasis(segAxis(s)), r = this.R(hRef), out = [];
    for (let i = 0; i < s.f.n; i++) {
      const X = lay.X[i], Y = lay.Y[i];
      out.push({ i, N: s.f.N, o: [u[0] * X + v[0] * Y, u[1] * X + v[1] * Y, u[2] * X + v[2] * Y], r, A: lay.dA * r * r, cs: lay.cs * r });
    }
    return out;
  }

  /**
   * Sever wood. region(o, r, i, N) -> [h0, h1] (the stretch of that fibre the
   * cut removes, as heights along the member) or null. Goes through the saw's
   * own sever(), so a second cut plane far from the first divides the segment
   * exactly as in play; this then re-places the rest of the cut.
   */
  cut(region) {
    const ctx = this.ctx;
    let n = 0;
    for (let attempt = 0; attempt < 6; attempt++) {
      let divided = false;
      for (const e of this.segs()) {
        const s = e.s, f = s.f, lay = layout(f.N), { u, v } = bundleBasis(segAxis(s)), idx = [], z = [];
        for (let i = 0; i < f.n; i++) {
          const X = lay.X[i], Y = lay.Y[i], o = [u[0] * X + v[0] * Y, u[1] * X + v[1] * Y, u[2] * X + v[2] * Y];
          const iv = region(o, this.R(e.h0 + e.L / 2), i, f.N); if (!iv) continue;
          let z0 = iv[0] - e.h0, z1 = iv[1] - e.h0;
          if (z1 < -1e-6 || z0 > e.L + 1e-6) continue;
          z0 = Math.max(0, Math.min(e.L, z0)); z1 = Math.max(0, Math.min(e.L, z1));
          if (f.state[i] !== INTACT && f.zmin[i] <= z0 + 1e-5 && f.zmax[i] >= z1 - 1e-5) continue;
          idx.push(i); z.push(+z0.toFixed(4));
          if (z1 > z0 + 1e-4) { idx.push(i); z.push(+z1.toFixed(4)); }
        }
        if (!idx.length) continue;
        n += ctx.severBatch(s, idx, z);
        if (ctx.lastDivide) { ctx.lastDivide = false; divided = true; break; }     // sever() divided the segment instead: place the cut again
      }
      if (!divided) break;
    }
    return n;
  }
}

export class Ctx {
  /** opts.frame: async fn(ctx) after every tick (the viewer draws and waits for the next frame there). */
  static async create(opts = {}) {
    const world = new World();
    const sim = await Sim.create(world, { tree: false });
    return new Ctx(world, sim, opts);
  }

  constructor(world, sim, opts) {
    this.world = world; this.sim = sim; this.frame = opts.frame || null;
    this.actions = [];          // fn(ctx) before each tick (progressive cuts)
    this.loads = [];            // point loads: {member, h, F(ctx) -> [3]}
    this.hooks = [];            // fn(ctx) after each tick (measurements)
    this.stepMs = [];
    this.splits = [];           // {tick, seg, at, piece, live, mass, h0}
    this.pending = [];
    this.joints = new Map();    // distal piece -> tracked live joint
    this.jointLog = [];         // ended joints
    this.h0 = new Map();        // piece -> COM height when it became a piece (INV-3)
    this.evCount = 0; this.evHash = 2166136261;
    this.lastDivide = false;
    this.notes = [];
    this.maxTicks = Infinity;
    world.on((ev, info) => this.onEvent(ev, info));
    sim.onLoads = () => this.applyLoads();
  }

  get t() { return this.sim.tick * CFG.TICK; }
  get tick() { return this.sim.tick; }

  onEvent(ev, info) {
    if (ev.t === 'toast') return;
    this.evCount++;
    const str = ev.t === 'tree' ? `tree:${ev.piece}:${ev.segs.length}` : JSON.stringify(ev);
    let h = this.evHash;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
    h ^= this.sim.tick; this.evHash = Math.imul(h, 16777619) >>> 0;
    if (ev.t === 'divide') this.lastDivide = true;
    if (ev.t === 'tree') this.treeSegs = ev.segs.map((x) => x.id);
    if (ev.t === 'split') {
      const old = this.world.pieces.get(info.oldPiece);
      this.pending.push({ tick: this.sim.tick, seg: ev.seg, at: ev.at, piece: ev.newPiece, fromFixed: !!(old && old.fixed), moved: info.moved ? info.moved.slice() : [] });
    }
  }

  // ---- building ----
  /** One `tree` event from a list of {parent (index or -1), a, b, r0, r1, leaf}. Returns the seg ids. */
  plant(list) {
    const w = this.world, piece = w.newId(), ids = list.map(() => w.newId());
    const segs = list.map((d, k) => ({ id: ids[k], parent: d.parent >= 0 ? ids[d.parent] : -1, a: d.a, b: d.b, r0: d.r0, r1: d.r1, leaf: d.leaf || 0, N: gridFor(d.r0) }));
    this.sim.emit({ t: 'tree', piece, segs });
    this.sim.outbox.length = 0;
    return ids;
  }
  /** A straight chain from `base` along `axis`, appended to `list`. Returns the member's description. */
  static chain(list, parent, base, axis, length, r0, r1) {
    const n = Math.max(1, Math.round(length / Math.max(0.05, CFG.SEG_LEN))), ax = norm(axis);
    let par = parent;
    for (let i = 0; i < n; i++) {
      const a = [base[0] + ax[0] * length * i / n, base[1] + ax[1] * length * i / n, base[2] + ax[2] * length * i / n];
      const b = [base[0] + ax[0] * length * (i + 1) / n, base[1] + ax[1] * length * (i + 1) / n, base[2] + ax[2] * length * (i + 1) / n];
      list.push({ parent: par, a, b, r0: r0 + (r1 - r0) * i / n, r1: r0 + (r1 - r0) * (i + 1) / n });
      par = list.length - 1;
    }
    return par;
  }
  /** Stem(H, D, taper, lean, leanAz): a branchless rooted trunk (TESTS.md 1.4). Angles in radians. */
  stem(H, D, lean = 0, leanAz = 0, taper = 0.4) {
    const axis = [Math.sin(lean) * Math.cos(leanAz), Math.cos(lean), Math.sin(lean) * Math.sin(leanAz)], list = [];
    Ctx.chain(list, -1, [0, 0, 0], axis, H, D / 2, D / 2 * taper);
    this.plant(list);
    return new Member(this, [0, 0, 0], axis, H, D / 2, D / 2 * taper);
  }
  /**
   * Limb(L, D, angle): a vertical stub of diameter 1.5 D with a straight limb
   * leaving its tip `angle` above horizontal (towards +x). The stub stands on
   * a rooted base high enough that the limb can hang straight down without
   * reaching the ground (TESTS.md 1.4, note on Limb).
   */
  limb(L, D, angle = 0, taper = 0.4) {
    const y0 = L + 1.0, list = [];
    const top = Ctx.chain(list, -1, [0, y0, 0], [0, 1, 0], 0.5, 0.75 * D, 0.75 * D);
    const base = [0, y0 + 0.5, 0], axis = [Math.cos(angle), Math.sin(angle), 0];
    Ctx.chain(list, top, base, axis, L, D / 2, D / 2 * taper);
    this.plant(list);
    const m = new Member(this, base, axis, L, D / 2, D / 2 * taper);
    m.stub = new Member(this, [0, y0, 0], [0, 1, 0], 0.5, 0.75 * D, 0.75 * D);
    return m;
  }

  // ---- cutting ----
  /** Sever fibres idx at z of segment s, through the saw's path (or into its live joint). Returns fibres sent. */
  severBatch(s, idx, z) {
    // fibres this close to a live joint's plane are that joint's fibres (the same distance sever() uses to keep one cut plane)
    const st = this.sim.structure, L = segLen(s), zone = Math.max(2 * s.r0, 0.15), zm = z.reduce((a, x) => a + x, 0) / z.length;
    for (const [pid, j] of st.live) {
      if ((j.parentSeg === s.id && j.rootSeg !== s.id && zm > L - zone) || (j.rootSeg === s.id && zm < zone)) {
        st.cutLive(pid, idx);
        return idx.length;
      }
    }
    this.lastDivide = false;
    sever(this.sim, { b: { seg: s.id }, i: idx, z });
    this.sim.outbox.length = 0;
    return idx.length;
  }

  /**
   * Progressive cut (TESTS.md 1.4): the fibres region() selects at height
   * hRef, severed in order of key(o, r) (smallest first) at CUT_RATE m^2/s.
   * Returns a handle {done, start, end, count, total}.
   */
  progressive(member, hRef, region, key) {
    const list = member.fibresAt(hRef).filter((fb) => region(fb.o, fb.r, fb.i, fb.N))
      .map((fb) => ({ ...fb, k: key(fb.o, fb.r) })).sort((a, b) => a.k - b.k || a.i - b.i);
    const hd = { done: !list.length, start: this.tick, end: list.length ? -1 : this.tick, count: 0, total: list.length, area: 0, list };
    let next = 0, budget = 0;
    const act = () => {
      if (hd.done) return;
      budget += CFG.CUT_RATE * CFG.TICK;
      const take = new Set();
      while (next < list.length && budget >= list[next].A) { budget -= list[next].A; hd.area += list[next].A; take.add(list[next].i); next++; }
      if (take.size) { member.cut((o, r, i) => (take.has(i) ? region(o, r, i) : null)); hd.count += take.size; }
      if (next >= list.length) { hd.done = true; hd.end = this.tick; this.actions = this.actions.filter((a) => a !== act); }
    };
    this.actions.push(act);
    return hd;
  }

  // ---- loads ----
  /**
   * A point load at height h on a member: F(ctx) -> [fx, fy, fz] N, applied
   * each tick while that wood is still held by the tree. On wood that has gone
   * live it fades as the point speeds up (0 at 2 m/s), as a climber's weight
   * does (STATUS.md): a force, not a mass, must not drive wood past free fall.
   */
  addLoad(member, h, F, opts) {
    return this.addLoadAt(() => {
      const e = member.segAt(h), t = Math.min(1, Math.max(0, (h - e.h0) / e.L));
      return { s: e.s, p: lerp3(e.s.a, e.s.b, t) };
    }, F, opts);
  }
  /**
   * where(ctx) -> {s, p}: a segment and a piece-local point on it.
   * opts.hang: a downward load that is a real hanging weight. While the wood is rooted it is the force F; once
   * the wood is loose it becomes a point mass |F| / g on a ball joint at that point (still following F as it
   * ramps), so it keeps pulling as the limb tears instead of fading like a capped force. It lets go when the
   * wood comes free.
   */
  addLoadAt(where, F, opts = {}) { const l = { where, F, on: true, hang: !!opts.hang, w: null, wPiece: -1 }; this.loads.push(l); return l; }
  hangWeight(l, s, p, mag) {
    const sim = this.sim, b = sim.bodies.get(s.piece), m = Math.max(0.01, mag / CFG.GRAVITY), I = { x: 1e-4 * m, y: 1e-4 * m, z: 1e-4 * m };
    if (l.w && l.wPiece === s.piece && sim.bodies.get(l.wPiece) === l.wBody) { l.w.setAdditionalMassProperties(m, { x: 0, y: 0, z: 0 }, I, { x: 0, y: 0, z: 0, w: 1 }, true); return; }
    if (l.w) sim.rapier.removeRigidBody(l.w);
    const v = b.linvel();
    l.w = sim.rapier.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(p.x, p.y, p.z).setLinvel(v.x, v.y, v.z)
      .setAdditionalMassProperties(m, { x: 0, y: 0, z: 0 }, I, { x: 0, y: 0, z: 0, w: 1 }));
    // the joint's anchor on the wood, in the wood body's frame
    const t = b.translation(), q = b.rotation(), dx = p.x - t.x, dy = p.y - t.y, dz = p.z - t.z;
    const qx = -q.x, qy = -q.y, qz = -q.z, qw = q.w;                 // inverse rotation
    const ix = qw * dx + qy * dz - qz * dy, iy = qw * dy + qz * dx - qx * dz, iz = qw * dz + qx * dy - qy * dx, iw = -qx * dx - qy * dy - qz * dz;
    const a = { x: ix * qw + iw * -qx + iy * -qz - iz * -qy, y: iy * qw + iw * -qy + iz * -qx - ix * -qz, z: iz * qw + iw * -qz + ix * -qy - iy * -qx };
    sim.rapier.createImpulseJoint(RAPIER.JointData.spherical(a, { x: 0, y: 0, z: 0 }), b, l.w, true);
    l.wPiece = s.piece; l.wBody = b;
  }
  applyLoads() {
    const sim = this.sim;
    for (const l of this.loads) {
      if (!l.on) continue;
      if (l.w && !this.world.pieces.has(l.wPiece)) { sim.rapier.removeRigidBody(l.w); l.w = null; }
      const at = l.where(this); if (!at) continue;
      const s = at.s, piece = this.world.pieces.get(s.piece);
      if (!piece || !this.world.segs.has(s.id)) continue;
      if (!sim.structure.isHeld(s.piece)) {
        // came free: let go of the weight (it has no collider, so it would drag the wood through the ground)
        if (l.w) { sim.rapier.removeRigidBody(l.w); l.w = null; }
        continue;
      }
      const p = sim.segToWorld(s, at.p), f = l.F(this);
      if (l.hang && !piece.fixed) { const mag = Math.hypot(f[0], f[1], f[2]); this.hangWeight(l, s, p, mag); l.applied = mag; continue; }
      let k = 1;
      if (!piece.fixed) {
        const b = sim.bodies.get(s.piece), v = b.linvel(), wv = b.angvel(), c = b.worldCom();
        const rx = p.x - c.x, ry = p.y - c.y, rz = p.z - c.z;
        const sp = Math.hypot(v.x + wv.y * rz - wv.z * ry, v.y + wv.z * rx - wv.x * rz, v.z + wv.x * ry - wv.y * rx);
        k = Math.max(0, 1 - sp / 2);
        // and it cannot by itself accelerate the point it acts on harder than 2 g (one tick of a big load would
        // launch it): cap at 2 g times the wood's effective mass at that point, rotation included
        const mag = Math.hypot(f[0], f[1], f[2]);
        if (mag > 0) {
          const n = [f[0] / mag, f[1] / mag, f[2] / mag], rn = [ry * n[2] - rz * n[1], rz * n[0] - rx * n[2], rx * n[1] - ry * n[0]];
          const e = b.effectiveWorldInvInertia().elements, I = [e[0], e[1], e[2], e[1], e[3], e[4], e[2], e[4], e[5]];
          let q = 0; for (let a = 0; a < 3; a++) for (let c = 0; c < 3; c++) q += rn[a] * I[a * 3 + c] * rn[c];
          const cap = 2 * CFG.GRAVITY / (1 / b.mass() + q);
          if (mag * k > cap) k = cap / mag;
        }
      }
      l.applied = k * Math.hypot(f[0], f[1], f[2]);
      if (k > 0) sim.applyForce(s.id, p, { x: f[0] * k, y: f[1] * k, z: f[2] * k });
    }
  }

  // ---- running ----
  /** Run for T simulated seconds, or until until(ctx) is true. Returns true if until() stopped it. */
  async run(T, until) {
    const end = this.sim.tick + Math.round(T / CFG.TICK);
    while (this.sim.tick < end) {
      if (this.sim.tick >= this.maxTicks) throw new Breach('LIMIT', this.sim.tick, 'run exceeded its tick budget');
      this.stepOnce();
      if (this.frame) await this.frame(this);
      if (until && until(this)) return true;
    }
    return false;
  }

  stepOnce() {
    try {
      for (const a of [...this.actions]) a(this);
      const t0 = performance.now();
      this.sim.step();
      this.stepMs.push(performance.now() - t0);
    } catch (e) {
      if (e instanceof Breach) throw e;
      throw new Breach('INV-2', this.sim.tick, (e && e.stack) || String(e));
    }
    this.sim.outbox.length = 0;
    this.observe();
    this.invariants();
    for (const h of this.hooks) h(this);
  }

  observe() {
    const sim = this.sim, st = sim.structure;
    for (const p of this.pending) {
      const b = sim.bodies.get(p.piece);
      p.live = st.live.has(p.piece);
      p.mass = b ? b.mass() : 0;
      if (b) { p.h0 = b.worldCom().y; this.h0.set(p.piece, p.h0); }
      this.splits.push(p);
    }
    this.pending.length = 0;
    for (const [piece, j] of st.live) {
      let J = this.joints.get(piece);
      if (!J) {
        let el = 0; for (let i = 0; i < j.count; i++) if (j.st[i] === L_ELASTIC) el++;
        J = { piece, parent: j.parent, parentSeg: j.parentSeg, rootSeg: j.rootSeg, start: this.tick, startElastic: el, end: -1,
          maxAngle: 0, snapped: [], seen: new Uint8Array(j.count), closed: false, contact: new Set(), j };
        for (let i = 0; i < j.count; i++) if (j.st[i] === L_BROKEN) J.seen[i] = 1;
        this.joints.set(piece, J);
      }
      if (j.angle > J.maxAngle) J.maxAngle = j.angle;
      for (let i = 0; i < j.count; i++) {
        if (j.st[i] === L_BROKEN && !J.seen[i]) { J.seen[i] = 1; J.snapped.push({ i, tick: this.tick }); }
        if (j.st[i] === L_CONTACT && j.force[i] < 0) { J.closed = true; J.contact.add(i); }   // severed faces bearing on each other
      }
    }
    for (const [piece, J] of this.joints) {
      if (st.live.has(piece)) continue;
      J.end = this.tick;
      // the last fibres usually go in the same solve that ends the joint: record them too
      for (let i = 0; i < J.j.count; i++) if (J.j.st[i] === L_BROKEN && !J.seen[i]) { J.seen[i] = 1; J.snapped.push({ i, tick: this.tick }); }
      let el = 0; for (let i = 0; i < J.j.count; i++) if (J.j.st[i] === L_ELASTIC) el++;
      J.endElastic = el;
      this.joints.delete(piece); this.jointLog.push(J);
    }
  }
  /** Every joint seen so far, live or ended, oldest first. */
  allJoints() { return [...this.jointLog, ...this.joints.values()].sort((a, b) => a.start - b.start); }

  // ---- invariants (TESTS.md 1.2) ----
  invariants() {
    const sim = this.sim, w = this.world, tick = this.sim.tick, g = CFG.GRAVITY;
    for (const [id, b] of sim.bodies) {
      const piece = w.pieces.get(id); if (!piece) continue;
      const t = b.translation(), q = b.rotation();
      if (!fin(t.x, t.y, t.z, q.x, q.y, q.z, q.w)) throw new Breach('INV-1', tick, `piece ${id} transform is not finite`);
      if (piece.fixed) {
        if (Math.abs(t.x) + Math.abs(t.y) + Math.abs(t.z) > 1e-9 || Math.abs(q.w) < 1 - 1e-9) throw new Breach('INV-5', tick, `rooted piece ${id} moved`);
        continue;
      }
      const v = b.linvel(), av = b.angvel();
      if (!fin(v.x, v.y, v.z, av.x, av.y, av.z)) throw new Breach('INV-1', tick, `piece ${id} velocity is not finite`);
      const c = b.worldCom();
      if (c.y < -0.5) throw new Breach('INV-4', tick, `piece ${id} centre of mass at y = ${c.y.toFixed(2)} m`);
      const h0 = this.h0.get(id);
      if (h0 !== undefined) {
        const sp = Math.hypot(v.x, v.y, v.z), lim = Math.sqrt(2 * g * Math.max(0, h0)) + 2;
        if (sp > lim) throw new Breach('INV-3', tick, `piece ${id} at ${sp.toFixed(2)} m/s, free fall from ${h0.toFixed(2)} m allows ${lim.toFixed(2)}`);
      }
    }
    for (const piece of w.pieces.values()) {
      if (!piece.fixed) continue;
      for (const s of w.segsOf(piece.id)) {
        const f = s.f;
        if (!fin(f.e0, f.e1, f.e2)) throw new Breach('INV-1', tick, `strain plane of segment ${s.id} is not finite`);
        if (tick % 30 === 0 && f.load && f.ncut < f.n) {
          const err = equilibriumError(f);
          if (err) throw new Breach('INV-6', tick, `segment ${s.id}: ${err}`);
        }
      }
    }
    for (const j of sim.structure.live.values()) {
      for (let i = 0; i < j.count; i++) if (j.st[i] !== L_BROKEN && !Number.isFinite(j.force[i])) throw new Breach('INV-1', tick, `live fibre ${i} force is not finite`);
    }
  }

  // ---- shared measurements (TESTS.md 1.3) ----
  /** Worst utilisation U over the stiff bundles of the standing wood, and where. */
  worstU() {
    let U = 0, seg = -1;
    for (const piece of this.world.pieces.values()) {
      if (!piece.fixed) continue;
      for (const s of this.world.segsOf(piece.id)) {
        if (s.f.ncut >= s.f.n) continue;
        const u = Math.max(s.f.maxT / CFG.MOR, -s.f.minC / CFG.COMP);
        if (u > U) { U = u; seg = s.id; }
      }
    }
    return { U, seg };
  }
  /** Start tracking "settled" (TESTS.md 1.3). Returns an object whose .settled is kept current. */
  trackSettle() {
    if (this.settle) return this.settle;
    const tr = { settled: false, ring: [], since: -1 };
    this.settle = tr;
    this.hooks.push(() => {
      if (this.tick % 6) return;
      const sim = this.sim, w = this.world, flex = sim.structure.flex, snap = new Map();
      for (const piece of w.pieces.values()) {
        if (!piece.fixed) continue;
        for (const s of w.segsOf(piece.id)) snap.set(s.id, frameApply(flex.at(s.id, 1), s.b));
      }
      tr.ring.push(snap); if (tr.ring.length > 11) tr.ring.shift();
      let ok = tr.ring.length === 11 && sim.structure.live.size === 0;
      if (ok) {
        const last = tr.ring[tr.ring.length - 1];
        outer: for (const [id, p] of last) for (const old of tr.ring) {
          const q = old.get(id); if (!q) { ok = false; break outer; }
          if (Math.abs(p[0] - q[0]) + Math.abs(p[1] - q[1]) + Math.abs(p[2] - q[2]) > 0.001) { ok = false; break outer; }
        }
      }
      if (ok) for (const [id, b] of sim.bodies) {
        if (w.pieces.get(id)?.fixed) continue;
        const v = b.linvel(), a = b.angvel();
        if (Math.hypot(v.x, v.y, v.z) > 0.05 || Math.hypot(a.x, a.y, a.z) > 0.05) { ok = false; break; }
      }
      if (ok && !tr.settled) tr.since = this.t;
      tr.settled = ok;
    });
    return tr;
  }
  stepStats(from = 0, to = this.stepMs.length) {
    const a = this.stepMs.slice(from, to);
    return { mean: +mean(a).toFixed(4), p95: +p95(a).toFixed(4) };
  }
  fibreCount() { let n = 0; for (const s of this.world.segs.values()) n += s.f.n; return n; }
}

/**
 * INV-6: do the fibre forces from a stiff bundle's strain plane give back the
 * axial force and moments it was solved for? Mirrors fibres.analyse() term for
 * term (including each fibre's own width). Returns an error string or null.
 */
export function equilibriumError(f) {
  const [R, Nax, Mu, Mv] = f.load, L = layout(f.N), n = L.n, X = L.X, Y = L.Y, dA = L.dA * R * R;
  const Et = CFG.MOR / CFG.TENS_STRAIN, Ec = CFG.COMP / CFG.COMP_STRAIN, Ek = CFG.KERF_CONTACT * Ec, half = L.cs * R / 2;
  let N = 0, MU = 0, MX = 0, A = 0;
  for (let c = 0; c < n; c++) {
    const wgt = f.state[c] === INTACT ? (f.sgn[c] < 0 ? Ec : f.sgn[c] > 0 ? Et : (Et + Ec) / 2) : (f.act[c] ? Ek : 0);
    if (!wgt) continue;
    const x = X[c] * R, y = Y[c] * R, eps = f.e0 + f.e1 * x + f.e2 * y, s = wgt * eps * dA;
    N += s; MU += s * y; MX += s * x; A += wgt * dA;
  }
  const own = A * (2 * half) * (2 * half) / 12;
  MU += own * f.e2; MX += own * f.e1;
  const tolN = Math.max(1, 0.01 * Math.abs(Nax)), tolM = Math.max(1, 0.01 * Math.hypot(Mu, Mv));
  if (Math.abs(N - Nax) > tolN) return `axial force ${N.toFixed(1)} N, solved for ${Nax.toFixed(1)} N`;
  if (Math.abs(MU - Mu) > tolM || Math.abs(MX + Mv) > tolM) return `moment (${MU.toFixed(1)}, ${(-MX).toFixed(1)}) N·m, solved for (${Mu.toFixed(1)}, ${Mv.toFixed(1)})`;
  return null;
}

export { dot, sub, norm, cross };
