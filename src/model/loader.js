// The grapple loader and the log truck: their shapes (shared by the sim's colliders and the view's meshes).
// Plain data, part of the world model.
//
// The loader is a small skid steer the driver stands on the back of. Its own frame: +x forward (the arms and claw),
// +y up, z across (+z to the driver's right). The body origin sits BODY_Y above the ground at rest. It has four
// wheels that do not steer: each side is driven on its own, and it turns by driving one side faster (skidding).
// Two short arms hinged on towers at the back reach forward past the front wheels; on their ends is an over-and-
// under claw, kept level: a fork underneath, and a clamp that closes down on the wood from above (sim/loader.js).
// The arms and the claw are drawn only: they have no colliders.
//
// The log truck is parked in the street in front of the job's lot. It does not move (a fixed body). Its own
// frame: +x toward the cab, +y up, z across; the origin is on the ground under the middle. Loose wood that comes
// to rest in its bed is taken away (a 'haul' event): it never fills up.
//
// world.loader = null, or {p:[3], q:[4] where the loader was parked, truck: {p, q}, kg: wood hauled away this job,
//                n: loads}. Parked fresh ('loader' event) with every new tree (not in the engine tests).

export const LOADER_BODY_ID = 59800;       // the loader's body in transform snapshots
// The G.O.E.s racked on the truck (D134): the one in slot i, once taken off it, is player id GOE_ID0 - i (people are
// 1, 2, 3...). A slot is empty while that player exists, so the rack needs no state of its own.
export const GOE_ID0 = 99;
export const GOE_NAME = 'G.O.E.';
export const GOE_COLOR = 0x8a8d90;         // gray

export const LOADER = {
  BODY_Y: 0.7,
  CHASSIS: { c: [0, 0, 0], h: [1.0, 0.35, 0.6] },
  // the counterweight over the back axle: most of the mass
  WEIGHT: { c: [-0.7, 0.15, 0], h: [0.28, 0.2, 0.58] },
  // the platform the driver stands on, behind the chassis, and the control post in front of them
  PLATFORM: { c: [-1.3, -0.33, 0], h: [0.3, 0.04, 0.5] },
  POST: { c: [-0.95, 0.45, 0.0], h: [0.05, 0.1, 0.25] },
  STAND: [-1.3, 0.59, 0],                  // the driver's body centre (feet on the platform)
  WHEELS: [[0.72, -0.3, 0.8], [0.72, -0.3, -0.8], [-0.72, -0.3, 0.8], [-0.72, -0.3, -0.8]],
  WHEEL_R: 0.4, WHEEL_W: 0.3,
  // the arms: hinged at PIVOT (on towers at the back), ARM_L long, one each side at ARM_Z; angle from level, up
  // positive. Down, the claw's fork is on the ground; up, the claw is overhead, above a truck's side.
  PIVOT: [-0.7, 0.85, 0], ARM_L: 2.3, ARM_Z: 0.72,
  ARM_MIN: -0.42, ARM_MAX: 0.62,
  // the claw, in its own frame: origin at the arms' ends, axes the loader's (it is kept level). A plate on the
  // arms, a fork of tines underneath (the under), and a clamp hinged on top of the plate that closes down (the over)
  PLATE: { c: [0.08, -0.22, 0], h: [0.04, 0.32, 0.62] },
  TINES: [-0.45, -0.15, 0.15, 0.45],       // z of each tine of the fork
  FORK: { c: [0.5, -0.55, 0], h: [0.42, 0.03, 0.05] },
  CLAMP_HINGE: [0.12, 0.1, 0], CLAMP_Z: 0.42, CLAMP_L: 0.62,
  JAW: [0.55, -0.35, 0],                   // the middle of the jaws: what it holds is held with its middle here
  JAW_R: 0.4,                              // the thickest wood the claw closes on (radius, m)
};

