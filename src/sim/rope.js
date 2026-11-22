// The rigging line: a tension path  anchor -> block -> device -> tail.
// Host only. Layout lives in world.rope (changed via 'rope' events); the
// scalars here (L0, tension, wraps, holder) go out in aux packets.
// See docs/DESIGN.md section 5.

import * as THREE from 'three';
import { CFG, MODE } from '../config.js';
import { segRadius, segParam, lerp3, segAxis } from '../model/world.js';

const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _d = new THREE.Vector3();

export class Rope {
  constructor(sim) { this.sim = sim; this.reset(); }
  reset() { this.L0 = 0; this.T = 0; this.wraps = 2; this.holder = -1; this.prev = 0; this.lastForce = null; this.slack = 0; }

  node(n) { return this.sim.segToWorld(this.sim.world.segs.get(n.seg), n.p); }

  // ---- placing ({rig}: block, then tie, then untie at the knot) ----
  target(p, aim) {
    if (!aim || aim.dist > CFG.REACH) return null;
    const sim = this.sim, s = sim.world.segs.get(aim.seg);
    const loc = sim.segToLocal(s, aim.point);
    return { seg: s.id, p: loc, fixed: sim.world.pieces.get(s.piece).fixed, point: aim.point };
  }
  prompt(p, aim) {
    const st = this.sim.world.rope.state, t = this.target(p, aim);
    if (st === 0) return t && t.fixed ? '{rig}: hang the rigging block here' : '';
    const down = p.mode === MODE.GROUND ? '   {drop}: take the block down' : '';
    if (st === 1) return (t ? '{rig}: tie the rope here' : 'Look at the wood to tie the rope to') + down;
    if (t && this.node(this.sim.world.rope.anchor).distanceTo(t.point) < 0.7) return '{rig}: untie';
    return '';
  }
  place(p, aim) {
    const sim = this.sim, w = sim.world, r = w.rope, t = this.target(p, aim);
    if (!t) return;
    if (r.state === 0) {
      if (!t.fixed) return;
      // friction device: on the root segment of the same piece, about 1 m up
      const root = w.segsOf(w.segs.get(t.seg).piece)[0];
      const c = lerp3(root.a, root.b, Math.min(0.9, 1 / Math.max(0.5, root.b[1] - root.a[1])));
      const dev = { seg: root.id, p: [c[0] + segRadius(root, 0.5) + 0.05, c[1], c[2]] };
      sim.emit({ t: 'rope', rope: { state: 1, block: { seg: t.seg, p: t.p }, device: dev } });
    } else if (r.state === 1) {
      sim.emit({ t: 'rope', rope: { ...r, state: 2, anchor: { seg: t.seg, p: t.p } } });
      this.L0 = this.pathLength() + 0.15; this.prev = 0; this.T = 0;
    } else if (this.node(r.anchor).distanceTo(t.point) < 0.7) {
      sim.emit({ t: 'rope', rope: { state: 1, block: r.block, device: r.device } });
      this.T = 0;
    }
  }
  clear(p) {
    if (this.sim.world.rope.state === 1) this.sim.emit({ t: 'rope', rope: { state: 0 } });
  }

  /** Straight runs of rope in the world, for anything that can cut it. */
  spans() {
    const r = this.sim.world.rope, out = [];
    if (r.state >= 2) out.push([this.node(r.anchor), this.node(r.block)]);
    if (r.state >= 1) out.push([this.node(r.block), this.node(r.device)]);
    return out;
  }
  cut() {
    this.sim.emit({ t: 'rope', rope: { state: 0 } });
    this.sim.toast('The rope was cut!');
    this.reset();
  }

  nearDevice(p) {
    const r = this.sim.world.rope;
    if (r.state !== 2) return false;
    const t = p.body.translation();
    return this.node(r.device).distanceTo(_d.set(t.x, t.y, t.z)) < CFG.DEVICE_RANGE;
  }

  /** Ground worker on the tail. */
  operate(p, inp, pressed, dt) {
    if (this.sim.world.rope.state !== 2) { this.holder = -1; p.mode = MODE.GROUND; return; }
    if (pressed.wrapUp) this.wraps = Math.min(CFG.WRAPS_MAX, this.wraps + 1);
    if (pressed.wrapDn) this.wraps = Math.max(0, this.wraps - 1);
    this.grip = 1 - inp.rt;
    if (inp.lt > 0.1 && this.T < CFG.HAUL_MAX) this.L0 = Math.max(1, this.L0 - inp.lt * CFG.HAUL_SPEED * dt);
  }

  pathLength() {
    const r = this.sim.world.rope;
    const a = this.node(r.anchor).clone(), b = this.node(r.block).clone(), d = this.node(r.device);
    return a.distanceTo(b) + b.distanceTo(d);
  }

  step(dt) {
    const sim = this.sim, w = sim.world, r = w.rope;
    this.lastForce = null;
    if (r.state !== 2) { this.T = 0; this.holder = -1; return; }
    const pa = this.node(r.anchor).clone(), pb = this.node(r.block).clone(), pd = this.node(r.device).clone();
    const s = pa.distanceTo(pb) + pb.distanceTo(pd);
    const stretch = s - this.L0;
    this.slack = -stretch;
    const aSeg = w.segs.get(r.anchor.seg), aPiece = w.pieces.get(aSeg.piece);
    const m = aPiece.fixed ? 500 : sim.bodies.get(aSeg.piece).mass();
    const k = Math.min(CFG.ROPE_EA / this.L0, CFG.ROPE_KCAP * m / (dt * dt));
    const c = 2 * CFG.ROPE_DAMP * Math.sqrt(k * m);
    const rate = (stretch - this.prev) / dt; this.prev = stretch;
    let T = stretch > 0 ? Math.max(0, k * stretch + c * rate) : 0;

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
      sim.emit({ t: 'rope', rope: { state: 0 } }); sim.toast('The rope snapped!'); this.reset(); return;
    }
    // anchor: pulled toward the block
    const fa = _a.copy(pb).sub(pa).normalize().multiplyScalar(T);
    sim.applyForce(r.anchor.seg, pa, fa);
    if (!aPiece.fixed) this.lastForce = { piece: aSeg.piece, p: pa, f: fa.clone() };
    // block: both legs pull on it
    const fb = _b.copy(pa).sub(pb).normalize().add(_d.copy(pd).sub(pb).normalize()).multiplyScalar(T);
    sim.applyForce(r.block.seg, pb, fb);
    // device: pulled toward the block
    sim.applyForce(r.device.seg, pd, _a.copy(pb).sub(pd).normalize().multiplyScalar(T));
  }

  aux() {
    return { L0: +this.L0.toFixed(3), T: Math.round(this.T), wraps: this.wraps, holder: this.holder, slack: +(this.slack || 0).toFixed(2), run: +(this.run || 0).toFixed(2), grip: +(this.grip ?? 1).toFixed(2) };
  }
}
