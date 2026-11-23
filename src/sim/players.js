// Players on the host: bodies, walking, spur climbing on a lanyard,
// interaction, injury thresholds. See docs/DESIGN.md section 6.
// Prompts use {tokens} that each client's HUD turns into the right key or button name.

import * as THREE from '../../vendor/three/three.module.js';
import { CFG, INJ, TOOL, MODE } from '../config.js';
import { segLen, segAxis, segRadius, segParam, lerp3, perp } from '../model/world.js';
import { sawStep, sawOff } from './saw.js';

const COUNTERS = ['jump', 'interact', 'drop', 'toolNext', 'toolPrev', 'wrapUp', 'wrapDn', 'respawn'];
export function blankInput() {
  const c = {}; for (const k of COUNTERS) c[k] = 0;
  // sy, sp: how far the saw is swung from straight-ahead-and-level (rad)
  return { mx: 0, my: 0, yaw: 0, pitch: 0, sy: 0, sp: 0, rt: 0, lt: 0, c };
}
const UP = new THREE.Vector3(0, 1, 0);
const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3();

export class Players {
  constructor(sim) { this.sim = sim; this.list = new Map(); }

  add(id, name) {
    const sim = this.sim, R = sim.R;
    const ang = id * 1.3, sp = [4 * Math.cos(ang), 1.2, 4 * Math.sin(ang)];
    const body = sim.rapier.createRigidBody(R.RigidBodyDesc.dynamic().setTranslation(sp[0], sp[1], sp[2]).lockRotations());
    const col = sim.rapier.createCollider(R.ColliderDesc.capsule(CFG.P_HALF, CFG.P_RADIUS).setMass(CFG.P_MASS)
      .setFriction(0.2).setActiveEvents(R.ActiveEvents.CONTACT_FORCE_EVENTS).setContactForceEventThreshold(300), body);
    sim.colPlayer.set(col.handle, id);
    const p = {
      id, body, col, spawn: sp, input: blankInput(), last: { ...blankInput().c }, primed: false,
      mode: MODE.GROUND, tool: TOOL.HANDS, inj: INJ.OK, shakenT: 0, lan: false,
      cl: null,                // {seg, t, side:[3] piece-local unit, perpendicular to the stem}
      saw: { on: false }, grounded: false, vPre: new THREE.Vector3(), toastT: 0,
      ride: null, prompt: '',
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
    p.mode = MODE.CLIMB; p.cl = { seg: segId, t, side }; p.lan = true; p.ride = null;
    p.col.setSensor(false);
  }
  cutLanyard(p, by) {
    this.sim.toast(by === p ? 'You cut your own lanyard' : `Player ${by.id} cut player ${p.id}'s lanyard`);
    this.toGround(p);
  }
  /** All wood is gone: everyone is on the ground with empty hands on the tree. */
  onReset() {
    for (const p of this.list.values()) {
      sawOff(this.sim, p);
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

  // ---- per tick, before physics ----
  pre(dt) {
    for (const p of this.list.values()) this.prePlayer(p, dt);
  }

  prePlayer(p, dt) {
    const sim = this.sim, inp = p.input, w = sim.world;
    const pressed = {};
    for (const k of COUNTERS) { pressed[k] = p.primed && inp.c[k] !== p.last[k]; p.last[k] = inp.c[k]; }
    p.primed = true;
    if (p.toastT > 0) p.toastT -= dt;
    if (p.shakenT > 0) { p.shakenT -= dt; if (p.shakenT <= 0 && p.inj === INJ.SHAKEN) p.inj = INJ.OK; }
    if (p.hit) { const dv = p.hit; p.hit = 0; this.impact(p, dv); }

    if (pressed.respawn) {
      sawOff(sim, p); if (p.mode === MODE.ROPE) this.leaveRope(p);
      this.toGround(p);
      p.inj = INJ.OK; p.shakenT = 0;
      p.body.setTranslation({ x: p.spawn[0], y: p.spawn[1], z: p.spawn[2] }, true);
      p.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    }
    const control = p.inj < INJ.DOWN && p.shakenT <= 0;
    if (control && !p.saw.on && p.mode !== MODE.ROPE) {
      if (pressed.toolNext) p.tool = (p.tool + 1) % 3;
      if (pressed.toolPrev) p.tool = (p.tool + 2) % 3;
    }

    const aim = control ? sim.aim(p) : null;
    p.prompt = '';

    // chainsaw: {raise} plants it on the wood looked at; look controls pivot it, {throttle} presses it in
    const canSaw = control && p.tool === TOOL.SAW && p.mode !== MODE.ROPE && !p.ride;
    sawStep(sim, p, inp, dt, canSaw, aim);
    if (canSaw && !p.saw.on && !p.prompt) p.prompt = 'Look at wood, then {raise} to plant the bar on it';

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
    const v = p.body.linvel(); p.vPre.set(v.x, v.y, v.z);
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
    const wx = (-sy * inp.my + cy * inp.mx) * speed, wz = (-cy * inp.my - sy * inp.mx) * speed;
    if (p.grounded) body.setLinvel({ x: wx, y: pressed.jump ? CFG.JUMP : v.y, z: wz }, true);
    else body.setLinvel({ x: v.x + (wx - v.x) * 0.02, y: v.y, z: v.z + (wz - v.z) * 0.02 }, true);

    // interact
    const rope = sim.rope;
    const nearDev = rope.nearDevice(p);
    if (p.tool === TOOL.ROPE) {
      p.prompt = rope.prompt(p, aim);
      if (pressed.interact) rope.place(p, aim);
      if (pressed.drop) rope.clear(p);
    } else if (nearDev && rope.holder < 0) {
      p.prompt = '{interact}: take the rope tail';
      if (pressed.interact) { p.mode = MODE.ROPE; rope.holder = p.id; }
    } else if (aim && aim.dist < CFG.REACH && p.tool === TOOL.HANDS) {
      const s = sim.world.segs.get(aim.seg), piece = sim.world.pieces.get(s.piece);
      if (piece.fixed && p.inj < INJ.HURT) {
        const loc = sim.segToLocal(s, aim.point), tt = Math.min(1, Math.max(0, segParam(s, loc)));
        if (segRadius(s, tt) >= CFG.SPUR_MIN_R) {
          p.prompt = '{interact}: spur in and throw the lanyard round';
          if (pressed.interact) {
            const ax = segAxis(s), c = lerp3(s.a, s.b, tt);
            // side = from the stem toward the player, perpendicular to the stem
            const bt = p.body.translation(), pl = sim.segToLocal(s, bt);
            let side = [pl[0] - c[0], pl[1] - c[1], pl[2] - c[2]];
            const d = side[0] * ax[0] + side[1] * ax[1] + side[2] * ax[2];
            side = perp(side.map((x, i) => x - ax[i] * d), ax);
            this.toClimb(p, s.id, tt, side);
          }
        }
      } else if (p.inj >= INJ.HURT) p.prompt = 'Too hurt to climb';
    }
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
    // letting go of the lanyard is letting go of the tree
    if (pressed.drop && control) { const v = fixed ? null : sim.bodies.get(s.piece).velocityAtPoint(p.body.translation()); this.toGround(p, v); return; }
    if (control && p.tool === TOOL.ROPE) {
      p.prompt = sim.rope.prompt(p, aim);
      if (pressed.interact) sim.rope.place(p, aim);
    } else if (control && p.tool === TOOL.HANDS && !p.ride && aim && aim.dist < CFG.REACH) {
      // throw the lanyard round another stem within reach: the way past a union
      const s2 = w.segs.get(aim.seg), loc = sim.segToLocal(s2, aim.point), t2 = Math.min(1, Math.max(0, segParam(s2, loc)));
      if (w.pieces.get(s2.piece).fixed && segRadius(s2, t2) >= CFG.SPUR_MIN_R && (s2.id !== s.id || Math.abs(t2 - cl.t) * segLen(s) > 0.3)) {
        p.prompt = '{interact}: move the lanyard here';
        if (pressed.interact) {
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
        const kids = w.kids(s.id).filter((k) => w.segs.get(k).r0 >= CFG.SPUR_MIN_R);
        const real = w.kids(s.id).filter((k) => w.isRealBranch(k)).length;
        if (!kids.length) t = 1;
        else if (real >= 2) { t = 1; this.say(p, 'The lanyard stops at the union. Look at the stem you want and {interact} (hands) to move it'); }
        else {
          const want = _c.set(-Math.sin(inp.yaw) * Math.cos(inp.pitch), Math.sin(inp.pitch), -Math.cos(inp.yaw) * Math.cos(inp.pitch)).multiplyScalar(0.9).add(axW);
          let best = kids[0], bd = -Infinity;
          for (const k of kids) {
            const d = sim.segDirToWorld(w.segs.get(k), segAxis(w.segs.get(k)), _b).dot(want);
            if (d > bd) { bd = d; best = k; }
          }
          s = w.segs.get(best); cl.seg = best; t = 0.01;
          cl.side = perp(cl.side, segAxis(s));
        }
      } else if (t < 0) {
        if (s.parent < 0) {
          t = 0;
          if (sim.segToWorld(s, s.a, _b).y < 0.6) { this.toGround(p); return; }
        } else {
          const real = w.kids(s.parent).filter((k) => w.isRealBranch(k)).length;
          if (real >= 2) { t = 0; this.say(p, 'The lanyard stops at the union. Look at the stem you want and {interact} (hands) to move it'); }
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
      p.prompt = p.prompt || '{move}: climb   {drop}: let go of the tree';
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
      p.prompt = 'Lanyarded to a falling piece!   {drop}: let go';
    }
  }

  // ---- after physics: read impacts on dynamic players ----
  post(dt) {
    for (const p of this.list.values()) {
      if (p.mode === MODE.CLIMB) continue;
      const v = p.body.linvel();
      const dv = Math.hypot(v.x - p.vPre.x, v.y - p.vPre.y, v.z - p.vPre.z);
      if (dv > CFG.DV_SHAKEN) this.impact(p, dv);
      if (p.body.translation().y < -20) p.body.setTranslation({ x: p.spawn[0], y: p.spawn[1], z: p.spawn[2] }, true);
    }
  }

  aux() {
    const out = [];
    for (const p of this.list.values()) {
      const s = p.saw;
      out.push({
        id: p.id, m: p.mode, tool: p.tool, inj: p.inj, yaw: +p.input.yaw.toFixed(2), pr: p.prompt,
        cl: p.cl ? [p.cl.seg, +p.cl.t.toFixed(3), p.cl.side.map((x) => +x.toFixed(3))] : 0,
        saw: s.on ? [...s.A.toArray(), ...s.b.toArray(), ...s.f.toArray(), s.stuck ? 1 : 0, s.cutting ? 1 : 0].map((x) => +x.toFixed(3)) : 0,
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
