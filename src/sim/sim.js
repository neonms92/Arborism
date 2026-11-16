// Host-only simulation. Owns the Rapier world. Decides everything; tells the
// world model what happened through emit(event). See docs/DESIGN.md 1.3.

import RAPIER from 'rapier';
import * as THREE from 'three';
import { CFG } from '../config.js';
import { segLen, segAxis, segMass, lerp3 } from '../model/world.js';
import { generateTree } from '../model/treegen.js';
import { frameApply, frameDir, frameInverse } from '../model/flex.js';
import { Players } from './players.js';
import { Rope } from './rope.js';
import { Structure } from './structure.js';

export const PLAYER_BODY_ID = 60000;   // snapshot ids >= this are players
const Y = new THREE.Vector3(0, 1, 0);
const _v = new THREE.Vector3(), _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion();

export class Sim {
  static async create(world, seed = 7) {
    await RAPIER.init();
    return new Sim(world, seed);
  }

  constructor(world, seed) {
    this.R = RAPIER;
    this.world = world;
    this.tick = 0;
    this.outbox = [];                 // events waiting to go to clients
    this.rapier = new RAPIER.World({ x: 0, y: -CFG.GRAVITY, z: 0 });
    this.rapier.timestep = CFG.TICK;
    this.eq = new RAPIER.EventQueue(true);
    this.bodies = new Map();          // piece id -> RigidBody
    this.segCol = new Map();          // seg id -> Collider
    this.colSeg = new Map();          // collider handle -> seg id
    this.colPlayer = new Map();       // collider handle -> player id
    this.born = new Map();            // piece id -> tick created
    this.colBase = new Map();         // seg id -> {mid, q, at}: its collider's unbent pose, and where it was last put
    this.loads = [];                  // this tick's point loads on rooted pieces: {seg, p:[3], f:[3]}
    this.contactRaw = new Map();      // seg id -> [fx,fy,fz] from last rapier step
    this.contactF = new Map();        // filtered

    const g = RAPIER.ColliderDesc.cuboid(200, 0.5, 200).setTranslation(0, -0.5, 0).setFriction(0.9);
    this.rapier.createCollider(g);

    // wood still joined by a live fibre bundle must not also collide across that joint
    const noHit = (c1, c2) => {
      const s1 = this.colSeg.get(c1), s2 = this.colSeg.get(c2);
      if (s1 === undefined || s2 === undefined) return false;
      const a = this.world.segs.get(s1), b = this.world.segs.get(s2), nh = this.structure.noHit;
      if (!a || !b) return false;
      const ro = this.structure.rootOf;
      return !!(nh.get(s1)?.has(b.piece) || nh.get(s2)?.has(a.piece) || ro.get(s1) === b.piece || ro.get(s2) === a.piece);
    };
    this.hooks = {
      filterContactPair: (c1, c2) => (noHit(c1, c2) ? null : RAPIER.SolverFlags.COMPUTE_IMPULSE),
      filterIntersectionPair: () => true,
    };
    world.on((ev, info) => this.onEvent(ev, info));
    this.players = new Players(this);
    this.rope = new Rope(this);
    this.structure = new Structure(this);

    this.emit({ t: 'tree', piece: world.newId(), segs: generateTree(seed, () => world.newId()) });
  }

  emit(ev) { this.world.apply(ev); this.outbox.push(ev); }
  toast(msg, to = -1) { this.emit({ t: 'toast', msg, to }); }

