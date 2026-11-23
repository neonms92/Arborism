// Concrete pavers round the tree. Plain data, part of the world model.
//
// Laid in a basket weave: the ground is divided into cells of side c, and
// each cell holds two c x c/2 pavers, side by side, turned a quarter turn
// from the cells next to it. Only whole pavers that fit inside a circle of
// radius r round the trunk are laid, and a square of cells is left open
// round the trunk (the tree pit). Their tops are flush with the ground (y = 0), so the ground
// collider is what wood and players actually land on; the sim works out which
// paver a contact point is on (paverAt).
//
// Each paver has a damage counter with no cap (one unit = one PAVER_CRACK_E of
// impact energy) and the places it was hit, which the view grows cracks from.

export const HITS_KEPT = 16;   // crack origins remembered per paver (damage itself keeps counting)

/** The layout for cell size c, radius r of the paved circle and half-width pit of the hole. */
export function layPavers(c, r, pit) {
  const n = Math.max(1, Math.ceil(r / c)), k = Math.max(1, Math.ceil(pit / c - 1e-6));
  const list = [], index = new Map();
  for (let i = -n; i < n; i++) for (let j = -n; j < n; j++) {
    if (i >= -k && i < k && j >= -k && j < k) continue;          // the tree pit
    const cx = (i + 0.5) * c, cz = (j + 0.5) * c, alongX = ((i + j) & 1) === 0;
    for (let h = 0; h < 2; h++) {
      const o = (h - 0.5) * c / 2;
      const p = alongX ? { x: cx, z: cz + o, hx: c / 2, hz: c / 4 } : { x: cx + o, z: cz, hx: c / 4, hz: c / 2 };
      if (Math.hypot(Math.abs(p.x) + p.hx, Math.abs(p.z) + p.hz) > r) continue;   // its far corner is outside the circle
      index.set(key(i, j, h), list.length);
      list.push(p);
    }
  }
  return { c, n, k, list, index };
}

const key = (i, j, h) => `${i},${j},${h}`;

/** Index of the paver under world (x, z), or -1. */
export function paverAt(L, x, z) {
  const c = L.c, i = Math.floor(x / c), j = Math.floor(z / c);
  if (i < -L.n || i >= L.n || j < -L.n || j >= L.n) return -1;
  const alongX = ((i + j) & 1) === 0, f = alongX ? z / c - j : x / c - i;
  const id = L.index.get(key(i, j, f < 0.5 ? 0 : 1));
  return id === undefined ? -1 : id;
}

/** A fresh paved area: {c, r, pit, L, dmg[], hits[][]}. hits are [u, v, amount], paver-local (m from its centre). */
export function newPaving(c, r, pit) {
  const L = layPavers(c, r, pit);
  return { c, r, pit, L, dmg: new Array(L.list.length).fill(0), hits: L.list.map(() => []) };
}

/** Add damage to paver i, struck at world (x, z). */
export function crackPaver(pv, i, x, z, add) {
  const p = pv.L.list[i]; if (!p) return;
  pv.dmg[i] += add;
  const hs = pv.hits[i], u = Math.max(-p.hx, Math.min(p.hx, x - p.x)), v = Math.max(-p.hz, Math.min(p.hz, z - p.z));
  // a hit close to an earlier one deepens that one; otherwise it is a new crack origin
  for (const h of hs) if (Math.hypot(h[0] - u, h[1] - v) < 0.05) { h[2] += add; return; }
  if (hs.length < HITS_KEPT) hs.push([+u.toFixed(3), +v.toFixed(3), add]);
  else hs[hs.length - 1][2] += add;
}

export function packPaving(pv) {
  if (!pv) return null;
  const d = [];
  pv.dmg.forEach((v, i) => { if (v > 0) d.push([i, v, pv.hits[i]]); });
  return { c: pv.c, r: pv.r, pit: pv.pit, d };
}
export function unpackPaving(o) {
  if (!o) return null;
  const pv = newPaving(o.c, o.r, o.pit);
  for (const [i, v, h] of o.d) { pv.dmg[i] = v; pv.hits[i] = h; }
  return pv;
}
