// Draws breakable structures (model/builds.js): the intact modules of each
// body merged into one mesh per material (a neighbourhood has thousands of
// boards), broken ones as their loose parts, one mesh each. No game rules.

import * as THREE from 'three';
import { compose } from '../model/builds.js';

const COLORS = {
  wall: 0x7a5534, door: 0x5e7f4a, floor: 0x8f6a42, post: 0x6b4a2c, roof: 0x3b3f44, rail: 0xb08a5a, picket: 0xc19a66, rough: 0xa39a8a,
  found: 0x8d8a84, glass: 0xd4dee2,   // frosted: pale and opaque, no seeing in
};
// house siding and roofing, picked per house
const SIDING = [0xd8d2c4, 0xa9b8c4, 0xc9b48a, 0x8e9f86, 0xb8826a, 0xe6e1d3, 0x9a8f86];
const ROOFING = [0x3b3f44, 0x5a3b32, 0x4a4f45, 0x2f3438];

const _m = new THREE.Matrix4(), _p = new THREE.Vector3(), _q = new THREE.Quaternion(), _s = new THREE.Vector3(), _v = new THREE.Vector3(), _n = new THREE.Vector3();
const UNIT = new THREE.BoxGeometry(1, 1, 1);

export class BuildsView {
  constructor(scene, world) {
    this.scene = scene; this.world = world;
    this.mats = {};
    this.root = new THREE.Group(); scene.add(this.root);
    this.drawn = new Map();       // build id -> {objs: [Object3D]}
    this.groups = new Map();      // body id -> {g, fixed}
    this.parts = new Map();       // part body id -> {m: mesh, rest: {p, q}, posed}
    this.geo = new Map();
  }

  mat(key, color) {
    let m = this.mats[key];
    if (!m) {
      m = this.mats[key] = key === 'glass'
        ? new THREE.MeshLambertMaterial({ color })     // frosted glass: opaque, smooth-shaded
        : new THREE.MeshLambertMaterial({ color, flatShading: true });
    }
    return m;
  }
  /** Material key and colour for a part of build b. */
  look(b, pt) {
    if (b.kind === 'house' && (pt.mat === 'wall' || pt.mat === 'roof')) {
      const h = (Math.imul(b.id + 7, 2654435761) >>> 0), pal = pt.mat === 'wall' ? SIDING : ROOFING;
      const i = (pt.mat === 'wall' ? h : h >>> 8) % pal.length;
      return [`${pt.mat}${i}`, pal[i]];
    }
    return [pt.mat in COLORS ? pt.mat : 'wall', COLORS[pt.mat] ?? COLORS.wall];
  }

  onEvent(ev) {
    if (ev.t === 'builds' || ev.t === 'load') this.rebuild();
    else if (ev.t === 'smash' || ev.t === 'freeze') { const b = this.world.builds.find((x) => x.id === ev.b); if (b) this.draw(b); }
  }

  box(pt) {
    const k = pt.h.join(',');
    let g = this.geo.get(k); if (!g) this.geo.set(k, g = new THREE.BoxGeometry(pt.h[0] * 2, pt.h[1] * 2, pt.h[2] * 2));
    return g;
  }

  rebuild() {
    for (const id of [...this.drawn.keys()]) this.undraw(id);
    this.root.clear(); this.groups.clear(); this.parts.clear();
    for (const b of this.world.builds) this.draw(b);
  }

  undraw(id) {
    const d = this.drawn.get(id); if (!d) return;
    for (const o of d.objs) { this.root.remove(o); o.traverse((x) => { if (x.isMesh && x.userData.own) x.geometry.dispose(); }); }
    for (const k of d.bodies) this.groups.delete(k);
    for (const k of d.parts) this.parts.delete(k);
    this.drawn.delete(id);
  }

