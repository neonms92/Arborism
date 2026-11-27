// A joined client predicts its own climber (D103). The host stays in charge: this only changes where
// the client draws itself (and so its camera), sooner than the host's answer could arrive.
//
// Every frame the client keeps the stick it used, tagged with the number of the input packet that will
// carry it. The host's aux says where the climber is (seg, t, side, end stop) and the newest input number
// it has used. The prediction is that host state with the newer frames replayed through the same rule the
// host runs (model/climb.js). A correction (the host disagreeing) is not shown as a jump: the difference
// is kept as an offset that fades out over about a tenth of a second.
// Only climbing on held wood is predicted; walking, the rope, riding a falling piece stay as they were.

import { CFG, INJ, MODE } from '../config.js';
import { climbMove, climbSign, jointLink } from '../model/climb.js';
import { lerp3, segAxis, segRadius } from '../model/world.js';
import { frameApply, frameDir } from '../model/flex.js';
import { groundY } from '../model/terrain.js';

const HIST = 240;            // frames kept (4 s at 60 fps): more than any useful round trip

export class ClimbPredict {
  constructor(world) {
    this.world = world; this.hist = [];
    this.base = null; this.baseKey = '';     // host's climber state from the latest aux
    this.off = [0, 0, 0]; this.last = null;   // fading correction; last predicted position
    this.cl = null; this.pos = null;          // this frame's prediction
  }

  /**
   * Call once a frame on a client, after input.poll. n = number of the input packet that will carry this
   * frame's stick (the next one sent). a = this player's aux entry. pieceTf(id) -> {p, q} | null.
   * flex: the view's flex (bending) of standing wood, or null.
   */
  frame(dt, inp, n, a, pieceTf, flex, live = null) {
    this.link = live && live.length ? jointLink(live.map((l) => [l.seg, l.stub])) : null;   // cracked wood held by fibres (D127)
    this.hist.push({ n, my: inp.my, mx: inp.mx, yaw: inp.yaw, dt });
    if (this.hist.length > HIST) this.hist.shift();
    const ok = CFG.PREDICT && a && a.m === MODE.CLIMB && Array.isArray(a.cl) && !a.cl[5] && a.inj < INJ.DOWN && !a.sk;
    if (!ok) { this.cl = this.pos = this.last = null; this.off = [0, 0, 0]; return; }
    const key = a.cl[0] + ':' + a.cl[1] + ':' + a.n + ':' + a.cl[2];
    const fresh = key !== this.baseKey;
    this.base = { cl: a.cl, ack: a.n || 0 }; this.baseKey = key;

    const ctx = { pieceTf, flex };
    const cl = this.replay(ctx); if (!cl) { this.cl = this.pos = null; return; }
    const pos = this.place(cl, ctx); if (!pos) { this.cl = this.pos = null; return; }
    // a new word from the host moved the prediction: keep showing where we were and fade the difference
    if (fresh && this.last) for (let i = 0; i < 3; i++) this.off[i] += this.last[i] - pos[i];
    const k = Math.exp(-dt * CFG.PREDICT_BLEND);
    for (let i = 0; i < 3; i++) this.off[i] *= k;
    if (Math.hypot(...this.off) > 1) this.off = [0, 0, 0];   // too far out: just go there
    this.last = pos;
    this.cl = cl;
    this.pos = [pos[0] + this.off[0], pos[1] + this.off[1], pos[2] + this.off[2]];
  }

  /** The host's climber, then every frame the host has not seen yet, through the host's own rule. */
  replay(ctx) {
    const b = this.base.cl, w = this.world;
    const cl = { seg: b[0], t: b[1], side: b[2].slice(), end: b[3] || 0, armed: !!b[4] };
    if (!w.segs.has(cl.seg)) return null;
    for (const h of this.hist) {
      if (h.n <= this.base.ack) continue;
      const s = w.segs.get(cl.seg); if (!s) return null;
      const ax = this.dir(s, segAxis(s), ctx);
      const r = climbMove(w, cl, h.my, h.mx, climbSign(ax, h.yaw), h.dt, (rs) => {
        const p = this.point(rs, rs.a, 0, ctx); return p ? p[1] < groundY(w.terrain, p[0], p[2]) + 0.6 : true;
      }, this.link);
      if (r.out) break;            // landing or climbing off: the host decides; stay put until it does
    }
    return cl;
  }

  place(cl, ctx) {
    const s = this.world.segs.get(cl.seg); if (!s) return null;
    const c = lerp3(s.a, s.b, cl.t), d = segRadius(s, cl.t) + CFG.STANDOFF;
    return this.point(s, [c[0] + cl.side[0] * d, c[1] + cl.side[1] * d, c[2] + cl.side[2] * d], cl.t, ctx);
  }

  /** A piece-local point on segment s (at fraction t along it) to world, bent like the view draws it. */
  point(s, p, t, ctx) {
    const f = ctx.flex ? ctx.flex.at(s.id, Math.min(1, Math.max(0, t))) : null;
    const q = frameApply(f, p);
    const piece = this.world.pieces.get(s.piece); if (!piece) return null;
    if (piece.fixed) return q;                         // rooted pieces sit at the origin, unrotated
    const tf = ctx.pieceTf(s.piece); if (!tf) return null;
    const r = rotq(tf.q, q); return [r[0] + tf.p.x, r[1] + tf.p.y, r[2] + tf.p.z];
  }
  dir(s, d, ctx) {
    const f = ctx.flex ? ctx.flex.at(s.id, 0.5) : null, q = frameDir(f, d);
    const piece = this.world.pieces.get(s.piece);
    if (!piece || piece.fixed) return q;
    const tf = ctx.pieceTf(s.piece); return tf ? rotq(tf.q, q) : q;
  }

  /** The aux entry with the predicted climber in place of the host's (the lanyard is drawn from it). */
  patch(a) {
    if (!this.cl || !a) return a;
    return { ...a, cl: [this.cl.seg, this.cl.t, this.cl.side, this.cl.end, this.cl.armed ? 1 : 0, 0] };
  }
}

function rotq(q, v) {
  const x = v[0], y = v[1], z = v[2], qx = q.x, qy = q.y, qz = q.z, qw = q.w;
  const ix = qw * x + qy * z - qz * y, iy = qw * y + qz * x - qx * z, iz = qw * z + qx * y - qy * x, iw = -qx * x - qy * y - qz * z;
  return [ix * qw + iw * -qx + iy * -qz - iz * -qy, iy * qw + iw * -qy + iz * -qx - ix * -qz, iz * qw + iw * -qz + ix * -qy - iy * -qx];
}
