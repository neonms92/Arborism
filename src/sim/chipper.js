// Host only: the wood chipper (model/chipper.js has its shape and chip piles).
//
// It is a heavy dynamic body on two frictionless wheel balls and a jockey
// wheel. The tyres are modelled here: under the axle they grip sideways (up
// to CHIP_GRIP x the weight on them) and resist rolling a little (CHIP_ROLL),
// so a player holding the grip at the front can tow it and turn it about its
// axle. Nothing else about it is special: rope, wood and players push and
// pull it like any body, and it can be dragged, tipped or hoisted.
//
// Feeding: a loose piece handed to the chipper goes on the winch over the
// hopper (D84): the player's grab rope, still tied where they held the wood,
// is reeled in at CHIP_FEED_V with up to CHIP_WINCH_F, pulling straight
// toward the winch (a rope: it only pulls). As soon as any of the wood is
// past the hopper's front (its mouth) and inside it, the rope comes off and
// the wood is drawn in by
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
//
// There can be more than one (the Tab menu's "Buy a new chipper"): sim.chipper
// is a Chippers, which holds each Chipper (unit k, world.chipper.units[k]) and
// the chip piles they share. Each unit has its own body, feed and tyres.

import * as THREE from '../../vendor/three/three.module.js';
import { CFG } from '../config.js';
import { segMass } from '../model/world.js';
import { SHAPE, parkedPose, pileShape, chipToWorld, CHIPPER_BODY_ID, WRECK, cageArc } from '../model/chipper.js';
import { compose } from '../model/builds.js';

const THROAT = 0.3;                  // m: the feed point counts as in the mouth within this of the hopper's axis
const _v = new THREE.Vector3(), _q = new THREE.Quaternion(), _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3();

/** All the chippers, and the chip piles they make. What the rest of the sim talks to (sim.chipper). */
export class Chippers {
  constructor(sim) {
    this.sim = sim;
    this.units = [];                 // Chipper per world.chipper.units[k]
    this.pileCols = new Map();       // pile index -> {col, r}
    this.colPile = new Map();        // pile collider handle -> pile index
  }
  unit(k) { return this.units[k || 0] || null; }
  /** The one whose feed rollers have the rope (world.rope.anchor {chip: 1, k}), or null. */
  fedUnit() { const r = this.sim.world.rope; return r.state === 2 && r.anchor.chip ? this.unit(r.anchor.k) : null; }

  /** Park the first one fresh with every new tree (at the spot the yard plan gives), its wheels on the ground. */
  place(keep = false, spot = this.spot) {
    this.spot = spot;
    const pose = this.pose(spot);
    this.sim.emit({ t: 'chipper', p: pose.p, q: pose.q });
  }
  /** Where a chipper parked at spot (or by the old paved circle on flat ground) stands, lifted so no wheel starts in the ground. */
  pose(spot, off = [0, 0]) {
    const sim = this.sim, S = SHAPE;
    const pose = spot ? { p: [spot.x, S.BODY_Y, spot.z], q: [0, Math.sin(spot.yaw / 2), 0, Math.cos(spot.yaw / 2)] } : parkedPose(CFG.TREE_HEIGHT * CFG.PAVER_RADIUS, CFG.CHIP_GAP);
    if (off[0] || off[1]) {   // moved from that spot by off = [along, across] metres in its own frame (across: toward -z, away from the chute)
      const z = chipToWorld([0, 0, 0], pose.q, [off[0], 0, -off[1]]);
      pose.p[0] += z[0]; pose.p[2] += z[2];
    }
    let y = -Infinity;
    for (const w of [...S.WHEELS, S.JOCKEY]) { const g = chipToWorld(pose.p, pose.q, w); y = Math.max(y, sim.groundY(g[0], g[2])); }
    pose.p[1] += y;
    return pose;
  }

