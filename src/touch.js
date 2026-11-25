// Touch controls for phones and tablets: the third input device next to the
// keyboard / mouse and the gamepad (DESIGN.md 7). It only fills in the same
// InputState the others do: nothing in sim/ knows a finger was used.
//
// Left of the screen: a floating stick under the thumb (move / climb).
// Right of the screen: drag to look (or, with the saw planted, to pivot the bar).
// One big context button (interact) labelled with what it will do now; the other
// buttons appear only while the host's prompt offers them. Held actions (the
// lanyard, letting go of the tree) are held buttons, and the ring round the
// reticle fills as for the other devices.
//
// On by default on touch-first screens; ?touch forces it on, ?touch=0 off.

import { CFG, MODE } from './config.js';
import { describe } from './view/hud.js';

const CSS = `
#touch { position: fixed; inset: 0; z-index: 5; touch-action: none; -webkit-user-select: none; user-select: none; -webkit-touch-callout: none; display: none; }
#touch .tb { position: absolute; display: flex; align-items: center; justify-content: center; text-align: center; box-sizing: border-box;
  border-radius: 50%; background: rgba(20,27,18,.55); border: 2px solid rgba(255,255,255,.55); color: #fff; font: 600 13px/1.1 system-ui, sans-serif;
  text-shadow: 0 1px 2px #000; padding: 6px; touch-action: none; }
#touch .tb.down { background: rgba(232,162,58,.75); color: #201400; text-shadow: none; }
#touch .tb.on { background: rgba(232,162,58,.9); color: #201400; text-shadow: none; border-color: #fff; }
#touch .tb.dim { opacity: .4; }
#touch .tb.small { border-radius: 12px; font-size: 18px; }
#touch .act, #touch .rig { font-size: 12px; }
/* the bottom of the screen belongs to the thumbs: prompt, rope line and toasts go up top */
body.touchui #prompt { bottom: auto; top: calc(34px + env(safe-area-inset-top)); left: 90px; right: 130px; font-size: 15px; }
body.touchui #rope { bottom: auto; top: calc(80px + env(safe-area-inset-top)); left: 90px; right: 130px; font-size: 13px; }
body.touchui #toasts { top: calc(110px + env(safe-area-inset-top)); font-size: 15px; }
#touch .stick { position: absolute; width: 0; height: 0; display: none; pointer-events: none; }
#touch .stick .base { position: absolute; border-radius: 50%; border: 2px solid rgba(255,255,255,.45); background: rgba(0,0,0,.18); }
#touch .stick .knob { position: absolute; width: 56px; height: 56px; margin: -28px; border-radius: 50%; background: rgba(255,255,255,.55); }
#touch .slider { position: absolute; width: 64px; border-radius: 32px; background: rgba(20,27,18,.55); border: 2px solid rgba(255,255,255,.55); touch-action: none; }
#touch .slider .knob { position: absolute; left: 6px; width: 48px; height: 48px; margin-top: -24px; border-radius: 50%; background: rgba(255,233,168,.85); pointer-events: none; }
#touch .slider .lab { position: absolute; left: 0; right: 0; text-align: center; font: 600 12px system-ui, sans-serif; color: #ffe9a8; text-shadow: 0 1px 2px #000; pointer-events: none; }
`;

// A button: [id, label, counter pressed on touch-down, held InputState field, layout]
// layout: [side ('l' | 'r'), x from that side, bottom, size] in CSS px, before safe-area insets.
const BUTTONS = [
  ['act', '', 'interact', 'hi', ['r', 20, 22, 108]],
  ['jump', 'Jump', 'jump', null, ['r', 140, 18, 64]],
  ['punch', 'Punch', 'punch', null, ['r', 146, 92, 64]],
  ['rig', 'Rig', 'rig', null, ['r', 108, 160, 84]],
  ['letgo', '⏳ Let go', 'drop', 'hd', ['r', 28, 150, 72]],
  ['saw', 'Saw', null, null, ['r', 214, 22, 64]],
  ['cut', 'Cut', null, null, ['l', 24, 150, 84]],
  ['wup', 'Wrap +', 'wrapUp', null, ['l', 104, 196, 56]],
  ['wdn', 'Wrap −', 'wrapDn', null, ['l', 104, 124, 56]],
];

