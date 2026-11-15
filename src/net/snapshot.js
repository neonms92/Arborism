// Binary transform snapshots (host -> clients) and client-side interpolation.
// Layout: u8 type(1) | u8 full | u32 tick | u16 count | count * (u16 id, f32 x,y,z, i16 qx,qy,qz,qw)
// See docs/DESIGN.md 2.2, 2.3.

import { CFG } from '../config.js';

const REC = 22;

export function encodeSnapshot(sim, full) {
  const recs = [];
  sim.eachBody((id, p, q, awake) => { if (full || awake) recs.push(id, p.x, p.y, p.z, q.x, q.y, q.z, q.w); });
  const n = recs.length / 8, buf = new ArrayBuffer(8 + n * REC), dv = new DataView(buf);
  dv.setUint8(0, 1); dv.setUint8(1, full ? 1 : 0); dv.setUint32(2, sim.tick, true); dv.setUint16(6, n, true);
  for (let i = 0, o = 8; i < n; i++, o += REC) {
    const r = i * 8;
    dv.setUint16(o, recs[r], true);
    dv.setFloat32(o + 2, recs[r + 1], true); dv.setFloat32(o + 6, recs[r + 2], true); dv.setFloat32(o + 10, recs[r + 3], true);
    for (let j = 0; j < 4; j++) dv.setInt16(o + 14 + j * 2, Math.round(recs[r + 4 + j] * 32767), true);
  }
  return buf;
}

/** Client transform source: buffers samples per body and interpolates at hostTime - delay. */
export class Interp {
  constructor() { this.bodies = new Map(); this.lastTick = -1; this.off = -Infinity; this.rt = 0; }

  push(buf) {
    const dv = new DataView(buf);
    if (dv.getUint8(0) !== 1) return;
    const tick = dv.getUint32(2, true), n = dv.getUint16(6, true);
    if (tick <= this.lastTick) return;                 // stale / out of order
    this.lastTick = tick;
    const t = tick * CFG.TICK, off = t - performance.now() / 1000;
    this.off = Math.max(off, this.off - 0.0005);       // track the least-delayed packet
    for (let i = 0, o = 8; i < n; i++, o += REC) {
      const id = dv.getUint16(o, true);
      let b = this.bodies.get(id); if (!b) this.bodies.set(id, b = []);
      b.push({
        t, p: { x: dv.getFloat32(o + 2, true), y: dv.getFloat32(o + 6, true), z: dv.getFloat32(o + 10, true) },
        q: { x: dv.getInt16(o + 14, true) / 32767, y: dv.getInt16(o + 16, true) / 32767, z: dv.getInt16(o + 18, true) / 32767, w: dv.getInt16(o + 20, true) / 32767 },
      });
      if (b.length > 10) b.shift();
    }
  }

  advance() { this.rt = performance.now() / 1000 + this.off - CFG.INTERP_DELAY; }
  drop(id) { this.bodies.delete(id); }

  pose(id) {
    const b = this.bodies.get(id); if (!b || !b.length) return null;
    const rt = this.rt;
    let i = b.length - 1;
    while (i > 0 && b[i].t > rt) i--;
    const a = b[i], c = b[i + 1];
    if (!c || rt <= a.t) return a;
    // a body that was asleep: hold the old sample until just before the new one
    const t0 = c.t - a.t > 0.2 ? c.t - 0.05 : a.t;
    const k = Math.max(0, Math.min(1, (rt - t0) / (c.t - t0)));
    if (k <= 0) return a;
    let d = a.q.x * c.q.x + a.q.y * c.q.y + a.q.z * c.q.z + a.q.w * c.q.w; const s = d < 0 ? -1 : 1;
    const q = { x: a.q.x + (c.q.x * s - a.q.x) * k, y: a.q.y + (c.q.y * s - a.q.y) * k, z: a.q.z + (c.q.z * s - a.q.z) * k, w: a.q.w + (c.q.w * s - a.q.w) * k };
    const l = Math.hypot(q.x, q.y, q.z, q.w) || 1; q.x /= l; q.y /= l; q.z /= l; q.w /= l;
    return { p: { x: a.p.x + (c.p.x - a.p.x) * k, y: a.p.y + (c.p.y - a.p.y) * k, z: a.p.z + (c.p.z - a.p.z) * k }, q };
  }
}