  /** The Tab menu's "Buy a new chipper" (by player p): one more, beside the others; the ones there stay as they are. */
  buy(p) {
    const sim = this.sim, w = sim.world, who = p ? sim.players.name(p.id) : 'Someone';
    if (!w.chipper) return;
    if (this.units.length >= CFG.CHIP_MAX) { sim.toast(`There are already ${this.units.length} chippers (the most, CHIP_MAX)`, p ? p.id : -1); return; }
    // the nearest clear spot to where the first was parked: side by side with it (3.2 m apart, the rack side first),
    // or ahead of or behind it, out to 4 rows each way
    let pose = null;
    const offs = [];
    for (let i = -4; i <= 4; i++) for (let j = -4; j <= 4; j++) if (i || j) offs.push([i * 6, j * 3.2 + (j > 0 ? 0 : -0.01)]);
    offs.sort((a, b) => Math.hypot(...a) - Math.hypot(...b));
    for (const off of offs) {
      const c = this.pose(this.spot, off);
      if (this.clear(c)) { pose = c; break; }
    }
    if (!pose) { pose = this.pose(this.spot, [0, 3.2]); pose.p[1] += 2.5; }     // nowhere clear: dropped in from above beside the first
    const k = this.units.length;
    sim.emit({ t: 'chipper', add: 1, k, p: pose.p, q: pose.q });
    if (CFG.CHIPPER_PRICE > 0) sim.emit({ t: 'buy', cost: CFG.CHIPPER_PRICE });
    sim.toast(`${who} bought a new chipper: {money:${Math.round(CFG.CHIPPER_PRICE)}}`);
  }
  /** Is the space a chipper at this pose takes (its chassis and cage, lifted a little off the ground) free of anything but the ground? */
  clear(pose) {
    const sim = this.sim, R = sim.R, S = SHAPE;
    const c = chipToWorld(pose.p, pose.q, [S.GRIP[0] / 2 + S.INFEED[0] / 2, 0.45, 0]), hz = Math.max(...cageArc().map(([, z]) => Math.abs(z)));
    const shape = new R.Cuboid((S.GRIP[0] - S.INFEED[0]) / 2 + 0.2, 0.9, hz + 0.2);
    let hit = false;
    sim.rapier.intersectionsWithShape({ x: c[0], y: c[1], z: c[2] }, { x: pose.q[0], y: pose.q[1], z: pose.q[2], w: pose.q[3] }, shape, (col) => {
      if (col.handle === sim.groundCol.handle || this.colPile.has(col.handle)) return true;   // the ground and chip piles are fine
      hit = true; return false;
    });
    return !hit;
  }

  // ---- model -> physics ----
  onEvent(ev, info) {
    if (ev.t === 'chipper') {
      if (!ev.add) {
        for (const u of this.units) u.destroy();
        this.units = [];
        for (const { col } of this.pileCols.values()) this.sim.rapier.removeCollider(col, false);
        this.pileCols.clear(); this.colPile.clear();
      }
      const k = ev.add ? ev.k : 0, u = new Chipper(this.sim, k);
      this.units[k] = u; u.build(ev);
      return;
    }
    if (ev.t === 'chipwreck') { this.unit(ev.k)?.wreck(ev); return; }
    for (const u of this.units) u.onEvent(ev, info);
    if (ev.t === 'chip' || ev.t === 'chips') {
      const ch = this.sim.world.chipper; if (!ch) return;
      ch.piles.forEach((pl, i) => this.pileCollider(i, pl));
    }
  }

  pre(dt) { for (const u of this.units) u.pre(dt); }
  post() { for (const u of this.units) u.post(); }
  crumpleCheck() { for (const u of this.units) u.crumpleCheck(); }
  onContact(h1, h2, F) { for (const u of this.units) u.onContact(h1, h2, F); }
  noHit(h, seg) { for (const u of this.units) if (u.noHit(h, seg)) return true; return false; }
  eachBody(fn) { for (const u of this.units) u.eachBody(fn); }
  eachRigid(fn) { for (const u of this.units) u.eachRigid(fn); }
  solid(h) { return this.units.some((u) => u.solid(h)); }
  has(h) { return this.units.some((u) => u.has(h)); }
  partBody(id) { for (const u of this.units) { const b = u.partBody(id); if (b) return b; } return null; }
  /** The body of transform snapshot id (CHIPPER_BODY_ID + k), or null. */
  bodyOf(id) { const u = this.unit(id - CHIPPER_BODY_ID); return u ? u.body : null; }
  /** Is someone holding chipper k's grip? (Its brakes come off.) */
  towed(k) { for (const p of this.sim.players.list.values()) if (p.grab && p.grab.chip && (p.grab.k || 0) === k) return true; return false; }
  /** Everyone holding chipper k's grip lets go (it went away or crumpled). */
  letGo(k) { for (const p of this.sim.players.list.values()) if (p.grab && p.grab.chip && (p.grab.k || 0) === k) p.grab = null; }