  // ---- model -> physics ----
  onEvent(ev, info) {
    if (ev.t === 'tree') {
      const body = this.rapier.createRigidBody(RAPIER.RigidBodyDesc.fixed());
      this.bodies.set(ev.piece, body);
      for (const s of this.world.segsOf(ev.piece)) this.addCollider(s, body);
    } else if (ev.t === 'divide') {
      const s = this.world.segs.get(ev.seg), body = this.bodies.get(s.piece);
      this.structure.flex.copy(ev.seg, ev.newSeg);
      this.dropCollider(ev.seg); this.addCollider(s, body);
      this.addCollider(this.world.segs.get(ev.newSeg), body);
      this.players.onDivide(ev);
    } else if (ev.t === 'split') {
      if (!info.moved) return;
      const old = this.bodies.get(info.oldPiece);
      for (const id of info.moved) this.dropCollider(id);
      if (info.cutSeg !== info.root) { this.dropCollider(info.cutSeg); this.addCollider(this.world.segs.get(info.cutSeg), old); }
      // The new body starts where that wood actually was: the old body's pose, bent as its root segment was bent.
      const fr = this.partFrame; this.partFrame = null;
      const ot = old.translation(), or = old.rotation();
      const q0 = new THREE.Quaternion(or.x, or.y, or.z, or.w), t0 = new THREE.Vector3(ot.x, ot.y, ot.z);
      if (fr) { t0.add(new THREE.Vector3(fr.t[0], fr.t[1], fr.t[2]).applyQuaternion(q0)); q0.multiply(new THREE.Quaternion(fr.q[0], fr.q[1], fr.q[2], fr.q[3])); }
      this.structure.flex.release(info.moved, fr);
      const desc = RAPIER.RigidBodyDesc.dynamic().setTranslation(t0.x, t0.y, t0.z)
        .setRotation({ x: q0.x, y: q0.y, z: q0.z, w: q0.w }).setLinvel(old.linvel().x, old.linvel().y, old.linvel().z).setAngvel(old.angvel())
        .setLinearDamping(0.05).setAngularDamping(0.2);
      const body = this.rapier.createRigidBody(desc);
      this.bodies.set(ev.newPiece, body);
      this.born.set(ev.newPiece, this.tick);
      for (const id of info.moved) this.addCollider(this.world.segs.get(id), body);
      this.players.onSplit(ev, info);
    } else if (ev.t === 'rmpiece') {
      const body = this.bodies.get(ev.piece);
      for (const [id, col] of [...this.segCol]) if (!this.world.segs.has(id)) { this.colSeg.delete(col.handle); this.segCol.delete(id); }
      if (body) this.rapier.removeRigidBody(body);
      this.bodies.delete(ev.piece); this.born.delete(ev.piece);
      this.structure.onRemove(ev.piece);
      if (info.ropeLost) this.rope.reset();
    }
  }

  addCollider(s, body) {
    const L = segLen(s), r = Math.max(0.01, (s.r0 + s.r1) / 2), ax = segAxis(s);
    const mid = lerp3(s.a, s.b, 0.5);
    _q.setFromUnitVectors(Y, _v.set(ax[0], ax[1], ax[2]));
    const desc = RAPIER.ColliderDesc.cylinder(Math.max(0.01, L / 2 - 0.004), r)
      .setTranslation(mid[0], mid[1], mid[2]).setRotation({ x: _q.x, y: _q.y, z: _q.z, w: _q.w })
      .setMass(segMass(s) + s.leaf).setFriction(0.8).setRestitution(0.05)
      .setActiveEvents(RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS).setContactForceEventThreshold(CFG.CONTACT_MIN);
    if (this.structure && (this.structure.noHit.has(s.id) || this.structure.rootOf.has(s.id))) desc.setActiveHooks(RAPIER.ActiveHooks.FILTER_CONTACT_PAIRS);
    const col = this.rapier.createCollider(desc, body);
    this.segCol.set(s.id, col); this.colSeg.set(col.handle, s.id);
    this.colBase.set(s.id, { mid, q: [_q.x, _q.y, _q.z, _q.w], at: mid.slice() });
  }
  dropCollider(id) {
    const col = this.segCol.get(id); if (!col) return;
    this.colSeg.delete(col.handle); this.segCol.delete(id); this.colBase.delete(id);
    this.rapier.removeCollider(col, true);
  }

