// Host only: breakable structures (model/builds.js has their shapes and state;
// model/yards.js plans where they go).
//
// An intact module has no physics of its own: its parts are colliders on the
// body it is in (the build's fixed body, or a loose body if it has lost its
// glue to the ground), so things just bump into it. Every tick the contact
// forces on each intact module from wood (or from loose parts and bodies of a
// build) are added up. When that reaches SHED_BREAK_F (a shed),
// FENCE_BREAK_F (a fence section) or HOUSE_BREAK_F (a room) the module breaks: a
// 'smash' event, after which each of its parts is a loose body of its own.
//
// It gives way rather than stopping what hit it: the body that hit it gets
// back the velocity it had before this step, so it ploughs on into the parts,
// which start where they were, moving as the module was: from there it is
// ordinary physics, and the structure slumps or is knocked apart. Glued
// modules that are no longer held by the ground through intact glue become
// one loose body, which can break again where it lands.

import { CFG } from '../config.js';
import { groundRange } from '../model/terrain.js';
import { compose, regroup, partMass, breakForce, qrot, modProxies, SHED, FENCE } from '../model/builds.js';
import { planYards, footprint } from '../model/yards.js';

const CONTACT_EVENT_F = 300;      // N: contact force below which Rapier does not report a pair on a module (too small to matter)

export class Builds {
  constructor(sim) {
    this.sim = sim;
    this.bodies = new Map();      // body id (build, loose module group or part) -> RigidBody
    this.modCols = new Map();     // 'build:module' -> [collider] while intact
    this.colMod = new Map();      // collider handle -> [build id, module index] while intact
    this.partCol = new Map();     // collider handle -> part body id
    this.hits = new Map();        // 'build:module' -> {F, h (module collider), o (other collider), f (strongest pair)} this step
    this.vel = new Map();         // body handle -> [vx,vy,vz, wx,wy,wz] at the end of last tick (loose bodies and parts)
    this.burst = null;            // how the next smash throws its parts (set just before it is emitted)
    this.proxies = new WeakMap();  // module (model) -> the boxes it collides as while intact
    this.log = null;              // set to [] in the console to see every contact on a module: arb.sim.builds.log = []
  }

  /**
   * The neighbourhood for the current settings (model/yards.js): lots of houses, sheds, fences and paving
   * round the tree's own lot, which also holds the shed on the far side of the trunk from the chipper's
   * chute, door toward the trunk. Planned before the ground is made, since the ground is made with the
   * pads the plan asks for. Flat ground (the engine tests) gets none of it.
   */
  plan() {
    if (this.sim.flat) return (this.planned = { builds: [], areas: [], pads: [] });
    const paveR = CFG.TREE_HEIGHT * CFG.PAVER_RADIUS, r = paveR + CFG.SHED_GAP + SHED.D / 2, chip = this.sim.chipper.reach();
    const P = planYards({
      seed: CFG.YARD_SEED, density: CFG.YARD_DENSITY, lotMax: CFG.YARD_LOT_MAX, lotMin: CFG.YARD_LOT_MIN, extent: CFG.YARD_EXTENT,
      street: CFG.YARD_STREET, fence: CFG.YARD_FENCE, blend: CFG.TERRAIN_BLEND, paver: CFG.PAVER_SIZE, paveR,
      treeLot: { x0: Math.min(-paveR, chip.x0), x1: Math.max(paveR, chip.x1), z0: -(r + SHED.D / 2) },
    });
    const shed = { kind: 'shed', p: [0, 0, -r], q: [0, 0, 0, 1] };
    P.builds.unshift(shed);
    P.pads.unshift({ x: 0, z: -r, r: Math.hypot(SHED.W, SHED.D) / 2 + 0.3, blend: CFG.TERRAIN_BLEND });
    return (this.planned = P);
  }

