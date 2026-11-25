// Host only: the wood chipper (model/chipper.js has its shape and chip piles).
//
// It is a heavy dynamic body on two frictionless wheel balls and a jockey
// wheel. The tyres are modelled here: under the axle they grip sideways (up
// to CHIP_GRIP x the weight on them) and resist rolling a little (CHIP_ROLL),
// so a player holding the grip at the front can tow it and turn it about its
// axle. Nothing else about it is special: rope, wood and players push and
// pull it like any body, and it can be dragged, tipped or hoisted.
//
// Feeding: a loose piece handed to the chipper is drawn into the infeed by
// the feed rollers, a velocity servo at CHIP_FEED_V whose pull is capped at
// CHIP_PULL (the rollers slip past it). The same pull goes back into the
// chipper. A fed piece does not collide with the chipper, and every segment
// that has gone past the drum is chipped: removed from the model ('chip'
// event) and blown out of the discharge chute onto a chip pile.
//
// A rope tied to wood that is chipped follows it into the rollers (world.rope
// anchor {chip: 1}). From then on the rollers reel it in for ever with up to
// CHIP_PULL: the rope pulls the tree toward the chipper and the chipper
// toward the block, and whichever gives first moves. It ends when the rope
// comes free (cut, snapped, block taken down or torn free) or on a reset,
// and the rest of the rope is chipped (sim/rope.js swallow).

import * as THREE from '../../vendor/three/three.module.js';
import { CFG } from '../config.js';
import { segMass } from '../model/world.js';
import { SHAPE, parkedPose, pileShape, CHIPPER_BODY_ID, WRECK } from '../model/chipper.js';
import { compose } from '../model/builds.js';

const THROAT = 0.3;                  // m: the feed point counts as in the mouth within this of the hopper's axis
const _v = new THREE.Vector3(), _q = new THREE.Quaternion(), _a = new THREE.Vector3(), _b = new THREE.Vector3();

export class Chipper {
  constructor(sim) {
    this.sim = sim;
    this.body = null;
    this.cols = new Set();           // collider handles of the chipper
    this.feeding = new Map();        // piece id -> {seg, p: piece-local feed point} (seg -1: pick one)
    this.pileCols = new Map();       // pile index -> {col, r}
    this.colPile = new Map();        // pile collider handle -> pile index
    this.parts = new Map();          // wreck part body id -> RigidBody, once it has crumpled
    this.partCols = new Set();       // collider handles of those parts
    this.hit = null;                 // strongest push on it this step from wood or a structure: {F, o (other collider)}
    this.busy = 0;                   // ticks left of chips flying out of the chute (aux)
    this.stick = { A: null, J: null }; // where the tyres under the axle (A) and the jockey wheel (J) stopped and grip
  }

  /** How far along x it reaches where it is parked, and its chips land: {x0, x1} (world). */
  reach() {
    const pose = parkedPose(CFG.TREE_HEIGHT * CFG.PAVER_RADIUS, CFG.CHIP_GAP), S = SHAPE;
    return { x0: pose.p[0] + S.INFEED[0] - 0.2, x1: pose.p[0] + S.GRIP[0] + 0.2 };
  }

  /** The Tab menu's "Respawn chipper": take away the old one, broken or not, and park a new one (chip piles stay). */
  respawn() {
    if (this.sim.rope.fed()) this.sim.rope.swallow('The chipper was taken away: the rope came free');
    for (const p of this.sim.players.list.values()) if (p.grab && p.grab.chip) p.grab = null;
    this.place(true);
    this.sim.toast('A new chipper');
  }

  /** Park it fresh for the current tree (with every new tree), its wheels on the ground. */
  place(keep = false) {
    const sim = this.sim, pose = parkedPose(CFG.TREE_HEIGHT * CFG.PAVER_RADIUS, CFG.CHIP_GAP), S = SHAPE;
    // the highest ground under a wheel or the jockey wheel, so none starts in the ground; it settles from there
    let y = -Infinity;
    for (const w of [...S.WHEELS, S.JOCKEY]) y = Math.max(y, sim.groundY(pose.p[0] + w[0], pose.p[2] + w[2]));
    pose.p[1] += y;
    sim.emit(keep ? { t: 'chipper', p: pose.p, q: pose.q, keep: 1 } : { t: 'chipper', p: pose.p, q: pose.q });
  }

