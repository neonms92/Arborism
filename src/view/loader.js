// Draws the grapple loader (its chassis, wheels, boom and claw) and the log truck with the wood hauled so far
// (shapes from model/loader.js), posed from the snapshots and aux. No game rules.

import * as THREE from 'three';
import { LOADER, TRUCK, LOADER_BODY_ID, GRAPPLE_BODY_ID } from '../model/loader.js';

const _v = new THREE.Vector3(), _q = new THREE.Quaternion(), _m = new THREE.Matrix4();
const LOG_KG = 250;                // kg of hauled wood per log drawn in the bed
const LOGS_MAX = 18;               // the most drawn: the bed looks full from there on (it never fills)

export class LoaderView {
  constructor(scene, world) {
    this.scene = scene; this.world = world;
    const lam = (c, extra) => new THREE.MeshLambertMaterial({ color: c, flatShading: true, ...extra });
    this.mats = { yellow: lam(0xf2b51c), dark: lam(0x262626), grey: lam(0x8a8d90), steel: lam(0x5d6166), red: lam(0xb8322a),
      white: lam(0xe8e8e2), glass: lam(0x223344), wood: lam(0x8a6236), end: lam(0xd9b98a) };
    this.loader = null; this.truck = null; this.logs = null; this.shown = -1;
    this.spin = 0; this.lastP = null;
  }

  onEvent(ev) {
    if (ev.t === 'loader' || ev.t === 'load' || ev.t === 'reset') this.rebuild();
    if (ev.t === 'haul' || ev.t === 'load' || ev.t === 'loader') this.fillBed();
  }

  rebuild() {
    for (const o of [this.loader?.g, this.loader?.grapple, this.truck]) if (o) this.scene.remove(o);
    this.loader = null; this.truck = null; this.logs = null; this.shown = -1;
    const L = this.world.loader; if (!L) return;
    this.loader = this.buildLoader(); this.truck = this.buildTruck();
    this.loader.g.position.set(...L.p); this.loader.g.quaternion.set(...L.q);
    this.truck.position.set(...L.truck.p); this.truck.quaternion.set(...L.truck.q);
    this.scene.add(this.loader.g, this.loader.grapple, this.truck);
  }

