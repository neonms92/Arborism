// DOM HUD: status line, prompt, toasts, rope panel, control hints.
// Prompts and toasts arrive from the host with {tokens}; each player sees the
// key or button name for the device they last touched.

import { CFG, TOOL_NAME, INJ_NAME, MODE } from '../config.js';

const $ = (id) => document.getElementById(id);

// token -> [keyboard and mouse, gamepad]
const NAMES = {
  move: ['WASD', 'Left stick'], look: ['Mouse', 'Right stick'],
  interact: ['E', 'X'], drop: ['C', 'B'], jump: ['Space', 'A'],
  raise: ['Right mouse', 'LT'], throttle: ['Left mouse', 'RT'],
  tool: ['Q / R', 'LB / RB'], wraps: ['Up / Down arrows', 'D-pad up / down'],
  fibres: ['Tab', 'Back'], respawn: ['Enter', 'Start'],
};
export function describe(text, device) {
  const k = device === 'pad' ? 1 : 0;
  return text.replace(/\{(\w+)\}/g, (m, t) => (NAMES[t] ? NAMES[t][k] : m));
}

export class Hud {
  constructor(world) {
    this.world = world;
    this.status = $('status'); this.prompt = $('prompt'); this.toasts = $('toasts');
    this.ropeEl = $('rope'); this.keys = $('keys');
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
    if (a) s += `  |  ${TOOL_NAME[a.tool]}  |  ${a.m === MODE.CLIMB ? 'on spurs, lanyard on' : a.m === MODE.ROPE ? 'on the rope' : 'on the ground'}  |  ${INJ_NAME[a.inj]}`;
    this.status.textContent = s;
    this.prompt.textContent = a ? describe(a.pr, device) : '';
    this.keys.textContent = describe('{move} move   {look} look   {tool} tool   {interact} use   {drop} let go   {fibres} fibres / bark   {respawn} respawn', device);

    const r = aux && aux.rope;
    if (r && this.world.rope.state === 2) {
      this.ropeEl.style.display = 'block';
      const cap = r.holder >= 0 ? Math.max(5, CFG.GRIP_MAX * r.grip) * Math.exp(CFG.ROPE_MU * 2 * Math.PI * r.wraps) : Infinity;
      this.ropeEl.textContent = `ROPE  tension ${(r.T / 9.81).toFixed(0)} kgf` +
        `  |  wraps ${r.wraps}  |  ${r.holder >= 0 ? `held by P${r.holder}, holds ${(cap / 9.81).toFixed(0)} kgf` : 'tied off'}` +
        (r.run > 0.05 ? `  |  running ${r.run.toFixed(1)} m/s` : r.slack > 0.05 ? `  |  slack ${r.slack.toFixed(1)} m` : '');
    } else this.ropeEl.style.display = 'none';
  }
}