  // ---- model -> physics ----
  onEvent(ev, info) {
    const sim = this.sim;
    if (ev.t === 'chipper') this.build(ev);
    else if (ev.t === 'chipwreck') this.wreck(ev);
    else if (ev.t === 'reset') this.feeding.clear();
    else if (ev.t === 'rmpiece') this.feeding.delete(ev.piece);
    else if (ev.t === 'split' && info.moved) {
      const f = this.feeding.get(info.oldPiece); if (!f) return;
      const moved = info.moved.includes(f.seg);
      // both sides stay fed; once the wood is in the rollers, only a side that still has wood inside the chipper
      // stays in them (post drops the other: it was sawn off outside)
      this.feeding.set(ev.newPiece, { seg: moved ? f.seg : -1, p: f.p, entered: f.entered, split: f.entered });
      if (moved) f.seg = -1;
      if (f.entered) f.split = true;
    } else if (ev.t === 'chip' || ev.t === 'chips') {
      if (info.gone) for (const pc of info.gone) this.feeding.delete(pc);
      const ch = sim.world.chipper; if (!ch) return;
      ch.piles.forEach((pl, i) => this.pileCollider(i, pl));
    }
  }

  build(ev) {
    const sim = this.sim, R = sim.R;
    this.removeBody();
    for (const b of this.parts.values()) sim.rapier.removeRigidBody(b);
    this.parts.clear(); this.partCols.clear(); this.stick = { A: null, J: null };
    if (!ev.keep) { for (const { col } of this.pileCols.values()) sim.rapier.removeCollider(col, false); this.pileCols.clear(); this.colPile.clear(); }
    const body = sim.rapier.createRigidBody(sim.dynamic().setTranslation(ev.p[0], ev.p[1], ev.p[2])
      .setRotation({ x: ev.q[0], y: ev.q[1], z: ev.q[2], w: ev.q[3] }).setLinearDamping(0.05).setAngularDamping(0.3));
    const M = CFG.CHIP_MASS, S = SHAPE;
    const add = (desc, c, mass, friction = 0.8) => {
      desc.setTranslation(c[0], c[1], c[2]).setMass(mass).setFriction(friction).setActiveHooks(R.ActiveHooks.FILTER_CONTACT_PAIRS)
        .setActiveEvents(R.ActiveEvents.CONTACT_FORCE_EVENTS).setContactForceEventThreshold(300);
      if (friction === 0) desc.setFrictionCombineRule(R.CoefficientCombineRule.Min);
      this.cols.add(sim.rapier.createCollider(desc, body).handle);
    };
    const box = (b, mass) => add(R.ColliderDesc.cuboid(b.h[0], b.h[1], b.h[2]), b.c, mass);
    box(S.CHASSIS, M * 0.8);
    box(S.HOPPER, M * 0.08);
    box(S.DRAWBAR, M * 0.02);
    add(R.ColliderDesc.cuboid(S.GRIP_H[0], S.GRIP_H[1], S.GRIP_H[2]), S.GRIP, M * 0.005);
    for (const w of S.WHEELS) add(R.ColliderDesc.ball(S.WHEEL_R), w, M * 0.04, 0);       // the tyres' grip is modelled in tyres()
    add(R.ColliderDesc.ball(S.JOCKEY_R), S.JOCKEY, M * 0.015, 0);
    this.body = body;
    this.born = sim.tick;            // it settles for a second (pushed out of anything it was put down in) before it can crumple
  }

  removeBody() {
    if (this.body) this.sim.rapier.removeRigidBody(this.body);
    this.body = null; this.cols.clear(); this.feeding.clear(); this.busy = 0; this.hit = null;
  }

