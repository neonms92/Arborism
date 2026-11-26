// Host only: the other trees in the yards while they are dormant (model/stands.js). Each has only its trunk as
// fixed colliders, so players bump into it and can look at it, and nothing else: no fibres, no load sharing, no
// crown to catch anything. A player who starts sawing or climbing one (or hanging the rigging block on it, or
// grabbing it) wakes it: its wood is grown for real, with YARD_TREES_PITCH-wide fibres, as an ordinary rooted
// tree, and from then on it is wood like the job tree.

import { standSegs, trunkOf } from '../model/stands.js';
import { segLen, segAxis, lerp3 } from '../model/world.js';
import * as THREE from '../../vendor/three/three.module.js';

const Y = new THREE.Vector3(0, 1, 0), _v = new THREE.Vector3(), _q = new THREE.Quaternion();

export class Stands {
  constructor(sim) {
    this.sim = sim;
    this.body = null;             // one fixed body holds every dormant trunk
    this.cols = new Map();        // stand index -> [collider]
    this.colStand = new Map();    // collider handle -> stand index
  }

  onEvent(ev) {
    if (ev.t === 'stands') this.build();
    else if (ev.t === 'reset') this.clear();
    else if (ev.t === 'tree' && ev.stand !== undefined) this.drop(ev.stand);
  }

  clear() {
    if (this.body) this.sim.rapier.removeRigidBody(this.body);
    this.body = null; this.cols.clear(); this.colStand.clear();
  }

  build() {
    this.clear();
    const sim = this.sim, R = sim.R, st = sim.world.stands;
    if (!st) return;
    this.body = sim.rapier.createRigidBody(R.RigidBodyDesc.fixed());
    let n = 0;
    st.list.forEach((s, i) => {
      if (s.piece) return;
      const cols = [];
      for (const g of trunkOf(standSegs(st, s, () => ++n))) {
        const L = segLen(g), ax = segAxis(g), mid = lerp3(g.a, g.b, 0.5);
        _q.setFromUnitVectors(Y, _v.set(ax[0], ax[1], ax[2]));
        const c = sim.rapier.createCollider(R.ColliderDesc.cylinder(Math.max(0.01, L / 2), Math.max(0.01, (g.r0 + g.r1) / 2))
          .setTranslation(mid[0], mid[1], mid[2]).setRotation({ x: _q.x, y: _q.y, z: _q.z, w: _q.w }).setFriction(0.8), this.body);
        cols.push(c); this.colStand.set(c.handle, i);
      }
      this.cols.set(i, cols);
    });
  }

  drop(i) {
    for (const c of this.cols.get(i) || []) { this.colStand.delete(c.handle); this.sim.rapier.removeCollider(c, false); }
    this.cols.delete(i);
  }

  /** The dormant tree a player is looking at within `max` m, nothing in between: {i, dist} or null. */
  aim(p, max) {
    if (!this.colStand.size) return null;
    const sim = this.sim, { o, d } = sim.eye(p);
    const hit = sim.rapier.castRay(new sim.R.Ray(o, d), max, true, undefined, undefined, undefined, p.body);
    const i = hit && this.colStand.get(hit.collider.handle);
    return i === undefined || i === null ? null : { i, dist: hit.timeOfImpact, pole: this.sim.world.stands.list[i].k === 1 };
  }

  /** Grow stand i's wood for real (it stays where it was drawn). */
  wake(i) {
    const sim = this.sim, w = sim.world, st = w.stands, s = st && st.list[i];
    if (!s || s.piece) return;
    sim.emit({ t: 'tree', piece: w.newId(), segs: standSegs(st, s, () => w.newId()), stand: i });
  }
}
