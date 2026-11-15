// Host-only simulation. Owns the Rapier world. Decides everything; tells the
// world model what happened through emit(event). See docs/DESIGN.md 1.3.

import RAPIER from 'rapier';
import * as THREE from 'three';
import { CFG } from '../config.js';
import { segLen, segAxis, segMass, lerp3 } from '../model/world.js';
import { generateTree } from '../model/treegen.js';
import { Players } from './players.js';
import { Rope } from './rope.js';
import { Structure } from './structure.js';

export const PLAYER_BODY_ID = 60000;   // snapshot ids >= this are players
const Y = new THREE.Vector3(0, 1, 0);
const _v = new THREE.Vector3(), _q = new THREE.Quaternion();

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
    this.loads = [];                  // this tick's point loads on rooted pieces: {seg, p:[3], f:[3]}
    this.contactRaw = new Map();      // seg id -> [fx,fy,fz] from last rapier step
    this.contactF = new Map();        // filtered

    const g = RAPIER.ColliderDesc.cuboid(200, 0.5, 200).setTranslation(0, -0.5, 0).setFriction(0.9);
    this.rapier.createCollider(g);

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
    } else if (ev.t === 'split') {
      if (!info.moved) return;
      const old = this.bodies.get(info.oldPiece);
      for (const id of info.moved) this.dropCollider(id);
      if (info.cutSeg !== info.root) { this.dropCollider(info.cutSeg); this.addCollider(this.world.segs.get(info.cutSeg), old); }
      const desc = RAPIER.RigidBodyDesc.dynamic().setTranslation(old.translation().x, old.translation().y, old.translation().z)
        .setRotation(old.rotation()).setLinvel(old.linvel().x, old.linvel().y, old.linvel().z).setAngvel(old.angvel())
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
    const col = this.rapier.createCollider(desc, body);
    this.segCol.set(s.id, col); this.colSeg.set(col.handle, s.id);
  }
  dropCollider(id) {
    const col = this.segCol.get(id); if (!col) return;
    this.colSeg.delete(col.handle); this.segCol.delete(id);
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

  /** Apply force f (Vector3, N) for this tick at world point p on a segment's piece. */
  applyForce(segId, p, f) {
    const s = this.world.segs.get(segId); if (!s) return;
    const piece = this.world.pieces.get(s.piece);
    if (piece.fixed) this.loads.push({ seg: segId, p: [p.x, p.y, p.z], f: [f.x, f.y, f.z] });
    else this.bodies.get(s.piece).applyImpulseAtPoint({ x: f.x * CFG.TICK, y: f.y * CFG.TICK, z: f.z * CFG.TICK }, p, true);
  }

  /** What a player's camera ray hits on a tree: {seg, point:Vector3, dist} or null. */
  aim(p) {
    const o = p.input.o, d = p.input.d, c = p.body.translation();
    const skip = Math.max(0, (c.x - o[0]) * d[0] + (c.y - o[1]) * d[1] + (c.z - o[2]) * d[2] - 0.4);
    const ox = o[0] + d[0] * skip, oy = o[1] + d[1] * skip, oz = o[2] + d[2] * skip;
    const hit = this.rapier.castRay(new RAPIER.Ray({ x: ox, y: oy, z: oz }, { x: d[0], y: d[1], z: d[2] }),
      12, true, undefined, undefined, undefined, p.body);
    if (!hit) return null;
    const seg = this.colSeg.get(hit.collider.handle);
    if (seg === undefined) return null;
    const t = hit.timeOfImpact;
    const point = new THREE.Vector3(ox + d[0] * t, oy + d[1] * t, oz + d[2] * t);
    return { seg, point, dist: point.distanceTo(_v.set(c.x, c.y + 0.3, c.z)) };
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

    this.players.pre(dt);
    this.rope.step(dt);
    this.structure.step(dt);
    this.rapier.step(this.eq);
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
      if (this.tick - t0 < CFG.DEBRIS_LIFE * 60 || this.structure.hinges.has(id)) continue;
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
    const util = [];
    for (const [id, u] of this.structure.util) if (u > 0.03) util.push(id, Math.min(255, Math.round(u * 100)));
    return {
      t: 'aux', tick: this.tick, pl: this.players.aux(), rope: this.rope.aux(), util,
      watch: this.structure.watchAux(),
    };
  }
}
