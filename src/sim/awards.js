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
//   bin    the "100%": share chipped times the share of the chips that went into bins, at STICKER_BIN. Only to
//          players who put STICKER_SHARE of the chips in bins (fed from their feeds, or tipped in by hand).
//   skull  the player who went DOWN (once per job each)
//   salad  the player who has eaten STICKER_SALADS tube salads this job (one handed over counts for whoever ate it)
//   house, shed, fence, wreck (a chipper)   the player whose wood or runaway chipper broke one (D107). Wood is
//          the player's who last sawed it free, grabbed, punched or fed it; a chipper is the player's who last
//          towed it or started a feed into it (the feed is what drags it off).
//   cutself, cutother   the player who sawed through their own lanyard, or someone else's
//   rigcut   on spurs, sawed free wood that has the rigging rope tied to it (D108)
//   lower    holding the rope tail, let down a piece of STICKER_LOWER_KG or more onto the ground, and nothing was
//            damaged (no 'damage' cost) for STICKER_LOWER_T seconds after
//   perch    sawed free the wood you are lanyarded to; perchother: wood someone else is lanyarded to
// All but the tree and chipper tiers come once per player per job; cutother and perchother carry once: 1, and a
// player's browser keeps them only the first time ever (stickerui.js).

import { CFG, MODE } from '../config.js';
import { segMass } from '../model/world.js';
import { tierOf } from '../model/stickers.js';

export class Awards {
  constructor(sim) {
    this.sim = sim; this.owed = { chop: {}, chip: {}, bin: {} }; this.any = false;
    // who set what moving, for the breaking stickers (host only: a player who takes over starts these afresh)
    this.by = new Map();          // loose piece id -> player id
    this.chipBy = new Map();      // chipper k -> player id
    this.sawn = new Map();        // seg id -> player id who last sawed fibres of it
    this.lastSaw = -1;            // whoever sawed job wood last
    this.lastSawT = -1e9;         // ... at this tick
    this.lowered = new Set();     // pieces already let down (one try each)
    this.landing = null;          // {id, piece, until, dmg}: a heavy piece let down, waiting to see that nothing broke
  }

  /** A new job (a tree has just grown): nothing handed out yet. */
  begin() {
    this.owed = { chop: {}, chip: {}, bin: {} }; this.any = false;
    this.by.clear(); this.chipBy.clear(); this.sawn.clear(); this.lastSaw = -1; this.lowered.clear(); this.landing = null;
    this.sim.emit({ t: 'job', id: Math.random().toString(36).slice(2, 10) });
  }

