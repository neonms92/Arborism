// Draws the wood chipper (shape from model/chipper.js), its chip piles, and
// chips flying out of the chute while it is chipping. No game rules.

import * as THREE from 'three';
import { SHAPE, CHIPPER_BODY_ID, pileShape, chipToWorld, WRECK } from '../model/chipper.js';
import { compose } from '../model/builds.js';
import { groundY } from '../model/terrain.js';

const CHUTE = [[0.2, 0.45, 0.3], [0.2, 1.45, 0.35], [0.2, 1.75, 0.8], [0.2, 1.55, 1.35]];   // discharge chute, chipper-local
const SPRAY = 48;

export class ChipperView {
  constructor(scene, world) {
    this.scene = scene; this.world = world;
    this.group = new THREE.Group(); this.group.visible = false;
    const S = SHAPE, lam = (c, extra) => new THREE.MeshLambertMaterial({ color: c, flatShading: true, ...extra });
    const orange = lam(0xe0701c), dark = lam(0x2a2a2a), grey = lam(0x8a8d90), yellow = lam(0xf2c418);
    const box = (b, mat) => { const m = new THREE.Mesh(new THREE.BoxGeometry(b.h[0] * 2, b.h[1] * 2, b.h[2] * 2), mat); m.position.set(...b.c); return m; };
    const parts = [];
    parts.push(box(S.CHASSIS, orange));
    parts.push(box({ c: [0.75, 0.6, 0], h: [0.45, 0.15, 0.55] }, lam(0xb85810)));           // engine cover
    // infeed hopper: a square funnel opening toward the back (-x)
    const hop = new THREE.CylinderGeometry(S.HOPPER.h[2] * Math.SQRT2, S.HOPPER.h[1] * Math.SQRT2 * 0.8, S.HOPPER.h[0] * 2, 4, 1, true).rotateY(Math.PI / 4).rotateZ(Math.PI / 2);
    const hm = new THREE.Mesh(hop, lam(0xe0701c, { side: THREE.DoubleSide })); hm.position.set(...S.HOPPER.c); parts.push(hm);
    const throat = box({ c: [S.HOPPER.c[0] + S.HOPPER.h[0] - 0.02, S.HOPPER.c[1], 0], h: [0.02, S.HOPPER.h[1] * 0.75, S.HOPPER.h[2] * 0.75] }, lam(0x111111));
    parts.push(throat);
    for (const w of S.WHEELS) { const m = new THREE.Mesh(new THREE.CylinderGeometry(S.WHEEL_R, S.WHEEL_R, 0.22, 14).rotateX(Math.PI / 2), dark); m.position.set(...w); parts.push(m); }
    const jw = new THREE.Mesh(new THREE.CylinderGeometry(S.JOCKEY_R, S.JOCKEY_R, 0.08, 10).rotateX(Math.PI / 2), dark); jw.position.set(...S.JOCKEY); parts.push(jw);
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.45, 6), grey); post.position.set(S.JOCKEY[0], S.JOCKEY[1] + 0.25, 0); parts.push(post);
    parts.push(box(S.DRAWBAR, grey));
    const grip = new THREE.Mesh(new THREE.TorusGeometry(0.1, 0.025, 6, 12).rotateX(Math.PI / 2), yellow); grip.position.set(...S.GRIP); parts.push(grip);
    const chute = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(CHUTE.map((p) => new THREE.Vector3(...p))), 12, 0.13, 7), orange);
    parts.push(chute);
    for (const m of parts) { m.castShadow = true; m.receiveShadow = true; this.group.add(m); }
    scene.add(this.group);

    this.pileMat = lam(0xc49a5c);
    this.chipMat = new THREE.MeshLambertMaterial({ color: 0xffffff, flatShading: true });
    this.piles = [];                // [{mesh, chips, V}]
    this.spray = new THREE.InstancedMesh(new THREE.BoxGeometry(0.05, 0.015, 0.035), this.chipMat, SPRAY);
    this.spray.frustumCulled = false; this.spray.visible = false;
    const c = new THREE.Color();
    for (let i = 0; i < SPRAY; i++) this.spray.setColorAt(i, c.setHSL(0.09 + (i % 5) * 0.008, 0.5, 0.55 + (i % 3) * 0.08));
    scene.add(this.spray);
    this.t = 0;
    // the wreck, once it has crumpled: one mesh per part
    this.wreckMats = { body: orange, dark: lam(0xb85810), wheel: dark, steel: grey, grip: yellow };
    this.wreckRoot = new THREE.Group(); scene.add(this.wreckRoot);
    this.wreckParts = new Map();    // part body id -> {m, rest}
  }

  syncWreck() {
    this.wreckRoot.clear(); this.wreckParts.clear();
    const wr = this.world.chipper && this.world.chipper.wreck; if (!wr) return;
    WRECK.forEach((pt, k) => {
      const geo = pt.mat === 'wheel' ? new THREE.CylinderGeometry(pt.h[0], pt.h[0], Math.max(0.04, pt.h[2] * 2), 12).rotateX(Math.PI / 2)
        : new THREE.BoxGeometry(pt.h[0] * 2, pt.h[1] * 2, pt.h[2] * 2);
      const m = new THREE.Mesh(geo, this.wreckMats[pt.mat] || this.wreckMats.body);
      m.castShadow = m.receiveShadow = true;
      const rest = compose(wr.at.p, wr.at.q, pt.c, pt.q);
      m.position.set(...rest.p); m.quaternion.set(...rest.q);
      this.wreckRoot.add(m); this.wreckParts.set(wr.ids[k], { m, rest });
    });
  }

  onEvent(ev) {
    if (ev.t === 'chipper' || ev.t === 'load') { this.group.visible = !!this.world.chipper; this.posed = false; this.syncPiles(!ev.keep); this.syncWreck(); }
    else if (ev.t === 'chip' || ev.t === 'chips') this.syncPiles(false);
    else if (ev.t === 'chipwreck') this.syncWreck();
  }

  syncPiles(all) {
    const ps = this.world.chipper ? this.world.chipper.piles : [];
    if (all) { for (const p of this.piles) this.dropPile(p); this.piles = []; }
    ps.forEach((pl, i) => {
      let v = this.piles[i];
      if (v && Math.abs(v.V - pl[2]) < 1e-4) return;
      if (v) this.dropPile(v);
      this.piles[i] = pl[2] > 1e-4 ? this.buildPile(pl, i) : { V: pl[2], mesh: null, chips: null };   // an emptied pile
    });
  }
  dropPile(v) { if (!v.mesh) return; this.scene.remove(v.mesh, v.chips); v.mesh.geometry.dispose(); v.chips.dispose(); }

  // A lumpy cone of chips at the angle of repose, with loose chips scattered over it. Seeded by the pile's index.
  buildPile(pl, idx) {
    const { r, h } = pileShape(pl[2]);
    let seed = (idx + 1) * 7919;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    const g = new THREE.ConeGeometry(1, 1, 22, 5).translate(0, 0.5, 0), a = g.attributes.position;
    for (let i = 0; i < a.count; i++) {
      const y = a.getY(i); if (y > 0.98 || y < 0.01) continue;
      const k = 1 + (rnd() - 0.5) * 0.18;
      a.setXYZ(i, a.getX(i) * k, y * (1 + (rnd() - 0.5) * 0.12), a.getZ(i) * k);
    }
    g.computeVertexNormals();
    const mesh = new THREE.Mesh(g, this.pileMat);
    const gy = groundY(this.world.terrain, pl[0], pl[1]);
    mesh.scale.set(r, h, r); mesh.position.set(pl[0], gy, pl[1]); mesh.castShadow = mesh.receiveShadow = true;
    const n = Math.min(400, 30 + Math.round(pl[2] * 150));
    const chips = new THREE.InstancedMesh(new THREE.BoxGeometry(0.05, 0.012, 0.03), this.chipMat, n);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), c = new THREE.Color(), s = new THREE.Vector3(1, 1, 1);
    for (let i = 0; i < n; i++) {
      const ang = rnd() * Math.PI * 2, f = Math.sqrt(rnd()) * 1.05, y = gy + Math.max(0, (1 - f) * h) + 0.01;
      q.setFromEuler(e.set(rnd() * 3, rnd() * 3, rnd() * 3));
      m.compose(new THREE.Vector3(pl[0] + Math.cos(ang) * f * r, y, pl[1] + Math.sin(ang) * f * r), q, s.setScalar(0.7 + rnd() * 0.8));
      chips.setMatrixAt(i, m);
      chips.setColorAt(i, c.setHSL(0.08 + rnd() * 0.03, 0.45 + rnd() * 0.2, 0.45 + rnd() * 0.25));
    }
    chips.castShadow = true;
    this.scene.add(mesh, chips);
    return { mesh, chips, V: pl[2] };
  }

  /** Chipper-local point to world, from where it is drawn now. */
  toWorld(l, out = new THREE.Vector3()) {
    const g = this.group;
    return out.set(l[0], l[1], l[2]).applyQuaternion(g.quaternion).add(g.position);
  }

  update(dt, src, aux) {
    const ch = this.world.chipper;
    this.group.visible = !!ch && !ch.wreck;
    for (const [id, P] of this.wreckParts) {
      const pose = src.pose(id);
      if (pose) { P.m.position.set(pose.p.x, pose.p.y, pose.p.z); P.m.quaternion.set(pose.q.x, pose.q.y, pose.q.z, pose.q.w); }
    }
    if (!ch || ch.wreck) { this.spray.visible = false; return; }
    const pose = src.pose(CHIPPER_BODY_ID);
    if (pose) { this.group.position.set(pose.p.x, pose.p.y, pose.p.z); this.group.quaternion.set(pose.q.x, pose.q.y, pose.q.z, pose.q.w); }
    else if (!this.posed) { this.group.position.set(...ch.p); this.group.quaternion.set(...ch.q); }
    this.posed = !!pose;
    // chips flying from the chute to where they land
    const on = !!(aux && aux.chip && aux.chip.on);
    this.spray.visible = on;
    if (!on) return;
    this.t += dt;
    const A = this.toWorld(CHUTE[CHUTE.length - 1]), q = this.group.quaternion, p = this.group.position;
    const land = chipToWorld([p.x, p.y, p.z], [q.x, q.y, q.z, q.w], [SHAPE.DISCHARGE[0], -SHAPE.BODY_Y, SHAPE.DISCHARGE[1]]);
    const B = new THREE.Vector3(land[0], groundY(this.world.terrain, land[0], land[2]) + 0.3, land[2]), m = new THREE.Matrix4(), rq = new THREE.Quaternion(), e = new THREE.Euler(), one = new THREE.Vector3(1, 1, 1), v = new THREE.Vector3();
    for (let i = 0; i < SPRAY; i++) {
      const u = (this.t * 1.4 + i / SPRAY) % 1, j = (i * 0.618) % 1 - 0.5;
      v.lerpVectors(A, B, u); v.y += Math.sin(u * Math.PI) * 0.6; v.x += j * 0.4 * u; v.z += ((i * 0.37) % 1 - 0.5) * 0.4 * u;
      rq.setFromEuler(e.set(this.t * 9 + i, this.t * 7 + i * 2, 0));
      this.spray.setMatrixAt(i, m.compose(v, rq, one));
    }
    this.spray.instanceMatrix.needsUpdate = true;
  }
}