/** The arms' ends (the claw's origin) in loader-local coordinates for arm angle a (rad). */
export function armTip(a) {
  const P = LOADER.PIVOT, L = LOADER.ARM_L;
  return [P[0] + L * Math.cos(a), P[1] + L * Math.sin(a), 0];
}
/** The middle of the jaws in loader-local coordinates for arm angle a. */
export function jawAt(a) {
  const t = armTip(a), J = LOADER.JAW;
  return [t[0] + J[0], t[1] + J[1], t[2] + J[2]];
}

export const TRUCK = {
  // a flatbed dump truck: cab at +x, an open steel bed behind it, and between them the G.O.E. rack. Boxes in the truck's frame.
  FRAME: { c: [0, 0.72, 0], h: [4.15, 0.34, 0.62] },
  CAB: { c: [3.35, 1.65, 0], h: [0.8, 0.95, 1.2] },
  HOOD: { c: [4.2, 1.15, 0], h: [0.25, 0.45, 1.1] },
  FLOOR: { c: [-1.75, 1.18, 0], h: [2.4, 0.08, 1.25] },
  SIDE: { c: [-1.75, 1.6, 1.2], h: [2.4, 0.34, 0.05] },  // (and mirrored to -z)
  HEADBOARD: { c: [0.6, 1.75, 0], h: [0.05, 0.5, 1.25] },
  TAILGATE: { c: [-4.1, 1.6, 0], h: [0.05, 0.34, 1.25] },
  WHEELS: [[3.3, 0.5, 1.05], [3.3, 0.5, -1.05], [-1.9, 0.5, 1.05], [-1.9, 0.5, -1.05], [-3.1, 0.5, 1.05], [-3.1, 0.5, -1.05]],
  WHEEL_R: 0.5,
  // inside the bed: wood whose centre of mass rests in here is hauled away
  BED: { lo: [-4.05, 1.2, -1.15], hi: [0.55, 4.5, 1.15] },
  HW: 1.3,                                 // half its width, for parking it
  HL: 4.5,                                 // half its length
  // The G.O.E. rack, between the headboard and the cab (D134): a deck on the frame and a spine down the middle,
  // with the groundbots stood back to back against it, two facing each side of the street, switched off.
  // Each slot: c, the middle of the bot (as his body's centre), and f, the way his front faces (+1: +z, -1: -z).
  RACK_DECK: { c: [1.6, 1.1, 0], h: [0.93, 0.04, 1.2] },
  RACK_SPINE: { c: [1.6, 1.95, 0], h: [0.9, 0.8, 0.03] },
  RACK_SLOTS: [{ c: [1.18, 2.03, 0.22], f: 1 }, { c: [2.02, 2.03, 0.22], f: 1 }, { c: [1.18, 2.03, -0.22], f: -1 }, { c: [2.02, 2.03, -0.22], f: -1 }],
};

/** A frame-local point to world, given position p:[3] and quaternion q:[4] (as chipToWorld). */
export function frameToWorld(p, q, l) {
  const [x, y, z, w] = q, [vx, vy, vz] = l;
  const tx = 2 * (y * vz - z * vy), ty = 2 * (z * vx - x * vz), tz = 2 * (x * vy - y * vx);
  return [p[0] + vx + w * tx + (y * tz - z * ty), p[1] + vy + w * ty + (z * tx - x * tz), p[2] + vz + w * tz + (x * ty - y * tx)];
}
/** A world point into the frame at p, q. */
export function worldToFrame(p, q, wp) {
  return frameToWorld([0, 0, 0], [-q[0], -q[1], -q[2], q[3]], [wp[0] - p[0], wp[1] - p[1], wp[2] - p[2]]);
}
/** Is truck-local point l inside the bed? */
export function inBed(l) {
  const B = TRUCK.BED;
  return l[0] > B.lo[0] && l[0] < B.hi[0] && l[1] > B.lo[1] && l[1] < B.hi[1] && l[2] > B.lo[2] && l[2] < B.hi[2];
}
