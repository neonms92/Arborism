// Host only: the grapple loader and the log truck (model/loader.js has their shapes).
//
// The loader is a heavy dynamic body on four frictionless wheel balls; the tyres are modelled here as the chipper's
// are (sim/chipper.js): each one that touches the ground grips sideways up to LOADER_GRIP x its share of the weight,
// and drives (or brakes) along its heading, up to that grip and LOADER_DRIVE_F between them. The front two steer.
//
// The boom is a hydraulic arm: an angle, moved by the driver at LOADER_BOOM_RATE. The grapple is its own dynamic
// body hung by a ball joint from the boom tip (the joint's anchor on the loader follows the boom), so it swings,
// and everything it carries pulls on the loader through that joint: a log held far out tips the loader forward.
// The hydraulics stall rather than doing what no real one could: raising, when the held load times its reach
// would need more than LOADER_BOOM_T, or when the back wheels are already off the ground (it is tipping);
// lowering, when the front wheels are off the ground (the claw is pushing the loader up). A rotator keeps the
// grapple turned square to the loader (a spring about the vertical, at most LOADER_ROTATOR_T).
//
// The claw closes on the loose wood between its jaws (no thicker than JAW_R): a fixed joint from the grapple to
// that piece, where it is. Opening it lets go. Wood still standing cannot be taken.
//
// The driver stands on the platform at the back: a kinematic body moved with it, that does not push it. A hard
// enough jolt there (a crash, a roll) is an impact like any other (players.impact); hurt, or with the loader on
// its side, the driver comes off.
//
// The log truck is a fixed body in the street. Loose wood (not held, not joined to the tree) whose centre of mass
// rests in its bed for TRUCK_TAKE_T is hauled away: a 'haul' event, like debris swept up, but it counts toward
// the job (world.prog.hauled). The bed never fills.

import * as THREE from '../../vendor/three/three.module.js';
import { CFG, MODE, INJ } from '../config.js';
import { segRadius } from '../model/world.js';
import { LOADER, TRUCK, LOADER_BODY_ID, GRAPPLE_BODY_ID, boomTip, frameToWorld, worldToFrame, inBed } from '../model/loader.js';
import { effMass } from './chipper.js';
import { sawOff } from './saw.js';

const _q = new THREE.Quaternion(), _v = new THREE.Vector3(), _a = new THREE.Vector3(), _b = new THREE.Vector3();
const yawQ = (a) => [0, Math.sin(a / 2), 0, Math.cos(a / 2)];

export class Loader {
  constructor(sim) {
    this.sim = sim;
    this.body = null; this.grapple = null; this.link = null;
    this.cols = new Set(); this.gcols = new Set();
    this.truck = null; this.truckCols = new Set();
    this.boom = LOADER.BOOM_START; this.steer = 0; this.closed = false;
    this.grab = null;                 // {piece, seg, joint}: what the claw holds
    this.regrab = -1;                 // the held wood was sawn in two: take hold again of the part with this segment
    this.driver = -1;
    this.ctrl = { thr: 0, steer: 0, boom: 0 };
    this.stall = '';                  // why the boom would not move this tick ('' when it did, or was not asked to)
    this.rest = new Map();            // piece id -> s it has lain still in the truck's bed
    this.vStand = null;               // the platform's velocity last tick (the driver's jolts)
    this.lift = { front: 2, rear: 2 };
  }

