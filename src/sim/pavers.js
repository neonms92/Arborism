// Host only: impacts on the concrete pavers (model/pavers.js).
//
// The pavers are flush with the ground, so wood, players and the chipper land on the
// ground collider. Every tick, each pair touching the ground with a contact
// force event is looked at: the energy of the impact is
// 1/2 * m_eff * v_n^2, where v_n is the speed the body was closing on the
// ground at the contact (before this step) and m_eff the mass it presents
// there (a log landing on its end hits with less than its whole mass). That
// energy is shared between the pavers under the contact points in proportion
// to the impulse each took. A paver whose share is at least PAVER_CRACK_E
// gains share / PAVER_CRACK_E damage. A body resting or rolling on the
// pavers closes at ~0 m/s and does nothing.

import { CFG, MODE } from '../config.js';
import { paverAt } from '../model/pavers.js';

const TOUCH = 0.01;                // m: contact points this much further than the nearest still share an impact (see impact)

export class Pavers {
  constructor(sim) {
    this.sim = sim;
    this.touch = new Set();          // collider handles that pressed on the ground this step
    this.log = null;                 // set to [] in the console to see every impact: arb.sim.pavers.log = []
    this.vel = new Map();            // body handle -> [vx,vy,vz, wx,wy,wz] at the end of last tick (= before this step)
  }

  /** The ground collider (made again with each new terrain). */
  get ground() { return this.sim.groundCol || null; }

  /** Lay fresh pavers: a circle round a tree of CFG.TREE_HEIGHT and CFG.TREE_DIAMETER, then the yards' areas. */
  lay(areas = []) {
    const c = CFG.PAVER_SIZE, pit = CFG.TREE_DIAMETER / 2 + CFG.PAVER_PIT;
    this.sim.emit({ t: 'pavers', c, areas: [{ shape: 'circle', x: 0, z: 0, r: CFG.TREE_HEIGHT * CFG.PAVER_RADIUS, pit }, ...areas] });
  }

  /** From sim.onContact: a contact force event between colliders h1 and h2. */
  onContact(h1, h2) {
    if (!this.ground) return;
    const g = this.ground.handle;
    if (h1 === g) this.touch.add(h2); else if (h2 === g) this.touch.add(h1);
  }

  /** After the physics step. */
  post() {
    const sim = this.sim, pv = sim.world.paving;
    if (pv && this.touch.size) {
      const out = [];
      for (const h of this.touch) this.impact(h, pv, out);
      if (out.length) sim.emit({ t: 'crack', h: out });
    }
    this.touch.clear();
    this.vel.clear();
    for (const [id, b] of sim.bodies) {
      if (sim.world.pieces.get(id)?.fixed || b.isSleeping()) continue;
      const v = b.linvel(), vx = v.x, vy = v.y, vz = v.z, w = b.angvel();
      this.vel.set(b.handle, [vx, vy, vz, w.x, w.y, w.z]);
    }
    sim.chipper.eachRigid((b) => {
      if (b.isSleeping()) return;
      const v = b.linvel(), vx = v.x, vy = v.y, vz = v.z, w = b.angvel();
      this.vel.set(b.handle, [vx, vy, vz, w.x, w.y, w.z]);
    });
  }

