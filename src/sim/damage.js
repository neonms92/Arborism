// Host only: the job's money. A budget at the start of each job (job()), wages
// paid out as play goes on (step()), and what the job has broken. Each paver cracked
// (the first time), each module of a house, shed or fence broken apart, and a
// wrecked chipper add their price (the *_COST settings) to world.damage
// through a 'damage' event, with a toast to everyone.
//
// The other trees in the yards are not the job's (D97). Once one has woken into wood, sawing into it costs
// YARD_CUT_COST per m2 of wood sawn through (added up and charged once the saw has been out of it for
// YARD_CUT_QUIET s), wood that comes off it for good (no longer held to it by any fibre) costs YARD_LOSS_COST
// per kg (with the sawing that took it off on the same bill), and the first time half its wood has come off it counts as felled: YARD_FELL_COST more.

import { CFG } from '../config.js';
import { segMass, segRadius, segLen } from '../model/world.js';
import { CUT } from '../model/fibres.js';

// build kind (before any ':') -> [cost setting, what to call one broken module]
const BUILD = { shed: ['SHED_COST', 'The shed'], fence: ['FENCE_COST', 'A fence section'], house: ['HOUSE_COST', 'A room of a house'] };

export class Damage {
  constructor(sim) {
    this.sim = sim;
    this.yard = new Map();        // piece id -> yard tree (stand index) it is wood of
    this.lost = new Set();        // pieces of yard wood already paid for (came off, or broke off something that had)
    this.trees = new Map();       // stand index -> {M: kg it had when it woke, gone: kg come off, felled, cut: m2 sawn not yet charged, quiet: s}
    this.sawn = new Map();        // yard segment id -> which of its fibres have been charged for sawing
    this.tCheck = 0;
  }

  /** After the world applied ev (sim.onEvent). */
  onEvent(ev, info) {
    const w = this.sim.world;
    if (ev.t === 'reset') { this.yard.clear(); this.lost.clear(); this.trees.clear(); this.sawn.clear(); }
    else if (ev.t === 'tree' && ev.stand !== undefined) {
      let M = 0;
      for (const s of w.segsOf(ev.piece)) M += segMass(s) + s.leaf;
      this.yard.set(ev.piece, ev.stand);
      this.trees.set(ev.stand, { M, gone: 0, felled: false, cut: 0, quiet: 0 });
    } else if (ev.t === 'split' && info && this.yard.has(info.oldPiece)) {
      this.yard.set(ev.newPiece, this.yard.get(info.oldPiece));
      if (this.lost.has(info.oldPiece)) this.lost.add(ev.newPiece);
    } else if (ev.t === 'cut') {
      const s = w.segs.get(ev.seg), i = s && this.yard.get(s.piece), tr = i !== undefined && this.trees.get(i);
      if (tr && !this.lost.has(s.piece) && s.f.n) {
        // each fibre severed for the first time carries its share of the cross-section where it was sawn. The
        // event is already applied, so a segment seen for the first time takes the fibres it names as new.
        let m = this.sawn.get(s.id);
        if (!m) {
          m = new Uint8Array(s.f.n); for (let k = 0; k < m.length; k++) m[k] = s.f.state[k] === CUT ? 1 : 0;
          for (const k of ev.i) m[k] = 0;
          this.sawn.set(s.id, m);
        }
        const L = segLen(s) || 1;
        ev.i.forEach((k, j) => {
          if (m[k]) return;
          m[k] = 1;
          const r = segRadius(s, Math.min(1, Math.max(0, ev.z[j] / L)));
          tr.cut += Math.PI * r * r / s.f.n;
        });
        tr.quiet = 0;
      }
    } else if (ev.t === 'divide' || ev.t === 'rip') { this.sawn.delete(ev.seg); if (info && info.newSeg) this.sawn.delete(info.newSeg); }
    if (ev.t === 'smash') {
      const b = w.builds && w.builds.find((x) => x.id === ev.b), k = b && BUILD[b.kind.split(':')[0]];
      if (k) this.charge(CFG[k[0]], `${k[1]} was smashed`);
    } else if (ev.t === 'crack' && w.paving) {
      // a paver whose damage is now only what this event added was whole before it
      const add = new Map();
      for (const [i, , , a] of ev.h) add.set(i, (add.get(i) || 0) + a);
      let n = 0;
      for (const [i, a] of add) if (w.paving.dmg[i] - a <= 1e-9) n++;
      if (n) this.charge(n * CFG.PAVER_COST, n === 1 ? 'A paver cracked' : `${n} pavers cracked`);
    } else if (ev.t === 'chipwreck') this.charge(CFG.CHIPPER_COST, 'The chipper truck was wrecked');
  }

