// Host-only simulation. Owns the Rapier world. Decides everything; tells the
// world model what happened through emit(event). See docs/DESIGN.md 1.3.

import RAPIER from '../../vendor/rapier/rapier.mjs';
import * as THREE from '../../vendor/three/three.module.js';
import { CFG } from '../config.js';
import { segLen, segAxis, segMass, segParam, lerp3 } from '../model/world.js';
import { layout, bundleBasis, isGone } from '../model/fibres.js';
import { generateTree } from '../model/treegen.js';
import { frameApply, frameDir, frameInverse } from '../model/flex.js';
import { Players } from './players.js';
import { Rope } from './rope.js';
import { Structure } from './structure.js';
import { Pavers } from './pavers.js';
import { Chipper } from './chipper.js';
import { Builds } from './builds.js';
import { CHIPPER_BODY_ID } from '../model/chipper.js';
import { terrainSpec, groundY, groundN } from '../model/terrain.js';

export const PLAYER_BODY_ID = 60000;   // snapshot ids >= this are players
const Y = new THREE.Vector3(0, 1, 0);
const _v = new THREE.Vector3(), _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion();

export class Sim {
  /**
   * opts.tree = false: start with no wood (the test harness builds its own with a `tree` event); the ground
   * then stays flat when it grows a tree, unless opts.terrain = true.
   */
  static async create(world, opts = {}) {
    await RAPIER.init();
    return new Sim(world, opts);
  }