  // ---- parking: with every new tree, in the street in front of the job's lot ----
  place(plan) {
    const sim = this.sim; if (sim.flat || !plan) return;
    const lot = plan.lots.find((l) => l.tree); if (!lot) return;
    const f = lot.face, kerb = f > 0 ? lot.z1 : lot.z0, ST = CFG.YARD_STREET;
    // the truck along the kerb on the lot's side (the poles stand 0.7 m in from the other kerb, or this one: clear
    // of them), the loader beside it in the middle of the street, facing the lot
    const tz = kerb + f * (TRUCK.HW + 1.4), lz = kerb + f * ST / 2, ty = yawQ(0), ly = yawQ(f * Math.PI / 2);
    const offs = [0]; for (let i = 1; i <= 8; i++) offs.push(i * 3, -i * 3);
    let pick = null;
    for (const o of offs) {
      const tx = (lot.x0 + lot.x1) / 2 * 0.3 + o, lx = tx - TRUCK.HL - 3;
      const T = this.truckPose(tx, tz, ty), L = this.pose(lx, lz, ly);
      if (this.clear(T.p, ty, [TRUCK.HL + 0.3, 1.6, TRUCK.HW + 0.2], 1.6) && this.clear(L.p, ly, [1.9, 1.2, 1.2], 0.5)) { pick = { T, L }; break; }
      if (!pick && o === 0) pick = { T, L, bad: true };
    }
    sim.emit({ t: 'loader', p: pick.L.p, q: pick.L.q, truck: { p: pick.T.p, q: pick.T.q } });
  }
  /** The loader standing at (x, z) turned by q, lifted so no wheel starts in the ground. */
  pose(x, z, q) {
    const sim = this.sim; let y = -Infinity;
    for (const w of LOADER.WHEELS) { const g = frameToWorld([x, 0, z], q, w); y = Math.max(y, sim.groundY(g[0], g[2])); }
    return { p: [+x.toFixed(3), +(y + LOADER.BODY_Y + 0.02).toFixed(3), +z.toFixed(3)], q };
  }
  truckPose(x, z, q) {
    const sim = this.sim; let y = 0, n = 0;
    for (const w of TRUCK.WHEELS) { const g = frameToWorld([x, 0, z], q, w); y += sim.groundY(g[0], g[2]); n++; }
    return { p: [+x.toFixed(3), +(y / n).toFixed(3), +z.toFixed(3)], q };
  }
  /** Is a box of half sizes h, its middle cy above p, free of everything but the ground and chip piles? */
  clear(p, q, h, cy) {
    const sim = this.sim, R = sim.R, c = frameToWorld(p, q, [0, cy, 0]);
    let hit = false;
    sim.rapier.intersectionsWithShape({ x: c[0], y: c[1], z: c[2] }, { x: q[0], y: q[1], z: q[2], w: q[3] }, new R.Cuboid(h[0], h[1], h[2]), (col) => {
      if (col.handle === sim.groundCol.handle || col.isSensor() || sim.chipper.colPile.has(col.handle)) return true;
      hit = true; return false;
    });
    return !hit;
  }

  // ---- model -> physics ----
  onEvent(ev, info) {
    const w = this.sim.world, g = this.grab;
    if (ev.t === 'loader') { this.build(ev); return; }
    if (ev.t === 'reset') { this.destroy(); return; }
    if (!g) return;
    if (ev.t === 'split' && info.moved && info.oldPiece === g.piece && info.moved.includes(g.seg)) {
      // the held wood was sawn through: the claw holds on to the part between its jaws (taken again next tick,
      // once that part has a body)
      this.dropJoint(); this.regrab = g.seg;
    } else if (ev.t === 'chip' || ev.t === 'rmpiece' || ev.t === 'haul') {
      if (!w.pieces.has(g.piece)) { this.dropJoint(); this.grab = null; }
      else if (!w.segs.has(g.seg)) g.seg = w.segsOf(g.piece)[0].id;
    }
  }

