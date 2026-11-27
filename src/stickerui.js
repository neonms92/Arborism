// Stickers on this device (D105): the ones this player has stuck on their helmet and the ones waiting to be
// stuck, kept in localStorage so they pile up from game to game; the glowing button that says one is waiting
// (Q on a keyboard, a tap on a phone); and the dialog to aim and stick it.
//
// The host hands a sticker to the players who earned it with an 'award' event (sim/awards.js). A tree or chipper
// sticker that goes up a tier later in the same job changes colour where it is, stuck or still waiting.

import { CFG } from './config.js';
import { KINDS, ONCE } from './model/stickers.js';
import { stickerURL, stickerInfo, tierWord } from './view/stickers.js';

const KEY = 'arb-stickers';
const PENDING_MAX = 20;

const CSS = `
#stkBtn { position: fixed; z-index: 16; top: calc(10px + env(safe-area-inset-top)); right: calc(12px + env(safe-area-inset-right)); width: 58px; height: 58px;
  border-radius: 50%; border: 2px solid #fff6c8; background: radial-gradient(circle at 50% 40%, #fff7d1, #e8a23a 70%); padding: 0; cursor: pointer;
  display: none; align-items: center; justify-content: center; animation: stkGlow 1.4s ease-in-out infinite; touch-action: manipulation; }
#stkBtn img { width: 44px; height: 44px; filter: drop-shadow(0 1px 2px rgba(0,0,0,.4)); pointer-events: none; }
#stkBtn .n { position: absolute; top: -4px; left: -4px; min-width: 20px; height: 20px; border-radius: 10px; background: #c33; color: #fff; font: 700 12px/20px system-ui, sans-serif; text-align: center; padding: 0 4px; box-sizing: border-box; }
#stkBtn .k { position: absolute; bottom: -7px; right: -7px; width: 22px; height: 22px; border-radius: 5px; background: #201400; color: #ffe9a8; font: 700 13px/22px system-ui, sans-serif; text-align: center; border: 1px solid #ffe9a8; }
body.touchui #stkBtn { right: calc(60px + env(safe-area-inset-right)); top: calc(4px + env(safe-area-inset-top)); width: 48px; height: 48px; }
body.touchui #stkBtn img { width: 36px; height: 36px; }
body.touchui #stkBtn .k { display: none; }
@keyframes stkGlow { 0%, 100% { box-shadow: 0 0 6px 2px rgba(255,214,102,.65), 0 0 0 0 rgba(255,214,102,.5); transform: scale(1); }
  50% { box-shadow: 0 0 18px 7px rgba(255,214,102,.95), 0 0 0 7px rgba(255,214,102,0); transform: scale(1.06); } }
#stk { position: fixed; z-index: 20; inset: 0; display: none; align-items: center; justify-content: center; background: rgba(12,17,11,.82); }
#stk .card { position: relative; display: grid; grid-template-columns: minmax(0, 1.15fr) minmax(0, 1fr); gap: 4px 18px; width: min(94vw, 780px); max-height: 96vh;
  box-sizing: border-box; padding: 16px 18px; border-radius: 14px; background: #1f2a1b; box-shadow: 0 10px 40px rgba(0,0,0,.6); }
#stk .stage { position: relative; min-height: 0; aspect-ratio: 1 / 1; border-radius: 12px; overflow: hidden;
  background: radial-gradient(circle at 50% 45%, #4c6343, #24301f 75%); }
#stk .stage canvas { position: absolute; inset: 0; width: 100%; height: 100%; display: block; cursor: grab; }
#stk .stage .arrows { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; }
#stk .arrows .hit { pointer-events: all; cursor: pointer; }
#stk .arrows path.a { fill: none; stroke: #ffe9a8; stroke-width: 2.2; stroke-linecap: round; opacity: .85; animation: stkNudge 2.2s ease-in-out infinite; }
#stk .arrows path.h { fill: #ffe9a8; opacity: .85; }
@keyframes stkNudge { 0%, 100% { opacity: .55; } 50% { opacity: 1; } }
#stk .hint { position: absolute; left: 0; right: 0; bottom: 6px; text-align: center; font-size: 12.5px; color: #ffe9a8; opacity: .85; text-shadow: 0 1px 2px #000; pointer-events: none; }
#stk .side { display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; min-width: 0; }
#stk .side img { width: min(100%, 200px); aspect-ratio: 1 / 1; filter: drop-shadow(0 4px 6px rgba(0,0,0,.55)); transform: rotate(-6deg); }
#stk h2 { margin: 6px 0 2px; font-size: 22px; }
#stk p { margin: 4px 0 10px; opacity: .85; font-size: 14.5px; }
#stk .btns { display: flex; align-items: center; justify-content: center; gap: 14px; flex-wrap: wrap; }
#stk button { font: inherit; border: 0; cursor: pointer; border-radius: 8px; }
#stk .go { font-size: 22px; font-weight: 800; padding: 12px 28px; background: #e8a23a; color: #201400; box-shadow: 0 0 14px rgba(255,214,102,.5); }
#stk .go:disabled { opacity: .45; box-shadow: none; cursor: default; }
#stk .drop { font-size: 14px; padding: 8px 10px; background: none; color: #d8dccf; opacity: .7; text-decoration: underline; }
#stk .more { font-size: 12.5px; opacity: .7; margin-top: 8px; min-height: 1em; }
#stk .x { position: absolute; top: 6px; right: 8px; font-size: 22px; padding: 2px 9px; background: none; color: #fff; opacity: .7; }
#stk .keys { font-size: 12px; opacity: .55; margin-top: 4px; }
body.touchui #stk .keys { display: none; }
@media (pointer: coarse) { #stkBtn .k, #stk .keys { display: none; } }
#stkGuides { position: fixed; inset: 0; width: 100%; height: 100%; pointer-events: none; z-index: 21; display: none; }
#stkGuides line { stroke: #ffe9a8; stroke-width: 1.5; stroke-dasharray: 5 5; opacity: .75; }
#stkGuides polygon { fill: none; stroke: #ffe9a8; stroke-width: 1.8; stroke-dasharray: 4 3; opacity: .9; }
/* a phone held upright: model and sticker side by side, the words and buttons under both */
@media (max-aspect-ratio: 1/1) {
  #stk .card { grid-template-columns: 1.2fr 1fr; grid-template-rows: auto auto; padding: 12px; }
  #stk .side { display: contents; }
  #stk .side img { grid-column: 2; grid-row: 1; align-self: center; justify-self: center; width: 90%; }
  #stk .words { grid-column: 1 / 3; grid-row: 2; text-align: center; }
}
/* a phone on its side: little height, so a smaller sticker and tighter words */
@media (max-height: 500px) and (min-aspect-ratio: 1/1) {
  #stk .card { width: min(96vw, 760px); padding: 10px 14px; height: 92vh; grid-template-columns: auto minmax(0, 1fr); }
  #stk .stage { height: calc(92vh - 20px); aspect-ratio: 1 / 1; }
  #stk .side img { width: min(100%, 110px); }
  #stk h2 { font-size: 18px; margin: 2px 0; } #stk p { font-size: 13px; margin: 2px 0 6px; }
  #stk .go { font-size: 18px; padding: 9px 22px; }
}
`;

