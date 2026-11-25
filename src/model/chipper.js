// The wood chipper: its shape (shared by the sim's colliders and the view's
// meshes) and its chip piles. Plain data, part of the world model.
//
// A towable chipper. Its own frame: +x runs from the infeed hopper (back) to
// the drawbar and grip (front), +y is up, +z is the side the discharge chute
// blows chips out to. The body origin sits BODY_Y above the ground at rest.
// Wood and rope go in at INFEED along +x and are chipped once past DRUM_X.
//
// world.chipper = {p:[3], q:[4] where it was parked, piles: [[x, z, V], ...],
//                  wreck: null, or {at: {p, q} its pose when it crumpled, ids: [body id of each WRECK part]}}
// (V = m3 of loose chips). A pile is a cone at the chips' angle of repose; a
// pile emptied by players stays in the list at V = 0 so the indices hold.

export const CHIPPER_BODY_ID = 59000;     // its id in transform snapshots (pieces are below, players at 60000+)

export const SHAPE = {
  BODY_Y: 0.8,
  CHASSIS: { c: [0, 0, 0], h: [1.3, 0.45, 0.65] },
  WHEELS: [[-0.3, -0.5, 0.8], [-0.3, -0.5, -0.8]], WHEEL_R: 0.3,
  AXLE: [-0.3, -0.8, 0],                  // ground point under the axle
  JOCKEY: [1.95, -0.68, 0], JOCKEY_R: 0.12,
  DRAWBAR: { c: [1.85, -0.25, 0], h: [0.55, 0.04, 0.04] },
  GRIP: [2.45, -0.25, 0], GRIP_H: [0.07, 0.06, 0.16],
  HOPPER: { c: [-1.7, 0.02, 0], h: [0.4, 0.36, 0.5] },
  INFEED: [-2.1, 0.02, 0],
  DRUM_X: -1.0,
  DISCHARGE: [0.2, 3.2],                  // (x, z) on the ground where chips land
};

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
  return out;
}
export const WRECK = wreckParts();
