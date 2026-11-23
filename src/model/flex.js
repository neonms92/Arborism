// How standing wood changes shape under load. Shared by host and clients; pure maths.
//
// fibres.analyse() gives every bundle a strain plane  eps = e0 + e1 x + e2 y:
// how much each of its fibres has stretched or shortened, as a fraction of its
// length. The fibres run the length L of their segment, from the disc at its
// base to the disc at its tip, so each fibre's change of length is eps * L, and
// the tip disc sits wherever those lengths put it:
//
//     moved along the stem by      e0 * L          (the fibres' mean change)
//     tilted by                    phi = (e2 u - e1 v) * L     (their differences)
//
// Severed fibres are not in the plane, so they have no say. Child segments grow
// from the tip disc, so tilts add up along the stem; and since loads are worked
// out on the tilted shape (structure.js), a tilt can feed itself.
//
// Each segment has an entry {phi, ext, base, tip}: base/tip are frames
// {q:[x,y,z,w], t:[x,y,z]} mapping undeflected piece-local coordinates to where
// that wood actually is:  p' = q p + t.  at(id, t) gives the frame of the
// cross-section a fraction t along the segment (the stem curves evenly between
// its discs). phi and ext follow their targets like a damped spring
// (FLEX_FREQ, FLEX_DAMP), so wood bounces when the load on it changes.
//
// Only rooted pieces deform. Wood that has just come away keeps its shape
// relative to its new body for a moment and relaxes straight ("loose" entries).

import { CFG } from '../config.js';
import { segAxis, segLen, lerp3 } from './world.js';
import { bundleBasis } from './fibres.js';

const MAX = 0.6;                               // rad per segment; anything near this has long since gone live
const IDENT = { q: [0, 0, 0, 1], t: [0, 0, 0] };

export class Flex {
  constructor(world) { this.world = world; this.st = new Map(); this.ver = 0; }

  clear() { this.st.clear(); this.ver++; }
  drop(segId) { this.st.delete(segId); }
  copy(from, to) {
    const e = this.st.get(from);
    if (e) this.st.set(to, { phi: [0, 0, 0], vel: [0, 0, 0], ext: 0, extV: 0, base: e.tip, tip: e.tip, ax: e.ax, L: e.L, a: e.a });
  }

  /** Frame of the cross-section a fraction t (0..1) along a segment, or null if that wood is where it was grown. */
  at(segId, t) {
    const e = this.st.get(segId); if (!e) return null;
    if (e.loose) return { q: nlerp(e.base.q, e.tip.q, t), t: lerp3(e.base.t, e.tip.t, t) };
    // even curvature from base to here: turned by t*phi about the stem centre at t, which has itself moved
    // along the stem by the fibres' mean stretch and sideways by the arc so far
    const r = quatFromVec([e.phi[0] * t, e.phi[1] * t, e.phi[2] * t]), ax = e.ax, L = e.L;
    const c = [e.a[0] + ax[0] * L * t, e.a[1] + ax[1] * L * t, e.a[2] + ax[2] * L * t], rc = rot(r, c);
    const side = cross(e.phi, ax), k = t * t * L / 2, m = e.ext * L * t;
    const d = [c[0] - rc[0] + ax[0] * m + side[0] * k, c[1] - rc[1] + ax[1] * m + side[1] * k, c[2] - rc[2] + ax[2] * m + side[2] * k];
    const bd = rot(e.base.q, d);
    return { q: qmul(e.base.q, r), t: [bd[0] + e.base.t[0], bd[1] + e.base.t[1], bd[2] + e.base.t[2]] };
  }
  /** One rigid frame for a whole segment (its middle), for things that need the segment as a solid. */
  frame(segId) { return this.at(segId, 0.5); }
  /**
   * The frame a body should start in when the wood beyond this segment's base bundle parts from it: the base
   * disc's frame, carried through the bundle's own tilt and stretch. Fibres across that bundle then start at
   * exactly the lengths they had.
   */
  joint(segId) {
    const e = this.st.get(segId); if (!e || e.loose) return null;
    const r = quatFromVec(e.phi), ra = rot(r, e.a), m = e.ext * e.L;
    const bd = rot(e.base.q, [e.a[0] - ra[0] + e.ax[0] * m, e.a[1] - ra[1] + e.ax[1] * m, e.a[2] - ra[2] + e.ax[2] * m]);
    return { q: qmul(e.base.q, r), t: [bd[0] + e.base.t[0], bd[1] + e.base.t[1], bd[2] + e.base.t[2]] };
  }