/** This device's stickers: stuck [{k, t, j, a, e, r}] (j: the job it came from, for colour changes) and pending [{k, t, j}]. */
export class StickerBook {
  constructor() {
    this.stuck = []; this.pending = []; this.ever = new Set();   // ever: once-ever kinds this browser has been given (D108)
    try {
      const o = JSON.parse(localStorage.getItem(KEY) || '{}');
      const ok = (s) => s && Object.hasOwn(KINDS, s.k) && Number.isInteger(s.t) && s.t >= 0 && s.t < KINDS[s.k];
      this.stuck = (Array.isArray(o.stuck) ? o.stuck : []).filter((s) => ok(s) && [s.a, s.e, s.r].every(Number.isFinite));
      this.pending = (Array.isArray(o.pending) ? o.pending : []).filter(ok);
      this.ever = new Set((Array.isArray(o.ever) ? o.ever : []).filter((k) => ONCE.has(k)));
    } catch { /* storage blocked or spoilt: start empty */ }
    this.onChange = () => {};
  }
  save() {
    try { localStorage.setItem(KEY, JSON.stringify({ stuck: this.stuck, pending: this.pending, ever: [...this.ever] })); } catch { /* storage blocked */ }
    this.onChange();
  }
  /** The stuck stickers as the model has them ([kind, tier, a, e, r]), for the host and the helmet. */
  wire() { return this.stuck.map((s) => [s.k, s.t, +s.a.toFixed(3), +s.e.toFixed(3), +s.r.toFixed(3)]); }

