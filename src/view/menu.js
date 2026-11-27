// The Tab menu: a slider and a number box for every variable worth iterating
// on. Each row edits one key of CFG in place, so a change takes effect on the
// next tick or frame. Changed values are kept in localStorage.
//
// To add a variable: put it in config.js and add one line to ROWS.
// Rows marked host only do something on the machine running the simulation
// (the host, or solo); on a joined client they are shown but have no effect.
// Above the rows sits the world seed (CFG.WORLD_SEED, model/seed.js): a word
// for the next tree, ground and yards. It is not remembered between visits.

import { CFG } from '../config.js';
import { randomSeed } from '../model/seed.js';
import { budgetMath, wageMath } from './hud.js';

const KEY = 'arb-settings-v1';
const OPEN_KEY = 'arb-settings-open-v1';   // which sections are expanded
// [config key, label, min, max, step, scale (shown value = CFG value / scale), host only]
export const ROWS = [
  ['Controls'],
  ['SAW_SENS', 'Chainsaw sensitivity (turns of the bar per screen of mouse)', 0.05, 2, 0.05, Math.PI * 2],
  ['LOOK_SENS', 'Look sensitivity (mouse)', 0.5, 10, 0.1, 0.001],
  ['TOUCH_LOOK_SENS', 'Look sensitivity (touch)', 1, 20, 0.5, 0.001],
  ['TOUCH_SAW_SENS', 'Chainsaw sensitivity, touch (times the mouse)', 0.2, 5, 0.1, 1],
  ['TOUCH_STICK_R', 'Touch stick size (px of thumb travel for full speed)', 20, 150, 5, 1],
  ['INVERT_Y', 'Inverted vertical look'],
  ['LEAVE_GUARD', 'Ask before Back or a swipe-back leaves the game'],
  ['LANYARD_TIME', 'Hold time to spur in or move the lanyard (s)', 0, 10, 0.1, 1, true],
  ['LETGO_TIME', 'Hold time to let go of the tree (s)', 0, 10, 0.1, 1, true],
  ['LAND_DIST', 'Climber reaching the ground is put down this far from the stem (m)', 1, 10, 0.5, 1, true],
  ['SPAWN_HEIGHT', 'Respawn / landing height of a player\'s middle over the ground (m)', 0.9, 3, 0.05, 1, true],
  ['PUNCH_FORCE', 'Punch: force added per press (N)', 0, 3000, 10, 1, true],
  ['PUNCH_DECAY', 'Punch: how long each one lasts (s)', 0.02, 1, 0.01, 1, true],
  ['PUNCH_MAX', 'Punch: most force stacked presses reach (N)', 0, 20000, 100, 1, true],
  ['LEG_FORCE', 'Legs: most force you push or pull with (walking into things, or away from what you hold; N)', 50, 5000, 10, 1, true],
  ['GRAB_MAX', 'Pulling: force that tears what you hold out of your hands (N)', 50, 10000, 10, 1, true],
  ['GRAB_CONE', 'Grab assist: angle round the reticle that still grabs loose wood (°)', 0, 20, 0.5, Math.PI / 180, true],
  ['GRAB_K', 'Grabbed wood: stiffness of the hold (N/m)', 500, 100000, 500, 1, true],
  ['View'],
  ['NET_STATS', 'Network and debug info on the HUD (fps, ping, loss, wage math; network box when joined)'],
  ['NET_QUEUE_MAX', 'Most data queued for a player before stale updates are skipped (kB; caps network lag)', 4, 512, 4, 1, true],
  ['NET_LAG_MAX', 'Most delay a slow link may queue before stale updates are skipped (ms)', 50, 2000, 10, 0.001, true],
  ['PREDICT', 'Climbing answers at once when joined (predicted, corrected by the host)'],
  ['PREDICT_BLEND', 'How fast a correction from the host is taken up (per second)', 1, 60, 1, 1],
  ['INTERP_DELAY', 'Render delay when joined (ms; lower answers sooner, too low stutters)', 0, 300, 5, 0.001],
  ['BARK_OPACITY', 'Bark visibility', 0, 1, 0.05, 1],
  ['SHOW_FIBRES', 'Draw fibres'],
  ['STRESS_COLORS', 'Colour fibres by load'],
  ['COLOR_GAMMA', 'Load colour contrast (lower = stronger)', 0.2, 1, 0.05, 1],
  ['LEAF_OPACITY', 'Foliage visibility', 0, 1, 0.05, 1],
  ['IMPERIAL', 'Imperial units on the HUD (ft, lb, mph)'],
  ['WOBBLE', 'How far the view swims while shaken (degrees)', 0, 30, 0.5, Math.PI / 180],
  ['WOBBLE_HZ', 'How fast the view swims while shaken (per second)', 0.1, 3, 0.05, 1],
  ['DOWN_EYE', 'Eye height above the ground while down (cm)', 2, 100, 1, 0.01],
  ['DRAW_DIST', 'Draw distance (m)', 20, 400, 5, 1],
  ['DRAW_DIST_MIN', 'Draw distance: shortest it drops to when the frame rate is low (m)', 10, 400, 5, 1],
  ['DRAW_FPS', 'Draw distance: frame rate below which it drops (fps)', 10, 120, 1, 1],
  ['DRAW_ADAPT', 'Draw distance: how fast it drops (fraction per second; grows back 5x slower)', 0.01, 2, 0.01, 1],
  ['AUTO_FOG', 'Fog hides the edge of the draw distance'],
  ['FOG_START', 'Fog begins at this fraction of the draw distance', 0, 0.95, 0.05, 1],
  ['WEEDS', 'Weeds grow along fences, buildings and tree trunks'],
  ['WEEDS_DENSITY', 'Weeds: tufts per metre of edge', 0.5, 20, 0.5, 1],
  ['WEEDS_HEIGHT', 'Weeds: height of an average tuft (cm)', 5, 120, 1, 0.01],
  ['WEEDS_DIST', 'Weeds: drawn out to this distance (m)', 5, 300, 5, 1],
  ['Day, night and moon'],
  ['DAY_LENGTH', 'Length of a whole day and night (minutes; 0 = time stands still)', 0, 120, 0.5, 60, true],
  ['MOON_DAYS', 'Days from one full moon to the next', 1, 30, 1, 1, true],
  ['@skip', 'Skip ahead', 'Skip ahead to the next sunrise, noon, sunset or midnight'],
  ['SUN_LIGHT', 'Sunlight brightness', 0, 5, 0.05, 1],
  ['MOON_LIGHT', 'Moonlight brightness under a full moon', 0, 2, 0.01, 1],
  ['NIGHT_AMBIENT', 'Sky glow on a moonless night', 0, 1, 0.01, 1],
  ['MOON_AMBIENT', 'Extra sky glow under a full moon', 0, 1, 0.01, 1],
  ['STARS', 'Star brightness', 0, 1, 0.05, 1],
  ['HEADLAMPS', 'Headlamps come on at night'],
  ['HEADLAMP', 'Headlamp brightness (candela)', 0, 100, 1, 1],
  ['HEADLAMP_ANGLE', 'Headlamp beam half-width (degrees)', 5, 80, 1, Math.PI / 180],
  ['FLOOD', 'Chipper floodlights: brightness (candela)', 0, 400, 5, 1],
  ['FLOOD_ANGLE', 'Chipper floodlights: beam half-width (degrees)', 5, 85, 1, Math.PI / 180],
  ['FLOOD_DIM', 'Chipper floodlights: share of light kept while chipping', 0, 1, 0.05, 1],
  ['FLOOD_FLICKER', 'Chipper floodlights: flicker while chipping (0 steady, 1 to black)', 0, 1, 0.05, 1],
  ['LAMPS', 'Streetlights, porch lights and windows at night'],
  ['STREETLIGHT', 'Streetlight brightness (candela)', 0, 400, 1],
  ['STREETLIGHT_POOL_I', 'Streetlight pool on the ground', 0, 1, 0.01],
  ['PORCH', 'Porch light brightness (candela)', 0, 50, 0.5],
  ['LAMP_LIGHTS', 'Lamps near you that shine real light', 0, 12, 1],
  ['LAMP_LIGHTS_PHONE', 'The same on a phone', 0, 12, 1],
  ['CLOUDS', 'Cloud cover (0 clear, 1 overcast; -1 = changes by itself)', -1, 1, 0.05, 1, true],
  ['CLOUD_HOURS', 'Clouds: game hours between changes in the weather', 0.25, 24, 0.25, 1, true],
  ['CLOUD_CHANGE', 'Clouds: time to go from clear to overcast (s)', 5, 1200, 5, 1, true],
  ['CLOUD_DIM', 'Clouds: share of sun and moon light that full cover blocks', 0, 1, 0.05, 1],
  ['CLOUD_WIND', 'Clouds: drift speed (m/s)', 0, 4, 0.05, 1],
  ['FOREST_HEIGHT', 'Far tree line: tree height (m; 0 = none)', 0, 80, 1, 1],
  ['FOREST_DIST', 'Far tree line: distance (m)', 50, 2000, 10, 1],
  ['FOREST_DARK', 'Far tree line: darkness against the sky', 0, 1, 0.05, 1],
  ['FOREST_MIST', 'Far tree line: share of its height lost in the haze', 0, 1, 0.05, 1],
  ['Wood fibres'],
  ['MOR', 'Tension strength (MPa)', 2, 80, 1, 1e6, true],
  ['COMP', 'Crushing strength (MPa)', 1, 60, 1, 1e6, true],
  ['TENS_STRAIN', 'Tension deformation: stretch at full tension strength (% of length)', 0.05, 10, 0.05, 0.01],
  ['COMP_STRAIN', 'Compression deformation: shortening at crushing strength (% of length)', 0.05, 10, 0.05, 0.01],
  ['FLEX_FREQ', 'Bounce speed (rad/s)', 2, 30, 0.5, 1],
  ['FLEX_DAMP', 'Bounce damping (1 = none)', 0.05, 1.5, 0.05, 1],
  ['FIBRE_STRETCH', 'Stretch at which a fibre snaps (mm)', 2, 80, 1, 0.001, true],
  ['FIBRE_PLY', 'Fold ply: how thin the layers a folded fibre acts as (mm)', 1, 30, 0.5, 0.001, true],
  ['FIBRE_SLIP', 'Sideways slip at which a fibre shears (mm)', 5, 100, 1, 0.001, true],
  ['SHEAR', 'Shear strength along the grain (MPa). Lower = wood splits lengthwise more readily', 1, 30, 0.5, 1e6, true],
  ['BOND_LEN', 'Fibre bond length (mm). Longer = cracks run across, shorter = wood splits along the grain', 5, 300, 5, 0.001],
  ['BEND_MAX', 'Fold angle no fibre survives (rad)', 0.2, 3.15, 0.05, 1, true],
  ['LIVE_COMP_X', 'Moving wood: compression strength × COMP', 1, 2000, 1, 1, true],
  ['BREAK_STRAIN', 'Moving wood: stretch at which a fibre snaps (fraction of its length, 0 = use the mm value)', 0, 1, 0.01, 1, true],
  ['SURGE_RATIO', 'Moving wood: snap if a fibre\'s pull grows this many times... (0 = off)', 0, 10, 0.1, 1, true],
  ['SURGE_TIME', '...within this time (s)', 0.02, 1, 0.01, 1, true],
  ['SURGE_MIN', '...counting from at least this fraction of its strength', 0, 1, 0.01, 1, true],
  ['FOLD_DAMP', 'Drag on folding fibres (s)', 0, 1, 0.01, 1, true],
  ['DENSITY', 'Wood density (kg/m3)', 200, 1400, 10, 1, true],
  ['ROLL_RESIST', 'How hard the ground stops a log rolling (cm; 0 = rolls for ever)', 0, 10, 0.5, 0.01],
  ['GROUND_LIFT_V', 'Wood stuck in the ground: speed it rises out at (m/s)', 0, 3, 0.05, 1, true],
  ['GROUND_LIFT_TIME', 'Wood stuck in the ground: each lift lasts (s)', 0.02, 2, 0.02, 1, true],
  ['Wood chipper'],
  ['CHIP_PULL', 'Feed rollers: most they pull with (N)', 500, 40000, 100, 1, true],
  ['CHIP_CAPACITY', 'Feed rollers: heaviest piece they take before seizing (kg)', 5, 2000, 5, 1, true],
  ['CHIP_FEED_V', 'Feed rollers: speed (m/s)', 0.05, 3, 0.05, 1, true],
  ['CHIP_WINCH_F', 'Hopper winch: most pull (kN)', 0.5, 30, 0.5, 1000, true],
  ['CHIP_ROLL', 'Wheels: rolling resistance while towed (fraction of weight)', 0, 0.3, 0.005, 1, true],
  ['CHIP_BRAKE', 'Wheels: brakes when nobody holds the grip (fraction of weight)', 0, 1.5, 0.05, 1, true],
  ['CHIP_MASS', 'Mass (kg, applies at the next new tree)', 100, 5000, 50, 1, true],
  ['CHIP_SWELL', 'Chips: loose volume per volume of wood', 1, 5, 0.1, 1, true],
  ['CHIP_CARRY', 'Chips a player can carry (litres)', 1, 500, 1, 0.001, true],
  ['BIN_RIGHT_T', 'Chip bin: seconds it is stood back up for after you let go (0 = off)', 0, 10, 0.5, 1, true],
  ['BIN_RIGHT_K', 'Chip bin: how hard it is stood back up (1/s²)', 1, 200, 1, 1, true],
  ['BIN_CATCH', 'Chip bin: how far past its rim chips landing still go in (m)', 0, 2, 0.05, 1, true],
  ['BIN_LID_K', 'Chip bin: how hard a press swings the lid (1/s²)', 10, 1000, 10, 1, true],
  ['BIN_HINGE_DAMP', 'Chip bin: friction in the lid hinge (1/s)', 0, 20, 0.1, 1, true],
  ['CHIP_BREAK_F', 'Hit that crumples it (kN, from wood or a structure)', 1, 500, 1, 1000, true],
  ['@chipper', 'Buy a new chipper', 'Buy another chipper (CHIPPER_PRICE off the cash), parked near where the first one was; the ones you have stay'],
  ['CHIP_MAX', 'Most chippers at once (the buy button stops there)', 1, 20, 1, 1, true],
  ['@bin', 'Buy a new chip bin', 'A 96 gallon chip bin, put down in front of you. Chips in a bin are gone: it has no bottom'],
  ['Houses, sheds and fences (breakable structures)'],
  ['HOUSE_BREAK_F', 'House: force from wood that breaks one room apart (N)', 500, 400000, 500, 1, true],
  ['SHED_BREAK_F', 'Shed: force from wood that breaks it apart (N)', 500, 200000, 500, 1, true],
  ['FENCE_BREAK_F', 'Fence: force from wood that breaks one section apart (N)', 500, 200000, 500, 1, true],
  ['DEBRIS_FREEZE', 'Broken pieces become scenery (no collision) after (s)', 1, 600, 1, 1, true],
  ['SHED_DENSITY', 'Board density (kg/m3)', 100, 1200, 10, 1, true],
  ['Money: budget, wages and damage'],
  ['BUDGET_BASE', 'Budget for the reference tree ($; applies when you press Grow)', 0, 100000, 500, 1, true],
  ['BUDGET_REF_H', 'Reference tree height (m)', 1, 40, 0.1, 1, true],
  ['BUDGET_REF_D', 'Reference tree diameter (m)', 0.1, 3, 0.05, 1, true],
  ['BUDGET_LOT_REF', 'Reference lot width (m)', 8, 60, 1, 1, true],
  ['WAGE', 'Wage per player per game hour ($)', 0, 100, 0.25, 1, true],
  ['PAVER_COST', 'Cost of a cracked paver ($)', 0, 500, 5, 1, true],
  ['FENCE_COST', 'Cost of a broken fence section ($)', 0, 5000, 25, 1, true],
  ['SHED_COST', 'Cost of a smashed shed ($)', 0, 20000, 100, 1, true],
  ['HOUSE_COST', 'Cost of a smashed room of a house ($)', 0, 200000, 500, 1, true],
  ['CHIPPER_PRICE', 'Price of a new chipper ($, the Buy a new chipper button)', 0, 100000, 500, 1, true],
  ['CHIPPER_COST', 'Cost of a wrecked chipper truck ($)', 0, 200000, 500, 1, true],
  ['YARD_CUT_COST', "Sawing into a neighbour's tree ($ per m2 sawn)", 0, 50000, 100, 1, true],
  ['YARD_LOSS_COST', "Wood off a neighbour's tree ($ per kg)", 0, 100, 0.5, 1, true],
  ['YARD_FELL_COST', "Felling a neighbour's tree, extra ($)", 0, 100000, 500, 1, true],
  ['LINE_COST', 'Cost of a power line brought down ($)', 0, 100000, 500, 1, true],
  ['POLE_FELL_COST', 'Felling a utility pole, extra ($)', 0, 100000, 500, 1, true],
  ['BIN_PRICE', 'Price of a new chip bin ($)', 0, 1000, 5, 1, true],
  ['New tree (these apply when you press Grow)'],
  ['TREE_HEIGHT', 'Height (m)', 3, 30, 0.5, 1, true],
  ['TREE_DIAMETER', 'Trunk diameter at the base (m)', 0.1, 1.5, 0.02, 1, true],
  ['BRANCH_DENSITY', 'Branch density (1 = a limb about every metre)', 0, 3, 0.1, 1, true],
  ['BRANCH_LENGTH', 'Branch length (multiplier)', 0.2, 3, 0.1, 1, true],
  ['FIBRE_PITCH', 'Fibre density: fibre width (mm). Smaller = more fibres', 8, 100, 1, 0.001, true],
  ['GRID_MAX', 'Most fibres across one stem', 3, 25, 2, 1, true],
  ['SEG_LEN', 'Fibre segment length (m)', 0.15, 2, 0.05, 1, true],
  ['Ground (applies when you press Grow)'],
  ['TERRAIN_HILL_H', 'Hill height (m; 0 = no hills)', 0, 6, 0.1, 1, true],
  ['TERRAIN_HILL_W', 'Hill spacing: hilltop to hilltop (m)', 5, 120, 1, 1, true],
  ['TERRAIN_LEDGES', 'Ledge levels (0 = no ledges)', 0, 10, 1, 1, true],
  ['TERRAIN_LEDGE_H', 'Ledge height (m)', 0, 4, 0.05, 1, true],
  ['TERRAIN_LEDGE_W', 'Ledge spacing (m; bigger = fewer, longer ledges)', 5, 150, 1, 1, true],
  ['TERRAIN_LEDGE_SHARP', 'Ledge face width (fraction of the gap between ledges; smaller = steeper)', 0.005, 0.5, 0.005, 1, true],
  ['TERRAIN_LEDGE_GAPS', 'Ledges ease into walkable slopes over about this fraction of their length', 0, 1, 0.05, 1, true],
  ['TERRAIN_BLEND', 'Level ground (under houses, sheds, patios) blends into the hills over (m)', 0.5, 20, 0.5, 1, true],
  ['Yards (apply when you press Grow)'],
  ['YARD_DENSITY', 'Density of houses, sheds, fences and paving (0 to 1; lots shrink as it rises)', 0, 1, 0.05, 1, true],
  ['YARD_LOT_MAX', 'Lot width at density 0 (m)', 8, 60, 1, 1, true],
  ['YARD_LOT_MIN', 'Lot width at density 1 (m)', 8, 60, 1, 1, true],
  ['YARD_EXTENT', 'Yards reach this far from the tree (m; 0 = only the tree\'s yard)', 0, 90, 1, 1, true],
  ['YARD_STREET', 'Street width between blocks (m)', 3, 30, 0.5, 1, true],
  ['STREET_SMOOTH', 'Street grade: ground averaged this far along it (m; bigger = flatter)', 0, 100, 1, 1, true],
  ['STREET_BLEND', 'Street edge blends into the ground over (m)', 0, 10, 0.5, 1, true],
  ['YARD_FENCE', 'Chance a yard is fenced', 0, 1, 0.05, 1, true],
  ['YARD_TREE_CLEAR', 'Clear ground round the trunk (m; no house, shed or chipper)', 0, 10, 0.1, 1, true],
  ['YARD_TREE_EDGE', 'Trunk at least this far inside its lot\'s lines (m)', 0, 10, 0.1, 1, true],
  ['YARD_TREES', 'Other trees per yard (average)', 0, 6, 0.1, 1, true],
  ['YARD_TREES_HMIN', 'Other trees: shortest (m)', 3, 30, 0.5, 1, true],
  ['YARD_TREES_HMAX', 'Other trees: tallest (m)', 3, 30, 0.5, 1, true],
  ['YARD_TREES_THICK', 'Other trees: trunk diameter per metre of height (cm)', 1, 10, 0.1, 0.01, true],
  ['YARD_TREES_PITCH', 'Other trees: fibre width once sawn or climbed (mm; bigger = fewer fibres, faster)', 8, 200, 1, 0.001, true],
  ['Power lines'],
  ['LINE_BREAK_F', 'Tension that snaps a conductor (kN)', 1, 200, 1, 1000, true],
  ['DROP_BREAK_F', 'Tension that snaps a service drop (kN)', 0.5, 50, 0.5, 1000, true],
  ['LINE_DEAD_T', 'Downed line stops sparking after (s)', 0, 300, 1],
  ['LINE_EA', 'Line stretch stiffness (MN for 100% stretch)', 0.2, 50, 0.1, 1e6, true],
  ['LINE_SLACK', 'Line slack (% longer than straight; applies when you press Grow)', 0, 2, 0.05, 0.01, true],
  ['POLE_HEIGHT', 'Pole height (m; applies when you press Grow)', 5, 20, 0.5, 1, true],
  ['POLE_SPACING', 'Pole spacing along a street (m; applies when you press Grow)', 15, 80, 1, 1, true],
  ['SHOCK_KNOCK', 'Shock: thrown back at (m/s)', 0, 20, 0.5, 1, true],
  ['@grow', 'Grow tree', 'Clear all wood and grow a new tree'],
  ['@respawn', 'Respawn player', 'Put yourself back where you started, unhurt'],
  ['Chainsaw'],
  ['CUT_RATE', 'Cutting rate (cm2 of wood per second)', 10, 1000, 10, 1e-4, true],
  ['BAR_LEN', 'Chainsaw bar length (cm)', 20, 150, 5, 0.01, true],
  ['SAW_FEED', 'Feed speed in open air or an open kerf (m/s)', 0.02, 1, 0.01, 1, true],
  ['PINCH_STUCK', 'Kerf force that pinches the bar (N)', 200, 20000, 100, 1, true],
  ['Climber and rope'],
  ['JUMP_SLOPE', 'Steepest ground you can still jump off while sliding (degrees)', 0, 90, 1, Math.PI / 180, true],
  ['P_MASS', 'Climber mass (kg)', 40, 400, 5, 1, true],
  ['DV_SHAKEN', 'Impact that shakes you (sudden change of speed, m/s)', 0.5, 30, 0.5, 1, true],
  ['DV_HURT', 'Impact that hurts you (m/s)', 0.5, 40, 0.5, 1, true],
  ['DV_DOWN', 'Impact that puts you down (m/s)', 0.5, 60, 0.5, 1, true],
  ['SHAKEN_TIME', 'How long being shaken lasts (s)', 0, 10, 0.1, 1, true],
  ['STUB_LEN', 'Shortest branch that stops the lanyard at a union (m it juts out past the bark, at right angles to the stem)', 0, 3, 0.05, 1, true],
  ['STEM_BEND', 'Sharpest turn the lanyard slides round on its own, along one stem (degrees)', 0, 90, 1, Math.PI / 180, true],
  ['CLIMB_BOUNCE', 'Weight multiplier while moving on spurs', 1, 3, 0.1, 1, true],
  ['ROPE_MU', 'Friction per wrap on the lowering device', 0.02, 0.5, 0.01, 1, true],
  ['GRIP_MAX', 'Grip strength on the rope tail (N)', 50, 1000, 10, 1, true],
  ['GOE_LOWER_V', 'G.O.E.: how fast he lets wood down on the rope (m/s)', 0.1, 3, 0.05, 1, true],
  ['GOE_REST_T', 'G.O.E.: how long wood lies still before he unties it (s)', 0.2, 10, 0.1, 1, true],
  ['Concrete pavers'],
  ['PAVER_CRACK_E', 'Impact energy that cracks a paver (J)', 50, 10000, 50, 1, true],
  ['PAVER_GRAVEL', 'Damage at which a paver is gravel (1 = one cracking impact)', 2, 200, 1, 1],
  ['PAVER_MAX_SLOPE', 'Steepest ground a paver is laid on (degrees; applies when you grow a new tree)', 0, 90, 1, Math.PI / 180, true],
  ['PAVER_SIZE', 'Paver length (m; applies when you grow a new tree)', 0.2, 1.5, 0.05, 1, true],
  ['PAVER_RADIUS', 'Largest paving round the trunk (fraction of tree height; applies when you grow a new tree)', 0.1, 2, 0.05, 1, true],
];

