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
  PEER_PREFIX: 'arborism-',

  // --- wood (green hardwood) ---
  DENSITY: 900,            // kg/m^3
  MOR: 30e6,               // Pa, modulus of rupture (tension failure in bending)
  SHEAR: 8e6,              // Pa
  GRAVITY: 9.81,
  OVERLOAD_WATCH: 0.8,     // utilisation above which a section is created at a joint
  SNAP_FACTOR: 3,          // tension > this * MOR tears the whole section at once
  TEAR_FRACTION: 0.05,     // fraction of cells that may tear per tick
  CONTACT_TAU: 0.04,       // s, low-pass on contact-force loads
  CONTACT_MIN: 150,        // N, contact-force event threshold
  DEBRIS_MASS: 2,          // kg, pieces lighter than this are removed...
  DEBRIS_LIFE: 10,         // ...this many seconds after creation

  // --- section (cut cross-section) ---
  GRID: 17,                // cells across the diameter
  KERF_WIDTH: 0.008,       // m
  COMP: 12e6,              // Pa, compressive yield: above this the wood crushes and kerfs close
  KERF_CONTACT: 0.5,       // relative stiffness of a closed kerf in compression
  HINGE_MAX_THICK: 0.22,   // strip thickness / diameter below which wood hinges
  HINGE_MIN_ASPECT: 2,     // strip length / thickness
  FIBRE_K: 0.12,           // theta_fibre = FIBRE_K / (thickness/diameter)
  FIBRE_MIN: 0.2, FIBRE_MAX: 1.6,   // rad
  HINGE_RESIST: 0.5,       // hinge resisting moment as a fraction of the moment driving it when it formed

  // --- chainsaw ---
  FEED: 0.05,              // m/s at full throttle
  PINCH_STUCK: 3000,       // N of kerf compression that stops the bar
  SAW_REACH: 2.4,          // m from chest to cut point
  SAW_MIN_R: 0.015,
  TILT_MAX: 1.2,           // rad

  // --- rope ---
  ROPE_EA: 200e3,          // N (stiffness * length)
  ROPE_BREAK: 25e3,        // N
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