  /** The host handed out sticker ev.k at tier ev.tier for job ev.job. Returns the line to toast, or ''. */
  award(ev) {
    if (!Object.hasOwn(KINDS, ev.k)) return '';
    if (ONCE.has(ev.k)) { if (this.ever.has(ev.k)) return ''; this.ever.add(ev.k); }   // only the first time ever
    const same = (s) => s.k === ev.k && s.j === ev.job;
    const s = this.stuck.find(same);
    if (s) {
      if (ev.tier <= s.t) return '';
      const was = stickerInfo(s.k, s.t).name; s.t = ev.tier; this.save();
      return `Your ${was} sticker is now ${tierWord(s.k, s.t)}`;
    }
    const p = this.pending.find(same);
    if (p) { p.t = Math.max(p.t, ev.tier); }
    else { this.pending.push({ k: ev.k, t: ev.tier, j: ev.job }); if (this.pending.length > PENDING_MAX) this.pending.shift(); }
    this.save();
    return `New sticker: ${stickerInfo(ev.k, ev.tier).name}`;
  }
  stick(p, at) {
    this.pending.splice(this.pending.indexOf(p), 1);
    this.stuck.push({ k: p.k, t: p.t, j: p.j, a: at.a, e: at.e, r: at.r });
    while (this.stuck.length > CFG.STICKER_MAX) this.stuck.shift();
    this.save();
  }
  discard(p) { this.pending.splice(this.pending.indexOf(p), 1); this.save(); }
}

