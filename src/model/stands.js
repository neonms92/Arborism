// The other trees in the yards ("stands"). Pure data and pure functions.
//
// The yard plan (model/yards.js) puts trees in the lots round the job tree. Until someone saws or climbs one it
// has no wood in the model at all: world.stands holds only where it stands and its shape, every machine grows
// the same skeleton from those numbers to draw it (view/stands.js), and the host gives it nothing but a trunk to
// bump into and to look at (sim/stands.js). The moment a player starts sawing or climbing one, the host grows its
// wood for real with the same numbers and a wider fibre (YARD_TREES_PITCH, fewer fibres for the same wood), as an
// ordinary rooted tree: a 'tree' event with `stand` set to its index. From then on it is wood like the job tree.
//
// world.stands = {g: shared shape {dens, blen, sl, cap, pitch}, list: [{x, y, z, seed, h, d, piece, k}]}
// (y: the trunk's base; piece: 0 while dormant, else the rooted piece it became; k: 1 for a utility pole, a
// straight trunk with no branches whose segments are marked pl (no spurs go into it), model/lines.js)

import { generateTree } from './treegen.js';
import { gridFor } from './fibres.js';

/** The shape generateTree grows stand i from. */
export function standShape(stands, st) { return { ...stands.g, h: st.h, d: st.d }; }

/** Stand st's segments (ids from newId), at its place in the world: the same on every machine. */
export function standSegs(stands, st, newId) {
  if (st.k === 1) return poleSegs(st, newId, stands.g.pitch);
  return generateTree(st.seed, newId, [st.x, st.y, st.z], standShape(stands, st));
}

/** A utility pole: a straight round trunk h tall, d across at its base, two thirds of that at its top. */
export function poleSegs(st, newId, pitch) {
  const n = Math.max(2, Math.ceil(st.h / 1.5)), out = [], r0 = st.d / 2, r1 = st.d / 3;
  for (let i = 0; i < n; i++) {
    const ra = r0 + (r1 - r0) * i / n, rb = r0 + (r1 - r0) * (i + 1) / n;
    out.push({ id: newId(), parent: i ? out[i - 1].id : -1, a: [st.x, st.y + st.h * i / n, st.z], b: [st.x, st.y + st.h * (i + 1) / n, st.z],
      r0: ra, r1: rb, leaf: 0, N: gridFor(ra, pitch), pl: 1 });
  }
  return out;
}

/** The trunk of a skeleton (generateTree puts it first, base to top): the segments while each starts where the last ended. */
export function trunkOf(segs) {
  const out = [segs[0]];
  for (let i = 1; i < segs.length && segs[i].parent === out[out.length - 1].id; i++) out.push(segs[i]);
  return out;
}

/**
 * Where to spray the X on a tree: the trunk segment whose middle is nearest `h` m above the base, its axis point
 * there (c) and the unit direction out from the axis, square to it, nearest `toward` ([x, z], horizontal) (n).
 */
export function markOn(segs, h, toward) {
  const tr = trunkOf(segs), y0 = tr[0].a[1];
  let best = tr[0], bd = Infinity;
  for (const s of tr) { const d = Math.abs((s.a[1] + s.b[1]) / 2 - y0 - h); if (d < bd) { bd = d; best = s; } }
  const c = best.a.map((v, k) => (v + best.b[k]) / 2), ax = best.b.map((v, k) => v - best.a[k]);
  const al = Math.hypot(...ax); for (let k = 0; k < 3; k++) ax[k] /= al;
  const t = [toward[0], 0, toward[1]], d = t[0] * ax[0] + t[2] * ax[2];
  const n = [t[0] - ax[0] * d, -ax[1] * d, t[2] - ax[2] * d], nl = Math.hypot(...n) || 1;
  return { c: c.map((v) => +v.toFixed(4)), n: n.map((v) => +(v / nl).toFixed(4)) };
}
