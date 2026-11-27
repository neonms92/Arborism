// A small 3-D stage with one player on it, on its own canvas (D105): the start screen shows you as you will
// look (name, shirt, stickers, blinking), and the sticker dialog shows your head close up to aim a sticker.
// It draws only while its canvas is on screen.
//
//   lobby mode: the whole body, turning gently to and fro; drag turns it, a change of name or shirt makes it hop.
//               Dragging down lifts the camera (from the default view up to CFG.STAGE_TILT_MAX above the horizon),
//               closing in on the helmet near the top to show the stickers; while the name box has focus the
//               camera eases in on the name tag (nameFocus()).
//   stick mode: the helmet close up, turned by dragging (or the arrows, nudge()); the spot facing the camera
//               is where the sticker goes, shown by its shadow (target()).

import * as THREE from 'three';
import { CFG } from '../config.js';
import { Avatar, HELMET_Y, HELMET_PHI, stickerMesh, rollFor, stickerDir } from './avatar.js';

const P_MIN = Math.PI / 2 - HELMET_PHI + 0.22;   // least tilt toward the camera that still puts the whole sticker on the helmet
const P_MAX = Math.PI / 2;                       // looking straight down on the top
const _v = new THREE.Vector3(), _q = new THREE.Quaternion(), _u = new THREE.Vector3();
const _t = new THREE.Vector3(), _c = new THREE.Vector3(), _n = new THREE.Vector3(), _w = new THREE.Vector3();
const smooth = (x) => { x = Math.max(0, Math.min(1, x)); return x * x * (3 - 2 * x); };

export class Stage {
  constructor() {
    const cv = this.canvas = document.createElement('canvas');
    cv.className = 'stage3d'; cv.style.touchAction = 'none';
    this.renderer = null;                         // made on first show (a WebGL context only when needed)
    this.scene = new THREE.Scene();
    this.scene.add(new THREE.HemisphereLight(0xf2f6ff, 0x3d4a33, 1.7));
    const sun = new THREE.DirectionalLight(0xffffff, 2.2); sun.position.set(1.6, 2.4, 2.6); this.scene.add(sun);
    this.camera = new THREE.PerspectiveCamera(26, 1, 0.05, 30);
    this.pivot = new THREE.Group(); this.scene.add(this.pivot);
    this.av = new Avatar(); this.pivot.add(this.av.group);
    this.av.group.rotation.y = Math.PI;           // faces the camera (+z) at yaw 0
    this.mode = 'lobby'; this.yaw = 0; this.pitch = 0; this.toYaw = null; this.toPitch = null;
    this.elev = -1; this.nameOn = false; this.nameT = 0;   // lobby camera: angle above the horizon (clamped in frame), name-tag zoom 0..1
    this.t = 0; this.hop = 0; this.dragT = 0; this.ghost = null; this.ghostKey = ''; this.sticker = null; this.tgt = null;
    let drag = null;
    cv.addEventListener('pointerdown', (e) => { drag = { id: e.pointerId, x: e.clientX, y: e.clientY }; try { cv.setPointerCapture(e.pointerId); } catch { /* gone */ } e.preventDefault(); });
    cv.addEventListener('pointermove', (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      const k = 7 / Math.max(300, cv.clientWidth);
      this.turn((e.clientX - drag.x) * k, (e.clientY - drag.y) * k);
      drag.x = e.clientX; drag.y = e.clientY;
    });
    const up = (e) => { if (drag && e.pointerId === drag.id) drag = null; };
    cv.addEventListener('pointerup', up); cv.addEventListener('pointercancel', up);
    const loop = (now) => { requestAnimationFrame(loop); const dt = Math.min(0.1, (now - (this.last || now)) / 1000); this.last = now; this.frame(dt); };
    requestAnimationFrame(loop);
  }

  turn(dy, dp) {
    this.toYaw = this.toPitch = null; this.dragT = 3;
    this.yaw += dy;
    if (this.mode === 'stick') this.pitch = Math.max(P_MIN, Math.min(P_MAX, this.pitch + dp));
    else this.elev = Math.max(this.elev0 ?? 0, Math.min(CFG.STAGE_TILT_MAX * Math.PI / 180, this.elev + dp * 0.5));
  }
  /** An arrow pressed: turn by this much, smoothly. */
  nudge(dy, dp) {
    this.toYaw = (this.toYaw ?? this.yaw) + dy;
    this.toPitch = Math.max(P_MIN, Math.min(P_MAX, (this.toPitch ?? this.pitch) + dp));
  }

