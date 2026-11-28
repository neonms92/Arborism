// Weeds: tufts of long grass where a mower can't reach, along the foot of fences, sheds and houses and round
// the base of every tree trunk (the job tree, the other trees in the yards, awake or dormant). Drawing only: no
// game rules, nothing collides with them, and every machine places the same tufts from the model alone
// (each tuft's look is hashed from where it stands). CFG.WEEDS turns them off (Tab menu, View).
//
// Placement: every part of a module that stands on the ground (mod.ground) and reaches within WEED_LOW of it
// gives the outline of its footprint; tufts go along that outline just outside it, WEEDS_DENSITY per metre,
// except where the spot is inside another footprint (a picket's neighbour, a foundation's next room).
// The tufts are instanced, one InstancedMesh per TILE m square, and squares further than WEEDS_DIST are not drawn.

import * as THREE from 'three';
import { CFG } from '../config.js';
import { compose, qrot } from '../model/builds.js';

const TILE = 24;            // m, side of one instanced batch
const WEED_LOW = 0.3;       // m, a part whose bottom is within this of the ground has weeds at its foot
const BLADES = 5;           // blades per tuft
const GREENS = [[0.26, 0.42, 0.17], [0.32, 0.46, 0.18], [0.40, 0.45, 0.21], [0.28, 0.44, 0.22]];

const hash = (x, z, k = 0) => (Math.imul((Math.round(x * 97) * 73856093) ^ (Math.round(z * 97) * 19349663) ^ (k * 83492791), 2654435761) >>> 0) / 4294967296;
const _m = new THREE.Matrix4(), _p = new THREE.Vector3(), _q = new THREE.Quaternion(), _s = new THREE.Vector3(), _c = new THREE.Color(), _up = new THREE.Vector3(0, 1, 0);

export class WeedsView {
  constructor(scene, world) {
    this.world = world;
    this.root = new THREE.Group(); scene.add(this.root);
    this.geo = tuftGeo();
    this.mat = new THREE.MeshLambertMaterial({ color: 0xffffff });
    this.dirty = true; this.key = '';
    this.count = 0;            // tufts drawn now
  }

  onEvent(ev) { if (ev.t === 'builds' || ev.t === 'terrain' || ev.t === 'stands' || ev.t === 'tree' || ev.t === 'reset' || ev.t === 'load') this.dirty = true; }

  /** Once a frame: rebuilds only after the model or a weeds setting changed; hides tiles past WEEDS_DIST of the camera. */
  update(cam) {
    const key = `${CFG.WEEDS}|${CFG.WEEDS_DENSITY}|${CFG.WEEDS_HEIGHT}`;
    if (this.dirty || key !== this.key) { this.dirty = false; this.key = key; this.rebuild(); }
    if (!cam) return;
    const d = CFG.WEEDS_DIST + TILE * 0.71, cx = cam.position.x, cz = cam.position.z;
    for (const m of this.root.children) { const c = m.userData.c; m.visible = Math.hypot(c[0] - cx, c[1] - cz) < d; }
  }

  clear() {
    for (const m of this.root.children) m.dispose();
    this.root.clear(); this.count = 0;
  }

