// Players on the host: bodies, walking, spur climbing on a lanyard,
// interaction, injury thresholds. See docs/DESIGN.md section 6.
// Prompts use {tokens} that each client's HUD turns into the right key or button name.

import * as THREE from '../../vendor/three/three.module.js';
import { CFG, INJ, MODE } from '../config.js';
import { segLen, segAxis, segRadius, segParam, lerp3, perp } from '../model/world.js';
import { sawStep, sawOff } from './saw.js';

const COUNTERS = ['jump', 'interact', 'drop', 'rig', 'punch', 'wrapUp', 'wrapDn', 'respawn'];
export function blankInput() {
  const c = {}; for (const k of COUNTERS) c[k] = 0;
  // sy, sp: how far the saw is swung from straight-ahead-and-level (rad)
  // hi, hd: {interact} and {drop} held down (1/0), for actions that take time
  return { mx: 0, my: 0, yaw: 0, pitch: 0, sy: 0, sp: 0, rt: 0, lt: 0, hi: 0, hd: 0, c };
}
const UP = new THREE.Vector3(0, 1, 0);
const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3();

export class Players {
  constructor(sim) { this.sim = sim; this.list = new Map(); }

  add(id, name) {
    const sim = this.sim, R = sim.R;
    const ang = id * 1.3, sp = [4 * Math.cos(ang), 1.2, 4 * Math.sin(ang)];       // spawn y is above the ground there
    sp[1] += sim.groundY(sp[0], sp[2]);
    const body = sim.rapier.createRigidBody(sim.dynamic().setTranslation(sp[0], sp[1], sp[2]).lockRotations());
    const col = sim.rapier.createCollider(R.ColliderDesc.capsule(CFG.P_HALF, CFG.P_RADIUS).setMass(CFG.P_MASS)
      .setFriction(0.2).setActiveEvents(R.ActiveEvents.CONTACT_FORCE_EVENTS).setContactForceEventThreshold(300), body);
    sim.colPlayer.set(col.handle, id);
    const p = {
      id, body, col, spawn: sp, input: blankInput(), last: { ...blankInput().c }, primed: false,
      mode: MODE.GROUND, inj: INJ.OK, shakenT: 0, lan: false,
      cl: null,                // {seg, t, side:[3] piece-local unit, perpendicular to the stem}
      saw: { on: false }, grounded: false, vPre: new THREE.Vector3(), toastT: 0,
      ride: null, prompt: '',
      ch: null, chLock: new Set(),   // channel in progress {kind, t, need, seen}; kinds done and not yet let go of
      punch: null,                   // {seg, p: piece-local point, d: world direction, F: N}, fading
      grab: null,                    // holding wood on the ground: {seg, p: piece-local point, L0: rope length, prev}
    };
    this.list.set(id, p);
    sim.emit({ t: 'player', id, name });
    return p;
  }
  remove(id) {
    const p = this.list.get(id); if (!p) return;
    if (this.sim.rope.holder === id) this.sim.rope.holder = -1;
    this.sim.colPlayer.delete(p.col.handle);
    this.sim.rapier.removeRigidBody(p.body);
    this.list.delete(id);
    this.sim.emit({ t: 'player', id, leave: 1 });
  }
  setInput(id, inp) { const p = this.list.get(id); if (p) p.input = inp; }

  say(p, msg) { if (p.toastT <= 0) { this.sim.toast(msg, p.id); p.toastT = 1.5; } }

  // ---- injuries: one measure (delta-v), thresholds, consequences ----
  impact(p, dv) {
    let lvl = INJ.OK;
    if (dv > CFG.DV_DOWN) lvl = INJ.DOWN; else if (dv > CFG.DV_HURT) lvl = INJ.HURT; else if (dv > CFG.DV_SHAKEN) lvl = INJ.SHAKEN;
    if (lvl === INJ.OK) return;
    if (lvl === INJ.SHAKEN) { p.shakenT = CFG.SHAKEN_TIME; if (p.inj < INJ.SHAKEN) p.inj = INJ.SHAKEN; }
    else if (lvl > p.inj) {
      p.inj = lvl;
      this.sim.toast(lvl === INJ.DOWN ? `Player ${p.id} is DOWN (${dv.toFixed(1)} m/s impact) - job failed` : `Player ${p.id} is hurt (${dv.toFixed(1)} m/s impact)`);
    }
    sawOff(this.sim, p);
    if (p.mode === MODE.CLIMB && lvl >= INJ.HURT) this.toGround(p);
    if (p.mode === MODE.ROPE) this.leaveRope(p);
  }
  onContact(pid, force) {
    const p = this.list.get(pid);
    if (p && p.mode === MODE.CLIMB && !p.ride) {   // kinematic: no velocity change to read, use the force
      const dv = force * CFG.TICK / CFG.P_MASS;
      p.hit = Math.max(p.hit || 0, dv);
    }
  }

