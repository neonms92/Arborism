// Host only: the ground is solid (DECISIONS D88).
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
// with the ground collider (collision groups) and the ground pushes it out
// along its normal at its deepest point instead, as a stiff damped spring
// (GROUND_PUSH_K, GROUND_PUSH_DAMP, GROUND_PUSH_MAX). Once its whole axis is back
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
    this.log = null;                // set to [] in the console to see segments go in and come out
  }

  /** The ground collider was made again (sim.makeGround): give it its group and forget old state. */
  onGround(col) {
    if (col) col.setCollisionGroups(GROUND);
    this.sunk.clear();
  }

  /** A segment's collider was made again (sim.addCollider): it starts with the default groups. */
  onCollider(id) { this.sunk.delete(id); }

  /** Before the physics step. */
  pre(dt) {
    const sim = this.sim, w = sim.world;
    if (!w.terrain) { if (this.sunk.size) this.sunk.clear(); return; }
    const K = CFG.GROUND_PUSH_K, C = CFG.GROUND_PUSH_DAMP, PMAX = CFG.GROUND_PUSH_MAX;
    const still = new Set(), hits = [];
    for (const [pid, body] of sim.bodies) {
      if (!body.isDynamic() || body.isSleeping()) {
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
        hits.push([_p[k].x, _p[k].y, _p[k].z, deep + s.r0]);    // the point, and how far the wood's underside is in
      }
      if (!hits.length) continue;
      // the ground pushes back like a stiff spring at each point, sharing the body's mass between them, so it holds
      // up a log as well as a twig (sunk by about g / GROUND_PUSH_K under its own weight), with damping of the speed
      // along the normal; it only ever pushes
      const l = body.linvel(), lv = [l.x, l.y, l.z], a = body.angvel(), av = [a.x, a.y, a.z], c = body.worldCom(), com = [c.x, c.y, c.z];
      const m = body.mass() / hits.length;
      for (const [x, y, z, pen] of hits) {
        const n = sim.groundN(x, z), rx = x - com[0], ry = y - com[1], rz = z - com[2];
        const vn = (lv[0] + av[1] * rz - av[2] * ry) * n[0] + (lv[1] + av[2] * rx - av[0] * rz) * n[1] + (lv[2] + av[0] * ry - av[1] * rx) * n[2];
        const acc = Math.max(0, K * Math.min(PMAX, pen * n[1]) - C * vn);
        if (!acc) continue;
        const J = m * acc * dt;
        body.applyImpulseAtPoint({ x: n[0] * J, y: n[1] * J, z: n[2] * J }, { x, y, z }, true);
      }
    }
    // segments that went away or whose body became fixed: give their colliders back the default groups
    for (const id of this.sunk) {
      if (still.has(id)) continue;
      const col = sim.segCol.get(id); if (col) col.setCollisionGroups(ALL);
    }
    this.sunk = still;
  }
}
