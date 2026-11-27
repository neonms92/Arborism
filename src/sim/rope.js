// The rigging line: a tension path  anchor -> block -> device -> tail.
// Host only. Layout lives in world.rope (changed via 'rope' events); the
// scalars here (L0, tension, wraps, holder) go out in aux packets.
// See docs/DESIGN.md section 5.

import * as THREE from '../../vendor/three/three.module.js';
import { CFG, MODE } from '../config.js';
import { segRadius, segParam, lerp3, segAxis, perp } from '../model/world.js';
import { routeSpan, pushOut, nearObstacles, spanLength } from '../model/ropepath.js';

const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _d = new THREE.Vector3(), _e = new THREE.Vector3();
const V = (x) => new THREE.Vector3(x[0], x[1], x[2]);

export class Rope {
  constructor(sim) { this.sim = sim; this.reset(); }
  reset() { this.L0 = 0; this.T = 0; this.wraps = 2; this.holder = -1; this.prev = 0; this.lastForce = null; this.slack = 0; this.wrap = [[], []]; this.path = null; }

  node(n) { return n.chip ? this.sim.chipper.unit(n.k).infeed() : this.sim.segToWorld(this.sim.world.segs.get(n.seg), n.p); }
  /** The chipper's feed rollers have the rope: they reel it in until it is cut, the block comes down or a reset. */
  fed() { const r = this.sim.world.rope; return r.state === 2 && !!r.anchor.chip; }

  // ---- placing ({rig}: block, then tie, then untie at the knot) ----
  target(p, aim) {
    if (!aim || aim.dist > CFG.REACH) return null;
    const sim = this.sim, s = sim.world.segs.get(aim.seg);
    const loc = sim.segToLocal(s, aim.point);
    return { seg: s.id, p: loc, fixed: sim.world.pieces.get(s.piece).fixed, point: aim.point };
  }
  prompt(p, aim) {
    const st = this.sim.world.rope.state, t = this.target(p, aim);
    if (st === 0) return t && t.fixed ? '{rig}: hang block' : '';
    if (st === 1) return !t ? 'Look at wood within reach to tie the rope to it, or at the block to take it down'
      : this.node(this.sim.world.rope.block).distanceTo(t.point) < 0.7 ? '{rig}: remove block' : '{rig}: tie rope';
    if (this.fed()) return t && this.node(this.sim.world.rope.block).distanceTo(t.point) < 0.7 ? '{rig}: remove block' : '';
    if (t && this.node(this.sim.world.rope.anchor).distanceTo(t.point) < 0.7) return '{rig}: untie';
    return '';
  }
  place(p, aim) {
    const sim = this.sim, w = sim.world, r = w.rope, t = this.target(p, aim);
    if (!t) return;
    if (this.fed()) { if (this.node(r.block).distanceTo(t.point) < 0.7) this.swallow('The block came down: the chipper took the rope'); return; }
    if (r.state === 0) {
      if (!t.fixed) return;
      // the block hangs on a short sling off the wood looked at (D123): below a limb, beside a stem
      const s = w.segs.get(t.seg), ax = segAxis(s), tt = Math.min(1, Math.max(0, segParam(s, t.p))), c = lerp3(s.a, s.b, tt);
      const rad = perp([t.p[0] - c[0], t.p[1] - c[1], t.p[2] - c[2]], ax);
      const hang = perp([rad[0] * 0.3, rad[1] * 0.3 - 1, rad[2] * 0.3], ax), off = segRadius(s, tt) + CFG.BLOCK_DROP;
      const bp = [c[0] + hang[0] * off, c[1] + hang[1] * off, c[2] + hang[2] * off];
      // friction device: on the bark of the root segment of the same piece, about 1 m up, on the side under the block
      const root = w.segsOf(s.piece)[0], rt = Math.min(0.9, 1 / Math.max(0.5, root.b[1] - root.a[1]));
      const rc = lerp3(root.a, root.b, rt), raxis = segAxis(root), hz = [bp[0] - rc[0], 0, bp[2] - rc[2]];
      const side = Math.hypot(hz[0], hz[2]) > 0.05 ? perp(hz, raxis) : perp([1, 0, 0], raxis), doff = segRadius(root, rt) + CFG.DEVICE_OFF;
      const dev = { seg: root.id, p: [rc[0] + side[0] * doff, rc[1] + side[1] * doff, rc[2] + side[2] * doff] };
      sim.emit({ t: 'rope', rope: { state: 1, block: { seg: t.seg, p: bp }, device: dev } });
      this.wrap = [[], []]; this.route(30);
    } else if (r.state === 1 && this.node(r.block).distanceTo(t.point) < 0.7) {
      this.clear(p);                                     // looking at the block: take it down
    } else if (r.state === 1) {
      // the knot sits on the bark, the rope round the wood (D123)
      const s = w.segs.get(t.seg), tt = Math.min(1, Math.max(0, segParam(s, t.p))), c = lerp3(s.a, s.b, tt);
      const rad = perp([t.p[0] - c[0], t.p[1] - c[1], t.p[2] - c[2]], segAxis(s)), off = segRadius(s, tt) + CFG.ROPE_RADIUS + 0.01;
      sim.emit({ t: 'rope', rope: { ...r, state: 2, anchor: { seg: t.seg, p: [c[0] + rad[0] * off, c[1] + rad[1] * off, c[2] + rad[2] * off] } } });
      this.wrap[0] = []; this.route(30);
      this.L0 = this.pathLength() + 0.15; this.prev = 0; this.T = 0;
    } else if (this.node(r.anchor).distanceTo(t.point) < 0.7) {
      sim.emit({ t: 'rope', rope: { state: 1, block: r.block, device: r.device } });
      this.T = 0; this.wrap[0] = [];
    }
  }
  clear(p) {
    if (this.sim.world.rope.state === 1) this.sim.emit({ t: 'rope', rope: { state: 0 } });
  }

