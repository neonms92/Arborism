// Stickers (achievements, DECISIONS D105). The host awards one to everyone in the game when the crew reaches
// a mark (sim/awards.js); each player sticks theirs on their helmet, and the browser keeps them (stickerui.js).
// This file is the shared part: the kinds, and the cleaning a host does on a player's list before it goes into
// the model. Plain data: no DOM.
//
// A stuck sticker on the wire and in the model: [kind, tier, a, e, r]
//   a: azimuth round the helmet (0 = the front, where the face is; + toward the wearer's left, +x),
//   e: elevation above the helmet's centre plane (rad), r: roll about the outward normal (rad, 0 = upright).

import { CFG } from '../config.js';

/** kind -> number of tiers. tree: brown / yellow / green; chip: bronze / silver / gold. */
export const KINDS = { tree: 3, chip: 3, bin: 1, skull: 1, salad: 1, house: 1, shed: 1, fence: 1, wreck: 1, cutself: 1, cutother: 1, rigcut: 1, lower: 1, perch: 1, perchother: 1 };
/** Kinds a player keeps only the first time ever (D108). */
export const ONCE = new Set(['cutother', 'perchother']);

const num = (v, lo, hi) => (Number.isFinite(v) ? Math.max(lo, Math.min(hi, Math.round(v * 1000) / 1000)) : null);

/** A player's stuck stickers as sent to the host, made safe: known kinds, tiers in range, at most STICKER_MAX. */
export function cleanStickers(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const s of list) {
    if (out.length >= CFG.STICKER_MAX) break;
    if (!Array.isArray(s) || !Object.hasOwn(KINDS, s[0])) continue;
    const t = Number.isInteger(s[1]) && s[1] >= 0 && s[1] < KINDS[s[0]] ? s[1] : 0;
    const a = num(s[2], -10, 10), e = num(s[3], -1.6, 1.6), r = num(s[4], -10, 10);
    if (a === null || e === null || r === null) continue;
    out.push([s[0], t, a, e, r]);
  }
  return out;
}

/** The tier a fraction of the job reaches against STICKER_T1..T3: -1 none yet, else 0..2. */
export function tierOf(f) { return f >= CFG.STICKER_T3 ? 2 : f >= CFG.STICKER_T2 ? 1 : f >= CFG.STICKER_T1 ? 0 : -1; }