export class Menu {
  /** onChange() is called after any value changes; onGrow() when the grow button is pressed. */
  constructor(onChange, onGrow) {
    this.onGrow = onGrow;
    this.el = document.getElementById('menu');
    this.onChange = onChange;
    this.open = false;
    this.defaults = {};
    for (const r of ROWS) if (r[0] in CFG) this.defaults[r[0]] = CFG[r[0]];
    try { Object.assign(CFG, JSON.parse(localStorage.getItem(KEY) || '{}')); } catch { /* ignore bad saved settings */ }
    this.build();
  }

  build() {
    const el = this.el; el.textContent = '';
    const h = document.createElement('h2'); h.textContent = 'Settings'; el.appendChild(h);
    const note = document.createElement('p');
    note.textContent = 'Changes apply at once and are remembered. Wood, chainsaw, climber and rope values only act on the host.';
    el.appendChild(note);
    const close = document.createElement('button'); close.textContent = 'Close'; close.className = 'go';
    close.onclick = () => this.toggle(false);
    el.appendChild(close);
    // the action buttons (grow, buy, respawn) sit at the top; pressing one closes the menu
    const top = document.createElement('div'); top.className = 'actions top'; el.appendChild(top);
    // a search box: shows only the settings whose label (or config name) has every word typed, sections opened
    const search = document.createElement('input'); search.type = 'search'; search.className = 'search';
    search.placeholder = 'Search settings'; el.appendChild(search);
    let open = {};
    try { open = JSON.parse(localStorage.getItem(OPEN_KEY) || '{}'); } catch { /* ignore */ }
    this.inputs = [];
    this.buildSeed(el);
    const sections = [];
    let sec = null;
    for (const r of ROWS) {
      if (r.length === 1) {         // a section: a collapsible block, closed until opened (remembered)
        const d = document.createElement('details'); d.open = !!open[r[0]];
        const sm = document.createElement('summary'); sm.textContent = r[0]; d.appendChild(sm);
        d.ontoggle = () => {
          if (search.value.trim()) return;           // opened by a search, not by hand
          open[r[0]] = d.open; try { localStorage.setItem(OPEN_KEY, JSON.stringify(open)); } catch { /* private window */ }
        };
        el.appendChild(d); sec = { d, title: r[0], rows: [] }; sections.push(sec); continue;
      }
      const into = sec ? sec.d : el;
      if (r[0] === '@grow' || r[0] === '@chipper' || r[0] === '@respawn' || r[0] === '@bin') {   // actions: kept out of the sections, at the top
        const b = document.createElement('button'); b.textContent = r[1]; b.title = r[2] || ''; b.className = 'go';
        b.onclick = () => {
          this.toggle(false);
          if (r[0] === '@grow') this.onGrow();
          else if (r[0] === '@chipper') this.onChipper && this.onChipper();
          else if (r[0] === '@bin') this.onBin && this.onBin();
          else this.onRespawn && this.onRespawn();
        };
        top.appendChild(b); continue;
      }
      if (r[0] === '@skip') {                           // an action that belongs to its section
        const b = document.createElement('button'); b.textContent = r[1]; b.title = r[2] || ''; b.className = 'go';
        b.onclick = () => this.onSkip && this.onSkip();
        into.appendChild(b); if (sec) sec.rows.push({ el: b, text: (r[1] + ' ' + (r[2] || '')).toLowerCase() }); continue;
      }
      const [key, label, min, max, step, scale] = r;
      const row = document.createElement('label'); row.className = 'row';
      const name = document.createElement('span'); name.textContent = label; row.appendChild(name);
      if (typeof CFG[key] === 'boolean') {
        const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = CFG[key];
        cb.onchange = () => this.set(key, cb.checked);
        row.appendChild(cb); this.inputs.push(() => { cb.checked = CFG[key]; });
      } else {
        const sl = document.createElement('input'), nb = document.createElement('input');
        sl.type = 'range'; nb.type = 'number';
        for (const i of [sl, nb]) { i.min = min; i.max = max; i.step = step; }
        const show = () => { const v = +(CFG[key] / scale).toFixed(4); sl.value = v; nb.value = v; };
        sl.oninput = () => { this.set(key, +sl.value * scale); nb.value = sl.value; };
        nb.onchange = () => { if (Number.isFinite(+nb.value)) { this.set(key, +nb.value * scale); sl.value = nb.value; } };   // the box may go outside the slider's range
        show(); row.appendChild(sl); row.appendChild(nb); this.inputs.push(show);
      }
      into.appendChild(row);
      if (sec) sec.rows.push({ el: row, text: (label + ' ' + key).toLowerCase() });
    }
    search.oninput = () => {
      const words = search.value.toLowerCase().split(/\s+/).filter(Boolean);
      for (const sc of sections) {
        const all = !words.length || words.every((wd) => sc.title.toLowerCase().includes(wd));
        let any = false;
        for (const rw of sc.rows) {
          const hit = all || words.every((wd) => rw.text.includes(wd));
          rw.el.style.display = hit ? '' : 'none'; any = any || hit;
        }
        sc.d.style.display = any ? '' : 'none';
        sc.d.open = words.length ? any : !!open[sc.title];
      }
    };
    const reset = document.createElement('button'); reset.textContent = 'Reset all'; reset.title = 'Reset everything to defaults';
    reset.onclick = () => { Object.assign(CFG, this.defaults); localStorage.removeItem(KEY); for (const f of this.inputs) f(); this.onChange(); };
    const foot = document.createElement('div'); foot.className = 'actions';
    foot.appendChild(reset); el.appendChild(foot);
  }

