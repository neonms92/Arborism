// Draws the chip bins (shape from model/bin.js): body, lid, wheels and handle bar, posed from the snapshots. No rules.

import * as THREE from 'three';
import { BIN, binBodyId, lidBodyId, lidPose } from '../model/bin.js';
import { chipToWorld } from '../model/chipper.js';

export class BinView {
  constructor(scene, world) {
    this.scene = scene; this.world = world;
    const lam = (c) => new THREE.MeshLambertMaterial({ color: c, flatShading: true });
    this.mats = { body: lam(0x2f5d3a), lid: lam(0x3b7347), dark: lam(0x202020), grey: lam(0x8a8d90) };
    this.units = [];                  // [{g: body group, lid: mesh}]
  }

  onEvent(ev) {
    if (ev.t === 'bin') this.units.push(this.build(this.world.bins[this.world.bins.length - 1]));
    else if (ev.t === 'bins' || ev.t === 'load') {
      for (const u of this.units) this.scene.remove(u.g, u.lid);
      this.units = this.world.bins.map((b) => this.build(b));
    }
  }

  build(b) {
    const B = BIN, M = this.mats, g = new THREE.Group();
    const parts = [];
    // the body, a little narrower at the base, as a bin is
    const h = B.BODY.h, geo = new THREE.BoxGeometry(h[0] * 2, h[1] * 2, h[2] * 2), a = geo.attributes.position;
    for (let i = 0; i < a.count; i++) if (a.getY(i) < 0) { a.setX(i, a.getX(i) * 0.88); a.setZ(i, a.getZ(i) * 0.9); }
    geo.computeVertexNormals();
    const body = new THREE.Mesh(geo, M.body); body.position.set(...B.BODY.c); parts.push(body);
    // a dark band round the rim, so its mouth reads when the lid is up
    const rim = new THREE.Mesh(new THREE.BoxGeometry(h[0] * 2 + 0.02, 0.04, h[2] * 2 + 0.02), M.dark); rim.position.set(0, h[1] - 0.02, 0); parts.push(rim);
    for (const w of B.WHEELS) { const m = new THREE.Mesh(new THREE.CylinderGeometry(B.WHEEL_R, B.WHEEL_R, 0.06, 12).rotateX(Math.PI / 2), M.dark); m.position.set(...w); parts.push(m); }
    const axle = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.015, 0.54, 6).rotateX(Math.PI / 2), M.grey); axle.position.set(B.WHEELS[0][0], B.WHEELS[0][1], 0); parts.push(axle);
    const bar = new THREE.Mesh(new THREE.CylinderGeometry(B.HANDLE_H[0], B.HANDLE_H[0], B.HANDLE_H[2] * 2, 8).rotateX(Math.PI / 2), M.dark); bar.position.set(...B.HANDLE); parts.push(bar);
    for (const s of [-1, 1]) { const m = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.04, 0.03), M.dark); m.position.set(B.HANDLE[0] + 0.05, B.HANDLE[1], s * B.HANDLE_H[2]); parts.push(m); }
    for (const m of parts) { m.castShadow = m.receiveShadow = true; g.add(m); }
    const lid = new THREE.Mesh(new THREE.BoxGeometry(B.LID.h[0] * 2, B.LID.h[1] * 2, B.LID.h[2] * 2), M.lid);
    lid.castShadow = lid.receiveShadow = true;
    // where it was put down, lid shut, until the snapshots say otherwise
    g.position.set(...b.p); g.quaternion.set(...b.q);
    const lp = lidPose(0), c = chipToWorld(b.p, b.q, lp.c); lid.position.set(...c); lid.quaternion.set(...b.q);
    this.scene.add(g, lid);
    return { g, lid };
  }

  /** Bin k's local point to world, from where it is drawn now. */
  toWorld(k, l, out = new THREE.Vector3()) {
    const u = this.units[k]; if (!u) return null;
    return out.set(l[0], l[1], l[2]).applyQuaternion(u.g.quaternion).add(u.g.position);
  }

  update(src) {
    this.units.forEach((u, k) => {
      const pb = src.pose(binBodyId(k)), pl = src.pose(lidBodyId(k));
      if (pb) { u.g.position.set(pb.p.x, pb.p.y, pb.p.z); u.g.quaternion.set(pb.q.x, pb.q.y, pb.q.z, pb.q.w); }
      if (pl) { u.lid.position.set(pl.p.x, pl.p.y, pl.p.z); u.lid.quaternion.set(pl.q.x, pl.q.y, pl.q.z, pl.q.w); }
    });
  }
}
