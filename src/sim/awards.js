// Stickers (achievements, D105, D106): the host watches the job and hands out stickers with 'award' events
// {k, tier, to: [player ids], job}. What has been handed out, and who did how much of the work, lives in the
// model (world.awards), not here, so a player who takes over as host (D104) carries on without handing anything
// out twice. Runs in a worker too: no DOM.
//
//   tree   share of the job tree chopped: chipped, swept away, or in loose sections each light enough for the
//          chipper to take (CHIP_CAPACITY, the weight that seizes its rollers, D66): brown at STICKER_T1, yellow
//          at T2, green at T3. Only to players who did STICKER_SHARE of the sawing (cross-section cut).
//   chip   share of the job tree chipped (as the HUD shows it): bronze, silver, gold at the same marks. Only to
//          players who fed STICKER_SHARE of the wood chipped.
//   bin    the "100%": share chipped times the share of the chips that went into bins, at STICKER_BIN; everyone
//   skull  the player who went DOWN (once per job each)
//   salad  the player who has eaten STICKER_SALADS tube salads this job (one handed over counts for whoever ate it)

import { CFG } from '../config.js';
import { segMass } from '../model/world.js';
import { tierOf } from '../model/stickers.js';

export class Awards {
  constructor(sim) { this.sim = sim; this.owed = { chop: {}, chip: {} }; this.any = false; }

  /** A new job (a tree has just grown): nothing handed out yet. */
  begin() { this.owed = { chop: {}, chip: {} }; this.any = false; this.sim.emit({ t: 'job', id: Math.random().toString(36).slice(2, 10) }); }

  /** Player id did n of kind ('chop': m² of job wood sawn through; 'chip': kg of job wood they fed chipped). */
  credit(kind, id, n) {
    if (!(n > 0) || id === undefined || id < 0 || !this.sim.world.awards.job) return;
    this.owed[kind][id] = (this.owed[kind][id] || 0) + n; this.any = true;
  }

  give(k, tier, ids) {
    const A = this.sim.world.awards, got = A.got[k] || {};
    if (!A.job) return;
    const to = ids.filter((id) => (got[id] ?? -1) < tier);
    if (to.length) this.sim.emit({ t: 'award', k, tier, to, job: A.job });
  }

  /** A player went DOWN. */
  down(id) { this.give('skull', 0, [id]); }
  /** Player id ate a tube salad (their own, or one handed to them). */
  ate(id) {
    const A = this.sim.world.awards; if (!A.job) return;
    this.sim.emit({ t: 'ate', id });
    if ((A.ate[id] || 0) >= CFG.STICKER_SALADS) this.give('salad', 0, [id]);
  }

  /** The players here who did at least STICKER_SHARE of this kind of work. */
  workers(kind) {
    const W = this.sim.world.awards.work[kind] || {};
    let tot = 0; for (const k in W) tot += W[k];
    if (!(tot > 0)) return [];
    return [...this.sim.players.list.keys()].filter((id) => (W[id] || 0) >= CFG.STICKER_SHARE * tot - 1e-12);
  }

  /** Every half second or so: the work done since last time into the model, then how far the job has got. */
  check() {
    const sim = this.sim, w = sim.world, A = w.awards, P = w.prog;
    if (!A.job || !(P.M > 0)) return;
    if (this.any) {
      const r = (o) => { const out = {}; for (const k in o) out[k] = +o[k].toPrecision(6); return out; };
      sim.emit({ t: 'work', chop: r(this.owed.chop), chip: r(this.owed.chip) });
      this.owed = { chop: {}, chip: {} }; this.any = false;
    }
    const t = tierOf(this.chopped());
    if (t >= 0) this.give('tree', t, this.workers('chop'));
    const chipped = P.M > (P.lost || 0) ? Math.min(1, P.chipped / (P.M - (P.lost || 0))) : 0;
    const c = tierOf(chipped);
    if (c >= 0) this.give('chip', c, this.workers('chip'));
    if (P.made > 0 && chipped * Math.min(1, P.gone / P.made) >= CFG.STICKER_BIN) this.give('bin', 0, [...sim.players.list.keys()]);
  }

  /** Share of the job tree chipped, swept away as debris, or lying in loose sections the chipper could take whole. */
  chopped() {
    const sim = this.sim, w = sim.world, P = w.prog;
    let done = P.chipped + (P.lost || 0);
    for (const pc of w.pieces.values()) {
      if (pc.fixed) continue;
      let m = 0;
      for (const s of w.segsOf(pc.id)) if (!s.yd) m += segMass(s) + s.leaf;
      if (m > 0 && sim.weightOf(pc.id) <= CFG.CHIP_CAPACITY) done += m;
    }
    return Math.min(1, done / P.M);
  }
}