  look(name, color) { if (this.av.setLook(name, color) && this.lookSeen) { this.hop = 1; this.av.blinkNow(); } this.lookSeen = true; }
  stickers(list) { this.av.setStickers(list); }
  /** The name box has (or lost) focus: zoom in on the name tag, or back out to the view before. */
  nameFocus(on) { this.nameOn = !!on; }

  lobby() { this.mode = 'lobby'; this.av.group.position.set(0, 0, 0); this.pivot.quaternion.identity(); this.yaw = 0; this.setGhost(null); }
  /** Aim sticker {k, t}: the head close up, turned to some spot on the side or top of the helmet. */
  stick(k, t) {
    const fresh = this.mode !== 'stick';
    this.mode = 'stick'; this.sticker = { k, t }; this.frozen = false;
    this.av.group.position.set(0, -HELMET_Y, 0);
    if (fresh) { this.yaw = (Math.random() < 0.5 ? -1 : 1) * (1.1 + Math.random() * 1.2); this.pitch = 0.75 + Math.random() * 0.4; this.toYaw = this.toPitch = null; }
    this.ghostKey = '';
  }
  /** Just stuck: no shadow until the next sticker. */
  freeze() { this.frozen = true; this.tgt = null; this.setGhost(null); }
  setGhost(m) {
    if (this.ghost) { this.ghost.geometry.dispose(); this.ghost.material.dispose(); this.av.group.remove(this.ghost); }
    this.ghost = m; if (m) this.av.group.add(m);
  }

  /** Where the sticker goes now: {a, e, r} on the helmet (model/stickers.js), or null. */
  target() { return this.tgt; }
  /** The four corners of the shadow on screen (page px), for the guide lines; null when not shown. */
  corners() {
    if (!this.ghost || !this.canvas.isConnected) return null;
    const pos = this.ghost.geometry.attributes.position, n = Math.round(Math.sqrt(pos.count)) - 1, r = this.canvas.getBoundingClientRect();
    return [0, n, (n + 1) * (n + 1) - 1, (n + 1) * n].map((i) => {
      _v.fromBufferAttribute(pos, i).applyMatrix4(this.av.group.matrixWorld).project(this.camera);
      return { x: r.left + (_v.x + 1) / 2 * r.width, y: r.top + (1 - _v.y) / 2 * r.height };
    });
  }

