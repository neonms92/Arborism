// Power lines: plain data and pure functions (the host simulates them in sim/lines.js, view/lines.js draws them).
//
// Wooden utility poles stand along every street (they are yard trees of kind 1, model/stands.js: dormant until
// someone saws into one, then wood like any other, but never climbable), North American style: three phase
// conductors on a braced crossarm and a neutral below run from each pole to the next along the street. A pole
// that feeds houses carries a transformer can, tapped from a phase, and a service drop runs from the can to the
// front of each house it feeds. Every line but the neutral is live.
//
// world.lines = {list: [line...], hw: [{e: an end, k: HW kind}]} or null (hw: the hardware drawn on the poles)
// line = {a, b: its two ends, n: links it is simulated as, L0: m of line, kind: KIND,
//         brk: [k...] links that have snapped (between point k and k + 1), off: [a, b] 1 where that end came away,
//         down: host tick it first came down (from the snap event), dead: 1 once it has gone dead (a 'dead' event)}
// an end is one of
//   {st, h, o}    on dormant pole st (stand index), h m above its base, o: [dx, dz] off its axis (or none)
//   {seg, p}      on wood: piece-local point p on segment seg (a pole that has woken; it follows splits)
//   {b, m, w}     on house b (build id), room module m, at world point w (it comes away when that room breaks or moves)
// The points of a line are continuous state: they travel in aux (`ln`), and a machine that has not been sent a
// line draws it hanging at rest (restNodes).

import { HOUSE, houseRooms, qrot } from './builds.js';
import { segParam } from './world.js';

/** Kinds of line: a phase conductor, a service drop, the neutral, the tap from a phase down to a transformer. */
export const KIND = { PHASE: 0, DROP: 1, NEUTRAL: 2, TAP: 3 };
/** Kinds of pole hardware (drawn only): a pin insulator, the neutral's spool, a transformer can. */
export const HW = { PIN: 0, SPOOL: 1, CAN: 2 };
/** Does a line of this kind carry power (shock, spark, flash)? The neutral is grounded. */
export const isLive = (l) => l.kind !== KIND.NEUTRAL;

/** World point of an end as the model has it (an end on wood: its unbent piece-local point, right while rooted). */
export function endRest(world, e) {
  if (e.st !== undefined) { const s = world.stands && world.stands.list[e.st], o = e.o || [0, 0]; return s ? [s.x + o[0], s.y + e.h, s.z + o[1]] : [0, 0, 0]; }
  if (e.seg !== undefined) return e.p.slice();
  return e.w.slice();
}

/** The points of a line of length L0 hanging between world points A and B, n links: a parabola of that length. */
export function restNodes(A, B, L0, n) {
  const c = Math.hypot(B[0] - A[0], B[1] - A[1], B[2] - A[2]), d = Math.sqrt(Math.max(0, 3 * c * (L0 - c) / 8));
  const out = new Float64Array((n + 1) * 3);
  for (let k = 0; k <= n; k++) {
    const t = k / n;
    out[3 * k] = A[0] + (B[0] - A[0]) * t;
    out[3 * k + 1] = A[1] + (B[1] - A[1]) * t - 4 * d * t * (1 - t);
    out[3 * k + 2] = A[2] + (B[2] - A[2]) * t;
  }
  return out;
}

/**
 * Where a drop meets house build `b` (as put up: world.builds entry): on the front wall of a top-storey front room,
 * in the column nearest `toward` ([x, z]), just under the eaves. {m: module index, w: world point}, or null.
 */
export function houseEnd(b, toward) {
  const h = b.h; if (!h) return null;
  const R = houseRooms(h), k = h.st - 1, inv = [-b.q[0], -b.q[1], -b.q[2], b.q[3]];
  const loc = qrot(inv, [toward[0] - b.p[0], 0, toward[1] - b.p[2]]);
  let best = -1, bd = Infinity, bi = 0, bz = 0;
  R.list.forEach((r, i) => {
    if (r.k !== k) return;
    const cx = (r.ix - (h.nx - 1) / 2) * h.rw, cz = (r.iz - (h.nz - 1) / 2) * h.rd;
    if (R.has(r.ix, r.iz + 1)) return;                               // only a room on the front
    const d = Math.abs(cx - loc[0]) - r.iz * 0.01;
    if (d < bd) { bd = d; best = i; bi = cx; bz = cz + h.rd / 2; }
  });
  if (best < 0) return null;
  const y = k * (HOUSE.WH + 0.01) + HOUSE.WH - 0.25, r = qrot(b.q, [bi, y, bz + HOUSE.T / 2 + 0.06]);
  return { m: best + 1, w: [b.p[0] + r[0], b.p[1] + r[1], b.p[2] + r[2]].map((v) => +v.toFixed(4)) };   // module 0 is the foundation
}