  /** What a player is looking at on any chipper: {u, point, dist, local, grip, rack} or null. */
  aim(p) {
    const sim = this.sim, { o, d } = sim.eye(p);
    const hit = sim.rapier.castRay(new sim.R.Ray(o, d), 8, true, undefined, undefined, undefined, p.body);
    const h = hit ? hit.collider.handle : -1, far = hit ? hit.timeOfImpact : 8;
    let best = null;
    for (const u of this.units) {
      if (!u.body) continue;
      // the salad rack (no collider of its own): the ray against its box, unless something not of this chipper is in front
      const rt = u.rackHit(o, d);
      if (rt !== null && rt <= far + 1e-3 + (u.cols.has(h) ? 2 : 0) && (!best || rt < best.dist)) {
        const point = o.clone().addScaledVector(d, rt);
        best = { u, point, dist: rt, local: u.toLocal(point), grip: false, rack: true };
      }
    }
    if (best) return best;
    if (!hit) return null;
    const u = this.units.find((x) => x.cols.has(h)); if (!u) return null;
    const point = o.clone().addScaledVector(d, hit.timeOfImpact), local = u.toLocal(point), g = SHAPE.GRIP;
    return { u, point, dist: hit.timeOfImpact, local, grip: Math.hypot(local[0] - g[0], local[1] - g[1], local[2] - g[2]) < 0.45, rack: false };
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
    // put down over an open bin, they go into it and are gone (sim/bin.js)
    if (sim.bins.catchAt(x, z) !== undefined) sim.emit({ t: 'chips', dump: +p.chips.toFixed(5) });
    else sim.emit({ t: 'chips', drop: [+x.toFixed(2), +z.toFixed(2), +p.chips.toFixed(5)] });
    p.chips = 0;
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

  /** aux.chip: per chipper k, what the view needs ({on, jam, wn}), null for one wrecked. */
  aux() { return this.units.map((u) => u.aux()); }
}

/** One chipper: its body (or its wreck), feed rollers, winch and tyres. */
export class Chipper {
  constructor(sim, k = 0) {
    this.sim = sim; this.k = k;
    this.body = null;
    this.cols = new Set();           // collider handles of the chipper
    this.feeding = new Map();        // piece id -> {seg, p: piece-local feed point} (seg -1: pick one)
    this.parts = new Map();          // wreck part body id -> RigidBody, once it has crumpled
    this.partCols = new Set();       // collider handles of those parts
    this.hit = null;                 // strongest push on it this step from wood or a structure: {F, o (other collider)}
    this.busy = 0;                   // ticks left of chips flying out of the chute (aux)
    this.stick = { A: null, J: null }; // where the tyres under the axle (A) and the jockey wheel (J) stopped and grip
  }

  /** Gone with a new tree: its body or its wreck parts come out of the physics world. */
  destroy() {
    this.removeBody();
    for (const b of this.parts.values()) this.sim.rapier.removeRigidBody(b);
    this.parts.clear(); this.partCols.clear();
  }

  // ---- model -> physics ----
  onEvent(ev, info) {
    if (ev.t === 'reset') this.feeding.clear();
    else if (ev.t === 'rmpiece') this.feeding.delete(ev.piece);
    else if (ev.t === 'split' && info.moved) {
      const f = this.feeding.get(info.oldPiece); if (!f) return;
      const moved = info.moved.includes(f.seg);
      // not in the hopper yet: the winch rope stays with the side it is tied to, the other side falls away
      if (f.wait) { if (info.moved.includes(f.wseg)) { this.feeding.delete(info.oldPiece); this.feeding.set(ev.newPiece, f); } return; }
      // in the rollers with the rope still on: it goes with the side it is tied to
      const wMoved = !!f.winch && info.moved.includes(f.wseg);
      // both sides stay fed; once the wood is in the rollers, only a side that still has wood inside the chipper
      // stays in them (post drops the other: it was sawn off outside)
      this.feeding.set(ev.newPiece, { seg: moved ? f.seg : -1, p: f.p, entered: f.entered, split: f.entered,
        winch: wMoved, wseg: f.wseg, wp: f.wp, by: f.by });
      if (moved) f.seg = -1;
      if (wMoved) f.winch = false;
      if (f.entered) f.split = true;
    } else if (ev.t === 'chip' || ev.t === 'chips') {
      if (info.gone) for (const pc of info.gone) this.feeding.delete(pc);
    }
  }

  build(ev) {
    const sim = this.sim, R = sim.R;
    this.removeBody();
    for (const b of this.parts.values()) sim.rapier.removeRigidBody(b);
    this.parts.clear(); this.partCols.clear(); this.stick = { A: null, J: null };
    const body = sim.rapier.createRigidBody(sim.dynamic().setTranslation(ev.p[0], ev.p[1], ev.p[2])
      .setRotation({ x: ev.q[0], y: ev.q[1], z: ev.q[2], w: ev.q[3] }).setLinearDamping(0.05).setAngularDamping(0.3)
      // Rapier would put it to sleep below 0.5 rad/s, which a 350 kg body rolling slowly off its roof is (D91); it is one body
      .setCanSleep(false));
    const M = CFG.CHIP_MASS, S = SHAPE;
    const add = (desc, c, mass, friction = 0.8) => {
      desc.setTranslation(c[0], c[1], c[2]).setMass(mass).setFriction(friction).setActiveHooks(R.ActiveHooks.FILTER_CONTACT_PAIRS)
        .setActiveEvents(R.ActiveEvents.CONTACT_FORCE_EVENTS).setContactForceEventThreshold(300);
      if (friction === 0) desc.setFrictionCombineRule(R.CoefficientCombineRule.Min);
      this.cols.add(sim.rapier.createCollider(desc, body).handle);
    };
    const box = (b, mass) => add(R.ColliderDesc.cuboid(b.h[0], b.h[1], b.h[2]), b.c, mass);
    box(S.CHASSIS, M * 0.45);
    box(S.BALLAST, M * 0.34);       // mass only: it is inside the chassis
    // the roll cage: the hull of its two hoops, a dome over the chassis that rolls it back onto its wheels (D91)
    const arc = cageArc(), hull = new Float32Array(arc.length * 6);
    arc.forEach(([y, z], i) => hull.set([S.CAGE.x0, y, z, S.CAGE.x1, y, z], i * 6));
    add(R.ColliderDesc.convexHull(hull), [0, 0, 0], M * 0.01);
    box(S.HOPPER, M * 0.08); this.hopperCol = [...this.cols].pop();
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
    if (sim.chipper.fedUnit() === this) sim.rope.swallow('The chipper is wrecked: the rope came free');
    sim.chipper.letGo(this.k);
    sim.awards.broke('wreck', hit.o);             // a sticker for whoever sent the wood (D107)
    sim.emit({ t: 'chipwreck', k: this.k, at, ids: WRECK.map(() => sim.world.newId()) });
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
    if (this.body) fn(CHIPPER_BODY_ID + this.k, this.body.translation(), this.body.rotation(), !this.body.isSleeping());
    for (const [id, b] of this.parts) fn(id, b.translation(), b.rotation(), !b.isSleeping());
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
    const f = s && this.feeding.get(s.piece); if (!f) return false;
    // Fed wood folds into the hopper (a funnel, not a box): side branches and a log's rim never catch on it. The rest
    // of the chipper it bumps into until its end is in the mouth, then it passes through on its way to the drum.
    return f.entered || h === this.hopperCol;
  }