/** True on a screen where touch is the main way in (a phone or tablet with no mouse). */
export function touchFirst() {
  const q = new URLSearchParams(location.search);
  if (q.has('touch')) return q.get('touch') !== '0';
  return !!(window.matchMedia && matchMedia('(pointer: coarse)').matches && !matchMedia('(any-pointer: fine)').matches);
}

export class Touch {
  constructor(input, canvas) {
    this.input = input;
    this.on = touchFirst();
    this.forcedOff = new URLSearchParams(location.search).get('touch') === '0';
    const st = document.createElement('style'); st.textContent = CSS; document.head.appendChild(st);
    const root = this.root = document.createElement('div'); root.id = 'touch';
    document.body.appendChild(root);

    this.mx = 0; this.my = 0; this.dx = 0; this.dy = 0;
    this.held = {};             // InputState hold field -> number of fingers on its button
    this.saw = false;           // the Saw button is a toggle: the bar stays planted until it is tapped again
    this.cutting = false;
    this.rope = 0;              // rope slider: +1 haul in (top) .. -1 ease off (bottom)
    this.fingers = new Map();   // pointer id -> {kind: 'stick' | 'look', x, y, x0, y0}

    // the stick, drawn where the thumb landed
    this.stick = el('div', 'stick'); const base = el('div', 'base'); this.knob = el('div', 'knob');
    this.stick.append(base, this.knob); root.appendChild(this.stick); this.base = base;

    this.b = {};
    for (const [id, label, counter, hold, lay] of BUTTONS) {
      const b = el('div', 'tb' + (id === 'act' || id === 'rig' ? ' ' + id : ''));
      b.textContent = label; b.style.whiteSpace = 'pre-line';
      place(b, lay);
      this.b[id] = b; root.appendChild(b);
      this.press(b, () => {
        if (counter) this.count(counter);
        if (hold) this.held[hold] = (this.held[hold] || 0) + 1;
        if (id === 'saw') { this.saw = !this.saw; }
        if (id === 'cut') this.cutting = true;
      }, () => {
        if (hold) this.held[hold] = Math.max(0, (this.held[hold] || 0) - 1);
        if (id === 'cut') this.cutting = false;
      });
    }
    // top right: settings and respawn
    const top = (label, x, fn) => {
      const b = el('div', 'tb small'); b.textContent = label;
      b.style.width = b.style.height = '44px';
      b.style.right = `calc(${x}px + env(safe-area-inset-right))`; b.style.top = 'calc(6px + env(safe-area-inset-top))';
      this.press(b, fn, () => {}); root.appendChild(b); return b;
    };
    top('⚙', 8, () => { this.input.menuToggled = true; });
    top('↺', 60, () => this.count('respawn'));

    // rope tail: a spring-centred vertical slider (up hauls in, down eases off) and the wraps buttons beside it
    const sl = this.slider = el('div', 'slider'), sk = el('div', 'knob');
    const lu = el('div', 'lab'), ld = el('div', 'lab'); lu.textContent = 'haul'; ld.textContent = 'ease';
    lu.style.top = '6px'; ld.style.bottom = '6px';
    sl.append(lu, ld, sk); this.sliderKnob = sk;
    sl.style.left = 'calc(24px + env(safe-area-inset-left))'; sl.style.bottom = 'calc(110px + env(safe-area-inset-bottom))'; sl.style.height = '170px';
    root.appendChild(sl);
    const setRope = (e) => {
      const r = sl.getBoundingClientRect(), mid = r.top + r.height / 2, half = r.height / 2 - 24;
      this.rope = clamp((mid - e.clientY) / half, -1, 1);
    };
    let ropeId = null;
    sl.addEventListener('pointerdown', (e) => { e.stopPropagation(); e.preventDefault(); this.seen(e); ropeId = e.pointerId; capture(sl, e); setRope(e); });
    sl.addEventListener('pointermove', (e) => { if (e.pointerId === ropeId) setRope(e); });
    const ropeUp = (e) => { if (e.pointerId === ropeId) { ropeId = null; this.rope = 0; } };
    sl.addEventListener('pointerup', ropeUp); sl.addEventListener('pointercancel', ropeUp);

    // the rest of the screen: left = stick, right = look
    root.addEventListener('pointerdown', (e) => {
      if (e.target !== root) return;
      e.preventDefault(); this.seen(e); capture(root, e);
      const kind = e.clientX < innerWidth * 0.42 && ![...this.fingers.values()].some((f) => f.kind === 'stick') ? 'stick' : 'look';
      this.fingers.set(e.pointerId, { kind, x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY });
      if (kind === 'stick') this.drawStick(e.clientX, e.clientY, e.clientX, e.clientY);
    });
    root.addEventListener('pointermove', (e) => {
      const f = this.fingers.get(e.pointerId); if (!f) return;
      if (f.kind === 'look') { this.dx += e.clientX - f.x; this.dy += e.clientY - f.y; }
      f.x = e.clientX; f.y = e.clientY;
      if (f.kind === 'stick') {
        const R = Math.max(10, CFG.TOUCH_STICK_R);
        let vx = (f.x - f.x0) / R, vy = (f.y - f.y0) / R; const m = Math.hypot(vx, vy);
        if (m > 1) {
          // past the edge the stick follows the thumb, so turning back answers at once
          vx /= m; vy /= m; f.x0 = f.x - vx * R; f.y0 = f.y - vy * R;
        }
        this.mx = vx; this.my = -vy;
        this.drawStick(f.x0, f.y0, f.x, f.y);
      }
    });
    const up = (e) => {
      const f = this.fingers.get(e.pointerId); if (!f) return;
      this.fingers.delete(e.pointerId);
      if (f.kind === 'stick') { this.mx = this.my = 0; this.stick.style.display = 'none'; }
    };
    root.addEventListener('pointerup', up); root.addEventListener('pointercancel', up);
    root.addEventListener('contextmenu', (e) => e.preventDefault());
    // a touch screen that did not say it was touch-first: the first finger on the game turns the controls on
    canvas.addEventListener('pointerdown', (e) => { if (e.pointerType === 'touch' && !this.forcedOff && !this.on) { this.on = true; this.input.device = 'touch'; } });
    window.addEventListener('blur', () => this.releaseAll());
  }