  build(ev) {
    const sim = this.sim, R = sim.R, L = LOADER, M = CFG.LOADER_MASS;
    this.destroy();
    this.boom = Math.max(L.BOOM_MIN, Math.min(L.BOOM_MAX, this.boom));
    const body = sim.rapier.createRigidBody(sim.dynamic().setTranslation(ev.p[0], ev.p[1], ev.p[2])
      .setRotation({ x: ev.q[0], y: ev.q[1], z: ev.q[2], w: ev.q[3] }).setLinearDamping(0.05).setAngularDamping(0.3).setCanSleep(false));
    const add = (b, set, desc, c, mass, friction = 0.8) => {
      desc.setTranslation(c[0], c[1], c[2]).setMass(mass).setFriction(friction)
        .setActiveEvents(R.ActiveEvents.CONTACT_FORCE_EVENTS).setContactForceEventThreshold(300);
      if (friction === 0) desc.setFrictionCombineRule(R.CoefficientCombineRule.Min);
      set.add(sim.rapier.createCollider(desc, b).handle);
    };
    const box = (b, set, x, mass) => add(b, set, R.ColliderDesc.cuboid(x.h[0], x.h[1], x.h[2]), x.c, mass);
    box(body, this.cols, L.CHASSIS, M * 0.35);
    box(body, this.cols, L.WEIGHT, M * 0.45);
    box(body, this.cols, L.PLATFORM, M * 0.03);
    box(body, this.cols, L.POST, M * 0.01);
    for (const wh of L.WHEELS) add(body, this.cols, R.ColliderDesc.ball(L.WHEEL_R), wh, M * 0.04, 0);   // the tyres are tyres()
    this.body = body;
    // the grapple, hanging straight down from the boom tip
    const tip = frameToWorld(ev.p, ev.q, boomTip(this.boom));
    const gp = [tip[0] - L.LINK[0], tip[1] - L.LINK[1], tip[2] - L.LINK[2]], G = CFG.LOADER_GRAPPLE_MASS;
    const grapple = sim.rapier.createRigidBody(sim.dynamic().setTranslation(gp[0], gp[1], gp[2])
      .setRotation({ x: ev.q[0], y: ev.q[1], z: ev.q[2], w: ev.q[3] }).setLinearDamping(0.1).setAngularDamping(1.5).setCanSleep(false));
    box(grapple, this.gcols, L.HEAD, G * 0.7);
    for (const s of [1, -1]) box(grapple, this.gcols, { c: [L.TINE.c[0], L.TINE.c[1], s * L.TINE.c[2]], h: L.TINE.h }, G * 0.15);
    this.grapple = grapple;
    const t = boomTip(this.boom);
    this.link = sim.rapier.createImpulseJoint(R.JointData.spherical({ x: t[0], y: t[1], z: t[2] }, { x: L.LINK[0], y: L.LINK[1], z: L.LINK[2] }), body, grapple, true);
    this.link.setContactsEnabled(false);
    // the truck: a fixed body of boxes
    const T = TRUCK, tq = ev.truck.q;
    const tb = sim.rapier.createRigidBody(R.RigidBodyDesc.fixed().setTranslation(ev.truck.p[0], ev.truck.p[1], ev.truck.p[2]).setRotation({ x: tq[0], y: tq[1], z: tq[2], w: tq[3] }));
    for (const x of [T.FRAME, T.CAB, T.HOOD, T.FLOOR, T.HEADBOARD, T.TAILGATE, T.SIDE, { c: [T.SIDE.c[0], T.SIDE.c[1], -T.SIDE.c[2]], h: T.SIDE.h }]) {
      this.truckCols.add(sim.rapier.createCollider(R.ColliderDesc.cuboid(x.h[0], x.h[1], x.h[2]).setTranslation(x.c[0], x.c[1], x.c[2]).setFriction(0.7), tb).handle);
    }
    this.truck = { body: tb, p: ev.truck.p, q: tq };
    this.vStand = null; this.rest.clear();
  }

  /** Gone (a new tree, or before it is parked again): the driver gets off, the claw lets go, the bodies go. */
  destroy() {
    const sim = this.sim;
    const d = sim.players.list.get(this.driver);
    if (d && d.mode === MODE.DRIVE) sim.players.toGround(d);
    this.driver = -1;
    this.dropJoint(); this.grab = null; this.regrab = -1; this.closed = false;
    if (this.body) sim.rapier.removeRigidBody(this.body);
    if (this.grapple) sim.rapier.removeRigidBody(this.grapple);
    if (this.truck) sim.rapier.removeRigidBody(this.truck.body);
    this.body = this.grapple = this.link = this.truck = null;
    this.cols.clear(); this.gcols.clear(); this.truckCols.clear();
  }

  dropJoint() {
    if (this.grab && this.grab.joint) {
      const j = this.grab.joint; this.grab.joint = null;
      if (this.sim.rapier.getImpulseJoint(j.handle)) this.sim.rapier.removeImpulseJoint(j, true);
    }
  }

