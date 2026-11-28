// Draws the grapple loader (a skid steer: its chassis, wheels, arms and over-and-under claw) and the log truck with the wood hauled so far
// (shapes from model/loader.js), posed from the snapshots and aux. No game rules.

import * as THREE from 'three';
import { LOADER, TRUCK, LOADER_BODY_ID, GOE_ID0, GOE_NAME, GOE_COLOR, armTip } from '../model/loader.js';
import { Avatar } from './avatar.js';

const _v = new THREE.Vector3();
const LOG_KG = 250;                // kg of hauled wood per log drawn in the bed
const LOGS_MAX = 18;               // the most drawn: the bed looks full from there on (it never fills)

export class LoaderView {
  constructor(scene, world) {
    this.scene = scene; this.world = world;
    const lam = (c, extra) => new THREE.MeshLambertMaterial({ color: c, flatShading: true, ...extra });
    this.mats = { yellow: lam(0xf2b51c), dark: lam(0x262626), grey: lam(0x8a8d90), steel: lam(0x5d6166), red: lam(0xb8322a),
      white: lam(0xe8e8e2), glass: lam(0x223344), wood: lam(0x8a6236), end: lam(0xd9b98a) };
    this.loader = null; this.truck = null; this.logs = null; this.shown = -1;
    this.lastW = null;
  }

  onEvent(ev) {
    if (ev.t === 'loader' || ev.t === 'load' || ev.t === 'reset') this.rebuild();
    if (ev.t === 'haul' || ev.t === 'load' || ev.t === 'loader') this.fillBed();
  }

  rebuild() {
    for (const o of [this.loader?.g, this.truck]) if (o) this.scene.remove(o);
    this.loader = null; this.truck = null; this.logs = null; this.shown = -1;
    const L = this.world.loader; if (!L) return;
    this.loader = this.buildLoader(); this.truck = this.buildTruck();
    this.loader.g.position.set(...L.p); this.loader.g.quaternion.set(...L.q);
    this.truck.position.set(...L.truck.p); this.truck.quaternion.set(...L.truck.q);
    this.scene.add(this.loader.g, this.truck); this.lastW = null;
  }

