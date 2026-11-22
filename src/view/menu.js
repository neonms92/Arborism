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
const ROWS = [
  ['Controls'],
  ['SAW_SENS', 'Chainsaw sensitivity (turns of the bar per screen of mouse)', 0.05, 2, 0.05, Math.PI * 2],
  ['LOOK_SENS', 'Look sensitivity (mouse)', 0.5, 10, 0.1, 0.001],
  ['INVERT_Y', 'Inverted vertical look'],
  ['LANYARD_TIME', 'Hold time to spur in or move the lanyard (s)', 0, 10, 0.1, 1, true],
  ['LETGO_TIME', 'Hold time to let go of the tree (s)', 0, 10, 0.1, 1, true],
  ['PUNCH_FORCE', 'Punch: force added per press (N)', 0, 3000, 10, 1, true],
  ['PUNCH_DECAY', 'Punch: how long each one lasts (s)', 0.02, 1, 0.01, 1, true],
  ['PUNCH_MAX', 'Punch: most force stacked presses reach (N)', 0, 20000, 100, 1, true],
  ['View'],
  ['BARK_OPACITY', 'Bark visibility', 0, 1, 0.05, 1],
  ['SHOW_FIBRES', 'Draw fibres'],
  ['STRESS_COLORS', 'Colour fibres by load'],
  ['COLOR_GAMMA', 'Load colour contrast (lower = stronger)', 0.2, 1, 0.05, 1],
  ['LEAF_OPACITY', 'Foliage visibility', 0, 1, 0.05, 1],
  ['Wood fibres'],
  ['MOR', 'Tension strength (MPa)', 2, 80, 1, 1e6, true],
  ['COMP', 'Crushing strength (MPa)', 1, 60, 1, 1e6, true],
  ['TENS_STRAIN', 'Tension deformation: stretch at full tension strength (% of length)', 0.05, 10, 0.05, 0.01],
  ['COMP_STRAIN', 'Compression deformation: shortening at crushing strength (% of length)', 0.05, 10, 0.05, 0.01],
  ['FLEX_FREQ', 'Bounce speed (rad/s)', 2, 30, 0.5, 1],
  ['FLEX_DAMP', 'Bounce damping (1 = none)', 0.05, 1.5, 0.05, 1],
  ['FIBRE_STRETCH', 'Stretch at which a fibre snaps (mm)', 2, 80, 1, 0.001, true],
  ['FIBRE_SLIP', 'Sideways slip at which a fibre shears (mm)', 5, 100, 1, 0.001, true],
  ['BEND_MAX', 'Fold angle no fibre survives (rad)', 0.2, 3.1, 0.05, 1, true],
  ['DENSITY', 'Wood density (kg/m3)', 200, 1400, 10, 1, true],
  ['New tree (these apply when you press Grow)'],
  ['TREE_HEIGHT', 'Height (m)', 3, 30, 0.5, 1, true],
  ['TREE_DIAMETER', 'Trunk diameter at the base (m)', 0.1, 1.5, 0.02, 1, true],
  ['BRANCH_DENSITY', 'Branch density (1 = a limb about every metre)', 0, 3, 0.1, 1, true],
  ['BRANCH_LENGTH', 'Branch length (multiplier)', 0.2, 3, 0.1, 1, true],
  ['FIBRE_PITCH', 'Fibre density: fibre width (mm). Smaller = more fibres', 8, 100, 1, 0.001, true],
  ['GRID_MAX', 'Most fibres across one stem', 3, 25, 2, 1, true],
  ['SEG_LEN', 'Fibre segment length (m)', 0.15, 2, 0.05, 1, true],
  ['TREE_SEED', 'Shape (seed)', 1, 200, 1, 1, true],
  ['@grow', 'Clear all wood and grow a new tree'],
  ['Chainsaw'],
  ['CUT_RATE', 'Cutting rate (cm2 of wood per second)', 10, 1000, 10, 1e-4, true],
  ['SAW_FEED', 'Feed speed in open air or an open kerf (m/s)', 0.02, 1, 0.01, 1, true],
  ['PINCH_STUCK', 'Kerf force that pinches the bar (N)', 200, 20000, 100, 1, true],
  ['Climber and rope'],
  ['P_MASS', 'Climber mass (kg)', 40, 400, 5, 1, true],
  ['STUB_LEN', 'Shortest branch that stops the lanyard at a union (m)', 0, 3, 0.05, 1, true],
  ['CLIMB_BOUNCE', 'Weight multiplier while moving on spurs', 1, 3, 0.1, 1, true],
  ['ROPE_MU', 'Friction per wrap on the lowering device', 0.02, 0.5, 0.01, 1, true],
  ['GRIP_MAX', 'Grip strength on the rope tail (N)', 50, 1000, 10, 1, true],
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
    this.inputs = [];
    for (const r of ROWS) {
      if (r.length === 1) { const t = document.createElement('h3'); t.textContent = r[0]; el.appendChild(t); continue; }
      if (r[0] === '@grow') {
        const b = document.createElement('button'); b.textContent = r[1]; b.className = 'go';
        b.onclick = () => this.onGrow();
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