  // ---- frames ----
  toWorld(l, target = new THREE.Vector3(), b = this.body) {
    const t = b.translation(), r = b.rotation();
    return target.set(l[0], l[1], l[2]).applyQuaternion(_q.set(r.x, r.y, r.z, r.w)).add(_v.set(t.x, t.y, t.z));
  }
  dirToWorld(d, target = new THREE.Vector3(), b = this.body) {
    const r = b.rotation();
    return target.set(d[0], d[1], d[2]).applyQuaternion(_q.set(r.x, r.y, r.z, r.w));
  }
  toLocal(wp, b = this.body) {
    const t = b.translation(), r = b.rotation();
    const v = new THREE.Vector3(wp.x - t.x, wp.y - t.y, wp.z - t.z).applyQuaternion(_q.set(r.x, r.y, r.z, r.w).invert());
    return [v.x, v.y, v.z];
  }

  // ---- the driver ----
  /** What player p is looking at on the loader within reach: {point, dist} or null. */
  aim(p) {
    if (!this.body) return null;
    const sim = this.sim, { o, d } = sim.eye(p);
    const hit = sim.rapier.castRay(new sim.R.Ray(o, d), CFG.REACH, true, undefined, undefined, undefined, p.body);
    if (!hit || !(this.cols.has(hit.collider.handle) || this.gcols.has(hit.collider.handle))) return null;
    return { point: o.clone().addScaledVector(d, hit.timeOfImpact), dist: hit.timeOfImpact };
  }
  /** p steps up onto the platform and takes the controls. */
  mount(p) {
    const sim = this.sim;
    if (!this.body) return;
    if (p.inj >= INJ.HURT) { sim.players.say(p, 'Too hurt to drive'); return; }
    if (this.driver >= 0 && this.driver !== p.id && sim.players.list.get(this.driver)?.mode === MODE.DRIVE) {
      sim.players.say(p, `${sim.players.name(this.driver)} is driving the loader`); return;
    }
    sawOff(sim, p); p.grab = null; p.cl = null; p.lan = false; p.ride = null;
    p.mode = MODE.DRIVE; this.driver = p.id;
    p.body.setBodyType(sim.R.RigidBodyType.KinematicPositionBased, true);
    p.col.setSensor(true);                       // the driver goes with the loader and does not shove it
    const s = this.toWorld(LOADER.STAND, _a);
    p.body.setTranslation({ x: s.x, y: s.y, z: s.z }, true);
    this.vStand = null; this.ctrl = { thr: 0, steer: 0, boom: 0 };
    sim.toast('On the loader: {move} drives, {raise} and {throttle} work the boom, {interact} the claw, {jump} gets off', p.id);
  }
  /** The driver gets off (or is thrown off): put down on the ground behind it, moving as the platform was. */
  dismount(p, msg = '') {
    const sim = this.sim, pl = sim.players;
    if (p.mode !== MODE.DRIVE) return;
    let vel = { x: 0, y: 0, z: 0 }, c = null;
    if (this.body) {
      const s = this.toWorld(LOADER.STAND, _a), v = this.body.velocityAtPoint(s);
      vel = { x: v.x, y: v.y, z: v.z };
      const t = this.body.translation(), back = this.dirToWorld([-1, 0, 0], _b);
      c = pl.safeSpot(p, t.x, t.z, Math.atan2(back.z, back.x), 2.4);
    }
    pl.toGround(p, vel);
    if (c) p.body.setTranslation({ x: c[0], y: c[1], z: c[2] }, true);
    p.vPre.set(vel.x, vel.y, vel.z); p.hit = 0;
    if (msg) sim.toast(msg, p.id);
  }
  /** players.toGround on the driver (by any route): the loader has no driver now. */
  left(p) { if (this.driver === p.id) { this.driver = -1; this.ctrl = { thr: 0, steer: 0, boom: 0 }; } }