  seen(e) { if (e.pointerType === 'touch' || this.on) this.input.device = 'touch'; }
  count(name) { const i = this.input; if (i.active && !i.menuOpen) i.state.c[name]++; }

  /** Pointer-down / up handlers for a button, holding the finger on it until it lifts. */
  press(b, down, upFn) {
    let ids = new Set();
    b.addEventListener('pointerdown', (e) => { e.stopPropagation(); e.preventDefault(); this.seen(e); capture(b, e); ids.add(e.pointerId); b.classList.add('down'); down(); });
    const up = (e) => { if (!ids.delete(e.pointerId)) return; if (!ids.size) b.classList.remove('down'); upFn(); };
    b.addEventListener('pointerup', up); b.addEventListener('pointercancel', up);
    b.addEventListener('contextmenu', (e) => e.preventDefault());
    this._release = this._release || [];
    this._release.push(() => { for (const id of [...ids]) up({ pointerId: id }); });
  }

  releaseAll() {
    for (const f of this._release || []) f();
    this.fingers.clear(); this.mx = this.my = 0; this.rope = 0; this.stick.style.display = 'none';
  }

  drawStick(x0, y0, x, y) {
    const R = Math.max(10, CFG.TOUCH_STICK_R);
    this.stick.style.display = 'block'; this.stick.style.left = x0 + 'px'; this.stick.style.top = y0 + 'px';
    Object.assign(this.base.style, { width: 2 * R + 'px', height: 2 * R + 'px', left: -R + 'px', top: -R + 'px' });
    this.knob.style.left = (x - x0) + 'px'; this.knob.style.top = (y - y0) + 'px';
  }