  /** How far a chipper-local point is from the line through the hopper mouth and the drum, and whether it is inside. */
  throat(l, r = 0) {
    // in the mouth once the end of the wood (r: its radius there) has reached the hopper's opening: a log's end
    // meets the hopper's face while its centre line is still r short of it
    const S = SHAPE, lat = Math.hypot(l[1] - S.INFEED[1], l[2]);
    return { lat, inMouth: l[0] > S.INFEED[0] - 0.1 - r && lat < THROAT };
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

  /** How far along the ray from o (world, unit d) it meets the salad rack's box, or null. */
  rackHit(o, d) {
    if (!this.body) return null;
    const lo = this.toLocal(o), t = this.body.translation(), ld = this.toLocal({ x: t.x + d.x, y: t.y + d.y, z: t.z + d.z });
    const R = SHAPE.RACK; let t0 = 0, t1 = 8;
    for (let i = 0; i < 3; i++) {
      const lo_ = R.c[i] - R.h[i] - lo[i], hi = R.c[i] + R.h[i] - lo[i];
      if (Math.abs(ld[i]) < 1e-9) { if (lo_ > 0 || hi < 0) return null; continue; }
      let a = lo_ / ld[i], b = hi / ld[i]; if (a > b) [a, b] = [b, a];
      t0 = Math.max(t0, a); t1 = Math.min(t1, b); if (t0 > t1) return null;
    }
    return t0;
  }

  /** Hand loose wood to the feed rollers, drawn in by piece-local point pl on segment seg. */
  feed(piece, seg, pl, by = -1) {
    // The grab rope goes from the player's hands onto the winch, still tied where they held the wood.
    // wait: no part of it in the hopper yet, so the rollers have nothing to take
    this.feeding.set(piece, { seg, p: pl.slice(), wseg: seg, wp: pl.slice(), winch: true, wait: true, by });   // by: who fed it (stickers)
  }

  /** Is a chipper-local point past the hopper's front (its mouth) and inside the hopper or the body behind it? */
  inHopper(l, r = 0) {
    const S = SHAPE, H = S.HOPPER;
    return l[0] > S.INFEED[0] - r && l[0] < S.DRUM_X && Math.abs(l[1] - H.c[1]) < H.h[1] + r && Math.abs(l[2]) < H.h[2] + r;
  }

  /** The point of this piece furthest into the hopper, if any of it is past the mouth: {seg, p} or null. */
  intoHopper(piece) {
    const sim = this.sim; let best = null, bx = -Infinity;
    for (const s of sim.world.segsOf(piece)) {
      for (let k = 0; k <= 4; k++) {
        const t = k / 4, pl = [s.a[0] + (s.b[0] - s.a[0]) * t, s.a[1] + (s.b[1] - s.a[1]) * t, s.a[2] + (s.b[2] - s.a[2]) * t];
        const l = this.toLocal(sim.segToWorld(s, pl, _a));
        if (this.inHopper(l, feedR(s, pl)) && l[0] > bx) { bx = l[0]; best = { seg: s.id, p: pl }; }
      }
    }
    return best;
  }

  /** The winch reels the grab rope in: a pull toward the winch only (a rope does not push), up to CHIP_WINCH_F. */
  winch(b, s, f, dt) {
    const sim = this.sim, P = sim.segToWorld(s, f.wp, _a), W = this.toWorld(SHAPE.WINCH, _b);
    const dir = W.clone().sub(P), d = dir.length();
    if (d < 0.3) { f.winch = false; f.T = 0; return; }       // reeled all the way in: the rope comes off
    dir.multiplyScalar(1 / d);
    const vp = b.velocityAtPoint(P), along = vp.x * dir.x + vp.y * dir.y + vp.z * dir.z;
    const want = Math.min(CFG.CHIP_FEED_V, Math.max(0, d - 0.15) * 4);
    // as the rollers do: the impulse that brings it to the reeling speed, plus a motor term that builds up while the
    // wood lags (snagged on the ground or the chipper) and drops away once it keeps up; never past CHIP_WINCH_F
    f.wvs = (f.wvs ?? along) * 0.85 + along * 0.15;
    f.wF = f.wvs >= want ? 0 : Math.min(CFG.CHIP_WINCH_F, 10 * b.mass() * CFG.GRAVITY, (f.wF || 0) + (want - along) / Math.max(0.05, want) * CFG.CHIP_WINCH_F * dt);
    // (half the gap each tick, as the rollers do: a whole-gap snap swung long wood about the rope and drove its far
    // end down through the ground)
    const J = Math.min(CFG.CHIP_WINCH_F * dt, Math.max(0, 0.5 * (want - along) * effMass(b, P, dir)) + f.wF * dt);
    f.T = J / dt;                                           // rope tension, for the view and tests
    if (f.wait) {
      // until it reaches the hopper half its weight rides on the hopper's tray, as it did on the rollers before the
      // winch (D70): its tips are not ploughed into the ground on the way
      const mg = b.mass() * CFG.GRAVITY * dt * 0.5;
      b.applyImpulse({ x: 0, y: mg, z: 0 }, true); this.body.applyImpulseAtPoint({ x: 0, y: -mg, z: 0 }, this.infeed(_c), true);
    }
    if (!J) return;
    sim.applyForce(s.id, P, dir.clone().multiplyScalar(J / dt));
    this.body.applyImpulseAtPoint({ x: -dir.x * J, y: -dir.y * J, z: -dir.z * J }, W, true);
  }

  // ---- per tick, before physics ----
  pre(dt) {
    if (!this.body) return;
    this.tyres(dt);
    const sim = this.sim, w = sim.world, S = SHAPE;
    for (const [piece, f] of [...this.feeding]) {
      const b = sim.bodies.get(piece);
      if (!b || !w.pieces.has(piece)) { this.feeding.delete(piece); continue; }
      let s = w.segs.get(f.seg);
      // The winch reels its rope in until the point it is tied to is at the drum. Meanwhile, as soon as any of the
      // wood is past the hopper's mouth, the rollers take it there (the winch keeps lifting the rest in after it).
      if (f.winch) {
        const ws = w.segs.get(f.wseg);
        if (ws && ws.piece === piece && !f.seized) this.winch(b, ws, f, dt); else { f.winch = false; f.T = 0; }
      }
      if (f.wait) {
        const into = this.intoHopper(piece);
        if (!into) { if (!f.winch) this.feeding.delete(piece); continue; }   // the rope's wood was sawn off outside
        f.wait = false; f.entered = true; f.seg = into.seg; f.p = into.p; s = w.segs.get(f.seg);
      }
      if (!s || s.piece !== piece) { if (!this.pickFeed(piece, f)) { this.feeding.delete(piece); continue; } s = w.segs.get(f.seg); }
      // The rollers: drive the feed point at CHIP_FEED_V, with no more than CHIP_PULL. First to the hopper mouth
      // (round behind it if the wood is beside the chipper), then straight down the throat to the drum.
      const P = sim.segToWorld(s, f.p, _a), l = this.toLocal(P), th = this.throat(l, feedR(s, f.p));
      if (!f.entered && th.inMouth) f.entered = true;
      let aim;
      if (f.entered) aim = [S.DRUM_X + 0.3, S.INFEED[1], 0];                               // down the axis, centred, to the drum
      else {
        // Beside, above or ahead of the mouth (off its axis): first round to a point on the axis behind it, all the
        // way there, then in. (Deciding afresh each tick flipped between the two where they meet and held the wood
        // there, short of the mouth, for ever.)
        const back = [S.INFEED[0] - 0.9, S.INFEED[1], 0];
        if (!f.round && l[0] > S.INFEED[0] - 0.3 && th.lat > THROAT) f.round = true;
        if (f.round && Math.hypot(l[0] - back[0], l[1] - back[1], l[2] - back[2]) < 0.3) f.round = false;
        aim = f.round ? back : [S.INFEED[0] + 0.3, S.INFEED[1], 0];
      }
      // seized (post found it too heavy at the drum): the rollers stop and clamp it where it is
      const dir = f.seized ? new THREE.Vector3(1, 0, 0) : this.toWorld(aim, _b).sub(P);
      const dist = f.seized ? 0 : dir.length(); dir.multiplyScalar(1 / (dist || 1));
      const vp = b.velocityAtPoint(P), want = f.seized ? 0 : Math.min(CFG.CHIP_FEED_V, dist * 4);   // at the drum they press the wood onto it
      const err = new THREE.Vector3(dir.x * want - vp.x, dir.y * want - vp.y, dir.z * want - vp.z), el = err.length();
      // The rollers drive the feed point at their speed. Each tick they give it the impulse that brings it to that
      // speed through the mass the wood presents there (so a twig gets the few newtons a twig needs, and any overshoot
      // is taken straight back), plus a motor term for a load that holds it back (a rope, branches dragging on the
      // ground): it rises toward CHIP_PULL while the wood lags and drops back to nothing as soon as it keeps up.
      // The total is never more than CHIP_PULL: past it they slip. (Before, a softer drive let that motor term fling
      // small branches about at 40-60 m/s when what held them let go.)
      const along = vp.x * dir.x + vp.y * dir.y + vp.z * dir.z;
      // (half the gap each tick: with the guide below also driving the same body, two dead-beat drives would fight)
      const F = err.multiplyScalar(el > 1e-6 ? 0.5 * effMass(b, P, err.clone().multiplyScalar(1 / el)) / dt : 0);
      // held back = its speed along the feed, smoothed over a few ticks (a rope's stretch makes it shiver), is short
      f.vs = (f.vs ?? along) * 0.85 + along * 0.15;
      if (f.seized || f.vs >= want) f.F = 0;
      // The loads it can be making up for: the wood dragging, snagging and being lifted over the ground (up to ten
      // times its weight), and a rope tied to it. With no cap a small branch caught on a ledge was pulled at 15 kN,
      // and flung when it came free; capped like this the most it can gain in a tick is about 1.6 m/s, and the drive
      // takes that back at once.
      else {
        const r = w.rope, roped = r.state === 2 && r.anchor.seg !== undefined && w.segs.get(r.anchor.seg)?.piece === piece;
        const load = 10 * b.mass() * CFG.GRAVITY + (roped ? 1.2 * (sim.rope.T || 0) : 0);
        f.F = Math.max(0, Math.min(CFG.CHIP_PULL, load, (f.F || 0) + (want - along) / Math.max(0.05, want) * CFG.CHIP_PULL * dt));
      }
      F.addScaledVector(dir, f.F);
      // the rollers carry the end they hold (about half its weight); once it is in the throat, the throat's floor and
      // the rollers carry all of it (its weight is taken at its centre of mass below), so nothing sags through the
      // chipper's floor into the ground
      if (!f.entered || f.seized) F.y += b.mass() * CFG.GRAVITY * 0.5;
      if (!f.seized) {
        // and the rest of it rides on the hopper's tray and in the throat: all of it once it is in, half of it on the
        // way (so a branch is not ploughed into the ground by its tips, which caught and held it short of the mouth)
        const mg = b.mass() * CFG.GRAVITY * dt * (f.entered ? 1 : 0.5);
        b.applyImpulse({ x: 0, y: mg, z: 0 }, true); this.body.applyImpulseAtPoint({ x: 0, y: -mg, z: 0 }, this.infeed(_b), true);
      }
      if (F.length() > CFG.CHIP_PULL) F.setLength(CFG.CHIP_PULL);
      sim.applyForce(s.id, P, F);
      const I = this.infeed(_b);
      this.body.applyImpulseAtPoint({ x: -F.x * dt, y: -F.y * dt, z: -F.z * dt }, I, true);
      // In the throat the rollers also hold the wood in line with it: the far end of the segment they have is brought
      // across to the throat's axis, so the wood goes in straight. Without this, wood that passes through the chipper's
      // body pivots on the one point held and folds out through its sides and floor into the ground.
      if (f.entered && !f.seized) this.guide(b, s, f, dt);
    }
  }

  /** Bring the far end of feed segment s across to the throat's axis (sideways only), with no more than CHIP_PULL. */
  guide(b, s, f, dt) {
    // the far end: whichever end of the segment is further out of the chipper (the rollers may hold it anywhere along it)
    const sim = this.sim, S = SHAPE, la = this.toLocal(sim.segToWorld(s, s.a, _a)), lb = this.toLocal(sim.segToWorld(s, s.b, _a));
    const far = la[0] <= lb[0] ? s.a : s.b;
    const Q = sim.segToWorld(s, far, new THREE.Vector3()), l = this.toLocal(Q);
    const ly = S.INFEED[1] - l[1], lz = -l[2], off = Math.hypot(ly, lz);
    const toW = (d) => this.dirToWorld(d, new THREE.Vector3());
    const vq = b.velocityAtPoint(Q), V = new THREE.Vector3(vq.x, vq.y, vq.z);
    const ex = toW([1, 0, 0]), lat = V.clone().addScaledVector(ex, -V.dot(ex));               // its sideways velocity
    const want = off > 1e-4 ? toW([0, ly / off, lz / off]).multiplyScalar(Math.min(CFG.CHIP_FEED_V, off * 4)) : new THREE.Vector3();
    const err = want.sub(lat), el = err.length(); if (el < 1e-5) return;
    const F = err.multiplyScalar(0.5 * effMass(b, Q, err.clone().multiplyScalar(1 / el)) / dt);
    if (F.length() > CFG.CHIP_PULL) F.setLength(CFG.CHIP_PULL);
    sim.applyForce(s.id, Q, F);
    this.body.applyImpulseAtPoint({ x: -F.x * dt, y: -F.y * dt, z: -F.z * dt }, this.infeed(_b), true);
  }

  /** The feed point becomes the end of the remaining wood nearest the throat (where the last of it was chipped). */
  pickFeed(piece, f) {
    const sim = this.sim; let best = -Infinity, bl = null;
    f.seg = -1;
    for (const s of sim.world.segsOf(piece)) for (const e of [s.a, s.b]) {
      const l = this.toLocal(sim.segToWorld(s, e, _a)), sc = Math.min(l[0], SHAPE.DRUM_X) - 2 * this.throat(l).lat;
      if (sc > best) { best = sc; bl = l; f.seg = s.id; f.p = e.slice(); }
    }
    // once in the rollers, what is left of it stays in them; otherwise it is in if that end is already inside the chipper
    f.entered = f.entered || (!!bl && bl[0] > SHAPE.INFEED[0] - 0.1 && this.throat(bl).lat < SHAPE.CHASSIS.h[2]);
    return f.seg >= 0;
  }

  // The tyres under the axle grip sideways and roll with a little resistance; the jockey wheel castors.
  tyres(dt) {
    const b = this.body; if (b.isSleeping()) return;
    const m = b.mass(), g = CFG.GRAVITY;
    // the parking brake is on unless someone has hold of the grip (the hand brake is on the drawbar); parked, the jockey
    // wheel is clamped too
    const towed = this.sim.chipper.towed(this.k);
    // the axle's share of the weight, from where the centre of mass is between it and the jockey wheel
    const S = SHAPE, share = Math.max(0, Math.min(1, (S.JOCKEY[0] - b.localCom().x) / (S.JOCKEY[0] - S.AXLE[0])));
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
        if (!inJoint && f.entered && this.through(a, b)) eat.push(s); else left += segMass(s) + s.leaf;
      }
      if (f.split) { f.split = false; if (!inAny) { this.feeding.delete(piece); continue; } }   // sawn off outside: the rollers let it go
      // The rollers seize on wood they cannot take: when it reaches the drum, the whole contiguous piece (and anything
      // still joined to it by fibres) must weigh no more than CHIP_CAPACITY. Saw it smaller and they run again.
      // Once seized they stay seized (the wood is clamped at the drum) until it is light enough or out of the chipper.
      const heavy = eat.length || f.seized ? this.weight(piece) : 0;
      if ((eat.length || (f.seized && inAny)) && heavy > CFG.CHIP_CAPACITY) {
        if (!f.seized) sim.toast(isFinite(heavy) ? `The chipper's rollers seized: that piece is too heavy ({mass:${Math.round(heavy)}}). Saw it smaller`
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

  /** Has the segment from chipper-local a to b (of wood in the rollers) reached the drum? Its front end is past the
   * drum and within the chipper's length and about its width: side branches fold in with the stem, so a segment is
   * not left hanging because its back end, or a fork beside it, is still outside the body. */
  through(a, b) {
    const S = SHAPE, fr = a[0] >= b[0] ? a : b, C = S.CHASSIS;
    return fr[0] > S.DRUM_X - 0.1 && fr[0] < C.c[0] + C.h[0] + 0.3
      && Math.abs(fr[2]) < C.h[2] + 0.5 && Math.abs(fr[1] - C.c[1]) < C.h[1] + 0.5;
  }

  /** Mass of the contiguous wood: this piece and every piece joined to it by live fibres (Infinity if that is the tree). */
  weight(piece) { return this.sim.weightOf(piece); }

  /** Are the rollers seized on something? (They stop reeling a rope in too.) */
  seized() { for (const f of this.feeding.values()) if (f.seized) return true; return false; }

  /** A rope tied to this wood whose knot has reached the drum goes into the rollers: they have it from now on. */
  knot(piece, force) {
    const sim = this.sim, r = sim.world.rope;
    if (r.state !== 2 || r.anchor.seg === undefined) return;
    const s = sim.world.segs.get(r.anchor.seg);
    if (!s || s.piece !== piece) return;
    if (!force) { const l = this.toLocal(sim.segToWorld(s, r.anchor.p, _a)); if (l[0] < SHAPE.DRUM_X || this.throat(l).lat > SHAPE.CHASSIS.h[2]) return; }
    sim.emit({ t: 'rope', rope: { ...r, anchor: { chip: 1, k: this.k } } });
    sim.rope.L0 = Math.min(sim.rope.L0, sim.rope.pathLength()); sim.rope.prev = 0;
    sim.toast('The rope went into the chipper!');
  }

  chip(piece, f, eat) {
    const sim = this.sim, w = sim.world, r = w.rope, ids = eat.map((s) => s.id);
    if (r.state === 2 && r.anchor.seg !== undefined && ids.includes(r.anchor.seg)) this.knot(piece, true);   // the rope goes in with its wood
    let V = 0, job = 0;
    for (const s of eat) { V += (segMass(s) + s.leaf) / CFG.DENSITY; if (!s.yd) job += segMass(s) + s.leaf; }
    sim.awards.credit('chip', f.by, job);           // whoever fed it did that much of the chipping (stickers, D106)
    V *= CFG.CHIP_SWELL;
    const out = this.toWorld([SHAPE.DISCHARGE[0], -SHAPE.BODY_Y, SHAPE.DISCHARGE[1]], _a);
    const bin = sim.bins.catchAt(out.x, out.z);       // landing in an open bin's mouth, they go into it (sim/bin.js)
    sim.emit({ t: 'chip', segs: ids, V: +V.toFixed(5), x: +out.x.toFixed(2), z: +out.z.toFixed(2), ...(bin === undefined ? {} : { bin }) });
    if (bin !== undefined) sim.awards.credit('bin', f.by, job / CFG.DENSITY * CFG.CHIP_SWELL);   // the job tree's chips, into a bin (stickers)
    this.busy = 40;
    if (ids.includes(f.seg)) f.seg = -1;
    f.F = 0;                          // the wood that held the motor back is gone: it starts again from nothing
    this.fallApart(piece);
  }

  /** What chipping cut through leaves in bits: each bit of the piece no longer joined to the rest becomes its own
   * piece (a side branch whose fork went into the drum falls free instead of staying rigidly fixed out beside the
   * truck). The rollers keep the bit nearest the drum; a split-off bit with no wood inside the chipper is let go (post). */
  fallApart(piece) {
    const sim = this.sim, w = sim.world; if (!w.pieces.has(piece)) return;
    const segs = w.segsOf(piece), ids = new Set(segs.map((s) => s.id));
    const roots = segs.filter((s) => !ids.has(s.parent));
    if (roots.length < 2) return;
    let keep = null, best = -Infinity;
    for (const rt of roots) for (const id of w.subtree(rt.id)) {
      const s = w.segs.get(id); if (!s || s.piece !== piece) continue;
      for (const e of [s.a, s.b]) {
        const l = this.toLocal(sim.segToWorld(s, e, _a)), sc = Math.min(l[0], SHAPE.DRUM_X) - 2 * this.throat(l).lat;
        if (sc > best) { best = sc; keep = rt; }
      }
    }
    for (const rt of roots) if (rt !== keep && w.segs.get(rt.id)?.piece === piece) sim.emit({ t: 'split', seg: rt.id, at: 0, newPiece: w.newId() });
  }

  aux() {
    if (!this.body) return null;
    // the winch's ropes: [seg, x, y, z] of the point each is tied to
    const wn = [];
    for (const f of this.feeding.values()) if (f.winch) wn.push([f.wseg, ...f.wp.map((x) => +x.toFixed(3))]);
    return { on: this.busy > 0 ? 1 : 0, jam: this.seized() ? 1 : 0, wn };
  }
}

/** The radius of segment s at piece-local point p on its axis (an end, for a feed point). */
function feedR(s, p) {
  const ax = [s.b[0] - s.a[0], s.b[1] - s.a[1], s.b[2] - s.a[2]], L2 = ax[0] * ax[0] + ax[1] * ax[1] + ax[2] * ax[2] || 1;
  const t = Math.max(0, Math.min(1, ((p[0] - s.a[0]) * ax[0] + (p[1] - s.a[1]) * ax[1] + (p[2] - s.a[2]) * ax[2]) / L2));
  return s.r0 + (s.r1 - s.r0) * t;
}

/** The mass body b presents to an impulse at world point P along unit n: 1 / (1/m + (r x n) . I^-1 (r x n)). */
const STICK = 0.2;          // fraction of a stuck tyre's drift from where it stopped taken back each step

function effMass(b, P, n) {
  const m = b.mass(), c = b.worldCom(), rx = P.x - c.x, ry = P.y - c.y, rz = P.z - c.z, e = b.effectiveWorldInvInertia().elements;
  const ux = ry * n.z - rz * n.y, uy = rz * n.x - rx * n.z, uz = rx * n.y - ry * n.x;
  const q = ux * (e[0] * ux + e[1] * uy + e[2] * uz) + uy * (e[1] * ux + e[3] * uy + e[4] * uz) + uz * (e[2] * ux + e[4] * uy + e[5] * uz);
  return 1 / (1 / Math.max(1e-6, m) + Math.max(0, q));
}