  /** The driver's controls, from players.prePlayer each tick (before pre). */
  drive(p, inp, dt, control, pressed) {
    const sim = this.sim;
    if (!this.body || this.driver !== p.id) { sim.players.toGround(p); return; }
    if (!control) { this.ctrl = { thr: 0, steer: 0, boom: 0 }; p.prompt = ''; return; }
    if (pressed.jump) { this.dismount(p); return; }
    this.ctrl = { thr: inp.my, steer: inp.mx, boom: (inp.lt || 0) - (inp.rt || 0) };
    if (pressed.interact) this.toggleClaw(p);
    const kg = this.grab ? sim.weightOf(this.grab.piece) : 0;
    const held = this.grab ? (isFinite(kg) ? ` {mass:${Math.round(kg)}}` : '') : '';
    p.prompt = (this.stall ? this.stall + '   ' : '') + '{move}: drive   {raise}: claw up   {throttle}: claw down   '
      + `{interact}: ${this.closed ? 'open claw' + held : 'close claw'}   {jump}: get off`;
  }

  toggleClaw(p) {
    if (this.closed) {
      this.closed = false;
      if (this.grab) { this.dropJoint(); this.grab = null; }
      return;
    }
    this.closed = true;
    const found = this.between();
    if (!found) return;
    const w = this.sim.world, s = w.segs.get(found.seg);
    if (w.pieces.get(s.piece).fixed) { this.sim.players.say(p, 'The claw cannot pull wood off the standing tree: saw it free first'); return; }
    this.attach(found.seg);
    this.sim.awards.touch(s.piece, p.id);
  }

  /** The loose wood between the jaws: the segment whose bark comes nearest the middle of them, within reach of the tines. */
  between() {
    const sim = this.sim, w = sim.world, J = this.toWorld(LOADER.JAW, new THREE.Vector3(), this.grapple);
    let best = null, bd = Infinity;
    for (const s of w.segs.values()) {
      if (!sim.segCol.has(s.id)) continue;
      const A = sim.segToWorld(s, s.a, _a), B = sim.segToWorld(s, s.b, _b);
      const dx = B.x - A.x, dy = B.y - A.y, dz = B.z - A.z, L2 = dx * dx + dy * dy + dz * dz || 1;
      const t = Math.max(0, Math.min(1, ((J.x - A.x) * dx + (J.y - A.y) * dy + (J.z - A.z) * dz) / L2));
      const r = segRadius(s, t), d = Math.hypot(A.x + dx * t - J.x, A.y + dy * t - J.y, A.z + dz * t - J.z);
      if (r > LOADER.JAW_R) continue;
      const gap = d - r;                          // from the jaws' middle to the bark (< 0: inside the wood)
      if (gap < CFG.LOADER_JAW_REACH && gap < bd) { bd = gap; best = { seg: s.id }; }
    }
    return best;
  }

  /** The claw takes hold of segment seg's piece where it is now (a fixed joint, so nothing jumps). */
  attach(segId) {
    const sim = this.sim, R = sim.R, s = sim.world.segs.get(segId); if (!s) return;
    const pb = sim.bodies.get(s.piece); if (!pb || sim.world.pieces.get(s.piece).fixed) return;
    const J = this.toWorld(LOADER.JAW, new THREE.Vector3(), this.grapple), a2 = this.toLocal(J, pb);
    const gr = this.grapple.rotation(), pr = pb.rotation();
    const qg = new THREE.Quaternion(gr.x, gr.y, gr.z, gr.w), qp = new THREE.Quaternion(pr.x, pr.y, pr.z, pr.w);
    const f2 = qp.invert().multiply(qg);           // the piece's frame to the grapple's, as they are now
    const data = R.JointData.fixed({ x: LOADER.JAW[0], y: LOADER.JAW[1], z: LOADER.JAW[2] }, { x: 0, y: 0, z: 0, w: 1 },
      { x: a2[0], y: a2[1], z: a2[2] }, { x: f2.x, y: f2.y, z: f2.z, w: f2.w });
    const joint = sim.rapier.createImpulseJoint(data, this.grapple, pb, true);
    joint.setContactsEnabled(false);
    this.grab = { piece: s.piece, seg: segId, joint };
  }