  // ---- mode changes ----
  /** Back to where p started, 1.2 m above the ground there (the ground may have changed since). */
  toSpawn(p) {
    const s = p.spawn;
    s[1] = this.sim.groundY(s[0], s[2]) + 1.2;
    p.body.setTranslation({ x: s[0], y: s[1], z: s[2] }, true);
  }

  /** New ground: anyone standing where it now rises is lifted onto it. */
  onTerrain() {
    for (const p of this.list.values()) {
      if (p.mode === MODE.CLIMB) continue;
      const t = p.body.translation(), y = this.sim.groundY(t.x, t.z) + CFG.P_HALF + CFG.P_RADIUS + 0.05;
      if (t.y < y) p.body.setTranslation({ x: t.x, y, z: t.z }, true);
    }
  }

  toGround(p, vel) {
    if (p.mode === MODE.CLIMB) {
      p.body.setBodyType(this.sim.R.RigidBodyType.Dynamic, true);
      p.body.setLinvel(vel || { x: 0, y: 0, z: 0 }, true);
    }
    p.mode = MODE.GROUND; p.cl = null; p.lan = false; p.ride = null;
    p.col.setSensor(false);
  }
  /** On spurs with the lanyard round segment segId. Climbing and being lanyarded are the same thing. */
  toClimb(p, segId, t, side) {
    p.body.setBodyType(this.sim.R.RigidBodyType.KinematicPositionBased, true);
    p.mode = MODE.CLIMB; p.cl = { seg: segId, t, side }; p.lan = true; p.ride = null; p.grab = null;
    p.col.setSensor(false);
  }
  cutLanyard(p, by) {
    this.sim.toast(by === p ? 'You cut your own lanyard' : `Player ${by.id} cut player ${p.id}'s lanyard`);
    this.toGround(p);
  }
  /** All wood is gone: everyone is on the ground with empty hands on the tree. */
  onReset() {
    for (const p of this.list.values()) {
      sawOff(this.sim, p); p.grab = null; p.chips = 0;
      if (p.mode === MODE.ROPE) this.leaveRope(p);
      if (p.mode === MODE.CLIMB) this.toGround(p);
    }
  }
  onDivide(ev) {
    for (const p of this.list.values()) {
      if (!p.cl || p.cl.seg !== ev.seg) continue;
      if (p.cl.t > ev.at) { p.cl.seg = ev.newSeg; p.cl.t = (p.cl.t - ev.at) / (1 - ev.at); } else p.cl.t /= ev.at;
    }
  }
  leaveRope(p) { if (this.sim.rope.holder === p.id) this.sim.rope.holder = -1; p.mode = MODE.GROUND; }

  onSplit(ev, info) {
    for (const p of this.list.values()) {
      if (!p.cl) continue;
      if (p.cl.seg === ev.seg && ev.at > 0) {
        if (p.cl.t > ev.at) { p.cl.seg = ev.newSeg; p.cl.t = (p.cl.t - ev.at) / (1 - ev.at); }
        else p.cl.t = p.cl.t / ev.at;
      }
      // the wood this climber is lanyarded to just became a moving piece: stay with it (and do not collide with it)
      if (info.moved.includes(p.cl.seg)) p.col.setSensor(true);
    }
  }