/** The glowing button and the sticker dialog. stage: view/stage.js, shared with the start screen. */
export class StickerUI {
  constructor(book, stage, { onOpen = () => {}, onClose = () => {} } = {}) {
    this.book = book; this.stage = stage; this.open = false; this.cur = null; this.onOpen = onOpen; this.onClose = onClose;
    const st = document.createElement('style'); st.textContent = CSS; document.head.appendChild(st);
    const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html) e.innerHTML = html; return e; };
    const btn = this.btn = el('button', '', '<img alt=""><span class="n"></span><span class="k">Q</span>');
    btn.id = 'stkBtn'; btn.title = 'A new sticker (Q)';
    btn.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); this.toggle(); });
    btn.addEventListener('pointerdown', (e) => e.stopPropagation());
    const box = this.box = el('div'); box.id = 'stk';
    box.innerHTML = `<div class="card">
      <div class="stage"><svg class="arrows" viewBox="0 0 100 100" preserveAspectRatio="none"></svg><div class="hint">Drag to turn your helmet</div></div>
      <div class="side"><img alt="">
        <div class="words"><h2></h2><p class="d"></p>
          <div class="btns"><button class="drop">Discard</button><button class="go">Stick!</button></div>
          <div class="keys">drag or arrow keys turn · Enter sticks · Esc later</div>
          <div class="more"></div></div></div>
      <button class="x" title="Later (Esc)">✕</button></div>`;
    document.body.append(btn, box);
    const g = this.guides = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); g.id = 'stkGuides'; document.body.appendChild(g);
    this.drawArrows();
    box.querySelector('.go').onclick = () => this.stick();
    box.querySelector('.drop').onclick = () => this.discard();
    box.querySelector('.x').onclick = () => this.close();
    box.addEventListener('pointerdown', (e) => { if (e.target === box) this.close(); });
    window.addEventListener('keydown', (e) => {
      const typing = e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
      if (e.code === 'KeyQ' && !typing && !e.repeat) { e.preventDefault(); this.toggle(); return; }
      if (!this.open) return;
      if (e.code === 'Escape') this.close();
      else if (e.code === 'Enter') { e.preventDefault(); this.stick(); }
      else if (e.code === 'ArrowLeft') this.stage.nudge(-0.35, 0);
      else if (e.code === 'ArrowRight') this.stage.nudge(0.35, 0);
      else if (e.code === 'ArrowUp') this.stage.nudge(0, -0.2);
      else if (e.code === 'ArrowDown') this.stage.nudge(0, 0.2);
      else return;
      e.preventDefault(); e.stopPropagation();
    }, true);
    this.refresh();
    const loop = () => { requestAnimationFrame(loop); if (this.open) this.drawGuides(); };
    requestAnimationFrame(loop);
  }

  /** Two small curved arrows under the head, left and right: a clue that it turns (drag tips it too). Each is a button. */
  drawArrows() {
    const svg = this.box.querySelector('.arrows');
    const arc = (d, head, dy, dp, hit) => `<g class="hit" data-dy="${dy}" data-dp="${dp}"><path class="hitbox" d="${hit}" fill="transparent"/><path class="a" d="${d}"/><path class="h" d="${head}"/></g>`;
    svg.innerHTML =
      arc('M44 89 Q34 88.5 28 83', 'M24.5 79.5 L30.5 81 L26.5 85.5 Z', 0.6, 0, 'M18 72 H48 V97 H18 Z') +
      arc('M56 89 Q66 88.5 72 83', 'M75.5 79.5 L69.5 81 L73.5 85.5 Z', -0.6, 0, 'M52 72 H82 V97 H52 Z');
    for (const h of svg.querySelectorAll('.hit')) h.addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); this.stage.nudge(+h.dataset.dy, +h.dataset.dp); });
  }

  refresh() {
    const n = this.book.pending.length, p = this.book.pending[n - 1];
    this.btn.style.display = n ? 'flex' : 'none';
    if (p) this.btn.querySelector('img').src = stickerURL(p.k, p.t);
    const c = this.btn.querySelector('.n'); c.textContent = String(n); c.style.display = n > 1 ? '' : 'none';
    if (this.open && !this.busy) { if (!n) this.close(); else this.show(this.book.pending.includes(this.cur) ? this.cur : p, this.stuck); }
    this.stuck = false;
  }

  toggle() { if (this.open) this.close(); else if (this.book.pending.length) this.openDialog(); }
  openDialog() {
    if (this.open || !this.book.pending.length) return;
    this.open = true;
    document.exitPointerLock?.();
    this.home = this.stage.canvas.parentNode; this.homeNext = this.stage.canvas.nextSibling;
    this.box.querySelector('.stage').prepend(this.stage.canvas);
    this.box.style.display = 'flex'; this.guides.style.display = 'block';
    this.show(this.book.pending[this.book.pending.length - 1]);
    this.onOpen();
  }
  show(p, reroll = false) {
    this.cur = p;
    const info = stickerInfo(p.k, p.t);
    this.box.querySelector('.side img').src = stickerURL(p.k, p.t);
    this.box.querySelector('h2').textContent = info.name;
    this.box.querySelector('.d').textContent = info.desc;
    const more = this.book.pending.length - 1;
    this.box.querySelector('.more').textContent = more > 0 ? `${more} more waiting` : '';
    this.stage.stick(p.k, p.t, reroll);
  }
  close() {
    if (!this.open) return;
    this.open = false; this.cur = null;
    this.box.style.display = 'none'; this.guides.style.display = 'none';
    this.stage.lobby();
    if (this.home) this.home.insertBefore(this.stage.canvas, this.homeNext && this.homeNext.parentNode === this.home ? this.homeNext : null);
    this.onClose();
  }
  stick() {
    const p = this.cur, at = this.stage.target();
    if (!p || !at || this.busy) return;
    // a moment to see it on the helmet, then the next one waiting (or the dialog shuts)
    const c = this.stage.corners();
    this.busy = true; this.stage.freeze();
    if (c) confetti(c.reduce((a, q) => a + q.x, 0) / 4, c.reduce((a, q) => a + q.y, 0) / 4);
    for (const b of this.box.querySelectorAll('.btns button')) b.disabled = true;
    this.book.stick(p, at);              // saves, tells the host and puts it on the helmet (main.js)
    setTimeout(() => { this.busy = false; this.stuck = true; for (const b of this.box.querySelectorAll('.btns button')) b.disabled = false; this.refresh(); }, 900);
  }
  discard() { if (this.cur && !this.busy) this.book.discard(this.cur); }

  /** Dashed lines from the sticker's corners to where its shadow lies on the helmet. */
  drawGuides() {
    const c = this.stage.corners(), img = this.box.querySelector('.side img');
    if (!c || !img.isConnected) { this.guides.innerHTML = ''; return; }
    // from the near side of the sticker (its left corners: the image is tipped a little) to the same corners of its shadow
    const r = img.getBoundingClientRect(), s = r.width * 0.1;
    const ic = [[r.left + s, r.bottom - s * 1.4], [r.left + s * 1.8, r.top + s]];   // bottom left, top left
    let h = `<polygon points="${c.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')}"/>`;
    [[0, 0], [1, 3]].forEach(([a, b]) => { h += `<line x1="${ic[a][0].toFixed(1)}" y1="${ic[a][1].toFixed(1)}" x2="${c[b].x.toFixed(1)}" y2="${c[b].y.toFixed(1)}"/>`; });
    this.guides.innerHTML = h;
  }
}

