// Host only: the grapple loader and the log truck (model/loader.js has their shapes).
//
// The loader is a skid steer: a heavy dynamic body on four frictionless wheel balls; the tyres are modelled here as
// the chipper's are (sim/chipper.js). The wheels do not steer: each side drives toward its own speed (throttle,
// plus or minus the turn), up to LOADER_GRIP x its share of the weight and LOADER_DRIVE_F between them, and grips
// sideways only up to LOADER_SKID x that weight, so a turn skids it round. Only the loader is physical.
//
// The claw does not follow physics rules (D130): what it holds is moved by animation. One button, two motions:
// grab and lift (the claw closes on the wood between its jaws, the wood is drawn square into them, and the arms
// lift it overhead), and let go and lower (the claw opens overhead, the wood drops, the arms come down). While
// held, the wood is a kinematic body carried at the jaws, and touches nothing of the loader; its weight is not on
// the loader. Three kinds of wood do not go up:
//   - lighter than LOADER_LIGHT x CHIP_CAPACITY (chipper wood): it slips through the claw halfway up, and falls;
//   - longer than LOADER_MAX_LEN (8 ft), or the standing tree: too heavy. The wood stays where it is (held still)
//     and the claw is pinned to it there (a ball joint), so the arms lifting tip the loader forward on its front
//     wheels. Once it has tipped LOADER_TIP (or the arms are up), it holds for LOADER_TIP_HOLD, lets go and lowers,
//     and the loader drops back onto its wheels under its own weight;
//   - wood still joined to the tree by fibres: the claw does not close (saw it free first).
// A utility pole in the jaws (D141): the claw tears a length of it out (LOADER_POLE_LEN, from the jaws' height, never
// lower than 0.3 m off the ground): two clean breaks, the pole above it comes down (with its lines), the grounded
// stub stays, and the claw carries the length. A dormant pole or yard tree in the jaws is woken into wood first.
// With no wood in its jaws it takes the other things that stand there (D140): a chipper, a chip bin, a player or a
// G.O.E. They are carried the same way (a kinematic body, standing on the fork as they stood), whatever they weigh,
// and come to no harm from it: a chipper held, or just put down, does not crumple, and a player or G.O.E. feels
// nothing of the ride or of the fall out of the claw (LOADER_SOFT_T after it lets go).
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
import { SHAPE as CHIP } from '../model/chipper.js';
import { BIN } from '../model/bin.js';
import { segRadius } from '../model/world.js';
import { LOADER, TRUCK, LOADER_BODY_ID, jawAt, frameToWorld, worldToFrame, inBed } from '../model/loader.js';
import { effMass } from './chipper.js';
import { sawOff } from './saw.js';

const _q = new THREE.Quaternion(), _v = new THREE.Vector3(), _a = new THREE.Vector3(), _b = new THREE.Vector3();
const yawQ = (a) => [0, Math.sin(a / 2), 0, Math.cos(a / 2)];
const smooth = (k) => k * k * (3 - 2 * k);

// Rapier collision groups (memberships in the high 16 bits, filter in the low 16; ground.js uses bits 0 and up).
// The loader is in group 15; wood in the claw (and on its way out of it) is not, and does not meet it.
const LOADER_G = (0x8000 << 16) | 0xffff;
const HELD_G = (0x7fff << 16) | 0x7fff;
const ALL = 0xffffffff;

// what the arms and claw are doing
const IDLE = 'down', GRAB = 'grab', LIFT = 'lift', UP = 'up', DROP = 'drop', LOWER = 'lower', TIP = 'tip';
const PHASE_CODE = { down: 0, grab: 1, lift: 2, up: 3, drop: 4, lower: 5, tip: 6 };

export class Loader {
  constructor(sim) {
    this.sim = sim;
    this.body = null; this.cols = new Set();
    this.truck = null; this.truckCols = new Set();
    this.arm = LOADER.ARM_MIN; this.jaw = 0; this.phase = IDLE; this.phaseT = 0;
    this.hold = null;                 // {piece, kind: 'carry'|'light'|'pin', ...}: what the claw has
    this.through = new Map();         // piece id -> s: wood dropped from the claw, not meeting the loader yet
    this.thru = [];                   // things dropped from the claw, not meeting it yet: {body, cols, r, t}
    this.driver = -1;
    this.lastDriver = -1;             // who drove it last (blamed for what it breaks: awards.culprit)
    this.ctrl = { thr: 0, turn: 0 };
    this.note = '';                   // a word for the driver about the last grab ('' for none)
    this.rest = new Map();            // piece id -> s it has lain still in the truck's bed
    this.vStand = null;               // the platform's velocity last tick (the driver's jolts)
  }

