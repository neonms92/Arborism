// Draws the concrete pavers (model/pavers.js): one instanced slab each, laid
// on the ground under its middle and tilted with it, and
// for each damaged paver a mesh of cracks, chips and (past PAVER_GRAVEL) a
// heap of gravel in its place. Everything is derived from the damage counter
// and the hit points in the model with a seeded generator, so every machine
// draws the same cracks, and a crack only ever grows: more damage lengthens
// the cracks already there and adds new ones from the same sequence.
//
// Driveway slabs are drawn the same way, bigger, thicker and with wider joints. Street patches have no slab
// (the asphalt is the ground's own colour, view/terrain.js): only their cracks and, past STREET_GRAVEL, a
// pothole of dark chips.

import * as THREE from 'three';
import { CFG } from '../config.js';
import { groundY, groundN } from '../model/terrain.js';
import { MAT_CFG } from '../model/pavers.js';

const RAYS = 14;          // most cracks from one hit
// per material: top (m, drawn top of a slab above the ground; the physics surface is the ground itself), slab
// thickness, joint, colour, crack colour, crack width scale, chip colour, whether a slab is drawn
const LOOK = {
  paver: { top: 0.012, thick: 0.07, gap: 0.006, col: [0.66, 0.65, 0.62], crack: [0.08, 0.08, 0.08], w: 1, chip: [0.5, 0.49, 0.475], slab: true },
  slab: { top: 0.012, thick: 0.1, gap: 0.014, col: [0.74, 0.73, 0.7], crack: [0.1, 0.1, 0.1], w: 1.6, chip: [0.56, 0.55, 0.53], slab: true },
  asphalt: { top: 0.004, thick: 0, gap: 0, col: null, crack: [0.035, 0.035, 0.04], w: 2, chip: [0.14, 0.14, 0.15], slab: false },
};
const SAND = 0xa89b80;
const _up = new THREE.Vector3(0, 1, 0), _n = new THREE.Vector3(), _yaw = new THREE.Quaternion();
const _m = new THREE.Matrix4(), _c = new THREE.Color(), _p = new THREE.Vector3(), _s = new THREE.Vector3(), _q = new THREE.Quaternion();

