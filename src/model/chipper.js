// The wood chipper: its shape (shared by the sim's colliders and the view's
// meshes) and its chip piles. Plain data, part of the world model.
//
// A towable chipper. Its own frame: +x runs from the infeed hopper (back) to
// the drawbar and grip (front), +y is up, +z is the side the discharge chute
// blows chips out to. The body origin sits BODY_Y above the ground at rest.
// Wood and rope go in at INFEED along +x and are chipped once past DRUM_X.
//
// world.chipper = {piles: [[x, z, V], ...], units: [{p:[3], q:[4] where it was parked,
//                  wreck: null, or {at: {p, q} its pose when it crumpled, ids: [body id of each WRECK part]}}, ...]}
// (V = m3 of loose chips). units[0] comes with every new tree; more are bought from the Tab menu
// ("Buy a new chipper"), and unit k is body CHIPPER_BODY_ID + k in transform snapshots. A pile is a cone at the chips' angle of repose; a
// pile emptied by players stays in the list at V = 0 so the indices hold.

export const CHIPPER_BODY_ID = 59000;     // chipper k is CHIPPER_BODY_ID + k in transform snapshots (pieces are below, players at 60000+)

export const SHAPE = {
  BODY_Y: 0.8,
  CHASSIS: { c: [0, 0, 0], h: [1.3, 0.45, 0.65] },
  // The axle sits under the drum, close behind the hopper (D120): the weight of wood on the hopper lip and the winch
  // then has a short lever about it against a long one for the chipper's own weight, so a heavy branch does not
  // tip it onto its hopper end (with the axle at -0.3 about 45 kg on the winch did). The jockey wheel carries more.
  WHEELS: [[-1.0, -0.5, 0.8], [-1.0, -0.5, -0.8]], WHEEL_R: 0.3,
  AXLE: [-1.0, -0.8, 0],                  // ground point under the axle
  JOCKEY: [1.95, -0.68, 0], JOCKEY_R: 0.12,
  DRAWBAR: { c: [1.85, -0.25, 0], h: [0.55, 0.04, 0.04] },
  GRIP: [2.45, -0.25, 0], GRIP_H: [0.07, 0.06, 0.16],
  HOPPER: { c: [-1.7, 0.02, 0], h: [0.4, 0.36, 0.5] },
  INFEED: [-2.1, 0.02, 0],
  WINCH: [-1.95, 0.28, 0],                // the winch drum just inside the top lip of the hopper mouth: it takes the grab rope
  DRUM_X: -1.0,
  DISCHARGE: [0.2, 3.2],                  // (x, z) on the ground where chips land
  // The roll cage: two steel hoops arched over the chassis at x0 and x1. Its collider is the solid between them
  // (sim/chipper.js), a dome over the chassis as wide as the wheels. Seen end on, each hoop is a gentle spiral about
  // the centre of mass (o, the chipper-local y of it; z = 0): rf from it at its feet (tf off straight up), and
  // farther by a factor e^(k * angle) toward the top, laid out in flat steps of `step`. A body on flat ground rests
  // only where its weight is over the contact; on this curve the weight is always a few cm outboard of it, toward
  // the wheels, so rolled over (onto its roof or its side) it rolls on until it is back on its wheels (D91). A round
  // dome would do it with less margin; flat steps of a round one would each be a resting place.
  CAGE: { x0: -1.25, x1: 1.25, o: -0.19, rf: 1.22, tf: 104, k: 0.05, step: 2 },
  // Where the drum, flywheel and engine block sit: low in the chassis (mass only, no shape of its own). With it the
  // centre of mass is at CAGE.o (keep them together when changing masses or shapes; a few cm either way still rolls).
  BALLAST: { c: [0, -0.4, 0], h: [1.25, 0.05, 0.6] },
  // The salad rack: a small open box on the side away from the chute (-z), bolted to the chassis inside the roll cage,
  // holding three tube salads standing up (SALADS: their centres; radius SALAD_R, half height SALAD_H). Players take
  // one with {interact}; the rack never runs out. It has no collider: it is reached by a ray against this box.
  RACK: { c: [0.6, 0.1, -0.74], h: [0.2, 0.14, 0.09] },
  SALADS: [[0.47, 0.09, -0.76], [0.6, 0.09, -0.76], [0.73, 0.09, -0.76]], SALAD_R: 0.045, SALAD_H: 0.11,
  // The floodlights (D120): a pair of work lamps on the back hoop of the roll cage, one each side, aimed down past the
  // hopper at the ground beside it where the wood is fed. FLOOD_AT: where the lamp sits on the hoop (degrees from the
  // top of the arc, either side); FLOOD_AIM: the ground point each one lights (z mirrored for the -z lamp).
  FLOOD_AT: 50, FLOOD_AIM: [-2.5, -0.8, 1.35],
};

/** The floodlights' lamp positions, chipper-local, [+z lamp, -z lamp]: on the back hoop's arc, just behind it. */
export function floodLamps() {
  const arc = cageArc(), n = (arc.length - 1) / 2, i = Math.round(SHAPE.FLOOD_AT / SHAPE.CAGE.tf * n);
  const [y, z] = arc[n + i];
  return [[SHAPE.CAGE.x0 - 0.07, y, z], [SHAPE.CAGE.x0 - 0.07, y, -z]];
}

