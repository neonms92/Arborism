// Gamepad + keyboard/mouse -> one InputState per frame.
// Held values are "latest wins"; button presses are COUNTERS (DESIGN.md 2.5).
// Look angles live here: they are applied locally and sent to the host.

import { blankInput } from './sim/players.js';

const DEAD = 0.18;
const dz = (v) => (Math.abs(v) < DEAD ? 0 : (v - Math.sign(v) * DEAD) / (1 - DEAD));

// standard gamepad button index -> counter name
const PAD = { 0: 'jump', 1: 'drop', 2: 'interact', 3: 'lanyard', 4: 'toolPrev', 5: 'toolNext', 12: 'wrapUp', 13: 'wrapDn', 9: 'respawn' };
const KEYS = { Space: 'jump', KeyC: 'drop', KeyE: 'interact', KeyF: 'lanyard', KeyQ: 'toolPrev', KeyR: 'toolNext', ArrowUp: 'wrapUp', ArrowDown: 'wrapDn', Enter: 'respawn' };

export class Input {
  constructor(canvas) {
    this.state = blankInput();
    this.keys = new Set(); this.mouse = { l: false, r: false, dx: 0, dy: 0, wheel: 0 };
    this.padPrev = [];
    this.overlayToggled = false;
    this.precise = false;       // set by main: local player's saw is engaged
    this.active = false;        // set by main: game running (not in lobby)
    window.addEventListener('keydown', (e) => {
      if (!this.active || e.repeat) return;
      this.keys.add(e.code);
      if (KEYS[e.code]) this.state.c[KEYS[e.code]]++;
      if (e.code === 'Tab') { this.overlayToggled = true; e.preventDefault(); }
      if (e.code === 'Space') e.preventDefault();
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
    canvas.addEventListener('mousedown', (e) => {
      if (!this.active) return;
      if (document.pointerLockElement !== canvas) { canvas.requestPointerLock?.(); return; }
      if (e.button === 0) this.mouse.l = true; if (e.button === 2) this.mouse.r = true;
    });
    window.addEventListener('mouseup', (e) => { if (e.button === 0) this.mouse.l = false; if (e.button === 2) this.mouse.r = false; });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('mousemove', (e) => {
      if (document.pointerLockElement === canvas) { this.mouse.dx += e.movementX; this.mouse.dy += e.movementY; }
    });
    window.addEventListener('wheel', (e) => { if (this.active) this.state.c[e.deltaY < 0 ? 'wrapUp' : 'wrapDn']++; });
  }

  poll(dt) {
    const s = this.state, k = this.keys;
    let mx = (k.has('KeyD') ? 1 : 0) - (k.has('KeyA') ? 1 : 0), my = (k.has('KeyW') ? 1 : 0) - (k.has('KeyS') ? 1 : 0);
    let lx = 0, ly = 0, rt = this.mouse.l ? 1 : 0, lt = this.mouse.r ? 1 : 0;
    let ty = (k.has('KeyX') ? 1 : 0) - (k.has('KeyZ') ? 1 : 0);

    const pad = [...(navigator.getGamepads?.() || [])].find((p) => p && p.connected && p.mapping === 'standard')
      || [...(navigator.getGamepads?.() || [])].find((p) => p && p.connected);
    if (pad) {
      mx += dz(pad.axes[0] || 0); my += -dz(pad.axes[1] || 0);
      lx = dz(pad.axes[2] || 0); ly = dz(pad.axes[3] || 0);
      rt = Math.max(rt, pad.buttons[7]?.value || 0); lt = Math.max(lt, pad.buttons[6]?.value || 0);
      pad.buttons.forEach((b, i) => {
        if (b.pressed && !this.padPrev[i]) {
          if (PAD[i]) s.c[PAD[i]]++;
          if (i === 8) this.overlayToggled = true;
        }
        this.padPrev[i] = b.pressed;
      });
    }
    // look
    s.yaw -= lx * 2.6 * dt + this.mouse.dx * 0.0025;
    if (this.precise) ty += -ly + this.mouse.dy * -0.02;
    else s.pitch -= ly * 2.0 * dt + this.mouse.dy * 0.0025;
    s.pitch = Math.max(-1.45, Math.min(1.45, s.pitch));
    this.mouse.dx = this.mouse.dy = 0;
    s.mx = Math.max(-1, Math.min(1, mx)); s.my = Math.max(-1, Math.min(1, my));
    s.ty = Math.max(-1, Math.min(1, ty));
    s.rt = rt; s.lt = lt;
    return s;
  }
}