  /** A new job: its budget from the tree's size and the lot's width (lot: nominal lot width, m, or 0 on flat test ground). */
  job(lot) {
    const h = CFG.TREE_HEIGHT, d = CFG.TREE_DIAMETER, L = lot > 0 ? lot : CFG.BUDGET_LOT_REF;
    const raw = CFG.BUDGET_BASE * (h * d) / (CFG.BUDGET_REF_H * CFG.BUDGET_REF_D) * (CFG.BUDGET_LOT_REF / L);
    const r = Math.max(1, CFG.BUDGET_ROUND), budget = Math.max(r, Math.round(raw / r) * r);
    const job = { budget, base: CFG.BUDGET_BASE, h, d, rh: CFG.BUDGET_REF_H, rd: CFG.BUDGET_REF_D, lot: +L.toFixed(2), rlot: CFG.BUDGET_LOT_REF };
    this.owed = 0;
    this.sim.emit({ t: 'budget', job });
    this.sim.toast(`Budget {money:${budget}}`);
  }

  /** Each tick: what the yard trees have suffered, and the crew's wages, WAGE per player per game hour, paid out in whole dollars. */
  step(dt) {
    const sim = this.sim;
    if (this.trees.size) this.yardStep(dt);
    if (!sim.world.job || !(CFG.DAY_LENGTH > 0)) return;
    const n = sim.players.list.size;
    this.owed = (this.owed || 0) + CFG.WAGE * n * dt / (CFG.DAY_LENGTH / 24);
    if (this.owed >= 1) { const c = Math.floor(this.owed); this.owed -= c; sim.emit({ t: 'wages', cost: c }); }
  }

  /** The yard trees: sawing finished, and wood that has come off them for good (checked a few times a second). */
  yardStep(dt) {
    const w = this.sim.world;
    for (const tr of this.trees.values()) {
      if (!(tr.cut > 0) || (tr.quiet += dt) < CFG.YARD_CUT_QUIET) continue;
      this.charge(tr.cut * CFG.YARD_CUT_COST, "Sawed into a neighbour's tree");
      tr.cut = 0;
    }
    if ((this.tCheck += dt) < 0.25) return;
    this.tCheck = 0;
    const off = new Map();        // stand index -> kg that came off it since the last check
    for (const [pc, i] of [...this.yard]) {
      const piece = w.pieces.get(pc);
      if (!piece) { this.yard.delete(pc); this.lost.delete(pc); continue; }   // chipped or swept away
      if (piece.fixed || this.lost.has(pc) || this.sim.structure.isHeld(pc)) continue;
      this.lost.add(pc);
      let m = 0;
      for (const s of w.segsOf(pc)) m += segMass(s) + s.leaf;
      off.set(i, (off.get(i) || 0) + m);
    }
    for (const [i, m] of off) {
      const tr = this.trees.get(i); if (!tr) continue;
      tr.gone += m;
      // the sawing that took it off goes on the same bill
      let cost = m * CFG.YARD_LOSS_COST + tr.cut * CFG.YARD_CUT_COST, what = "A limb came off a neighbour's tree";
      tr.cut = 0;
      if (!tr.felled && tr.gone >= 0.5 * tr.M) { tr.felled = true; cost += CFG.YARD_FELL_COST; what = "A neighbour's tree was felled"; }
      this.charge(cost, `${what} ({mass:${Math.round(m)}})`);
    }
  }

  charge(cost, what) {
    if (!(cost > 0)) return;
    const sim = this.sim;
    sim.emit({ t: 'damage', cost });
    sim.toast(`${what}: {money:${Math.round(cost)}}`);   // the running total is on the status line (hud.js)
  }
}