  /** Player id's saw went through a fibre of segment seg. */
  sawed(id, seg) { this.sawn.set(seg, id); if (!this.sim.world.segs.get(seg)?.yd) { this.lastSaw = id; this.lastSawT = this.sim.tick; } }
  /** Player id took hold of, punched or fed this piece: it is theirs now. */
  touch(piece, id) { if (piece !== undefined && !this.sim.world.pieces.get(piece)?.fixed) this.by.set(piece, id); }
  /** Player id towed chipper k or started a feed into it. */
  touchChipper(k, id) { this.chipBy.set(k || 0, id); }
  /** A new piece split off: it belongs to whoever sawed where it parted, else to whoever had the piece, else to the last sawyer. */
  onEvent(ev, info) {
    if (ev.t !== 'split' || !info.moved) return;
    const id = this.sawn.get(info.cutSeg) ?? this.by.get(info.oldPiece) ?? this.lastSaw;
    if (id >= 0) this.by.set(ev.newPiece, id);
    this.cutDown(ev, info);
  }
  /** Wood came free (players.onSplit has not moved anyone's lanyard yet): stickers for who sawed it. */
  cutDown(ev, info) {
    const sim = this.sim, w = sim.world, moved = new Set(info.moved);
    // the sawyer: whoever sawed where it parted, else whoever sawed job wood in the last 3 s
    let cutter = this.sawn.get(info.cutSeg);
    if (cutter === undefined && sim.tick - this.lastSawT < 3 / CFG.TICK) cutter = this.lastSaw;
    const p = cutter === undefined ? null : sim.players.list.get(cutter);
    if (!p) return;
    const r = w.rope;
    if (p.mode === MODE.CLIMB && r.state === 2 && r.anchor.seg !== undefined && moved.has(r.anchor.seg)) this.give('rigcut', 0, [p.id]);
    for (const q of sim.players.list.values()) {
      if (!q.cl || q.mode !== MODE.CLIMB) continue;
      // the lanyard's segment as it will be after this split (the same remap players.onSplit makes)
      const on = moved.has(q.cl.seg) || (q.cl.seg === ev.seg && ev.at > 0 && q.cl.t > ev.at);
      if (!on) continue;
      if (q === p) this.give('perch', 0, [p.id]); else this.give('perchother', 0, [p.id], true);
    }
  }
  /** Every few ticks: a heavy piece on the rope let down onto the ground by whoever holds the tail. */
  lowering() {
    const sim = this.sim, w = sim.world, r = w.rope;
    if (this.landing) {
      const L = this.landing;
      if (w.damage > L.dmg) this.landing = null;                     // something broke: no sticker
      else if (sim.tick >= L.until) { this.give('lower', 0, [L.id]); this.landing = null; }
      return;
    }
    const holder = sim.rope.holder;
    if (r.state !== 2 || r.anchor.seg === undefined || holder < 0) return;
    const s = w.segs.get(r.anchor.seg); if (!s) return;
    const piece = s.piece;
    if (w.pieces.get(piece)?.fixed || this.lowered.has(piece)) return;
    let m = 0; for (const g of w.segsOf(piece)) m += segMass(g) + g.leaf;
    if (m < CFG.STICKER_LOWER_KG) return;
    let down = false;
    for (const g of w.segsOf(piece)) {
      const c = sim.segCol.get(g.id); if (!c) continue;
      sim.rapier.contactPair(sim.groundCol, c, (man) => { if (man.numContacts() > 0) down = true; });
      if (down) break;
    }
    if (!down) return;
    this.lowered.add(piece);
    this.landing = { id: holder, piece, until: sim.tick + Math.round(CFG.STICKER_LOWER_T / CFG.TICK), dmg: w.damage };
  }
  /** Who is to blame for collider h hitting something: the player behind that wood or chipper, or -1. */
  culprit(h) {
    const sim = this.sim, seg = sim.colSeg.get(h);
    if (seg !== undefined) {
      const s = sim.world.segs.get(seg); if (!s) return -1;
      return sim.world.pieces.get(s.piece)?.fixed ? -1 : this.by.get(s.piece) ?? -1;
    }
    for (const u of sim.chipper.units) if (u && u.solid(h)) return this.chipBy.get(u.k) ?? -1;
    return -1;
  }
  /** Something of kind ('house', 'shed', 'fence', 'wreck') broke, hit by collider h. */
  broke(kind, h) { const id = this.culprit(h); if (id >= 0) this.give(kind, 0, [id]); }
  /** Player by sawed through victim's lanyard. */
  lanyard(by, victim) { if (by === victim) this.give('cutself', 0, [by]); else this.give('cutother', 0, [by], true); }

  /** Player id did n of kind ('chop': m² of job wood sawn through; 'chip': kg of job wood they fed chipped;
   *  'bin': m³ of chips into bins, from their feeds or by hand). */
  credit(kind, id, n) {
    if (!(n > 0) || id === undefined || id < 0 || !this.sim.world.awards.job) return;
    this.owed[kind][id] = (this.owed[kind][id] || 0) + n; this.any = true;
  }

  /** once: the player's browser keeps it only the first time ever. */
  give(k, tier, ids, once = false) {
    const A = this.sim.world.awards, got = A.got[k] || {};
    if (!A.job) return;
    const to = ids.filter((id) => (got[id] ?? -1) < tier);
    if (to.length) this.sim.emit({ t: 'award', k, tier, to, job: A.job, ...(once ? { once: 1 } : {}) });
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
      sim.emit({ t: 'work', chop: r(this.owed.chop), chip: r(this.owed.chip), bin: r(this.owed.bin) });
      this.owed = { chop: {}, chip: {}, bin: {} }; this.any = false;
    }
    const t = tierOf(this.chopped());
    if (t >= 0) this.give('tree', t, this.workers('chop'));
    const chipped = P.M > (P.lost || 0) ? Math.min(1, P.chipped / (P.M - (P.lost || 0))) : 0;
    const c = tierOf(chipped);
    if (c >= 0) this.give('chip', c, this.workers('chip'));
    if (P.made > 0 && chipped * Math.min(1, P.gone / P.made) >= CFG.STICKER_BIN) this.give('bin', 0, this.workers('bin'));
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
