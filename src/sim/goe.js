// G.O.E., the groundbot (D117). Host only; solo games only (main.js spawns him).
// He is an ordinary player (sim/players.js): this controller writes his input each tick, the way a person's
// keys would, and everything he does goes through the same rules as anyone's (rope.js, players.js).
// He does only these things:
//   - stands by the job tree;
//   - once a block is hung, takes the rope tail ({rig} at the friction device);
//   - once the rope is tied to wood, puts the wraps up to WRAPS_MAX;
//   - once that wood comes off the tree, eases the tail to let it down at about GOE_LOWER_V;
//   - once it lies still, ties off, walks to the knot (A* over the ground, round fences, sheds and logs) and unties it.
// Then, with the block still hung, he goes back to the tail for the next one.
// And (D118): when a person goes down, he ties off if he is on the tail, takes a tube salad off the nearest
// chipper's rack and gives it to them. A red button on his right shoulder switches him off (players.setPower):
// then he is a box anyone can grab. Switched off when someone goes down, he switches himself on to help and
// back off once they are up.

import * as THREE from '../../vendor/three/three.module.js';
import { CFG, INJ, MODE } from '../config.js';
import { segRadius } from '../model/world.js';
import { SHAPE } from '../model/chipper.js';
import { blankInput } from './players.js';

export const GOE_ID = 99;               // his player id (people are 1, 2, 3...)
export const GOE_NAME = 'G.O.E.';
export const GOE_COLOR = 0x8a8d90;      // gray

const _o = new THREE.Vector3(), _d = new THREE.Vector3();
const yawTo = (dx, dz) => Math.atan2(-dx, -dz);          // yaw 0 looks toward -z; forward = (-sin, 0, -cos)

export class Goe {
  constructor(sim) { this.sim = sim; this.p = null; }

  /** Put him down by the tree (once: solo games). */
  spawn() {
    if (this.p) return this.p;
    const at = this.standSpot();
    this.p = this.sim.players.add(GOE_ID, GOE_NAME, GOE_COLOR, [], true, at);
    this.p.spawn = [at[0], this.p.spawn[1], at[1]];
    this.inp = blankInput(); this.inp.yaw = yawTo(-at[0], -at[1]);
    this.path = null; this.goalKey = ''; this.planT = 0; this.stuckT = 0; this.stuckN = 0; this.from = null;
    this.grip = 1; this.restT = 0; this.wrapT = 0; this.rigT = 0; this.lowering = false;
    this.aid = null; this.passed = new Set(); this.aidT = 0;
    return this.p;
  }

  // ---- where things are ----
  /** The job tree's trunk at the ground: rooted wood sits at the origin (structure.js), the trunk on its axis. */
  trunk() {
    const w = this.sim.world; let best = null;
    for (const s of w.segs.values()) {
      if (!w.pieces.get(s.piece)?.fixed || Math.hypot(s.a[0], s.a[2]) > 0.5) continue;
      if (!best || s.a[1] < best.a[1]) best = s;
    }
    return { r: best ? segRadius(best, 0) : 0.3 };
  }
  /** His place by the tree before a block is hung, a pace out from the bark (the device then goes on the side under the block, rope.js D125). */
  standSpot() {
    const r = this.trunk().r + 1.0;
    for (const a of [0.35, 0.8, -0.2, 1.3, -0.7, 1.9, 2.6, -1.4, 3.14]) {
      const x = r * Math.cos(a), z = r * Math.sin(a);
      if (this.free(x, z)) return [x, z];
    }
    return [r, 0];
  }