  // ---- actions that take time: hold the button for `need` seconds; letting go or losing the target cancels ----
  /** Call every tick the action is possible. Returns true on the tick it completes. */
  hold(p, kind, held, need, dt) {
    if (!held) { p.chLock.delete(kind); if (p.ch && p.ch.kind === kind) p.ch = null; return false; }
    if (p.chLock.has(kind)) return false;                      // done once: let go before it can happen again
    if (!p.ch || p.ch.kind !== kind) p.ch = { kind, t: 0, need };
    p.ch.need = need; p.ch.t += dt; p.ch.seen = true;
    if (p.ch.t < need) return false;
    p.ch = null; p.chLock.add(kind);
    return true;
  }

  // ---- grabbing wood on the ground: a short rope from the hands to the point grabbed (tension only) ----
  hands(p, out) { const t = p.body.translation(); return out.set(t.x, t.y + CFG.GRAB_HEIGHT, t.z); }
  grabStart(p, aim) {
    const sim = this.sim, s = sim.world.segs.get(aim.seg);
    p.grab = { seg: s.id, p: sim.segToLocal(s, aim.point), L0: Math.max(0.2, this.hands(p, _a).distanceTo(aim.point)), prev: 0 };
  }
  /** Take hold of the chipper's grip (local point pl on it). */
  grabChipper(p, ca) {
    p.grab = { chip: 1, p: ca.local, L0: Math.max(0.2, this.hands(p, _a).distanceTo(ca.point)), prev: 0 };
  }
  grabStep(p, dt) {
    const g = p.grab, sim = this.sim; p.pull = 0; p.lean = null; if (!g) return;
    const ch = sim.chipper;
    const s = g.chip ? null : sim.world.segs.get(g.seg);
    if (g.chip ? !ch.body : !s) { p.grab = null; return; }
    const h = this.hands(p, _a), w = g.chip ? ch.toWorld(g.p, _b) : sim.segToWorld(s, g.p, _b);
    const dir = _c.copy(h).sub(w), len = dir.length();
    const stretch = len - g.L0, rate = (stretch - g.prev) / dt; g.prev = stretch;
    const piece = g.chip ? null : sim.world.pieces.get(s.piece);
    // something that can move (loose wood, the chipper): the feet cannot walk away from it faster than it follows
    const mover = g.chip ? ch.body : piece.fixed ? null : sim.bodies.get(s.piece);
    const hx = dir.x, hz = dir.z, hl = Math.hypot(hx, hz);
    if (mover && hl > 1e-6 && stretch > -0.1) {       // taut, or nearly
      const v = mover.velocityAtPoint(w);
      p.lean = { x: hx / hl, z: hz / hl, v: (v.x * hx + v.z * hz) / hl };
    }
    if (stretch <= 0 || len < 1e-6) return;
    const m = g.chip || piece.fixed ? CFG.P_MASS : Math.min(CFG.P_MASS, sim.bodies.get(s.piece).mass());
    const k = Math.min(CFG.GRAB_K, CFG.ROPE_KCAP * m / (dt * dt)), c = 2 * CFG.ROPE_DAMP * Math.sqrt(k * m);
    const T = Math.max(0, k * stretch + c * rate);
    p.pull = T;
    if (T > CFG.GRAB_MAX) { p.grab = null; p.pull = 0; this.say(p, g.chip ? 'The chipper pulled out of your hands' : 'The wood pulled out of your hands'); return; }
    dir.divideScalar(len);
    if (g.chip) ch.body.applyImpulseAtPoint({ x: dir.x * T * dt, y: dir.y * T * dt, z: dir.z * T * dt }, w, true);   // chipper pulled toward the hands
    else sim.applyForce(s.id, w, dir.clone().multiplyScalar(T));               // wood pulled toward the hands
    p.body.applyImpulse({ x: -dir.x * T * dt, y: -dir.y * T * dt, z: -dir.z * T * dt }, true);   // and the hands toward the wood
  }

  // ---- punch: each press adds a shove along the look direction that fades; spamming stacks it ----
  punchPress(p, aim) {
    if (!aim || aim.dist > CFG.REACH) return;
    const sim = this.sim, s = sim.world.segs.get(aim.seg);
    const F = Math.min(CFG.PUNCH_MAX, (p.punch ? p.punch.F : 0) + CFG.PUNCH_FORCE);
    p.punch = { seg: s.id, p: sim.segToLocal(s, aim.point), d: sim.eye(p).d, F };
  }
  punchStep(p, dt) {
    const pu = p.punch; if (!pu) return;
    const s = this.sim.world.segs.get(pu.seg);
    if (!s || pu.F < 1) { p.punch = null; return; }
    this.sim.applyForce(s.id, this.sim.segToWorld(s, pu.p, _a), _b.copy(pu.d).multiplyScalar(pu.F));
    pu.F *= Math.exp(-dt / Math.max(1e-3, CFG.PUNCH_DECAY));
  }

