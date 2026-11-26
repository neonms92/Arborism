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
// (y: the trunk's base; cut: where it was pruned at planting, model/prune.js; piece: 0 while dormant, else the rooted piece it became; k: 1 for a utility pole, a
// straight trunk with no branches whose segments are marked pl (no spurs go into it), model/lines.js)

import { generateTree } from './treegen.js';
import { gridFor } from './fibres.js';
import { applyCuts } from './prune.js';

/** The shape generateTree grows stand i from. */
export function standShape(stands, st) { return { ...stands.g, h: st.h, d: st.d }; }

/** Stand st's segments (ids from newId), at its place in the world: the same on every machine. */
export function standSegs(stands, st, newId) {
  if (st.k === 1) return poleSegs(st, newId, stands.g.pitch);
  return applyCuts(generateTree(st.seed, newId, [st.x, st.y, st.z], standShape(stands, st)), st.cut);
}

/**
 * North American distribution pole hardware, in m (fixed, not tunables: every machine must grow the same pole).
 * A wooden crossarm (an 8 ft arm, 2.44 m) square across the street (streets run along x, so it lies along z),
 * ARM_DROP below the top, held by two flat braces at 45 degrees from the pole up to the arm. Three phase
 * conductors on pin insulators on the arm (two on the street side, one on the yard side), a neutral on a spool
 * bracket lower down, and below the arm, on a pole that feeds houses, a pole-mount transformer can on the yard
 * side (or the street side, whichever its first house is on), with a tap from the nearest phase down to its top
 * bushing and the service drops leaving its side.
 */
export const POLE = {
  ARM_DROP: 0.3, ARM_HALF: 1.22, ARM_R: 0.05,        // crossarm: below the pole top, half its length, radius
  BRACE: 0.55, BRACE_R: 0.02,                        // braces: they meet the arm this far out and rise as much (45 deg)
  PINS: [-1.07, 0.36, 1.07], PIN_H: 0.2,             // phases: z along the arm (- yard side, + street side), insulator height
  NEUTRAL: 2.4, NEUTRAL_OUT: 0.17,                   // neutral: below the arm, out from the axis on the street side
  CAN_TOP: 1.0, CAN_H: 0.8, CAN_R: 0.25, CAN_OUT: 0.41,   // transformer can: top below the arm, height, radius, out on the yard side
};

/** Where the hardware of a pole h tall is, as [dx, dy, dz] from the middle of its base; its can on side `side` (-1 yard, +1 street). */
export function poleParts(h, side = -1) {
  const arm = h - POLE.ARM_DROP;
  return {
    arm,
    pins: POLE.PINS.map((z) => [0, arm + POLE.ARM_R + POLE.PIN_H, z]),
    neutral: [0, arm - POLE.NEUTRAL, POLE.NEUTRAL_OUT],
    can: [0, arm - POLE.CAN_TOP - POLE.CAN_H / 2, side * POLE.CAN_OUT],    // the can's middle
    bushing: [0, arm - POLE.CAN_TOP + 0.08, side * (POLE.CAN_OUT - 0.08)], // its primary bushing, on the lid
    tap: side > 0 ? 1 : 0,                                                  // the phase tapped: the pin nearest the can
  };
}

/**
 * A utility pole: a straight round trunk h tall, d across at its base, two thirds of that at its top, with its
 * crossarm (two halves out from the pole's axis) and the two braces under it, all wood, all marked pl.
 */
export function poleSegs(st, newId, pitch) {
  const { arm } = poleParts(st.h), foot = arm - POLE.BRACE, r0 = st.d / 2, r1 = st.d / 3, out = [];
  // the trunk, in pieces of about 1.5 m, with joints where the braces and the arm meet it
  const ys = [0];
  for (const y of [foot, arm, st.h]) { const n = Math.max(1, Math.round((y - ys[ys.length - 1]) / 1.5)), y0 = ys[ys.length - 1]; for (let i = 1; i <= n; i++) ys.push(y0 + (y - y0) * i / n); }
  const rad = (y) => r0 + (r1 - r0) * y / st.h, at = {};
  for (let i = 0; i + 1 < ys.length; i++) {
    const ya = ys[i], yb = ys[i + 1], ra = rad(ya), rb = rad(yb);
    const s = { id: newId(), parent: i ? out[out.length - 1].id : -1, a: [st.x, st.y + ya, st.z], b: [st.x, st.y + yb, st.z], r0: ra, r1: rb, leaf: 0, N: gridFor(ra, pitch), pl: 1 };
    out.push(s);
    if (Math.abs(yb - foot) < 1e-9) at.foot = s; if (Math.abs(yb - arm) < 1e-9) at.arm = s;
  }
  const kid = (par, a, b, r) => out.push({ id: newId(), parent: par.id, a, b, r0: r, r1: r, leaf: 0, N: gridFor(r, pitch), pl: 1 });
  for (const sg of [1, -1]) kid(at.arm, [st.x, st.y + arm, st.z], [st.x, st.y + arm, st.z + sg * POLE.ARM_HALF], POLE.ARM_R);
  for (const sg of [1, -1]) kid(at.foot, [st.x, st.y + foot, st.z], [st.x, st.y + arm - POLE.ARM_R, st.z + sg * (POLE.BRACE - POLE.ARM_R)], POLE.BRACE_R);
  // (the arm and braces go after the whole trunk, so trunkOf still sees a plain trunk)
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
