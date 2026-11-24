// The wood chipper: its shape (shared by the sim's colliders and the view's
// meshes) and its chip piles. Plain data, part of the world model.
//
// A towable chipper. Its own frame: +x runs from the infeed hopper (back) to
// the drawbar and grip (front), +y is up, +z is the side the discharge chute
// blows chips out to. The body origin sits BODY_Y above the ground at rest.
// Wood and rope go in at INFEED along +x and are chipped once past DRUM_X.
//
// world.chipper = {p:[3], q:[4] where it was parked, piles: [[x, z, V], ...]}
// (V = m3 of loose chips). A pile is a cone at the chips' angle of repose.

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