  /** (Re)draw one build from the model. */
  draw(b) {
    this.undraw(b.id);
    const d = { objs: [], bodies: [], parts: [] }, merge = new Map();    // body id -> material key -> {color, list of [part, local frame]}
    b.mods.forEach((m) => {
      if (m.ids) {                                      // broken: one mesh per loose part
        m.parts.forEach((pt, k) => {
          const still = b.still && b.still[m.ids[k]];     // frozen where it came to rest: no more snapshots for it
          const l = compose(m.p, m.q, pt.c, pt.q), rest = still || compose(m.at.p, m.at.q, l.p, l.q), [key, col] = this.look(b, pt);
          const mesh = new THREE.Mesh(this.box(pt), this.mat(key, col));
          mesh.castShadow = mesh.receiveShadow = true;
          mesh.position.set(...rest.p); mesh.quaternion.set(...rest.q);
          this.root.add(mesh); d.objs.push(mesh);
          this.parts.set(m.ids[k], { m: mesh, rest, posed: false, still: !!still }); d.parts.push(m.ids[k]);
        });
        return;
      }
      let M = merge.get(m.body); if (!M) merge.set(m.body, M = new Map());
      for (const pt of m.parts) {
        const [key, col] = this.look(b, pt);
        let e = M.get(key); if (!e) M.set(key, e = { col, list: [] });
        e.list.push([pt, compose(m.p, m.q, pt.c, pt.q)]);
      }
    });
    for (const [body, M] of merge) {
      const g = new THREE.Group(), start = body === b.id ? { p: b.p, q: b.q } : b.bodies[body];
      g.position.set(...start.p); g.quaternion.set(...start.q);
      for (const [key, e] of M) {
        const mesh = new THREE.Mesh(mergedBoxes(e.list), this.mat(key, e.col));
        mesh.userData.own = true;
        mesh.castShadow = true; mesh.receiveShadow = true;
        g.add(mesh);
      }
      this.root.add(g); d.objs.push(g);
      this.groups.set(body, { g, fixed: body === b.id || !!(b.still && b.still[body]) }); d.bodies.push(body);
    }
    this.drawn.set(b.id, d);
  }

  update(src) {
    const set = (o, pose) => { o.position.set(pose.p.x, pose.p.y, pose.p.z); o.quaternion.set(pose.q.x, pose.q.y, pose.q.z, pose.q.w); };
    for (const [id, G] of this.groups) {
      if (G.fixed) continue;
      const pose = src.pose(id); if (pose) set(G.g, pose);
    }
    for (const [id, P] of this.parts) {
      if (P.still) continue;
      const pose = src.pose(id);
      if (pose) set(P.m, pose);
      else if (!P.posed) { P.m.position.set(...P.rest.p); P.m.quaternion.set(...P.rest.q); }
      P.posed = !!pose || P.posed;
    }
  }
}

/** One geometry of boxes: list of [part {h}, frame {p, q}] in the body's frame. */
function mergedBoxes(list) {
  const up = UNIT.attributes.position, un = UNIT.attributes.normal, ui = UNIT.index, nv = up.count, ni = ui.count;
  const pos = new Float32Array(list.length * nv * 3), nor = new Float32Array(list.length * nv * 3);
  const idx = new (list.length * nv > 65535 ? Uint32Array : Uint16Array)(list.length * ni);
  list.forEach(([pt, f], k) => {
    _m.compose(_p.set(...f.p), _q.set(...f.q), _s.set(pt.h[0] * 2, pt.h[1] * 2, pt.h[2] * 2));
    for (let i = 0; i < nv; i++) {
      _v.fromBufferAttribute(up, i).applyMatrix4(_m); _n.fromBufferAttribute(un, i).applyQuaternion(_q);
      const o = (k * nv + i) * 3;
      pos[o] = _v.x; pos[o + 1] = _v.y; pos[o + 2] = _v.z; nor[o] = _n.x; nor[o + 1] = _n.y; nor[o + 2] = _n.z;
    }
    for (let i = 0; i < ni; i++) idx[k * ni + i] = ui.getX(i) + k * nv;
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  g.computeBoundingSphere();
  return g;
}