  /** Straight runs of rope in the world, for anything that can cut it. */
  spans() {
    const out = [], P = this.path;
    if (!P) return out;
    for (let i = 1; i < P.pts.length; i++) out.push([V(P.pts[i - 1]), V(P.pts[i])]);
    return out;
  }

  // ---- the rope's path over the wood (D123): model/ropepath.js on every segment thick enough to hold it ----
  obstacles() {
    const sim = this.sim;
    if (this._obsTick === sim.tick && this._obs) return this._obs;
    const out = [];
    for (const s of sim.world.segs.values()) {
      if (Math.max(s.r0, s.r1) < CFG.ROPE_WRAP_R || !sim.world.pieces.get(s.piece)) continue;
      out.push({ id: s.id, a: sim.segToWorld(s, s.a, _a).toArray(), b: sim.segToWorld(s, s.b, _b).toArray(), r0: s.r0, r1: s.r1 });
    }
    this._obsTick = sim.tick; this._obs = out;
    return out;
  }
  /**
   * Lay the rope over the wood: anchor -> contact points -> block -> contact points -> device.
   * Sets this.path = {pts (world arrays), segs (seg id per point, -1 for the chipper), legs (index of the block)}.
   */
  route(iters = CFG.ROPE_WRAP_ITERS) {
    const sim = this.sim, w = sim.world, r = w.rope, rr = CFG.ROPE_RADIUS;
    if (r.state < 1) { this.path = null; this.wrap = [[], []]; return; }
    const hasA = r.state >= 2;
    const raw = [hasA ? this.node(r.anchor) : null, this.node(r.block), this.node(r.device)].map((v) => v && v.toArray());
    const all = this.obstacles(), near = nearObstacles(all, raw.filter(Boolean), 1.5), byId = new Map(near.map((o) => [o.id, o]));
    const [A, B, D] = raw.map((x) => x && pushOut(x, near, rr));
    // the contact points are kept on their wood between ticks (piece-local), so they ride with it
    const live = (list) => list.filter((q) => byId.has(q.seg)).map((q) => ({ id: q.seg, x: sim.segToWorld(w.segs.get(q.seg), q.p, _e).toArray() }));
    const wa = hasA ? routeSpan(A, B, live(this.wrap[0]), near, byId, rr, iters) : [];
    const wb = routeSpan(B, D, live(this.wrap[1]), near, byId, rr, iters);
    const keep = (list) => list.map((q) => ({ seg: q.id, p: sim.segToLocal(w.segs.get(q.id), V(q.x)) }));
    this.wrap = [keep(wa), keep(wb)];
    const pts = [], segs = [];
    if (hasA) { pts.push(A); segs.push(r.anchor.chip ? -1 : r.anchor.seg); for (const q of wa) { pts.push(q.x); segs.push(q.id); } }
    const legs = pts.length;
    pts.push(B); segs.push(r.block.seg);
    for (const q of wb) { pts.push(q.x); segs.push(q.id); }
    pts.push(D); segs.push(r.device.seg);
    this.path = { pts, segs, legs };
  }
  cut() {
    if (this.fed()) { this.swallow('The rope was cut: the chipper took the rest'); return; }
    this.sim.emit({ t: 'rope', rope: { state: 0 } });
    this.sim.toast('The rope was cut!');
    this.reset();
  }