const CONFETTI = ['#ffd166', '#ef476f', '#06d6a0', '#118ab2', '#f78c6b', '#b388eb', '#ffffff'];
/** A burst of paper confetti from page point (x, y): a sticker just went on (D112). DOM only, gone in 1.6 s. */
function confetti(x, y) {
  let calm = false;
  try { calm = matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { /* old browser */ }
  const n = calm ? 12 : 60, layer = document.createElement('div');
  layer.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:10050;overflow:hidden';
  document.body.appendChild(layer);
  for (let i = 0; i < n; i++) {
    const d = document.createElement('i'), w = 7 + Math.random() * 6, h = Math.random() < 0.3 ? w : w * (0.4 + Math.random() * 0.3);
    d.style.cssText = `position:absolute;left:${x}px;top:${y}px;width:${w}px;height:${h}px;margin:${-h / 2}px 0 0 ${-w / 2}px;` +
      `background:${CONFETTI[i % CONFETTI.length]};border-radius:${Math.random() < 0.25 ? '50%' : '1px'}`;
    layer.appendChild(d);
    const ang = -Math.PI / 2 + (Math.random() - 0.5) * Math.PI * 1.5, v = (calm ? 60 : 120) + Math.random() * (calm ? 60 : 170);
    const dx = Math.cos(ang) * v, dy = Math.sin(ang) * v, fall = 140 + Math.random() * 120, spin = (Math.random() - 0.5) * 1440;
    const t = 1100 + Math.random() * 500;
    d.animate([
      { transform: 'translate(0,0) rotate(0deg)', opacity: 1 },
      { transform: `translate(${dx}px,${dy}px) rotate(${spin / 2}deg)`, opacity: 1, offset: 0.35 },
      { transform: `translate(${dx * 1.2}px,${dy + fall * 0.6}px) rotate(${spin * 0.8}deg)`, opacity: 1, offset: 0.75 },
      { transform: `translate(${dx * 1.3}px,${dy + fall}px) rotate(${spin}deg)`, opacity: 0 },
    ], { duration: t, easing: 'cubic-bezier(.2,.7,.4,1)', fill: 'forwards' });
  }
  setTimeout(() => layer.remove(), 1700);
}
