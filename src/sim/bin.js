// Host only: the chip bins (model/bin.js has their shape).
//
// Each bin is a light dynamic body (a box with two frictionless wheel balls at the bottom of its back) and a lid,
// a second body hung on it by a hinge joint with limits (shut on the rim, or swung right back to hang down behind).
// Nothing holds the lid but the hinge, so it flops about as the bin is moved, knocked or tipped. A player's
// {interact} on the lid drives the hinge round to the other end for a moment (open if it was more shut than open,
// shut otherwise), then lets it go again. A player holding the handle bar moves the bin like the chipper's grip:
// pulled back it tips onto its wheels and rolls.
//
// Chips that land in an open, upright bin's mouth (blown out of a chipper's chute or put down by a player) go into
// it and are gone: the bin has no bottom (world.prog.gone). It cannot be broken.

import * as THREE from '../../vendor/three/three.module.js';
import { CFG } from '../config.js';
import { BIN, binBodyId, lidBodyId } from '../model/bin.js';
import { chipToWorld } from '../model/chipper.js';

const OPEN_AT = 1.2;                  // rad: a lid swung up this far leaves the mouth open
const DRIVE_T = 1.5;                  // s the hinge is driven for after a press
const _q = new THREE.Quaternion(), _v = new THREE.Vector3(), _r = new THREE.Quaternion();
const rot = (b) => { const r = b.rotation(); return _r.set(r.x, r.y, r.z, r.w); };

export class Bins {
  constructor(sim) {
    this.sim = sim;
    this.units = [];                  // bin k: {body, lid, joint, drive: null | {to, t}}
    this.colOf = new Map();           // collider handle -> {k, part: 'body' | 'lid' | 'handle'}
  }

  /** With every new tree: one bin by the chipper (chipper-local BIN.PARK), on the ground. */
  place() {
    const sim = this.sim, ch = sim.world.chipper, cp = ch && (ch.units ? ch.units[0] : ch);
    if (!cp) { sim.emit({ t: 'bins', list: [] }); return; }
    const at = chipToWorld(cp.p, cp.q, [BIN.PARK[0], 0, BIN.PARK[1]]);
    sim.emit({ t: 'bins', list: [this.pose(at[0], at[2], cp.q)] });
  }

  /** The Tab menu's "Buy a new chip bin": one more, put down 1.5 m in front of the player who bought it. */
  buy(p) {
    const sim = this.sim, t = p ? p.body.translation() : null;
    let x, z, q = [0, 0, 0, 1];
    if (t) {
      const yaw = p.input.yaw; x = t.x - Math.sin(yaw) * 1.5; z = t.z - Math.cos(yaw) * 1.5;
      // its back (handles) toward the player
      q = [0, Math.sin((yaw + Math.PI / 2) / 2), 0, Math.cos((yaw + Math.PI / 2) / 2)];
    } else {
      const ch = sim.world.chipper, cp = ch && (ch.units ? ch.units[0] : ch);
      const at = cp ? chipToWorld(cp.p, cp.q, [BIN.PARK[0], 0, BIN.PARK[1] + 1]) : [0, 0, 5];
      x = at[0]; z = at[2]; if (cp) q = cp.q;
    }
    const [pp, qq] = this.pose(x, z, q);
    sim.emit({ t: 'bin', p: pp, q: qq });
    if (CFG.BIN_PRICE > 0) sim.emit({ t: 'buy', cost: CFG.BIN_PRICE });
    sim.toast(CFG.BIN_PRICE > 0 ? `A new chip bin: {money:${CFG.BIN_PRICE}}` : 'A new chip bin');
  }

  /** [p, q] for a bin standing on the ground at (x, z), turned by q (yaw only). */
  pose(x, z, q) {
    const sim = this.sim, p = [x, 0, z];
    let y = -Infinity;     // the highest ground under its base, so none of it starts in the ground
    for (const [lx, lz] of [[-1, -1], [-1, 1], [1, -1], [1, 1], [0, 0]]) {
      const g = chipToWorld(p, q, [lx * BIN.BODY.h[0], 0, lz * BIN.BODY.h[2]]); y = Math.max(y, sim.groundY(g[0], g[2]));
    }
    return [[+x.toFixed(3), +(y + BIN.BODY_Y + 0.01).toFixed(3), +z.toFixed(3)], q.map((v) => +v.toFixed(5))];
  }

  // ---- model -> physics ----
  onEvent(ev) {
    if (ev.t === 'bins') { this.clear(); ev.list.forEach(([p, q]) => this.build(p, q)); }
    else if (ev.t === 'bin') this.build(ev.p, ev.q);
  }

  clear() {
    for (const p of this.sim.players.list.values()) if (p.grab && p.grab.bin !== undefined) p.grab = null;
    for (const u of this.units) { this.sim.rapier.removeRigidBody(u.lid); this.sim.rapier.removeRigidBody(u.body); }
    this.units = []; this.colOf.clear();
  }

