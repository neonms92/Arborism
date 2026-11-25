// DOM HUD: status line, prompt, toasts, rope panel, control hints.
// Prompts and toasts arrive from the host with {tokens}; each player sees the
// key or button name for the device they last touched.

import { CFG, INJ_NAME, MODE } from '../config.js';

const $ = (id) => document.getElementById(id);

// token -> [keyboard and mouse, gamepad, touch (the on-screen buttons of src/touch.js)]
const NAMES = {
  move: ['ESDF', 'Left stick', 'Left thumb'], look: ['Mouse', 'Right stick', 'Drag right'],
  interact: ['R', 'X', 'Action'], drop: ['C', 'B', 'Let go'], jump: ['Space', 'A', 'Jump'],
  rig: ['W', 'Y', 'Rig'], punch: ['G', 'RB', 'Punch'],
  raise: ['Right mouse', 'LT', 'Saw'], throttle: ['Left mouse', 'RT', 'Cut'],
  wraps: ['Up / Down arrows', 'D-pad up / down', 'Wrap + / −'],
  menu: ['Tab', 'Back', '⚙'], respawn: ['Enter', 'Start', '↺'],
};
// on the rope tail the saw's buttons are not shown: the slider does their work
const TOUCH_ROPE = { raise: 'Slider up', throttle: 'Slider down' };
export function describe(text, device, over) {
  const k = device === 'pad' ? 1 : device === 'touch' ? 2 : 0;
  return text.replace(/\{(\w+)\}/g, (m, t) => (over && over[t]) || (NAMES[t] ? NAMES[t][k] : m));
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

  update(dt, aux, me, info, device) {
    this.device = device;
    this.fps += (1 / Math.max(dt, 1e-3) - this.fps) * 0.05;
    const a = aux && aux.pl.find((p) => p.id === me);
    let s = `${info}  |  ${Math.round(this.fps)} fps`;
    if (a) s += `  |  ${a.m === MODE.CLIMB ? 'on spurs, lanyard on' : a.m === MODE.ROPE ? 'on the rope' : 'on the ground'}  |  ${INJ_NAME[a.inj]}`;
    this.status.textContent = s;
    this.prompt.textContent = a ? describe(a.pr, device, device === 'touch' && a.m === MODE.ROPE ? TOUCH_ROPE : null) : '';
    this.keys.style.display = device === 'touch' ? 'none' : '';
    this.keys.textContent = describe('{move} move   {look} look   {interact} lanyard (hold)   {rig} block / tie   {punch} punch   {raise} saw   {drop} let go (hold)   {menu} settings   {respawn} respawn', device);
    const ch = a ? a.ch || 0 : 0;
    this.ring.style.display = ch > 0 ? '' : 'none';
    if (ch > 0) this.ring.setAttribute('stroke-dashoffset', String(100 * (1 - ch)));

    const r = aux && aux.rope;
    if (r && this.world.rope.state === 2) {
      this.ropeEl.style.display = 'block';
      const cap = r.holder >= 0 ? Math.max(5, CFG.GRIP_MAX * r.grip) * Math.exp(CFG.ROPE_MU * 2 * Math.PI * r.wraps) : Infinity;
      this.ropeEl.textContent = (r.fed ? 'ROPE IN THE CHIPPER (cut it or take the block down to free it)  |  ' : '') + `ROPE  tension ${(r.T / 9.81).toFixed(0)} kgf` +
        `  |  wraps ${r.wraps}  |  ${r.holder >= 0 ? `held by P${r.holder}, holds ${(cap / 9.81).toFixed(0)} kgf` : 'tied off'}` +
        (r.run > 0.05 ? `  |  running ${r.run.toFixed(1)} m/s` : r.slack > 0.05 ? `  |  slack ${r.slack.toFixed(1)} m` : '');
    } else this.ropeEl.style.display = 'none';
  }
}
