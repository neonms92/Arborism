// The grapple loader and the log truck: their shapes (shared by the sim's colliders and the view's meshes).
// Plain data, part of the world model.
//
// The loader is a small four-wheeled machine the driver stands on the back of (a stand-on loader). Its own
// frame: +x forward (the boom and claw), +y up, z across. The body origin sits BODY_Y above the ground at rest.
// A boom hinged on two towers over the middle of the chassis reaches forward; a grapple (the claw) hangs from a
// link at its tip and swings there. The driver steers the front wheels, drives all four, raises and lowers the
// boom, and opens and closes the claw (sim/loader.js).
//
// The log truck is parked in the street in front of the job's lot. It does not move (a fixed body). Its own
// frame: +x toward the cab, +y up, z across; the origin is on the ground under the middle. Loose wood that comes
// to rest in its bed is taken away (a 'haul' event): it never fills up.
//
// world.loader = null, or {p:[3], q:[4] where the loader was parked, truck: {p, q}, kg: wood hauled away this job,
//                n: loads}. Parked fresh ('loader' event) with every new tree (not in the engine tests).

export const LOADER_BODY_ID = 59800;       // the loader's body in transform snapshots; its grapple is one more
export const GRAPPLE_BODY_ID = 59801;

export const LOADER = {
  BODY_Y: 0.7,
  CHASSIS: { c: [0, 0, 0], h: [1.2, 0.35, 0.62] },
  // the counterweight over the back axle: most of the mass, so the loader can hold a heavy log out in front
  WEIGHT: { c: [-0.85, 0.15, 0], h: [0.3, 0.2, 0.6] },
  // the platform the driver stands on, behind the chassis, and the control post in front of them
  PLATFORM: { c: [-1.5, -0.33, 0], h: [0.3, 0.04, 0.5] },
  POST: { c: [-1.15, 0.45, 0.0], h: [0.05, 0.1, 0.25] },
  STAND: [-1.5, 0.59, 0],                  // the driver's body centre (feet on the platform)
  WHEELS: [[0.85, -0.3, 0.78], [0.85, -0.3, -0.78], [-0.85, -0.3, 0.78], [-0.85, -0.3, -0.78]],   // front two steer
  WHEEL_R: 0.4, WHEEL_W: 0.3,
  // the boom: hinged at PIVOT, BOOM_L long, two arms ARM_Z either side; angle from level, up positive
  PIVOT: [-0.55, 0.6, 0], BOOM_L: 4.4, ARM_Z: 0.45,
  BOOM_MIN: -0.32, BOOM_MAX: 1.15, BOOM_START: 0.35,
  // the grapple, in its own frame (+y up toward the link, z across the loader when it hangs straight): a head
  // with a tine at each side that close round the log
  LINK: [0, 0.5, 0],                       // where it hangs from the boom tip
  HEAD: { c: [0, 0, 0], h: [0.22, 0.14, 0.72] },
  TINE: { c: [0, -0.38, 0.72], h: [0.09, 0.3, 0.04] },    // (and mirrored to -z), as open
  JAW: [0, -0.42, 0],                      // the middle of the jaws: what it closes on is held here
  JAW_R: 0.65,                             // the thickest wood the jaws close round (radius, m)
};

/** The boom tip in loader-local coordinates for boom angle a (rad). */
export function boomTip(a) {
  const P = LOADER.PIVOT, L = LOADER.BOOM_L;
  return [P[0] + L * Math.cos(a), P[1] + L * Math.sin(a), 0];
}

export const TRUCK = {
  // a flatbed dump truck: cab at +x, an open steel bed behind it. Boxes in the truck's frame.
  FRAME: { c: [0, 0.72, 0], h: [4.15, 0.34, 0.62] },
  CAB: { c: [3.35, 1.65, 0], h: [0.8, 0.95, 1.2] },
  HOOD: { c: [4.2, 1.15, 0], h: [0.25, 0.45, 1.1] },
  FLOOR: { c: [-0.85, 1.18, 0], h: [3.3, 0.08, 1.25] },
  SIDE: { c: [-0.85, 1.6, 1.2], h: [3.3, 0.34, 0.05] },  // (and mirrored to -z)
  HEADBOARD: { c: [2.42, 1.75, 0], h: [0.05, 0.5, 1.25] },
  TAILGATE: { c: [-4.1, 1.6, 0], h: [0.05, 0.34, 1.25] },
  WHEELS: [[3.3, 0.5, 1.05], [3.3, 0.5, -1.05], [-1.9, 0.5, 1.05], [-1.9, 0.5, -1.05], [-3.1, 0.5, 1.05], [-3.1, 0.5, -1.05]],
  WHEEL_R: 0.5,
  // inside the bed: wood whose centre of mass rests in here is hauled away
  BED: { lo: [-4.05, 1.2, -1.15], hi: [2.37, 4.5, 1.15] },
  HW: 1.3,                                 // half its width, for parking it
  HL: 4.5,                                 // half its length
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
