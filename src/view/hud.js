// DOM HUD: status line, prompt, toasts, rope panel, control hints.
// Prompts and toasts arrive from the host with {tokens}; each player sees the
// key or button name for the device they last touched.

import { CFG, INJ_NAME, MODE } from '../config.js';

const $ = (id) => document.getElementById(id);
/** Colour of a job percentage (owner): red under 60 %, amber from 60, green from 90, blue from 99. */
export function pctColour(f) { return f >= 0.99 ? '#5ab4ff' : f >= 0.9 ? '#52d468' : f >= 0.6 ? '#ffb326' : '#ff5a4e'; }

// token -> [keyboard and mouse, gamepad, touch (the on-screen buttons of src/touch.js)]
const NAMES = {
  move: ['ESDF', 'Left stick', 'Left thumb'], look: ['Mouse', 'Right stick', 'Drag right'],
  interact: ['R', 'X', 'Action'], drop: ['C', 'B', 'Let go'], jump: ['Space', 'A', 'Jump'],
  rig: ['W', 'Y', 'Rig'], punch: ['G', 'RB', 'Punch'],
  raise: ['Right mouse', 'LT', 'Saw'], throttle: ['Left mouse', 'RT', 'Cut'],
  eat: ['Left mouse', 'RT', 'Eat salad'],          // {throttle} with a tube salad in hand and the saw not planted
  wraps: ['Up / Down arrows', 'D-pad up / down', 'Wrap + / −'],
  menu: ['Tab', 'Back', '⚙'],
};
// on the rope tail the saw's buttons are not shown: the slider does their work
const TOUCH_ROPE = { raise: 'Slider up', throttle: 'Slider down' };
// quantities: kind -> [SI unit, imperial factor, imperial unit, decimals]. Host text writes {kind:value} in SI.
const UNITS = {
  speed: ['m/s', 2.23694, 'mph', 1],
  len: ['m', 3.28084, 'ft', 1],
  mass: ['kg', 2.20462, 'lb', 0],
  force: ['kgf', 2.20462 / 9.81, 'lbf', 0],   // value in N
  vol: ['L', 0.264172, 'gal', 1],              // value in litres
};
/** A quantity in SI as text in the units the HUD shows (CFG.IMPERIAL). */
export function qty(kind, v, dec) {
  const u = UNITS[kind]; if (!u) return String(v);
  const imp = CFG.IMPERIAL, x = imp ? v * u[1] : kind === 'force' ? v / 9.81 : v;
  return `${x.toFixed(dec ?? u[3])} ${imp ? u[2] : u[0]}`;
}
export const money = (v) => `$${Math.round(v).toLocaleString('en-US')}`;
/** How the job's budget was worked out, as one line of text (world.job from sim/damage.js). */
export function budgetMath(job) {
  if (!job) return '';
  const L = (v) => qty('len', v, 1), x = (job.h * job.d) / (job.rh * job.rd), y = job.rlot / job.lot;
  return `Budget ${money(job.budget)} = ${money(job.base)} (for a tree ${L(job.rh)} x ${L(job.rd)})`
    + ` × ${x.toFixed(2)} (this tree is ${L(job.h)} x ${L(job.d)})`
    + ` × ${y.toFixed(2)} (lots ${L(job.lot)} wide against ${L(job.rlot)}), to the nearest ${money(CFG.BUDGET_ROUND)}`;
}
/** The wage drain, worked out: players x WAGE per game hour, a game hour being DAY_LENGTH / 24 s. */
export function wageMath(n) {
  if (!(CFG.DAY_LENGTH > 0)) return 'no wages while time stands still';
  const hr = CFG.DAY_LENGTH / 24, per = n * CFG.WAGE;
  return `wages ${n} × ${money2(CFG.WAGE)} per game hour ÷ ${+hr.toFixed(1)} s = ${money2(per / hr)}/s`;
}
const money2 = (v) => `$${v.toFixed(2)}`;
export function describe(text, device, over) {
  const k = device === 'pad' ? 1 : device === 'touch' ? 2 : 0;
  text = text.replace(/\{(\w+):(-?[\d.e+-]+)\}/g, (m, kind, v) => (kind === 'money' ? money(+v) : UNITS[kind] ? qty(kind, +v) : m));
  // {interact|feed}: the key's name here; the words after | are the touch button's dimmed caption (touch.js actionLabel)
  return text.replace(/\{(\w+)(?:\|[^}]*)?\}/g, (m, t) => (over && over[t]) || (NAMES[t] ? NAMES[t][k] : m));
}