  rebuild() {
    this.clear();
    if (!CFG.WEEDS || CFG.WEEDS_DENSITY <= 0) return;
    const w = this.world, t = w.terrain, gy = (x, z) => (t ? t.heightAt(x, z) : 0);
    const step = 1 / CFG.WEEDS_DENSITY, pts = [];           // [x, z, size]
    // footprints of everything standing on the ground: {cx, cz, ax, az, ha, bx, bz, hb} (two horizontal half axes)
    const feet = [];
    for (const b of w.builds) for (const m of b.mods) {
      if (!m.ground || m.ids || b.kind === 'car') continue;   // (a parked car stands on its driveway: nothing grows round it)                       // broken modules: their weeds went with them
      const start = m.body === b.id ? { p: b.p, q: b.q } : b.bodies[m.body]; if (!start) continue;
      const mf = compose(start.p, start.q, m.p, m.q);
      for (const pt of m.parts) {
        const f = compose(mf.p, mf.q, pt.c, pt.q);
        const ax = [qrot(f.q, [1, 0, 0]), qrot(f.q, [0, 1, 0]), qrot(f.q, [0, 0, 1])];
        let v = 0; for (let k = 1; k < 3; k++) if (Math.abs(ax[k][1]) > Math.abs(ax[v][1])) v = k;
        let low = f.p[1]; for (let k = 0; k < 3; k++) low -= Math.abs(ax[k][1]) * pt.h[k];
        if (low > gy(f.p[0], f.p[2]) + WEED_LOW) continue;
        const [i, j] = [0, 1, 2].filter((k) => k !== v), hi = Math.hypot(ax[i][0], ax[i][2]) || 1, hj = Math.hypot(ax[j][0], ax[j][2]) || 1;
        feet.push({ cx: f.p[0], cz: f.p[2], ax: ax[i][0] / hi, az: ax[i][2] / hi, ha: pt.h[i] * hi, bx: ax[j][0] / hj, bz: ax[j][2] / hj, hb: pt.h[j] * hj });
      }
    }
    const grid = new Map(), G = 2, gk = (x, z) => `${Math.floor(x / G)},${Math.floor(z / G)}`;
    for (const F of feet) {
      const r = Math.hypot(F.ha, F.hb);
      for (let x = Math.floor((F.cx - r) / G); x <= Math.floor((F.cx + r) / G); x++) for (let z = Math.floor((F.cz - r) / G); z <= Math.floor((F.cz + r) / G); z++) {
        const k = `${x},${z}`; let l = grid.get(k); if (!l) grid.set(k, l = []); l.push(F);
      }
    }
    const inside = (x, z) => (grid.get(gk(x, z)) || []).some((F) => {
      const dx = x - F.cx, dz = z - F.cz;
      return Math.abs(dx * F.ax + dz * F.az) < F.ha && Math.abs(dx * F.bx + dz * F.bz) < F.hb;
    });
    for (const F of feet) {
      // the four sides of the footprint, each walked from corner to corner, tufts pushed out from the side
      for (const [nx, nz, h, tx, tz, L] of [[F.ax, F.az, F.ha, F.bx, F.bz, F.hb], [-F.ax, -F.az, F.ha, F.bx, F.bz, F.hb], [F.bx, F.bz, F.hb, F.ax, F.az, F.ha], [-F.bx, -F.bz, F.hb, F.ax, F.az, F.ha]]) {
        const n = Math.max(1, Math.round(2 * L / step));
        if (2 * L < step * 0.5 && hash(F.cx + nx, F.cz + nz) > 2 * L / step * 2) continue;    // a picket's thin side: now and then
        for (let s = 0; s < n; s++) {
          const u = -L + (s + 0.5) * (2 * L / n), x0 = F.cx + nx * h + tx * u, z0 = F.cz + nz * h + tz * u;
          const r = hash(x0, z0, 1), off = 0.03 + r * r * 0.14, jt = (hash(x0, z0, 2) - 0.5) * step * 0.8;
          const x = x0 + nx * off + tx * jt, z = z0 + nz * off + tz * jt;
          if (!inside(x, z)) pts.push(x, z, 0.6 + 0.6 * hash(x, z, 3) * (1 - r * 0.5));
        }
      }
    }
    // round the foot of each trunk
    const ring = (x, z, R) => {
      const n = Math.max(6, Math.round(2 * Math.PI * R * CFG.WEEDS_DENSITY * 1.5));
      for (let s = 0; s < n; s++) {
        const a = (s + hash(x, z, s) * 0.8) / n * Math.PI * 2, rr = R + 0.02 + hash(x, z, s + 99) ** 2 * 0.3;
        pts.push(x + Math.cos(a) * rr, z + Math.sin(a) * rr, 0.7 + 0.6 * hash(x, z, s + 7));
      }
    };
    for (const p of w.pieces.values()) {
      if (!p.fixed) continue;
      for (const sg of w.segsOf(p.id)) { if (sg.parent < 0) ring(sg.a[0], sg.a[2], sg.r0); break; }
    }
    if (w.stands) for (const s of w.stands.list) if (!s.piece) ring(s.x, s.z, s.d / 2);

    // batch by tile
    const tiles = new Map();
    for (let i = 0; i < pts.length; i += 3) {
      const k = `${Math.floor(pts[i] / TILE)},${Math.floor(pts[i + 1] / TILE)}`;
      let l = tiles.get(k); if (!l) tiles.set(k, l = []); l.push(i);
    }
    const H = CFG.WEEDS_HEIGHT;
    for (const [tk, list] of tiles) {
      const [tx, tz] = tk.split(',').map(Number);
      const mesh = new THREE.InstancedMesh(this.geo, this.mat, list.length);
      list.forEach((i, k) => {
        const x = pts[i], z = pts[i + 1], sz = pts[i + 2], hs = H * sz;
        _q.setFromAxisAngle(_up, hash(x, z, 4) * Math.PI * 2);
        _m.compose(_p.set(x, gy(x, z) - 0.02, z), _q, _s.set(hs * 0.8, hs, hs * 0.8));
        mesh.setMatrixAt(k, _m);
        const g = GREENS[Math.floor(hash(x, z, 5) * GREENS.length)], v = 0.85 + 0.3 * hash(x, z, 6);
        mesh.setColorAt(k, _c.setRGB(g[0] * v, g[1] * v, g[2] * v));
      });
      mesh.computeBoundingSphere();
      mesh.receiveShadow = true; mesh.userData.c = [(tx + 0.5) * TILE, (tz + 0.5) * TILE];
      this.root.add(mesh);
    }
    this.count = pts.length / 3;
  }
}

/** One tuft, 1 m tall: BLADES thin blades fanning out from a small base, normals up so they light like the ground. */
function tuftGeo() {
  const pos = [], nor = [];
  for (let b = 0; b < BLADES; b++) {
    const a = b / BLADES * Math.PI * 2 + b * 0.7, lean = 0.15 + 0.25 * ((b * 37) % 5) / 4, ht = 0.6 + 0.4 * ((b * 53) % 7) / 6;
    const cx = Math.cos(a), cz = Math.sin(a), w = 0.05, bx = cx * 0.04, bz = cz * 0.04;
    const l = [bx - cz * w, 0, bz + cx * w], r = [bx + cz * w, 0, bz - cx * w], tip = [bx + cx * lean, ht, bz + cz * lean];
    pos.push(...l, ...r, ...tip, ...r, ...l, ...tip);        // both faces, front-facing each: a double-sided material would light the back as if it faced down
    for (let k = 0; k < 6; k++) nor.push(0, 1, 0);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  return g;
}
