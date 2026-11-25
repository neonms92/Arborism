// Host only: the job's money. A budget at the start of each job (job()), wages
// paid out as play goes on (step()), and what the job has broken. Each paver cracked
// (the first time), each module of a house, shed or fence broken apart, and a
// wrecked chipper add their price (the *_COST settings) to world.damage
// through a 'damage' event, with a toast to everyone.

import { CFG } from '../config.js';

// build kind (before any ':') -> [cost setting, what to call one broken module]
const BUILD = { shed: ['SHED_COST', 'The shed'], fence: ['FENCE_COST', 'A fence section'], house: ['HOUSE_COST', 'A room of a house'] };

export class Damage {
  constructor(sim) { this.sim = sim; }

  /** After the world applied ev (sim.onEvent). */
  onEvent(ev) {
    const w = this.sim.world;
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

  /** Each tick: the crew's wages, WAGE per player per game hour, paid out in whole dollars. */
  step(dt) {
    const sim = this.sim; if (!sim.world.job || !(CFG.DAY_LENGTH > 0)) return;
    const n = sim.players.list.size;
    this.owed = (this.owed || 0) + CFG.WAGE * n * dt / (CFG.DAY_LENGTH / 24);
    if (this.owed >= 1) { const c = Math.floor(this.owed); this.owed -= c; sim.emit({ t: 'wages', cost: c }); }
  }

  charge(cost, what) {
    if (!(cost > 0)) return;
    const sim = this.sim;
    sim.emit({ t: 'damage', cost });
    sim.toast(`${what}: {money:${Math.round(cost)}}`);   // the running total is on the status line (hud.js)
  }
}