  // ---- crumpling: like a shed module (sim/builds.js), it gives way to a hard enough hit and slumps into parts ----
  /** From sim.onContact. Wood and the parts or modules of structures push on it; players, the ground and chips do not count. */
  onContact(h1, h2, F) {
    if (!this.body) return;
    for (const [h, o] of [[h1, h2], [h2, h1]]) {
      if (!this.cols.has(h)) continue;
      const sim = this.sim, bl = sim.builds;
      if (!(sim.colSeg.has(o) || bl.partCol.has(o) || bl.colMod.has(o))) continue;
      if (!this.hit) this.hit = { F: 0, o, f: 0 };
      this.hit.F += F; if (F > this.hit.f) { this.hit.f = F; this.hit.o = o; }
    }
  }

  crumpleCheck() {
    const hit = this.hit; this.hit = null;
    if (!this.body || !hit || hit.F < CFG.CHIP_BREAK_F || this.sim.tick - this.born < 60) return;
    const sim = this.sim, b = this.body, t = b.translation(), r = b.rotation();
    const at = { p: [t.x, t.y, t.z], q: [r.x, r.y, r.z, r.w] };
    // it gave way: what hit it goes on with the velocity it had before this step; the parts start as the chipper was moving
    const oc = sim.rapier.getCollider(hit.o), other = oc ? oc.parent() : null;
    this.burst = { self: sim.builds.preVel(b), other: other && other.isDynamic() ? other : null, otherPre: other ? sim.builds.preVel(other) : null };
    if (sim.rope.fed()) sim.rope.swallow('The chipper is wrecked: the rope came free');
    sim.emit({ t: 'chipwreck', at, ids: WRECK.map(() => sim.world.newId()) });
    sim.toast('The chipper is wrecked!');
  }

  /** A chipwreck event: the chipper's body goes, and each WRECK part is a loose body where it was. */
  wreck(ev) {
    const sim = this.sim, R = sim.R, B = this.burst || { self: [0, 0, 0, 0, 0, 0] }; this.burst = null;
    this.removeBody();
    WRECK.forEach((pt, k) => {
      const f = compose(ev.at.p, ev.at.q, pt.c, pt.q), v = B.self;
      const body = sim.rapier.createRigidBody(sim.dynamic().setTranslation(f.p[0], f.p[1] + 0.002, f.p[2]).setRotation({ x: f.q[0], y: f.q[1], z: f.q[2], w: f.q[3] })
        .setLinvel(v[0], v[1], v[2]).setAngvel({ x: v[3], y: v[4], z: v[5] }).setLinearDamping(0.05).setAngularDamping(0.3).setCcdEnabled(true));
      const desc = pt.mat === 'wheel'
        ? R.ColliderDesc.cylinder(Math.max(0.02, pt.h[2]), pt.h[0]).setRotation({ x: Math.SQRT1_2, y: 0, z: 0, w: Math.SQRT1_2 })
        : R.ColliderDesc.cuboid(pt.h[0], pt.h[1], pt.h[2]);
      const col = sim.rapier.createCollider(desc.setMass(Math.max(1, pt.m * CFG.CHIP_MASS)).setFriction(0.7).setRestitution(0.1)
        .setActiveEvents(R.ActiveEvents.CONTACT_FORCE_EVENTS).setContactForceEventThreshold(300), body);
      this.partCols.add(col.handle);
      this.parts.set(ev.ids[k], body);
    });
    if (B.other && B.otherPre) { const o = B.otherPre; B.other.setLinvel({ x: o[0], y: o[1], z: o[2] }, true); B.other.setAngvel({ x: o[3], y: o[4], z: o[5] }, true); }
  }
  partBody(id) { return this.parts.get(id) || null; }
  /** Calls fn(id, translation, rotation, awake) for the chipper or its wreck. */
  eachBody(fn) {
    if (this.body) fn(CHIPPER_BODY_ID, this.body.translation(), this.body.rotation(), !this.body.isSleeping());
    for (const [id, b] of this.parts) fn(id, b.translation(), b.rotation(), !b.isSleeping());
  }

