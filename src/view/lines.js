// Draws the power lines (model/lines.js): every link of every line as a thin dark cylinder in one instanced mesh,
// where the host's solver has the line (src.line(i): the host's own points, or a joined player's copy of the last
// ones it was sent), or hanging at rest where nothing has been sent. A joined player's lines ease towards each new
// set of points so they do not jump at 10 Hz. A line that snaps (or a player who touches one) makes a white flash
// you can see from far off; the live ends of a downed line lying on the ground spark now and then, until it goes
// dead. No game rules.

import * as THREE from 'three';
import { endRest, restNodes, HW, isLive } from '../model/lines.js';
import { POLE } from '../model/stands.js';
import { frameApply } from '../model/flex.js';
import { segParam } from '../model/world.js';
import { groundY } from '../model/terrain.js';

const R = 0.016;                                   // m, drawn radius of a line (a service drop: triplex, thicker)
const RK = [0.8, 1.15, 0.8, 0.6];                  // by KIND: phase, drop, neutral, tap
const _m = new THREE.Matrix4(), _a = new THREE.Vector3(), _b = new THREE.Vector3(), _q = new THREE.Quaternion(), _s = new THREE.Vector3();
const _P = new THREE.Vector3(), _Q = new THREE.Quaternion(), _o = new THREE.Vector3(), _q2 = new THREE.Quaternion();
const Y = new THREE.Vector3(0, 1, 0), ZERO = new THREE.Matrix4().makeScale(0, 0, 0);

