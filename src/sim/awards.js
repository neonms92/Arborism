// Stickers (achievements, D105): the host watches the job and hands a sticker to everyone in the game at once
// with an 'award' event. What has been handed out lives in the model (world.awards), not here, so a player who
// takes over as host (D104) carries on without handing anything out twice. Runs in a worker too: no DOM.
//
//   tree   share of the job tree no longer standing on its roots (cut down, chipped or swept away):
//          brown at STICKER_T1, yellow at T2, green at T3
//   chip   share of the job tree chipped (as the HUD shows it): bronze, silver, gold at the same marks
//   bin    the "100%": share chipped times the share of the chips that went into bins, at STICKER_BIN
//   skull  someone went DOWN (once per job)
//   salad  STICKER_SALADS tube salads eaten this job, by anyone (one handed over and eaten counts)

import { CFG } from '../config.js';
import { segMass } from '../model/world.js';
import { tierOf } from '../model/stickers.js';

export class Awards {
  constructor(sim) { this.sim = sim; }

  /** A new job (a tree has just grown): nothing handed out yet. */
  begin() { this.sim.emit({ t: 'job', id: Math.random().toString(36).slice(2, 10) }); }

  give(k, tier) {
    const A = this.sim.world.awards;
    if (!A.job || (A.got[k] ?? -1) >= tier) return;
    this.sim.emit({ t: 'award', k, tier, job: A.job });
  }

  /** A player went DOWN. */
  down() { this.give('skull', 0); }
  /** A tube salad was eaten. */
  ate() {
    const A = this.sim.world.awards; if (!A.job) return;
    this.sim.emit({ t: 'ate' });
    if (A.ate >= CFG.STICKER_SALADS) this.give('salad', 0);
  }

  /** Every half second or so: how far the job has got. */
  check() {
    const w = this.sim.world, A = w.awards, P = w.prog;
    if (!A.job || !(P.M > 0)) return;
    let standing = 0;
    for (const s of w.segs.values()) if (!s.yd && w.pieces.get(s.piece)?.fixed) standing += segMass(s) + s.leaf;
    const t = tierOf(1 - standing / P.M);
    if (t >= 0) this.give('tree', t);
    const chipped = P.M > (P.lost || 0) ? Math.min(1, P.chipped / (P.M - (P.lost || 0))) : 0;
    const c = tierOf(chipped);
    if (c >= 0) this.give('chip', c);
    if (P.made > 0 && chipped * Math.min(1, P.gone / P.made) >= CFG.STICKER_BIN) this.give('bin', 0);
  }
}
