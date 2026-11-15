// Players on the host: bodies, walking, spur climbing + lanyard rules,
// interaction, injury thresholds. See docs/DESIGN.md section 6.

import * as THREE from 'three';
import { CFG, INJ, TOOL, MODE } from '../config.js';
import { segLen, segAxis, segRadius, segParam, lerp3 } from '../model/world.js';
import { sawStep, sawOff } from './saw.js';

const COUNTERS = ['jump', 'interact', 'lanyard', 'drop', 'toolNext', 'toolPrev', 'wrapUp', 'wrapDn', 'respawn'];
export function blankInput() {
  const c = {}; for (const k of COUNTERS) c[k] = 0;
  return { mx: 0, my: 0, ty: 0, yaw: 0, pitch: 0, rt: 0, lt: 0, o: [0, 2, 5], d: [0, 0, -1], c };
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
    if (p.mode === MODE.CLIMB && (!p.lan || lvl >= INJ.HURT)) this.toGround(p);
    if (p.mode === MODE.ROPE) this.leaveRope(p);
  }
  onContact(pid, force) {
    const p = this.list.get(pid);
    if (p && p.mode === MODE.CLIMB) {            // kinematic: no velocity change to read, use the force
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
  }
  toClimb(p, segId, t, side) {
    p.body.setBodyType(this.sim.R.RigidBodyType.KinematicPositionBased, true);
    p.mode = MODE.CLIMB; p.cl = { seg: segId, t, side }; p.lan = false; p.ride = null;
  }
  leaveRope(p) { if (this.sim.rope.holder === p.id) this.sim.rope.holder = -1; p.mode = MODE.GROUND; }

  onSplit(ev, info) {
    for (const p of this.list.values()) {
      if (p.saw.on && (p.saw.seg === ev.seg || info.moved.includes(p.saw.seg))) sawOff(this.sim, p);
      if (p.cl && p.cl.seg === ev.seg && ev.at > 0) {
        if (p.cl.t > ev.at) { p.cl.seg = ev.newSeg; p.cl.t = (p.cl.t - ev.at) / (1 - ev.at); }
        else p.cl.t = p.cl.t / ev.at;
      }
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

    // chainsaw (precision mode)
    const canSaw = control && p.tool === TOOL.SAW && (p.mode === MODE.GROUND ? p.grounded : (p.mode === MODE.CLIMB && p.lan && !p.ride));
    if (p.tool === TOOL.SAW && p.mode === MODE.CLIMB && !p.lan && inp.lt > 0.3) this.say(p, 'Clip your lanyard (Y) before running the saw');
    sawStep(sim, p, inp, dt, aim, canSaw);

    if (p.mode === MODE.ROPE) {
      p.prompt = 'RT ease  LT haul  D-pad wraps  X let go (ties off)';
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
    if (!control || p.saw.on) { if (p.grounded) body.setLinvel({ x: v.x * 0.8, y: v.y, z: v.z * 0.8 }, true); return; }
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
      p.prompt = 'X: take the rope tail';
      if (pressed.interact) { p.mode = MODE.ROPE; rope.holder = p.id; }
    } else if (aim && aim.dist < CFG.REACH && p.tool === TOOL.HANDS) {
      const s = sim.world.segs.get(aim.seg), piece = sim.world.pieces.get(s.piece);
      if (piece.fixed && p.inj < INJ.HURT) {
        const loc = sim.toLocal(s.piece, aim.point), tt = Math.min(1, Math.max(0, segParam(s, loc)));
        if (segRadius(s, tt) >= CFG.SPUR_MIN_R) {
          p.prompt = 'X: spur in and climb';
          if (pressed.interact) {
            const ax = segAxis(s), c = lerp3(s.a, s.b, tt);
            // side = from the stem toward the player, perpendicular to the stem
            const bt = p.body.translation(), pl = sim.toLocal(s.piece, bt);
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
    if (!fixed && !p.lan) {           // the wood broke away and nothing ties us to it
      const v = sim.bodies.get(s.piece).velocityAtPoint(p.body.translation());
      this.toGround(p, v); sim.toast('Your branch broke away and you were not tied in', p.id); return;
    }
    if (!fixed && !p.ride) p.ride = { max: 0, still: 0, prev: null };
    if (pressed.lanyard && control && !p.ride) {
      p.lan = !p.lan; if (!p.lan) sawOff(sim, p);
    }
    if (pressed.drop && control && !p.saw.on) { this.toGround(p); return; }
    if (control && p.tool === TOOL.ROPE) {
      p.prompt = sim.rope.prompt(p, aim);
      if (pressed.interact) sim.rope.place(p, aim);
    }

    if (control && !p.saw.on && !p.ride) {
      let ax = segAxis(s), L = segLen(s);
      const axW = sim.dirToWorld(s.piece, ax, _a);
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
        else if (p.lan && real >= 2) { t = 1; this.say(p, 'Lanyard is stopped by the union - unclip (Y) to pass'); }
        else {
          const want = _c.set(-Math.sin(inp.yaw) * Math.cos(inp.pitch), Math.sin(inp.pitch), -Math.cos(inp.yaw) * Math.cos(inp.pitch)).multiplyScalar(0.9).add(axW);
          let best = kids[0], bd = -Infinity;
          for (const k of kids) {
            const d = sim.dirToWorld(s.piece, segAxis(w.segs.get(k)), _b).dot(want);
            if (d > bd) { bd = d; best = k; }
          }
          s = w.segs.get(best); cl.seg = best; t = 0.01;
          cl.side = perp(cl.side, segAxis(s));
        }
      } else if (t < 0) {
        if (s.parent < 0) {
          t = 0;
          if (sim.toWorld(s.piece, s.a, _b).y < 0.6) { this.toGround(p); return; }
        } else {
          const real = w.kids(s.parent).filter((k) => w.isRealBranch(k)).length;
          if (p.lan && real >= 2) { t = 0; this.say(p, 'Lanyard is stopped by the union - unclip (Y) to pass'); }
          else { s = w.segs.get(s.parent); cl.seg = s.id; t = 0.99; cl.side = perp(cl.side, segAxis(s)); }
        }
      }
      cl.t = t;
    }

    // pose derived from (segment, t, side)
    const c = lerp3(s.a, s.b, cl.t), d = segRadius(s, cl.t) + CFG.STANDOFF;
    const pos = sim.toWorld(s.piece, [c[0] + cl.side[0] * d, c[1] + cl.side[1] * d, c[2] + cl.side[2] * d], _a);
    p.body.setNextKinematicTranslation(pos);
    if (fixed) {
      sim.loads.push({ seg: s.id, p: c, f: [0, -CFG.P_MASS * CFG.GRAVITY, 0] });
      p.prompt = p.prompt || (p.lan ? 'Y: unclip lanyard' : 'Y: clip lanyard   B: step off');
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
      p.prompt = 'Tied to a falling piece!';
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
        id: p.id, m: p.mode, tool: p.tool, inj: p.inj, lan: p.lan ? 1 : 0, yaw: +p.input.yaw.toFixed(2), pr: p.prompt,
        saw: s.on ? [s.seg, s.at, s.z0, s.phi, s.tilt, s.depth, s.stuck ? 1 : 0, s.sec, Math.round(s.pinch || 0), s.R] : 0,
      });
    }
    return out;
  }
}

/** Unit vector perpendicular to unit axis ax, as close as possible to v. */
function perp(v, ax) {
  const d = v[0] * ax[0] + v[1] * ax[1] + v[2] * ax[2];
  let o = [v[0] - ax[0] * d, v[1] - ax[1] * d, v[2] - ax[2] * d], l = Math.hypot(o[0], o[1], o[2]);
  if (l < 1e-4) { o = Math.abs(ax[1]) < 0.9 ? [ax[2], 0, -ax[0]] : [1, 0, 0]; l = Math.hypot(o[0], o[1], o[2]); }
  return [o[0] / l, o[1] / l, o[2] / l];
}
function rotateAbout(v, ax, ang) {
  const c = Math.cos(ang), s = Math.sin(ang), d = v[0] * ax[0] + v[1] * ax[1] + v[2] * ax[2];
  const cr = [ax[1] * v[2] - ax[2] * v[1], ax[2] * v[0] - ax[0] * v[2], ax[0] * v[1] - ax[1] * v[0]];
  return perp([v[0] * c + cr[0] * s + ax[0] * d * (1 - c), v[1] * c + cr[1] * s + ax[1] * d * (1 - c), v[2] * c + cr[2] * s + ax[2] * d * (1 - c)], ax);
}
