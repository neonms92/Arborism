// The Tab menu: a slider and a number box for every variable worth iterating
// on. Each row edits one key of CFG in place, so a change takes effect on the
// next tick or frame. Changed values are kept in localStorage.
//
// To add a variable: put it in config.js and add one line to ROWS.
// Rows marked host only do something on the machine running the simulation
// (the host, or solo); on a joined client they are shown but have no effect.

import { CFG } from '../config.js';

const KEY = 'arb-settings-v1';
// [config key, label, min, max, step, scale (shown value = CFG value / scale), host only]
export const ROWS = [
  ['Controls'],
  ['SAW_SENS', 'Chainsaw sensitivity (turns of the bar per screen of mouse)', 0.05, 2, 0.05, Math.PI * 2],
  ['LOOK_SENS', 'Look sensitivity (mouse)', 0.5, 10, 0.1, 0.001],
  ['TOUCH_LOOK_SENS', 'Look sensitivity (touch)', 1, 20, 0.5, 0.001],
  ['TOUCH_SAW_SENS', 'Chainsaw sensitivity, touch (times the mouse)', 0.2, 5, 0.1, 1],
  ['TOUCH_STICK_R', 'Touch stick size (px of thumb travel for full speed)', 20, 150, 5, 1],
  ['INVERT_Y', 'Inverted vertical look'],
  ['LANYARD_TIME', 'Hold time to spur in or move the lanyard (s)', 0, 10, 0.1, 1, true],
  ['LETGO_TIME', 'Hold time to let go of the tree (s)', 0, 10, 0.1, 1, true],
  ['PUNCH_FORCE', 'Punch: force added per press (N)', 0, 3000, 10, 1, true],
  ['PUNCH_DECAY', 'Punch: how long each one lasts (s)', 0.02, 1, 0.01, 1, true],
  ['PUNCH_MAX', 'Punch: most force stacked presses reach (N)', 0, 20000, 100, 1, true],
  ['PULL_FORCE', 'Pulling: most force you pull wood or the chipper with by walking away (N)', 50, 5000, 10, 1, true],
  ['GRAB_MAX', 'Pulling: force that tears what you hold out of your hands (N)', 50, 10000, 10, 1, true],
  ['GRAB_K', 'Grabbed wood: stiffness of the hold (N/m)', 500, 100000, 500, 1, true],
  ['View'],
  ['BARK_OPACITY', 'Bark visibility', 0, 1, 0.05, 1],
  ['SHOW_FIBRES', 'Draw fibres'],
  ['STRESS_COLORS', 'Colour fibres by load'],
  ['COLOR_GAMMA', 'Load colour contrast (lower = stronger)', 0.2, 1, 0.05, 1],
  ['LEAF_OPACITY', 'Foliage visibility', 0, 1, 0.05, 1],
  ['IMPERIAL', 'Imperial units on the HUD (ft, lb, mph)'],
  ['WOBBLE', 'How far the view swims while shaken (degrees)', 0, 30, 0.5, Math.PI / 180],
  ['WOBBLE_HZ', 'How fast the view swims while shaken (per second)', 0.1, 3, 0.05, 1],
  ['DOWN_EYE', 'Eye height above the ground while down (cm)', 2, 100, 1, 0.01],
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
  ['Wood chipper'],
  ['CHIP_PULL', 'Feed rollers: most they pull with (N)', 500, 40000, 100, 1, true],
  ['CHIP_CAPACITY', 'Feed rollers: heaviest piece they take before seizing (kg)', 5, 2000, 5, 1, true],
  ['CHIP_FEED_V', 'Feed rollers: speed (m/s)', 0.05, 3, 0.05, 1, true],
  ['CHIP_ROLL', 'Wheels: rolling resistance while towed (fraction of weight)', 0, 0.3, 0.005, 1, true],
  ['CHIP_BRAKE', 'Wheels: brakes when nobody holds the grip (fraction of weight)', 0, 1.5, 0.05, 1, true],
  ['CHIP_MASS', 'Mass (kg, applies at the next new tree)', 100, 5000, 50, 1, true],
  ['CHIP_SWELL', 'Chips: loose volume per volume of wood', 1, 5, 0.1, 1, true],
  ['CHIP_CARRY', 'Chips a player can carry (litres)', 1, 500, 1, 0.001, true],
  ['CHIP_BREAK_F', 'Hit that crumples it (kN, from wood or a structure)', 1, 500, 1, 1000, true],
  ['@chipper', 'Respawn chipper (removes the old one, broken or not; chip piles stay)'],
  ['Houses, sheds and fences (breakable structures)'],
  ['HOUSE_BREAK_F', 'House: force from wood that breaks one room apart (N)', 500, 400000, 500, 1, true],
  ['SHED_BREAK_F', 'Shed: force from wood that breaks it apart (N)', 500, 200000, 500, 1, true],
  ['FENCE_BREAK_F', 'Fence: force from wood that breaks one section apart (N)', 500, 200000, 500, 1, true],
  ['SHED_DENSITY', 'Board density (kg/m3)', 100, 1200, 10, 1, true],
  ['New tree (these apply when you press Grow)'],
  ['TREE_HEIGHT', 'Height (m)', 3, 30, 0.5, 1, true],
  ['TREE_DIAMETER', 'Trunk diameter at the base (m)', 0.1, 1.5, 0.02, 1, true],
  ['BRANCH_DENSITY', 'Branch density (1 = a limb about every metre)', 0, 3, 0.1, 1, true],
  ['BRANCH_LENGTH', 'Branch length (multiplier)', 0.2, 3, 0.1, 1, true],
  ['FIBRE_PITCH', 'Fibre density: fibre width (mm). Smaller = more fibres', 8, 100, 1, 0.001, true],
  ['GRID_MAX', 'Most fibres across one stem', 3, 25, 2, 1, true],
  ['SEG_LEN', 'Fibre segment length (m)', 0.15, 2, 0.05, 1, true],
  ['TREE_SEED', 'Shape (seed)', 1, 200, 1, 1, true],
  ['Ground (applies when you press Grow)'],
  ['TERRAIN_SEED', 'Shape of the hills and ledges (seed)', 1, 200, 1, 1, true],
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
  ['YARD_SEED', 'Layout of the yards (seed)', 1, 200, 1, 1, true],
  ['YARD_LOT_MAX', 'Lot width at density 0 (m)', 8, 60, 1, 1, true],
  ['YARD_LOT_MIN', 'Lot width at density 1 (m)', 8, 60, 1, 1, true],
  ['YARD_EXTENT', 'Yards reach this far from the tree (m; 0 = only the tree\'s yard)', 0, 90, 1, 1, true],
  ['YARD_STREET', 'Street width between blocks (m)', 3, 30, 0.5, 1, true],
  ['YARD_FENCE', 'Chance a yard is fenced', 0, 1, 0.05, 1, true],
  ['YARD_TREE_CLEAR', 'Clear ground round the trunk (m; no house, shed or chipper)', 0, 10, 0.5, 1, true],
  ['@grow', 'Clear all wood and grow a new tree'],
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
    this.inputs = [];
    for (const r of ROWS) {
      if (r.length === 1) { const t = document.createElement('h3'); t.textContent = r[0]; el.appendChild(t); continue; }
      if (r[0] === '@grow' || r[0] === '@chipper') {
        const b = document.createElement('button'); b.textContent = r[1]; b.className = 'go';
        b.onclick = () => (r[0] === '@grow' ? this.onGrow() : this.onChipper && this.onChipper());
        el.appendChild(b); continue;
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
      el.appendChild(row);
    }
    const reset = document.createElement('button'); reset.textContent = 'Reset everything to defaults';
    reset.onclick = () => { Object.assign(CFG, this.defaults); localStorage.removeItem(KEY); for (const f of this.inputs) f(); this.onChange(); };
    el.appendChild(reset);
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
    if (on) document.exitPointerLock?.();
  }
}
