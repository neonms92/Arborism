// The chip bins: 96 US gallon wheeled bins parked by the chipper. Their shape (shared by the sim's colliders and the
// view's meshes). Plain data, part of the world model.
//
// A bin's own frame: +y up, -x is its back (the hinge of the lid, the handle bar and the two wheels), +x its front,
// z across. The body origin sits BODY_Y above the ground when it stands on its base. The lid is a separate body
// hung on a hinge along the top of the back (sim/bin.js): it flops about on its own and is pushed open or shut by
// a player.
//
// A bin has no bottom as far as the game is concerned (owner, 2026-11-26): chips that land in its open mouth, or
// that a player tips in, are gone for good (world.prog.gone). It cannot be broken.
//
// world.bins = [{p:[3], q:[4]} where each was put down], in the order they came (a bought bin is added)

export const BIN_BODY_ID = 59500;          // bin k's body is BIN_BODY_ID + 2k in transform snapshots, its lid one more
export const binBodyId = (k) => BIN_BODY_ID + 2 * k;
export const lidBodyId = (k) => BIN_BODY_ID + 2 * k + 1;

// About a 96 gal (363 L) wheeled bin: 1.07 m tall with the lid, 0.74 m deep, 0.62 m wide.
export const BIN = {
  BODY_Y: 0.52,
  BODY: { c: [0, 0, 0], h: [0.34, 0.52, 0.30] },
  LID: { c: [0.02, 0.537, 0], h: [0.37, 0.015, 0.32] },      // (closed, in the bin's frame)
  HINGE: [-0.365, 0.537, 0],                                 // along z, through the back edge of the lid
  LID_OPEN: 3.5,                                             // rad a press drives the lid toward: past 180°, onto the handle bar
  WHEELS: [[-0.37, -0.40, 0.24], [-0.37, -0.40, -0.24]], WHEEL_R: 0.12,
  HANDLE: [-0.42, 0.46, 0], HANDLE_H: [0.03, 0.03, 0.26],    // the bar across the back, under the hinge
  // where it is parked: chipper-local (x, z), the drawbar end on the chute side, clear of the chute's spray
  PARK: [1.6, 1.7],
};

/** The lid's pose in the bin's frame, opened by angle a (rad) about the hinge: {c:[3], q:[4]}. */
export function lidPose(a) {
  const H = BIN.HINGE, L = BIN.LID.c, dx = L[0] - H[0], dy = L[1] - H[1], c = Math.cos(a), s = Math.sin(a);
  return { c: [H[0] + dx * c - dy * s, H[1] + dx * s + dy * c, L[2]], q: [0, 0, Math.sin(a / 2), Math.cos(a / 2)] };
}
