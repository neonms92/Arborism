// Concrete pavers: the circle round the tree, and the patios, porches and
// sidewalks of the yards (model/yards.js). Plain data, part of the world model.
//
// Pavers are laid in AREAS. Each area has its own frame (centre x, z and a
// turn `yaw` about +y) and is laid in a basket weave in that frame: the
// ground is divided into cells of side c, and each cell holds two c x c/2
// pavers, side by side, turned a quarter turn from the cells next to it. Only
// whole pavers that fit inside the area are laid.
//   {shape: 'circle', x, z, r, pit}      whole pavers within r of the centre
//   {shape: 'rect', x, z, yaw, w, d, pit} whole pavers within a w x d rectangle (w along the area's x)
// pit (optional): a square of that half-width left open in the middle (a tree pit).
// mat (optional): what the area is made of (MATS). 'paver' (the default) is the basket weave above; 'slab' (a
// concrete driveway) and 'asphalt' (a street) are rectangles cut into a plain grid of panels about `c` (the
// area's own cell, m) on a side, stretched to fill it exactly: a driveway's control joints, and patches of road
// that crack on their own. All three crack the same way; the sim and the view look the material up per panel (m).
// Their tops are flush with the ground, so the ground collider is what wood
// and players actually land on; the sim works out which paver a contact
// point is on (paverAt), and the view lays each one on the ground under it.
//
// Each paver has a damage counter with no cap (one unit = one PAVER_CRACK_E of
// impact energy) and the places it was hit (in its own frame), which the view
// grows cracks from.

import { groundN } from './terrain.js';

export const MATS = ['paver', 'slab', 'asphalt'];
export const HITS_KEPT = 16;   // crack origins remembered per paver (damage itself keeps counting)
const BUCKET = 2;              // m, side of the lookup grid's squares

/**
 * The layout for cell size c and these areas: {c, list: [{x, z, a, hx, hz}], grid}. a: the paver's turn
 * about +y (its hx is along its own x). Areas are laid in order and a paver that would overlap one already
 * laid is left out, so areas can touch or overlap. keep(paver) (optional) can turn a paver down (too steep).
 */
export function layPavers(c, areas, keep) {
  const list = [], grid = new Map();
  for (const A of areas) {
    const ca = Math.cos(A.yaw || 0), sa = Math.sin(A.yaw || 0), mat = A.mat || 'paver';
    const put = (p) => {
      const w = { x: +(A.x + p.x * ca + p.z * sa).toFixed(4), z: +(A.z - p.x * sa + p.z * ca).toFixed(4), a: A.yaw || 0, hx: p.hx, hz: p.hz, m: mat };
      if (paverAt({ list, grid }, w.x, w.z) >= 0) return;           // an area laid earlier is already there
      if (keep && !keep(w)) return;
      add(grid, list.length, w);
      list.push(w);
    };
    if (mat !== 'paver') {
      // a plain grid of panels filling the rectangle: as many along each side as come closest to the cell
      const cell = A.c || c, nu = Math.max(1, Math.round(A.w / cell)), nw = Math.max(1, Math.round(A.d / cell));
      const hu = +(A.w / nu / 2).toFixed(4), hw = +(A.d / nw / 2).toFixed(4);
      for (let i = 0; i < nu; i++) for (let j = 0; j < nw; j++) put({ x: -A.w / 2 + (2 * i + 1) * hu, z: -A.d / 2 + (2 * j + 1) * hw, hx: hu, hz: hw });
      continue;
    }
    let ni, nj, inside;
    if (A.shape === 'circle') {
      ni = nj = Math.max(1, Math.ceil(A.r / c));
      inside = (p) => Math.hypot(Math.abs(p.x) + p.hx, Math.abs(p.z) + p.hz) <= A.r;      // its far corner is inside the circle
    } else {
      ni = Math.max(1, Math.ceil(A.w / 2 / c)); nj = Math.max(1, Math.ceil(A.d / 2 / c));
      inside = (p) => Math.abs(p.x) + p.hx <= A.w / 2 + 1e-6 && Math.abs(p.z) + p.hz <= A.d / 2 + 1e-6;
    }
    const pit = A.pit || 0;      // no paver reaches into the square of this half-width round the area's middle (the tree pit)
    const fits = (p) => inside(p) && !(Math.abs(p.x) - p.hx < pit && Math.abs(p.z) - p.hz < pit);
    // a rectangle's weave starts at its corner, so the pavers fill it to the edge when it is a whole number of cells
    const ox = A.shape === 'rect' ? -A.w / 2 + ni * c : 0, oz = A.shape === 'rect' ? -A.d / 2 + nj * c : 0;
    for (let i = -ni; i < ni; i++) for (let j = -nj; j < nj; j++) {
      const cx = (i + 0.5) * c + ox, cz = (j + 0.5) * c + oz, alongX = ((i + j) & 1) === 0;
      for (let h = 0; h < 2; h++) {
        const o = (h - 0.5) * c / 2;
        const p = alongX ? { x: cx, z: cz + o, hx: c / 2, hz: c / 4 } : { x: cx + o, z: cz, hx: c / 4, hz: c / 2 };
        if (fits(p)) put(p);
      }
    }
  }
  return { c, list, grid };
}

