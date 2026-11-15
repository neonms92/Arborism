// DOM HUD: status line, prompt, toasts, rope panel, and the cross-section
// diagram (the main "read and learn" surface, DESIGN.md 4.4).

import { CELLS, NCELL, INTACT, CUT, gapOf } from '../model/section.js';
import { CFG, TOOL_NAME, INJ_NAME, MODE } from '../config.js';

const $ = (id) => document.getElementById(id);

export class Hud {
  constructor(world) {
    this.world = world;
    this.status = $('status'); this.prompt = $('prompt'); this.toasts = $('toasts');
    this.ropeEl = $('rope'); this.canvas = $('section'); this.ctx = this.canvas.getContext('2d');
    this.fps = 60;
  }

  toast(msg) {
    const d = document.createElement('div'); d.textContent = msg; this.toasts.appendChild(d);
    setTimeout(() => d.remove(), 3500);
    while (this.toasts.children.length > 5) this.toasts.firstChild.remove();
  }

  /** stressOf(secId) -> array-like of stress/MOR*100 per cell, or null */
  update(dt, aux, me, info, stressOf) {
    this.fps += (1 / Math.max(dt, 1e-3) - this.fps) * 0.05;
    const a = aux && aux.pl.find((p) => p.id === me);
    let s = `${info}  |  ${Math.round(this.fps)} fps`;
    if (a) s += `  |  ${TOOL_NAME[a.tool]}  |  ${a.m === MODE.CLIMB ? (a.lan ? 'climbing, LANYARD ON' : 'climbing, unclipped') : a.m === MODE.ROPE ? 'on the rope' : 'on the ground'}  |  ${INJ_NAME[a.inj]}`;
    this.status.textContent = s;
    this.prompt.textContent = a ? a.pr : '';

    const r = aux && aux.rope;
    if (r && this.world.rope.state === 2) {
      this.ropeEl.style.display = 'block';
      const cap = r.holder >= 0 ? Math.max(5, CFG.GRIP_MAX * r.grip) * Math.exp(CFG.ROPE_MU * 2 * Math.PI * r.wraps) : Infinity;
      this.ropeEl.textContent = `ROPE  tension ${(r.T / 9.81).toFixed(0)} kgf` +
        `  |  wraps ${r.wraps}  |  ${r.holder >= 0 ? `held by P${r.holder}, holds ${(cap / 9.81).toFixed(0)} kgf` : 'tied off'}` +
        (r.run > 0.05 ? `  |  running ${r.run.toFixed(1)} m/s` : r.slack > 0.05 ? `  |  slack ${r.slack.toFixed(1)} m` : '');
    } else this.ropeEl.style.display = 'none';

    const sw = a && a.saw;
    if (sw) { this.canvas.style.display = 'block'; this.drawSection(sw, stressOf); }
    else this.canvas.style.display = 'none';
  }

  // Cross-section, viewed along the stem, rotated so the saw enters from the bottom.
  drawSection(sw, stressOf) {
    const [, , z0, phi, tilt, depth, stuck, secId, pinch] = sw;
    const ctx = this.ctx, W = this.canvas.width, c = W / 2, Rpx = W * 0.4;
    ctx.clearRect(0, 0, W, W);
    ctx.fillStyle = 'rgba(0,0,0,0.55)'; ctx.fillRect(0, 0, W, W);
    const sec = secId >= 0 ? this.world.sections.get(secId) : null;
    const stress = sec && stressOf ? stressOf(secId) : null;
    // rotate so entry direction e=(cos phi, sin phi) maps to screen-down
    const rot = Math.PI / 2 - phi, cr = Math.cos(rot), sr = Math.sin(rot);
    const cs = Rpx * 2 / CFG.GRID * 1.02;
    ctx.save(); ctx.translate(c, c);
    for (let i = 0; i < NCELL; i++) {
      const x = CELLS[i].x, y = CELLS[i].y;
      const sx = (x * cr - y * sr) * Rpx, sy = (x * sr + y * cr) * Rpx;
      const st = sec ? sec.state[i] : INTACT;
      if (st === INTACT) {
        const v = stress ? stress[i] / 100 : 0;      // fraction of MOR
        const t = Math.max(-1, Math.min(1, v));
        const r = 205 + (t > 0 ? 50 * t : 0), g = 170 - Math.abs(t) * 120, b = 120 + (t < 0 ? -t * 135 : -t * 80);
        ctx.fillStyle = `rgb(${r | 0},${g | 0},${b | 0})`;
      } else if (st === CUT) ctx.fillStyle = gapOf(sec, i) > CFG.KERF_WIDTH * 1.5 ? '#000' : '#3a3a3a';
      else ctx.fillStyle = '#8a5a20';
      ctx.fillRect(sx - cs / 2, sy - cs / 2, cs, cs);
    }
    // bar: a line across at the current depth, entering from the bottom
    const yb = Rpx - depth / (sw[9] || (sec ? sec.R : 1)) * Rpx;
    ctx.strokeStyle = stuck ? '#ff3030' : '#ffd040'; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(-Rpx, yb); ctx.lineTo(Rpx, yb); ctx.stroke();
    ctx.restore();
    ctx.fillStyle = '#fff'; ctx.font = '12px sans-serif';
    ctx.fillText(`tilt ${(tilt * 57.3).toFixed(0)} deg   offset ${(z0 * 100).toFixed(0)} cm`, 6, 14);
    ctx.fillText(`depth ${(depth * 100).toFixed(0)} cm` + (pinch > 50 ? `   pinch ${(pinch / CFG.PINCH_STUCK * 100).toFixed(0)}%` : ''), 6, W - 8);
    ctx.fillText('red = tension  blue = compression', 6, 28);
  }
}