  buildLoader() {
    const L = LOADER, M = this.mats, g = new THREE.Group(), parts = [];
    const box = (b, mat, par = parts) => { const m = new THREE.Mesh(new THREE.BoxGeometry(b.h[0] * 2, b.h[1] * 2, b.h[2] * 2), mat); m.position.set(...b.c); par.push(m); return m; };
    box(L.CHASSIS, M.yellow);
    box(L.WEIGHT, M.dark);
    box(L.PLATFORM, M.steel);
    box(L.POST, M.dark);
    box({ c: [L.POST.c[0] + 0.04, L.POST.c[1] + L.POST.h[1], 0], h: [0.08, 0.03, 0.32] }, M.grey);       // the control panel
    for (const z of [-0.18, 0.18]) box({ c: [L.POST.c[0] + 0.02, L.POST.c[1] + L.POST.h[1] + 0.1, z], h: [0.012, 0.08, 0.012] }, M.red);   // two levers
    // guard rails round the platform
    for (const z of [-0.5, 0.5]) box({ c: [L.PLATFORM.c[0] - 0.05, 0.15, z], h: [0.25, 0.02, 0.02] }, M.grey);
    for (const z of [-0.5, 0.5]) box({ c: [L.PLATFORM.c[0] - 0.28, -0.1, z], h: [0.02, 0.25, 0.02] }, M.grey);
    // the boom towers beside the pivot
    for (const s of [-1, 1]) box({ c: [L.PIVOT[0], (L.PIVOT[1] + L.CHASSIS.h[1]) / 2, s * L.ARM_Z], h: [0.12, (L.PIVOT[1] - L.CHASSIS.h[1]) / 2 + 0.06, 0.05] }, M.yellow);
    // wheels: each in its own group so the front two can steer and all of them roll
    this.wheels = [];
    for (const w of L.WHEELS) {
      const wg = new THREE.Group(); wg.position.set(...w);
      const tyre = new THREE.Mesh(new THREE.CylinderGeometry(L.WHEEL_R, L.WHEEL_R, L.WHEEL_W, 16).rotateX(Math.PI / 2), M.dark);
      const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.18, L.WHEEL_W + 0.02, 8).rotateX(Math.PI / 2), M.yellow);
      const roll = new THREE.Group(); roll.add(tyre, hub);
      for (const m of [tyre, hub]) { m.castShadow = true; m.receiveShadow = true; }
      wg.add(roll); g.add(wg); this.wheels.push({ wg, roll });
    }
    // the boom: two arms from the pivot, a cross beam at the tip; drawn along +x, turned about the pivot
    const boom = new THREE.Group(); boom.position.set(...L.PIVOT);
    const bp = [];
    for (const s of [-1, 1]) box({ c: [L.BOOM_L / 2, 0, s * L.ARM_Z], h: [L.BOOM_L / 2 + 0.08, 0.09, 0.05] }, M.yellow, bp);
    box({ c: [L.BOOM_L, 0, 0], h: [0.08, 0.08, L.ARM_Z + 0.05] }, M.yellow, bp);
    box({ c: [L.BOOM_L * 0.3, 0, 0], h: [0.06, 0.06, L.ARM_Z] }, M.yellow, bp);
    for (const m of bp) { m.castShadow = true; m.receiveShadow = true; boom.add(m); }
    g.add(boom);
    // the boom's rams, one beside each arm: from low on the chassis to a third of the way along the boom
    const rams = [-1, 1].map((s) => { const r = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 1, 8), M.steel); r.castShadow = true; r.userData.z = s * (L.ARM_Z + 0.11); g.add(r); return r; });
    for (const m of parts) { m.castShadow = true; m.receiveShadow = true; g.add(m); }
    // the grapple: its own group, posed from its body
    const grapple = new THREE.Group(), gp = [];
    box(L.HEAD, M.yellow, gp);
    const link = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, L.LINK[1] - L.HEAD.h[1], 6), M.steel);
    link.position.set(0, (L.LINK[1] + L.HEAD.h[1]) / 2, 0); gp.push(link);
    const rot = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 0.12, 10), M.dark); rot.position.set(0, L.HEAD.h[1] + 0.06, 0); gp.push(rot);
    for (const m of gp) { m.castShadow = true; m.receiveShadow = true; grapple.add(m); }
    // the tines hinge at the head's ends and curve in at the bottom
    const tines = [];
    for (const s of [1, -1]) {
      const hinge = new THREE.Group(); hinge.position.set(0, -L.HEAD.h[1] + 0.02, s * L.TINE.c[2]);
      const T = L.TINE.h, len = T[1] * 2;
      const upper = new THREE.Mesh(new THREE.BoxGeometry(T[0] * 2, len, T[2] * 2), M.steel); upper.position.set(0, -len / 2, 0);
      const tip = new THREE.Mesh(new THREE.BoxGeometry(T[0] * 2, 0.22, T[2] * 2), M.steel);
      tip.position.set(0, -len + 0.06, -s * 0.08); tip.rotation.x = s * 0.9;
      for (const m of [upper, tip]) { m.castShadow = true; hinge.add(m); }
      grapple.add(hinge); tines.push({ hinge, s });
    }
    return { g, boom, rams, grapple, tines, jaw: 0 };
  }

  buildTruck() {
    const T = TRUCK, M = this.mats, g = new THREE.Group(), parts = [];
    const box = (b, mat, flip = false) => { const m = new THREE.Mesh(new THREE.BoxGeometry(b.h[0] * 2, b.h[1] * 2, b.h[2] * 2), mat); m.position.set(b.c[0], b.c[1], flip ? -b.c[2] : b.c[2]); parts.push(m); return m; };
    box(T.FRAME, M.dark);
    box(T.CAB, M.white); box(T.HOOD, M.white);
    // windscreen and side windows
    box({ c: [T.CAB.c[0] + T.CAB.h[0] + 0.005, T.CAB.c[1] + 0.35, 0], h: [0.01, 0.35, T.CAB.h[2] - 0.15] }, M.glass);
    for (const s of [false, true]) box({ c: [T.CAB.c[0] + 0.1, T.CAB.c[1] + 0.35, T.CAB.h[2] + 0.005], h: [0.45, 0.3, 0.01] }, M.glass, s);
    box({ c: [T.HOOD.c[0] + T.HOOD.h[0] + 0.03, T.HOOD.c[1] - 0.25, 0], h: [0.05, 0.12, T.HOOD.h[2] + 0.1] }, M.steel);   // bumper
    box(T.FLOOR, M.red); box(T.HEADBOARD, M.red); box(T.TAILGATE, M.red);
    box(T.SIDE, M.red); box(T.SIDE, M.red, true);
    // stakes along the sides
    for (let x = T.FLOOR.c[0] - T.FLOOR.h[0] + 0.3; x < T.FLOOR.c[0] + T.FLOOR.h[0]; x += 1.1) for (const s of [false, true]) box({ c: [x, T.SIDE.c[1], T.SIDE.c[2] + 0.06], h: [0.05, T.SIDE.h[1] + 0.05, 0.03] }, M.dark, s);
    for (const w of T.WHEELS) { const m = new THREE.Mesh(new THREE.CylinderGeometry(T.WHEEL_R, T.WHEEL_R, 0.4, 16).rotateX(Math.PI / 2), M.dark); m.position.set(...w); parts.push(m); }
    for (const m of parts) { m.castShadow = true; m.receiveShadow = true; g.add(m); }
    this.logs = new THREE.Group(); g.add(this.logs);
    return g;
  }

  /** The wood hauled so far, as logs stacked in the bed (one per LOG_KG, up to the brim). */
  fillBed() {
    const L = this.world.loader; if (!L || !this.logs) return;
    const n = Math.min(LOGS_MAX, Math.ceil((L.kg || 0) / LOG_KG));
    if (n === this.shown) return;
    this.shown = n;
    while (this.logs.children.length) this.logs.remove(this.logs.children[0]);
    const T = TRUCK, B = T.BED, M = this.mats, per = 6, r = 0.17, len = (B.hi[0] - B.lo[0]) * 0.42;
    for (let i = 0; i < n; i++) {
      const row = Math.floor(i / per), k = i % per, half = Math.floor(k / 3), j = k % 3;
      const geo = new THREE.CylinderGeometry(r, r * 1.08, len, 9).rotateZ(Math.PI / 2);
      const log = new THREE.Mesh(geo, [M.wood, M.end, M.end]);
      log.position.set(B.lo[0] + 0.15 + len / 2 + half * (len + 0.25) + (row % 2) * 0.12, B.lo[1] + r + row * r * 1.7, -0.75 + j * 0.75 + (row % 2) * 0.2);
      log.rotation.x = (i * 0.7) % 1; log.castShadow = true; log.receiveShadow = true;
      this.logs.add(log);
    }
  }

  /** The loader's heading as a look yaw (0 looks toward -z), from where it is drawn now; null with no loader. */
  yaw() {
    if (!this.loader) return null;
    const f = _v.set(1, 0, 0).applyQuaternion(this.loader.g.quaternion);
    return Math.atan2(-f.x, -f.z);
  }

  update(dt, src, aux) {
    const u = this.loader; if (!u) return;
    const pb = src.pose(LOADER_BODY_ID), pg = src.pose(GRAPPLE_BODY_ID), ld = aux && aux.ld;
    if (pb) { u.g.position.set(pb.p.x, pb.p.y, pb.p.z); u.g.quaternion.set(pb.q.x, pb.q.y, pb.q.z, pb.q.w); }
    if (pg) { u.grapple.position.set(pg.p.x, pg.p.y, pg.p.z); u.grapple.quaternion.set(pg.q.x, pg.q.y, pg.q.z, pg.q.w); }
    const L = LOADER;
    // the boom points at where the claw hangs from (its link), seen from the pivot in the loader's frame
    const tip = _v.set(...L.LINK).applyQuaternion(u.grapple.quaternion).add(u.grapple.position);
    _m.compose(u.g.position, u.g.quaternion, new THREE.Vector3(1, 1, 1)).invert();
    tip.applyMatrix4(_m);
    const a = Math.atan2(tip.y - L.PIVOT[1], tip.x - L.PIVOT[0]);
    u.boom.rotation.set(0, 0, Number.isFinite(a) ? a : (ld ? ld[2] : L.BOOM_START));
    // the rams from the chassis to a third of the way along the boom
    const A = new THREE.Vector3(L.PIVOT[0] + 0.9, L.CHASSIS.h[1] - 0.05, 0), Bp = new THREE.Vector3(L.PIVOT[0] + L.BOOM_L * 0.3 * Math.cos(u.boom.rotation.z), L.PIVOT[1] + L.BOOM_L * 0.3 * Math.sin(u.boom.rotation.z) - 0.08, 0);
    for (const r of u.rams) {
      r.position.copy(A).add(Bp).multiplyScalar(0.5); r.position.z = r.userData.z;
      r.scale.set(1, A.distanceTo(Bp), 1);
      r.quaternion.setFromUnitVectors(_v.set(0, 1, 0), Bp.clone().sub(A).normalize());
    }
    // the tines: swung out open, in round the log shut
    const want = ld && ld[0] ? 1 : 0;
    u.jaw += Math.max(-dt * 3, Math.min(dt * 3, want - u.jaw));
    for (const t of u.tines) t.hinge.rotation.x = t.s * (-0.35 + 0.55 * u.jaw);
    // wheels: the front two steer; all roll with the distance driven along the loader's heading
    const st = ld ? ld[1] : 0;
    if (this.lastP) {
      const d = _v.copy(u.g.position).sub(this.lastP), f = new THREE.Vector3(1, 0, 0).applyQuaternion(u.g.quaternion);
      this.spin -= d.dot(f) / L.WHEEL_R;
    }
    this.lastP = (this.lastP || new THREE.Vector3()).copy(u.g.position);
    this.wheels.forEach((w, i) => { w.wg.rotation.y = i < 2 ? -st : 0; w.roll.rotation.z = this.spin; });
  }
}