  /**
   * Put the planned builds up, intact (with every new tree), on the ground as it is: a shed at the highest
   * ground under its footprint (its pad makes that level), a house on a foundation that reaches down below
   * the lowest ground under it, and each fence section level at the lower of its two posts, so a run steps
   * down a slope and its posts go deeper into the ground on the uphill side.
   */
  place() {
    const sim = this.sim, w = sim.world, list = (this.planned || this.plan()).builds.map((b) => ({ ...b, id: w.newId(), p: b.p.slice() }));
    this.planned = null;
    for (const b of list) {
      const toW = (l) => { const r = qrot(b.q, l); return [b.p[0] + r[0], b.p[2] + r[2]]; };
      if (b.kind.startsWith('fence:')) {
        const span = b.span || FENCE[b.kind.slice(6)].SPAN, post = [];
        for (let i = 0; i <= b.n; i++) { const [x, z] = toW([i * span, 0, 0]); post.push(sim.groundY(x, z)); }
        b.p[1] = post[0];
        b.ys = []; for (let i = 0; i < b.n; i++) b.ys.push(+(Math.min(post[i], post[i + 1]) - b.p[1]).toFixed(4));
      } else {
        const g = groundRange(w.terrain, footprint(b));
        if (b.kind === 'house') {
          b.p[1] = +(g.hi + CFG.HOUSE_RAISE).toFixed(4);
          b.h = { ...b.h, depth: +(b.p[1] - g.lo + 0.3).toFixed(3) };
        } else b.p[1] = +g.hi.toFixed(4);
      }
    }
    sim.emit({ t: 'builds', list });
  }

  body(id) { return this.bodies.get(id) || null; }

  // ---- model -> physics ----
  onEvent(ev) {
    if (ev.t === 'builds') this.build();
    else if (ev.t === 'smash') this.apart(ev);
  }

  clear() {
    const R = this.sim.rapier;
    for (const b of this.bodies.values()) R.removeRigidBody(b);
    this.bodies.clear(); this.modCols.clear(); this.colMod.clear(); this.partCol.clear(); this.hits.clear(); this.vel.clear();
  }

  build() {
    this.clear();
    const sim = this.sim, R = sim.R;
    for (const b of sim.world.builds) {
      const body = sim.rapier.createRigidBody(R.RigidBodyDesc.fixed().setTranslation(b.p[0], b.p[1], b.p[2]).setRotation({ x: b.q[0], y: b.q[1], z: b.q[2], w: b.q[3] }));
      this.bodies.set(b.id, body);
      b.mods.forEach((m, i) => { if (!m.ids) this.addModule(b, i, body); });
    }
  }

  /** Colliders for intact module i of build b, on body: its parts merged where they line up (model/builds.js modProxies). */
  addModule(b, i, body) {
    const sim = this.sim, R = sim.R, m = b.mods[i], cols = [];
    let px = this.proxies.get(m); if (!px) this.proxies.set(m, px = modProxies(m));
    for (const pt of px) {
      const f = compose(m.p, m.q, pt.c, pt.q);
      const d = R.ColliderDesc.cuboid(pt.h[0], pt.h[1], pt.h[2]).setTranslation(f.p[0], f.p[1], f.p[2])
        .setRotation({ x: f.q[0], y: f.q[1], z: f.q[2], w: f.q[3] }).setMass(pt.v * CFG.SHED_DENSITY).setFriction(0.7).setRestitution(0.1)
        .setActiveEvents(R.ActiveEvents.CONTACT_FORCE_EVENTS).setContactForceEventThreshold(CONTACT_EVENT_F);
      const c = sim.rapier.createCollider(d, body);
      cols.push(c); this.colMod.set(c.handle, [b.id, i]);
    }
    this.modCols.set(`${b.id}:${i}`, cols);
  }

  dropModule(bid, i) {
    const k = `${bid}:${i}`, cols = this.modCols.get(k); if (!cols) return;
    for (const c of cols) { this.colMod.delete(c.handle); this.sim.rapier.removeCollider(c, true); }
    this.modCols.delete(k);
  }

