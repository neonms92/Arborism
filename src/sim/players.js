// Players on the host: bodies, walking, spur climbing on a lanyard,
// interaction, injury thresholds. See docs/DESIGN.md section 6.
// Prompts use {tokens} that each client's HUD turns into the right key or button name.

import * as THREE from '../../vendor/three/three.module.js';
import { CFG, INJ, MODE } from '../config.js';
import { segLen, segAxis, segRadius, segParam, lerp3, perp, cleanName, cleanColor, playerName } from '../model/world.js';
import { sawStep, sawOff } from './saw.js';

// respawn, buyChip and buyBin are the Tab menu's "Respawn player", "Buy a new chipper" and "Buy a new chip bin" buttons (no key or button of their own)
const COUNTERS = ['jump', 'interact', 'drop', 'rig', 'punch', 'wrapUp', 'wrapDn', 'respawn', 'buyChip', 'buyBin'];
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

  /** name and color as the player chose them (cleaned here; '' / -1 when none). */
  add(id, name, color = -1) {
    const sim = this.sim, R = sim.R;
    const ang = id * 1.3, sp = [4 * Math.cos(ang), 1.2, 4 * Math.sin(ang)];       // spawn y is above the ground there
    sp[1] += sim.groundY(sp[0], sp[2]);
    const body = sim.rapier.createRigidBody(sim.dynamic().setTranslation(sp[0], sp[1], sp[2]).lockRotations());
    const col = sim.rapier.createCollider(R.ColliderDesc.capsule(CFG.P_HALF, CFG.P_RADIUS).setMass(CFG.P_MASS)
      .setFriction(0).setFrictionCombineRule(R.CoefficientCombineRule.Min).setActiveEvents(R.ActiveEvents.CONTACT_FORCE_EVENTS).setContactForceEventThreshold(300), body);
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
      held: '',                      // what is in the other hand: '' or 'salad' (a tube salad off a chipper's rack)
      rtPrev: 0,                     // {throttle} last tick, for its press (eating)
    };
    this.list.set(id, p);
    sim.emit({ t: 'player', id, name: cleanName(name), color: cleanColor(color) });
    return p;
  }
  /** A player picked a name and shirt colour in the lobby (a joining client sends them once it is in). */
  setLook(id, name, color) {
    if (!this.list.has(id)) return;
    this.sim.emit({ t: 'player', id, name: cleanName(name), color: cleanColor(color) });
  }
  name(id) { return playerName(this.sim.world, id); }
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
    // any injury shakes first: a pause with no control (the view swims, view.js)
    p.shakenT = Math.max(p.shakenT, CFG.SHAKEN_TIME);
    if (lvl === INJ.SHAKEN) { if (p.inj < INJ.SHAKEN) p.inj = INJ.SHAKEN; }
    else if (lvl > p.inj) {
      p.inj = lvl;
      this.sim.toast(lvl === INJ.DOWN ? `${this.name(p.id)} is DOWN ({speed:${dv.toFixed(1)}} impact)` : `${this.name(p.id)} is hurt ({speed:${dv.toFixed(1)}} impact)`);
    }
    sawOff(this.sim, p);
    if (p.mode === MODE.CLIMB && lvl >= INJ.HURT) this.toGround(p);
    if (p.mode === MODE.ROPE) this.leaveRope(p);
  }
  // ---- tube salads: off a chipper's rack, eaten ({throttle}) or given to another player ({interact}) ----
  /** A tube salad: p is as good as new, even from DOWN (a downed player gets back up where they lie). */
  heal(p) {
    p.inj = INJ.OK; p.shakenT = 0; p.hit = 0;
  }
  /** The player p is looking at within reach (their body), or null. */
  aimPlayer(p) {
    const sim = this.sim, { o, d } = sim.eye(p);
    const hit = sim.rapier.castRay(new sim.R.Ray(o, d), CFG.REACH, true, undefined, undefined, undefined, p.body);
    const id = hit ? sim.colPlayer.get(hit.collider.handle) : undefined;
    return id === undefined ? null : this.list.get(id) || null;
  }
  /** Holding a salad: {interact} on a player in reach gives it to them, {throttle} (not sawing) eats it. Returns the prompt part. */
  salad(p, inp, pressed) {
    const eat = inp.rt > 0.5 && p.rtPrev <= 0.5 && !p.saw.on;
    if (!p.held) return '';
    const o = this.aimPlayer(p);
    if (o && pressed.interact) {
      p.held = ''; pressed.interact = false; p.chLock.add('lanyard');
      const was = o.inj;
      this.heal(o);
      this.sim.toast(`${this.name(p.id)} gave ${this.name(o.id)} a tube salad` + (was === INJ.DOWN ? `: ${this.name(o.id)} is back up` : ''));
      return '';
    }
    if (eat) {
      p.held = ''; const was = p.inj; this.heal(p);
      this.sim.toast(was > INJ.SHAKEN ? 'You ate a tube salad: good as new' : 'You ate a tube salad', p.id);
      return '';
    }
    return (o ? '{interact}: give salad' : '') + (p.saw.on ? '' : (o ? '   ' : '') + '{eat}: eat salad');
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
    this.sim.toast(by === p ? 'You cut your own lanyard' : `${this.name(by.id)} cut ${this.name(p.id)}'s lanyard`);
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
    p.grab = { chip: 1, k: ca.u.k, p: ca.local, L0: Math.max(0.2, this.hands(p, _a).distanceTo(ca.point)), prev: 0 };
  }
  /** Take hold of chip bin k's handle bar (bin-local point on it). */
  grabBin(p, bn) {
    p.grab = { bin: bn.k, p: bn.local, L0: Math.max(0.2, this.hands(p, _a).distanceTo(bn.point)), prev: 0 };
  }
  grabStep(p, dt) {
    const g = p.grab, sim = this.sim; p.pull = 0; if (!g) return;
    const ch = g.chip ? sim.chipper.unit(g.k) : null, bin = g.bin !== undefined ? sim.bins.unit(g.bin) : null;
    if (g.bin !== undefined) {
      // a chip bin by its handle: held like the chipper's grip (below), with arms as stiff as its weight allows
      if (!bin) { p.grab = null; return; }
      return this.holdBody(p, g, bin.body, sim.bins.toWorld(g.bin, g.p, _b), Math.min(CFG.P_MASS, bin.body.mass()), dt, 'The bin pulled out of your hands');
    }
    const s = g.chip ? null : sim.world.segs.get(g.seg);
    if (g.chip ? !ch || !ch.body : !s) { p.grab = null; return; }
    const h = this.hands(p, _a), w = g.chip ? ch.toWorld(g.p, _b) : sim.segToWorld(s, g.p, _b);
    const dir = _c.copy(h).sub(w), len = dir.length();
    const stretch = len - g.L0, rate = (stretch - g.prev) / dt; g.prev = stretch;
    const piece = g.chip ? null : sim.world.pieces.get(s.piece);
    if (len < 1e-6) return;
    // The arms: a stiff spring from the hands to the point held, at the length it was taken hold at. It pulls when
    // stretched and pushes when squeezed. Walking away from it or into it, the legs (LEG_FORCE) give way before the
    // hold does (GRAB_MAX), so pushing and pulling what is held are the same and the walk speed sorts itself out.
    const m = g.chip || piece.fixed ? CFG.P_MASS : Math.min(CFG.P_MASS, sim.bodies.get(s.piece).mass());
    const k = Math.min(CFG.GRAB_K, CFG.ROPE_KCAP * m / (dt * dt)), c = 2 * CFG.ROPE_DAMP * Math.sqrt(k * m);
    // > 0 pulls the two together, < 0 pushes them apart. Squeezed harder than GRAB_MAX, the arms fold rather than let go.
    const T = Math.max(-CFG.GRAB_MAX, k * stretch + c * rate);
    p.pull = T;
    // what tears it out of the hands is a pull kept up (over about GRAB_TAU), not a one-tick jolt of the spring's damping
    g.held = (g.held || 0) + (Math.max(0, T) - (g.held || 0)) * Math.min(1, dt / Math.max(dt, CFG.GRAB_TAU));
    if (g.held > CFG.GRAB_MAX) { p.grab = null; p.pull = 0; this.say(p, g.chip ? 'The chipper pulled out of your hands' : 'The wood pulled out of your hands'); return; }
    dir.divideScalar(len);
    // a push goes level from the hands (arms push forward, not down into the ground through what they hold)
    if (T < 0) { const hl = Math.hypot(dir.x, dir.z); if (hl > 0.2) dir.set(dir.x / hl, 0, dir.z / hl); }
    if (g.chip) ch.body.applyImpulseAtPoint({ x: dir.x * T * dt, y: dir.y * T * dt, z: dir.z * T * dt }, w, true);   // chipper pulled toward the hands
    else sim.applyForce(s.id, w, dir.clone().multiplyScalar(T));               // wood pulled toward the hands
    p.body.applyImpulse({ x: -dir.x * T * dt, y: -dir.y * T * dt, z: -dir.z * T * dt }, true);   // and the hands toward the wood
    // Steering: walking with it, the hands also keep it on the line of the walk: behind when walking away from it,
    // ahead when pushing it, so a drawbar or a log follows the path (a hitch held by one point would jackknife),
    // with at most LEG_FORCE across the arms. Only for what can move: on standing wood the arms only pull or push.
    const mover = g.chip ? ch.body : piece.fixed ? null : sim.bodies.get(s.piece);
    const rx = w.x - h.x, rz = w.z - h.z, rl = Math.hypot(rx, rz), wk = p.walk;
    if (!mover || rl < 0.1 || !wk) return;
    const along = (rx * wk.x + rz * wk.z) / rl;
    if (Math.abs(along) < 0.3) return;                // walking across it: nothing to keep it in line with
    const tx = Math.sign(along) * wk.x, tz = Math.sign(along) * wk.z;
    const ux = rx / rl, uz = rz / rl, ex = h.x + tx * rl - w.x, ez = h.z + tz * rl - w.z;
    const er = ex * ux + ez * uz, lx = ex - ux * er, lz = ez - uz * er;          // the error across the arms
    const vm = mover.velocityAtPoint(w), vp = p.body.linvel();
    const dvx = vm.x - vp.x, dvz = vm.z - vp.z, dvr = dvx * ux + dvz * uz;
    let fx = CFG.GRAB_STEER * lx - 2 * Math.sqrt(CFG.GRAB_STEER * m) * (dvx - ux * dvr);
    let fz = CFG.GRAB_STEER * lz - 2 * Math.sqrt(CFG.GRAB_STEER * m) * (dvz - uz * dvr);
    const fl = Math.hypot(fx, fz); if (fl > CFG.LEG_FORCE) { fx *= CFG.LEG_FORCE / fl; fz *= CFG.LEG_FORCE / fl; }
    if (g.chip) ch.body.applyImpulseAtPoint({ x: fx * dt, y: 0, z: fz * dt }, w, true);
    else sim.applyForce(s.id, w, new THREE.Vector3(fx, 0, fz));
    p.body.applyImpulse({ x: -fx * dt, y: 0, z: -fz * dt }, true);
  }

  /** The arms holding a loose body (not wood) at world point w: the same spring and steering as grabStep's. */
  holdBody(p, g, body, w, m, dt, lost) {
    const h = this.hands(p, _a), dir = _c.copy(h).sub(w), len = dir.length();
    const stretch = len - g.L0, rate = (stretch - g.prev) / dt; g.prev = stretch;
    if (len < 1e-6) return;
    const k = Math.min(CFG.GRAB_K, CFG.ROPE_KCAP * m / (dt * dt)), c = 2 * CFG.ROPE_DAMP * Math.sqrt(k * m);
    const T = Math.max(-CFG.GRAB_MAX, k * stretch + c * rate);
    p.pull = T;
    g.held = (g.held || 0) + (Math.max(0, T) - (g.held || 0)) * Math.min(1, dt / Math.max(dt, CFG.GRAB_TAU));
    if (g.held > CFG.GRAB_MAX) { p.grab = null; p.pull = 0; this.say(p, lost); return; }
    dir.divideScalar(len);
    if (T < 0) { const hl = Math.hypot(dir.x, dir.z); if (hl > 0.2) dir.set(dir.x / hl, 0, dir.z / hl); }
    body.applyImpulseAtPoint({ x: dir.x * T * dt, y: dir.y * T * dt, z: dir.z * T * dt }, w, true);
    p.body.applyImpulse({ x: -dir.x * T * dt, y: -dir.y * T * dt, z: -dir.z * T * dt }, true);
    const rx = w.x - h.x, rz = w.z - h.z, rl = Math.hypot(rx, rz), wk = p.walk;
    if (rl < 0.1 || !wk) return;
    const along = (rx * wk.x + rz * wk.z) / rl;
    if (Math.abs(along) < 0.3) return;
    const tx = Math.sign(along) * wk.x, tz = Math.sign(along) * wk.z;
    const ux = rx / rl, uz = rz / rl, ex = h.x + tx * rl - w.x, ez = h.z + tz * rl - w.z;
    const er = ex * ux + ez * uz, lx = ex - ux * er, lz = ez - uz * er;
    const vm = body.velocityAtPoint(w), vp = p.body.linvel();
    const dvx = vm.x - vp.x, dvz = vm.z - vp.z, dvr = dvx * ux + dvz * uz;
    let fx = CFG.GRAB_STEER * lx - 2 * Math.sqrt(CFG.GRAB_STEER * m) * (dvx - ux * dvr);
    let fz = CFG.GRAB_STEER * lz - 2 * Math.sqrt(CFG.GRAB_STEER * m) * (dvz - uz * dvr);
    const fl = Math.hypot(fx, fz); if (fl > CFG.LEG_FORCE) { fx *= CFG.LEG_FORCE / fl; fz *= CFG.LEG_FORCE / fl; }
    body.applyImpulseAtPoint({ x: fx * dt, y: 0, z: fz * dt }, w, true);
    p.body.applyImpulse({ x: -fx * dt, y: 0, z: -fz * dt }, true);
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
    if (p.replay) { for (const k in p.replay) pressed[k] = pressed[k] || p.replay[k]; p.replay = null; }   // a press that woke a tree (below)
    // two movement keys at once: the same speed as one (no faster on the diagonal)
    const mv = Math.hypot(inp.mx, inp.my); if (mv > 1) { inp.mx /= mv; inp.my /= mv; }
    if (p.toastT > 0) p.toastT -= dt;
    if (p.shakenT > 0) { p.shakenT -= dt; if (p.shakenT <= 0 && p.inj === INJ.SHAKEN) p.inj = INJ.OK; }
    if (p.hit) { const dv = p.hit; p.hit = 0; this.impact(p, dv); }

    if (pressed.buyChip) sim.chipper.buy(p);
    if (pressed.respawn) {
      sawOff(sim, p); if (p.mode === MODE.ROPE) this.leaveRope(p);
      this.toGround(p); p.grab = null;
      p.inj = INJ.OK; p.shakenT = 0;
      this.toSpawn(p);
      p.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    }
    if (pressed.buyBin) sim.bins.buy(p);          // the Tab menu's "Buy a new chip bin": put down in front of them
    const control = p.inj < INJ.DOWN && p.shakenT <= 0;
    const aim = control ? sim.aim(p) : null;
    p.prompt = '';
    // one of the other trees in the yards, still without wood of its own (sim/stands.js): starting to saw it
    // (holding {raise}), climb or grab it ({interact}) or rig it ({rig}) grows its wood. Rapier only finds the new
    // colliders after the next step, so the press that did it is handed on to the next tick.
    const stand = control && !aim && p.mode !== MODE.ROPE ? sim.stands.aim(p, Math.max(CFG.REACH, CFG.SAW_REACH)) : null;
    let standHint = '';
    if (stand) {
      const sawIt = inp.lt >= 0.3 && stand.dist <= CFG.SAW_REACH, near = stand.dist < CFG.REACH;
      if (sawIt || (near && (pressed.interact || pressed.rig))) {
        sim.stands.wake(stand.i);
        p.replay = { interact: pressed.interact, rig: pressed.rig };
        pressed.interact = pressed.rig = false;
      } else if (near) standHint = (stand.dist <= CFG.SAW_REACH ? '{raise}: plant saw   ' : '') + '{interact}: grab   hold {interact}: spur in   {rig}: hang block';
    }
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
      p.prompt = '{throttle}: ease   {raise}: haul   {wraps}: wraps   {interact}: tie off';
      sim.rope.operate(p, inp, pressed, dt);
      if (pressed.interact || !control) this.leaveRope(p);
      p.body.setLinvel({ x: 0, y: p.body.linvel().y, z: 0 }, true);
    } else if (p.mode === MODE.CLIMB) {
      this.climb(p, inp, dt, control, pressed, aim);
    } else {
      this.ground(p, inp, dt, control, pressed, aim);
    }
    if (standHint && !p.grab && p.mode === MODE.GROUND) p.prompt = standHint;
    if (p.ch && !p.ch.seen) p.ch = null;          // the action stopped being possible: start again
    p.rtPrev = inp.rt;
    const v = p.body.linvel(); p.vPre.set(v.x, v.y, v.z);
  }

  /** What else the wood (or rope) looked at offers, appended to a prompt. */
  extras(p, aim, first) {
    const out = first ? [first] : [];
    const r = this.sim.rope.prompt(p, aim); if (r) out.push(r);
    if (aim && aim.dist < CFG.REACH) out.push('{punch}: punch');
    if (!p.saw.on && aim && aim.dist <= CFG.SAW_REACH && !p.ride) out.push('{raise}: plant saw');
    return out.join('   ');
  }

  /** Is p touching anything under it no steeper than slope (default JUMP_SLOPE: something to push a jump off)? n: set to its normal. */
  footing(p, n, slope = CFG.JUMP_SLOPE) {
    const sim = this.sim, minY = Math.cos(slope);
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
    // standing: ground under the middle, or anything under the body no steeper than WALK_SLOPE (the side of a ditch)
    p.grounded = !!hit || this.footing(p, null, CFG.WALK_SLOPE);
    if (!control) { if (p.grounded) body.setLinvel({ x: v.x * 0.8, y: v.y, z: v.z * 0.8 }, true); return; }
    const speed = CFG.WALK * (p.inj >= INJ.HURT ? 0.45 : 1);
    const sy = Math.sin(inp.yaw), cy = Math.cos(inp.yaw);
    // yaw 0 looks toward -Z; forward = (-sin, 0, -cos), right = (cos, 0, -sin)
    let wx = (-sy * inp.my + cy * inp.mx) * speed, wz = (-cy * inp.my - sy * inp.mx) * speed;
    const wl = Math.hypot(wx, wz); p.walk = wl > 0.1 && p.grounded ? { x: wx / wl, z: wz / wl } : null;   // for grabStep's steering
    if (p.grounded) {
      // The legs: they push the body toward the walking velocity with at most LEG_FORCE across the ground. The body
      // has no friction of its own, so this is all its traction: what it pushes or pulls (the chipper, a log) gets
      // that force at most, either way, and what pulls on it (a held rope) moves it once past that.
      const jx = CFG.P_MASS * (wx - v.x), jz = CFG.P_MASS * (wz - v.z), jl = Math.hypot(jx, jz), cap = CFG.LEG_FORCE * dt;
      const f = jl > cap ? cap / jl : 1;
      body.applyImpulse({ x: jx * f, y: 0, z: jz * f }, true);
      if (pressed.jump) { const u = body.linvel(); body.setLinvel({ x: u.x, y: CFG.JUMP, z: u.z }, true); }
    }
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
    // a tube salad in hand goes first: {interact} on another player gives it to them (it takes the press)
    const sal = this.salad(p, inp, pressed);
    if (nearDev && rope.holder < 0 && !p.grab) {
      first = '{interact}: take tail';
      if (pressed.interact) { p.mode = MODE.ROPE; rope.holder = p.id; }
    } else if (p.chips > 0 && !p.grab) {
      // hands full of chips: {interact} takes more off the pile looked at, while there is room, or puts them all down
      // At a chip bin: open, they are tipped in (and gone: it has no bottom); shut, the press opens its lid first.
      const pile = control ? sim.chipper.aimPile(p) : -1, room = p.chips < CFG.CHIP_CARRY - 1e-5;
      const bn = control ? sim.bins.aim(p) : null, bOpen = bn && sim.bins.open(bn.k);
      if (pressed.interact) {
        if (bn && bOpen) { sim.emit({ t: 'chips', dump: +p.chips.toFixed(5) }); p.chips = 0; }
        else if (bn) sim.bins.toggle(bn.k);
        else if (pile >= 0 && room) sim.chipper.take(p, pile); else sim.chipper.drop(p);
        p.chLock.add('lanyard');
      }
      first = bn ? (bOpen ? '{interact}: tip in' : '{interact}: open lid') : pile >= 0 && room ? '{interact}: more chips' : '{interact}: drop chips';
    } else {
      // {interact} toggles holding the wood. Letting go does not start a lanyard throw until the button is
      // released; a press that grabs standing wood and keeps being held goes on to throw the lanyard.
      // At the chipper: with wood in hand it feeds it in; at its grip it takes hold of the chipper.
      const ca = control ? sim.chipper.aim(p) : null, atChip = ca && ca.dist < CFG.REACH;
      const atRack = atChip && ca.rack && !p.grab;
      const pile = control && !p.grab ? sim.chipper.aimPile(p) : -1;      // a chip pile within reach
      const bn = control && !p.grab ? sim.bins.aim(p) : null;              // a chip bin within reach: its lid or its handle
      const wood = p.grab && !p.grab.chip ? sim.world.segs.get(p.grab.seg) : null;
      const loose = wood && !sim.world.pieces.get(wood.piece).fixed;
      if (pressed.interact && wood && atChip) {
        if (loose) { ca.u.feed(wood.piece, wood.id, p.grab.p); p.grab = null; p.chLock.add('lanyard'); }
        else this.say(p, 'Only loose wood can go in the chipper');
      } else if (pressed.interact && p.grab) { p.grab = null; p.chLock.add('lanyard'); }
      else if (pressed.interact && atRack) {
        if (!p.held) { p.held = 'salad'; this.say(p, 'A tube salad: {eat} eats it, {interact} on someone gives it to them'); }
        p.chLock.add('lanyard');
      }
      else if (pressed.interact && atChip && ca.grip) this.grabChipper(p, ca);
      else if (pressed.interact && bn && bn.part === 'lid') { sim.bins.toggle(bn.k); p.chLock.add('lanyard'); }
      else if (pressed.interact && bn && bn.part === 'handle') this.grabBin(p, bn);
      else if (pressed.interact && pile >= 0) { sim.chipper.take(p, pile); p.chLock.add('lanyard'); }
      else if (pressed.interact && reach) this.grabStart(p, aim);
      // the weight of the wood in hand, or of loose wood looked at, goes on the button (nothing for wood still on the tree)
      const kg = (piece) => { const m = sim.weightOf(piece); return isFinite(m) ? ` {mass:${Math.round(m)}}` : ''; };
      if (wood && atChip) first = loose ? '{interact}: feed' + kg(wood.piece) : 'Only loose wood can go in the chipper';
      else if (p.grab) first = p.grab.chip || p.grab.bin !== undefined ? '{interact}: let go   {move}: tow' : '{interact}: let go' + (wood ? kg(wood.piece) : '');
      else if (atRack) first = p.held ? '' : '{interact}: take salad';
      else if (atChip && ca.u.seized()) first = 'The chipper\'s rollers have seized on wood too heavy for it: saw it smaller';
      else if (atChip) first = ca.grip ? '{interact}: grab chipper' : 'Chipper: grab a limb, then {interact|feed} here to feed it in. Its grip is at the front';
      else if (bn) first = bn.part === 'lid' ? (sim.bins.lidAngle(bn.k) > 2 ? '{interact}: shut lid' : '{interact}: open lid')
        : bn.part === 'handle' ? '{interact}: grab bin' : 'Chip bin: {interact} on its lid opens it, its handle moves it. Chips in it are gone';
      else if (pile >= 0) first = '{interact}: take chips';
      else first = reach ? '{interact}: grab' + kg(sim.world.segs.get(aim.seg).piece) : '';
    }
    if (reach && !(nearDev && rope.holder < 0 && !p.grab)) {
      const s = sim.world.segs.get(aim.seg), piece = sim.world.pieces.get(s.piece);
      if (piece.fixed && p.inj < INJ.HURT) {
        const loc = sim.segToLocal(s, aim.point), tt = Math.min(1, Math.max(0, segParam(s, loc)));
        if (segRadius(s, tt) >= CFG.SPUR_MIN_R) {
          if (!p.chLock.has('lanyard')) first += '   hold {interact}: spur in';
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
    if (p.ch && p.ch.kind === 'lanyard') first = 'keep holding {interact}: spur in';
    this.grabStep(p, dt);
    p.prompt = this.extras(p, aim, (sal && first ? sal + '   ' + first : sal || first));
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
        first = 'hold {interact}: move lanyard';
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
      // The end of the wood stops you once (D85): to climb off it, let go of {move} and push on again. A late
      // view (a joined client sees itself ~0.1-0.2 s behind) can then never carry anyone off the top unawares.
      const push = Math.sign(inp.my * sign);
      if (cl.end && push !== cl.end) cl.armed = true;
      if (cl.end && (cl.end > 0 ? t < 1 - 0.3 / L : t > 0.3 / L)) cl.end = cl.armed = 0;
      const endStop = (dir) => {
        if (cl.end === dir && cl.armed) return false;
        cl.end = dir; cl.armed = false;
        this.say(p, 'The end of the wood. Let go of {move} and push on again to climb off it');
        return true;
      };
      if (t > cl.t && segRadius(s, Math.min(1, t)) < CFG.SPUR_MIN_R) { t = cl.t; this.say(p, 'Too thin for spurs'); }
      if (t > 1) {
        // the lanyard only slides on along the same stem; onto a branch it has to be thrown ({interact})
        const next = w.stemNext(s.id), block = w.kids(s.id).some((k) => k !== next && w.isRealBranch(k));
        if (!w.kids(s.id).length) { if (endStop(1)) t = 1; else { this.offTheEnd(p, s, fixed); return; } }
        else if (!next) { t = 1; this.say(p, 'The stem ends here. Look at a branch and hold {interact} to move the lanyard onto it'); }
        else if (w.segs.get(next).r0 < CFG.SPUR_MIN_R) { t = 1; this.say(p, 'Too thin for spurs'); }
        else if (block) { t = 1; this.say(p, 'The lanyard stops at the union. Look at the stem you want and hold {interact} to move it'); }
        else { s = w.segs.get(next); cl.seg = next; t = 0.01; cl.side = perp(cl.side, segAxis(s)); }
      } else if (t < 0) {
        if (s.parent < 0) {
          // the bottom of the wood: stepping off onto the ground, or off the end of a hanging piece
          if (sim.segToWorld(s, s.a, _b).y < sim.groundY(_b.x, _b.z) + 0.6) { this.toGround(p); return; }
          if (endStop(-1)) t = 0; else { this.offTheEnd(p, s, fixed); return; }
        } else {
          const up = w.stemNext(s.parent), block = w.kids(s.parent).some((k) => k !== s.id && w.isRealBranch(k));
          if (up !== s.id || block) { t = 0; this.say(p, 'The lanyard stops at the union. Look at the stem you want and hold {interact} to move it'); }
          else { s = w.segs.get(s.parent); cl.seg = s.id; t = 0.99; cl.side = perp(cl.side, segAxis(s)); }
        }
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
      const sal = control ? this.salad(p, inp, pressed) : '';    // a salad can be eaten (or handed over) on spurs too
      p.prompt = (control ? this.extras(p, aim, sal && first ? sal + '   ' + first : sal || first) + '   ' : '') + '{move}: climb   hold {drop}: let go';
    } else {
      // riding a falling piece because we are lanyarded to it
      const rd = p.ride;
      if (rd.prev) {
        const sp = pos.distanceTo(rd.prev) / dt;
        rd.max = Math.max(rd.max, sp);
        rd.still = sp < 0.4 ? rd.still + 1 : 0;
        if (rd.still > 20 && rd.max > 1) {
          const dv = rd.max; this.toGround(p);
          sim.toast(`You rode it down at {speed:${dv.toFixed(1)}}`, p.id);
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
        id: p.id, m: p.mode, inj: p.inj, sk: p.shakenT > 0 ? 1 : 0, ck: +(p.chips || 0).toFixed(4), hd: p.held ? 1 : 0, gk: p.grab && p.grab.chip ? p.grab.k || 0 : 0, gr: p.grab ? [p.grab.chip ? -1 : p.grab.bin !== undefined ? -2 - p.grab.bin : p.grab.seg, ...p.grab.p.map((x) => +x.toFixed(3))] : 0, ch: p.ch ? +Math.min(1, p.ch.t / Math.max(1e-3, p.ch.need)).toFixed(2) : 0, yaw: +p.input.yaw.toFixed(2), pt: +p.input.pitch.toFixed(2), pr: p.prompt,
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