  /** Can he stand here: ground no steeper than he can walk, and nothing but the ground (or a person) in the way. */
  free(x, z) {
    const sim = this.sim, R = sim.R, h = CFG.GOE_GRID, y0 = sim.groundY(x, z);
    for (const [dx, dz] of [[h, 0], [0, h]]) {
      const s = Math.max(Math.abs(sim.groundY(x + dx, z + dz) - y0), Math.abs(sim.groundY(x - dx, z - dz) - y0)) / h;
      if (s > Math.tan(CFG.WALK_SLOPE * 0.9)) return false;
    }
    // the capsule lifted a little off the ground, so kerbs and pavers do not count but a log or a fence does
    const shape = this.shape || (this.shape = new R.Capsule(CFG.P_HALF, CFG.P_RADIUS + 0.04));
    let hit = false;
    sim.rapier.intersectionsWithShape({ x, y: y0 + CFG.P_HALF + CFG.P_RADIUS + 0.3, z }, { x: 0, y: 0, z: 0, w: 1 }, shape, (col) => {
      if (col.handle === sim.groundCol.handle || col.isSensor() || sim.colPlayer.has(col.handle)) return true;
      hit = true; return false;
    });
    return !hit;
  }

  // ---- walking: A* on a grid over the ground ----
  /**
   * A path from where he is to any cell that goal(x, z) accepts, heading for (gx, gz). Cells are GOE_GRID square,
   * eight ways round, a diagonal only past two free sides; a climb costs extra. With no cell that goal() accepts in
   * reach, the path to the cell nearest (gx, gz) that he can reach; null when that is where he stands.
   */
  plan(gx, gz, goal) {
    const sim = this.sim, h = CFG.GOE_GRID, t = this.p.body.translation();
    const sx = Math.round(t.x / h), sz = Math.round(t.z / h), K = (i, j) => i * 100003 + j;
    const okC = new Map(), ok = (i, j) => { const k = K(i, j); let v = okC.get(k); if (v === undefined) okC.set(k, v = this.free(i * h, j * h)); return v; };
    const H = (i, j) => { const dx = Math.abs(i * h - gx), dz = Math.abs(j * h - gz); return Math.max(dx, dz) + 0.414 * Math.min(dx, dz); };
    const open = [[H(sx, sz), 0, sx, sz]], g = new Map([[K(sx, sz), 0]]), came = new Map();
    let n = 0, near = [sx, sz], nearH = H(sx, sz);
    const back = (i, j) => {
      const out = []; let k = K(i, j), c = [i, j];
      while (c) { out.push([c[0] * h, c[1] * h]); c = came.get(k); if (c) k = K(c[0], c[1]); }
      return out.reverse();
    };
    while (open.length && n++ < CFG.GOE_SEARCH) {
      // a binary heap would be quicker; a few thousand cells a plan, a plan every few seconds, is cheap enough
      let bi = 0; for (let i = 1; i < open.length; i++) if (open[i][0] < open[bi][0]) bi = i;
      const [, gc, i, j] = open[bi]; open[bi] = open[open.length - 1]; open.pop();
      if (gc > g.get(K(i, j))) continue;
      if (goal(i * h, j * h)) return back(i, j);
      const hc = H(i, j); if (hc < nearH) { nearH = hc; near = [i, j]; }
      const y = sim.groundY(i * h, j * h);
      for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) {
        if (!di && !dj) continue;
        const a = i + di, b = j + dj;
        if (!ok(a, b) || (di && dj && (!ok(i + di, j) || !ok(i, j + dj)))) continue;
        const ng = gc + h * (di && dj ? 1.414 : 1) + 2 * Math.max(0, sim.groundY(a * h, b * h) - y);
        const k = K(a, b);
        if (ng >= (g.get(k) ?? Infinity)) continue;
        g.set(k, ng); came.set(k, [i, j]); open.push([ng + H(a, b), ng, a, b]);
      }
    }
    // No way to it found (D118): the way to the nearest place to it that he can get to, so he still goes round
    // the trunk and what lies about instead of straight at it through them. null only when he cannot move at all.
    return near[0] === sx && near[1] === sz ? null : back(near[0], near[1]);
  }

  /** Walk toward (gx, gz) until goal() holds where he stands. true once there. key: re-plan when the goal changes. */
  walkTo(key, gx, gz, goal, dt) {
    const inp = this.inp, t = this.p.body.translation();
    if (goal(t.x, t.z)) { this.path = null; return true; }
    this.planT -= dt;
    if (key !== this.goalKey || !this.path || this.planT <= 0) {
      this.goalKey = key; this.planT = CFG.GOE_REPLAN;
      this.path = this.plan(gx, gz, goal);
      if (this.path) this.path.shift();
      else this.path = [];      // boxed in where he stands: straight at it (jumping when stuck) until the next plan
    }
    while (this.path.length > 1 && Math.hypot(this.path[0][0] - t.x, this.path[0][1] - t.z) < CFG.GOE_GRID * 0.8) this.path.shift();
    const wp = this.path[0] || [gx, gz];
    inp.yaw = yawTo(wp[0] - t.x, wp[1] - t.z); inp.pitch = -0.15; inp.my = 1;
    // stuck (a log, a kerb): jump, and after a few tries look for another way
    this.stuckT += dt;
    if (!this.from) this.from = [t.x, t.z];
    if (this.stuckT > 1) {
      if (Math.hypot(t.x - this.from[0], t.z - this.from[1]) < 0.3) { inp.c.jump++; if (++this.stuckN > 2) { this.planT = 0; this.stuckN = 0; } }
      else this.stuckN = 0;
      this.stuckT = 0; this.from = [t.x, t.z];
    }
    return false;
  }

  /** Look at world point q from his eyes. */
  look(q) {
    const t = this.p.body.translation(), dx = q.x - t.x, dy = q.y - t.y - CFG.EYE, dz = q.z - t.z;
    this.inp.yaw = yawTo(dx, dz); this.inp.pitch = Math.atan2(dy, Math.hypot(dx, dz));
  }

  // ---- each tick, before the players move ----
  step(dt) {
    const p = this.p; if (!p || !this.sim.players.list.has(GOE_ID)) return;
    const sim = this.sim, w = sim.world, r = w.rope, rope = sim.rope, inp = this.inp;
    inp.mx = inp.my = 0; inp.rt = inp.lt = 0;
    if (this.rigT > 0) this.rigT -= dt;
    if (this.wrapT > 0) this.wrapT -= dt;
    sim.players.setInput(GOE_ID, inp);
    // a person down: off to help them, switching himself on for it if he is off
    const down = this.aid ? null : this.downed();
    if (down && !this.aid) {
      this.aid = { id: down.id, woke: !!p.off };
      if (p.off) { sim.players.setPower(p, true); sim.toast(`${GOE_NAME} switched himself on to help ${sim.players.name(down.id)}`); }
    }
    if (p.off) return;
    if (p.inj >= INJ.DOWN || p.shakenT > 0) return;
    if (this.aid && this.aidStep(dt)) return;

    // the wood on the knot: is it off the tree, and lying still?
    const aSeg = r.state === 2 && !r.anchor.chip ? w.segs.get(r.anchor.seg) : null;
    const loose = !!aSeg && !sim.structure.isHeld(aSeg.piece);
    if (loose) {
      const b = sim.bodies.get(aSeg.piece), v = b.linvel(), av = b.angvel();
      const still = Math.hypot(v.x, v.y, v.z) < CFG.GOE_REST_V && Math.hypot(av.x, av.y, av.z) < 2 * CFG.GOE_REST_V && rope.T < 0.5 * b.mass() * CFG.GRAVITY;
      this.restT = still ? this.restT + dt : 0;
    } else this.restT = 0;
    const atRest = loose && this.restT >= CFG.GOE_REST_T;

    if (p.mode === MODE.ROPE) { this.onTail(dt, aSeg, loose, atRest); return; }
    this.lowering = false; this.grip = 1;

    // the knot to untie: walk to where he can see it within reach, look at it, {rig}
    if (atRest) {
      const q = rope.node(r.anchor);
      const goal = (x, z) => this.canReach(x, z, q, aSeg.piece);
      if (this.walkTo('knot', q.x, q.z, goal, dt)) {
        this.look(q);
        if (this.rigT <= 0 && rope.prompt(p, sim.aim(p)).includes('untie')) { inp.c.rig++; this.rigT = 0.5; }
      }
      return;
    }
    // a block hung and nobody on the tail: take it
    if (r.state >= 1 && rope.holder < 0 && !rope.fed() && !atRest) {
      const dv = rope.node(r.device), range = CFG.DEVICE_RANGE - 0.6;
      if (this.walkTo('tail', dv.x, dv.z, (x, z) => Math.hypot(x - dv.x, z - dv.z) < range && this.free(x, z), dt) && rope.nearDevice(p)) {
        // {rig} takes the tail only while no wood in reach offers a rigging action: look where there is none
        if (this.lookClear() && this.rigT <= 0) { inp.c.rig++; this.rigT = 0.3; }
      }
      return;
    }
    // otherwise: stand by the tree, facing it
    const sp = this.spot || (this.spot = this.standSpot());
    if (this.walkTo('stand', sp[0], sp[1], (x, z) => Math.hypot(x - sp[0], z - sp[1]) < 0.6, dt)) {
      const t = p.body.translation();
      inp.yaw = yawTo(-t.x, -t.z);
      inp.pitch = r.state >= 1 ? this.pitchTo(rope.node(r.block)) : 0.25;
    }
  }

  // ---- first aid (D118) ----
  /** The nearest person down that he can get to (on the ground or the tail, not up the tree), with a salad to be had. */
  downed() {
    const sim = this.sim, t = this.p.body.translation();
    for (const id of [...this.passed]) { const o = sim.players.list.get(id); if (!o || o.inj < INJ.DOWN) this.passed.delete(id); }
    if (!this.p.held && !this.rack()) return null;
    let best = null, bd = Infinity;
    for (const o of sim.players.list.values()) {
      if (o.bot || o.inj < INJ.DOWN || o.mode === MODE.CLIMB || this.passed.has(o.id)) continue;
      const b = o.body.translation(), d = Math.hypot(b.x - t.x, b.z - t.z);
      if (d < bd) { bd = d; best = o; }
    }
    return best;
  }
  /** The nearest working chipper's salad rack: {u, c: its middle in the world}, or null. */
  rack() {
    const t = this.p.body.translation(); let best = null, bd = Infinity;
    for (const u of this.sim.chipper.units) {
      if (!u.body) continue;
      const c = u.toWorld(SHAPE.RACK.c, new THREE.Vector3()), d = Math.hypot(c.x - t.x, c.z - t.z);
      if (d < bd) { bd = d; best = { u, c }; }
    }
    return best;
  }
  /** Someone pressed his button (players.act): switched off by hand, he drops what he was doing for whoever is down. */
  switched(p, by) {
    if (p !== this.p) return;
    if (p.off && this.aid) { this.passed.add(this.aid.id); this.aid = null; }
    if (p.off) this.path = null;
  }
  /** One tick of helping the person in this.aid. true while that is what he is doing. */
  aidStep(dt) {
    const sim = this.sim, p = this.p, inp = this.inp, a = this.aid, o = sim.players.list.get(a.id);
    if (this.aidT > 0) this.aidT -= dt;
    if (!o || o.inj < INJ.DOWN || o.mode === MODE.CLIMB) {
      // up again (his salad, or anyone's): back to work, or back off if he woke himself for it
      this.aid = null; this.path = null;
      if (a.woke) { sim.players.setPower(p, false); sim.toast(`${GOE_NAME} switched himself back off`); return true; }
      return false;
    }
    if (p.mode === MODE.ROPE) { if (this.aidT <= 0) { inp.c.interact++; this.aidT = 0.3; } return true; }   // tie off first
    if (!p.held) {
      const rk = this.rack();
      if (!rk) { this.passed.add(a.id); this.aid = null; return false; }        // no chipper left to take one from
      const c = rk.c, goal = (x, z) => Math.hypot(x - c.x, z - c.z) < CFG.REACH - 1.0 && this.free(x, z);
      if (this.walkTo('rack', c.x, c.z, goal, dt)) {
        this.look(c);
        const ca = sim.chipper.aim(p);
        if (ca && ca.rack && ca.dist < CFG.REACH && this.aidT <= 0) { inp.c.interact++; this.aidT = 0.3; }
      }
      return true;
    }
    const b = o.body.translation();
    const goal = (x, z) => { const d = Math.hypot(x - b.x, z - b.z); return d < CFG.REACH - 1.1 && d > 0.6 && this.free(x, z); };
    if (this.walkTo('aid' + o.id, b.x, b.z, goal, dt)) {
      this.look(_o.set(b.x, b.y, b.z));
      if (sim.players.aimPlayer(p) === o && this.aidT <= 0) { inp.c.interact++; this.aidT = 0.3; }
    }
    return true;
  }

  pitchTo(q) { const t = this.p.body.translation(); return Math.atan2(q.y - t.y - CFG.EYE, Math.hypot(q.x - t.x, q.z - t.z)); }

  /** From a cell at (x, z), would his eyes see the knot q on its wood, within reach? */
  canReach(x, z, q, piece) {
    const sim = this.sim, y = sim.groundY(x, z) + CFG.P_HALF + CFG.P_RADIUS + CFG.EYE;
    _o.set(x, y, z); _d.copy(q).sub(_o); const L = _d.length();
    if (L > CFG.REACH - 0.2 || Math.hypot(q.x - x, q.z - z) < 0.5) return false;
    _d.divideScalar(L);
    const hit = sim.ray(_o, _d, CFG.REACH, this.p.body);
    return !!hit && hit.point.distanceTo(q) < 0.6 && !!this.free(x, z);
  }

  /** Point his eyes where no wood is in reach (down at his feet, out from the tree, or up), so {rig} means the tail. */
  lookClear() {
    const sim = this.sim, t = this.p.body.translation(), out = yawTo(t.x, t.z);
    for (const [yaw, pitch] of [[out, -1.2], [out, 0], [out + 1.5, 0], [out - 1.5, 0], [out, 1.3]]) {
      const cp = Math.cos(pitch);
      _o.set(t.x, t.y + CFG.EYE, t.z); _d.set(-Math.sin(yaw) * cp, Math.sin(pitch), -Math.cos(yaw) * cp);
      if (!sim.ray(_o, _d, CFG.REACH + 0.5, this.p.body)) {
        const ok = Math.abs(this.inp.yaw - yaw) < 1e-6 && Math.abs(this.inp.pitch - pitch) < 1e-6;
        this.inp.yaw = yaw; this.inp.pitch = pitch;
        return ok;                     // pressed only once players.js has seen him look there
      }
    }
    return false;
  }

  /** On the tail: wraps up once the knot is tied, ease it down once its wood is off the tree, tie off once it is still. */
  onTail(dt, aSeg, loose, atRest) {
    const sim = this.sim, w = sim.world, r = w.rope, rope = sim.rope, inp = this.inp;
    if (r.state >= 1) inp.pitch = this.pitchTo(rope.node(r.block));
    const t = this.p.body.translation(); inp.yaw = yawTo(-t.x, -t.z);
    if (rope.fed() || atRest) { inp.c.interact++; this.lowering = false; return; }     // tied off (and, at rest, off to untie it)
    if (r.state === 2 && !loose) {
      if (rope.wraps < CFG.WRAPS_MAX) inp.c.wrapUp++;
      this.grip = 1; this.lowering = false;
    } else if (loose) {
      // riding the tension: the grip is eased until the rope runs at about GOE_LOWER_V, firmed up when it runs faster
      this.lowering = true;
      const run = rope.run || 0, T = rope.T;
      if (T > 20) {
        const e = run - CFG.GOE_LOWER_V;
        this.grip += (e > 0 ? 3 : 1.5) * e * dt;
        this.grip = Math.min(1, Math.max(0, this.grip));
        // let go to nothing and the wraps still hold the wood up (light wood): a wrap off
        if (this.grip <= 0.01 && run < 0.05 && T > 0.6 * sim.bodies.get(aSeg.piece).mass() * CFG.GRAVITY && rope.wraps > 0 && this.wrapT <= 0) { inp.c.wrapDn++; this.wrapT = 1; }
      }
    } else this.grip = 1;
    inp.rt = 1 - this.grip;
  }
}