const bkey = (i, j) => i * 100003 + j;
/** The setting names for a material: [impact energy that cracks one, damage at which it is rubble, $ the first time one cracks]. */
export const MAT_CFG = { paver: ['PAVER_CRACK_E', 'PAVER_GRAVEL', 'PAVER_COST'], slab: ['DRIVE_CRACK_E', 'DRIVE_GRAVEL', 'DRIVE_COST'], asphalt: ['STREET_CRACK_E', 'STREET_GRAVEL', 'STREET_COST'] };
function add(grid, idx, p) {
  const r = Math.hypot(p.hx, p.hz);
  for (let i = Math.floor((p.x - r) / BUCKET); i <= Math.floor((p.x + r) / BUCKET); i++) {
    for (let j = Math.floor((p.z - r) / BUCKET); j <= Math.floor((p.z + r) / BUCKET); j++) {
      const k = bkey(i, j); let b = grid.get(k); if (!b) grid.set(k, b = []); b.push(idx);
    }
  }
}

/** World (x, z) in paver p's own frame: [u, v]. */
export function paverLocal(p, x, z) {
  const dx = x - p.x, dz = z - p.z, ca = Math.cos(p.a), sa = Math.sin(p.a);
  return [dx * ca - dz * sa, dx * sa + dz * ca];
}

/** Index of the paver under world (x, z), or -1. */
export function paverAt(L, x, z) {
  const b = L.grid.get(bkey(Math.floor(x / BUCKET), Math.floor(z / BUCKET)));
  if (!b) return -1;
  for (const i of b) {
    const p = L.list[i], [u, v] = paverLocal(p, x, z);
    if (Math.abs(u) <= p.hx && Math.abs(v) <= p.hz) return i;
  }
  return -1;
}

/**
 * A fresh paved area: {c, areas, slope, L, dmg[], hits[][]}. hits are [u, v, amount], paver-local (m from its centre).
 * slope (rad, optional): no paver is laid where the ground under its middle is steeper than this (the host's
 * PAVER_MAX_SLOPE, sent in the event so every machine lays the same pavers).
 */
export function newPaving(c, areas, terrain = null, slope) {
  const minY = slope >= 0 ? Math.cos(slope) : -2;
  const L = layPavers(c, areas, terrain && minY > -1 ? (p) => groundN(terrain, p.x, p.z)[1] >= minY - 1e-9 : null);
  return { c, areas, slope, L, dmg: new Array(L.list.length).fill(0), hits: L.list.map(() => []) };
}

/** Add damage to paver i, struck at world (x, z). */
export function crackPaver(pv, i, x, z, add) {
  const p = pv.L.list[i]; if (!p) return;
  pv.dmg[i] += add;
  const hs = pv.hits[i], [lu, lv] = paverLocal(p, x, z), u = Math.max(-p.hx, Math.min(p.hx, lu)), v = Math.max(-p.hz, Math.min(p.hz, lv));
  // a hit close to an earlier one deepens that one; otherwise it is a new crack origin
  for (const h of hs) if (Math.hypot(h[0] - u, h[1] - v) < 0.05) { h[2] += add; return; }
  if (hs.length < HITS_KEPT) hs.push([+u.toFixed(3), +v.toFixed(3), add]);
  else hs[hs.length - 1][2] += add;
}

export function packPaving(pv) {
  if (!pv) return null;
  const d = [];
  pv.dmg.forEach((v, i) => { if (v > 0) d.push([i, v, pv.hits[i]]); });
  return { c: pv.c, areas: pv.areas, slope: pv.slope, d };
}
export function unpackPaving(o, terrain) {
  if (!o) return null;
  const pv = newPaving(o.c, o.areas, terrain, o.slope);
  for (const [i, v, h] of o.d) { pv.dmg[i] = v; pv.hits[i] = h; }
  return pv;
}
