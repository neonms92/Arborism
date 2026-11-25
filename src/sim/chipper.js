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
import { SHAPE, parkedPose, pileShape, CHIPPER_BODY_ID } from '../model/chipper.js';

const _v = new THREE.Vector3(), _q = new THREE.Quaternion(), _a = new THREE.Vector3(), _b = new THREE.Vector3();

export class Chipper {
  constructor(sim) {
    this.sim = sim;
    this.body = null;
    this.cols = new Set();           // collider handles of the chipper
    this.feeding = new Map();        // piece id -> {seg, p: piece-local feed point} (seg -1: pick one)
    this.pileCols = new Map();       // pile index -> {col, r}
    this.busy = 0;                   // ticks left of chips flying out of the chute (aux)
  }

  /** Level ground where it is parked (the terrain is made before it is placed): a pad round its middle. */
  pads(blend) {
    const pose = parkedPose(CFG.TREE_HEIGHT * CFG.PAVER_RADIUS, CFG.CHIP_GAP), S = SHAPE;
    const x0 = S.INFEED[0] - 0.2, x1 = S.GRIP[0] + 0.2, mid = (x0 + x1) / 2;
    return [{ x: pose.p[0] + mid, z: pose.p[2], r: Math.hypot((x1 - x0) / 2, S.WHEELS[0][2] + S.WHEEL_R), blend }];
  }

  /** Park it fresh for the current tree (with every new tree), its wheels on the ground. */
  place() {
    const sim = this.sim, pose = parkedPose(CFG.TREE_HEIGHT * CFG.PAVER_RADIUS, CFG.CHIP_GAP), S = SHAPE;
    // the highest ground under a wheel or the jockey wheel, so none starts in the ground; it settles from there
    let y = -Infinity;
    for (const w of [...S.WHEELS, S.JOCKEY]) y = Math.max(y, sim.groundY(pose.p[0] + w[0], pose.p[2] + w[2]));
    pose.p[1] += y;
    sim.emit({ t: 'chipper', p: pose.p, q: pose.q });
  }

  // ---- model -> physics ----
  onEvent(ev, info) {
    const sim = this.sim;
    if (ev.t === 'chipper') this.build(ev);
    else if (ev.t === 'reset') this.feeding.clear();
    else if (ev.t === 'rmpiece') this.feeding.delete(ev.piece);
    else if (ev.t === 'split' && info.moved) {
      const f = this.feeding.get(info.oldPiece); if (!f) return;
      const moved = info.moved.includes(f.seg);
      this.feeding.set(ev.newPiece, { seg: moved ? f.seg : -1, p: f.p });
      if (moved) f.seg = -1;
    } else if (ev.t === 'chip') {
      for (const pc of info.gone) this.feeding.delete(pc);
      const ch = sim.world.chipper; if (!ch) return;
      ch.piles.forEach((pl, i) => this.pileCollider(i, pl));
    }
  }

