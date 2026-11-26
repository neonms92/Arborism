// Draws the power lines (model/lines.js): every link of every line as a thin dark cylinder in one instanced mesh,
// where the host's solver has the line (src.line(i): the host's own points, or a joined player's copy of the last
// ones it was sent), or hanging at rest where nothing has been sent. A joined player's lines ease towards each new
// set of points so they do not jump at 10 Hz. A line that snaps (or a player who touches one) makes a white flash
// you can see from far off; the live ends of a downed line lying on the ground spark now and then. No game rules.

import * as THREE from 'three';
import { endRest, restNodes } from '../model/lines.js';
import { groundY } from '../model/terrain.js';

const R = 0.016;                                   // m, drawn radius of a line
const _m = new THREE.Matrix4(), _a = new THREE.Vector3(), _b = new THREE.Vector3(), _q = new THREE.Quaternion(), _s = new THREE.Vector3();
const Y = new THREE.Vector3(0, 1, 0), ZERO = new THREE.Matrix4().makeScale(0, 0, 0);

export class LinesView {
  constructor(scene, world) {
    this.scene = scene; this.world = world;
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
    this.light = new THREE.PointLight(0xe6eeff, 0, 120, 1.7);
    scene.add(this.light);
    this.sparkT = 0;
  }

  onEvent(ev) {
    if (ev.t === 'lines' || ev.t === 'reset' || ev.t === 'load') this.rebuild();
    else if (ev.t === 'snap' && ev.p) this.flash(ev.p, 1);
    else if (ev.t === 'zap' && ev.p) this.flash(ev.p, 0.45);
  }

  rebuild() {
    if (this.mesh) { this.scene.remove(this.mesh); this.mesh.dispose(); this.mesh = null; }
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
          _m.compose(_a, _q, _s.set(R, len + 0.01, R));
          this.mesh.setMatrixAt(V.first + q, _m);
        }
        this.mesh.instanceMatrix.needsUpdate = true;
      });
      // the live ends of a downed line, where they lie on the ground, spark
      this.sparkT -= dt;
      if (this.sparkT <= 0) {
        this.sparkT = 0.15;
        w.lines.list.forEach((L, i) => {
          const V = this.lines[i]; if (!V || (!L.brk.length && !L.off[0] && !L.off[1])) return;
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
