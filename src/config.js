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
  LOOK_SENS: 0.0025,       // rad of look per pixel of mouse travel
  // --- view (all in the Tab menu) ---
  BARK_OPACITY: 0,         // 0 = bark hidden, 1 = solid bark
  SHOW_FIBRES: true,       // draw every fibre
  STRESS_COLORS: true,     // colour fibres by load (off: plain wood)
  LEAF_OPACITY: 0.25,
  EYE: 0.65,               // m, eye height above the body centre
  PEER_PREFIX: 'arborism-',

  // --- wood (green hardwood) ---
  DENSITY: 900,            // kg/m^3
  MOR: 30e6,               // Pa, modulus of rupture (tension failure in bending)
  SHEAR: 8e6,              // Pa
  GRAVITY: 9.81,
  CONTACT_TAU: 0.04,       // s, low-pass on contact-force loads
  CONTACT_MIN: 150,        // N, contact-force event threshold
  ROLL_RESIST: 0.02,       // m, rolling resistance of loose wood on the ground: lever arm of the normal force
  DEBRIS_MASS: 2,          // kg, pieces lighter than this are removed...
  DEBRIS_LIFE: 10,         // ...this many seconds after creation

  // --- tree generation (applied by "Grow a new tree" in the Tab menu) ---
  TREE_SEED: 7,
  TREE_HEIGHT: 11,         // m
  TREE_DIAMETER: 0.54,     // m at the base
  BRANCH_DENSITY: 1,       // 1 = a limb roughly every metre of trunk
  BRANCH_LENGTH: 1,        // multiplier
  SEG_CAP: 900,            // stop adding branches once the tree has this many segments
  SEG_LEN: 0.8,            // m, length of a fibre segment (how finely stems are divided along their length)

  // --- concrete pavers round the tree (laid again, undamaged, with every new tree) ---
  PAVER_SIZE: 0.6,         // m, a paver is PAVER_SIZE x PAVER_SIZE / 2 (two to a basket-weave cell)
  PAVER_RADIUS: 0.5,       // paved circle round the trunk, as a fraction of TREE_HEIGHT (whole pavers only)
  PAVER_PIT: 0.3,          // m of open soil left between the trunk and the nearest paver (at least)
  PAVER_CRACK_E: 800,      // J of impact energy on one paver that cracks it; each hit adds (its energy / this) damage
  PAVER_GRAVEL: 30,        // damage at which a paver is drawn as gravel (the counter goes on past it)

  // --- fibres (every segment is a bundle of them) ---
  FIBRE_PITCH: 0.03,       // m, target fibre width; a segment gets round(diameter / pitch) fibres across
  GRID_MAX: 17,            // most fibres across a diameter
  KERF_WIDTH: 0.008,       // m
  COMP: 12e6,              // Pa, compressive yield: above this the wood crushes and kerfs close
  KERF_CONTACT: 0.5,       // relative stiffness of a closed kerf in compression (static analysis)
  TENS_STRAIN: 0.006,      // how much a fibre has stretched, as a fraction of its length, when it reaches MOR
  COMP_STRAIN: 0.009,      // how much a fibre has shortened, as a fraction of its length, when it starts to crush
                           // (so its stiffness is MOR / TENS_STRAIN in tension and COMP / COMP_STRAIN in compression)
  FLEX_FREQ: 9,            // rad/s, how fast bending follows a change of load (the bounce)
  FLEX_DAMP: 0.35,         // damping ratio of that bounce (1 = no bounce)
  FIBRE_STRETCH: 0.02,     // m, elongation at which a fibre snaps (it stretches plastically in between)
  FIBRE_PLY: 0.01,         // m, a fibre bundle folds like layers this thick sliding on each other (FIBRE_PITCH or more = one solid block)
  FIBRE_SLIP: 0.03,        // m, sideways slip at which a fibre shears off
  PART_OVERLAP: 0.01,      // m: two pieces that were joined start colliding once they overlap by less than this
  BOND_LEN: 0.05,          // m, length along the grain over which neighbouring fibres are bonded (SHEAR acts over it)
  FIBRE_DAMP: 0.01,        // s, stiffness-proportional damping of a live bundle
  BEND_MAX: 3.14,          // rad, no fibre survives being folded further than this (3.14 = folded right over)
  LIVE_COMP_X: 1,          // how many times COMP a live fibre bears in compression before it crushes (D54)
  BREAK_STRAIN: 0,         // a live fibre snaps once stretched this fraction of its length (0 = use FIBRE_STRETCH instead)
  SURGE_RATIO: 2,          // a live fibre snaps if its pull grows this many times within SURGE_TIME (0 = off)
  SURGE_TIME: 0.2,         // s
  SURGE_MIN: 0.03,         // ... counting only from a pull of at least this fraction of its tensile strength
  FOLD_DAMP: 0.1,          // s, drag on folding fibres (plies rubbing): this times a solid fibre's bending stiffness
  COLOR_GAMMA: 0.6,        // debug fibre colours: (stress / limit) ^ gamma

  // --- chainsaw ---
  BAR_LEN: 0.5,            // m
  CUT_RATE: 0.012,         // m^2 of wood cross-section the chain clears per second at full throttle
  SAW_FEED: 0.3,           // m/s the bar moves forward under full throttle when nothing is in the way
  SAW_REACH: 2.0,          // m from the eyes to where the bar can be planted
  SAW_SENS: Math.PI,       // rad the bar pivots per screen-width of mouse travel
  PINCH_STUCK: 3000,       // N of kerf compression that stops the bar

  // --- rope ---
  ROPE_EA: 200e3,          // N (stiffness * length)
  ROPE_BREAK: 25e3,        // N
  ROPE_RADIUS: 0.02,       // m, drawn (and cut) thickness
  ROPE_CUT_TIME: 0.15,     // s of a running chain on a rope or lanyard before it parts
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
  // --- controls that take time (hold the button; let go to cancel) ---
  LANYARD_TIME: 4,         // s of holding {interact} to spur in or move the lanyard
  LETGO_TIME: 4,           // s of holding {drop} to let go of the tree
  // --- punch ({punch}): every press adds a short shove; presses faster than it fades stack up ---
  PUNCH_FORCE: 400,        // N added by one punch, along the look direction at the point hit
  PUNCH_DECAY: 0.12,       // s, time constant the shove fades with (one punch is about FORCE * DECAY N*s)
  PUNCH_MAX: 4000,         // N, most that stacked punches add up to
  // --- grabbing wood on the ground ({interact} toggles): a short rope from the hands to the point grabbed ---
  GRAB_K: 20000,           // N/m, stiffness of that rope (capped for stability on light pieces)
  GRAB_MAX: 600,           // N, pull at which the wood is pulled out of the player's hands
  GRAB_HEIGHT: 0.3,        // m, hands above the body centre
};

// The values above as shipped, before the Tab menu loads saved settings over them (the test runner starts from these).
export const CFG_DEFAULTS = Object.freeze({ ...CFG });

export const INJ = { OK: 0, SHAKEN: 1, HURT: 2, DOWN: 3 };
export const INJ_NAME = ['ok', 'shaken', 'HURT', 'DOWN'];
export const MODE = { GROUND: 0, CLIMB: 1, ROPE: 2 };