  // ---- parking: with every new tree, in the street in front of the job's lot ----
  /** The loader and the truck; returns where the chipper parks ({x, z, yaw}, chipper.place), or undefined. */
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
    // the chipper (and its bin, by it) parks in the street too (owner, 2026-11-28): along the kerb on the lot's side,
    // behind the loader clear of the way it drives out, its chute toward the lot; else past the truck's cab
    const cz = kerb + f * 1.6, cyaw = f > 0 ? Math.PI : 0, cq = yawQ(cyaw), T0 = pick.T.p[0], L0 = pick.L.p[0];
    const xs = []; for (let i = 0; i < 5; i++) xs.push(L0 - 4.2 - i * 1.5);
    for (let i = 0; i < 5; i++) xs.push(T0 + TRUCK.HL + 3.2 + i * 1.5);
    for (const x of xs) if (this.clear([x, sim.groundY(x, cz), cz], cq, [2.7, 1.0, 1.1], 1.0)) return { x, z: cz, yaw: cyaw };
    return { x: xs[0], z: cz, yaw: cyaw, bad: true };
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
    const w = this.sim.world, h = this.hold;
    if (ev.t === 'loader') { this.build(ev); return; }
    if (ev.t === 'reset') { this.destroy(); return; }
    if (h && ev.t === 'split' && info.oldPiece === h.piece) {
      // the held wood was sawn through: the claw lets go of all of it (the parts fall)
      this.release(false);
      if (this.phase === GRAB || this.phase === LIFT || this.phase === UP || this.phase === TIP) this.setPhase(DROP);
    } else if (ev.t === 'chip' || ev.t === 'rmpiece' || ev.t === 'haul') {
      if (h && !h.thing && !w.pieces.has(h.piece)) { if (h.joint) this.dropJoint(); this.hold = null; }
      for (const id of [...this.through.keys()]) if (!w.pieces.has(id)) this.through.delete(id);
    }
  }

  build(ev) {
    const sim = this.sim, R = sim.R, L = LOADER, M = CFG.LOADER_MASS;
    this.destroy();
    const body = sim.rapier.createRigidBody(sim.dynamic().setTranslation(ev.p[0], ev.p[1], ev.p[2])
      .setRotation({ x: ev.q[0], y: ev.q[1], z: ev.q[2], w: ev.q[3] }).setLinearDamping(0.05).setAngularDamping(0.3).setCanSleep(false));
    const add = (desc, c, mass, friction = 0.8) => {
      desc.setTranslation(c[0], c[1], c[2]).setMass(mass).setFriction(friction).setCollisionGroups(LOADER_G)
        .setActiveEvents(R.ActiveEvents.CONTACT_FORCE_EVENTS).setContactForceEventThreshold(300);
      if (friction === 0) desc.setFrictionCombineRule(R.CoefficientCombineRule.Min);
      this.cols.add(sim.rapier.createCollider(desc, body).handle);
    };
    const box = (x, mass) => add(R.ColliderDesc.cuboid(x.h[0], x.h[1], x.h[2]), x.c, mass);
    box(L.CHASSIS, M * 0.4);
    box(L.WEIGHT, M * 0.4);
    box(L.PLATFORM, M * 0.03);
    box(L.POST, M * 0.01);
    for (const wh of L.WHEELS) add(R.ColliderDesc.ball(L.WHEEL_R), wh, M * 0.04, 0);   // the tyres are tyres()
    this.body = body;
    // the truck: a fixed body of boxes
    const T = TRUCK, tq = ev.truck.q;
    const tb = sim.rapier.createRigidBody(R.RigidBodyDesc.fixed().setTranslation(ev.truck.p[0], ev.truck.p[1], ev.truck.p[2]).setRotation({ x: tq[0], y: tq[1], z: tq[2], w: tq[3] }));
    for (const x of [T.FRAME, T.CAB, T.HOOD, T.FLOOR, T.HEADBOARD, T.TAILGATE, T.SIDE, { c: [T.SIDE.c[0], T.SIDE.c[1], -T.SIDE.c[2]], h: T.SIDE.h }]) {
      this.truckCols.add(sim.rapier.createCollider(R.ColliderDesc.cuboid(x.h[0], x.h[1], x.h[2]).setTranslation(x.c[0], x.c[1], x.c[2]).setFriction(0.7), tb).handle);
    }
    this.truck = { body: tb, p: ev.truck.p, q: tq };
    sim.goe.onTruck(tb);              // the G.O.E.s still racked on it (sim/goe.js, D134)
    this.vStand = null; this.rest.clear(); this.lastDriver = -1;
    this.arm = Math.max(L.ARM_MIN, Math.min(L.ARM_MAX, this.arm));
    this.jaw = 0; this.phase = this.arm > L.ARM_MIN + 1e-3 ? LOWER : IDLE; this.phaseT = 0;
  }

  /** Gone (a new tree, or before it is parked again): the driver gets off, the claw lets go, the bodies go. */
  destroy() {
    const sim = this.sim;
    const d = sim.players.list.get(this.driver);
    if (d && d.mode === MODE.DRIVE) sim.players.toGround(d);
    this.driver = -1;
    if (this.hold) this.release(false);
    for (const id of this.through.keys()) this.groups(id, ALL);
    this.through.clear();
    for (const o of this.thru) this.restore(o.cols);
    this.thru = [];
    if (this.body) sim.rapier.removeRigidBody(this.body);
    if (this.truck) { sim.rapier.removeRigidBody(this.truck.body); sim.goe.offTruck(); }
    this.body = this.truck = null;
    this.cols.clear(); this.truckCols.clear();
  }

  dropJoint() {
    const h = this.hold;
    if (h && h.joint) {
      const j = h.joint; h.joint = null;
      if (this.sim.rapier.getImpulseJoint(j.handle)) this.sim.rapier.removeImpulseJoint(j, true);
    }
  }

  /** Every collider of piece id into collision groups g. */
  groups(id, g) {
    const sim = this.sim;
    for (const s of sim.world.segsOf(id)) sim.segCol.get(s.id)?.setCollisionGroups(g);
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
  quat(b = this.body) { const r = b.rotation(); return new THREE.Quaternion(r.x, r.y, r.z, r.w); }

  // ---- the driver ----
  /** What player p is looking at on the loader within reach: {point, dist} or null. */
  aim(p) {
    if (!this.body) return null;
    const sim = this.sim, { o, d } = sim.eye(p);
    const hit = sim.rapier.castRay(new sim.R.Ray(o, d), CFG.REACH, true, undefined, undefined, undefined, p.body);
    if (!hit || !this.cols.has(hit.collider.handle)) return null;
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
    p.mode = MODE.DRIVE; this.driver = p.id; this.lastDriver = p.id;
    p.body.setBodyType(sim.R.RigidBodyType.KinematicPositionBased, true);
    p.col.setSensor(true);                       // the driver goes with the loader and does not shove it
    const s = this.toWorld(LOADER.STAND, _a);
    p.body.setTranslation({ x: s.x, y: s.y, z: s.z }, true);
    this.vStand = null; this.ctrl = { thr: 0, turn: 0 };
    sim.toast('On the loader: {move} drives, {interact} grabs and lifts, then lets go and lowers, {jump} gets off', p.id);
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
  left(p) { if (this.driver === p.id) { this.driver = -1; this.ctrl = { thr: 0, turn: 0 }; } }

  /** The driver's controls, from players.prePlayer each tick (before pre). */
  drive(p, inp, dt, control, pressed) {
    const sim = this.sim;
    if (!this.body || this.driver !== p.id) { sim.players.toGround(p); return; }
    if (!control) { this.ctrl = { thr: 0, turn: 0 }; p.prompt = ''; return; }
    if (pressed.jump) { this.dismount(p); return; }
    this.ctrl = { thr: inp.my, turn: inp.mx };
    if (pressed.interact) this.toggle(p);
    // the one button goes the other way at any time: up (grab and lift) or down (let go and lower)
    const up = this.goingUp(), h = this.hold;
    let act;
    if (up) act = h && h.thing ? `{interact}: put ${h.thing.name} down` : `{interact}: let go and lower${h && h.kind === 'carry' ? ` {mass:${Math.round(h.kg)}}` : ''}`;
    else {
      // what closing now would take: said before you press, so you know when the wood (or the thing) is in the jaws
      const f = this.between(), th = !f || f.thick ? this.thingAt() : null;
      const sd = !f && !th ? this.standAt() : null;
      act = th ? `{interact}: pick up ${th.name} {mass:${Math.round(th.kg)}}`
        : sd !== null ? (sim.world.stands.list[sd].k === 1 ? '{interact}: tear out a length of the pole' : '{interact}: grab (the standing tree)')
        : !f ? '{interact}: lift (nothing in the claw)'
        : f.thick ? '{interact}: lift (too thick for the claw)'
        : !isFinite(f.kg) ? (this.stumpPrompt(f.seg))
        : `{interact}: grab and lift {mass:${Math.round(f.kg)}}`;
    }
    p.prompt = (this.note ? this.note + '   ' : '') + `{move}: drive   ${act}   {jump}: get off`;
  }

  /** What the button does for wood of the standing tree in the jaws. */
  stumpPrompt(seg) {
    const w = this.sim.world, s = w.segs.get(seg), pc = s && w.pieces.get(s.piece);
    if (!pc || !pc.fixed) return '{interact}: grab (still joined to the tree)';
    const st = this.stump(s.piece);
    if (!st && s.pl) return '{interact}: tear out a length of the pole';
    return !st ? '{interact}: grab (the standing tree)' : st.why ? `{interact}: grab (${st.why.split(':')[0].toLowerCase()})` : '{interact}: rip out the stump';
  }

  /** Are the arms on their way up, or up (closing, lifting, holding overhead, straining)? */
  goingUp() { return this.phase === GRAB || this.phase === LIFT || this.phase === UP || this.phase === TIP; }

  /**
   * The one button: it turns the motion round at once, whatever it is doing. Going up (closing, lifting, up,
   * straining): the claw opens, lets go, and the arms come down. Going down, or down: the claw closes on what is
   * between its jaws there and the arms go up.
   */
  toggle(p) {
    const sim = this.sim, w = sim.world;
    if (this.goingUp()) { if (this.hold && this.hold.kind !== 'pin') this.release(); this.setPhase(DROP); return; }
    this.note = '';
    if (this.hold) this.release();
    let found = this.between();
    const th = !found || found.thick ? this.thingAt() : null;
    if (!found && !th) {                               // a dormant pole or yard tree in the jaws: its wood grows, then as below
      const sd = this.standAt();
      if (sd !== null) { sim.stands.wake(sd); found = this.between(); }
    }
    if (th) { this.takeThing(th, p); this.setPhase(GRAB); return; }   // a chipper, a bin, a player or a G.O.E.
    if (!found || found.thick) {
      if (found) this.note = 'Too thick for the claw';
      this.setPhase(GRAB); return;                     // nothing it can hold there: the motion, empty
    }
    const s = w.segs.get(found.seg), piece = w.pieces.get(s.piece), body = sim.bodies.get(s.piece);
    if (!body) { this.setPhase(GRAB); return; }
    const kg = found.kg;
    if (!piece.fixed && !isFinite(kg)) { sim.players.say(p, 'Still joined to the tree: saw it free first'); return; }
    if (piece.fixed) {
      const st = this.stump(s.piece);
      if (st && !st.why) {                           // a short stump: out it comes, roots and all
        const np = this.uproot(s.piece, st);
        sim.awards.touch(np, p.id);
        this.take(np, sim.bodies.get(np), sim.weightOf(np), 'carry', true);
        this.note = 'Stump out, roots and all';
        this.setPhase(GRAB); return;
      }
      if (st && st.why) { sim.players.say(p, st.why); return; }
      if (!st && s.pl) { if (this.tearPole(s, p)) return; }   // a utility pole: a length of it comes out
    }
    sim.awards.touch(s.piece, p.id);
    const len = piece.fixed ? Infinity : this.lengthOf(s.piece);
    if (!piece.fixed && kg < CFG.LOADER_LIGHT * CFG.CHIP_CAPACITY) this.take(s.piece, body, kg, 'light');
    else if (len > CFG.LOADER_MAX_LEN) this.pin(s.piece, body, kg, piece.fixed);
    else this.take(s.piece, body, kg, 'carry');
    this.setPhase(GRAB);
  }
  setPhase(ph) { this.phase = ph; this.phaseT = 0; }

  /** The dormant stand (pole or yard tree, sim/stands.js) in the open jaws: its index, or null. */
  standAt() {
    const sim = this.sim, st = sim.stands; if (!this.body || !st.colStand.size) return null;
    const R = sim.R, J = this.toWorld(jawAt(this.arm), new THREE.Vector3());
    const q = this.quat().multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2));
    let out = null;
    sim.rapier.intersectionsWithShape({ x: J.x, y: J.y, z: J.z }, { x: q.x, y: q.y, z: q.z, w: q.w }, new R.Capsule(LOADER.JAW_W, CFG.LOADER_JAW_REACH), (col) => {
      const i = st.colStand.get(col.handle); if (i === undefined) return true;
      out = i; return false;
    }, undefined, undefined, undefined, this.body);
    return out;
  }

  /**
   * The claw closes on standing pole s (a segment of its trunk): a length LOADER_POLE_LEN is torn out of it at the
   * jaws (its bottom no lower than 0.3 m off the ground). Two clean breaks ('split'): the pole above comes free
   * and falls, the grounded stub stays, and the length between is carried as any wood. False if there is not
   * that much pole above the jaws to tear (the claw then pins, as on the standing tree).
   */
  tearPole(s, p) {
    const sim = this.sim, w = sim.world, id = s.piece, LEN = CFG.LOADER_POLE_LEN;
    // the trunk, from its base up (the arm and braces branch off it)
    const chain = []; let g = [...w.segsOf(id)].find((x) => x.parent < 0 && x.pl);
    while (g) {
      chain.push(g.id);
      const b = g.b; g = w.kids(g.id).map((k) => w.segs.get(k)).find((k) => k && Math.abs(k.a[1] - b[1]) < 1e-6 && Math.hypot(k.b[0] - k.a[0], k.b[2] - k.a[2]) < 0.2 * (k.b[1] - k.a[1]));
    }
    if (!chain.length) return false;
    const base = w.segs.get(chain[0]).a[1], top = w.segs.get(chain[chain.length - 1]).b[1];
    const J = this.toWorld(jawAt(this.arm), new THREE.Vector3());
    const y0 = Math.max(base + 0.3, J.y - LEN / 2), y1 = y0 + LEN;
    if (y1 > top - 0.3) return false;
    const cut = (y) => {
      for (const sid of chain) {
        const c = w.segs.get(sid); if (!c || c.piece !== id || !(c.a[1] <= y && y < c.b[1])) continue;
        const np = w.newId(), at = Math.max(0.02, Math.min(0.98, (y - c.a[1]) / (c.b[1] - c.a[1])));
        sim.emit({ t: 'split', seg: c.id, at, newSeg: w.newId(), newPiece: np });
        return np;
      }
      return null;
    };
    const up = cut(y1), mid = up !== null ? cut(y0) : null;
    if (up !== null) sim.awards.touch(up, p.id);
    if (mid === null) return up !== null;
    sim.awards.touch(mid, p.id);
    this.take(mid, sim.bodies.get(mid), sim.weightOf(mid), 'carry');   // (whatever it weighs: it is the length torn out)
    this.note = 'Tore a length out of the pole';
    this.setPhase(GRAB);
    return true;
  }

  // ---- things in the claw (D140): a chipper, a chip bin, a player or a G.O.E. ----
  /**
   * What thing stands in the open jaws (their line, LOADER_JAW_REACH round it): the nearest of a chipper (not a
   * wreck), a chip bin, and a player or G.O.E. on the ground (not the driver). {kind, key, body, bodies, name, kg,
   * hx, base} (hx: its half sizes in its own frame, base: its centre of mass above the bottom it stands on), or null.
   */
  thingAt() {
    if (!this.body) return null;
    const sim = this.sim, R = sim.R, j = jawAt(this.arm), J = this.toWorld(j, new THREE.Vector3());
    const q = this.quat().multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2));
    const shape = new R.Capsule(LOADER.JAW_W, CFG.LOADER_JAW_REACH);
    let best = null, bd = Infinity;
    sim.rapier.intersectionsWithShape({ x: J.x, y: J.y, z: J.z }, { x: q.x, y: q.y, z: q.z, w: q.w }, shape, (col) => {
      const t = this.thingOf(col.handle);
      if (t) { const c = t.body.worldCom(), d = Math.hypot(c.x - J.x, c.y - J.y, c.z - J.z); if (d < bd) { bd = d; best = t; } }
      return true;
    }, undefined, undefined, undefined, this.body);
    return best;
  }
  thingOf(h) {
    const sim = this.sim, pid = sim.colPlayer.get(h);
    if (pid !== undefined) {
      const p = sim.players.list.get(pid);
      if (!p || p.mode !== MODE.GROUND || p.id === this.driver) return null;
      const r = CFG.P_RADIUS;
      return { kind: 'player', key: p.id, body: p.body, bodies: [p.body], name: sim.players.name(p.id), kg: p.body.mass(), hx: [r, CFG.P_HALF + r, r], base: CFG.P_HALF + r };
    }
    const u = sim.chipper.units.find((x) => x && x.body && x.cols.has(h));
    if (u) return { kind: 'chipper', key: u.k, body: u.body, bodies: [u.body], name: 'the chipper', kg: u.body.mass(), hx: CHIP.CHASSIS.h, base: CHIP.BODY_Y - u.body.localCom().y };
    const bc = sim.bins.colOf.get(h), b = bc && sim.bins.units[bc.k];
    if (b && b.body) return { kind: 'bin', key: bc.k, body: b.body, bodies: [b.body, b.lid], name: 'the chip bin', kg: b.body.mass() + b.lid.mass(), hx: BIN.BODY.h, base: BIN.BODY_Y - b.body.localCom().y };
    return null;
  }
  /** Is the thing t still there, the same body (not rebuilt by a new tree, not left the game, not wrecked)? */
  alive(t) {
    const sim = this.sim;
    if (t.kind === 'player') { const p = sim.players.list.get(t.key); return !!p && p.body === t.body; }
    if (t.kind === 'chipper') return sim.chipper.units[t.key]?.body === t.body;
    return sim.bins.units[t.key]?.body === t.body;
  }
  /** No harm from the claw: held, and for LOADER_SOFT_T after it lets go. */
  soften(t) {
    const sim = this.sim, until = sim.tick + Math.round(CFG.LOADER_SOFT_T * 60);
    if (t.kind === 'player') { const p = sim.players.list.get(t.key); if (p) p.softT = until; }
    else if (t.kind === 'chipper') { const u = sim.chipper.units[t.key]; if (u) u.softT = until; }
  }
  /** Every collider of these bodies into collision groups g; returns what they were, to put back. */
  setGroups(bodies, g) {
    const out = [];
    for (const b of bodies) for (let i = 0, n = b.numColliders(); i < n; i++) { const c = b.collider(i); out.push([c, c.collisionGroups()]); c.setCollisionGroups(g); }
    return out;
  }
  restore(cols) { for (const [c, g] of cols || []) { try { if (c.isValid()) c.setCollisionGroups(g); } catch (e) { /* (gone with its body) */ } } }

  /** The claw takes thing t: carried as wood is, standing on the fork as it stood, the side nearest the loader against the plate. */
  takeThing(t, by) {
    const sim = this.sim, qL = this.quat(), qLi = qL.clone().invert(), body = t.body;
    const J = this.toWorld(jawAt(this.arm), new THREE.Vector3()), qP = this.quat(body);
    const wc = body.worldCom(), lc = body.localCom(), com = new THREE.Vector3(lc.x, lc.y, lc.z);
    const p0 = new THREE.Vector3(wc.x - J.x, wc.y - J.y, wc.z - J.z).applyQuaternion(qLi), q0 = qLi.clone().multiply(qP);
    // how far it reaches toward the loader (its half size along the loader's x, as it is turned): that far ahead of the plate
    const ax = new THREE.Vector3(1, 0, 0).applyQuaternion(q0.clone().invert());
    const d = Math.abs(ax.x) * t.hx[0] + Math.abs(ax.y) * t.hx[1] + Math.abs(ax.z) * t.hx[2];
    const FORK = LOADER.FORK.c[1] + LOADER.FORK.h[1] - LOADER.JAW[1];   // the fork's top, from the jaws' middle
    const p1 = new THREE.Vector3(Math.max(0, d - 0.3), FORK + t.base, 0);
    // whoever was holding it lets go; a player taken stops what they were doing
    for (const o of sim.players.list.values()) {
      const g = o.grab; if (!g) continue;
      if ((t.kind === 'chipper' && g.chip && (g.k || 0) === t.key) || (t.kind === 'bin' && g.bin === t.key) || (t.kind === 'player' && g.bot === t.key)) o.grab = null;
    }
    let fixQ = null;
    if (t.kind === 'player') {
      const p = sim.players.list.get(t.key);
      sawOff(sim, p); p.grab = null; p.walk = null;
      p.mode = MODE.CLAW;
      fixQ = qP.clone();
      sim.toast(`${sim.players.name(by.id)} picked you up in the loader's claw`, p.id);
    }
    for (const b of t.bodies) b.setBodyType(sim.R.RigidBodyType.KinematicPositionBased, true);
    t.bodies = t.bodies.slice(0, 1);                 // (a bin's lid hangs on its hinge: only the bin is carried)
    const cols = this.setGroups(t.kind === 'bin' ? [body, sim.bins.units[t.key].lid] : [body], HELD_G);
    if (t.kind === 'bin') sim.bins.units[t.key].lid.setBodyType(sim.R.RigidBodyType.Dynamic, true);
    this.soften(t);
    this.hold = { thing: t, kind: 'carry', kg: t.kg, p0, q0, p1, q1: q0.clone(), com, body, jaw0: Math.min(0.95, this.jaw), cols, fixQ };
  }

  /** The claw lets go of the thing it holds: it falls out of the claw as wood does, harmlessly (soften). */
  dropThing(fall = true) {
    const sim = this.sim, h = this.hold, t = h.thing; this.hold = null;
    if (!this.alive(t)) { this.restore(h.cols); return; }
    const b = t.body;
    if (t.kind === 'player') {
      const p = sim.players.list.get(t.key);
      p.mode = MODE.GROUND; p.col.setSensor(false);
      p.vPre.set(0, 0, 0); p.hit = 0;
    }
    b.setBodyType(sim.R.RigidBodyType.Dynamic, true);
    const v = this.body && fall ? this.body.velocityAtPoint(b.worldCom()) : { x: 0, y: 0, z: 0 };
    b.setLinvel({ x: v.x, y: v.y, z: v.z }, true); b.setAngvel({ x: 0, y: 0, z: 0 }, true);
    if (t.kind === 'player') sim.players.list.get(t.key).vPre.set(v.x, v.y, v.z);
    b.wakeUp();
    this.soften(t);
    this.thru.push({ body: b, cols: h.cols, r: Math.max(...t.hx), t: 0, alive: () => this.alive(t) });
  }
  /** Player p came out of the claw by another route (respawn, a new tree, left the game): the claw is empty. */
  lost(p) {
    const h = this.hold;
    if (h && h.thing && h.thing.kind === 'player' && h.thing.key === p.id) { this.restore(h.cols); this.hold = null; }
  }

  /**
   * The wood between the jaws: of the segments whose axis comes within its radius + LOADER_JAW_REACH of the jaws'
   * line (across the claw, JAW_W either side of the middle), the nearest. {seg, kg, thick} (thick: more than
   * JAW_R: the claw cannot close on it), or null.
   */
  between() {
    const sim = this.sim, w = sim.world, j = jawAt(this.arm), W = LOADER.JAW_W;
    const P = this.toWorld([j[0], j[1], j[2] - W], new THREE.Vector3()), Q = this.toWorld([j[0], j[1], j[2] + W], new THREE.Vector3());
    let best = null, bd = Infinity, thick = null, td = Infinity;
    for (const s of w.segs.values()) {
      if (!sim.segCol.has(s.id)) continue;
      const A = sim.segToWorld(s, s.a, _a), B = sim.segToWorld(s, s.b, _b);
      const { d, t } = segSeg(A, B, P, Q), r = segRadius(s, t);
      const gap = d - r;                          // from the jaws to the bark (< 0: the jaws are inside the wood)
      if (gap >= CFG.LOADER_JAW_REACH) continue;
      if (r > LOADER.JAW_R) { if (gap < td) { td = gap; thick = s.id; } continue; }
      if (gap < bd) { bd = gap; best = s.id; }
    }
    if (best !== null) return { seg: best, kg: sim.weightOf(w.segs.get(best).piece), thick: false };
    return thick !== null ? { seg: thick, thick: true } : null;
  }

  /** How long piece id is: the farthest apart two of its segments' ends are, and that line (piece-local). */
  lengthOf(id, out) {
    const pts = [];
    for (const s of this.sim.world.segsOf(id)) pts.push(s.a, s.b);
    let m = 0, A = pts[0], B = pts[0];
    for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) {
      const p = pts[i], q = pts[j], d = Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
      if (d > m) { m = d; A = p; B = q; }
    }
    if (out) out.set(B[0] - A[0], B[1] - A[1], B[2] - A[2]);
    return m;
  }

  /**
   * Is rooted piece id a stump the claw can rip out? {base, top, R} (base: its root segment), with why set when it
   * is a stump that cannot come out yet; null when it is not a stump (standing wood: too heavy, the claw tips).
   * Short enough: its wood reaches no more than LOADER_STUMP_H above the ground at its base.
   */
  stump(id) {
    const sim = this.sim, w = sim.world;
    let base = null, top = -Infinity;
    for (const s of w.segsOf(id)) { if (s.parent < 0) base = s; top = Math.max(top, s.a[1], s.b[1]); }
    if (!base) return null;
    const g = sim.groundY(base.a[0], base.a[2]);
    if (top - g > CFG.LOADER_STUMP_H) return null;
    const out = { base, R: base.r0, g };
    for (const j of sim.structure.live.values()) if (j.parent === id) { out.why = 'Wood still hangs from the stump: saw it free first'; break; }
    return out;
  }

  /**
   * Rip out stump id: roots grow on its base where they were in the ground (a 'roots' event: wood like any other,
   * a few thick roots splaying out and down and a tap root, and a dirt patch where it stood), then the whole of it
   * comes free of the ground (a 'split' at its base). Returns the new loose piece.
   */
  uproot(id, st) {
    const sim = this.sim, w = sim.world, b = st.base, R = st.R, a = b.a, segs = [];
    const n = 5, k0 = (a[0] * 7.3 + a[2] * 3.1) % 1;             // turned a little, the same for the same stump
    const add = (d, len, r0, r1) => {
      const l = Math.hypot(d[0], d[1], d[2]), u = [d[0] / l, d[1] / l, d[2] / l];
      const o = [a[0] + u[0] * R * 0.5, a[1] + 0.12, a[2] + u[2] * R * 0.5];
      segs.push({ id: w.newId(), parent: b.id, a: o, b: [o[0] + u[0] * len, o[1] + u[1] * len, o[2] + u[2] * len], r0, r1, leaf: 0 });
    };
    for (let i = 0; i < n; i++) {
      const th = (i + k0) * 2 * Math.PI / n, len = R * 2.2 + 0.3 + 0.15 * ((i * 0.37 + k0) % 1);
      add([Math.cos(th), -0.55, Math.sin(th)], len, R * 0.42, R * 0.14);
    }
    add([0, -1, 0], R * 1.5 + 0.2, R * 0.5, R * 0.2);           // the tap root
    sim.emit({ t: 'roots', piece: id, segs, dirt: [+a[0].toFixed(3), +st.g.toFixed(3), +a[2].toFixed(3), +(R * 2.4 + 0.5).toFixed(3)] });
    const np = w.newId();
    sim.emit({ t: 'split', seg: b.id, at: 0, newPiece: np });
    return np;
  }

  /**
   * The claw takes piece id to carry (kind 'carry', or 'light': it slips out halfway up): the wood becomes a
   * kinematic body, drawn while the claw closes from where it is to lying square across the jaws with its centre
   * of mass in their middle; from then on it goes where the jaws go.
   */
  take(id, body, kg, kind, upright = false) {
    const sim = this.sim, qL = this.quat(), qLi = qL.clone().invert();
    const J = this.toWorld(jawAt(this.arm), new THREE.Vector3()), t = body.translation(), qP = this.quat(body);
    // now, in the loader's frame relative to the jaws
    // (its centre of mass is moved, and the body turned about it: its own origin can be far from the wood)
    const wc = body.worldCom(), lc = body.localCom(), com = new THREE.Vector3(lc.x, lc.y, lc.z);
    const p0 = new THREE.Vector3(wc.x - J.x, wc.y - J.y, wc.z - J.z).applyQuaternion(qLi), q0 = qLi.clone().multiply(qP);
    // square across the jaws: its length along the loader's z (the nearer way round), its centre of mass in the middle
    const ax = new THREE.Vector3(); this.lengthOf(id, ax); if (ax.lengthSq() < 1e-9) ax.set(0, 0, 1);
    ax.normalize().applyQuaternion(q0); if (ax.z < 0) ax.negate();
    // (a stump is held as it stood, upright, its roots hanging under the claw)
    const q1 = upright ? q0.clone() : new THREE.Quaternion().setFromUnitVectors(ax, new THREE.Vector3(0, 0, 1)).multiply(q0);
    const p1 = new THREE.Vector3();
    body.setBodyType(sim.R.RigidBodyType.KinematicPositionBased, true);
    this.groups(id, HELD_G); this.through.delete(id);
    this.hold = { piece: id, kind, kg, p0, q0, p1, q1, com, body, jaw0: Math.min(0.95, this.jaw) };
  }

  /** Too heavy (too long, or the standing tree): the wood is held still where it is and the claw pinned to it there. */
  pin(id, body, kg, fixed) {
    const sim = this.sim;
    if (!fixed) { body.setBodyType(sim.R.RigidBodyType.KinematicPositionBased, true); this.groups(id, HELD_G); this.through.delete(id); }
    this.hold = { piece: id, kind: 'pin', kg, body, fixed, joint: null, pitch0: 0 };
  }

  /** The claw lets go of what it holds: back to a dynamic body (falling through the claw), or unpinned. */
  release(fall = true) {
    const sim = this.sim, h = this.hold; if (!h) return;
    if (h.thing) { this.dropThing(fall); return; }
    this.hold = null;
    if (h.joint) { this.hold = h; this.dropJoint(); this.hold = null; }
    if (!sim.world.pieces.has(h.piece) || sim.bodies.get(h.piece) !== h.body) return;
    if (h.fixed) return;
    const b = h.body;
    b.setBodyType(sim.R.RigidBodyType.Dynamic, true);
    if (this.body && fall && h.kind !== 'pin') {
      const c = b.worldCom(), v = this.body.velocityAtPoint(c);
      b.setLinvel({ x: v.x, y: v.y, z: v.z }, true); b.setAngvel({ x: 0, y: 0, z: 0 }, true);
    } else { b.setLinvel({ x: 0, y: 0, z: 0 }, true); b.setAngvel({ x: 0, y: 0, z: 0 }, true); }
    this.through.set(h.piece, 0);                  // it falls through the claw: it meets the loader again once clear
    b.wakeUp();
  }

  // ---- each tick, before physics ----
  pre(dt) {
    if (!this.body) return;
    const sim = this.sim, L = LOADER;
    const d = sim.players.list.get(this.driver);
    if (!d || d.mode !== MODE.DRIVE) { this.driver = -1; this.ctrl = { thr: 0, turn: 0 }; }
    this.tyres(dt, this.ctrl.thr, this.ctrl.turn);
    this.animate(dt);
    this.carry(dt);
    this.clearThrough(dt);
    // the driver rides on the platform (kinematic: where it will be at the end of this step)
    if (d && d.mode === MODE.DRIVE) {
      const s = this.toWorld(L.STAND, _a), v = this.body.velocityAtPoint(s);
      d.body.setNextKinematicTranslation({ x: s.x + v.x * dt, y: s.y + v.y * dt, z: s.z + v.z * dt });
    }
  }

  /** The claw's and the arms' motions, one step. */
  animate(dt) {
    const L = LOADER, h = this.hold, close = dt / Math.max(0.05, CFG.LOADER_CLOSE_T);
    const armV = (L.ARM_MAX - L.ARM_MIN) / Math.max(0.2, CFG.LOADER_LIFT_T) * dt, mid = (L.ARM_MIN + L.ARM_MAX) / 2;
    this.phaseT += dt;
    switch (this.phase) {
      case GRAB:
        this.jaw = Math.min(1, this.jaw + close);
        if (this.jaw >= 1) {
          if (h && h.kind === 'pin') this.pinJoint(); else this.setPhase(LIFT);
        }
        break;
      case LIFT:
        this.arm = Math.min(L.ARM_MAX, this.arm + armV);
        if (h && h.kind === 'light' && this.arm >= mid && this.phaseT > 0.3) {
          this.release(); this.note = 'Too light for the claw: it slipped through (chip it)';
        }
        if (this.arm >= L.ARM_MAX) this.setPhase(UP);
        break;
      case TIP: {
        // the arms lift against wood that does not move: the loader goes over on its front wheels instead
        const up = this.dirToWorld([1, 0, 0], _a), pitch = -Math.asin(Math.max(-1, Math.min(1, up.y)));
        const tipped = pitch - (h ? h.pitch0 : 0) >= CFG.LOADER_TIP || this.arm >= L.ARM_MAX;
        if (!tipped && !h?.done) this.arm = Math.min(L.ARM_MAX, this.arm + armV);
        else if (h && !h.done) { h.done = true; this.phaseT = 0; }
        if (h && h.joint) { const j = jawAt(this.arm); h.joint.setAnchor1({ x: j[0], y: j[1], z: j[2] }); }
        if (!h || (h.done && this.phaseT >= CFG.LOADER_TIP_HOLD)) {
          this.release(false); this.setPhase(DROP);
        }
        break;
      }
      case DROP:
        if (this.hold) this.release();
        this.jaw = Math.max(0, this.jaw - close);
        if (this.jaw <= 0) this.setPhase(LOWER);
        break;
      case LOWER:
        this.arm = Math.max(L.ARM_MIN, this.arm - armV);
        if (this.arm <= L.ARM_MIN) this.setPhase(IDLE);
        break;
      default: break;
    }
  }

  /** The claw closed on wood too heavy to lift: a ball joint from the jaws to the wood, where they are now. */
  pinJoint() {
    const sim = this.sim, R = sim.R, h = this.hold;
    const j = jawAt(this.arm), J = this.toWorld(j, new THREE.Vector3()), a2 = this.toLocal(J, h.body);
    const data = R.JointData.spherical({ x: j[0], y: j[1], z: j[2] }, { x: a2[0], y: a2[1], z: a2[2] });
    h.joint = sim.rapier.createImpulseJoint(data, this.body, h.body, true);
    h.joint.setContactsEnabled(false);
    const up = this.dirToWorld([1, 0, 0], _a); h.pitch0 = -Math.asin(Math.max(-1, Math.min(1, up.y)));
    this.note = h.fixed ? 'The claw cannot pull up the standing tree' : 'Too heavy: over 8 ft long (saw it shorter)';
    this.setPhase(TIP);
  }

  /** What the claw carries goes where the jaws will be at the end of this step. */
  carry(dt) {
    const h = this.hold; if (!h || h.kind === 'pin') return;
    if (h.thing) {
      if (!this.alive(h.thing)) { this.restore(h.cols); this.hold = null; return; }   // gone (a new tree, left the game)
      this.soften(h.thing);
    }
    const b = this.body, j = jawAt(this.arm), J = this.toWorld(j, new THREE.Vector3()), v = b.velocityAtPoint(J);
    J.x += v.x * dt; J.y += v.y * dt; J.z += v.z * dt;
    const k = smooth(this.phase === GRAB ? Math.max(0, Math.min(1, (this.jaw - h.jaw0) / (1 - h.jaw0))) : 1), qL = this.quat();
    const q = h.fixQ ? h.fixQ : qL.clone().multiply(h.q0.clone().slerp(h.q1, k));   // (a player stays upright)
    const p = h.p0.clone().lerp(h.p1, k).applyQuaternion(qL).add(J).sub(h.com.clone().applyQuaternion(q));
    h.body.setNextKinematicTranslation({ x: p.x, y: p.y, z: p.z });
    h.body.setNextKinematicRotation({ x: q.x, y: q.y, z: q.z, w: q.w });
  }

  /** Wood dropped from the claw meets the loader again once it is clear of the jaws (or after a while). */
  clearThrough(dt) {
    if (this.thru.length) {
      const J = this.toWorld(jawAt(this.arm), new THREE.Vector3());
      this.thru = this.thru.filter((o) => {
        o.t += dt;
        let c = null; try { c = o.alive() ? o.body.worldCom() : null; } catch (e) { c = null; }
        if (c && Math.hypot(c.x - J.x, c.y - J.y, c.z - J.z) <= 1.2 + o.r && o.t <= 4) return true;
        if (c) this.restore(o.cols);
        return false;
      });
    }
    if (!this.through.size) return;
    const sim = this.sim, J = this.toWorld(jawAt(this.arm), new THREE.Vector3());
    for (const [id, t] of this.through) {
      const b = sim.bodies.get(id);
      if (!b || !sim.world.pieces.has(id)) { this.through.delete(id); continue; }
      const c = b.worldCom(), far = Math.hypot(c.x - J.x, c.y - J.y, c.z - J.z) > 1.2 + this.lengthOf(id) / 2;
      if (far || t > 4) { this.groups(id, ALL); this.through.delete(id); } else this.through.set(id, t + dt);
    }
  }

  /**
   * The tyres (as the chipper's, sim/chipper.js): at each wheel that touches the ground an impulse across it that
   * resists it sliding sideways (up to LOADER_SKID x its share of the weight), and one along it toward its side's
   * speed (throttle minus or plus the turn, x LOADER_SPEED; with no input, toward standing still: the brakes), up to
   * LOADER_GRIP x that weight and LOADER_DRIVE_F shared out. Solved together in a few passes, each kept within its cap.
   */
  tyres(dt, thr, turn) {
    const sim = this.sim, b = this.body, L = LOADER, g = CFG.GRAVITY;
    const pts = [];
    L.WHEELS.forEach((w) => {
      const P = this.toWorld([w[0], w[1] - L.WHEEL_R, w[2]], new THREE.Vector3());
      if (P.y - sim.groundY(P.x, P.z) < 0.1) pts.push({ P, side: Math.sign(w[2]) });
    });
    if (!pts.length) return;
    const N = b.mass() * g / pts.length;
    const drive = Math.abs(thr) > 0.05 || Math.abs(turn) > 0.05;
    const grips = [];
    for (const { P, side } of pts) {
      const n0 = sim.groundN(P.x, P.z), n = new THREE.Vector3(n0[0], n0[1], n0[2]);
      const h = this.dirToWorld([1, 0, 0], new THREE.Vector3()), l = this.dirToWorld([0, 0, 1], new THREE.Vector3());
      h.addScaledVector(n, -h.dot(n)).normalize(); l.addScaledVector(n, -l.dot(n)).normalize();
      // (turning right, +turn: the left side, -z, goes faster)
      const vt = Math.max(-1, Math.min(1, thr - side * turn * CFG.LOADER_TURN)) * CFG.LOADER_SPEED;
      grips.push({ P, d: l, cap: CFG.LOADER_SKID * N * dt, v: 0, J: 0 });
      grips.push({ P, d: h, cap: drive ? Math.min(CFG.LOADER_GRIP * N * dt, CFG.LOADER_DRIVE_F / pts.length * dt) : CFG.LOADER_BRAKE * N * dt, v: drive ? vt : 0, J: 0 });
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
      if (this.hold && this.hold.piece === id) continue;
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
  /** Is collider h the loader (heavy: it breaks fences and cracks pavers as the chipper does)? */
  solid(h) { return this.cols.has(h); }
  eachRigid(fn) { if (this.body) fn(this.body); }
  eachBody(fn) { if (this.body) fn(LOADER_BODY_ID, this.body.translation(), this.body.rotation(), true); }
  bodyOf(id) { return id === LOADER_BODY_ID ? this.body : null; }
  /** aux.ld: [how shut the claw is 0..1, what the arms are doing (PHASE_CODE), arm angle (rad), driver id] or 0 with no loader. */
  aux() { return this.body ? [+this.jaw.toFixed(3), PHASE_CODE[this.phase] || 0, +this.arm.toFixed(4), this.driver] : 0; }
}

/** Closest approach of segments AB and PQ (THREE vectors): {d, t} with t along AB (0..1). */
function segSeg(A, B, P, Q) {
  const ux = B.x - A.x, uy = B.y - A.y, uz = B.z - A.z, vx = Q.x - P.x, vy = Q.y - P.y, vz = Q.z - P.z;
  const wx = A.x - P.x, wy = A.y - P.y, wz = A.z - P.z;
  const a = ux * ux + uy * uy + uz * uz, b = ux * vx + uy * vy + uz * vz, c = vx * vx + vy * vy + vz * vz;
  const d = ux * wx + uy * wy + uz * wz, e = vx * wx + vy * wy + vz * wz, D = a * c - b * b;
  let s = D > 1e-12 ? (b * e - c * d) / D : 0;
  s = Math.max(0, Math.min(1, s));
  let t = c > 1e-12 ? (b * s + e) / c : 0;
  if (t < 0) { t = 0; s = a > 1e-12 ? Math.max(0, Math.min(1, -d / a)) : 0; }
  else if (t > 1) { t = 1; s = a > 1e-12 ? Math.max(0, Math.min(1, (b - d) / a)) : 0; }
  const x = wx + ux * s - vx * t, y = wy + uy * s - vy * t, z = wz + uz * s - vz * t;
  return { d: Math.hypot(x, y, z), t: s };
}
