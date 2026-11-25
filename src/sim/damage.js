// Host only: what the job has broken, and what it costs. Each paver cracked
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

  charge(cost, what) {
    if (!(cost > 0)) return;
    const sim = this.sim;
    sim.emit({ t: 'damage', cost });
    sim.toast(`${what}: {money:${Math.round(cost)}}`);   // the running total is on the status line (hud.js)
  }
}
