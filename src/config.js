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
  LOOK_SENS: 0.008,         // rad of look per pixel of mouse travel
  TOUCH_LOOK_SENS: 0.006,  // rad of look per pixel a finger drags on the right of the screen
  TOUCH_SAW_SENS: 1.5,     // touch: the bar pivots this many times as far per pixel as with the mouse (SAW_SENS)
  LEAVE_GUARD: true,       // in a game, Back / swipe-back asks before leaving, and so does closing the tab (src/leave.js)
  TOUCH_STICK_R: 60,       // px a thumb moves from where it landed for full speed (CSS px)
  // --- view (all in the Tab menu) ---
  BARK_OPACITY: 1,         // 0 = bark hidden, 1 = solid bark (the test viewer starts from TEST_DEFAULTS instead)
  SHOW_FIBRES: true,       // draw every fibre
  STRESS_COLORS: true,     // colour fibres by load (off: plain wood)
  LEAF_OPACITY: 0.7,
  EYE: 0.65,               // m, eye height above the body centre
  DOWN_EYE: 0.1524,        // m (6 in): eye height above the ground while down (the view is also turned on its side)
  WOBBLE: 0.08,            // rad, how far the view swims while shaken (0 = steady)
  WOBBLE_HZ: 0.6,          // how fast it swims (cycles per second)
  IMPERIAL: true,          // HUD numbers in feet, pounds, mph... (the settings menu stays in SI)
  DRAW_DIST: 150,          // m, how far the view draws while the frame rate keeps up (the camera's far plane)
  DRAW_DIST_MIN: 50,       // m, the shortest it rides down to while the frame rate is low
  DRAW_FPS: 40,            // frames per second: below this the draw distance shrinks; above it by 10% it grows back
  DRAW_ADAPT: 0.25,        // fraction of the draw distance it shrinks by per second while too slow (it grows back at a fifth of this)
  AUTO_FOG: true,          // fog thickens towards the draw distance so the far edge fades into the sky instead of being clipped
  FOG_START: 0.3,          // fog begins at this fraction of the draw distance
  WEEDS: true,             // tufts of long grass along the foot of fences, sheds, houses and tree trunks (drawing only)
  WEEDS_DENSITY: 8,        // tufts per metre of edge
  WEEDS_HEIGHT: 0.45,      // m, height of an average tuft
  WEEDS_DIST: 60,          // m, weeds further from the eye than this are not drawn
  PEER_PREFIX: 'arborism-',

  // --- sky: sun, moon and headlamps (view/sky.js; the host keeps the clock and sends it in aux) ---
  DAY_LENGTH: 1200,        // s of play for one whole day and night (0 = time stands still)
  DAY_START: 0.3,          // time of day the game starts at (0 = midnight, 0.25 = sunrise, 0.5 = noon, 0.75 = sunset)
  MOON_DAYS: 8,            // days from one full moon to the next (it changes phase each noon)
  SUN_LIGHT: 2.0,          // intensity of sunlight with the sun high
  MOON_LIGHT: 0.35,        // intensity of moonlight under a full moon; it scales with how much of the moon is lit
  NIGHT_AMBIENT: 0.06,     // sky glow on a moonless night (the ambient light is 1.2 at noon)
  MOON_AMBIENT: 0.22,      // extra sky glow under a full moon, scaled the same way as MOON_LIGHT
  STARS: 1,                // how bright the stars are on a dark night (0 = none)
  HEADLAMPS: true,         // players switch headlamps on when the sun goes down
  HEADLAMP: 14,            // candela: brightness of a headlamp (lights a surface 1 m away with this, 3 m away with a ninth)
  HEADLAMP_ANGLE: 0.45,    // rad, half-width of a headlamp's beam
  // clouds: the host drifts one number, cover (0 clear .. 1 overcast), and sends it with the clock
  CLOUDS: -1,              // -1 = the weather changes by itself; 0..1 = hold the cover there
  CLOUD_HOURS: 3,          // game hours, about how long between changes in the weather
  CLOUD_CHANGE: 120,       // s of play for the cover to go all the way from clear to overcast
  CLOUD_DIM: 0.85,         // fraction of sunlight and moonlight that full cover blocks
  CLOUD_WIND: 0.6,         // m/s the cloud layer drifts overhead

  // --- wood (green hardwood) ---
  DENSITY: 900,            // kg/m^3
  MOR: 30e6,               // Pa, modulus of rupture (tension failure in bending)
  SHEAR: 8e6,              // Pa
  GRAVITY: 9.81,
  CONTACT_TAU: 0.04,       // s, low-pass on contact-force loads
  CONTACT_MIN: 150,        // N, contact-force event threshold
  ROLL_RESIST: 0.02,       // m, rolling resistance of loose wood on the ground: lever arm of the normal force
  GROUND_PUSH_K: 1000,     // 1/s^2: wood inside the ground (D84) is pushed out like a spring: this x its share of the body's mass per m it is in (1000: about 1 cm under its own weight)...
  GROUND_PUSH_MAX: 0.05,   // m: ...counting at most this depth...
  GROUND_PUSH_DAMP: 40,    // 1/s: ...less this per m/s it is moving out of the ground (more per m/s into it)
  DEBRIS_MASS: 2,          // kg, pieces lighter than this are removed...
  DEBRIS_LIFE: 10,         // ...this many seconds after creation

  // --- world seed: one word for the tree, the ground and the yards (model/seed.js; applied when a tree grows) ---
  WORLD_SEED: '',          // '' = use TREE_SEED, TERRAIN_SEED and YARD_SEED as they are (the engine tests); the game picks a random word

  // --- tree generation (applied by "Grow a new tree" in the Tab menu) ---
  TREE_SEED: 7,
  TREE_HEIGHT: 22,         // m
  TREE_DIAMETER: 1.2,      // m at the base
  BRANCH_DENSITY: 1,       // 1 = a limb roughly every metre of trunk
  BRANCH_LENGTH: 1,        // multiplier
  SEG_CAP: 900,            // stop adding branches once the tree has this many segments
  SEG_LEN: 0.8,            // m, length of a fibre segment (how finely stems are divided along their length)

  // --- the ground (model/terrain.js; made again with every new tree) ---
  TERRAIN_SEED: 3,         // shape of the hills and ledges
  TERRAIN_SIZE: 200,       // m, side of the square of ground (centred on the tree)
  TERRAIN_CELL: 0.5,       // m between ground heights (a ledge is at least this wide)
  TERRAIN_HILL_H: 2,       // m, about how high the hills rise and fall (0 = no hills)
  TERRAIN_HILL_W: 35,      // m, about how far from one hilltop to the next
  TERRAIN_LEDGES: 4,       // ledge levels across the ledge field (0 = no ledges)
  TERRAIN_LEDGE_H: 0.8,    // m, height of one ledge (stepping off one at 0.8 m lands under DV_SHAKEN)
  TERRAIN_LEDGE_W: 40,     // m, scale over which ledges wind (bigger = fewer, longer ledges)
  TERRAIN_LEDGE_SHARP: 0.015, // fraction of the gap between two ledges taken by the riser (smaller = steeper)
  TERRAIN_LEDGE_GAPS: 0.3, // about what fraction of a ledge's length eases into a slope you can walk up
  TERRAIN_CCD: 0.5,        // m a moving body looks ahead for ground contacts (the ground is a surface with nothing under it)
  TERRAIN_BLEND: 4,        // m over which level ground (under houses, sheds and patios) blends into the hills

  // --- concrete pavers round the tree (laid again, undamaged, with every new tree) ---
  PAVER_SIZE: 0.6,         // m, a paver is PAVER_SIZE x PAVER_SIZE / 2 (two to a basket-weave cell)
  PAVER_RADIUS: 0.5,       // largest paving round the trunk (its radius), as a fraction of TREE_HEIGHT; the lot may allow less
  PAVER_PIT: 0.3,          // m of open soil left between the trunk and the nearest paver (at least)
  PAVER_CRACK_E: 800,      // J of impact energy on one paver that cracks it; each hit adds (its energy / this) damage
  PAVER_MAX_SLOPE: 0.5236, // rad (30°): no paver is laid on ground steeper than this
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
  CUT_RATE: 0.02,          // m^2 of wood cross-section the chain clears per second at full throttle
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
  WALK_SLOPE: 0.785,       // rad (45°): ground up to this steep is stood on (the legs work on it)
  JUMP_SLOPE: 1.22,        // rad (70°): sliding on ground up to this steep (a ledge face), a jump still pushes off it
  CLIMB: 1.1,              // m/s along the stem
  AROUND: 1.4,             // m/s around the stem
  CLIMB_BOUNCE: 1.6,       // weight multiplier while moving on spurs
  STANDOFF: 0.38,          // m from bark to body centre
  SPUR_MIN_R: 0.03,
  STEM_BEND: 0.35,         // rad: a child segment turning less than this from its parent carries on the same stem (the lanyard slides onto it)
  STUB_LEN: 0.8,           // m: a branch jutting out less than this past the bark does not block the lanyard
  REACH: 2.6,              // m, interact reach
  DV_SHAKEN: 4, DV_HURT: 7, DV_DOWN: 11,   // m/s impact thresholds (sudden change of velocity)
  SHAKEN_TIME: 2,          // s a shaken player has no control (a hurt player is shaken first too)
  // --- controls that take time (hold the button; let go to cancel) ---
  LANYARD_TIME: 2,         // s of holding {interact} to spur in or move the lanyard
  LETGO_TIME: 4,           // s of holding {drop} to let go of the tree
  // --- punch ({punch}): every press adds a short shove; presses faster than it fades stack up ---
  PUNCH_FORCE: 400,        // N added by one punch, along the look direction at the point hit
  PUNCH_DECAY: 0.12,       // s, time constant the shove fades with (one punch is about FORCE * DECAY N*s)
  PUNCH_MAX: 4000,         // N, most that stacked punches add up to
  // --- grabbing wood on the ground ({interact} toggles): a short rope from the hands to the point grabbed ---
  GRAB_K: 20000,           // N/m, stiffness of that rope (capped for stability on light pieces)
  GRAB_STEER: 3000,        // N/m: walking with what can move in hand, the arms keep it on the line of the walk (at most LEG_FORCE)
  GRAB_TAU: 0.1,           // s over which the force on the hands is averaged before it can tear the hold out
  GRAB_MAX: 2500,          // N, pull at which the wood is pulled out of the player's hands
  LEG_FORCE: 1000,         // N, most a player's legs push the body across the ground with: walking, pushing and pulling alike (keep under GRAB_MAX)
  GRAB_HEIGHT: 0.3,        // m, hands above the body centre
  // --- wood chipper (sim/chipper.js): a towable chipper on two wheels and a jockey wheel ---
  CHIP_MASS: 350,          // kg (applies when it is put back by a new tree or respawned)
  CHIP_GAP: 3,             // m between the tree's paving (or the trunk) and the chipper, where it is parked
  CHIP_PULL: 15000,        // N, most the feed rollers pull with (on wood and on rope); they slip past it
  CHIP_FEED_V: 0.6,        // m/s the feed rollers draw wood and rope in
  CHIP_ROLL: 0.02,         // rolling resistance of its wheels, as a fraction of the weight on them
  CHIP_BRAKE: 0.7,         // braked wheels (whenever nobody holds the grip), as a fraction of the weight on them
  CHIP_GRIP: 0.9,          // sideways grip of the tyres (friction coefficient)
  CHIP_BREAK_F: 120000,    // N of contact force in one step, from wood or a structure's parts, that crumples it
  CHIP_CARRY: 0.04,        // m3 of chips a player can carry (an armful, about 40 L)
  CHIP_CAPACITY: 150,      // kg: the heaviest contiguous piece the rollers take; heavier wood seizes them until it is sawn
  CHIP_SWELL: 2.5,         // m3 of loose chips per m3 of wood chipped
  // --- breakable structures (sim/builds.js): the shed; rigid until hit hard enough, then loose boards ---
  SHED_BREAK_F: 25000,     // N of contact force from wood in one tick that breaks a module (the shed) apart
  FENCE_BREAK_F: 10000,    // N of contact force from wood in one tick that breaks one fence section apart
  HOUSE_BREAK_F: 40000,    // N of contact force from wood in one tick that breaks one room of a house apart
  HOUSE_RAISE: 0.15,       // m a house's floor stands above the highest ground under it (its foundation shows)
  // --- yards (model/yards.js): lots of houses, sheds, fences and paving round the tree's own lot ---
  YARD_SEED: 1,            // layout of the yards
  YARD_DENSITY: 0.5,       // 0..1: chance of a house, shed, patio... on each lot; lots shrink as it rises
  YARD_LOT_MAX: 30,        // m, lot width at density 0 (lots are about 1.4 times as deep)
  YARD_LOT_MIN: 14,        // m, lot width at density 1
  YARD_EXTENT: 45,         // m from the tree that lots reach (0 = only the tree's own lot)
  YARD_STREET: 9,          // m, street between blocks of lots
  YARD_FENCE: 0.5,         // chance a lot is fenced round its sides and back
  YARD_TREE_CLEAR: 4,      // m beyond the trunk kept clear of houses, sheds and the chipper (players spawn 4 m from the tree)
  // --- other trees in the yards (model/stands.js): drawn, with only a trunk to bump into, until someone saws or climbs one ---
  YARD_TREES: 1.5,         // trees per lot, on average (as many as fit)
  YARD_TREES_HMIN: 8,      // m, shortest
  YARD_TREES_HMAX: 16,     // m, tallest
  YARD_TREES_THICK: 0.045, // m of trunk diameter per metre of height
  YARD_TREES_PITCH: 0.06,  // m, fibre width once one comes to life (FIBRE_PITCH is the job tree's): wider = fewer fibres, cheaper
  MARK_HEIGHT: 1.4,        // m above the ground of the orange X sprayed on the job tree
  // --- what breaking things costs (sim/damage.js), in dollars, added to a running total on the HUD ---
  PAVER_COST: 25,          // one paver, the first time it cracks
  FENCE_COST: 300,         // one fence section broken apart
  SHED_COST: 2500,         // the shed broken apart
  HOUSE_COST: 20000,       // one room of a house broken apart
  CHIPPER_COST: 45000,     // the chipper truck wrecked
  SHED_DENSITY: 450,       // kg/m3 of the shed's and fences' boards
};

// The values above as shipped, before the Tab menu loads saved settings over them (the test runner starts from these).
export const CFG_DEFAULTS = Object.freeze({ ...CFG });
// What the test runner and its viewer start from instead: the same, except that tests are watched for their
// fibres, so the bark starts hidden there (the viewer's Tune panel can still change it), and tests keep the
// smaller tree they were written for (play grows the bigger one, D75).
export const TEST_DEFAULTS = Object.freeze({ ...CFG_DEFAULTS, BARK_OPACITY: 0, TREE_HEIGHT: 11, TREE_DIAMETER: 0.54 });

export const INJ = { OK: 0, SHAKEN: 1, HURT: 2, DOWN: 3 };
export const INJ_NAME = ['ok', 'shaken', 'HURT', 'DOWN'];
export const MODE = { GROUND: 0, CLIMB: 1, ROPE: 2 };