  build(ev) {
    const sim = this.sim, R = sim.R;
    if (this.body) sim.rapier.removeRigidBody(this.body);
    for (const { col } of this.pileCols.values()) sim.rapier.removeCollider(col, false);
    this.pileCols.clear(); this.cols.clear(); this.feeding.clear(); this.busy = 0;
    const body = sim.rapier.createRigidBody(sim.dynamic().setTranslation(ev.p[0], ev.p[1], ev.p[2])
      .setRotation({ x: ev.q[0], y: ev.q[1], z: ev.q[2], w: ev.q[3] }).setLinearDamping(0.05).setAngularDamping(0.3));
    const M = CFG.CHIP_MASS, S = SHAPE;
    const add = (desc, c, mass, friction = 0.8) => {
      desc.setTranslation(c[0], c[1], c[2]).setMass(mass).setFriction(friction).setActiveHooks(R.ActiveHooks.FILTER_CONTACT_PAIRS);
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
  }

  /** Is collider handle h part of the chipper? */
  has(h) { return this.cols.has(h); }
  /** Chipper collider h against wood that is being fed in: they pass through each other. */
  noHit(h, seg) {
    if (!this.cols.has(h) || seg === undefined) return false;
    const s = this.sim.world.segs.get(seg);
    return !!s && this.feeding.has(s.piece);
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
    const sim = this.sim, w = sim.world, deep = [SHAPE.DRUM_X + 4, SHAPE.INFEED[1], 0];
    for (const [piece, f] of [...this.feeding]) {
      const b = sim.bodies.get(piece);
      if (!b || !w.pieces.has(piece)) { this.feeding.delete(piece); continue; }
      let s = w.segs.get(f.seg);
      if (!s || s.piece !== piece) { if (!this.pickFeed(piece, f)) { this.feeding.delete(piece); continue; } s = w.segs.get(f.seg); }
      // the rollers: drive the feed point toward the drum at CHIP_FEED_V, with no more than CHIP_PULL
      const P = sim.segToWorld(s, f.p, _a), dir = this.toWorld(deep, _b).sub(P);
      const dist = dir.length(); dir.multiplyScalar(1 / (dist || 1));
      const vp = b.velocityAtPoint(P), want = CFG.CHIP_FEED_V;           // the target is well past the drum: they never stop
      const along = vp.x * dir.x + vp.y * dir.y + vp.z * dir.z;
      const err = new THREE.Vector3(dir.x * want - vp.x, dir.y * want - vp.y, dir.z * want - vp.z), el = err.length();
      // stiff rollers: close the speed error in a few ticks, through the mass the wood presents at the feed point...
      const F = err.multiplyScalar(el > 1e-6 ? effMass(b, P, err.clone().multiplyScalar(1 / el)) / 0.05 : 0);
      // ...and a motor that pulls harder the longer it is held back: up to CHIP_PULL within about a second of stalling
      f.F = Math.max(0, Math.min(CFG.CHIP_PULL, (f.F || 0) + (want - along) / Math.max(0.05, want) * CFG.CHIP_PULL * dt));
      F.addScaledVector(dir, f.F);
      F.y += b.mass() * CFG.GRAVITY * 0.5;          // the rollers carry the end they hold (about half its weight)
      if (F.length() > CFG.CHIP_PULL) F.setLength(CFG.CHIP_PULL);
      sim.applyForce(s.id, P, F);
      const I = this.infeed(_b);
      this.body.applyImpulseAtPoint({ x: -F.x * dt, y: -F.y * dt, z: -F.z * dt }, I, true);
    }
  }

  /** The feed point becomes the end of the remaining wood nearest the drum. */
  pickFeed(piece, f) {
    const sim = this.sim; let best = -Infinity;
    f.seg = -1;
    for (const s of sim.world.segsOf(piece)) for (const e of [s.a, s.b]) {
      const x = this.toLocal(sim.segToWorld(s, e, _a))[0];
      if (x > best) { best = x; f.seg = s.id; f.p = e.slice(); }
    }
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
    const meff = (P, n) => effMass(b, P, n);
    const push = (P, n, v, cap) => {          // impulse along n at P that stops velocity v along n, up to cap
      const J = Math.max(-cap, Math.min(cap, -v * meff(P, n)));
      if (J) b.applyImpulseAtPoint({ x: n.x * J, y: n.y * J, z: n.z * J }, P, true);
    };
    // directions along the ground under a point (its tangent plane)
    const flat = (d, n) => d.addScaledVector(n, -d.dot(n)).normalize();
    const sim = this.sim, gn = (P) => { const n = sim.groundN(P.x, P.z); return new THREE.Vector3(n[0], n[1], n[2]); };
    const above = (P) => P.y - sim.groundY(P.x, P.z);
    const A = this.toWorld(S.AXLE, new THREE.Vector3());
    if (above(A) < 0.06) {
      const N = m * g * share, n = gn(A);
      const side = flat(this.dirToWorld([0, 0, 1], new THREE.Vector3()), n);
      const fwd = flat(this.dirToWorld([1, 0, 0], new THREE.Vector3()), n);
      let v = b.velocityAtPoint(A);
      push(A, side, v.x * side.x + v.y * side.y + v.z * side.z, CFG.CHIP_GRIP * N * dt);
      v = b.velocityAtPoint(A);
      push(A, fwd, v.x * fwd.x + v.y * fwd.y + v.z * fwd.z, (towed ? CFG.CHIP_ROLL : CFG.CHIP_BRAKE) * N * dt);
    }
    const J = this.toWorld([S.JOCKEY[0], S.JOCKEY[1] - S.JOCKEY_R, S.JOCKEY[2]], new THREE.Vector3());
    if (above(J) < 0.06) {
      const v = b.velocityAtPoint(J), n = gn(J), h = new THREE.Vector3(v.x, v.y, v.z), sp = h.addScaledVector(n, -h.dot(n)).length();
      if (sp > 1e-4) push(J, h.multiplyScalar(1 / sp), sp, (towed ? CFG.CHIP_ROLL : CFG.CHIP_BRAKE) * m * g * (1 - share) * dt);
    }
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
      let left = 0;
      for (const s of segs) {
        const inJoint = st.noHit.has(s.id) || st.rootOf.has(s.id);      // still part of a live joint: the fibres decide
        const a = this.toLocal(sim.segToWorld(s, s.a, _a)), b = this.toLocal(sim.segToWorld(s, s.b, _b));
        const inside = (l) => l[0] > SHAPE.DRUM_X && Math.abs(l[2]) < 2 && l[1] > -1.5 && l[1] < 2.5;
        if (!inJoint && inside(a) && inside(b)) eat.push(s); else left += segMass(s) + s.leaf;
      }
      if (!eat.length) continue;
      if (left < CFG.DEBRIS_MASS && !st.live.has(piece)) { eat.length = 0; eat.push(...segs); }      // the last twigs go too
      this.chip(piece, f, eat);
    }
  }