  // ---- per tick, before physics ----
  pre(dt) {
    for (const p of this.list.values()) this.prePlayer(p, dt);
  }

  prePlayer(p, dt) {
    const sim = this.sim, inp = p.input, w = sim.world;
    const pressed = {};
    for (const k of COUNTERS) { pressed[k] = p.primed && inp.c[k] !== p.last[k]; p.last[k] = inp.c[k]; }
    p.primed = true;
    // two movement keys at once: the same speed as one (no faster on the diagonal)
    const mv = Math.hypot(inp.mx, inp.my); if (mv > 1) { inp.mx /= mv; inp.my /= mv; }
    if (p.toastT > 0) p.toastT -= dt;
    if (p.shakenT > 0) { p.shakenT -= dt; if (p.shakenT <= 0 && p.inj === INJ.SHAKEN) p.inj = INJ.OK; }
    if (p.hit) { const dv = p.hit; p.hit = 0; this.impact(p, dv); }

    if (pressed.respawn) {
      sawOff(sim, p); if (p.mode === MODE.ROPE) this.leaveRope(p);
      this.toGround(p);
      p.inj = INJ.OK; p.shakenT = 0;
      this.toSpawn(p);
      p.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    }
    const control = p.inj < INJ.DOWN && p.shakenT <= 0;
    const aim = control ? sim.aim(p) : null;
    p.prompt = '';
    if (p.ch) p.ch.seen = false;
    if (!inp.hi) p.chLock.delete('lanyard');
    if (!inp.hd) p.chLock.delete('letgo');

    // chainsaw (no tool to pick: it is always to hand): {raise} plants it on the wood looked at;
    // look controls pivot it, {throttle} presses it in
    const canSaw = control && p.mode !== MODE.ROPE && !p.ride;
    sawStep(sim, p, inp, dt, canSaw, aim);
    if (control && p.mode !== MODE.ROPE && pressed.punch) this.punchPress(p, aim);
    this.punchStep(p, dt);
    if (p.mode !== MODE.GROUND || !control) p.grab = null;

    if (p.mode === MODE.ROPE) {
      p.prompt = '{throttle}: ease   {raise}: haul   {wraps}: wraps   {interact}: let go (ties off)';
      sim.rope.operate(p, inp, pressed, dt);
      if (pressed.interact || !control) this.leaveRope(p);
      p.body.setLinvel({ x: 0, y: p.body.linvel().y, z: 0 }, true);
    } else if (p.mode === MODE.CLIMB) {
      this.climb(p, inp, dt, control, pressed, aim);
    } else {
      this.ground(p, inp, dt, control, pressed, aim);
    }
    if (p.ch && !p.ch.seen) p.ch = null;          // the action stopped being possible: start again
    const v = p.body.linvel(); p.vPre.set(v.x, v.y, v.z);
  }

  /** What else the wood (or rope) looked at offers, appended to a prompt. */
  extras(p, aim, first) {
    const out = first ? [first] : [];
    const r = this.sim.rope.prompt(p, aim); if (r) out.push(r);
    if (aim && aim.dist < CFG.REACH) out.push('{punch}: punch');
    if (!p.saw.on && aim && aim.dist <= CFG.SAW_REACH && !p.ride) out.push('{raise}: plant the saw');
    return out.join('   ');
  }

