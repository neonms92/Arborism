// Gamepad + keyboard/mouse -> one InputState per frame.
// Held values are "latest wins"; button presses are COUNTERS (DESIGN.md 2.5).
// Look angles and saw swing angles live here: they are applied locally and
// sent to the host. `device` is whichever of 'kb' / 'pad' was touched last;
// the HUD uses it to name controls.

import { CFG } from './config.js';
import { blankInput } from './sim/players.js';

const DEAD = 0.18;
const dz = (v) => (Math.abs(v) < DEAD ? 0 : (v - Math.sign(v) * DEAD) / (1 - DEAD));
const INV = CFG.INVERT_Y ? 1 : -1;     // inverted: pushing the mouse or stick forward looks (and swings the saw) down

// standard gamepad button index -> counter name
const PAD = { 0: 'jump', 1: 'drop', 2: 'interact', 4: 'toolPrev', 5: 'toolNext', 12: 'wrapUp', 13: 'wrapDn', 9: 'respawn' };
const KEYS = { Space: 'jump', KeyC: 'drop', KeyE: 'interact', KeyQ: 'toolPrev', KeyR: 'toolNext', ArrowUp: 'wrapUp', ArrowDown: 'wrapDn', Enter: 'respawn' };

export class Input {
  constructor(canvas) {
    this.state = blankInput();
    this.keys = new Set(); this.mouse = { l: false, r: false, dx: 0, dy: 0 };
    this.padPrev = [];
    this.fibresToggled = false;
    this.sawOut = false;        // set by main: the local player is holding the chainsaw
    this.active = false;        // set by main: game running (not in lobby)
    this.device = 'kb';
    window.addEventListener('keydown', (e) => {
      this.device = 'kb';
      if (!this.active || e.repeat) return;
      this.keys.add(e.code);
      if (KEYS[e.code]) this.state.c[KEYS[e.code]]++;
      if (e.code === 'Tab') { this.fibresToggled = true; e.preventDefault(); }
      if (e.code === 'Space') e.preventDefault();
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
    canvas.addEventListener('mousedown', (e) => {
      this.device = 'kb';
      if (!this.active) return;
      if (document.pointerLockElement !== canvas) { canvas.requestPointerLock?.(); return; }
      if (e.button === 0) this.mouse.l = true; if (e.button === 2) this.mouse.r = true;
    });
    window.addEventListener('mouseup', (e) => { if (e.button === 0) this.mouse.l = false; if (e.button === 2) this.mouse.r = false; });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('mousemove', (e) => {
      if (document.pointerLockElement === canvas) { this.mouse.dx += e.movementX; this.mouse.dy += e.movementY; this.device = 'kb'; }
    });
    window.addEventListener('wheel', (e) => { if (this.active) this.state.c[e.deltaY < 0 ? 'wrapUp' : 'wrapDn']++; });
  }

  poll(dt) {
    const s = this.state, k = this.keys;
    let mx = (k.has('KeyD') ? 1 : 0) - (k.has('KeyA') ? 1 : 0), my = (k.has('KeyW') ? 1 : 0) - (k.has('KeyS') ? 1 : 0);
    let lx = 0, ly = 0, rt = this.mouse.l ? 1 : 0, lt = this.mouse.r ? 1 : 0;

    const pads = [...(navigator.getGamepads?.() || [])].filter((p) => p && p.connected);
    const pad = pads.find((p) => p.mapping === 'standard') || pads[0];
    if (pad) {
      const ax = [dz(pad.axes[0] || 0), dz(pad.axes[1] || 0), dz(pad.axes[2] || 0), dz(pad.axes[3] || 0)];
      const prt = pad.buttons[7]?.value || 0, plt = pad.buttons[6]?.value || 0;
      if (ax.some((v) => v) || prt > 0.1 || plt > 0.1) this.device = 'pad';
      mx += ax[0]; my += -ax[1]; lx = ax[2]; ly = ax[3];
      rt = Math.max(rt, prt); lt = Math.max(lt, plt);
      pad.buttons.forEach((b, i) => {
        if (b.pressed && !this.padPrev[i]) {
          this.device = 'pad';
          if (PAD[i]) s.c[PAD[i]]++;
          if (i === 8) this.fibresToggled = true;
        }
        this.padPrev[i] = b.pressed;
      });
    }
    // dYaw: + turns left. dPitch: + tilts up. Mouse forward / stick forward is negative dy / ly.
    const perScreen = Math.PI / Math.max(600, window.innerWidth);
    if (this.sawOut && lt > 0.3) {
      // saw raised: the view holds still and the same controls swing the bar instead.
      // Mouse: half a turn across one screen width.
      s.sy = clamp(s.sy - lx * 1.8 * dt - this.mouse.dx * perScreen, -Math.PI / 2, Math.PI / 2);
      s.sp = clamp(s.sp + INV * (ly * 1.8 * dt + this.mouse.dy * perScreen), -Math.PI / 2, Math.PI / 2);
    } else {
      s.sy = s.sp = 0;
      s.yaw -= lx * 2.6 * dt + this.mouse.dx * 0.0025;
      s.pitch = clamp(s.pitch + INV * (ly * 2.0 * dt + this.mouse.dy * 0.0025), -1.5, 1.5);
    }
    this.mouse.dx = this.mouse.dy = 0;
    s.mx = clamp(mx, -1, 1); s.my = clamp(my, -1, 1);
    s.rt = rt; s.lt = lt;
    return s;
  }
}
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
