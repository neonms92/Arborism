// Bark and foliage geometry, built from the fibre bundles (DESIGN.md 3.5): for the pieces of wood the world model
// holds (view.js) and for the other trees in the yards before they have any (stands.js, from bundles made just to
// draw them). Also the orange X sprayed on the job tree, which is paint on its bark: it rides the bark as it bends,
// and goes where the bark goes (a kerf through it is a gap in it; a slab sawn off takes that part of it away).

import * as THREE from 'three';
import { segAxis, segLen, segParam, segRadius } from '../model/world.js';
import { bundleBasis, layout, CUT } from '../model/fibres.js';

const SIDES = 7, TAU = Math.PI * 2;
const PAINT = { H: 0.5, W: 0.42, LINE: 0.07, RGB: [1.0, 0.42, 0.04] };   // the X: m tall, m wide (round the bark), stroke width
const ico = new THREE.IcosahedronGeometry(1, 0).attributes.position;
// Width of every fibre box in a segment: one width all along, from the radius at its middle (a box cannot taper).
// The bark is fitted around this (woodInto), so the two must agree.
export const fibreWidth = (s) => (s.r0 + s.r1) / s.f.N * 0.82;

/** Is piece-local point c on segment s's axis (within a third of its radius)? */
function onSeg(s, c) {
  const t = segParam(s, c); if (t < 0 || t > 1) return false;
  const ax = segAxis(s), L = segLen(s), r = segRadius(s, t);
  const d = [c[0] - s.a[0] - ax[0] * t * L, c[1] - s.a[1] - ax[1] * t * L, c[2] - s.a[2] - ax[2] * t * L];
  return Math.hypot(d[0], d[1], d[2]) < r / 3;
}

/**
 * Bark (with its colours) and foliage for segments segs (piece-local). mark: the X ({c, n}, model/world.js), drawn
 * on whichever of these segments its centre is on. Returns {pos, col, lpos, barkSpan, leafSeg}:
 * bark: [seg id, first vertex, t0, t1] per quad; leaves: [seg id, first vertex, count] (for bending, view.js).
 */