  constructor(world, opts = {}) {
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

    this.flat = opts.terrain === undefined ? opts.tree === false : !opts.terrain;
    this.groundCol = null;
    this.makeGround();

    // wood still joined by a live fibre bundle must not also collide across that joint
    const noHit = (c1, c2) => {
      const s1 = this.colSeg.get(c1), s2 = this.colSeg.get(c2);
      if (this.chipper.noHit(c1, s2) || this.chipper.noHit(c2, s1)) return true;     // wood being fed passes into the chipper
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
    this.pavers = new Pavers(this);   // needs the ground collider and nothing else yet
    this.rope = new Rope(this);
    this.structure = new Structure(this);
    this.chipper = new Chipper(this);  // its body is made by the first 'chipper' event (grow)
    this.builds = new Builds(this);    // the shed; its bodies are made by the 'builds' event (grow)
    this.onLoads = null;              // optional fn(dt), called each tick where point loads go in (test harness)

    if (opts.tree !== false) this.grow();
  }

  grow() {
    this.emit({ t: 'terrain', spec: this.flat ? null : terrainSpec(CFG, this.pads()) });
    this.pavers.lay(); this.chipper.place(); this.builds.place();
    this.emit({ t: 'tree', piece: this.world.newId(), segs: generateTree(CFG.TREE_SEED, () => this.world.newId()) });
  }

  /** Level ground for the tree's yard (the paving and a margin) and under whatever is put up round it. */
  pads() {
    const paveR = CFG.TREE_HEIGHT * CFG.PAVER_RADIUS, blend = CFG.TERRAIN_BLEND;
    return [{ x: 0, z: 0, r: paveR + CFG.TERRAIN_YARD, blend, y: 0 }, ...this.chipper.pads(blend), ...this.builds.pads(blend)];
  }

  // ---- the ground ----
  /** Height of the ground at world (x, z), m. */
  groundY(x, z) { return groundY(this.world.terrain, x, z); }
  /** Upward unit normal of the ground at world (x, z), [3]. */
  groundN(x, z) { return groundN(this.world.terrain, x, z); }

  /**
   * A dynamic body's description. On terrain the ground is a surface with nothing under it (a heightfield),
   * not a 1 m slab, so a fast thin piece could pass through it in one step: every moving body looks
   * TERRAIN_CCD ahead for contacts (Rapier's soft CCD). Flat ground keeps the slab and needs none.
   */
  dynamic() { return RAPIER.RigidBodyDesc.dynamic().setSoftCcdPrediction(this.ccd()); }
  ccd() { return this.world.terrain ? CFG.TERRAIN_CCD : 0; }

  /** The ground collider for world.terrain: a heightfield, or a slab with its top at y = 0 when flat. */
  makeGround() {
    const R = RAPIER, t = this.world.terrain;
    if (this.groundCol) this.rapier.removeCollider(this.groundCol, false);
    let g;
    if (!t) g = R.ColliderDesc.cuboid(200, 0.5, 200).setTranslation(0, -0.5, 0);
    // (no FIX_INTERNAL_EDGES: with it, thin rods slid through the crease at the foot of a ledge)
    else g = R.ColliderDesc.heightfield(t.n, t.n, t.h, { x: t.n * t.cell, y: 1, z: t.n * t.cell });
    this.groundCol = this.rapier.createCollider(g.setFriction(0.9));
    const d = this.ccd();
    this.rapier.forEachRigidBody((b) => { if (b.isDynamic()) b.setSoftCcdPrediction(d); });
  }
  /** Clear all wood and grow a new tree from the current TREE_* settings. */
  regrow() { this.emit({ t: 'reset' }); this.grow(); this.toast('A new tree'); }

  emit(ev) { this.world.apply(ev); this.outbox.push(ev); }
  toast(msg, to = -1) { this.emit({ t: 'toast', msg, to }); }

  // ---- model -> physics ----
  onEvent(ev, info) {
    if (ev.t === 'terrain') { this.makeGround(); this.players.onTerrain(); return; }
    this.chipper.onEvent(ev, info);
    this.builds.onEvent(ev, info);
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
    } else if (ev.t === 'rip') {
      if (!info.newSeg) return;
      const s = this.world.segs.get(ev.seg), body = this.bodies.get(s.piece);
      this.dropCollider(ev.seg); this.addCollider(s, body);
      this.addCollider(this.world.segs.get(info.newSeg), body);
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
      const desc = this.dynamic().setTranslation(t0.x, t0.y, t0.z)
        .setRotation({ x: q0.x, y: q0.y, z: q0.z, w: q0.w }).setLinvel(old.linvel().x, old.linvel().y, old.linvel().z).setAngvel(old.angvel())
        .setLinearDamping(0.05).setAngularDamping(0.2);
      const body = this.rapier.createRigidBody(desc);
      this.bodies.set(ev.newPiece, body);
      this.born.set(ev.newPiece, this.tick);
      for (const id of info.moved) this.addCollider(this.world.segs.get(id), body);
      this.players.onSplit(ev, info);
    } else if (ev.t === 'reset') {
      for (const body of this.bodies.values()) this.rapier.removeRigidBody(body);
      this.bodies.clear(); this.segCol.clear(); this.colSeg.clear(); this.colBase.clear(); this.born.clear();
      this.contactRaw.clear(); this.contactF.clear(); this.loads.length = 0;
      this.structure.reset(); this.rope.reset(); this.players.onReset();
    } else if (ev.t === 'chip') {
      for (const [id, col] of [...this.segCol]) if (!this.world.segs.has(id)) this.dropCollider(id);
      for (const pc of info.gone) {
        const body = this.bodies.get(pc);
        if (body) this.rapier.removeRigidBody(body);
        this.bodies.delete(pc); this.born.delete(pc); this.structure.onRemove(pc);
      }
      if (info.ropeLost) this.rope.reset();
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
    const L = segLen(s), ax = segAxis(s);
    let r = Math.max(0.01, (s.r0 + s.r1) / 2);
    const mid = lerp3(s.a, s.b, 0.5);
    if (s.f.ncut) {
      // part of a lengthwise split: a thinner rod through the middle of the wood that is left, clear of the other part
      const Ly = layout(s.f.N), { u, v } = bundleBasis(ax);
      let cx = 0, cy = 0, m = 0;
      for (let i = 0; i < s.f.n; i++) if (!isGone(s.f, i)) { cx += Ly.X[i]; cy += Ly.Y[i]; m++; }
      if (m < s.f.n && m) {
        cx /= m; cy /= m;
        const off = Math.hypot(cx, cy);
        for (let k = 0; k < 3; k++) mid[k] += (u[k] * cx + v[k] * cy) * r;
        r = Math.max(0.01, r * Math.min(Math.sqrt(m / s.f.n), off));
      }
    }
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
  segToWorld(s, p, target = new THREE.Vector3()) {
    return this.toWorld(s.piece, frameApply(this.structure.flex.at(s.id, Math.min(1, Math.max(0, segParam(s, p)))), p), target);
  }
  segDirToWorld(s, d, target = new THREE.Vector3(), t = 0.5) { return this.dirToWorld(s.piece, frameDir(this.structure.flex.at(s.id, t), d), target); }
  segToLocal(s, wp) {
    const flex = this.structure.flex, pl = this.toLocal(s.piece, wp);
    let t = 0.5, p = pl;
    for (let n = 0; n < 3; n++) { p = frameInverse(flex.at(s.id, t), pl); t = Math.min(1, Math.max(0, segParam(s, p))); }   // which cross-section is it on?
    return p;
  }

  /** Move the standing tree's colliders to where its bent wood is (only those that have moved). */
  syncColliders() {
    const flex = this.structure.flex;
    for (const [id, base] of this.colBase) {
      const fr = flex.frame(id); if (!fr) continue;
      if (!this.world.pieces.get(this.world.segs.get(id)?.piece)?.fixed) continue;
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
      if (this.world.pieces.get(s.piece).fixed) this.loads.push({ seg, p: this.segToWorld(s, lerp3(s.a, s.b, 0.5)).toArray(), f: [f[0], f[1], f[2]] });
    }
    for (const seg of this.contactRaw.keys()) if (!this.contactF.has(seg)) this.contactF.set(seg, [0, 0, 0]);
    this.contactRaw.clear();

    this.rope.step(dt);          // rope first: the saw and the fibres both need this tick's rope state
    this.players.pre(dt);
    this.chipper.pre(dt);
    if (this.onLoads) this.onLoads(dt);
    this.structure.step(dt);
    if (this.tick % 2 === 0) this.syncColliders();
    this.rollResist();
    this.rapier.step(this.eq, this.hooks);
    this.eq.drainContactForceEvents((e) => this.onContact(e));
    this.players.post(dt);
    this.builds.post();          // before pavers.post: it reads the velocities from before the step
    this.pavers.post();
    this.chipper.post();

    if (this.tick % 60 === 0) this.sweepDebris();
  }

  onContact(e) {
    const h1 = e.collider1(), h2 = e.collider2();
    const mag = e.totalForceMagnitude(), dir = e.maxForceDirection();
    this.pavers.onContact(h1, h2);
    this.builds.onContact(h1, h2, mag);
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

  /**
   * Rolling resistance for loose wood on the ground. Rapier's contacts are points on a rigid plane, so a
   * round log rolls on for ever; on real ground it presses in and the soil ahead pushes back. That is a
   * torque of ROLL_RESIST (a lever arm, m) times the ground's normal force, against the spin, and it
   * never more than stops it.
   */
  rollResist() {
    const arm = CFG.ROLL_RESIST;
    if (!(arm > 0)) return;
    const pushed = new Map();          // body -> normal impulse from the ground last step
    this.rapier.contactPairsWith(this.groundCol, (oc) => {
      const b = oc.parent();
      if (!b || !b.isDynamic() || b.isSleeping() || this.colSeg.get(oc.handle) === undefined) return;
      let J = 0;
      this.rapier.contactPair(this.groundCol, oc, (man) => { for (let i = 0, n = man.numContacts(); i < n; i++) J += man.contactImpulse(i); });
      if (J > 0) pushed.set(b, (pushed.get(b) || 0) + J);
    });
    for (const [b, J] of pushed) {
      const w = b.angvel(), wx = w.x, wy = w.y, wz = w.z, wn = Math.hypot(wx, wy, wz);
      if (wn < 1e-6) continue;
      const nx = wx / wn, ny = wy / wn, nz = wz / wn, e = b.effectiveWorldInvInertia().elements;
      // angular impulse that would stop the spin about that axis: |w| / (n . I^-1 n)
      const q = nx * (e[0] * nx + e[1] * ny + e[2] * nz) + ny * (e[1] * nx + e[3] * ny + e[4] * nz) + nz * (e[2] * nx + e[4] * ny + e[5] * nz);
      const L = Math.min(arm * J, q > 0 ? wn / q : 0);
      b.applyTorqueImpulse({ x: -nx * L, y: -ny * L, z: -nz * L }, true);
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
    const c = this.chipper.body;
    if (c) fn(CHIPPER_BODY_ID, c.translation(), c.rotation(), !c.isSleeping());
    this.builds.eachBody(fn);
  }
  pose(id) {
    const b = id >= PLAYER_BODY_ID ? this.players.list.get(id - PLAYER_BODY_ID)?.body : id === CHIPPER_BODY_ID ? this.chipper.body : this.bodies.get(id) || this.builds.body(id);
    return b ? { p: b.translation(), q: b.rotation() } : null;
  }
  aux() {
    return { t: 'aux', tick: this.tick, pl: this.players.aux(), rope: this.rope.aux(), chip: this.chipper.aux(), ...this.structure.aux() };
  }
}