function rng(seed) {      // mulberry32
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const hash = (a, b) => (Math.imul(a + 1, 73856093) ^ Math.imul(b + 1, 19349663)) >>> 0;

export class PaverView {
  constructor(scene, world) {
    this.scene = scene; this.world = world;
    this.group = new THREE.Group(); scene.add(this.group);
    this.slabMat = new THREE.MeshLambertMaterial({ color: 0xffffff });
    this.dmgMat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
    this.slabs = null; this.bed = null;
    this.broken = new Map();    // paver -> {mesh, dmg drawn}
  }

  onEvent(ev) {
    if (ev.t === 'pavers' || ev.t === 'load') this.build();
    else if (ev.t === 'crack') for (const h of ev.h) this.redraw(h[0]);
  }

  /** The gravel threshold or a view setting changed. */
  refresh() { if (this.world.paving) for (let i = 0; i < this.world.paving.dmg.length; i++) if (this.world.paving.dmg[i] > 0) this.redraw(i, true); }

  clear() {
    for (const o of [...this.group.children]) { this.group.remove(o); o.geometry?.dispose(); }
    this.slabs = null; this.broken.clear();
  }

  build() {
    this.clear();
    const pv = this.world.paving; if (!pv) return;
    const list = pv.L.list, n = list.length;
    // jointing sand under each paver (shows in the joints), so the bed follows the paved circle and leaves the pit open
    this.bed = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), new THREE.MeshLambertMaterial({ color: SAND }), n);
    this.bed.receiveShadow = true;
    for (let i = 0; i < n; i++) {
      const p = list[i], y = this.seat(p, _q), L = LOOK[p.m] || LOOK.paver;
      this.bed.setMatrixAt(i, _m.compose(_p.set(p.x, y + 0.003, p.z), _q, L.slab ? _s.set(2 * p.hx, 1, 2 * p.hz) : _s.set(0, 0, 0)));
    }
    this.group.add(this.bed);

    this.slabs = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), this.slabMat, n);
    this.slabs.receiveShadow = true;
    for (let i = 0; i < n; i++) { this.place(i); this.tint(i); }
    this.group.add(this.slabs);
    for (let i = 0; i < n; i++) if (pv.dmg[i] > 0) this.redraw(i);
  }

  place(i, hidden = false) {
    const p = this.world.paving.L.list[i], L = LOOK[p.m] || LOOK.paver;
    if (!L.slab) hidden = true;
    _s.set(hidden ? 0 : 2 * p.hx - L.gap, hidden ? 0 : L.thick, hidden ? 0 : 2 * p.hz - L.gap);
    const y = this.seat(p, _q);
    _m.compose(_p.set(p.x, y, p.z).addScaledVector(_n, L.top - L.thick / 2), _q, _s);
    this.slabs.setMatrixAt(i, _m); this.slabs.instanceMatrix.needsUpdate = true;
  }
  /** A paver lies on the ground under its middle: returns that height, sets q to its tilt and turn (and _n to the normal). */
  seat(p, q) {
    const t = this.world.terrain, g = groundN(t, p.x, p.z);
    q.setFromUnitVectors(_up, _n.set(g[0], g[1], g[2])).multiply(_yaw.setFromAxisAngle(_up, p.a || 0));
    return groundY(t, p.x, p.z);
  }
  tint(i) {
    const p = this.world.paving.L.list[i], L = LOOK[p.m] || LOOK.paver; if (!L.slab) return;
    const r = rng(hash(i, 999))(), lvl = Math.min(1, this.world.paving.dmg[i] / gravelAt(p));
    const f = (0.92 + 0.12 * r) * (1 - 0.25 * lvl);
    _c.setRGB(L.col[0] * f, L.col[1] * f, L.col[2] * f);
    this.slabs.setColorAt(i, _c); this.slabs.instanceColor.needsUpdate = true;
  }

  redraw(i, force = false) {
    const pv = this.world.paving; if (!pv || !this.slabs) return;
    const D = pv.dmg[i], old = this.broken.get(i);
    if (old && old.dmg === D && !force) return;
    if (old) { this.group.remove(old.mesh); old.mesh.geometry.dispose(); }
    const p = pv.L.list[i], L = LOOK[p.m] || LOOK.paver, G = gravelAt(p), gravel = D >= G;
    this.place(i, gravel); this.tint(i);
    const lp = { x: 0, z: 0, hx: p.hx, hz: p.hz };   // drawn in the paver's own frame at y = 0, then laid on the ground there
    const geo = gravel ? gravelGeo(lp, i, D, G, L) : crackGeo(lp, i, pv.hits[i], D, G, L);
    const mesh = new THREE.Mesh(geo, this.dmgMat); mesh.receiveShadow = true;
    mesh.position.set(p.x, this.seat(p, mesh.quaternion), p.z);
    this.group.add(mesh);
    this.broken.set(i, { mesh, dmg: D });
  }
}

/** Damage at which paver p is gravel (or rubble, or a pothole). */
const gravelAt = (p) => Math.max(1, CFG[MAT_CFG[p.m || 'paver'][1]]);

// ---- geometry ----