  // ---- chips: players pick them up off a pile and put them down ----
  /** The chip pile a player is looking at within reach: its index, or -1. */
  aimPile(p) {
    const sim = this.sim, { o, d } = sim.eye(p);
    const hit = sim.rapier.castRay(new sim.R.Ray(o, d), CFG.REACH, true, undefined, undefined, undefined, p.body);
    const i = hit ? this.colPile.get(hit.collider.handle) : undefined;
    return i === undefined ? -1 : i;
  }
  take(p, i) {
    const pl = this.sim.world.chipper?.piles[i]; if (!pl) return;
    const V = Math.min(pl[2], CFG.CHIP_CARRY - (p.chips || 0));
    if (V <= 1e-5) return;
    this.sim.emit({ t: 'chips', take: [i, +V.toFixed(5)] });
    p.chips = (p.chips || 0) + V;
  }
  /** Put all the chips a player carries down where they are looking (on the ground within reach), or at their feet. */
  drop(p) {
    const sim = this.sim; if (!(p.chips > 0) || !sim.world.chipper) return;
    const { o, d } = sim.eye(p);
    const hit = sim.rapier.castRay(new sim.R.Ray(o, d), CFG.REACH, true, undefined, undefined, undefined, p.body);
    const t = p.body.translation();
    const x = hit ? o.x + d.x * hit.timeOfImpact : t.x + d.x * 0.8, z = hit ? o.z + d.z * hit.timeOfImpact : t.z + d.z * 0.8;
    sim.emit({ t: 'chips', drop: [+x.toFixed(2), +z.toFixed(2), +p.chips.toFixed(5)] });
    p.chips = 0;
  }

  /** Is collider h the chipper or one of its wreck parts (something heavy that can crack pavers and break structures)? */
  solid(h) { return this.cols.has(h) || this.partCols.has(h); }
  /** Calls fn(body) for the chipper's body, or its wreck parts. */
  eachRigid(fn) { if (this.body) fn(this.body); for (const b of this.parts.values()) fn(b); }

  /** Is collider handle h part of the chipper? */
  has(h) { return this.cols.has(h); }
  /** Chipper collider h against wood that is being fed in: they pass through each other. */
  noHit(h, seg) {
    if (!this.cols.has(h) || seg === undefined) return false;
    const s = this.sim.world.segs.get(seg);
    return !!s && !!this.feeding.get(s.piece)?.entered;           // until it is in the mouth, it bumps into the chipper
  }

  /** How far a chipper-local point is from the line through the hopper mouth and the drum, and whether it is inside. */
  throat(l) {
    const S = SHAPE, lat = Math.hypot(l[1] - S.INFEED[1], l[2]);
    return { lat, inMouth: l[0] > S.INFEED[0] - 0.1 && lat < THROAT };
  }

  toWorld(l, target = new THREE.Vector3()) {
    const t = this.body.translation(), r = this.body.rotation();
    return target.set(l[0], l[1], l[2]).applyQuaternion(_q.set(r.x, r.y, r.z, r.w)).add(_v.set(t.x, t.y, t.z));
  }
  dirToWorld(d, target = new THREE.Vector3()) {
    const r = this.body.rotation();
    return target.set(d[0], d[1], d[2]).applyQuaternion(_q.set(r.x, r.y, r.z, r.w));
  }
  toLocal(wp) {
    const t = this.body.translation(), r = this.body.rotation();
    const v = new THREE.Vector3(wp.x - t.x, wp.y - t.y, wp.z - t.z).applyQuaternion(_q.set(r.x, r.y, r.z, r.w).invert());
    return [v.x, v.y, v.z];
  }
  infeed(target) { return this.toWorld(SHAPE.INFEED, target); }
  mass() { return this.body ? this.body.mass() : CFG.CHIP_MASS; }