  /** The rope comes free while the chipper has it: whatever is left is pulled in and chipped. */
  swallow(msg) {
    const u = this.sim.chipper.fedUnit();
    this.sim.emit({ t: 'rope', rope: { state: 0 } });
    this.sim.toast(msg);
    this.reset();
    if (u) u.busy = 40;
  }

  /** Close enough to the friction device to take the tail: once a block is hung there is a tail to take (D117). */
  nearDevice(p) {
    const r = this.sim.world.rope;
    if (r.state < 1) return false;
    const t = p.body.translation();
    return this.node(r.device).distanceTo(_d.set(t.x, t.y, t.z)) < CFG.DEVICE_RANGE;
  }

  /** Ground worker on the tail (from the hung block on: with no knot tied yet there is just nothing on it). */
  operate(p, inp, pressed, dt) {
    if (this.sim.world.rope.state < 1) { this.holder = -1; p.mode = MODE.GROUND; return; }
    if (pressed.wrapUp) this.wraps = Math.min(CFG.WRAPS_MAX, this.wraps + 1);
    if (pressed.wrapDn) this.wraps = Math.max(0, this.wraps - 1);
    this.grip = 1 - inp.rt;
    if (this.sim.world.rope.state === 2 && inp.lt > 0.1 && this.T < CFG.HAUL_MAX) this.L0 = Math.max(1, this.L0 - inp.lt * CFG.HAUL_SPEED * dt);
  }

  pathLength() {
    if (!this.path) this.route(30);
    const P = this.path.pts;
    let s = 0;
    for (let i = 1; i < P.length; i++) s += Math.hypot(P[i][0] - P[i - 1][0], P[i][1] - P[i - 1][1], P[i][2] - P[i - 1][2]);
    return s;
  }