  // ---- frames ----
  /** piece-local array -> world Vector3 (new or into target) */
  toWorld(pieceId, p, target = new THREE.Vector3()) {
    const b = this.bodies.get(pieceId), t = b.translation(), r = b.rotation();
    return target.set(p[0], p[1], p[2]).applyQuaternion(_q.set(r.x, r.y, r.z, r.w)).add(_v.set(t.x, t.y, t.z));
  }
  dirToWorld(pieceId, d, target = new THREE.Vector3()) {
    const r = this.bodies.get(pieceId).rotation();
    return target.set(d[0], d[1], d[2]).applyQuaternion(_q.set(r.x, r.y, r.z, r.w));
  }
  toLocal(pieceId, wp) {
    const b = this.bodies.get(pieceId), t = b.translation(), r = b.rotation();
    const v = new THREE.Vector3(wp.x - t.x, wp.y - t.y, wp.z - t.z).applyQuaternion(_q.set(r.x, r.y, r.z, r.w).invert());
    return [v.x, v.y, v.z];
  }

  // ---- the same, for a point on a particular segment: follows that segment's bend (model/flex.js) ----
  segToWorld(s, p, target = new THREE.Vector3()) { return this.toWorld(s.piece, frameApply(this.structure.flex.frame(s.id), p), target); }
  segDirToWorld(s, d, target = new THREE.Vector3()) { return this.dirToWorld(s.piece, frameDir(this.structure.flex.frame(s.id), d), target); }
  segToLocal(s, wp) { return frameInverse(this.structure.flex.frame(s.id), this.toLocal(s.piece, wp)); }

  /** Move the standing tree's colliders to where its bent wood is (only those that have moved). */
  syncColliders() {
    const flex = this.structure.flex;
    for (const [id, base] of this.colBase) {
      const fr = flex.frame(id); if (!fr) continue;
      const m = frameApply(fr, base.mid);
      if (Math.abs(m[0] - base.at[0]) + Math.abs(m[1] - base.at[1]) + Math.abs(m[2] - base.at[2]) < 0.002) continue;
      base.at = m;
      const col = this.segCol.get(id);
      _q.set(fr.q[0], fr.q[1], fr.q[2], fr.q[3]).multiply(_q2.set(base.q[0], base.q[1], base.q[2], base.q[3]));
      col.setTranslationWrtParent({ x: m[0], y: m[1], z: m[2] });
      col.setRotationWrtParent({ x: _q.x, y: _q.y, z: _q.z, w: _q.w });
    }
  }

  /** Apply force f (Vector3, N) for this tick at world point p on a segment's piece. */
  applyForce(segId, p, f) {
    const s = this.world.segs.get(segId); if (!s) return;
    const piece = this.world.pieces.get(s.piece);
    if (piece.fixed) this.loads.push({ seg: segId, p: [p.x, p.y, p.z], f: [f.x, f.y, f.z] });
    else this.bodies.get(s.piece).applyImpulseAtPoint({ x: f.x * CFG.TICK, y: f.y * CFG.TICK, z: f.z * CFG.TICK }, p, true);
  }

  /** A player's eyes and where they are looking (authoritative: from the host's own copy of the body). */
  eye(p) {
    const c = p.body.translation(), cp = Math.cos(p.input.pitch);
    return {
      o: new THREE.Vector3(c.x, c.y + CFG.EYE, c.z),
      d: new THREE.Vector3(-Math.sin(p.input.yaw) * cp, Math.sin(p.input.pitch), -Math.cos(p.input.yaw) * cp),
    };
  }
  /** What a player is looking at on a tree: {seg, point:Vector3, dist} or null. */
  aim(p) {
    const { o, d } = this.eye(p);
    const hit = this.rapier.castRay(new RAPIER.Ray(o, d), 8, true, undefined, undefined, undefined, p.body);
    if (!hit) return null;
    const seg = this.colSeg.get(hit.collider.handle);
    if (seg === undefined) return null;
    const t = hit.timeOfImpact;
    return { seg, point: o.clone().addScaledVector(d, t), dist: t };
  }