class Tris {
  constructor() { this.pos = []; this.col = []; }
  tri(a, b, c, col) { this.pos.push(...a, ...b, ...c); for (let k = 0; k < 3; k++) this.col.push(...col); }
  quad(a, b, c, d, col) { this.tri(a, b, c, col); this.tri(a, c, d, col); }
  /** A flat strip of width w along (x0,z0)-(x1,z1) at height y. */
  strip(x0, z0, x1, z1, w, y, col) {
    const dx = x1 - x0, dz = z1 - z0, l = Math.hypot(dx, dz) || 1, nx = -dz / l * w / 2, nz = dx / l * w / 2;
    this.quad([x0 - nx, y, z0 - nz], [x1 - nx, y, z1 - nz], [x1 + nx, y, z1 + nz], [x0 + nx, y, z0 + nz], col);
  }
  /** A small rough box (a chip of concrete), centre (x,y,z), size s, turned a about y. */
  chip(x, y, z, s, a, col, r) {
    const h = s * (0.35 + 0.4 * r()), ca = Math.cos(a), sa = Math.sin(a), sx = s / 2, sz = s * (0.3 + 0.4 * r());
    const v = [];
    for (const [px, py, pz] of [[-1, 0, -1], [1, 0, -1], [1, 0, 1], [-1, 0, 1], [-1, 1, -1], [1, 1, -1], [1, 1, 1], [-1, 1, 1]]) {
      const lx = px * sx * (py ? 0.6 + 0.3 * r() : 1), lz = pz * sz * (py ? 0.6 + 0.3 * r() : 1);
      v.push([x + lx * ca - lz * sa, y + py * h, z + lx * sa + lz * ca]);
    }
    const dark = col.map((c) => c * 0.8);
    this.quad(v[4], v[7], v[6], v[5], col);
    this.quad(v[0], v[1], v[5], v[4], dark); this.quad(v[1], v[2], v[6], v[5], dark);
    this.quad(v[2], v[3], v[7], v[6], dark); this.quad(v[3], v[0], v[4], v[7], dark);
  }
  geometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.computeVertexNormals();
    return g;
  }
}

/** Cracks from each hit, growing with that hit's share of damage; chips and spalls as the paver nears gravel. */
function crackGeo(p, i, hits, D, G, L) {
  const T = new Tris(), lvl = D / G, y = L.top + 0.0006, CRACK = L.crack;
  const hx = p.hx - L.gap / 2, hz = p.hz - L.gap / 2, inside = (u, v) => Math.abs(u) < hx && Math.abs(v) < hz;
  const w = (0.004 + 0.008 * Math.min(1, lvl)) * L.w;
  const crack = (r, u, v, a, len, width) => {          // a wandering crack from (u,v) heading a, len long
    if (!inside(u, v)) return;
    let s = 0;
    while (s < len) {
      const step = 0.015 + 0.025 * r(), a2 = a + (r() - 0.5) * 0.9;
      const u2 = u + Math.cos(a2) * step, v2 = v + Math.sin(a2) * step;
      const out = !inside(u2, v2);
      const cu = Math.max(-hx, Math.min(hx, u2)), cv = Math.max(-hz, Math.min(hz, v2));
      T.strip(p.x + u, p.z + v, p.x + cu, p.z + cv, width, y, CRACK);
      if (out) return;
      u = u2; v = v2; a = a2 * 0.6 + a * 0.4; s += step;
    }
  };
  hits.forEach(([u, v, amt], hi) => {
    const u0 = Math.max(-0.95 * hx, Math.min(0.95 * hx, u)), v0 = Math.max(-0.95 * hz, Math.min(0.95 * hz, v));
    const r = rng(hash(i, hi)), a = Math.max(0, amt), full = Math.min(2.4, 2 * Math.max(hx, hz));
    const rays = Math.min(RAYS, 2 + Math.floor(3 * Math.sqrt(a)));
    const reach = Math.min(1, 0.25 + 0.3 * Math.sqrt(a));
    const a0 = r() * Math.PI * 2;
    for (let k = 0; k < RAYS; k++) {
      // draw the same RAYS seeded cracks in the same order every time; damage decides how many and how far
      const rk = rng(hash(i * 31 + hi, k)), dir = a0 + k * 2.39996 + (rk() - 0.5) * 0.6, len = full * reach * (0.5 + 0.6 * rk());
      if (k >= rays) continue;
      crack(rk, u0, v0, dir, len, w);
      if (lvl > 0.3 && rk() < lvl) crack(rk, u0 + Math.cos(dir) * len * 0.5, v0 + Math.sin(dir) * len * 0.5, dir + (rk() < 0.5 ? 1 : -1) * (0.7 + rk()), len * 0.5, w * 0.7);
    }
    if (lvl > 0.25) {                                    // crushed spot where it was struck
      const rs = 0.02 + 0.08 * Math.min(1, lvl) * Math.min(1, Math.sqrt(a) / 3), m = 9;
      for (let k = 0; k < m; k++) {
        const t0 = k / m * Math.PI * 2, t1 = (k + 1) / m * Math.PI * 2, f0 = 0.7 + 0.5 * r(), f1 = 0.7 + 0.5 * r();
        const c = (u, v) => [p.x + Math.max(-hx, Math.min(hx, u)), y + 0.0004, p.z + Math.max(-hz, Math.min(hz, v))];
        T.tri(c(u0, v0), c(u0 + Math.cos(t1) * rs * f1, v0 + Math.sin(t1) * rs * f1), c(u0 + Math.cos(t0) * rs * f0, v0 + Math.sin(t0) * rs * f0), L.slab ? [0.32, 0.31, 0.29] : [0.06, 0.06, 0.065]);
      }
    }
  });
  if (lvl > 0.4) {                                       // loose chips
    const r = rng(hash(i, 4242)), n = Math.floor((lvl - 0.4) / 0.6 * 40);
    for (let k = 0; k < n; k++) {
      const h = hits[Math.floor(r() * hits.length)] || [0, 0];
      const d = r() * 0.15, a = r() * Math.PI * 2;
      const u = Math.max(-hx, Math.min(hx, h[0] + Math.cos(a) * d)), v = Math.max(-hz, Math.min(hz, h[1] + Math.sin(a) * d));
      const g = 1 + 0.3 * r();
      T.chip(p.x + u, L.top, p.z + v, (0.012 + 0.03 * r()) * Math.sqrt(L.w), r() * 6.3, L.chip.map((x) => x * g), r);
    }
  }
  return T.geometry();
}

