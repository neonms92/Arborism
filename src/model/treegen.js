// Seeded tree generator, shaped by the TREE_* / BRANCH_* / SEG_LEN / FIBRE_*
// values in config (the Tab menu), or by an explicit shape `o` (treeShape) so
// that every machine grows the same tree from the same numbers whatever its own
// menu says (the other trees in the yards, model/stands.js, are drawn on every
// machine from their shape before any of their wood exists).
// Returns [{id, parent, a, b, r0, r1, leaf, N}] with parents before children
// (N = fibres across that segment's bundle). The trunk comes first, base to top.

import { CFG } from '../config.js';
import { gridFor } from './fibres.js';

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The job tree's shape from the menu: height, diameter, branch density and length, segment length, segment cap, fibre width. */
export function treeShape(over = {}) {
  return { h: CFG.TREE_HEIGHT, d: CFG.TREE_DIAMETER, dens: CFG.BRANCH_DENSITY, blen: CFG.BRANCH_LENGTH, sl: CFG.SEG_LEN, cap: CFG.SEG_CAP, pitch: CFG.FIBRE_PITCH, ...over };
}

export function generateTree(seed, newId, origin = [0, 0, 0], o = treeShape()) {
  const R = rng(seed), segs = [];
  const rnd = (a, b) => a + (b - a) * R();
  const H = o.h, rBase = o.d / 2, SL = Math.max(0.1, o.sl), cap = o.cap;
  const scale = H / 11, thick = rBase / 0.27, dens = o.dens, blen = o.blen * scale;
  const add = (parent, a, b, r0, r1, leaf = 0) => {
    const s = { id: newId(), parent, a, b, r0, r1, leaf, N: gridFor(r0, o.pitch) }; segs.push(s); return s;
  };
  const norm = (v) => { const l = Math.hypot(v[0], v[1], v[2]); return [v[0] / l, v[1] / l, v[2] / l]; };
  /** How many branches to start here, for `per` expected per metre of stem. */
  const count = (per, len) => { const x = per * len * dens, n = Math.floor(x); return n + (R() < x - n ? 1 : 0); };

  // Grow a stem as a chain of segments; returns them. lift and wobble are per metre.
  function chain(parent, start, dir, length, r0, r1, lift, wobble) {
    const n = Math.max(1, Math.round(length / SL)), sl = length / n, out = [];
    let p = start, d = norm(dir), par = parent;
    for (let i = 0; i < n; i++) {
      const w = wobble * sl, ra = r0 + (r1 - r0) * i / n, rb = r0 + (r1 - r0) * (i + 1) / n;
      d = norm([d[0] + rnd(-w, w), d[1] + lift * sl + rnd(-w, w), d[2] + rnd(-w, w)]);
      const q = [p[0] + d[0] * sl, p[1] + d[1] * sl, p[2] + d[2] * sl];
      const s = add(par, p, q, ra, rb, rb < 0.04 ? 0.75 * sl : 0);          // twigs carry foliage along their length
      out.push(s); par = s.id; p = q;
    }
    out[out.length - 1].leaf += 1.5;
    return out;
  }

  // Trunk: a lean, so a felling cut has something to work with.
  const lean = rnd(0.10, 0.15), leanAz = rnd(0, Math.PI * 2);
  const trunk = chain(-1, origin, [Math.sin(lean) * Math.cos(leanAz), 1, Math.sin(lean) * Math.sin(leanAz)],
    H, rBase, rBase * 0.22, 0.03, 0.02);

  let az = rnd(0, Math.PI * 2), first = true, h = 0;
  for (let i = 0; i < trunk.length; i++) {
    const t = trunk[i], sl = H / trunk.length;
    h += sl;
    if (h < 0.34 * H || i === trunk.length - 1) continue;                    // clear stem below the crown
    for (let c = first ? Math.max(1, count(0.9, sl)) : count(0.9, sl); c > 0 && segs.length < cap; c--) {
      az += 2.4 + rnd(-0.4, 0.4);
      const frac = h / H, elev = rnd(0.25, 0.75) + frac * 0.4;
      const dir = [Math.cos(az) * Math.cos(elev), Math.sin(elev), Math.sin(az) * Math.cos(elev)];
      const rb = t.r1 * rnd(0.45, 0.62);
      const length = (first ? 5.6 : rnd(2.6, 4.8)) * (1 - 0.45 * frac) * blen;
      const limb = chain(t.id, t.b, dir, length, first ? Math.max(rb, 0.085 * thick) : rb, 0.02, 0.075, 0.09);
      first = false;
      for (let j = 0; j < limb.length - 1; j++) {
        const l = limb[j];
        for (let c2 = count(0.9, length / limb.length); c2 > 0 && segs.length < cap; c2--) {
          const a2 = rnd(0, Math.PI * 2), tl = rnd(1.0, 2.2) * blen;
          const d2 = [dir[0] * 0.5 + Math.cos(a2), 0.3 + rnd(0, 0.6), dir[2] * 0.5 + Math.sin(a2)];
          chain(l.id, l.b, d2, tl, Math.max(0.018 * tl, l.r1 * rnd(0.45, 0.6)), 0.015, 0.11, 0.14);   // long twigs are thicker: they must carry themselves
        }
      }
    }
  }
  return segs;
}