  // ---- the tick ----
  step() {
    const dt = CFG.TICK;
    this.tick++;
    this.loads.length = 0;
    // filtered contact loads from the previous physics step
    const k = Math.min(1, dt / CFG.CONTACT_TAU);
    for (const [seg, f] of this.contactF) {
      const raw = this.contactRaw.get(seg);
      f[0] += ((raw ? raw[0] : 0) - f[0]) * k; f[1] += ((raw ? raw[1] : 0) - f[1]) * k; f[2] += ((raw ? raw[2] : 0) - f[2]) * k;
      const s = this.world.segs.get(seg);
      if (!s || Math.hypot(f[0], f[1], f[2]) < 20) { this.contactF.delete(seg); continue; }
      if (this.world.pieces.get(s.piece).fixed) this.loads.push({ seg, p: lerp3(s.a, s.b, 0.5), f: [f[0], f[1], f[2]] });
    }
    for (const seg of this.contactRaw.keys()) if (!this.contactF.has(seg)) this.contactF.set(seg, [0, 0, 0]);
    this.contactRaw.clear();

    this.rope.step(dt);          // rope first: the saw and the fibres both need this tick's rope state
    this.players.pre(dt);
    this.structure.step(dt);
    if (this.tick % 2 === 0) this.syncColliders();
    this.rapier.step(this.eq, this.hooks);
    this.eq.drainContactForceEvents((e) => this.onContact(e));
    this.players.post(dt);

    if (this.tick % 60 === 0) this.sweepDebris();
  }

  onContact(e) {
    const h1 = e.collider1(), h2 = e.collider2();
    const mag = e.totalForceMagnitude(), dir = e.maxForceDirection();
    for (const [h, other] of [[h1, h2], [h2, h1]]) {
      const pid = this.colPlayer.get(h);
      if (pid !== undefined) { this.players.onContact(pid, mag); continue; }
      const seg = this.colSeg.get(h); if (seg === undefined) continue;
      const s = this.world.segs.get(seg); if (!s || !this.world.pieces.get(s.piece).fixed) continue;
      // force on this segment points away from the other body
      const oc = this.rapier.getCollider(other); if (!oc) continue;
      const ob = oc.parent(), c = ob ? ob.worldCom() : oc.translation(), m = lerp3(s.a, s.b, 0.5);
      const sgn = (dir.x * (m[0] - c.x) + dir.y * (m[1] - c.y) + dir.z * (m[2] - c.z)) >= 0 ? 1 : -1;
      const raw = this.contactRaw.get(seg) || [0, 0, 0];
      raw[0] += dir.x * mag * sgn; raw[1] += dir.y * mag * sgn; raw[2] += dir.z * mag * sgn;
      this.contactRaw.set(seg, raw);
    }
  }

  sweepDebris() {
    for (const [id, t0] of [...this.born]) {
      if (this.tick - t0 < CFG.DEBRIS_LIFE * 60 || this.structure.live.has(id)) continue;
      const body = this.bodies.get(id);
      if (body && body.mass() < CFG.DEBRIS_MASS) this.emit({ t: 'rmpiece', piece: id });
      else this.born.delete(id);
    }
  }

  // ---- outputs (transform source + aux) ----
  /** Calls fn(id, translation, rotation, awake) for every dynamic piece and player. */
  eachBody(fn) {
    for (const [id, b] of this.bodies) {
      if (this.world.pieces.get(id).fixed) continue;
      fn(id, b.translation(), b.rotation(), !b.isSleeping());
    }
    for (const p of this.players.list.values()) fn(PLAYER_BODY_ID + p.id, p.body.translation(), p.body.rotation(), true);
  }
  pose(id) {
    const b = id >= PLAYER_BODY_ID ? this.players.list.get(id - PLAYER_BODY_ID)?.body : this.bodies.get(id);
    return b ? { p: b.translation(), q: b.rotation() } : null;
  }
  aux() {
    return { t: 'aux', tick: this.tick, pl: this.players.aux(), rope: this.rope.aux(), ...this.structure.aux() };
  }
}