  frame(dt) {
    const cv = this.canvas;
    if (!cv.isConnected || !cv.offsetParent) return;
    const w = cv.clientWidth, h = cv.clientHeight;
    if (w < 2 || h < 2) return;
    if (!this.renderer) {
      this.renderer = new THREE.WebGLRenderer({ canvas: cv, antialias: true, alpha: true });
      this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    }
    const pr = Math.min(2, window.devicePixelRatio || 1);
    if (cv.width !== Math.round(w * pr) || cv.height !== Math.round(h * pr)) { this.renderer.setPixelRatio(pr); this.renderer.setSize(w, h, false); }
    this.camera.aspect = w / h;
    this.t += dt; this.dragT -= dt;
    const blink = this.av.blinking(dt);
    this.av.setEyes(blink ? 'blink' : 'open');
    const ease = (v, to) => v + (to - v) * Math.min(1, dt * 8);
    if (this.toYaw !== null) { this.yaw = ease(this.yaw, this.toYaw); if (Math.abs(this.yaw - this.toYaw) < 1e-3) this.toYaw = null; }
    if (this.toPitch !== null) { this.pitch = ease(this.pitch, this.toPitch); if (Math.abs(this.pitch - this.toPitch) < 1e-3) this.toPitch = null; }

    if (this.mode === 'lobby') {
      // whole body in view whatever the shape of the box: fit 1.95 m tall and 0.9 m wide
      const half = Math.tan(this.camera.fov * Math.PI / 360), asp = this.camera.aspect;
      const d0 = Math.max(0.92 / half, 0.45 / (half * asp)) + 0.15;
      const e0 = this.elev0 = Math.atan2(0.13, d0), eMax = CFG.STAGE_TILT_MAX * Math.PI / 180;   // the default view is the lowest
      this.elev = Math.max(e0, Math.min(eMax, this.elev));
      this.nameT += ((this.nameOn ? 1 : 0) - this.nameT) * Math.min(1, dt * CFG.STAGE_ZOOM_RATE);
      const zn = smooth(this.nameT);
      if (this.nameOn) {                          // turn the tag to the camera, the shorter way round
        const want = Math.PI - this.av.tagAt;
        const to = want + 2 * Math.PI * Math.round((this.yaw - want) / (2 * Math.PI));
        this.yaw += (to - this.yaw) * Math.min(1, dt * CFG.STAGE_ZOOM_RATE * 1.5); this.dragT = 1;
      } else if (this.dragT <= 0) this.yaw += (Math.sin(this.t * 0.5) * 0.45 * (1 - zn) - this.yaw) * Math.min(1, dt * 0.8);   // drifting back to its idle sway
      this.hop = Math.max(0, this.hop - dt * 2.5);
      this.pivot.position.y = Math.sin((1 - this.hop) * Math.PI) * this.hop * 0.18;
      this.pivot.quaternion.setFromEuler(new THREE.Euler(0, this.yaw, 0));
      // orbit: around the body, closing in on the helmet (framed as in the sticker dialog) near the top
      const zh = smooth(((this.elev - e0) / Math.max(1e-6, eMax - e0) - CFG.STAGE_HELMET_FROM) / (1 - CFG.STAGE_HELMET_FROM));
      const dist = THREE.MathUtils.lerp(Math.hypot(d0, 0.13), 0.3 / (half * Math.min(1, asp)), zh);
      _t.set(0, THREE.MathUtils.lerp(-0.03, HELMET_Y, zh), 0);
      _c.set(0, Math.sin(this.elev) * dist, Math.cos(this.elev) * dist).add(_t);
      if (zn > 0) {                               // the name tag close up, from in front and a little above
        this.scene.updateMatrixWorld();
        const tg = this.av.tag, a = this.av.tagAt;
        _n.set(Math.sin(a) * 0.263, tg.position.y, Math.cos(a) * 0.263);
        this.av.group.localToWorld(_n);
        const dn = Math.max(0.13 / half, 0.2 / (half * asp));   // about 0.26 m of chest top to bottom
        _w.set(0, Math.sin(0.12) * dn, Math.cos(0.12) * dn).add(_n);
        _t.lerp(_n, zn); _c.lerp(_w, zn);
      }
      this.camera.position.copy(_c); this.camera.lookAt(_t);
    } else {
      const half = Math.tan(this.camera.fov * Math.PI / 360), d = 0.3 / (half * Math.min(1, this.camera.aspect));
      this.camera.position.set(0, 0, d); this.camera.lookAt(0, 0, 0);
      this.pivot.position.set(0, 0, 0);
      this.pivot.quaternion.setFromEuler(new THREE.Euler(this.pitch, this.yaw, 0, 'XYZ'));
      if (!this.frozen) this.aim();
    }
    this.camera.updateProjectionMatrix();
    this.renderer.render(this.scene, this.camera);
  }

  /** The spot on the helmet facing the camera, and the sticker's shadow there (upright as the camera sees it). */
  aim() {
    this.scene.updateMatrixWorld();
    _q.copy(this.av.group.getWorldQuaternion(_q)).invert();
    const d = _v.set(0, 0, 1).applyQuaternion(_q).normalize(), up = _u.set(0, 1, 0).applyQuaternion(_q);
    const a = Math.atan2(d.x, -d.z), e = Math.asin(Math.max(-1, Math.min(1, d.y))), r = rollFor(stickerDir(a, e), up);
    this.tgt = { a, e, r };
    const key = `${this.sticker.k}${this.sticker.t}|${a.toFixed(3)}|${e.toFixed(3)}|${r.toFixed(3)}`;
    if (key === this.ghostKey) return;
    this.ghostKey = key;
    this.setGhost(stickerMesh(this.sticker.k, this.sticker.t, a, e, r, 0, true));
  }
}