  /** What a player is looking at on the chipper: {point, dist, local, grip} or null. */
  aim(p) {
    if (!this.body) return null;
    const sim = this.sim, { o, d } = sim.eye(p);
    const hit = sim.rapier.castRay(new sim.R.Ray(o, d), 8, true, undefined, undefined, undefined, p.body);
    if (!hit || !this.cols.has(hit.collider.handle)) return null;
    const point = o.clone().addScaledVector(d, hit.timeOfImpact), local = this.toLocal(point), g = SHAPE.GRIP;
    return { point, dist: hit.timeOfImpact, local, grip: Math.hypot(local[0] - g[0], local[1] - g[1], local[2] - g[2]) < 0.45 };
  }

  /** Hand loose wood to the feed rollers, drawn in by piece-local point pl on segment seg. */
  feed(piece, seg, pl) { this.feeding.set(piece, { seg, p: pl }); }

  // ---- per tick, before physics ----
  pre(dt) {
    if (!this.body) return;
    this.tyres(dt);
    const sim = this.sim, w = sim.world, S = SHAPE;
    for (const [piece, f] of [...this.feeding]) {
      const b = sim.bodies.get(piece);
      if (!b || !w.pieces.has(piece)) { this.feeding.delete(piece); continue; }
      let s = w.segs.get(f.seg);
      if (!s || s.piece !== piece) { if (!this.pickFeed(piece, f)) { this.feeding.delete(piece); continue; } s = w.segs.get(f.seg); }
      // The rollers: drive the feed point at CHIP_FEED_V, with no more than CHIP_PULL. First to the hopper mouth
      // (round behind it if the wood is beside the chipper), then straight down the throat to the drum.
      const P = sim.segToWorld(s, f.p, _a), l = this.toLocal(P), th = this.throat(l);
      if (!f.entered && th.inMouth) f.entered = true;
      let aim;
      if (f.entered) aim = [S.DRUM_X + 0.3, S.INFEED[1], 0];                               // down the axis, centred, to the drum
      else if (l[0] > S.INFEED[0] - 0.3) aim = [S.INFEED[0] - 0.9, S.INFEED[1], 0];        // beside or ahead of the mouth: go round
      else aim = [S.INFEED[0] + 0.3, S.INFEED[1], 0];                                       // behind it: into the mouth
      // seized (post found it too heavy at the drum): the rollers stop and clamp it where it is
      const dir = f.seized ? new THREE.Vector3(1, 0, 0) : this.toWorld(aim, _b).sub(P);
      const dist = f.seized ? 0 : dir.length(); dir.multiplyScalar(1 / (dist || 1));
      const vp = b.velocityAtPoint(P), want = f.seized ? 0 : Math.min(CFG.CHIP_FEED_V, dist * 4);   // at the drum they press the wood onto it
      const along = vp.x * dir.x + vp.y * dir.y + vp.z * dir.z;
      const err = new THREE.Vector3(dir.x * want - vp.x, dir.y * want - vp.y, dir.z * want - vp.z), el = err.length();
      // stiff rollers: close the speed error in a few ticks, through the mass the wood presents at the feed point...
      const F = err.multiplyScalar(el > 1e-6 ? effMass(b, P, err.clone().multiplyScalar(1 / el)) / 0.05 : 0);
      // ...and a motor that pulls harder the longer it is held back: up to CHIP_PULL within about a second of stalling
      f.F = f.seized ? 0 : Math.max(0, Math.min(CFG.CHIP_PULL, (f.F || 0) + (want - along) / Math.max(0.05, want) * CFG.CHIP_PULL * dt));
      F.addScaledVector(dir, f.F);
      F.y += b.mass() * CFG.GRAVITY * 0.5;          // the rollers carry the end they hold (about half its weight)
      if (F.length() > CFG.CHIP_PULL) F.setLength(CFG.CHIP_PULL);
      sim.applyForce(s.id, P, F);
      const I = this.infeed(_b);
      this.body.applyImpulseAtPoint({ x: -F.x * dt, y: -F.y * dt, z: -F.z * dt }, I, true);
    }
  }

