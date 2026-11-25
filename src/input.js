// Gamepad + keyboard/mouse + touch -> one InputState per frame.
// Held values are "latest wins"; button presses are COUNTERS (DESIGN.md 2.5).
// Look angles and saw swing angles live here: they are applied locally and
// sent to the host. `device` is whichever of 'kb' / 'pad' / 'touch' was used last;
// the HUD uses it to name controls.

import { CFG } from './config.js';
import { blankInput } from './sim/players.js';
import { Touch } from './touch.js';

const DEAD = 0.18;
const dz = (v) => (Math.abs(v) < DEAD ? 0 : (v - Math.sign(v) * DEAD) / (1 - DEAD));

// standard gamepad button index -> counter name
// Movement is ESDF (E forward, S left, D back, F right). There are no tools: what a button does depends on what is looked at.
const PAD = { 0: 'jump', 1: 'drop', 2: 'interact', 3: 'rig', 5: 'punch', 12: 'wrapUp', 13: 'wrapDn', 9: 'respawn' };
const KEYS = { Space: 'jump', KeyC: 'drop', KeyR: 'interact', KeyW: 'rig', KeyG: 'punch', ArrowUp: 'wrapUp', ArrowDown: 'wrapDn', Enter: 'respawn' };
// held buttons for actions that take time (hold to channel, let go to cancel): state field -> [key, pad button]
const HOLD = { hi: ['KeyR', 2], hd: ['KeyC', 1] };

export class Input {
  constructor(canvas) {
    this.state = blankInput();
    this.keys = new Set(); this.mouse = { l: false, r: false, dx: 0, dy: 0 };
    this.padPrev = [];
    this.menuToggled = false;
    this.menuOpen = false;      // set by main: the settings menu has the mouse and keyboard
    this.sawOut = false;        // set by main: the local player's chainsaw is planted
    this.active = false;        // set by main: game running (not in lobby)
    this.device = 'kb';
    this.touch = new Touch(this, canvas);    // on-screen controls (src/touch.js)
    if (this.touch.on) this.device = 'touch';
    window.addEventListener('keydown', (e) => {
      this.device = 'kb';
      if (!this.active || e.repeat) return;
      if (e.code !== 'Tab' && this.menuOpen) return;
      this.keys.add(e.code);
      if (KEYS[e.code]) this.state.c[KEYS[e.code]]++;
      if (e.code === 'Tab') { this.menuToggled = true; e.preventDefault(); this.keys.clear(); return; }
      if (this.menuOpen) return;
      if (e.code === 'Space') e.preventDefault();
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
    canvas.addEventListener('mousedown', (e) => {
      this.device = 'kb';
      if (!this.active || this.menuOpen) return;
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
    let mx = (k.has('KeyF') ? 1 : 0) - (k.has('KeyS') ? 1 : 0), my = (k.has('KeyE') ? 1 : 0) - (k.has('KeyD') ? 1 : 0);
    for (const f in HOLD) s[f] = k.has(HOLD[f][0]) ? 1 : 0;
    let lx = 0, ly = 0, rt = this.mouse.l ? 1 : 0, lt = this.mouse.r ? 1 : 0;
    let tdx = 0, tdy = 0;
    if (this.touch.on) {
      const t = this.touch.take();
      mx += t.mx; my += t.my; tdx = t.dx; tdy = t.dy;
      rt = Math.max(rt, t.rt); lt = Math.max(lt, t.lt);
      if (t.hi) s.hi = 1; if (t.hd) s.hd = 1;
    }

    const pads = [...(navigator.getGamepads?.() || [])].filter((p) => p && p.connected);
    const pad = pads.find((p) => p.mapping === 'standard') || pads[0];
    if (pad) {
      const ax = [dz(pad.axes[0] || 0), dz(pad.axes[1] || 0), dz(pad.axes[2] || 0), dz(pad.axes[3] || 0)];
      const prt = pad.buttons[7]?.value || 0, plt = pad.buttons[6]?.value || 0;
      if (ax.some((v) => v) || prt > 0.1 || plt > 0.1) this.device = 'pad';
      mx += ax[0]; my += -ax[1]; lx = ax[2]; ly = ax[3];
      for (const f in HOLD) if (pad.buttons[HOLD[f][1]]?.pressed) s[f] = 1;
      rt = Math.max(rt, prt); lt = Math.max(lt, plt);
      pad.buttons.forEach((b, i) => {
        if (b.pressed && !this.padPrev[i]) {
          this.device = 'pad';
          if (PAD[i]) s.c[PAD[i]]++;
          if (i === 8) this.menuToggled = true;
        }
        this.padPrev[i] = b.pressed;
      });
    }
    // Yaw: + turns left. Pitch: + tilts up. Mouse forward / stick forward is negative dy / ly;
    // inverted look means that looks (and tilts the saw) down.
    const inv = CFG.INVERT_Y ? 1 : -1;
    if (this.sawOut && lt > 0.3) {
      // saw planted: the view holds still and the same controls pivot the bar instead.
      // The host only uses how much these change, so they are free-running angles.
      const perPx = CFG.SAW_SENS / Math.max(600, window.innerWidth);
      s.sy += -lx * CFG.SAW_SENS * 0.5 * dt - (this.mouse.dx + tdx * CFG.TOUCH_SAW_SENS) * perPx;
      s.sp += inv * (ly * CFG.SAW_SENS * 0.5 * dt + (this.mouse.dy + tdy * CFG.TOUCH_SAW_SENS) * perPx);
    } else {
      s.sy = s.sp = 0;
      s.yaw -= lx * 2.6 * dt + this.mouse.dx * CFG.LOOK_SENS + tdx * CFG.TOUCH_LOOK_SENS;
      s.pitch = clamp(s.pitch + inv * (ly * 2.0 * dt + this.mouse.dy * CFG.LOOK_SENS + tdy * CFG.TOUCH_LOOK_SENS), -1.5, 1.5);
    }
    this.mouse.dx = this.mouse.dy = 0;
    s.mx = clamp(mx, -1, 1); s.my = clamp(my, -1, 1);
    s.rt = rt; s.lt = lt;
    return s;
  }
}
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
