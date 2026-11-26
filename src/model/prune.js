// Pruning at planting (D113): a tree grows wherever its lot puts it, and any branch that would grow into
// something solid is not there. Pure functions.
//
// The obstacles are what stands in the neighbourhood when the trees are planted: every module of every build
// (houses, sheds, fences) as the boxes it collides as (model/builds.js modProxies), the power lines hanging at
// rest, the trunks of the other trees and the poles, and the ground. A segment that is not on its tree's trunk
// and comes within its own radius of one of them is cut off, with everything that grows from it. A trunk is
// never cut (the yard plan keeps trunks clear: model/yards.js).
//
// The job tree is pruned on the host before its 'tree' event, so its segments simply are not there. A yard
// tree (model/stands.js) is grown from its numbers on every machine, so its cuts travel in a 'prune' event:
// stand.cut = indices (in generateTree's order) of the segments where a cut starts.

import { compose, qrot, modProxies } from './builds.js';
import { endRest, restNodes } from './lines.js';
import { groundY } from './terrain.js';
import { standSegs, trunkOf } from './stands.js';

const CELL = 4;               // m: the grid the obstacles are bucketed in (x, z)
const LINE_R = 0.03;          // m: a power line's radius, for this test
const STEP = 0.15;            // m between the points sampled along a segment

/**
 * The obstacles in world (its builds, lines and stands), plus `extra` rods [{a, b, r, own}].
 * Returns {boxes, rods, terrain, grid}: a box is {c, q, h, lo, hi} (lo/hi its world bounds), a rod {a, b, r, own,
 * lo, hi} (own: whose trunk it is, so a tree is not pruned by its own trunk: a stand index, or 'job').
 */
export function obstacles(world, extra = []) {
  const boxes = [], rods = [];
  for (const b of world.builds || []) for (const m of b.mods) {
    if (m.ids) continue;                                    // broken: its parts are loose
    for (const pt of modProxies(m)) {
      const f = compose(m.p, m.q, pt.c, pt.q), g = compose(b.p, b.q, f.p, f.q);
      const ext = [0, 1, 2].map((k) => Math.abs(qrot(g.q, [pt.h[0], 0, 0])[k]) + Math.abs(qrot(g.q, [0, pt.h[1], 0])[k]) + Math.abs(qrot(g.q, [0, 0, pt.h[2]])[k]));
      boxes.push({ c: g.p, q: g.q, h: pt.h, lo: g.p.map((v, k) => v - ext[k]), hi: g.p.map((v, k) => v + ext[k]) });
    }
  }
  const rod = (a, b, r, own) => rods.push({ a, b, r, own, lo: a.map((v, k) => Math.min(v, b[k]) - r), hi: a.map((v, k) => Math.max(v, b[k]) + r) });
  if (world.lines) for (const L of world.lines.list) {
    const x = restNodes(endRest(world, L.a), endRest(world, L.b), L.L0, L.n);
    for (let k = 0; k < L.n; k++) rod([x[3 * k], x[3 * k + 1], x[3 * k + 2]], [x[3 * k + 3], x[3 * k + 4], x[3 * k + 5]], LINE_R, -1);
  }
  if (world.stands) world.stands.list.forEach((s, i) => {
    if (s.piece) return;
    let n = 0;
    for (const g of trunkOf(standSegs(world.stands, s, () => ++n))) rod(g.a, g.b, Math.max(g.r0, g.r1), i);
  });
  for (const e of extra) rod(e.a, e.b, e.r, e.own);
  const grid = new Map(), put = (o) => {
    for (let i = Math.floor(o.lo[0] / CELL); i <= Math.floor(o.hi[0] / CELL); i++) for (let j = Math.floor(o.lo[2] / CELL); j <= Math.floor(o.hi[2] / CELL); j++) {
      const k = i * 65536 + j; let c = grid.get(k); if (!c) grid.set(k, c = []); c.push(o);
    }
  };
  boxes.forEach(put); rods.forEach(put);
  return { boxes, rods, terrain: world.terrain || null, grid };
}