  /** The feed point becomes the end of the remaining wood nearest the throat (where the last of it was chipped). */
  pickFeed(piece, f) {
    const sim = this.sim; let best = -Infinity, bl = null;
    f.seg = -1;
    for (const s of sim.world.segsOf(piece)) for (const e of [s.a, s.b]) {
      const l = this.toLocal(sim.segToWorld(s, e, _a)), sc = Math.min(l[0], SHAPE.DRUM_X) - 2 * this.throat(l).lat;
      if (sc > best) { best = sc; bl = l; f.seg = s.id; f.p = e.slice(); }
    }
    f.entered = !!bl && bl[0] > SHAPE.INFEED[0] - 0.1 && this.throat(bl).lat < SHAPE.CHASSIS.h[2];   // already inside the chipper
    return f.seg >= 0;
  }

  // The tyres under the axle grip sideways and roll with a little resistance; the jockey wheel castors.
  tyres(dt) {
    const b = this.body; if (b.isSleeping()) return;
    const m = b.mass(), g = CFG.GRAVITY;
    // the parking brake is on unless someone has hold of the grip (the hand brake is on the drawbar); parked, the jockey
    // wheel is clamped too
    const towed = [...this.sim.players.list.values()].some((p) => p.grab && p.grab.chip);
    const S = SHAPE, share = (S.JOCKEY[0] - S.CHASSIS.c[0]) / (S.JOCKEY[0] - S.AXLE[0]);
    // directions along the ground under a point (its tangent plane)
    const flat = (d, n) => d.addScaledVector(n, -d.dot(n)).normalize();
    const sim = this.sim, gn = (P) => { const n = sim.groundN(P.x, P.z); return new THREE.Vector3(n[0], n[1], n[2]); };
    const above = (P) => P.y - sim.groundY(P.x, P.z);
    // Each grip is an impulse along a direction at a point that stops the velocity there, up to a cap (the friction
    // the weight on it allows). They are applied before the physics step, in which gravity pulls along the ground
    // too, so they stop that as well; and they are solved together, a few passes with the total kept within each cap,
    // since one grip's impulse changes the velocity at the other. A gripping tyre also sticks where it is: it is
    // pulled back toward the spot where it stopped (the drift the step's contact forces leave would otherwise add up
    // to a slow creep down a slope), and that spot moves with it whenever it slips (its grip at the cap).
    const grips = [], st = this.stick;
    const A = this.toWorld(S.AXLE, new THREE.Vector3());
    if (above(A) < 0.06) {
      const N = m * g * share, n = gn(A);
      if (!st.A || towed) st.A = A.clone();      // being towed, it rolls: grip only stops sliding, it does not hold a spot
      grips.push({ P: A, at: 'A', d: flat(this.dirToWorld([0, 0, 1], new THREE.Vector3()), n), cap: CFG.CHIP_GRIP * N * dt, J: 0, stick: true });
      grips.push({ P: A, at: 'A', d: flat(this.dirToWorld([1, 0, 0], new THREE.Vector3()), n), cap: (towed ? CFG.CHIP_ROLL : CFG.CHIP_BRAKE) * N * dt, J: 0, stick: !towed });
    } else st.A = null;
    const Jp = this.toWorld([S.JOCKEY[0], S.JOCKEY[1] - S.JOCKEY_R, S.JOCKEY[2]], new THREE.Vector3());
    if (above(Jp) < 0.06) {
      // the castor: whichever way it is sliding, or about to slide this step under gravity (or back to where it stopped)
      if (!st.J || towed) st.J = Jp.clone();
      const v = b.velocityAtPoint(Jp), n = gn(Jp), h = new THREE.Vector3(v.x, v.y - g * dt, v.z).addScaledVector(Jp.clone().sub(st.J), STICK / dt);
      const sp = h.addScaledVector(n, -h.dot(n)).length();
      if (sp > 1e-5) grips.push({ P: Jp, at: 'J', d: h.multiplyScalar(1 / sp), cap: (towed ? CFG.CHIP_ROLL : CFG.CHIP_BRAKE) * m * g * (1 - share) * dt, J: 0, stick: !towed });
    } else st.J = null;
    for (const G of grips) { G.m = effMass(b, G.P, G.d); G.e = G.stick && st[G.at] ? G.P.clone().sub(st[G.at]).dot(G.d) * STICK / dt : 0; }
    for (let pass = 0; pass < 4; pass++) {
      for (const G of grips) {
        const v = b.velocityAtPoint(G.P), d = G.d, vn = v.x * d.x + v.y * d.y + v.z * d.z - g * d.y * dt + G.e;
        const J = Math.max(-G.cap, Math.min(G.cap, G.J - vn * G.m)), dJ = J - G.J;
        G.J = J;
        if (dJ) b.applyImpulseAtPoint({ x: d.x * dJ, y: d.y * dJ, z: d.z * dJ }, G.P, true);
      }
    }
    for (const G of grips) if (Math.abs(G.J) >= G.cap * 0.999 && st[G.at]) st[G.at] = G.P.clone();     // slipping: it sticks again further on
  }