  build(p, q) {
    const sim = this.sim, R = sim.R, k = this.units.length, B = BIN;
    const body = sim.rapier.createRigidBody(sim.dynamic().setTranslation(p[0], p[1], p[2])
      .setRotation({ x: q[0], y: q[1], z: q[2], w: q[3] }).setLinearDamping(0.05).setAngularDamping(0.3));
    const add = (b, desc, c, mass, part, friction = 0.6) => {
      desc.setTranslation(c[0], c[1], c[2]).setMass(mass).setFriction(friction);
      if (friction === 0) desc.setFrictionCombineRule(R.CoefficientCombineRule.Min);
      this.colOf.set(sim.rapier.createCollider(desc, b).handle, { k, part });
    };
    const M = CFG.BIN_MASS;
    add(body, R.ColliderDesc.cuboid(...B.BODY.h), B.BODY.c, M * 0.8, 'body');
    for (const w of B.WHEELS) add(body, R.ColliderDesc.ball(B.WHEEL_R), w, M * 0.08, 'body', 0);   // they roll: no friction
    add(body, R.ColliderDesc.cuboid(...B.HANDLE_H), B.HANDLE, M * 0.04, 'handle');
    // the lid: its own body on the hinge, starting shut
    const lp = chipToWorld(p, q, B.LID.c);
    const lid = sim.rapier.createRigidBody(sim.dynamic().setTranslation(lp[0], lp[1], lp[2])
      .setRotation({ x: q[0], y: q[1], z: q[2], w: q[3] }).setLinearDamping(0.05).setAngularDamping(0.1));
    add(lid, R.ColliderDesc.cuboid(...B.LID.h), [0, 0, 0], CFG.BIN_LID_MASS, 'lid', 0.5);
    const H = B.HINGE, L = B.LID.c;
    const joint = sim.rapier.createImpulseJoint(R.JointData.revolute({ x: H[0], y: H[1], z: H[2] },
      { x: H[0] - L[0], y: H[1] - L[1], z: H[2] - L[2] }, { x: 0, y: 0, z: 1 }), body, lid, true);
    // No limits on the hinge: shut, the lid lies on the rim; swung back, it comes to rest on the handle bar (contacts
    // between the two bodies stay on). (Rapier's hinge limits and motor only work within ±180°.)
    this.units.push({ body, lid, joint, drive: null });
  }

  // ---- the lid ----
  /** How far bin k's lid is open: rad about the hinge, 0 shut. */
  lidAngle(k) {
    const u = this.units[k], a = u.body.rotation(), b = u.lid.rotation();
    _q.set(a.x, a.y, a.z, a.w).invert().multiply(new THREE.Quaternion(b.x, b.y, b.z, b.w));
    let t = 2 * Math.atan2(_q.z, _q.w);
    if (t < -1) t += 2 * Math.PI;
    return t;
  }
  /** Is bin k's mouth open and facing up (so chips can go in)? */
  open(k) {
    const u = this.units[k], r = u.body.rotation(), up = _v.set(0, 1, 0).applyQuaternion(_q.set(r.x, r.y, r.z, r.w));
    return up.y > 0.7 && this.lidAngle(k) > OPEN_AT;
  }
  /** A press on the lid: swing it to the other end, open or shut. */
  toggle(k) {
    const u = this.units[k], shut = this.lidAngle(k) > Math.PI / 2;
    // driven a little past each end, so it is pressed onto the rim or the handle bar until the drive lets go
    u.drive = { to: shut ? -0.3 : BIN.LID_OPEN, end: shut ? 0.03 : Math.PI - 0.15, shut, t: DRIVE_T };
  }

  pre(dt) {
    const held = new Set();
    for (const p of this.sim.players.list.values()) if (p.grab && p.grab.bin !== undefined) held.add(p.grab.bin);
    for (const [k, u] of this.units.entries()) {
      // let go of (by hand, or pulled out of the hands): it is stood back up (owner, 2026-11-26)
      if (u.held && !held.has(k)) u.right = CFG.BIN_RIGHT_T;
      u.held = held.has(k);
      if (u.right > 0) { u.right -= dt; this.rightUp(u, dt); }
      const a = this.lidAngle(k), ax = _v.set(0, 0, 1).applyQuaternion(rot(u.body)), lw = u.lid.angvel(), bw = u.body.angvel();
      const w = (lw.x - bw.x) * ax.x + (lw.y - bw.y) * ax.y + (lw.z - bw.z) * ax.z;      // how fast it swings
      // the hinge's own friction, and the press: a spring toward the far end (an acceleration, so the same feel
      // whatever the lid weighs), for DRIVE_T or until it gets there
      let acc = -CFG.BIN_HINGE_DAMP * w;
      if (u.drive) {
        u.drive.t -= dt;
        if (u.drive.t <= 0 || (u.drive.shut ? a < u.drive.end : a > u.drive.end)) u.drive = null;
        else acc += CFG.BIN_LID_K * (u.drive.to - a) - 2 * Math.sqrt(CFG.BIN_LID_K) * w;
      }
      const I = CFG.BIN_LID_MASS * (4 * BIN.LID.h[0] * BIN.LID.h[0]) / 3, J = Math.max(-20, Math.min(20, acc * I)) * dt;   // N m s, about the hinge
      if (Math.abs(J) < 1e-6) continue;
      u.lid.applyTorqueImpulse({ x: ax.x * J, y: ax.y * J, z: ax.z * J }, true);
      u.body.applyTorqueImpulse({ x: -ax.x * J, y: -ax.y * J, z: -ax.z * J }, true);
    }
  }