  /** Is p touching anything under it no steeper than JUMP_SLOPE (something to push a jump off)? n: set to its normal. */
  footing(p, n) {
    const sim = this.sim, minY = Math.cos(CFG.JUMP_SLOPE);
    let ok = false;
    sim.rapier.contactPairsWith(p.col, (o) => {
      if (ok) return;
      sim.rapier.contactPair(p.col, o, (man, flipped) => {
        if (ok || !man.numContacts()) return;
        let close = false;
        for (let i = 0, n = man.numContacts(); i < n; i++) if (man.contactDist(i) < 0.03) close = true;
        // the manifold's normal points from its first collider to its second: from p down into what it stands on
        const nm = man.normal(), sg = flipped ? 1 : -1, nx = nm.x * sg, ny = nm.y * sg, nz = nm.z * sg;
        if (close && ny >= minY) { ok = true; if (n) n.set(nx, ny, nz); }
      });
    });
    return ok;
  }

  ground(p, inp, dt, control, pressed, aim) {
    const sim = this.sim, body = p.body, t = body.translation(), v = body.linvel();
    const hit = sim.rapier.castRay(new sim.R.Ray(t, { x: 0, y: -1, z: 0 }), CFG.P_HALF + CFG.P_RADIUS + 0.12, true,
      undefined, undefined, undefined, body);
    p.grounded = !!hit;
    if (!control) { if (p.grounded) body.setLinvel({ x: v.x * 0.8, y: v.y, z: v.z * 0.8 }, true); return; }
    const speed = CFG.WALK * (p.inj >= INJ.HURT ? 0.45 : 1);
    const sy = Math.sin(inp.yaw), cy = Math.cos(inp.yaw);
    // yaw 0 looks toward -Z; forward = (-sin, 0, -cos), right = (cos, 0, -sin)
    let wx = (-sy * inp.my + cy * inp.mx) * speed, wz = (-cy * inp.my - sy * inp.mx) * speed;
    // dragging something that moves (loose wood, the chipper): lean into it rather than walk out of the hold.
    // Away from it, the feet go no faster than it follows, plus a little while the pull is under PULL_FORCE.
    const ln = p.grab && p.lean;
    if (ln) {
      const away = wx * ln.x + wz * ln.z, allow = Math.max(0, ln.v) + ((p.pull || 0) < CFG.PULL_FORCE ? 0.15 : 0);
      if (away > allow) { wx -= (away - allow) * ln.x; wz -= (away - allow) * ln.z; }
    }
    if (p.grounded) body.setLinvel({ x: wx, y: pressed.jump ? CFG.JUMP : v.y, z: wz }, true);
    // sliding on ground too steep to stand on (a ledge face): a jump still pushes off it, so a ledge just over
    // jump height can be scrambled up in two or three jumps; a wall (steeper than JUMP_SLOPE) gives no footing
    // (the push has nothing into the face: the feet push off it, not through it)
    else if (pressed.jump && (_c.set(0, 0, 0), this.footing(p, _c))) {
      const j = _b.set(wx, Math.max(v.y, CFG.JUMP), wz), into = j.dot(_c);
      if (into < 0) j.addScaledVector(_c, -into);
      body.setLinvel({ x: j.x, y: j.y, z: j.z }, true);
    }
    else body.setLinvel({ x: v.x + (wx - v.x) * 0.02, y: v.y, z: v.z + (wz - v.z) * 0.02 }, true);

    // what the buttons do depends on what is looked at (no tools)
    const rope = sim.rope;
    const nearDev = rope.nearDevice(p);
    let first = '';
    if (pressed.rig) rope.place(p, aim);
    const reach = aim && aim.dist < CFG.REACH;
    if (nearDev && rope.holder < 0 && !p.grab) {
      first = '{interact}: take the rope tail';
      if (pressed.interact) { p.mode = MODE.ROPE; rope.holder = p.id; }
    } else if (p.chips > 0 && !p.grab) {
      // hands full of chips: {interact} takes more off the pile looked at, while there is room, or puts them all down
      const pile = control ? sim.chipper.aimPile(p) : -1, room = p.chips < CFG.CHIP_CARRY - 1e-5;
      if (pressed.interact) { if (pile >= 0 && room) sim.chipper.take(p, pile); else sim.chipper.drop(p); p.chLock.add('lanyard'); }
      first = pile >= 0 && room ? '{interact}: pick up more chips' : '{interact}: put the chips down';
    } else {
      // {interact} toggles holding the wood. Letting go does not start a lanyard throw until the button is
      // released; a press that grabs standing wood and keeps being held goes on to throw the lanyard.
      // At the chipper: with wood in hand it feeds it in; at its grip it takes hold of the chipper.
      const ca = control ? sim.chipper.aim(p) : null, atChip = ca && ca.dist < CFG.REACH;
      const pile = control && !p.grab ? sim.chipper.aimPile(p) : -1;      // a chip pile within reach
      const wood = p.grab && !p.grab.chip ? sim.world.segs.get(p.grab.seg) : null;
      const loose = wood && !sim.world.pieces.get(wood.piece).fixed;
      if (pressed.interact && wood && atChip) {
        if (loose) { sim.chipper.feed(wood.piece, wood.id, p.grab.p); p.grab = null; p.chLock.add('lanyard'); }
        else this.say(p, 'Only loose wood can go in the chipper');
      } else if (pressed.interact && p.grab) { p.grab = null; p.chLock.add('lanyard'); }
      else if (pressed.interact && atChip && ca.grip) this.grabChipper(p, ca);
      else if (pressed.interact && pile >= 0) { sim.chipper.take(p, pile); p.chLock.add('lanyard'); }
      else if (pressed.interact && reach) this.grabStart(p, aim);
      if (wood && atChip) first = loose ? '{interact}: feed it into the chipper' : 'Only loose wood can go in the chipper';
      else if (p.grab) first = p.grab.chip ? '{interact}: let go of the chipper   {move}: tow it' : '{interact}: let go of the wood';
      else if (atChip && sim.chipper.seized()) first = 'The chipper\'s rollers have seized on wood too heavy for it: saw it smaller';
      else if (atChip) first = ca.grip ? '{interact}: take hold of the chipper' : 'Chipper: grab a limb, then {interact} here to feed it in. Its grip is at the front';
      else if (pile >= 0) first = '{interact}: pick up chips';
      else first = reach ? '{interact}: grab the wood' : '';
    }
    if (reach && !(nearDev && rope.holder < 0 && !p.grab)) {
      const s = sim.world.segs.get(aim.seg), piece = sim.world.pieces.get(s.piece);
      if (piece.fixed && p.inj < INJ.HURT) {
        const loc = sim.segToLocal(s, aim.point), tt = Math.min(1, Math.max(0, segParam(s, loc)));
        if (segRadius(s, tt) >= CFG.SPUR_MIN_R) {
          if (!p.chLock.has('lanyard')) first += '   hold {interact}: spur in and throw the lanyard round';
          if (this.hold(p, 'lanyard', inp.hi, CFG.LANYARD_TIME, dt)) {
            const ax = segAxis(s), c = lerp3(s.a, s.b, tt);
            // side = from the stem toward the player, perpendicular to the stem
            const bt = p.body.translation(), pl = sim.segToLocal(s, bt);
            let side = [pl[0] - c[0], pl[1] - c[1], pl[2] - c[2]];
            const d = side[0] * ax[0] + side[1] * ax[1] + side[2] * ax[2];
            side = perp(side.map((x, i) => x - ax[i] * d), ax);
            this.toClimb(p, s.id, tt, side);
          }
        }
      } else if (piece.fixed) first += '   (too hurt to climb)';
    }
    if (p.ch && p.ch.kind === 'lanyard') first = 'keep holding {interact}: spur in and throw the lanyard round';
    this.grabStep(p, dt);
    p.prompt = this.extras(p, aim, first);
  }