  // ---- after physics: chip whatever has gone past the drum ----
  post() {
    if (!this.body) return;
    if (this.busy > 0) this.busy--;
    const sim = this.sim, w = sim.world, st = sim.structure;
    for (const [piece, f] of [...this.feeding]) {
      if (!w.pieces.has(piece)) { this.feeding.delete(piece); continue; }
      this.knot(piece);
      const segs = w.segsOf(piece), eat = [];
      let left = 0, inAny = false;
      for (const s of segs) {
        const inJoint = st.noHit.has(s.id) || st.rootOf.has(s.id);      // still part of a live joint: the fibres decide
        const a = this.toLocal(sim.segToWorld(s, s.a, _a)), b = this.toLocal(sim.segToWorld(s, s.b, _b));
        // chipped when it reaches the drum with all of it inside the hopper and the chipper's body
        const inside = (l) => this.inside(l);
        if (inside(a) || inside(b)) inAny = true;
        if (!inJoint && f.entered && inside(a) && inside(b) && Math.max(a[0], b[0]) > SHAPE.DRUM_X - 0.1) eat.push(s); else left += segMass(s) + s.leaf;
      }
      if (f.split) { f.split = false; if (!inAny) { this.feeding.delete(piece); continue; } }   // sawn off outside: the rollers let it go
      // The rollers seize on wood they cannot take: when it reaches the drum, the whole contiguous piece (and anything
      // still joined to it by fibres) must weigh no more than CHIP_CAPACITY. Saw it smaller and they run again.
      // Once seized they stay seized (the wood is clamped at the drum) until it is light enough or out of the chipper.
      const heavy = eat.length || f.seized ? this.weight(piece) : 0;
      if ((eat.length || (f.seized && inAny)) && heavy > CFG.CHIP_CAPACITY) {
        if (!f.seized) sim.toast(isFinite(heavy) ? `The chipper's rollers seized: that piece is too heavy (${Math.round(heavy)} kg). Saw it smaller`
          : 'The chipper\'s rollers seized: that wood is still part of the tree. Saw it free');
        f.seized = true; continue;
      }
      f.seized = false;
      if (!eat.length) continue;
      if (left < CFG.DEBRIS_MASS && !st.live.has(piece)) { eat.length = 0; eat.push(...segs); }      // the last twigs go too
      this.chip(piece, f, eat);
    }
  }

  /** Is a chipper-local point inside the hopper and the chipper's body (where wood is chipped)? */
  inside(l) {
    const S = SHAPE;
    return l[0] > S.INFEED[0] - 0.1 && Math.abs(l[2]) < S.CHASSIS.h[2] && Math.abs(l[1] - S.CHASSIS.c[1]) < S.CHASSIS.h[1] + 0.05;
  }

  /** Mass of the contiguous wood: this piece and every piece joined to it by live fibres (Infinity if that is the tree). */
  weight(piece) {
    const w = this.sim.world, live = this.sim.structure.live, seen = new Set([piece]), todo = [piece];
    let m = 0;
    while (todo.length) {
      const id = todo.pop();
      if (w.pieces.get(id)?.fixed) return Infinity;
      for (const s of w.segsOf(id)) m += segMass(s) + s.leaf;
      const near = [];
      const j = live.get(id); if (j) near.push(j.parent);
      for (const [c, jc] of live) if (jc.parent === id) near.push(c);
      for (const n of near) if (!seen.has(n)) { seen.add(n); todo.push(n); }
    }
    return m;
  }