  /**
   * Wood that has just parted from the tree (segments ids; its new body starts at frame `root`) keeps the
   * shape it had relative to that body for a moment and relaxes straight, instead of snapping straight.
   */
  release(ids, root) {
    const iq = root ? [-root.q[0], -root.q[1], -root.q[2], root.q[3]] : null;
    const rel = (f) => (iq ? { q: qmul(iq, f.q), t: rot(iq, [f.t[0] - root.t[0], f.t[1] - root.t[1], f.t[2] - root.t[2]]) } : { q: f.q.slice(), t: f.t.slice() });
    const set = new Set(ids);
    for (const id of ids) { const e = this.st.get(id); if (e && !e.loose) { e.tip = rel(e.tip); e.loose = true; } }
    for (const id of ids) {
      const e = this.st.get(id); if (!e) continue;
      const s = this.world.segs.get(id), pe = s && set.has(s.parent) ? this.st.get(s.parent) : null;
      e.base = pe ? pe.tip : IDENT;                    // shares its parent's (fading) tip disc
    }
    this.ver++;
  }

  /** plane(seg) -> [e0, e1, e2], the bundle's strain plane, or null. */
  update(dt, plane) {
    const w = this.world, om = CFG.FLEX_FREQ, damp = 2 * CFG.FLEX_DAMP * om;
    const steps = Math.max(1, Math.ceil(dt * om / 0.25)), h = dt / steps;
    const seen = new Set(), fade = Math.exp(-dt * 5);
    let moved = 0;
    for (const [id, e] of this.st) {
      if (!e.loose) continue;
      seen.add(id);
      for (let k = 0; k < 3; k++) { e.tip.q[k] *= fade; e.tip.t[k] *= fade; }
      const n = Math.hypot(e.tip.q[0], e.tip.q[1], e.tip.q[2], e.tip.q[3]); for (let k = 0; k < 4; k++) e.tip.q[k] /= n;
      moved = 1;
      if (!w.segs.has(id) || (Math.abs(e.tip.q[3]) > 0.9999995 && Math.hypot(e.tip.t[0], e.tip.t[1], e.tip.t[2]) < 5e-4)) this.st.delete(id);
    }
    for (const piece of w.pieces.values()) {
      if (!piece.fixed) continue;
      for (const s of w.segsOf(piece.id)) {
        seen.add(s.id);
        let e = this.st.get(s.id);
        if (e && e.loose) e = null;
        if (!e) this.st.set(s.id, e = { phi: [0, 0, 0], vel: [0, 0, 0], ext: 0, extV: 0, base: IDENT, tip: IDENT });
        const L = segLen(s), ax = segAxis(s);
        e.ax = ax; e.L = L; e.a = s.a;
        const pl = plane(s), tg = [0, 0, 0];
        let tx = 0;
        if (pl) {
          const { u, v } = bundleBasis(ax);
          for (let k = 0; k < 3; k++) tg[k] = (pl[2] * u[k] - pl[1] * v[k]) * L;
          const m = Math.hypot(tg[0], tg[1], tg[2]);
          if (m > MAX) for (let k = 0; k < 3; k++) tg[k] *= MAX / m;
          tx = Math.max(-0.2, Math.min(0.2, pl[0]));
        }
        for (let n = 0; n < steps; n++) {
          for (let k = 0; k < 3; k++) {
            e.vel[k] += (om * om * (tg[k] - e.phi[k]) - damp * e.vel[k]) * h;
            const d = e.vel[k] * h; e.phi[k] += d; moved += Math.abs(d);
          }
          e.extV += (om * om * (tx - e.ext) - damp * e.extV) * h;
          const d = e.extV * h; e.ext += d; moved += Math.abs(d);
        }
        const pe = s.parent >= 0 ? this.st.get(s.parent) : null;
        // a child grows from its parent's tip, except the half of a lengthwise split, which hangs from its parent's base
        const ps = pe ? w.segs.get(s.parent) : null, atBase = ps && Math.abs(s.a[0] - ps.a[0]) + Math.abs(s.a[1] - ps.a[1]) + Math.abs(s.a[2] - ps.a[2]) < 1e-4;
        e.base = pe ? (atBase ? this.at(s.parent, 0) : pe.tip) : IDENT;
        e.tip = this.at(s.id, 1);
      }
    }
    for (const id of this.st.keys()) if (!seen.has(id)) { this.st.delete(id); moved = 1; }
    if (moved > 1e-7) this.ver++;                        // lets the view skip redrawing wood that has not moved
  }
}

export function frameApply(f, p) { if (!f) return [p[0], p[1], p[2]]; const r = rot(f.q, p); return [r[0] + f.t[0], r[1] + f.t[1], r[2] + f.t[2]]; }
export function frameDir(f, d) { return f ? rot(f.q, d) : [d[0], d[1], d[2]]; }
export function frameInverse(f, p) { if (!f) return [p[0], p[1], p[2]]; return rot([-f.q[0], -f.q[1], -f.q[2], f.q[3]], [p[0] - f.t[0], p[1] - f.t[1], p[2] - f.t[2]]); }

const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
function nlerp(a, b, t) {
  const s = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3] < 0 ? -1 : 1;
  const q = [a[0] + (b[0] * s - a[0]) * t, a[1] + (b[1] * s - a[1]) * t, a[2] + (b[2] * s - a[2]) * t, a[3] + (b[3] * s - a[3]) * t];
  const n = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  return [q[0] / n, q[1] / n, q[2] / n, q[3] / n];
}
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