  /** Tip the bin back toward upright: a spring on its tilt (an acceleration, BIN_RIGHT_K, damped), about the
   * horizontal axis it leans over, with no more than BIN_RIGHT_MAX of torque. It pivots on whatever it rests on. */
  rightUp(u, dt) {
    const b = u.body, up = new THREE.Vector3(0, 1, 0).applyQuaternion(rot(b)), ang = Math.acos(Math.max(-1, Math.min(1, up.y)));
    const ax = new THREE.Vector3(-up.z, 0, up.x);              // up x (0, 1, 0): turning about it brings up to vertical
    const w = b.angvel(), wl = new THREE.Vector3(w.x, 0, w.z);
    if (ax.length() < 1e-4) { if (wl.length() < 0.05) { u.right = 0; return; } ax.copy(wl).negate(); }
    ax.normalize();
    const wa = wl.dot(ax);
    if (ang < 0.03 && Math.abs(wa) < 0.05) { u.right = 0; return; }      // stood up
    const K = CFG.BIN_RIGHT_K, acc = K * ang - 2 * Math.sqrt(K) * wa;
    const e = b.effectiveWorldInvInertia().elements, x = ax.x, y = ax.y, z = ax.z;
    const inv = x * (e[0] * x + e[1] * y + e[2] * z) + y * (e[1] * x + e[3] * y + e[4] * z) + z * (e[2] * x + e[4] * y + e[5] * z);
    const T = Math.max(-CFG.BIN_RIGHT_MAX, Math.min(CFG.BIN_RIGHT_MAX, acc / Math.max(1e-6, inv)));
    b.applyTorqueImpulse({ x: ax.x * T * dt, y: ax.y * T * dt, z: ax.z * T * dt }, true);
  }

  /** Bin k whose open mouth world (x, z) is in, give or take BIN_CATCH: its index, or undefined. */
  catchAt(x, z) {
    for (let k = 0; k < this.units.length; k++) {
      if (!this.open(k)) continue;
      const b = this.units[k].body, t = b.translation(), r = b.rotation();
      const l = _v.set(x - t.x, 0, z - t.z).applyQuaternion(_q.set(r.x, r.y, r.z, r.w).invert());
      if (Math.abs(l.x) < BIN.BODY.h[0] + CFG.BIN_CATCH && Math.abs(l.z) < BIN.BODY.h[2] + CFG.BIN_CATCH) return k;
    }
    return undefined;
  }

  /** The bin a player is looking at within reach: {k, part, point, local, dist} or null. */
  aim(p) {
    if (!this.units.length) return null;
    const sim = this.sim, { o, d } = sim.eye(p);
    const hit = sim.rapier.castRay(new sim.R.Ray(o, d), CFG.REACH, true, undefined, undefined, undefined, p.body);
    const c = hit && this.colOf.get(hit.collider.handle); if (!c) return null;
    const point = o.clone().addScaledVector(d, hit.timeOfImpact), local = this.toLocal(c.k, point), H = BIN.HANDLE;
    // the lid swung back lies over the handle bar: a hand reaching for it there gets the bar
    const part = c.part === 'lid' && Math.hypot(local[0] - H[0], local[1] - H[1]) < 0.15 && Math.abs(local[2]) < BIN.HANDLE_H[2] ? 'handle' : c.part;
    return { k: c.k, part, point, local, dist: hit.timeOfImpact };
  }

  toWorld(k, l, target = new THREE.Vector3()) {
    const b = this.units[k].body, t = b.translation(), r = b.rotation();
    return target.set(l[0], l[1], l[2]).applyQuaternion(_q.set(r.x, r.y, r.z, r.w)).add(_v.set(t.x, t.y, t.z));
  }
  toLocal(k, wp) {
    const b = this.units[k].body, t = b.translation(), r = b.rotation();
    const v = new THREE.Vector3(wp.x - t.x, wp.y - t.y, wp.z - t.z).applyQuaternion(_q.set(r.x, r.y, r.z, r.w).invert());
    return [v.x, v.y, v.z];
  }
  unit(k) { return this.units[k] || null; }

  /** Calls fn(id, translation, rotation, awake) for each bin and its lid. */
  eachBody(fn) {
    this.units.forEach((u, k) => {
      fn(binBodyId(k), u.body.translation(), u.body.rotation(), !u.body.isSleeping());
      fn(lidBodyId(k), u.lid.translation(), u.lid.rotation(), !u.lid.isSleeping());
    });
  }
  body(id) {
    const k = id - binBodyId(0); if (k < 0 || k >= 2 * this.units.length) return null;
    const u = this.units[k >> 1]; return k & 1 ? u.lid : u.body;
  }
}