  impact(h, pv, out) {
    const sim = this.sim, col = sim.rapier.getCollider(h); if (!col) return;
    const body = col.parent(); if (!body || !body.isDynamic()) return;
    const pid = sim.colPlayer.get(h), pl = pid !== undefined ? sim.players.list.get(pid) : null;
    const chip = sim.chipper.solid(h);
    if (pid === undefined && sim.colSeg.get(h) === undefined && !chip) return;
    if (pl && pl.mode === MODE.CLIMB) return;

    // On the heightfield ground Rapier reports no per-point impulses (contactImpulse is 0, though the pair's contact
    // force event fires, so it is pushing). Then the closest points (within TOUCH of the nearest; with soft CCD the
    // push can come before they meet) share it equally.
    const gt = this.ground.translation(), gx = gt.x, gy = gt.y, gz = gt.z, cand = [];
    let anyJ = false;
    sim.rapier.contactPair(this.ground, col, (man, flipped) => {
      const nm = man.normal(), s = nm.y < 0 ? -1 : 1;      // the ground's upward normal (the manifold's points from one collider to the other)
      const n3 = [s * nm.x, s * nm.y, s * nm.z];
      for (let i = 0, n = man.numContacts(); i < n; i++) {
        const J = man.contactImpulse(i), d = man.contactDist(i);
        const lp = flipped ? man.localContactPoint2(i) : man.localContactPoint1(i);
        cand.push([lp.x + gx, lp.y + gy, lp.z + gz, J > 0 ? J : 0, d, n3]);
        if (J > 0) anyJ = true;
      }
    });
    let pts;
    if (anyJ) pts = cand.filter((p) => p[3] > 0);
    else {
      let dmin = Infinity; for (const p of cand) dmin = Math.min(dmin, p[4]);
      pts = cand.filter((p) => p[4] <= dmin + TOUCH); for (const p of pts) p[3] = 1;
    }
    if (!pts.length) return;
    let nx = 0, ny = 0, nz = 0;
    for (const p of pts) { nx += p[5][0]; ny += p[5][1]; nz += p[5][2]; }
    let W = 0, cx = 0, cy = 0, cz = 0;
    for (const p of pts) { W += p[3]; cx += p[0] * p[3]; cy += p[1] * p[3]; cz += p[2] * p[3]; }
    cx /= W; cy /= W; cz /= W;
    const nl = Math.hypot(nx, ny, nz) || 1; nx /= nl; ny /= nl; nz /= nl;
    if (!(ny > 0)) { nx = 0; ny = 1; nz = 0; }

    // closing speed along the ground's normal and effective mass at the impulse-weighted contact point
    let vn, meff;
    if (pl) { vn = -(pl.vPre.x * nx + pl.vPre.y * ny + pl.vPre.z * nz); meff = CFG.P_MASS; }         // capsule with locked rotation
    else {
      const pre = this.vel.get(body.handle);        // velocity before this step (a body born this tick: use the current one)
      let vx, vy, vz, wx, wy, wz;
      if (pre) [vx, vy, vz, wx, wy, wz] = pre;
      else { const v = body.linvel(); vx = v.x; vy = v.y; vz = v.z; const w = body.angvel(); wx = w.x; wy = w.y; wz = w.z; }
      const com = body.worldCom(), rx = cx - com.x, ry = cy - com.y, rz = cz - com.z;
      // v + w x r at the contact, along n
      vn = -((vx + wy * rz - wz * ry) * nx + (vy + wz * rx - wx * rz) * ny + (vz + wx * ry - wy * rx) * nz);
      // m_eff = 1 / (1/m + u . I^-1 u), u = r x n
      const e = body.effectiveWorldInvInertia().elements, m = body.mass();
      const ux = ry * nz - rz * ny, uy = rz * nx - rx * nz, uz = rx * ny - ry * nx;
      const q = ux * (e[0] * ux + e[1] * uy + e[2] * uz) + uy * (e[1] * ux + e[3] * uy + e[4] * uz) + uz * (e[2] * ux + e[4] * uy + e[5] * uz);
      meff = 1 / (1 / Math.max(1e-6, m) + Math.max(0, q));
    }
    if (!(vn > 0)) return;
    const E = 0.5 * meff * vn * vn, thr = Math.max(1e-6, CFG.PAVER_CRACK_E);
    if (this.log) this.log.push({ tick: sim.tick, E: Math.round(E), vn: +vn.toFixed(2), meff: Math.round(meff), n: pts.length, x: +cx.toFixed(2), z: +cz.toFixed(2), who: pl ? 'player' : chip ? 'chipper' : 'wood' });
    if (E < thr) return;

    // share it out by impulse between the pavers under the points
    const share = new Map();       // paver -> [J, Jx, Jz]
    for (const p of pts) {
      const i = paverAt(pv.L, p[0], p[2]); if (i < 0) continue;
      const s = share.get(i) || [0, 0, 0];
      s[0] += p[3]; s[1] += p[0] * p[3]; s[2] += p[2] * p[3];
      share.set(i, s);
    }
    for (const [i, s] of share) {
      const e = E * s[0] / W;
      if (e >= thr) out.push([i, +(s[1] / s[0]).toFixed(3), +(s[2] / s[0]).toFixed(3), +(e / thr).toFixed(3)]);
    }
  }
}