/** Past PAVER_GRAVEL (DRIVE_GRAVEL, STREET_GRAVEL): the slab is gone, and its footprint is a low heap of chips (on a street, a pothole). */
function gravelGeo(p, i, D, G, L) {
  const T = new Tris(), r = rng(hash(i, 777)), area = p.hx * p.hz / 0.045;
  // a big panel breaks into bigger lumps, so the heap does not take tens of thousands of chips
  const big = Math.min(2.5, Math.sqrt(Math.sqrt(area)));
  const n = Math.min(1500, Math.round(Math.min(400, 160 + 60 * Math.log2(D / G + 1)) * area / (big * big) * (L.slab ? 1 : 0.3)));
  const fine = Math.min(1, (D / G - 1) / 3);            // keeps getting finer past the threshold
  if (!L.slab) {                                         // a pothole: the dark hollow under the broken asphalt
    const e = 0.0025;
    T.quad([p.x - p.hx * 0.9, e, p.z - p.hz * 0.9], [p.x - p.hx * 0.9, e, p.z + p.hz * 0.9], [p.x + p.hx * 0.9, e, p.z + p.hz * 0.9], [p.x + p.hx * 0.9, e, p.z - p.hz * 0.9], [0.05, 0.045, 0.04]);
  }
  for (let k = 0; k < n; k++) {
    const u = (r() * 2 - 1) * p.hx, v = (r() * 2 - 1) * p.hz;
    const edge = Math.min(1, (p.hx - Math.abs(u)) / 0.08, (p.hz - Math.abs(v)) / 0.08);
    const g = (0.42 + 0.25 * r()) / 0.5;
    T.chip(p.x + u, -0.004 + 0.014 * edge * r(), p.z + v, (0.025 + 0.05 * r()) * (1 - 0.5 * fine) * big * (L.slab ? 1 : 0.6), r() * 6.3, [L.chip[0] * g, L.chip[1] * g * 0.97, L.chip[2] * g * 0.93], r);
  }
  return T.geometry();
}