  /** Are the rollers seized on something? (They stop reeling a rope in too.) */
  seized() { for (const f of this.feeding.values()) if (f.seized) return true; return false; }

  /** A rope tied to this wood whose knot has reached the drum goes into the rollers: they have it from now on. */
  knot(piece, force) {
    const sim = this.sim, r = sim.world.rope;
    if (r.state !== 2 || r.anchor.seg === undefined) return;
    const s = sim.world.segs.get(r.anchor.seg);
    if (!s || s.piece !== piece) return;
    if (!force) { const l = this.toLocal(sim.segToWorld(s, r.anchor.p, _a)); if (l[0] < SHAPE.DRUM_X || this.throat(l).lat > SHAPE.CHASSIS.h[2]) return; }
    sim.emit({ t: 'rope', rope: { ...r, anchor: { chip: 1 } } });
    sim.rope.L0 = Math.min(sim.rope.L0, sim.rope.pathLength()); sim.rope.prev = 0;
    sim.toast('The rope went into the chipper!');
  }

  chip(piece, f, eat) {
    const sim = this.sim, w = sim.world, r = w.rope, ids = eat.map((s) => s.id);
    if (r.state === 2 && r.anchor.seg !== undefined && ids.includes(r.anchor.seg)) this.knot(piece, true);   // the rope goes in with its wood
    let V = 0;
    for (const s of eat) V += (segMass(s) + s.leaf) / CFG.DENSITY;
    V *= CFG.CHIP_SWELL;
    const out = this.toWorld([SHAPE.DISCHARGE[0], -SHAPE.BODY_Y, SHAPE.DISCHARGE[1]], _a);
    sim.emit({ t: 'chip', segs: ids, V: +V.toFixed(5), x: +out.x.toFixed(2), z: +out.z.toFixed(2) });
    this.busy = 40;
    if (ids.includes(f.seg)) f.seg = -1;
  }

  /** A pile is a fixed cone collider, rebuilt as it grows or shrinks; an emptied pile has none. */
  pileCollider(i, pl) {
    const sim = this.sim, R = sim.R, { r, h } = pileShape(pl[2]), old = this.pileCols.get(i);
    if (old && Math.abs(old.r - r) < 0.02 && r >= 0.05) return;
    if (old) { sim.rapier.removeCollider(old.col, false); this.colPile.delete(old.col.handle); this.pileCols.delete(i); }
    if (r < 0.05) return;
    const col = sim.rapier.createCollider(R.ColliderDesc.cone(h / 2, r).setTranslation(pl[0], sim.groundY(pl[0], pl[1]) + h / 2, pl[1]).setFriction(1));
    this.pileCols.set(i, { col, r }); this.colPile.set(col.handle, i);
  }

  aux() { return this.body ? { on: this.busy > 0 ? 1 : 0, jam: this.seized() ? 1 : 0 } : null; }
  static get ID() { return CHIPPER_BODY_ID; }
}

/** The mass body b presents to an impulse at world point P along unit n: 1 / (1/m + (r x n) . I^-1 (r x n)). */
const STICK = 0.2;          // fraction of a stuck tyre's drift from where it stopped taken back each step

function effMass(b, P, n) {
  const m = b.mass(), c = b.worldCom(), rx = P.x - c.x, ry = P.y - c.y, rz = P.z - c.z, e = b.effectiveWorldInvInertia().elements;
  const ux = ry * n.z - rz * n.y, uy = rz * n.x - rx * n.z, uz = rx * n.y - ry * n.x;
  const q = ux * (e[0] * ux + e[1] * uy + e[2] * uz) + uy * (e[1] * ux + e[3] * uy + e[4] * uz) + uz * (e[2] * ux + e[4] * uy + e[5] * uz);
  return 1 / (1 / Math.max(1e-6, m) + Math.max(0, q));
}