  /** The world seed box: the word the next Grow uses, a reroll button, and the seed of the world in play. */
  buildSeed(el) {
    const box = document.createElement('div'); box.className = 'seed';
    const row = document.createElement('label'); row.className = 'seedrow';
    const name = document.createElement('span'); name.textContent = 'World seed (tree, ground and yards; applies when you press Grow)';
    const tb = document.createElement('input'); tb.type = 'text'; tb.maxLength = 32; tb.autocomplete = 'off'; tb.spellcheck = false;
    const dice = document.createElement('button'); dice.textContent = 'New'; dice.title = 'A new random seed';
    const now = document.createElement('p'), job = document.createElement('p');
    row.append(name, tb, dice); box.append(row, now, job); el.appendChild(box);
    tb.onchange = () => this.setSeed(tb.value);
    dice.onclick = (e) => { e.preventDefault(); this.setSeed(randomSeed()); };
    this.showSeed = () => {
      if (document.activeElement !== tb) tb.value = CFG.WORLD_SEED;
      const w = this.world && this.world.seed;
      now.textContent = w ? `This world: ${w}` : '';
      // the job's money, worked out (sim/damage.js)
      const j = this.world && this.world.job;
      job.textContent = j ? `${budgetMath(j)}. Paid out: ${wageMath(Math.max(1, this.world.players.size))}.` : '';
    };
    this.inputs.push(this.showSeed); this.showSeed();
  }

  /** Change the world seed (no localStorage: every visit starts with a fresh random word). */
  setSeed(word) {
    CFG.WORLD_SEED = String(word || '').trim().toLowerCase();
    for (const f of this.inputs) f();
    this.onSeed && this.onSeed();
  }

  set(key, value) {
    CFG[key] = value;
    const changed = {};
    for (const k in this.defaults) if (CFG[k] !== this.defaults[k]) changed[k] = CFG[k];
    try { localStorage.setItem(KEY, JSON.stringify(changed)); } catch { /* private window */ }
    this.onChange();
  }

  toggle(on = !this.open) {
    this.open = on;
    this.el.style.display = on ? 'block' : 'none';
    if (on) { document.exitPointerLock?.(); this.showSeed(); }
  }
}
