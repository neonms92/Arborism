// Host only: the ground is solid (DECISIONS D88, D96).
//
// On terrain the ground collider is a heightfield: a surface with nothing
// under it. A bit of wood pressed hard enough (a crown landing on a twig, a
// rope or the feed rollers dragging a branch over a ledge) can end up partly
// under that surface. A segment that crosses the surface can then be pushed
// out either way, and the one under it is pushed further down, while the rest
// of the piece is pushed up: the piece is pinned through the ground.
//
// So, every tick, the axis of each wood segment on a moving body is checked
// against the ground height at its two ends and its middle. The axis of wood
// lying on the ground is at least its radius above it, so a segment whose
// axis is anywhere under the surface is inside the ground: it stops colliding
// with the ground collider (collision groups), and the body is lifted: for
// GROUND_LIFT_TIME it rises at least GROUND_LIFT_V
// (the feed rollers' speed), and another lift starts if it is still in
// when that one ends (D96; the spring of D88 kicked too hard). Once its whole axis is back
// at least half its radius above the surface, the ordinary contact takes over
// again. Flat ground (the 1 m slab the engine tests use) has a solid inside
// and needs none of this.

import * as THREE from '../../vendor/three/three.module.js';
import { CFG } from '../config.js';
import { lerp3, segLen } from '../model/world.js';

// Rapier collision groups: memberships in the high 16 bits, filter in the low 16.
const GROUND = (0x0001 << 16) | 0xffff;     // the ground: in group 0, meets everything
const SUNK = (0xfffe << 16) | 0xfffe;       // wood inside the ground: not in group 0 and does not meet it
const ALL = 0xffffffff;                     // Rapier's default

const _p = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];

export class Ground {
  constructor(sim) {
    this.sim = sim;
    this.sunk = new Set();          // seg ids inside the ground now (their colliders do not meet it)
    this.lift = new Map();          // piece id -> s left of its lift out of the ground
    this.log = null;                // set to [] in the console to see segments go in and come out
  }

  /** The ground collider was made again (sim.makeGround): give it its group and forget old state. */
  onGround(col) {
    if (col) col.setCollisionGroups(GROUND);
    this.sunk.clear(); this.lift.clear();
  }

  /** A segment's collider was made again (sim.addCollider): it starts with the default groups. */
  onCollider(id) { this.sunk.delete(id); }

  /** Before the physics step. */
  pre(dt) {
    const sim = this.sim, w = sim.world;
    if (!w.terrain) { this.sunk.clear(); this.lift.clear(); return; }
    const V = CFG.GROUND_LIFT_V, T = CFG.GROUND_LIFT_TIME;
    const still = new Set(), hits = [];
    for (const [pid, body] of sim.bodies) {
      if (!body.isDynamic() || body.isSleeping()) {
        if (!body.isDynamic()) this.lift.delete(pid);
        // a sleeping body keeps its state: just remember which of its segments are still in
        for (const s of w.segsOf(pid)) if (this.sunk.has(s.id)) still.add(s.id);
        continue;
      }
      hits.length = 0;
      for (const s of w.segsOf(pid)) {
        const col = sim.segCol.get(s.id); if (!col) continue;
        if (!this.sunk.has(s.id)) {
          // too high for any of it to reach the ground (half its length, and a margin for bending): skip
          const t = col.translation(), tx = t.x, ty = t.y, tz = t.z;
          if (ty - sim.groundY(tx, tz) > 0.6 * segLen(s) + 0.1) continue;
        }
        // the deepest of the axis's two ends and middle (how far its axis is under the surface, m)
        sim.segToWorld(s, s.a, _p[0]); sim.segToWorld(s, s.b, _p[1]); sim.segToWorld(s, lerp3(s.a, s.b, 0.5), _p[2]);
        let deep = -Infinity, k = 0;
        for (let i = 0; i < 3; i++) { const q = _p[i], d = sim.groundY(q.x, q.z) - q.y; if (d > deep) { deep = d; k = i; } }
        const was = this.sunk.has(s.id);
        // in when the axis goes under the surface; out once it is all at least half a radius above it
        if (was ? deep < -0.5 * s.r0 : deep < 0) {
          if (was) { col.setCollisionGroups(ALL); this.log?.push({ tick: sim.tick, seg: s.id, out: true }); }
          continue;
        }
        if (!was) { col.setCollisionGroups(SUNK); this.log?.push({ tick: sim.tick, seg: s.id, depth: deep }); }
        still.add(s.id);
        hits.push([_p[k].x, _p[k].y, _p[k].z, deep]);    // the point, and how far its axis is in
      }
      if (!hits.length) { if (!this.lift.has(pid)) continue; }
      else if (!this.lift.has(pid)) this.lift.set(pid, T);       // found in the ground: lift for GROUND_LIFT_TIME
      if (!this.lift.has(pid)) continue;
      // while a lift lasts, the body rises at least V m/s (a velocity, not a force: the same gentle rise for a
      // twig and a log; its spin is left alone)
      const l = body.linvel(), lx = l.x, ly = l.y, lz = l.z;
      if (ly < V) body.setLinvel({ x: lx, y: V, z: lz }, true);
      const left = this.lift.get(pid) - dt;
      if (left > 1e-9) this.lift.set(pid, left); else this.lift.delete(pid);   // still in after it ends: a new one starts next tick
    }
    for (const pid of this.lift.keys()) if (!sim.bodies.has(pid)) this.lift.delete(pid);
    // segments that went away or whose body became fixed: give their colliders back the default groups
    for (const id of this.sunk) {
      if (still.has(id)) continue;
      const col = sim.segCol.get(id); if (col) col.setCollisionGroups(ALL);
    }
    this.sunk = still;
  }
}