/** The roll cage's curve as chipper-local [y, z] points, from one foot over the top to the other (SHAPE.CAGE). */
export function cageArc() {
  const C = SHAPE.CAGE, n = Math.round(C.tf / C.step), d = C.step * Math.PI / 180, out = [];
  for (let i = -n; i <= n; i++) {
    const t = i * d, r = C.rf * Math.exp(C.k * (n - Math.abs(i)) * d);
    out.push([C.o + r * Math.cos(t), r * Math.sin(t)]);
  }
  return out;
}


export const REPOSE = 0.65;               // rad, slope of a chip pile
const PILE_JOIN = 1.0;                    // m: chips landing this close to a pile's centre go on that pile

/** Radius and height of a cone of V m3 at the angle of repose. */
export function pileShape(V) {
  const tn = Math.tan(REPOSE), r = Math.cbrt(3 * Math.max(0, V) / (Math.PI * tn));
  return { r, h: r * tn };
}

/** Add V m3 of chips landing at world (x, z). Returns the index of the pile they went on. */
export function addChips(ch, x, z, V) {
  const ps = ch.piles;
  for (let i = ps.length - 1; i >= 0; i--) {
    if (Math.hypot(ps[i][0] - x, ps[i][1] - z) < PILE_JOIN) { ps[i][2] += V; return i; }
  }
  ps.push([x, z, V]);
  return ps.length - 1;
}

/** A chipper-local point to world, given position p:[3] and quaternion q:[4]. */
export function chipToWorld(p, q, l) {
  const [x, y, z, w] = q, [vx, vy, vz] = l;
  // v + 2 w (u x v) + 2 u x (u x v)
  const tx = 2 * (y * vz - z * vy), ty = 2 * (z * vx - x * vz), tz = 2 * (x * vy - y * vx);
  return [p[0] + vx + w * tx + (y * tz - z * ty), p[1] + vy + w * ty + (z * tx - x * tz), p[2] + vz + w * tz + (x * ty - y * tx)];
}

/** Where the chipper is parked for a tree of this height and paving radius: back to the tree, chute to the side. */
export function parkedPose(paveR, gap) {
  return { p: [paveR + gap - SHAPE.INFEED[0], SHAPE.BODY_Y, 0], q: [0, 0, 0, 1] };
}

// ---- the wreck: what it comes apart into when it takes a strong hit (sim/chipper.js crumple) ----
// Boxes in the chipper's frame, a few mm apart so none starts overlapping. m = share of CHIP_MASS.
// kind 'wheel' is a cylinder about z (h[0] = radius, h[2] = half width).
const T = 0.03, G = 0.004;
function wreckParts() {
  const { h } = SHAPE.CHASSIS, out = [], I = [0, 0, 0, 1];
  const box = (c, hh, m, mat = 'body', q = I) => out.push({ c, h: hh, q, m, mat });
  // the chassis as six panels
  box([0, -h[1] + T / 2, 0], [h[0] - G, T / 2, h[2] - G], 0.2);
  box([0, h[1] - T / 2, 0], [h[0] - T - G, T / 2, h[2] - T - G], 0.1);
  for (const s of [-1, 1]) box([0, 0, s * (h[2] - T / 2)], [h[0] - G, h[1] - T - G, T / 2], 0.1);
  for (const s of [-1, 1]) box([s * (h[0] - T / 2), 0, 0], [T / 2, h[1] - T - G, h[2] - T - 2 * G], 0.05);
  box([0.75, h[1] + 0.15 + G, 0], [0.45, 0.15, 0.55], 0.15, 'dark');                        // engine
  // the hopper as four plates
  const hp = SHAPE.HOPPER;
  for (const s of [-1, 1]) box([hp.c[0] - G, hp.c[1] + s * (hp.h[1] - T / 2), 0], [hp.h[0] - G, T / 2, hp.h[2]], 0.02);
  for (const s of [-1, 1]) box([hp.c[0] - G, hp.c[1], s * (hp.h[2] - T / 2)], [hp.h[0] - G, hp.h[1] - T - G, T / 2], 0.02);
  for (const w of SHAPE.WHEELS) box(w, [SHAPE.WHEEL_R, 0, 0.11], 0.04, 'wheel');
  box(SHAPE.DRAWBAR.c, SHAPE.DRAWBAR.h, 0.02, 'steel');
  box(SHAPE.GRIP, SHAPE.GRIP_H, 0.005, 'grip');
  box(SHAPE.JOCKEY, [SHAPE.JOCKEY_R, 0, 0.04], 0.01, 'wheel');
  box([0.2, h[1] + 0.65, 0.35], [0.13, 0.62, 0.13], 0.03);                                     // the discharge chute, straightened
  for (const x of [SHAPE.CAGE.x0, SHAPE.CAGE.x1]) box([x, h[1] + 0.8, 0], [0.025, 0.025, 1.1], 0.005, 'steel');  // the cage's hoops, straightened
  const R = SHAPE.RACK;
  box([R.c[0], R.c[1], R.c[2] - G], [R.h[0], R.h[1], R.h[2] - 0.02], 0.004, 'steel');          // the salad rack, torn off
  return out;
}
export const WRECK = wreckParts();
