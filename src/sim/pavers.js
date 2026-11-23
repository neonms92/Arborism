// Host only: impacts on the concrete pavers (model/pavers.js).
//
// The pavers are flush with the ground, so wood and players land on the
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

export class Pavers {
  constructor(sim) {
    this.sim = sim;
    // the ground is the only collider with no body; it exists before anything else
    this.ground = sim.groundCol || null;
    if (!this.ground) sim.rapier.forEachCollider((c) => { if (!c.parent()) this.ground = c; });
    this.touch = new Set();          // collider handles that pressed on the ground this step
    this.log = null;                 // set to [] in the console to see every impact: arb.sim.pavers.log = []
    this.vel = new Map();            // body handle -> [vx,vy,vz, wx,wy,wz] at the end of last tick (= before this step)
  }

  /** Lay fresh pavers round a tree of CFG.TREE_HEIGHT and CFG.TREE_DIAMETER. */
  lay() {
    const c = CFG.PAVER_SIZE, pit = CFG.TREE_DIAMETER / 2 + CFG.PAVER_PIT;
    this.sim.emit({ t: 'pavers', c, r: CFG.TREE_HEIGHT * CFG.PAVER_RADIUS, pit });
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
  }

  impact(h, pv, out) {
    const sim = this.sim, col = sim.rapier.getCollider(h); if (!col) return;
    const body = col.parent(); if (!body || !body.isDynamic()) return;
    const pid = sim.colPlayer.get(h), pl = pid !== undefined ? sim.players.list.get(pid) : null;
    if (pid === undefined && sim.colSeg.get(h) === undefined) return;
    if (pl && pl.mode === MODE.CLIMB) return;

    // contact points on the ground (world) and the impulse at each, read out before calling Rapier again
    const gt = this.ground.translation(), gx = gt.x, gy = gt.y, gz = gt.z, pts = [];
    sim.rapier.contactPair(this.ground, col, (man, flipped) => {
      for (let i = 0, n = man.numContacts(); i < n; i++) {
        const J = man.contactImpulse(i); if (!(J > 0)) continue;
        const lp = flipped ? man.localContactPoint2(i) : man.localContactPoint1(i);
        pts.push([lp.x + gx, lp.y + gy, lp.z + gz, J]);
      }
    });
    if (!pts.length) return;
    let W = 0, cx = 0, cz = 0;
    for (const p of pts) { W += p[3]; cx += p[0] * p[3]; cz += p[2] * p[3]; }
    cx /= W; cz /= W;

    // closing speed and effective mass at the impulse-weighted contact point; the ground's normal is +y
    let vn, meff;
    if (pl) { vn = -pl.vPre.y; meff = CFG.P_MASS; }         // capsule with locked rotation
    else {
      const pre = this.vel.get(body.handle);        // velocity before this step (a body born this tick: use the current one)
      let vy, wx, wz;
      if (pre) { vy = pre[1]; wx = pre[3]; wz = pre[5]; }
      else { vy = body.linvel().y; const w = body.angvel(); wx = w.x; wz = w.z; }
      const com = body.worldCom(), rx = cx - com.x, rz = cz - com.z;
      vn = -(vy + (wz * rx - wx * rz));             // -(v + w x r).y
      // m_eff = 1 / (1/m + u . I^-1 u), u = r x n = (-rz, 0, rx)
      const e = body.effectiveWorldInvInertia().elements, m = body.mass();
      const ux = -rz, uz = rx;
      const q = ux * (e[0] * ux + e[2] * uz) + uz * (e[2] * ux + e[5] * uz);
      meff = 1 / (1 / Math.max(1e-6, m) + Math.max(0, q));
    }
    if (!(vn > 0)) return;
    const E = 0.5 * meff * vn * vn, thr = Math.max(1e-6, CFG.PAVER_CRACK_E);
    if (this.log) this.log.push({ tick: sim.tick, E: Math.round(E), vn: +vn.toFixed(2), meff: Math.round(meff), n: pts.length, x: +cx.toFixed(2), z: +cz.toFixed(2), who: pl ? 'player' : 'wood' });
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