  climb(p, inp, dt, control, pressed, aim) {
    const sim = this.sim, w = sim.world, cl = p.cl;
    let s = w.segs.get(cl.seg);
    if (!s) { this.toGround(p); return; }
    const fixed = w.pieces.get(s.piece).fixed;
    // wood that has cracked but is still held by fibres can be climbed on; wood that has come free is a ride
    const held = sim.structure.isHeld(s.piece);
    if (!held && !p.ride) p.ride = { max: 0, still: 0, prev: null };
    if (held) p.ride = null;
    // letting go of the lanyard is letting go of the tree: it takes a held {drop}, so a stray press cannot kill
    if (this.hold(p, 'letgo', control && inp.hd, CFG.LETGO_TIME, dt)) {
      const v = fixed ? null : sim.bodies.get(s.piece).velocityAtPoint(p.body.translation()); this.toGround(p, v); return;
    }
    let first = '';
    if (control && pressed.rig) sim.rope.place(p, aim);
    if (control && !p.ride && aim && aim.dist < CFG.REACH) {
      // throw the lanyard round another stem within reach: the way past a union
      const s2 = w.segs.get(aim.seg), loc = sim.segToLocal(s2, aim.point), t2 = Math.min(1, Math.max(0, segParam(s2, loc)));
      if (w.pieces.get(s2.piece).fixed && segRadius(s2, t2) >= CFG.SPUR_MIN_R && (s2.id !== s.id || Math.abs(t2 - cl.t) * segLen(s) > 0.3)) {
        first = 'hold {interact}: move the lanyard here';
        if (this.hold(p, 'lanyard', inp.hi, CFG.LANYARD_TIME, dt)) {
          const c = lerp3(s2.a, s2.b, t2), pl = sim.segToLocal(s2, p.body.translation());
          cl.seg = s2.id; cl.t = t2; cl.side = perp([pl[0] - c[0], pl[1] - c[1], pl[2] - c[2]], segAxis(s2));
          s = s2;
        }
      }
    }

    if (control && !p.ride) {
      let ax = segAxis(s), L = segLen(s);
      const axW = sim.segDirToWorld(s, ax, _a);
      const look = _b.set(-Math.sin(inp.yaw), 0, -Math.cos(inp.yaw));
      const sign = axW.dot(_c.copy(UP).addScaledVector(look, 0.6)) >= 0 ? 1 : -1;
      // around the stem
      const r = segRadius(s, cl.t);
      const ang = inp.mx * sign * CFG.AROUND * dt / (r + CFG.STANDOFF);
      if (ang) cl.side = rotateAbout(cl.side, ax, ang);
      // along the stem
      let t = cl.t + inp.my * sign * CFG.CLIMB * dt / L;
      if (t > cl.t && segRadius(s, Math.min(1, t)) < CFG.SPUR_MIN_R) { t = cl.t; this.say(p, 'Too thin for spurs'); }
      if (t > 1) {
        // the lanyard only slides on along the same stem; onto a branch it has to be thrown ({interact})
        const next = w.stemNext(s.id), block = w.kids(s.id).some((k) => k !== next && w.isRealBranch(k));
        if (!w.kids(s.id).length) { this.offTheEnd(p, s, fixed); return; }
        if (!next) { t = 1; this.say(p, 'The stem ends here. Look at a branch and hold {interact} to move the lanyard onto it'); }
        else if (w.segs.get(next).r0 < CFG.SPUR_MIN_R) { t = 1; this.say(p, 'Too thin for spurs'); }
        else if (block) { t = 1; this.say(p, 'The lanyard stops at the union. Look at the stem you want and hold {interact} to move it'); }
        else { s = w.segs.get(next); cl.seg = next; t = 0.01; cl.side = perp(cl.side, segAxis(s)); }
      } else if (t < 0) {
        if (s.parent < 0) {
          // the bottom of the wood: stepping off onto the ground, or off the end of a hanging piece
          if (sim.segToWorld(s, s.a, _b).y < sim.groundY(_b.x, _b.z) + 0.6) this.toGround(p); else this.offTheEnd(p, s, fixed);
          return;
        }
        const up = w.stemNext(s.parent), block = w.kids(s.parent).some((k) => k !== s.id && w.isRealBranch(k));
        if (up !== s.id || block) { t = 0; this.say(p, 'The lanyard stops at the union. Look at the stem you want and hold {interact} to move it'); }
        else { s = w.segs.get(s.parent); cl.seg = s.id; t = 0.99; cl.side = perp(cl.side, segAxis(s)); }
      }
      cl.t = t;
    }

    // pose derived from (segment, t, side)
    const c = lerp3(s.a, s.b, cl.t), d = segRadius(s, cl.t) + CFG.STANDOFF;
    const pos = sim.segToWorld(s, [c[0] + cl.side[0] * d, c[1] + cl.side[1] * d, c[2] + cl.side[2] * d], _a);
    p.body.setNextKinematicTranslation(pos);
    if (held) {
      // the climber's weight goes into whatever wood the spurs are in; moving bounces it
      const dyn = control && (inp.mx || inp.my) ? CFG.CLIMB_BOUNCE : 1;
      // The climber is a force here, not a mass. So that their weight cannot drive light wood down faster
      // than they could fall themselves, it fades out as the wood under them accelerates downward.
      const vy = (pos.y - (cl.py ?? pos.y)) / dt, ay = (vy - (cl.vy ?? vy)) / dt;
      cl.py = pos.y; cl.vy = vy; cl.ad = (cl.ad || 0) + 0.1 * (-ay - (cl.ad || 0));
      const share = fixed ? 1 : Math.max(0, Math.min(1, 1 - cl.ad / CFG.GRAVITY));
      sim.applyForce(s.id, sim.segToWorld(s, c, _b), _c.set(0, -CFG.P_MASS * CFG.GRAVITY * dyn * share, 0));
      p.prompt = (control ? this.extras(p, aim, first) + '   ' : '') + '{move}: climb   hold {drop}: let go of the tree';
    } else {
      // riding a falling piece because we are lanyarded to it
      const rd = p.ride;
      if (rd.prev) {
        const sp = pos.distanceTo(rd.prev) / dt;
        rd.max = Math.max(rd.max, sp);
        rd.still = sp < 0.4 ? rd.still + 1 : 0;
        if (rd.still > 20 && rd.max > 1) {
          const dv = rd.max; this.toGround(p);
          sim.toast(`You rode it down at ${dv.toFixed(1)} m/s`, p.id);
          this.impact(p, dv);
          return;
        }
      }
      rd.prev = pos.clone();
      p.prompt = 'Lanyarded to a falling piece!   hold {drop}: let go';
    }
  }