  buildLoader() {
    const L = LOADER, M = this.mats, g = new THREE.Group(), parts = [];
    const box = (b, mat, par = parts) => { const m = new THREE.Mesh(new THREE.BoxGeometry(b.h[0] * 2, b.h[1] * 2, b.h[2] * 2), mat); m.position.set(...b.c); par.push(m); return m; };
    box(L.CHASSIS, M.yellow);
    box(L.WEIGHT, M.dark);
    box({ c: [L.CHASSIS.c[0] + 0.55, L.CHASSIS.h[1] + 0.02, 0], h: [0.4, 0.03, 0.45] }, M.dark);      // the engine hood's grille
    box(L.PLATFORM, M.steel);
    box(L.POST, M.dark);
    box({ c: [L.POST.c[0] + 0.04, L.POST.c[1] + L.POST.h[1], 0], h: [0.08, 0.03, 0.32] }, M.grey);       // the control panel
    for (const z of [-0.18, 0.18]) box({ c: [L.POST.c[0] + 0.02, L.POST.c[1] + L.POST.h[1] + 0.1, z], h: [0.012, 0.08, 0.012] }, M.red);   // two levers
    // guard rails round the platform
    for (const z of [-0.5, 0.5]) box({ c: [L.PLATFORM.c[0] - 0.05, 0.15, z], h: [0.25, 0.02, 0.02] }, M.grey);
    for (const z of [-0.5, 0.5]) box({ c: [L.PLATFORM.c[0] - 0.28, -0.1, z], h: [0.02, 0.25, 0.02] }, M.grey);
    // the arms' towers at the back, either side of the driver
    for (const s of [-1, 1]) box({ c: [L.PIVOT[0], (L.PIVOT[1] + L.CHASSIS.h[1]) / 2 - 0.05, s * L.ARM_Z], h: [0.14, (L.PIVOT[1] - L.CHASSIS.h[1]) / 2 + 0.15, 0.05] }, M.yellow);
    // wheels: each in its own group, rolled by how far it went along the loader's heading (the sides differ in a turn)
    this.wheels = [];
    for (const w of L.WHEELS) {
      const wg = new THREE.Group(); wg.position.set(...w);
      const tyre = new THREE.Mesh(new THREE.CylinderGeometry(L.WHEEL_R, L.WHEEL_R, L.WHEEL_W, 16).rotateX(Math.PI / 2), M.dark);
      const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.18, L.WHEEL_W + 0.02, 8).rotateX(Math.PI / 2), M.yellow);
      const roll = new THREE.Group(); roll.add(tyre, hub);
      for (const m of [tyre, hub]) { m.castShadow = true; m.receiveShadow = true; }
      wg.add(roll); g.add(wg); this.wheels.push({ wg, roll, spin: 0 });
    }
    // the arms: one each side from the pivot, a cross tube behind the claw; drawn along +x, turned about the pivot
    const arms = new THREE.Group(); arms.position.set(...L.PIVOT);
    const ap = [];
    for (const s of [-1, 1]) box({ c: [L.ARM_L / 2, 0, s * L.ARM_Z], h: [L.ARM_L / 2 + 0.06, 0.08, 0.05] }, M.yellow, ap);
    box({ c: [L.ARM_L * 0.62, 0, 0], h: [0.06, 0.06, L.ARM_Z] }, M.yellow, ap);
    for (const m of ap) { m.castShadow = true; m.receiveShadow = true; arms.add(m); }
    g.add(arms);
    // the lift rams, one beside each arm: from low on the chassis to half way along the arm
    const rams = [-1, 1].map((s) => { const r = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 1, 8), M.steel); r.castShadow = true; r.userData.z = s * (L.ARM_Z + 0.09); g.add(r); return r; });
    for (const m of parts) { m.castShadow = true; m.receiveShadow = true; g.add(m); }
    // the claw at the arms' ends, kept level: a plate, a fork underneath and a clamp that closes from above
    const claw = new THREE.Group(), cp = [];
    box(L.PLATE, M.steel, cp);
    for (const z of L.TINES) {
      box({ c: [L.FORK.c[0], L.FORK.c[1], z], h: L.FORK.h }, M.dark, cp);
      box({ c: [L.FORK.c[0] + L.FORK.h[0] - 0.03, L.FORK.c[1] + 0.07, z], h: [0.03, 0.08, L.FORK.h[2]] }, M.dark, cp);   // turned up at the tip
    }
    box({ c: [0.1, L.FORK.c[1] + 0.02, 0], h: [0.08, 0.05, L.PLATE.h[2]] }, M.steel, cp);
    for (const m of cp) { m.castShadow = true; m.receiveShadow = true; claw.add(m); }
    const clamp = new THREE.Group(); clamp.position.set(...L.CLAMP_HINGE);
    for (const s of [-1, 1]) {
      const a = new THREE.Mesh(new THREE.BoxGeometry(L.CLAMP_L, 0.07, 0.06), M.steel); a.position.set(L.CLAMP_L / 2, 0, s * L.CLAMP_Z);
      const hook = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.34, 0.06), M.steel); hook.position.set(L.CLAMP_L - 0.04, -0.15, s * L.CLAMP_Z); hook.rotation.z = -0.35;
      for (const m of [a, hook]) { m.castShadow = true; clamp.add(m); }
    }
    const bar = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.06, L.CLAMP_Z * 2), M.steel); bar.position.set(L.CLAMP_L * 0.55, 0, 0); clamp.add(bar);
    const cyl = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.4, 8), M.dark); cyl.position.set(0.0, 0.2, 0); claw.add(cyl);
    claw.add(clamp); g.add(claw);
    return { g, arms, rams, claw, clamp };
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
    // the G.O.E. rack between the bed and the cab: a deck, a spine down the middle, a rail along its top, and the
    // groundbots stood switched off against it (a slot is drawn empty once its G.O.E. is a player, updateRack)
    box(T.RACK_DECK, M.steel); box(T.RACK_SPINE, M.grey);
    box({ c: [T.RACK_SPINE.c[0], T.RACK_SPINE.c[1] + T.RACK_SPINE.h[1], 0], h: [T.RACK_SPINE.h[0] + 0.03, 0.03, 0.06] }, M.dark);
    for (const x of [-1, 0, 1]) box({ c: [T.RACK_SPINE.c[0] + x * (T.RACK_SPINE.h[0] - 0.02), T.RACK_SPINE.c[1], 0], h: [0.03, T.RACK_SPINE.h[1], 0.06] }, M.dark);
    for (const m of parts) { m.castShadow = true; m.receiveShadow = true; g.add(m); }
    this.racked = T.RACK_SLOTS.map((s) => {
      const av = new Avatar(true); av.setPower(false); av.setLook(GOE_NAME, GOE_COLOR);
      av.group.position.set(...s.c); av.group.rotation.y = s.f > 0 ? Math.PI : 0;     // he faces -z in his own frame
      g.add(av.group); return av;
    });
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

  /** Racked G.O.E.s show only in slots whose G.O.E. has not been taken off (is not a player). */
  updateRack() {
    if (this.racked) this.racked.forEach((av, i) => { av.group.visible = !this.world.players.has(GOE_ID0 - i); });
  }

  update(dt, src, aux) {
    this.updateRack();
    const u = this.loader; if (!u) return;
    const pb = src.pose(LOADER_BODY_ID), ld = aux && aux.ld, L = LOADER;
    if (pb) { u.g.position.set(pb.p.x, pb.p.y, pb.p.z); u.g.quaternion.set(pb.q.x, pb.q.y, pb.q.z, pb.q.w); }
    // the arms at the angle the host says; the claw on their ends, level with the loader
    const a = ld && Number.isFinite(ld[2]) ? ld[2] : L.ARM_MIN;
    u.arms.rotation.set(0, 0, a);
    u.claw.position.set(...armTip(a));
    // the clamp: up and open, or down on the fork
    const jaw = ld ? ld[0] : 0;
    u.clamp.rotation.z = 1.0 * (1 - jaw) - 0.12 * jaw;
    // the rams from low on the chassis to half way along the arms
    const A = new THREE.Vector3(L.PIVOT[0] + 1.1, L.CHASSIS.h[1] - 0.15, 0), Bp = new THREE.Vector3(L.PIVOT[0] + L.ARM_L * 0.5 * Math.cos(a), L.PIVOT[1] + L.ARM_L * 0.5 * Math.sin(a) - 0.08, 0);
    for (const r of u.rams) {
      r.position.copy(A).add(Bp).multiplyScalar(0.5); r.position.z = r.userData.z;
      r.scale.set(1, A.distanceTo(Bp), 1);
      r.quaternion.setFromUnitVectors(_v.set(0, 1, 0), Bp.clone().sub(A).normalize());
    }
    // wheels: each rolls with the distance its own centre went along the loader's heading
    const f = new THREE.Vector3(1, 0, 0).applyQuaternion(u.g.quaternion);
    u.g.updateMatrixWorld();
    const now = L.WHEELS.map((w) => new THREE.Vector3(...w).applyMatrix4(u.g.matrixWorld));
    this.wheels.forEach((w, i) => {
      if (this.lastW) w.spin -= now[i].clone().sub(this.lastW[i]).dot(f) / L.WHEEL_R;
      w.roll.rotation.z = w.spin;
    });
    this.lastW = now;
  }
}