export class LinesView {
  constructor(scene, world, view) {
    this.scene = scene; this.world = world; this.view = view;
    this.mesh = null; this.lines = [];             // per line: {first instance, cur: drawn points, rest}
    this.geo = new THREE.CylinderGeometry(1, 1, 1, 5, 1, true);
    this.mat = new THREE.MeshLambertMaterial({ color: 0x202224 });
    // flashes: a few sprites reused, and one light that goes where the brightest one is
    const c = document.createElement('canvas'); c.width = c.height = 64;
    const g = c.getContext('2d'), gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.18, 'rgba(235,242,255,0.95)'); gr.addColorStop(0.45, 'rgba(180,205,255,0.35)'); gr.addColorStop(1, 'rgba(160,190,255,0)');
    g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
    this.tex = new THREE.CanvasTexture(c);
    this.flashes = [];
    for (let i = 0; i < 8; i++) {
      const core = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.tex, color: 0xffffff, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, fog: false }));
      // the glow round a big one keeps its size on screen however far away it is, and shows over roofs
      const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.tex, color: 0xe8f0ff, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, depthTest: false, sizeAttenuation: false, fog: false }));
      core.visible = halo.visible = false; halo.renderOrder = 5;
      scene.add(core, halo);
      this.flashes.push({ core, halo, at: new THREE.Vector3(), t: 0, life: 0, size: 0, big: false });
    }
    // pole hardware: pin insulators, the neutral's spool, transformer cans (each part one instanced mesh)
    const cyl = (rt, rb, h, seg = 10) => new THREE.CylinderGeometry(rt, rb, h, seg);
    const lam = (c) => new THREE.MeshLambertMaterial({ color: c });
    const grey = lam(0x8f979b), porc = lam(0xb9bdb6), steel = lam(0x3a3c3e);
    this.parts = {
      pin: [cyl(0.03, 0.055, POLE.PIN_H), porc], spool: [cyl(0.045, 0.045, 0.1), porc],
      can: [cyl(POLE.CAN_R, POLE.CAN_R, POLE.CAN_H, 16), grey], lid: [cyl(POLE.CAN_R + 0.02, POLE.CAN_R + 0.02, 0.05, 16), grey],
      bush: [cyl(0.025, 0.035, 0.16, 8), porc], strap: [new THREE.BoxGeometry(0.12, 0.35, 1), steel], pinpost: [cyl(0.012, 0.012, 0.12, 6), steel],
    };
    this.hw = null;                                // per part name: InstancedMesh (made for the hardware there is)
    this.light = new THREE.PointLight(0xe6eeff, 0, 120, 1.7);
    scene.add(this.light);
    this.sparkT = 0;
  }

  onEvent(ev) {
    if (ev.t === 'lines' || ev.t === 'reset' || ev.t === 'load') this.rebuild();
    else if (ev.t === 'snap' && ev.p && !this.deadLine(ev.i)) this.flash(ev.p, 1);
    else if (ev.t === 'zap' && ev.p) this.flash(ev.p, 0.45);
  }

  deadLine(i) { const L = this.world.lines && this.world.lines.list[i]; return !!(L && !isLive(L)); }

  rebuild() {
    if (this.mesh) { this.scene.remove(this.mesh); this.mesh.dispose(); this.mesh = null; }
    if (this.hw) { for (const m of Object.values(this.hw)) { this.scene.remove(m); m.dispose(); } this.hw = null; }
    this.lines = [];
    const w = this.world; if (!w.lines) return;
    let N = 0;
    for (const L of w.lines.list) {
      const rest = restNodes(endRest(w, L.a), endRest(w, L.b), L.L0, L.n);
      this.lines.push({ first: N, cur: rest.slice(), rest, dirty: true });
      N += L.n;
    }
    this.mesh = new THREE.InstancedMesh(this.geo, this.mat, Math.max(1, N));
    this.mesh.frustumCulled = false; this.mesh.castShadow = true;
    this.scene.add(this.mesh);
    const hw = w.lines.hw || [], nPin = hw.filter((h) => h.k === HW.PIN).length, nSp = hw.filter((h) => h.k === HW.SPOOL).length, nCan = hw.filter((h) => h.k === HW.CAN).length;
    const counts = { pin: nPin, pinpost: nPin, spool: nSp, can: nCan, lid: nCan, bush: nCan, strap: nCan + nSp };
    this.hw = {};
    for (const [k, [g, m]] of Object.entries(this.parts)) {
      const im = new THREE.InstancedMesh(g, m, Math.max(1, counts[k] || 0));
      im.count = counts[k] || 0; im.frustumCulled = false; im.castShadow = true; im.receiveShadow = true;
      this.scene.add(im); this.hw[k] = im;
    }
    this.hwDirty = true;
  }

  /** World place of a hardware end: position into P, rotation into Q; false when what held it is gone. */
  endPose(e, P, Q) {
    const w = this.world, v = this.view;
    if (e.seg === undefined) { const p = endRest(w, e); P.set(p[0], p[1], p[2]); Q.identity(); return true; }
    const s = w.segs.get(e.seg), piece = s && v && v.pieces.get(s.piece); if (!piece) return false;
    const f = v.flexNow && v.flexNow.at(s.id, Math.min(1, Math.max(0, segParam(s, e.p)))), b = frameApply(f, e.p);
    P.set(b[0], b[1], b[2]).applyQuaternion(piece.group.quaternion).add(piece.group.position);
    Q.copy(piece.group.quaternion); if (f) Q.multiply(_q2.set(f.q[0], f.q[1], f.q[2], f.q[3]));
    return true;
  }

  /** Pole hardware where its wood is now (a dormant pole's only once: it never moves). */
  updateHardware() {
    const w = this.world, hw = w.lines && w.lines.hw; if (!this.hw || !hw) return;
    let any = this.hwDirty; this.hwDirty = false;
    if (!any) for (const h of hw) if (h.e.seg !== undefined) { any = true; break; }
    if (!any) return;
    const idx = {}; for (const k in this.hw) idx[k] = 0;
    const put = (k, ox, oy, oz, sx = 1, sy = 1, sz = 1, ok = true) => {
      if (!ok) { this.hw[k].setMatrixAt(idx[k]++, ZERO); return; }
      _o.set(ox, oy, oz).applyQuaternion(_Q).add(_P);
      _m.compose(_o, _Q, _s.set(sx, sy, sz)); this.hw[k].setMatrixAt(idx[k]++, _m);
    };
    for (const h of hw) {
      const ok = this.endPose(h.e, _P, _Q);
      if (h.k === HW.PIN) {                       // the conductor sits on its top; a steel pin into the arm under it
        put('pin', 0, -POLE.PIN_H / 2, 0, 1, 1, 1, ok); put('pinpost', 0, -POLE.PIN_H - 0.03, 0, 1, 1, 1, ok);
      } else if (h.k === HW.SPOOL) {              // on a strap bolted to the pole
        const sg = Math.sign((h.e.o && h.e.o[1]) || 1);
        put('spool', 0, 0, 0, 1, 1, 1, ok); put('strap', 0, 0, -sg * 0.09, 0.4, 0.3, 0.12, ok);
      } else if (h.k === HW.CAN) {                // the can, its lid, a bushing on the lid, its hanger bracket against the pole
        const sg = h.s || -1, gap = POLE.CAN_OUT - POLE.CAN_R + 0.04;
        put('can', 0, 0, 0, 1, 1, 1, ok); put('lid', 0, POLE.CAN_H / 2 + 0.025, 0, 1, 1, 1, ok);
        put('bush', 0, POLE.CAN_H / 2 + 0.13, -sg * 0.08, 1, 1, 1, ok);
        put('strap', 0, POLE.CAN_H / 2 - 0.25, -sg * (POLE.CAN_R + gap / 2 - 0.04), 1, 1, gap, ok);
      }
    }
    for (const k in this.hw) this.hw[k].instanceMatrix.needsUpdate = true;
  }

  /** A white flash at world point p: s = 1 a line snapping, less for a touch. */
  flash(p, s) {
    const f = this.flashes.reduce((a, b) => (a.life - a.t < b.life - b.t ? a : b));
    f.t = 0; f.life = 0.2 + 0.7 * s; f.size = s; f.big = s >= 0.4;
    f.at.set(p[0], p[1], p[2]); f.core.position.copy(f.at); f.halo.position.copy(f.at);
    f.core.visible = true; f.halo.visible = f.big;
  }

  update(dt, src) {
    const w = this.world;
    if (this.mesh && w.lines) {
      const joined = !src.flex;                     // a joined player eases towards what the host sent
      const k = joined ? Math.min(1, dt * 14) : 1;
      w.lines.list.forEach((L, i) => {
        const V = this.lines[i]; if (!V) return;
        const to = (src.line && src.line(i)) || V.rest, cur = V.cur;
        let d = 0;
        if (to.length === cur.length) for (let j = 0; j < cur.length; j++) { const e = to[j] - cur[j]; if (e > d) d = e; else if (-e > d) d = -e; cur[j] += e * k; }
        const nb = L.brk.length;
        if (d < 1e-5 && !V.dirty && V.nb === nb) return;
        V.dirty = false; V.nb = nb;
        for (let q = 0; q < L.n; q++) {
          if (nb && L.brk.includes(q)) { this.mesh.setMatrixAt(V.first + q, ZERO); continue; }
          _a.set(cur[3 * q], cur[3 * q + 1], cur[3 * q + 2]); _b.set(cur[3 * q + 3], cur[3 * q + 4], cur[3 * q + 5]);
          const len = _a.distanceTo(_b);
          _q.setFromUnitVectors(Y, _b.sub(_a).normalize());
          _a.addScaledVector(_b, len / 2);
          const r = R * (RK[L.kind] || 1);
          _m.compose(_a, _q, _s.set(r, len + 0.01, r));
          this.mesh.setMatrixAt(V.first + q, _m);
        }
        this.mesh.instanceMatrix.needsUpdate = true;
      });
      // the live ends of a downed line, where they lie on the ground, spark
      this.sparkT -= dt;
      if (this.sparkT <= 0) {
        this.sparkT = 0.15;
        w.lines.list.forEach((L, i) => {
          const V = this.lines[i]; if (!V || L.dead || !isLive(L) || (!L.brk.length && !L.off[0] && !L.off[1])) return;
          const ends = [];
          for (const q of L.brk) ends.push(q, q + 1);
          if (L.off[0]) ends.push(0); if (L.off[1]) ends.push(L.n);
          for (const q of ends) {
            const x = V.cur[3 * q], y = V.cur[3 * q + 1], z = V.cur[3 * q + 2];
            if (y - groundY(w.terrain, x, z) < 0.4 && Math.random() < 0.25) this.flash([x, y + 0.05, z], 0.12 + Math.random() * 0.12);
          }
        });
      }
    }
    this.updateHardware();
    // flashes: an arc flickers a few times and dies away
    let light = 0, at = null;
    for (const f of this.flashes) {
      if (!f.core.visible) continue;
      f.t += dt;
      if (f.t >= f.life) { f.core.visible = f.halo.visible = false; continue; }
      const u = f.t / f.life, flick = (Math.sin(f.t * 70) * 0.5 + 0.5) * 0.6 + 0.4, e = (1 - u) * (1 - u) * flick;
      f.core.material.opacity = Math.min(1, 1.6 * e);
      f.core.position.copy(f.at);
      f.core.scale.setScalar((1.2 + 7 * f.size) * (0.7 + 0.3 * flick));
      if (f.big) {
        f.halo.material.opacity = Math.min(1, 1.3 * e); f.halo.scale.setScalar(0.35 * f.size * (0.8 + 0.2 * flick));
        f.halo.position.copy(f.core.position);
      }
      const I = 2500 * f.size * f.size * e;
      if (I > light) { light = I; at = f.at; }
    }
    this.light.intensity = light;
    if (at) this.light.position.copy(at);
  }
}