  /** A rope tied to this wood whose knot has reached the drum goes into the rollers: they have it from now on. */
  knot(piece, force) {
    const sim = this.sim, r = sim.world.rope;
    if (r.state !== 2 || r.anchor.seg === undefined) return;
    const s = sim.world.segs.get(r.anchor.seg);
    if (!s || s.piece !== piece) return;
    if (!force && this.toLocal(sim.segToWorld(s, r.anchor.p, _a))[0] < SHAPE.DRUM_X) return;
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

  /** A pile is a fixed cone collider, rebuilt as it grows. */
  pileCollider(i, pl) {
    const sim = this.sim, R = sim.R, { r, h } = pileShape(pl[2]), old = this.pileCols.get(i);
    if (r < 0.05 || (old && Math.abs(old.r - r) < 0.02)) return;
    if (old) sim.rapier.removeCollider(old.col, false);
    const col = sim.rapier.createCollider(R.ColliderDesc.cone(h / 2, r).setTranslation(pl[0], sim.groundY(pl[0], pl[1]) + h / 2, pl[1]).setFriction(1));
    this.pileCols.set(i, { col, r });
  }

  aux() { return this.body ? { on: this.busy > 0 ? 1 : 0 } : null; }
  static get ID() { return CHIPPER_BODY_ID; }
}

/** The mass body b presents to an impulse at world point P along unit n: 1 / (1/m + (r x n) . I^-1 (r x n)). */
function effMass(b, P, n) {
  const m = b.mass(), c = b.worldCom(), rx = P.x - c.x, ry = P.y - c.y, rz = P.z - c.z, e = b.effectiveWorldInvInertia().elements;
  const ux = ry * n.z - rz * n.y, uy = rz * n.x - rx * n.z, uz = rx * n.y - ry * n.x;
  const q = ux * (e[0] * ux + e[1] * uy + e[2] * uz) + uy * (e[1] * ux + e[3] * uy + e[4] * uz) + uz * (e[2] * ux + e[4] * uy + e[5] * uz);
  return 1 / (1 / Math.max(1e-6, m) + Math.max(0, q));
}