  step(dt) {
    const sim = this.sim, w = sim.world, r = w.rope;
    this.lastForce = null;
    this.route();
    if (r.state !== 2) { this.T = 0; this.run = 0; if (r.state < 1) this.holder = -1; return; }
    const s = this.pathLength();
    const fed = !!r.anchor.chip;
    if (fed && !sim.structure.isHeld(w.segs.get(r.block.seg).piece)) { this.swallow('The block\'s wood tore free: the chipper took the rope'); return; }
    if (fed && !sim.chipper.fedUnit().seized()) this.L0 = Math.max(0.3, this.L0 - CFG.CHIP_FEED_V * dt);     // the feed rollers reel it in (not while seized)
    let stretch = s - this.L0;
    const aSeg = fed ? null : w.segs.get(r.anchor.seg), aPiece = fed ? null : w.pieces.get(aSeg.piece);
    const m = fed ? sim.chipper.fedUnit().mass() : aPiece.fixed ? 500 : sim.bodies.get(aSeg.piece).mass();
    const k = Math.min(CFG.ROPE_EA / this.L0, CFG.ROPE_KCAP * m / (dt * dt));
    const c = 2 * CFG.ROPE_DAMP * Math.sqrt(k * m);
    let rate = (stretch - this.prev) / dt;
    let T = stretch > 0 ? Math.max(0, k * stretch + c * rate) : 0;
    if (fed && T > CFG.CHIP_PULL) {            // ...but slip on it past what they can pull
      this.L0 += (T - CFG.CHIP_PULL) / k; stretch = s - this.L0; T = CFG.CHIP_PULL;
    }
    this.prev = stretch;
    this.slack = -stretch;

    // friction device: capstan. Unattended = tied off.
    if (this.holder >= 0) {
      const cap = Math.max(5, CFG.GRIP_MAX * this.grip) * Math.exp(CFG.ROPE_MU * 2 * Math.PI * this.wraps);
      this.cap = cap;
      if (T > cap) {
        const v = Math.min(8, CFG.SLIP_V0 * (T / cap - 1));
        this.L0 += v * dt; this.run = v;
        T = Math.min(T, cap * (1 + v / CFG.SLIP_V0));
      } else this.run = 0;
    } else { this.cap = Infinity; this.run = 0; }
    this.T = T;
    if (T <= 0) return;
    if (T > CFG.ROPE_BREAK) {
      if (fed) { this.swallow('The rope snapped: the chipper took the rest'); return; }
      sim.emit({ t: 'rope', rope: { state: 0 } }); sim.toast('The rope snapped!'); this.reset(); return;
    }
    // every point of the path is pulled toward both its neighbours: the anchor toward the first wood the
    // rope touches, each contact and the block by both runs, the device up toward the last one
    const P = this.path.pts, S = this.path.segs, g = CFG.GRAVITY * CFG.ROPE_PUSH_G;
    for (let i = 0; i < P.length; i++) {
      const at = V(P[i]), f = new THREE.Vector3();
      if (i > 0) f.add(_a.set(P[i - 1][0] - at.x, P[i - 1][1] - at.y, P[i - 1][2] - at.z).normalize());
      if (i + 1 < P.length) f.add(_a.set(P[i + 1][0] - at.x, P[i + 1][1] - at.y, P[i + 1][2] - at.z).normalize());
      f.multiplyScalar(T);
      if (i === 0 && fed) { sim.chipper.fedUnit().body.applyImpulseAtPoint({ x: f.x * dt, y: f.y * dt, z: f.z * dt }, at, true); continue; }
      const seg = w.segs.get(S[i]); if (!seg) continue;
      const piece = w.pieces.get(seg.piece);
      if (i === 0 && !piece.fixed) this.lastForce = { piece: seg.piece, p: at, f: f.clone() };
      // rope pressing on some other loose wood shoves it no harder than ROPE_PUSH_G g (an explicit push on a light stick would fling it)
      if (i > 0 && !piece.fixed && seg.piece !== (aSeg && aSeg.piece)) { const cap = sim.bodies.get(seg.piece).mass() * g; if (f.length() > cap) f.setLength(cap); }
      sim.applyForce(seg.id, at, f);
    }
  }

  aux() {
    // the contact points over the wood, piece-local to mm: [leg (0 anchor-block, 1 block-device), seg, x, y, z]...
    const wr = [];
    this.wrap.forEach((list, leg) => { for (const q of list) wr.push(leg, q.seg, +q.p[0].toFixed(3), +q.p[1].toFixed(3), +q.p[2].toFixed(3)); });
    return { w: wr, fed: this.fed() ? 1 : 0, L0: +this.L0.toFixed(3), T: Math.round(this.T), wraps: this.wraps, holder: this.holder, slack: +(this.slack || 0).toFixed(2), run: +(this.run || 0).toFixed(2), grip: +(this.grip ?? 1).toFixed(2) };
  }
}