  // ---- each tick, before physics ----
  pre(dt) {
    if (!this.body) return;
    const sim = this.sim, L = LOADER;
    if (this.regrab >= 0) {
      const seg = this.regrab; this.regrab = -1; this.grab = null;
      if (this.closed && sim.world.segs.has(seg)) this.attach(seg);
    }
    const d = sim.players.list.get(this.driver);
    if (!d || d.mode !== MODE.DRIVE) { this.driver = -1; this.ctrl = { thr: 0, steer: 0, boom: 0 }; }
    const c = this.ctrl;
    // steering: the front wheels turn toward where the stick says, at LOADER_STEER_RATE
    const st = c.steer * CFG.LOADER_STEER, ds = CFG.LOADER_STEER_RATE * dt;
    this.steer += Math.max(-ds, Math.min(ds, st - this.steer));
    this.tyres(dt, c.thr);
    // the boom
    this.stall = '';
    const rate = Math.max(-1, Math.min(1, c.boom)) * CFG.LOADER_BOOM_RATE;
    if (Math.abs(rate) > 1e-4) {
      let ok = true;
      if (rate > 0) {
        const held = this.grab ? sim.weightOf(this.grab.piece) : 0;
        const tip = this.toWorld(boomTip(this.boom), _a), piv = this.toWorld(L.PIVOT, _b);
        const need = (held + this.grapple.mass()) * CFG.GRAVITY * Math.hypot(tip.x - piv.x, tip.z - piv.z);
        if (!isFinite(held)) { ok = false; this.stall = 'The claw holds wood still joined to the tree'; }
        else if (need > CFG.LOADER_BOOM_T) { ok = false; this.stall = 'Too heavy to lift this far out: bring the boom in or saw it smaller'; }
        else if (this.lift.rear === 0 && this.grab) { ok = false; this.stall = 'The loader is tipping: lower the load'; }
      } else if (this.lift.front === 0) { ok = false; this.stall = 'The claw is pushing the loader up'; }
      if (ok) this.boom = Math.max(L.BOOM_MIN, Math.min(L.BOOM_MAX, this.boom + rate * dt));
      const t = boomTip(this.boom);
      this.link.setAnchor1({ x: t[0], y: t[1], z: t[2] });
    }
    this.rotator(dt);
    this.swingBrake(dt);
    // the driver rides on the platform (kinematic: where it will be at the end of this step)
    if (d && d.mode === MODE.DRIVE) {
      const s = this.toWorld(L.STAND, _a), v = this.body.velocityAtPoint(s);
      d.body.setNextKinematicTranslation({ x: s.x + v.x * dt, y: s.y + v.y * dt, z: s.z + v.z * dt });
    }
  }

