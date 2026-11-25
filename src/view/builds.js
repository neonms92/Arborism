// Draws breakable structures (model/builds.js): intact modules with the body
// they are in, broken ones as their loose parts. No game rules.

import * as THREE from 'three';
import { compose } from '../model/builds.js';

const COLORS = { wall: 0x7a5534, door: 0x5e7f4a, floor: 0x8f6a42, post: 0x6b4a2c, roof: 0x3b3f44, rail: 0xb08a5a, picket: 0xc19a66, rough: 0xa39a8a };

export class BuildsView {
  constructor(scene, world) {
    this.scene = scene; this.world = world;
    this.mats = {};
    for (const [k, c] of Object.entries(COLORS)) this.mats[k] = new THREE.MeshLambertMaterial({ color: c, flatShading: true });
    this.root = new THREE.Group(); scene.add(this.root);
    this.groups = new Map();      // body id -> {g, fixed: build | null, start: {p, q}}
    this.parts = new Map();       // part body id -> {m: mesh, rest: {p, q}}
    this.geo = new Map();
  }

  onEvent(ev) { if (ev.t === 'builds' || ev.t === 'smash' || ev.t === 'load') this.rebuild(); }

  box(pt) {
    const k = pt.h.join(',');
    let g = this.geo.get(k); if (!g) this.geo.set(k, g = new THREE.BoxGeometry(pt.h[0] * 2, pt.h[1] * 2, pt.h[2] * 2));
    return g;
  }
  mesh(pt, k) {
    const m = new THREE.Mesh(this.box(pt), this.mats[pt.mat] || this.mats.wall);
    m.castShadow = m.receiveShadow = true;
    m.userData.k = k;
    return m;
  }

  rebuild() {
    this.root.clear(); this.groups.clear(); this.parts.clear();
    for (const b of this.world.builds) {
      b.mods.forEach((m, i) => {
        if (m.ids) {                                      // broken: one mesh per loose part
          m.parts.forEach((pt, k) => {
            const l = compose(m.p, m.q, pt.c, pt.q), rest = compose(m.at.p, m.at.q, l.p, l.q), mesh = this.mesh(pt, k);
            this.root.add(mesh); this.parts.set(m.ids[k], { m: mesh, rest, posed: false });
          });
          return;
        }
        let G = this.groups.get(m.body);
        if (!G) {
          const g = new THREE.Group(), start = m.body === b.id ? { p: b.p, q: b.q } : b.bodies[m.body];
          g.position.set(...start.p); g.quaternion.set(...start.q);
          this.root.add(g); this.groups.set(m.body, G = { g, fixed: m.body === b.id, posed: false });
        }
        m.parts.forEach((pt, k) => {
          const l = compose(m.p, m.q, pt.c, pt.q), mesh = this.mesh(pt, k + i * 7);
          mesh.position.set(...l.p); mesh.quaternion.set(...l.q);
          G.g.add(mesh);
        });
      });
    }
  }

  update(src) {
    const set = (o, pose) => { o.position.set(pose.p.x, pose.p.y, pose.p.z); o.quaternion.set(pose.q.x, pose.q.y, pose.q.z, pose.q.w); };
    for (const [id, G] of this.groups) {
      if (G.fixed) continue;
      const pose = src.pose(id); if (pose) set(G.g, pose);
    }
    for (const [id, P] of this.parts) {
      const pose = src.pose(id);
      if (pose) set(P.m, pose);
      else if (!P.posed) { P.m.position.set(...P.rest.p); P.m.quaternion.set(...P.rest.q); }
      P.posed = !!pose || P.posed;
    }
  }
}