  /** Climbed past the end of the wood: the lanyard comes off it and the climber falls. */
  offTheEnd(p, s, fixed) {
    const v = fixed ? null : this.sim.bodies.get(s.piece).velocityAtPoint(p.body.translation());
    this.toGround(p, v);
    this.sim.toast('You climbed off the end of the wood and the lanyard came off', p.id);
  }

  // ---- after physics: read impacts on dynamic players ----
  post(dt) {
    for (const p of this.list.values()) {
      if (p.mode === MODE.CLIMB) continue;
      const v = p.body.linvel();
      const dv = Math.hypot(v.x - p.vPre.x, v.y - p.vPre.y, v.z - p.vPre.z);
      if (dv > CFG.DV_SHAKEN) this.impact(p, dv);
      const t = p.body.translation();
      if (t.y < this.sim.groundY(t.x, t.z) - 20) this.toSpawn(p);
    }
  }

  aux() {
    const out = [];
    for (const p of this.list.values()) {
      const s = p.saw;
      out.push({
        id: p.id, m: p.mode, inj: p.inj, ck: +(p.chips || 0).toFixed(4), gr: p.grab ? [p.grab.chip ? -1 : p.grab.seg, ...p.grab.p.map((x) => +x.toFixed(3))] : 0, ch: p.ch ? +Math.min(1, p.ch.t / Math.max(1e-3, p.ch.need)).toFixed(2) : 0, yaw: +p.input.yaw.toFixed(2), pr: p.prompt,
        cl: p.cl ? [p.cl.seg, +p.cl.t.toFixed(3), p.cl.side.map((x) => +x.toFixed(3))] : 0,
        saw: s.on ? [...s.A.toArray(), ...s.b.toArray(), ...s.f.toArray(), s.stuck ? 1 : 0, s.cutting ? 1 : 0, CFG.BAR_LEN].map((x) => +x.toFixed(3)) : 0,
      });
    }
    return out;
  }
}

function rotateAbout(v, ax, ang) {
  const c = Math.cos(ang), s = Math.sin(ang), d = v[0] * ax[0] + v[1] * ax[1] + v[2] * ax[2];
  const cr = [ax[1] * v[2] - ax[2] * v[1], ax[2] * v[0] - ax[0] * v[2], ax[0] * v[1] - ax[1] * v[0]];
  return perp([v[0] * c + cr[0] * s + ax[0] * d * (1 - c), v[1] * c + cr[1] * s + ax[1] * d * (1 - c), v[2] * c + cr[2] * s + ax[2] * d * (1 - c)], ax);
}