  /**
   * The tyres (as the chipper's, sim/chipper.js): at each wheel that touches the ground an impulse across it that
   * stops it sliding sideways (up to LOADER_GRIP x its share of the weight), and one along it toward the drive's
   * speed (throttle x LOADER_SPEED; with no throttle, toward standing still: the brakes), up to the same grip and
   * LOADER_DRIVE_F shared out. Solved together in a few passes, each kept within its cap.
   */
  tyres(dt, thr) {
    const sim = this.sim, b = this.body, L = LOADER, g = CFG.GRAVITY;
    const pts = [];
    let front = 0, rear = 0;
    L.WHEELS.forEach((w, i) => {
      const P = this.toWorld([w[0], w[1] - L.WHEEL_R, w[2]], new THREE.Vector3());
      const on = P.y - sim.groundY(P.x, P.z) < 0.1;
      if (on) { pts.push({ P, i }); if (i < 2) front++; else rear++; }
    });
    this.lift = { front, rear };
    if (!pts.length) return;
    const held = this.grab ? (sim.bodies.get(this.grab.piece)?.mass() || 0) : 0;
    const N = (b.mass() + this.grapple.mass() + held) * g / pts.length;
    const drive = Math.abs(thr) > 0.05, vt = thr * CFG.LOADER_SPEED;
    const grips = [];
    for (const { P, i } of pts) {
      const n0 = sim.groundN(P.x, P.z), n = new THREE.Vector3(n0[0], n0[1], n0[2]);
      const a = i < 2 ? this.steer : 0;
      const h = this.dirToWorld([Math.cos(a), 0, Math.sin(a)], new THREE.Vector3()), l = this.dirToWorld([-Math.sin(a), 0, Math.cos(a)], new THREE.Vector3());
      h.addScaledVector(n, -h.dot(n)).normalize(); l.addScaledVector(n, -l.dot(n)).normalize();
      const grip = CFG.LOADER_GRIP * N * dt;
      grips.push({ P, d: l, cap: grip, v: 0, J: 0 });
      grips.push({ P, d: h, cap: drive ? Math.min(grip, CFG.LOADER_DRIVE_F / pts.length * dt) : CFG.LOADER_BRAKE * N * dt, v: drive ? vt : 0, J: 0 });
    }
    for (const G of grips) G.m = effMass(b, G.P, G.d);
    for (let pass = 0; pass < 4; pass++) {
      for (const G of grips) {
        const v = b.velocityAtPoint(G.P), d = G.d, vn = v.x * d.x + v.y * d.y + v.z * d.z - g * d.y * dt - G.v;
        const J = Math.max(-G.cap, Math.min(G.cap, G.J - vn * G.m)), dJ = J - G.J;
        G.J = J;
        if (dJ) b.applyImpulseAtPoint({ x: d.x * dJ, y: d.y * dJ, z: d.z * dJ }, G.P, true);
      }
    }
  }

  /** The rotator: turns the grapple about the vertical to sit square to the loader (a damped spring, capped). */
  rotator(dt) {
    const gb = this.grapple, b = this.body;
    const gz = this.dirToWorld([0, 0, 1], _a, gb), lz = this.dirToWorld([0, 0, 1], _b, b);
    const err = Math.atan2(lz.z * gz.x - lz.x * gz.z, gz.x * lz.x + gz.z * lz.z);   // how far the grapple is turned from the loader, about +y
    // (a log held end-on is as good as across: the nearer of the two ways is held)
    const e = err > Math.PI / 2 ? err - Math.PI : err < -Math.PI / 2 ? err + Math.PI : err;
    const wg = gb.angvel().y, wl = b.angvel().y, K = CFG.LOADER_ROTATOR_K;
    const ie = gb.effectiveWorldInvInertia().elements, inv = ie[3];       // about the vertical (row y, column y)
    const acc = -K * e - 2 * Math.sqrt(K) * (wg - wl);
    const T = Math.max(-CFG.LOADER_ROTATOR_T, Math.min(CFG.LOADER_ROTATOR_T, acc / Math.max(1e-6, inv)));
    gb.applyTorqueImpulse({ x: 0, y: T * dt, z: 0 }, true);
    b.applyTorqueImpulse({ x: 0, y: -T * dt, z: 0 }, true);
  }

  /**
   * The swing brake: the claw and what it holds swing on the link at the boom tip, and a brake there slows the
   * swinging: a force on the claw against how fast it moves across under the tip (relative to the loader there),
   * LOADER_SWING_DAMP per second of that speed for the claw and its load, and the same back on the loader.
   */
  swingBrake(dt) {
    const sim = this.sim, gb = this.grapple, b = this.body, k = CFG.LOADER_SWING_DAMP; if (!(k > 0)) return;
    const tip = this.toWorld(boomTip(this.boom), _a), vt = b.velocityAtPoint(tip), J = this.toWorld(LOADER.JAW, _b, gb), vj = gb.velocityAtPoint(J);
    const held = this.grab ? (sim.bodies.get(this.grab.piece)?.mass() || 0) : 0, m = gb.mass() + held;
    // across: the part of the relative velocity at right angles to the link (along it, the joint does the work)
    const lx = J.x - tip.x, ly = J.y - tip.y, lz = J.z - tip.z, ll = Math.hypot(lx, ly, lz) || 1;
    let rx = vj.x - vt.x, ry = vj.y - vt.y, rz = vj.z - vt.z;
    const along = (rx * lx + ry * ly + rz * lz) / ll; rx -= along * lx / ll; ry -= along * ly / ll; rz -= along * lz / ll;
    const f = Math.min(1, k * dt) * m;                 // impulse per m/s: at most what stops it this tick
    const ix = -rx * f, iy = -ry * f, iz = -rz * f;
    gb.applyImpulseAtPoint({ x: ix, y: iy, z: iz }, J, true);
    b.applyImpulseAtPoint({ x: -ix, y: -iy, z: -iz }, tip, true);
  }

