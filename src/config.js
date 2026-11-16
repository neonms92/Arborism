// Every tunable number lives here. Units are SI (m, kg, s, N, Pa) unless noted.
// Tune here first; change code only if a number cannot express what you want.

export const CFG = {
  // --- loop / net ---
  TICK: 1 / 60,            // sim step
  SNAP_EVERY: 3,           // ticks between snapshots (20 Hz)
  AUX_EVERY: 6,            // ticks between aux packets (10 Hz)
  FULL_EVERY: 60,          // ticks between full (all bodies) snapshots
  INTERP_DELAY: 0.1,       // s, client render delay
  INPUT_HZ: 30,
  INVERT_Y: true,          // push forward / mouse forward looks down
  DEBUG_FIBRES: true,      // start with bark hidden and every fibre drawn (Tab / Back toggles)
  EYE: 0.65,               // m, eye height above the body centre
  PEER_PREFIX: 'arborism-',

  // --- wood (green hardwood) ---
  DENSITY: 900,            // kg/m^3
  MOR: 30e6,               // Pa, modulus of rupture (tension failure in bending)
  SHEAR: 8e6,              // Pa
  GRAVITY: 9.81,
  CONTACT_TAU: 0.04,       // s, low-pass on contact-force loads
  CONTACT_MIN: 150,        // N, contact-force event threshold
  DEBRIS_MASS: 2,          // kg, pieces lighter than this are removed...
  DEBRIS_LIFE: 10,         // ...this many seconds after creation

  // --- fibres (every segment is a bundle of them) ---
  FIBRE_PITCH: 0.03,       // m, target fibre width; a segment gets round(diameter / pitch) fibres across
  GRID_MAX: 17,            // most fibres across a diameter
  KERF_WIDTH: 0.008,       // m
  COMP: 12e6,              // Pa, compressive yield: above this the wood crushes and kerfs close
  KERF_CONTACT: 0.5,       // relative stiffness of a closed kerf in compression (static analysis)
  FIBRE_YIELD: 0.0015,     // m, elongation at which a fibre reaches MOR (sets its stiffness)
  FIBRE_STRETCH: 0.02,     // m, elongation at which a fibre snaps (it stretches plastically in between)
  FIBRE_SLIP: 0.03,        // m, sideways slip at which a fibre shears off
  FIBRE_DAMP: 0.01,        // s, stiffness-proportional damping of a live bundle
  BEND_MAX: 1.6,           // rad, no fibre survives being folded further than this
  COLOR_GAMMA: 0.6,        // debug fibre colours: (stress / limit) ^ gamma

  // --- chainsaw ---
  BAR_LEN: 0.5,            // m
  CUT_TIME: 0.35,          // s of full throttle to sever the fibres the bar is resting on
  BAR_SPEED: 1.2,          // m/s, how fast the bar follows the hands when nothing is in the way
  PINCH_STUCK: 3000,       // N of kerf compression that stops the bar
  SAW_HOLD: 0.45,          // m in front of the eyes that the hands hold the saw
  SAW_YANK: 0.9,           // m: if the hands get this far from a blocked bar it pulls free

  // --- rope ---
  ROPE_EA: 200e3,          // N (stiffness * length)
  ROPE_BREAK: 25e3,        // N
  ROPE_RADIUS: 0.02,       // m, drawn (and cut) thickness
  ROPE_KCAP: 0.1,          // k <= KCAP * m / dt^2 (explicit-spring stability)
  ROPE_DAMP: 0.5,          // damping ratio
  ROPE_MU: 0.15,           // friction per radian on the device
  GRIP_MAX: 250,           // N a person can hold
  HAUL_MAX: 500,           // N a person can pull against
  HAUL_SPEED: 1.0,         // m/s
  SLIP_V0: 1.0,            // m/s slip speed at 2x capacity
  WRAPS_MAX: 4,
  DEVICE_RANGE: 2.5,       // m to grab the tail

  // --- player ---
  P_MASS: 85, P_RADIUS: 0.28, P_HALF: 0.6,
  WALK: 3.5, JUMP: 3.4,
  CLIMB: 1.1,              // m/s along the stem
  AROUND: 1.4,             // m/s around the stem
  CLIMB_BOUNCE: 1.6,       // weight multiplier while moving on spurs
  STANDOFF: 0.38,          // m from bark to body centre
  SPUR_MIN_R: 0.03,
  STUB_LEN: 0.3,           // a branch shorter than this does not block the lanyard
  REACH: 2.6,              // m, interact reach
  DV_SHAKEN: 4, DV_HURT: 7, DV_DOWN: 11,   // m/s impact thresholds
  SHAKEN_TIME: 2,
};

export const INJ = { OK: 0, SHAKEN: 1, HURT: 2, DOWN: 3 };
export const INJ_NAME = ['ok', 'shaken', 'HURT', 'DOWN'];
export const TOOL = { HANDS: 0, SAW: 1, ROPE: 2 };
export const TOOL_NAME = ['hands', 'chainsaw', 'rigging rope'];
export const MODE = { GROUND: 0, CLIMB: 1, ROPE: 2 };