  /** This frame's touch input, merged into the InputState by Input.poll. Look travel is consumed. */
  take() {
    const t = { mx: this.mx, my: this.my, dx: this.dx, dy: this.dy, lt: 0, rt: 0, hi: !!this.held.hi, hd: !!this.held.hd };
    this.dx = this.dy = 0;
    if (this.ropeMode) { t.lt = Math.max(0, this.rope); t.rt = Math.max(0, -this.rope); }
    else { t.lt = this.saw ? 1 : 0; t.rt = this.cutting ? 1 : 0; }
    return t;
  }

  /**
   * Once a frame from main: show the controls the moment offers.
   * a: the local player's aux ({m, pr, saw...}) or null.
   */
  sync(a, show) {
    const vis = this.on && show;
    this.root.style.display = vis ? 'block' : 'none';
    document.body.classList.toggle('touchui', vis);
    if (!vis) { if (this.fingers.size || this.mx || this.my) this.releaseAll(); return; }
    const pr = (a && a.pr) || '', has = (tok) => pr.includes('{' + tok + '}');
    const rope = !!(a && a.m === MODE.ROPE), sawOut = !!(a && a.saw);
    this.ropeMode = rope;
    if (rope) this.saw = false;
    const act = actionLabel(pr);
    // Rig says what it will do: hang, tie, untie and take down are all this one button, and which one it is
    // depends on where you look (near the block it takes the block down). With a block hung and no wood in
    // reach it stays up, dimmed, so it is clear the tie is waiting on getting closer.
    const rig = actionLabel(pr, 'rig'), waiting = !rig && /rope to/.test(pr);
    const b = this.b;
    b.act.textContent = act || 'Action'; b.act.classList.toggle('dim', !act);
    show1(b.jump, !a || a.m === MODE.GROUND);
    show1(b.punch, has('punch'));
    show1(b.rig, !!rig || waiting); b.rig.classList.toggle('dim', waiting);
    b.rig.textContent = rig || 'Get closer';
    show1(b.letgo, has('drop'));
    show1(b.saw, !rope && (has('raise') || this.saw || sawOut)); b.saw.classList.toggle('on', this.saw);
    b.saw.textContent = this.saw ? 'Lift saw' : 'Saw';
    show1(b.cut, !rope && (this.saw || sawOut));
    show1(b.wup, rope); show1(b.wdn, rope);
    this.slider.style.display = rope ? 'block' : 'none';
    if (rope) this.sliderKnob.style.top = `${50 - this.rope * (50 - 24 / 1.7)}%`;
    if (!rope && b.cut.style.display === 'none') this.cutting = false;
  }
}

/** The words after {token} (default interact) in a host prompt: what that button will do. */
export function actionLabel(pr, token = 'interact') {
  const tok = '{' + token + '}';
  for (const part of pr.split(/\s{3,}/)) {
    const i = part.indexOf(tok);
    if (i < 0) continue;
    let s = part.slice(i + tok.length).replace(/^[:\s]+/, '');
    const hold = /hold/i.test(part.slice(0, i));
    // quantities ({mass:42}) in the HUD's units, other tokens dropped; captions are kept to two words plus a weight
    s = describe(s, 'touch').trim();
    s = s.replace(/^\w/, (c) => c.toUpperCase());
    return (hold ? '⏳ ' : '') + (s || 'Action');
  }
  return '';
}

const el = (tag, cls) => { const e = document.createElement(tag); e.className = cls; return e; };
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const capture = (node, e) => { try { node.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ } };
const show1 = (b, on) => { b.style.display = on ? 'flex' : 'none'; };
function place(b, [side, x, bottom, size]) {
  b.style.width = b.style.height = size + 'px';
  b.style[side === 'l' ? 'left' : 'right'] = `calc(${x}px + env(safe-area-inset-${side === 'l' ? 'left' : 'right'}))`;
  b.style.bottom = `calc(${bottom}px + env(safe-area-inset-bottom))`;
}