  // ---- after physics ----
  post(dt) {
    if (!this.body) return;
    const sim = this.sim, d = sim.players.list.get(this.driver);
    if (d && d.mode === MODE.DRIVE) {
      // jolts on the platform hurt as any impact does; on its side, or hurt, the driver comes off
      const s = this.toWorld(LOADER.STAND, _a), v = this.body.velocityAtPoint(s), vx = v.x, vy = v.y, vz = v.z;
      if (this.vStand) {
        const dv = Math.hypot(vx - this.vStand[0], vy - this.vStand[1], vz - this.vStand[2]);
        if (dv > CFG.DV_SHAKEN) sim.players.impact(d, dv);
      }
      this.vStand = [vx, vy, vz];
      const up = this.dirToWorld([0, 1, 0], _b);
      if (d.mode === MODE.DRIVE && up.y < 0.4) this.dismount(d, 'The loader went over: you jumped off');
      else if (d.mode === MODE.DRIVE && d.inj >= INJ.HURT) this.dismount(d, 'Thrown off the loader');
      else if (d.mode === MODE.DRIVE) d.vPre.set(vx, vy, vz);
    } else this.vStand = null;
    if (sim.tick % 10 === 0) this.haulCheck(10 * dt);
  }

  /** Loose wood lying still in the truck's bed for TRUCK_TAKE_T is hauled away. */
  haulCheck(dt) {
    const sim = this.sim, w = sim.world, T = this.truck; if (!T) return;
    const seen = new Set();
    for (const [id, b] of sim.bodies) {
      const pc = w.pieces.get(id); if (!pc || pc.fixed) continue;
      if (this.grab && this.grab.piece === id) continue;
      const c = b.worldCom(), l = worldToFrame(T.p, T.q, [c.x, c.y, c.z]);
      if (!inBed(l)) continue;
      const v = b.linvel();
      if (Math.hypot(v.x, v.y, v.z) > CFG.TRUCK_REST_V || !isFinite(sim.weightOf(id))) continue;
      seen.add(id);
      const t = (this.rest.get(id) || 0) + dt;
      if (t < CFG.TRUCK_TAKE_T) { this.rest.set(id, t); continue; }
      this.rest.delete(id);
      const kg = b.mass();
      sim.emit({ t: 'haul', piece: id });
      sim.toast(`A log went on the truck: {mass:${Math.round(kg)}}`);
    }
    for (const id of [...this.rest.keys()]) if (!seen.has(id)) this.rest.delete(id);
  }

  // ---- outputs ----
  /** Is collider h the loader or its grapple (heavy: it breaks fences and cracks pavers as the chipper does)? */
  solid(h) { return this.cols.has(h) || this.gcols.has(h); }
  eachRigid(fn) { if (this.body) { fn(this.body); fn(this.grapple); } }
  eachBody(fn) {
    if (!this.body) return;
    fn(LOADER_BODY_ID, this.body.translation(), this.body.rotation(), true);
    fn(GRAPPLE_BODY_ID, this.grapple.translation(), this.grapple.rotation(), true);
  }
  bodyOf(id) { return id === LOADER_BODY_ID ? this.body : id === GRAPPLE_BODY_ID ? this.grapple : null; }
  /** aux.ld: [claw shut 1/0, front wheels' steer (rad), boom angle (rad), driver id] or 0 with no loader. */
  aux() { return this.body ? [this.closed ? 1 : 0, +this.steer.toFixed(3), +this.boom.toFixed(4), this.driver] : 0; }
}