  /** A smash event: the module's parts become loose bodies, and modules cut off from the ground move as loose groups. */
  apart(ev) {
    const sim = this.sim, R = sim.R, b = sim.world.builds.find((x) => x.id === ev.b); if (!b) return;
    const m = b.mods[ev.m], oldId = m.body, old = this.bodies.get(oldId);
    this.dropModule(b.id, ev.m);
    const lv = old && !old.isFixed() ? old.linvel() : { x: 0, y: 0, z: 0 }, la = [lv.x, lv.y, lv.z];
    const av = old && !old.isFixed() ? old.angvel() : { x: 0, y: 0, z: 0 }, aa = [av.x, av.y, av.z];
    for (const l of ev.loose) {
      const body = sim.rapier.createRigidBody(sim.dynamic().setTranslation(l.p[0], l.p[1], l.p[2]).setRotation({ x: l.q[0], y: l.q[1], z: l.q[2], w: l.q[3] })
        .setLinvel(la[0], la[1], la[2]).setAngvel({ x: aa[0], y: aa[1], z: aa[2] }).setLinearDamping(0.05).setAngularDamping(0.2).setCcdEnabled(true));
      this.bodies.set(l.body, body);
      for (const i of l.mods) { this.dropModule(b.id, i); this.addModule(b, i, body); }
    }
    if (old && !old.isFixed() && !b.mods.some((x) => !x.ids && x.body === oldId)) { sim.rapier.removeRigidBody(old); this.bodies.delete(oldId); }

    // the parts, each where it was, moving as the module was: what happens next is ordinary physics
    const B = this.burst; this.burst = null;
    const v = B ? B.vSelf : la, w = B ? B.wSelf : aa;
    m.parts.forEach((pt, k) => {
      const l = compose(m.p, m.q, pt.c, pt.q), f = compose(ev.at.p, ev.at.q, l.p, l.q);
      const body = sim.rapier.createRigidBody(sim.dynamic().setTranslation(f.p[0], f.p[1] + 0.002, f.p[2]).setRotation({ x: f.q[0], y: f.q[1], z: f.q[2], w: f.q[3] })
        .setLinvel(v[0], v[1], v[2]).setAngvel({ x: w[0], y: w[1], z: w[2] }).setLinearDamping(0.05).setAngularDamping(0.3).setCcdEnabled(true));
      const c = sim.rapier.createCollider(R.ColliderDesc.cuboid(pt.h[0], pt.h[1], pt.h[2]).setMass(partMass(pt, CFG.SHED_DENSITY)).setFriction(0.7).setRestitution(0.1), body);
      this.bodies.set(ev.parts[k], body); this.partCol.set(c.handle, ev.parts[k]);
    });
    // what hit it goes on as if the module had not been there; the parts are in its way now, so it still pays for them
    if (B && B.other && B.otherPre) { const o = B.otherPre; B.other.setLinvel({ x: o[0], y: o[1], z: o[2] }, true); B.other.setAngvel({ x: o[3], y: o[4], z: o[5] }, true); }
  }

  // ---- contacts and breaking ----
  /** From sim.onContact: a contact force event between colliders h1 and h2 with total force F (N). */
  onContact(h1, h2, F) {
    for (const [h, o] of [[h1, h2], [h2, h1]]) {
      const bm = this.colMod.get(h); if (!bm) continue;
      if (!this.hurts(h, o)) continue;
      const k = `${bm[0]}:${bm[1]}`, hit = this.hits.get(k);
      if (!hit) this.hits.set(k, { F, h, o, f: F });
      else { hit.F += F; if (F > hit.f) { hit.f = F; hit.h = h; hit.o = o; } }
    }
  }

  /** Does a push from collider o count against the module collider h? Wood, builds and the chipper (whole or wrecked) do; players do not. A loose group also breaks on the ground. */
  hurts(h, o) {
    const sim = this.sim;
    if (sim.colSeg.has(o) || this.partCol.has(o) || sim.chipper.solid(o)) return true;
    const om = this.colMod.get(o), hm = this.colMod.get(h);
    if (om) return true;
    if (o === sim.groundCol.handle) { const b = sim.world.builds.find((x) => x.id === hm[0]); return !!b && b.mods[hm[1]].body !== b.id; }
    return false;
  }