export function woodInto(segs, mark = null) {
  let painted = false;
  const pos = [], col = [], lpos = [];
  const barkSpan = [], leafSeg = [];          // bark: [seg id, first vertex, t0, t1] per panel; leaves: [seg id, first vertex, count]
  for (const s of segs) {
    const start = pos.length / 3;
    const ax = segAxis(s), { u, v } = bundleBasis(ax), L = segLen(s), f = s.f, Ly = layout(f.N);
    // Bark panels. Each is owned by the outermost fibre behind it and covers only what is left of that fibre.
    const sides = Math.max(SIDES, Math.min(20, f.N + 3));
    // The bark is a polygon circumscribed about the fibre boxes as drawn: panel k lies on the line that just
    // touches them in its own direction (its middle angle), and its corners are where neighbouring panels'
    // lines meet. So no box corner can stick out between two corners of the bark, whatever the number of sides.
    // A face's line is mFace * R + (box half width) * kFace out: the fibre centres scale with the radius R,
    // but each box keeps one width all along (fibreWidth), so on a strongly tapering (thin) segment the boxes
    // stand out further at the thin end. Both are linear in z, so straight panels from end to end contain them.
    const w2 = fibreWidth(s) / 2, mFace = [], kFace = [], faceSpans = [];
    for (let k = 0; k < sides; k++) {
      const am = (k + 0.5) / sides * Math.PI * 2, c = Math.cos(am), sn = Math.sin(am);
      let m = 0; for (let i = 0; i < f.n; i++) { const d = Ly.X[i] * c + Ly.Y[i] * sn; if (d > m) m = d; }
      mFace.push(m); kFace.push(Math.abs(c) + Math.abs(sn));
    }
    const dl = Math.PI / sides, cd = Math.cos(dl), sd = Math.sin(dl);
    const at = (k, z) => {
      const R = s.r0 + (s.r1 - s.r0) * Math.min(1, Math.max(0, z / L)), k1 = (k + sides - 1) % sides, k2 = k % sides;
      const h1 = (mFace[k1] * R + w2 * kFace[k1]) * 1.03, h2 = (mFace[k2] * R + w2 * kFace[k2]) * 1.03;
      // corner k: where the lines of faces k-1 and k (normals at ang -/+ dl) meet
      const ang = k / sides * Math.PI * 2, a = (h1 + h2) / (2 * cd), b = (h2 - h1) / (2 * sd), ca = Math.cos(ang), sa = Math.sin(ang);
      const cx = a * ca - b * sa, sy = a * sa + b * ca;
      return [s.a[0] + ax[0] * z + u[0] * cx + v[0] * sy, s.a[1] + ax[1] * z + u[1] * cx + v[1] * sy, s.a[2] + ax[2] * z + u[2] * cx + v[2] * sy];
    };
    for (let k = 0; k < sides; k++) {
      const a0 = k / sides * Math.PI * 2, a1 = (k + 1) / sides * Math.PI * 2, am = (a0 + a1) / 2, cm = Math.cos(am), sm = Math.sin(am);
      let own = 0, best = -Infinity;
      for (let i = 0; i < f.n; i++) { const d = Ly.X[i] * cm + Ly.Y[i] * sm; if (d > best) { best = d; own = i; } }
      const lo = f.lo ? f.lo[own] : 0, hi = f.hi ? f.hi[own] : L;
      const spans = f.state[own] === CUT ? [[lo, f.zmin[own] - 0.008], [f.zmax[own] + 0.008, hi]] : [[lo, hi]];
      faceSpans.push(spans);
      for (const [z0, z1] of spans) {
        if (z1 - z0 < 0.004) continue;
        const p00 = at(k, z0), p10 = at(k + 1, z0), p01 = at(k, z1), p11 = at(k + 1, z1);
        barkSpan.push(s.id, pos.length / 3, z0 / L, z1 / L);
        pos.push(...p00, ...p10, ...p11, ...p00, ...p11, ...p01);
      }
    }
    const shade = 0.85 + ((s.id * 37) % 10) / 60;
    for (let i = start; i < pos.length / 3; i++) col.push(0.42 * shade, 0.31 * shade, 0.22 * shade);
    if (mark && !painted && onSeg(s, mark.c)) {
      painted = true;
      // out from the axis at angle ang (in the bundle's u, v) and z along it: the bark face there, a hair outside it
      const out = (ang, z) => {
        const R = s.r0 + (s.r1 - s.r0) * Math.min(1, Math.max(0, z / L)), a = ((ang % TAU) + TAU) % TAU, k = Math.min(sides - 1, Math.floor(a / TAU * sides));
        const h = (mFace[k] * R + w2 * kFace[k]) * 1.03 / Math.cos(a - (k + 0.5) / sides * TAU) + 0.006;
        const cx = Math.cos(a) * h, sy = Math.sin(a) * h;
        return [s.a[0] + ax[0] * z + u[0] * cx + v[0] * sy, s.a[1] + ax[1] * z + u[1] * cx + v[1] * sy, s.a[2] + ax[2] * z + u[2] * cx + v[2] * sy];
      };
      // ...only where the bark still is (the fibre that owns that face is there over the whole quad)
      const bare = (ang, z0, z1) => {
        const a = ((ang % TAU) + TAU) % TAU, k = Math.min(sides - 1, Math.floor(a / TAU * sides));
        // (a span that reaches an end of this segment carries on into the next one, as far as this is concerned)
        return !faceSpans[k].some(([lo, hi]) => (lo <= 1e-6 || z0 >= lo) && (hi >= L - 1e-6 || z1 <= hi));
      };
      const zc = segParam(s, mark.c) * L, n = mark.n;
      const a0 = Math.atan2(n[0] * v[0] + n[1] * v[1] + n[2] * v[2], n[0] * u[0] + n[1] * u[1] + n[2] * u[2]);
      const R0 = s.r0 + (s.r1 - s.r0) * Math.min(1, Math.max(0, zc / L));
      const HZ = PAINT.H / 2, HA = Math.min(PAINT.W / 2, R0 * 1.1), WW = PAINT.LINE / 2, NQ = 8;
      const sl = Math.hypot(HZ, HA), pz = HA / sl, pa = HZ / sl;      // across the stroke, in (z, arc)
      for (const sg of [1, -1]) {
        const pt = (j, e) => { const t = -1 + 2 * j / NQ, z = zc + t * HZ + e * -sg * pz * WW, arc = sg * t * HA + e * pa * WW; return [z, a0 + arc / R0]; };
        for (let j = 0; j < NQ; j++) {
          const [z00, g00] = pt(j, -1), [z10, g10] = pt(j, 1), [z01, g01] = pt(j + 1, -1), [z11, g11] = pt(j + 1, 1);
          const zl = Math.min(z00, z10, z01, z11), zh = Math.max(z00, z10, z01, z11);
          if (bare((g00 + g11) / 2, zl, zh)) continue;
          const first = pos.length / 3;
          barkSpan.push(s.id, first, Math.min(1, Math.max(0, (z00 + z10) / 2 / L)), Math.min(1, Math.max(0, (z01 + z11) / 2 / L)));
          pos.push(...out(g00, z00), ...out(g10, z10), ...out(g11, z11), ...out(g00, z00), ...out(g11, z11), ...out(g01, z01));
          const sh = 0.9 + 0.1 * Math.sin(j * 2.7 + sg);                // uneven, as sprayed
          for (let q = 0; q < 6; q++) col.push(PAINT.RGB[0] * sh, PAINT.RGB[1] * sh, PAINT.RGB[2] * sh);
        }
      }
    }
    if (s.leaf > 0) {
      const r = 0.3 + s.leaf * 0.18;
      leafSeg.push(s.id, lpos.length / 3, ico.count);
      for (let i = 0; i < ico.count; i++) lpos.push(s.b[0] + ico.getX(i) * r, s.b[1] + ico.getY(i) * r * 0.8, s.b[2] + ico.getZ(i) * r);
    }
  }
  return { pos, col, lpos, barkSpan, leafSeg };
}