/** A 'lines' event applied: every line whole. */
export function newLines(list, hw = []) { return list.length ? { list: list.map((l) => ({ ...l, brk: [], off: [0, 0] })), hw: hw.map((h) => ({ ...h })) } : null; }

/** Every end on the poles: both ends of every line and every piece of hardware, as [holder, key] (holder[key] is the end). */
function* allEnds(lines) {
  for (const l of lines.list) { yield [l, 'a']; yield [l, 'b']; }
  if (lines.hw) for (const h of lines.hw) yield [h, 'e'];
}

/** A 'snap' event: link k of line i parted, or its end `end` (0 or 1) came away. */
export function snapLine(lines, ev) {
  const l = lines && lines.list[ev.i]; if (!l) return;
  if (ev.k !== undefined) { if (!l.brk.includes(ev.k)) l.brk.push(ev.k); }
  else if (ev.end !== undefined) l.off[ev.end] = 1;
  if (l.down === undefined && ev.tk !== undefined) l.down = ev.tk;
}

/** A 'dead' event: line i, down for LINE_DEAD_T, no longer carries power (no sparks, no shocks). */
export function deadLine(lines, ev) { const l = lines && lines.list[ev.i]; if (l) l.dead = 1; }

/**
 * Pole st has woken into wood (segments segs, rooted, piece-local = world): ends on it move onto its wood, each
 * onto the segment nearest it (a conductor onto its half of the crossarm, the can onto the trunk beside it).
 */
export function wakeEnds(lines, st, segs) {
  if (!lines) return;
  for (const [h, k] of allEnds(lines)) {
    const e = h[k]; if (e.st !== st) continue;
    const s0 = segs[0], o = e.o || [0, 0], p = [s0.a[0] + o[0], s0.a[1] + e.h, s0.a[2] + o[1]];
    let s = segs[0], bd = Infinity;
    for (const g of segs) { const d = distToSeg(p, g); if (d < bd - 1e-9) { bd = d; s = g; } }
    h[k] = { seg: s.id, p: p.map((v) => +v.toFixed(4)) };
  }
}
function distToSeg(p, g) {
  const d = [0, 1, 2].map((c) => g.b[c] - g.a[c]), L2 = d[0] * d[0] + d[1] * d[1] + d[2] * d[2] || 1;
  const t = Math.min(1, Math.max(0, ((p[0] - g.a[0]) * d[0] + (p[1] - g.a[1]) * d[1] + (p[2] - g.a[2]) * d[2]) / L2));
  return Math.hypot(p[0] - g.a[0] - d[0] * t, p[1] - g.a[1] - d[1] * t, p[2] - g.a[2] - d[2] * t);
}

/** Segment s is being divided at fraction `at` into s and newId (model/world.js _divide): ends past `at` go with newId. */
export function divideEnds(lines, s, at, newId) {
  if (!lines) return;
  for (const [h, k] of allEnds(lines)) {
    const e = h[k]; if (e.seg === s.id && segParam(s, e.p) > at) e.seg = newId;
  }
}

/** Is the line still joined end to end (no link snapped, neither end come away)? */
export function whole(l) { return !l.brk.length && !l.off[0] && !l.off[1]; }

/** A machine's copy of the points of the lines it has been sent (main.js keeps one for a joined player). */
export class LinePoses {
  constructor() { this.m = new Map(); }
  /** aux.ln: [[line index, x, y, z, x, y, z...] in cm]. */
  take(ln) { if (ln) for (const r of ln) { const a = new Float64Array(r.length - 1); for (let j = 1; j < r.length; j++) a[j - 1] = r[j] / 100; this.m.set(r[0], a); } }
  get(i) { return this.m.get(i) || null; }
  clear() { this.m.clear(); }
}
