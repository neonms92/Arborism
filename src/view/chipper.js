// Draws the wood chippers (shape from model/chipper.js; one or more, world.chipper.units),
// their salad racks, the chip piles, and chips flying out of a chute while it is
// chipping, and its two floodlights (on at night; dim and flicker while it chips,
// out with the wreck). No game rules.

import * as THREE from 'three';
import { SHAPE, CHIPPER_BODY_ID, pileShape, chipToWorld, WRECK, cageArc, floodLamps } from '../model/chipper.js';
import { CFG } from '../config.js';
import { compose } from '../model/builds.js';
import { groundY } from '../model/terrain.js';

const CHUTE = [[0.2, 0.45, 0.3], [0.2, 1.45, 0.35], [0.2, 1.75, 0.8], [0.2, 1.55, 1.35]];   // discharge chute, chipper-local
const SPRAY = 48;
const _lit = new THREE.Color(0xfff6dc);    // a floodlight's lens when it is on

export class ChipperView {
  constructor(scene, world) {
    this.scene = scene; this.world = world;
    this.group = new THREE.Group();        // the template every chipper's group is a clone of (never in the scene)
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
    // the winch over the hopper mouth: a drum on two posts
    const drum = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.34, 10).rotateX(Math.PI / 2), dark); drum.position.set(...S.WINCH); parts.push(drum);
    for (const z of [-0.2, 0.2]) {
      const top = S.HOPPER.c[1] + S.HOPPER.h[1], m = new THREE.Mesh(new THREE.BoxGeometry(0.04, S.WINCH[1] - top + 0.05, 0.04), grey);
      m.position.set(S.WINCH[0], (S.WINCH[1] + top) / 2, z); parts.push(m);
    }
    for (const w of S.WHEELS) { const m = new THREE.Mesh(new THREE.CylinderGeometry(S.WHEEL_R, S.WHEEL_R, 0.22, 14).rotateX(Math.PI / 2), dark); m.position.set(...w); parts.push(m); }
    const jw = new THREE.Mesh(new THREE.CylinderGeometry(S.JOCKEY_R, S.JOCKEY_R, 0.08, 10).rotateX(Math.PI / 2), dark); jw.position.set(...S.JOCKEY); parts.push(jw);
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.45, 6), grey); post.position.set(S.JOCKEY[0], S.JOCKEY[1] + 0.25, 0); parts.push(post);
    parts.push(box(S.DRAWBAR, grey));
    const grip = new THREE.Mesh(new THREE.TorusGeometry(0.1, 0.025, 6, 12).rotateX(Math.PI / 2), yellow); grip.position.set(...S.GRIP); parts.push(grip);
    const chute = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(CHUTE.map((p) => new THREE.Vector3(...p))), 12, 0.13, 7), orange);
    parts.push(chute);
    // the tube is open-ended and single-sided: line its inside black so the outlet reads as a dark hole
    const liner = new THREE.Mesh(chute.geometry, lam(0x111111, { side: THREE.BackSide }));
    // the roll cage (its collider is the dome between the hoops, D91): two hoops, rails along it, and struts from
    // the hoops' feet in to the chassis
    const C = S.CAGE, arc = cageArc(), foot = arc[0], tube = (pts, n) => new THREE.Mesh(new THREE.TubeGeometry(
      n ? new THREE.CatmullRomCurve3(pts) : new THREE.LineCurve3(pts[0], pts[1]), n || 1, 0.025, 6), grey);
    for (const x of [C.x0, C.x1]) {
      parts.push(tube(arc.map(([y, z]) => new THREE.Vector3(x, y, z)), 48));
      for (const s of [-1, 1]) parts.push(tube([new THREE.Vector3(x, foot[0], s * foot[1]), new THREE.Vector3(x, foot[0], s * S.CHASSIS.h[2])]));
    }
    for (let j = 0; j <= 4; j++) { const [y, z] = arc[Math.round(j * (arc.length - 1) / 4)]; parts.push(tube([new THREE.Vector3(C.x0, y, z), new THREE.Vector3(C.x1, y, z)])); }
    // the salad rack on the side away from the chute: a grey open box with three tube salads standing in it
    const R = S.RACK, T = 0.012, rack = [];
    rack.push(box({ c: [R.c[0], R.c[1] - R.h[1] + T, R.c[2]], h: [R.h[0], T, R.h[2]] }, grey));             // floor
    rack.push(box({ c: [R.c[0], R.c[1], R.c[2] + R.h[2] - T], h: [R.h[0], R.h[1], T] }, grey));              // back, on the chassis
    for (const sx of [-1, 1]) rack.push(box({ c: [R.c[0] + sx * (R.h[0] - T), R.c[1], R.c[2]], h: [T, R.h[1], R.h[2]] }, grey));
    rack.push(box({ c: [R.c[0], R.c[1] - R.h[1] * 0.55, R.c[2] - R.h[2] + T], h: [R.h[0], 0.01, T] }, grey));   // the low front bar that holds them in
    this.saladGeo = saladGeometry();
    this.saladMat = lam(0x3fae3a);
    for (const c of S.SALADS) { const m = new THREE.Mesh(this.saladGeo, this.saladMat); m.position.set(...c); rack.push(m); }
    parts.push(...rack);
    // the floodlights: a dark housing on a short bracket from the back hoop, its lens toward FLOOD_AIM. The lens is
    // named so each chipper's clone gets its own material (it glows with that chipper's lamps)
    this.lensOff = new THREE.Color(0x555555);
    const lensMat = new THREE.MeshBasicMaterial({ color: this.lensOff });
    for (const L of floodLamps()) {
      const aim = [SHAPE.FLOOD_AIM[0], SHAPE.FLOOD_AIM[1], Math.sign(L[2]) * SHAPE.FLOOD_AIM[2]];
      const lamp = new THREE.Group(); lamp.position.set(...L);
      lamp.lookAt(new THREE.Vector3(...aim));           // a group's +z looks at the target
      const body = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.13, 0.08), dark);
      const lens = new THREE.Mesh(new THREE.PlaneGeometry(0.15, 0.1), lensMat); lens.position.z = 0.041; lens.name = 'floodLens';
      lamp.add(body, lens); this.group.add(lamp);
      body.castShadow = true;
      parts.push(tube([new THREE.Vector3(S.CAGE.x0, L[1], L[2]), new THREE.Vector3(L[0] + 0.03, L[1], L[2])]));   // bracket
    }
    for (const m of parts) { m.castShadow = true; m.receiveShadow = true; this.group.add(m); }
    this.group.add(liner);
    this.units = [];                // per world.chipper.units[k]: {group, spray, t, posed, wreckRoot, wreckParts}

    this.pileMat = lam(0xc49a5c);
    this.chipMat = new THREE.MeshLambertMaterial({ color: 0xffffff, flatShading: true });
    this.piles = [];                // [{mesh, chips, V}]
    this.sprayGeo = new THREE.BoxGeometry(0.05, 0.015, 0.035);
    // the wreck, once it has crumpled: one mesh per part
    this.wreckMats = { body: orange, dark: lam(0xb85810), wheel: dark, steel: grey, grip: yellow };
  }

  /** The drawing of chipper k, made the first time it is needed. */
  unit(k) {
    let u = this.units[k];
    if (u) return u;
    const group = this.group.clone(); group.visible = false;
    const spray = new THREE.InstancedMesh(this.sprayGeo, this.chipMat, SPRAY);
    spray.frustumCulled = false; spray.visible = false;
    const c = new THREE.Color();
    for (let i = 0; i < SPRAY; i++) spray.setColorAt(i, c.setHSL(0.09 + (i % 5) * 0.008, 0.5, 0.55 + (i % 3) * 0.08));
    const wreckRoot = new THREE.Group();
    // its floodlights: spotlights in the scene (posed from the group each frame), and its own lens material
    const lensMat = new THREE.MeshBasicMaterial({ color: this.lensOff });
    group.traverse((o) => { if (o.name === 'floodLens') o.material = lensMat; });
    const floods = floodLamps().map((L) => {
      const s = new THREE.SpotLight(0xfff2d8, 0, 0, CFG.FLOOD_ANGLE, 0.5, 2);
      s.userData.at = L; s.userData.aim = [SHAPE.FLOOD_AIM[0], SHAPE.FLOOD_AIM[1], Math.sign(L[2]) * SHAPE.FLOOD_AIM[2]];
      this.scene.add(s, s.target); return s;
    });
    this.scene.add(group, spray, wreckRoot);
    u = this.units[k] = { k, group, spray, t: 0, posed: false, wreckRoot, wreckParts: new Map(),   // wreckParts: part body id -> {m, rest}
      floods, lensMat, load: 0, fl: 0, dip: 0 };
    return u;
  }
  /** Units beyond what the world has (after a new tree) go. */
  trim() {
    const n = this.world.chipper ? this.world.chipper.units.length : 0;
    while (this.units.length > n) {
      const u = this.units.pop(); this.scene.remove(u.group, u.spray, u.wreckRoot); u.spray.dispose();
      for (const s of u.floods) this.scene.remove(s, s.target);
    }
  }

  syncWreck(k) {
    const u = this.unit(k);
    u.wreckRoot.clear(); u.wreckParts.clear();
    const wr = this.world.chipper && this.world.chipper.units[k] && this.world.chipper.units[k].wreck; if (!wr) return;
    WRECK.forEach((pt, j) => {
      const geo = pt.mat === 'wheel' ? new THREE.CylinderGeometry(pt.h[0], pt.h[0], Math.max(0.04, pt.h[2] * 2), 12).rotateX(Math.PI / 2)
        : new THREE.BoxGeometry(pt.h[0] * 2, pt.h[1] * 2, pt.h[2] * 2);
      const m = new THREE.Mesh(geo, this.wreckMats[pt.mat] || this.wreckMats.body);
      m.castShadow = m.receiveShadow = true;
      const rest = compose(wr.at.p, wr.at.q, pt.c, pt.q);
      m.position.set(...rest.p); m.quaternion.set(...rest.q);
      u.wreckRoot.add(m); u.wreckParts.set(wr.ids[j], { m, rest });
    });
  }

  onEvent(ev) {
    if (ev.t === 'chipper' || ev.t === 'load') {
      this.trim();
      const us = this.world.chipper ? this.world.chipper.units : [];
      us.forEach((x, k) => { if (!ev.add || k === ev.k) { this.unit(k).posed = false; this.syncWreck(k); } });
      this.syncPiles(!ev.add);
    }
    else if (ev.t === 'chip' || ev.t === 'chips') this.syncPiles(false);
    else if (ev.t === 'chipwreck') this.syncWreck(ev.k || 0);
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

  /** Is chipper k drawn whole (not wrecked, not missing)? */
  whole(k) { const u = this.units[k || 0]; return !!u && u.group.visible; }
  /** Chipper k's local point to world, from where it is drawn now. */
  toWorld(l, out = new THREE.Vector3(), k = 0) {
    const g = this.unit(k).group;
    return out.set(l[0], l[1], l[2]).applyQuaternion(g.quaternion).add(g.position);
  }

  /** dark: 0 by day to 1 at night (Sky.dark); the floodlights come on with it. */
  update(dt, src, aux, dark = 0) {
    const us = this.world.chipper ? this.world.chipper.units : [];
    this.trim();
    us.forEach((ch, k) => {
      const u = this.unit(k), ax = aux && aux.chip && Array.isArray(aux.chip) ? aux.chip[k] : null;
      this.updateUnit(u, ch, dt, src, ax);
      this.updateFloods(u, ch, dt, ax, dark);
    });
  }

  // The floodlights run off the chipper's engine: on at night while it is whole; while it chips the engine bogs and
  // they sag to FLOOD_DIM and flicker below it (random steps, smoothed, with now and then a deeper dip). A wreck's
  // lamps are dead.
  updateFloods(u, ch, dt, ax, dark) {
    const whole = !!ch && !ch.wreck && u.group.visible;
    u.load += ((ax && ax.on ? 1 : 0) - u.load) * Math.min(1, dt / 0.15);
    u.fl += (Math.random() - u.fl) * Math.min(1, dt * 30);
    if (Math.random() < dt * 2.5 * u.load) u.dip = 0.5 + Math.random() * 0.5;
    u.dip *= Math.exp(-dt * 12);
    const flick = Math.max(0, 1 - CFG.FLOOD_FLICKER * u.load * (u.fl + u.dip));
    const level = whole ? dark * (1 - u.load * (1 - CFG.FLOOD_DIM)) * flick : 0;
    u.lensMat.color.copy(this.lensOff).lerp(_lit, Math.min(1, level * 1.2));
    for (const s of u.floods) {
      s.intensity = CFG.FLOOD * level; s.angle = CFG.FLOOD_ANGLE;
      if (!level) continue;     // (kept in the scene at 0, like the headlamps: adding and removing lights recompiles shaders)
      this.toWorld(s.userData.at, s.position, u.k);
      this.toWorld(s.userData.aim, s.target.position, u.k);
      s.target.updateMatrixWorld();
    }
  }

  updateUnit(u, ch, dt, src, ax) {
    u.group.visible = !!ch && !ch.wreck;
    for (const [id, P] of u.wreckParts) {
      const pose = src.pose(id);
      if (pose) { P.m.position.set(pose.p.x, pose.p.y, pose.p.z); P.m.quaternion.set(pose.q.x, pose.q.y, pose.q.z, pose.q.w); }
    }
    if (!ch || ch.wreck) { u.spray.visible = false; return; }
    const pose = src.pose(CHIPPER_BODY_ID + u.k);
    if (pose) { u.group.position.set(pose.p.x, pose.p.y, pose.p.z); u.group.quaternion.set(pose.q.x, pose.q.y, pose.q.z, pose.q.w); }
    else if (!u.posed) { u.group.position.set(...ch.p); u.group.quaternion.set(...ch.q); }
    u.posed = !!pose;
    // chips flying from the chute to where they land
    const on = !!(ax && ax.on);
    u.spray.visible = on;
    if (!on) return;
    u.t += dt;
    const A = this.toWorld(CHUTE[CHUTE.length - 1], new THREE.Vector3(), u.k), q = u.group.quaternion, p = u.group.position;
    const land = chipToWorld([p.x, p.y, p.z], [q.x, q.y, q.z, q.w], [SHAPE.DISCHARGE[0], -SHAPE.BODY_Y, SHAPE.DISCHARGE[1]]);
    const B = new THREE.Vector3(land[0], groundY(this.world.terrain, land[0], land[2]) + 0.3, land[2]), m = new THREE.Matrix4(), rq = new THREE.Quaternion(), e = new THREE.Euler(), one = new THREE.Vector3(1, 1, 1), v = new THREE.Vector3();
    for (let i = 0; i < SPRAY; i++) {
      const f = (u.t * 1.4 + i / SPRAY) % 1, j = (i * 0.618) % 1 - 0.5;
      v.lerpVectors(A, B, f); v.y += Math.sin(f * Math.PI) * 0.6; v.x += j * 0.4 * f; v.z += ((i * 0.37) % 1 - 0.5) * 0.4 * f;
      rq.setFromEuler(e.set(u.t * 9 + i, u.t * 7 + i * 2, 0));
      u.spray.setMatrixAt(i, m.compose(v, rq, one));
    }
    u.spray.instanceMatrix.needsUpdate = true;
  }
}

/** A tube salad: a green cylinder SALAD_R round and 2 x SALAD_H long. Shared with the players' hands (view.js). */
export function saladGeometry() {
  return new THREE.CylinderGeometry(SHAPE.SALAD_R, SHAPE.SALAD_R, SHAPE.SALAD_H * 2, 10);
}