/** Squared distance between segments p0-p1 and q0-q1. */
function segSeg2(p0, p1, q0, q1) {
  const d1 = [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]], d2 = [q1[0] - q0[0], q1[1] - q0[1], q1[2] - q0[2]], r = [p0[0] - q0[0], p0[1] - q0[1], p0[2] - q0[2]];
  const dot = (u, v) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
  const a = dot(d1, d1), e = dot(d2, d2), f = dot(d2, r);
  let s, t;
  if (a < 1e-12 && e < 1e-12) { s = t = 0; }
  else if (a < 1e-12) { s = 0; t = Math.min(1, Math.max(0, f / e)); }
  else {
    const c = dot(d1, r);
    if (e < 1e-12) { t = 0; s = Math.min(1, Math.max(0, -c / a)); }
    else {
      const b = dot(d1, d2), den = a * e - b * b;
      s = den > 1e-12 ? Math.min(1, Math.max(0, (b * f - c * e) / den)) : 0;
      t = (b * s + f) / e;
      if (t < 0) { t = 0; s = Math.min(1, Math.max(0, -c / a)); } else if (t > 1) { t = 1; s = Math.min(1, Math.max(0, (b - c) / a)); }
    }
  }
  const x = r[0] + d1[0] * s - d2[0] * t, y = r[1] + d1[1] * s - d2[1] * t, z = r[2] + d1[2] * s - d2[2] * t;
  return x * x + y * y + z * z;
}

/** Whether segment s (world points a, b, radius r0..r1) runs into an obstacle other than tree `own`'s trunk. */
function hits(s, O, own) {
  const r = Math.max(s.r0, s.r1), a = s.a, b = s.b;
  const lo = [0, 1, 2].map((k) => Math.min(a[k], b[k]) - r), hi = [0, 1, 2].map((k) => Math.max(a[k], b[k]) + r);
  const L = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]), n = Math.max(1, Math.ceil(L / STEP));
  // the ground: the segment's axis below it
  if (O.terrain) for (let i = 0; i <= n; i++) {
    const t = i / n, x = a[0] + (b[0] - a[0]) * t, y = a[1] + (b[1] - a[1]) * t, z = a[2] + (b[2] - a[2]) * t;
    if (y < groundY(O.terrain, x, z)) return true;
  }
  const seen = new Set();
  for (let i = Math.floor(lo[0] / CELL); i <= Math.floor(hi[0] / CELL); i++) for (let j = Math.floor(lo[2] / CELL); j <= Math.floor(hi[2] / CELL); j++) {
    for (const o of O.grid.get(i * 65536 + j) || []) {
      if (seen.has(o)) continue; seen.add(o);
      if (o.lo[0] > hi[0] || o.hi[0] < lo[0] || o.lo[1] > hi[1] || o.hi[1] < lo[1] || o.lo[2] > hi[2] || o.hi[2] < lo[2]) continue;
      if (o.q) {                                            // a box: any point of the axis inside it grown by r
        const inv = [-o.q[0], -o.q[1], -o.q[2], o.q[3]];
        for (let k = 0; k <= n; k++) {
          const t = k / n, l = qrot(inv, [a[0] + (b[0] - a[0]) * t - o.c[0], a[1] + (b[1] - a[1]) * t - o.c[1], a[2] + (b[2] - a[2]) * t - o.c[2]]);
          if (Math.abs(l[0]) < o.h[0] + r && Math.abs(l[1]) < o.h[1] + r && Math.abs(l[2]) < o.h[2] + r) return true;
        }
      } else if (o.own !== own && segSeg2(a, b, o.a, o.b) < (r + o.r) * (r + o.r)) return true;
    }
  }
  return false;
}

/**
 * Where to cut tree `segs` (generateTree's output, world points, trunk first): the indices of the segments, off
 * its trunk, that run into an obstacle in O while their parent does not. `own` is the tree's own trunk's tag.
 */
export function pruneCuts(segs, O, own) {
  const trunk = new Set(trunkOf(segs).map((s) => s.id)), gone = new Set(), cut = [];
  segs.forEach((s, i) => {
    if (trunk.has(s.id)) return;
    if (gone.has(s.parent)) { gone.add(s.id); return; }
    if (hits(s, O, own)) { gone.add(s.id); cut.push(i); }
  });
  return cut;
}

/** segs without the segments at `cut` (indices) and everything that grows from them. */
export function applyCuts(segs, cut) {
  if (!cut || !cut.length) return segs;
  const at = new Set(cut), gone = new Set();
  return segs.filter((s, i) => {
    if (at.has(i) || gone.has(s.parent)) { gone.add(s.id); return false; }
    return true;
  });
}