  /** After the physics step (before sim.pavers.post, whose velocities from before the step it reads). */
  post() {
    const sim = this.sim;
    for (const [k, hit] of this.hits) {
      if (this.log) this.log.push({ tick: sim.tick, mod: k, F: Math.round(hit.F) });
      const bm = this.colMod.get(hit.h); if (!bm) continue;          // already broken this tick
      const b = sim.world.builds.find((x) => x.id === bm[0]);
      if (!b || hit.F < breakForce(b.mods[bm[1]], CFG)) continue;
      this.smash(bm[0], bm[1], hit);
    }
    this.hits.clear();
    this.vel.clear();
    for (const b of this.bodies.values()) {
      if (b.isFixed() || b.isSleeping()) continue;
      const v = b.linvel(), vx = v.x, vy = v.y, vz = v.z, w = b.angvel();
      this.vel.set(b.handle, [vx, vy, vz, w.x, w.y, w.z]);
    }
  }

  /** Velocity [6] of a body before this step. */
  preVel(body) {
    if (!body || body.isFixed()) return [0, 0, 0, 0, 0, 0];
    const v = this.vel.get(body.handle) || this.sim.pavers.vel.get(body.handle);
    if (v) return v;
    const l = body.linvel(), lx = l.x, ly = l.y, lz = l.z, a = body.angvel();
    return [lx, ly, lz, a.x, a.y, a.z];
  }

  smash(bid, mi, hit) {
    const sim = this.sim, w = sim.world, b = w.builds.find((x) => x.id === bid), m = b.mods[mi];
    const body = this.bodies.get(m.body), t = body.translation(), r = body.rotation();
    const at = { p: [t.x, t.y, t.z], q: [r.x, r.y, r.z, r.w] };
    // where it was hit, and how fast the two were closing there before this step
    const hc = sim.rapier.getCollider(hit.h), oc = sim.rapier.getCollider(hit.o);
    let P = null;
    if (hc && oc) {
      let sx = 0, sy = 0, sz = 0, n = 0;
      sim.rapier.contactPair(hc, oc, (man) => {
        for (let i = 0, k = man.numSolverContacts(); i < k; i++) { const p = man.solverContactPoint(i); sx += p.x; sy += p.y; sz += p.z; n++; }
      });
      if (n) P = [sx / n, sy / n, sz / n];
    }
    if (!P) { const c = hc ? hc.translation() : t; P = [c.x, c.y, c.z]; }
    const other = oc ? oc.parent() : null;
    const at2 = (bd, pre) => {
      if (!bd) return [0, 0, 0];
      const c = bd.worldCom(), rx = P[0] - c.x, ry = P[1] - c.y, rz = P[2] - c.z;
      return [pre[0] + pre[4] * rz - pre[5] * ry, pre[1] + pre[5] * rx - pre[3] * rz, pre[2] + pre[3] * ry - pre[4] * rx];
    };
    const selfPre = this.preVel(body), otherPre = other ? this.preVel(other) : null;
    const vs = at2(body.isFixed() ? null : body, selfPre), vo = other ? at2(other, otherPre) : [0, 0, 0];
    const rel = [vo[0] - vs[0], vo[1] - vs[1], vo[2] - vs[2]], sp = Math.hypot(rel[0], rel[1], rel[2]);
    this.burst = {
      P, sp, vSelf: selfPre.slice(0, 3), wSelf: selfPre.slice(3, 6),
      other: other && other.isDynamic() ? other : null, otherPre,
    };
    const { loose } = regroup(b, m.body, mi);
    sim.emit({
      t: 'smash', b: bid, m: mi, at, parts: m.parts.map(() => w.newId()),
      loose: loose.map((mods) => ({ body: w.newId(), mods, p: at.p, q: at.q })),
    });
  }

  /** Calls fn(id, translation, rotation, awake) for every loose body (for snapshots). */
  eachBody(fn) {
    for (const [id, b] of this.bodies) if (!b.isFixed()) fn(id, b.translation(), b.rotation(), !b.isSleeping());
  }
}