export class Hud {
  constructor(world) {
    this.world = world;
    this.status = $('status'); this.prompt = $('prompt'); this.toasts = $('toasts');
    this.ropeEl = $('rope'); this.keys = $('keys');
    this.ring = $('ringArc');   // channel progress round the reticle
    this.fps = 60; this.device = 'kb';
  }

  toast(msg) {
    const d = document.createElement('div'); d.textContent = describe(msg, this.device); this.toasts.appendChild(d);
    setTimeout(() => d.remove(), 4000);
    while (this.toasts.children.length > 5) this.toasts.firstChild.remove();
  }

  /** How far the job has got: the job tree chipped, and of the chips made, how many went into a bin (world.prog). */
  progress() {
    const P = this.world.prog, el = this.progEl || (this.progEl = $('prog'));
    const tree = P.M > (P.lost || 0) ? Math.min(1, P.chipped / (P.M - (P.lost || 0))) : 0, bin = P.made > 0 ? P.gone / P.made : null;
    const key = `${tree.toFixed(4)} ${bin === null ? '-' : bin.toFixed(4)}`;
    if (key === this.progKey) return;
    this.progKey = key;
    // to a tenth of a percent, rounded down (a big tree moves slowly; 99.96 % is not yet 100 %)
    const span = (f) => `<span style="color:${pctColour(f)}">${(Math.floor(f * 1000 + 1e-6) / 10).toFixed(1)}%</span>`;
    el.innerHTML = `Tree chipped ${span(tree)}  ·  Chips in bins ${bin === null ? '<span style="opacity:.7">none yet</span>' : span(bin)}`;
  }

  /** The network box (net/stats.js), top right on a joined client; null hides it. */
  net(lines) {
    const el = this.netEl || (this.netEl = $('net'));
    el.style.display = lines ? 'block' : 'none';
    if (lines) { const t = lines.join('\n'); if (el.textContent !== t) el.textContent = t; }
  }

  update(dt, aux, me, info, device) {
    this.device = device;
    this.fps += (1 / Math.max(dt, 1e-3) - this.fps) * 0.05;
    const a = aux && aux.pl.find((p) => p.id === me);
    let s = `${info}  |  ${Math.round(this.fps)} fps`;
    if (this.view && this.view.drawDist < CFG.DRAW_DIST - 0.5) s += `  |  view ${qty('len', this.view.drawDist, 0)}`;   // ridden down for the frame rate
    const cash = this.world.cash();
    if (cash !== null) s += `  |  cash ${cash < 0 ? '-' : ''}${money(Math.abs(cash))}, ${wageMath(aux ? aux.pl.length : 1)}`;
    if (a && a.ck > 0) s += `  |  carrying ${qty('vol', a.ck * 1000, 0)} of chips`;
    if (a && a.hd) s += '  |  holding a tube salad';
    if (a) s += `  |  ${a.m === MODE.CLIMB ? 'on spurs, lanyard on' : a.m === MODE.ROPE ? 'on the rope' : 'on the ground'}  |  ${INJ_NAME[a.inj]}`;
    this.status.textContent = s;
    this.progress();
    this.prompt.textContent = a ? describe(a.pr, device, device === 'touch' && a.m === MODE.ROPE ? TOUCH_ROPE : null) : '';
    this.keys.style.display = device === 'touch' ? 'none' : '';
    this.keys.textContent = describe('{move} move   {look} look   {interact} lanyard (hold)   {rig} block / tie   {punch} punch   {raise} saw   {drop} let go (hold)   {menu} settings', device);
    const ch = a ? a.ch || 0 : 0;
    this.ring.style.display = ch > 0 ? '' : 'none';
    if (ch > 0) this.ring.setAttribute('stroke-dashoffset', String(100 * (1 - ch)));

    const r = aux && aux.rope;
    if (r && this.world.rope.state === 2) {
      this.ropeEl.style.display = 'block';
      const cap = r.holder >= 0 ? Math.max(5, CFG.GRIP_MAX * r.grip) * Math.exp(CFG.ROPE_MU * 2 * Math.PI * r.wraps) : Infinity;
      this.ropeEl.textContent = (r.fed ? 'ROPE IN THE CHIPPER (cut it or take the block down to free it)  |  ' : '') + `ROPE  tension ${qty('force', r.T)}` +
        `  |  wraps ${r.wraps}  |  ${r.holder >= 0 ? `held by P${r.holder}, holds ${qty('force', cap)}` : 'tied off'}` +
        (r.run > 0.05 ? `  |  running ${qty('speed', r.run)}` : r.slack > 0.05 ? `  |  slack ${qty('len', r.slack)}` : '');
    } else this.ropeEl.style.display = 'none';
  }
}
