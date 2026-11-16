// Elastic bending of standing wood. Shared by host and clients; pure maths.
//
// A stiff bundle (DESIGN.md 3.2) carries a stress plane  s = c0 + s1 x + s2 y.
// Its fibres are springs that reach MOR at FIBRE_YIELD of stretch, so that
// plane IS a tilt of the bundle's far face relative to its near face:
//
//     phi = (s2 u - s1 v) * FIBRE_YIELD / MOR        (a rotation vector, rad)
//
// - the same angle the live-regime springs (3.3) would settle at under the
// same load, which is why a bundle can go live without a jolt.
// Each segment is hinged at its base by its bundle's phi; the tilts add up
// along the stem, so a loaded limb droops most at its tip. phi follows its
// target like a damped spring (FLEX_FREQ, FLEX_DAMP), so wood bounces when the
// load on it changes.
//
// A frame {q:[x,y,z,w], t:[x,y,z]} maps a segment's undeflected piece-local
// coordinates to where that wood actually is (still piece-local):  p' = q p + t.
// Only rooted pieces flex; wood that has just come away relaxes to no frame
// (identity) over a fraction of a second.

import { CFG } from '../config.js';
import { segAxis } from './world.js';
import { bundleBasis } from './fibres.js';

const MAX = 0.6;   // rad per joint; anything near this has long since gone live

export class Flex {
  constructor(world) { this.world = world; this.st = new Map(); }   // seg id -> {phi, vel, q, t}

  frame(segId) { return this.st.get(segId) || null; }
  drop(segId) { this.st.delete(segId); }
  copy(from, to) { const e = this.st.get(from); if (e) this.st.set(to, { phi: [0, 0, 0], vel: [0, 0, 0], q: e.q.slice(), t: e.t.slice() }); }

  /**
   * Wood that has just parted from the tree (segments ids, whose new body starts at root frame `root`) keeps
   * the bend it had relative to its root for a moment and relaxes straight, instead of snapping straight.
   */
  release(ids, root) {
    const iq = root ? [-root.q[0], -root.q[1], -root.q[2], root.q[3]] : null;
    for (const id of ids) {
      const e = this.st.get(id); if (!e) continue;
      if (iq) { e.q = qmul(iq, e.q); e.t = rot(iq, [e.t[0] - root.t[0], e.t[1] - root.t[1], e.t[2] - root.t[2]]); }
      e.loose = true;
    }
  }

  /** plane(seg) -> [s1, s2] (Pa per metre across the bundle) or null. */
  update(dt, plane) {
    const w = this.world, gain = CFG.FIBRE_YIELD / CFG.MOR, om = CFG.FLEX_FREQ, damp = 2 * CFG.FLEX_DAMP * om;
    const steps = Math.max(1, Math.ceil(dt * om / 0.25)), h = dt / steps;
    const seen = new Set(), fade = Math.exp(-dt * 5);
    for (const [id, e] of this.st) {
      if (!e.loose) continue;
      seen.add(id);
      for (let k = 0; k < 3; k++) { e.q[k] *= fade; e.t[k] *= fade; }
      const n = Math.hypot(e.q[0], e.q[1], e.q[2], e.q[3]); for (let k = 0; k < 4; k++) e.q[k] /= n;
      if (!this.world.segs.has(id) || Math.abs(e.q[3]) > 0.9999995 && Math.hypot(e.t[0], e.t[1], e.t[2]) < 5e-4) this.st.delete(id);
    }
    for (const piece of w.pieces.values()) {
      if (!piece.fixed) continue;
      for (const s of w.segsOf(piece.id)) {
        seen.add(s.id);
        let e = this.st.get(s.id);
        if (e && e.loose) e = null;
        if (!e) this.st.set(s.id, e = { phi: [0, 0, 0], vel: [0, 0, 0], q: [0, 0, 0, 1], t: [0, 0, 0] });
        const pl = plane(s), tg = [0, 0, 0];
        if (pl) {
          const { u, v } = bundleBasis(segAxis(s));
          for (let k = 0; k < 3; k++) tg[k] = (pl[1] * u[k] - pl[0] * v[k]) * gain;
          const m = Math.hypot(tg[0], tg[1], tg[2]);
          if (m > MAX) for (let k = 0; k < 3; k++) tg[k] *= MAX / m;
        }
        for (let n = 0; n < steps; n++) for (let k = 0; k < 3; k++) {
          e.vel[k] += (om * om * (tg[k] - e.phi[k]) - damp * e.vel[k]) * h;
          e.phi[k] += e.vel[k] * h;
        }
        // this segment's frame = parent's frame, then a turn of phi about this segment's base
        const r = quatFromVec(e.phi), pf = s.parent >= 0 ? this.st.get(s.parent) : null;
        const ra = rot(r, s.a), d = [s.a[0] - ra[0], s.a[1] - ra[1], s.a[2] - ra[2]];
        if (pf) { e.q = qmul(pf.q, r); const pd = rot(pf.q, d); e.t = [pd[0] + pf.t[0], pd[1] + pf.t[1], pd[2] + pf.t[2]]; }
        else { e.q = r; e.t = d; }
      }
    }
    for (const id of this.st.keys()) if (!seen.has(id)) this.st.delete(id);
  }
}

export function frameApply(f, p) { if (!f) return [p[0], p[1], p[2]]; const r = rot(f.q, p); return [r[0] + f.t[0], r[1] + f.t[1], r[2] + f.t[2]]; }
export function frameDir(f, d) { return f ? rot(f.q, d) : [d[0], d[1], d[2]]; }
export function frameInverse(f, p) { if (!f) return [p[0], p[1], p[2]]; return rot([-f.q[0], -f.q[1], -f.q[2], f.q[3]], [p[0] - f.t[0], p[1] - f.t[1], p[2] - f.t[2]]); }

function quatFromVec(v) {
  const a = Math.hypot(v[0], v[1], v[2]);
  if (a < 1e-9) return [0, 0, 0, 1];
  const s = Math.sin(a / 2) / a;
  return [v[0] * s, v[1] * s, v[2] * s, Math.cos(a / 2)];
}
function qmul(a, b) {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
}
function rot(q, v) {   // v + 2 qv x (qv x v + w v)
  const x = q[0], y = q[1], z = q[2], w = q[3];
  const cx = y * v[2] - z * v[1] + w * v[0], cy = z * v[0] - x * v[2] + w * v[1], cz = x * v[1] - y * v[0] + w * v[2];
  return [v[0] + 2 * (y * cz - z * cy), v[1] + 2 * (z * cx - x * cz), v[2] + 2 * (x * cy - y * cx)];
}
