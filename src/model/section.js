// A "section" is one cross-section of a segment where wood can part: a grid of
// fibre cells, the saw kerfs that have passed through it, and (host only) the
// stress analysis of what is left. Pure functions, no physics engine, no
// rendering. See docs/DESIGN.md sections 3.3 and 4.
//
// Section coordinates: origin on the stem axis, x along `u`, y along `v`,
// z along the stem axis `a` (base -> tip). (u, v, a) is right-handed and is
// derived from the segment axis by sectionBasis(), identically on every
// machine.

import { CFG } from '../config.js';

export const INTACT = 0, CUT = 1, TORN = 2;

const N = CFG.GRID;
// Unit-radius cell centres and which cells lie inside the circle.
export const CELLS = [];          // [{i, x, y}] for cells inside the unit circle
{
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const x = (i + 0.5) / N * 2 - 1, y = (j + 0.5) / N * 2 - 1;
    if (x * x + y * y <= 1) CELLS.push({ i: j * N + i, x, y });
  }
}
export const NCELL = CELLS.length;
const UNIT_DA = Math.PI / NCELL;   // so the cells sum to the true circle area
export const CELL_SIZE = 2 / N;    // in unit-radius coordinates

/** Right-handed basis (u, v) perpendicular to unit axis a. Arrays of 3. */
export function sectionBasis(a) {
  const ref = Math.abs(a[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  let u = [a[1] * ref[2] - a[2] * ref[1], a[2] * ref[0] - a[0] * ref[2], a[0] * ref[1] - a[1] * ref[0]];
  const l = Math.hypot(u[0], u[1], u[2]); u = [u[0] / l, u[1] / l, u[2] / l];
  const v = [a[1] * u[2] - a[2] * u[1], a[2] * u[0] - a[0] * u[2], a[0] * u[1] - a[1] * u[0]];
  return { u, v };
}

export function makeSection(id, seg, at, R) {
  return {
    id, seg, at, R,
    state: new Uint8Array(NCELL),        // INTACT / CUT / TORN
    zmin: new Float32Array(NCELL),       // axial extent of removed wood (m)
    zmax: new Float32Array(NCELL),
    mask: new Uint16Array(NCELL),        // which kerfs cut this cell (bit per kerf)
    kerfs: [],                           // [{phi, tilt, z0, depth}]
    sep: -1,                             // piece id that separated here, or -1
    // host-only scratch (not serialized):
    stress: new Float32Array(NCELL),
    act: new Uint8Array(NCELL),
    maxT: 0, pinch: [], intact: NCELL,
  };
}

export function intactCount(sec) {
  let n = 0; for (let c = 0; c < NCELL; c++) if (sec.state[c] === INTACT) n++;
  return n;
}

/** Apply kerf k (already stored in sec.kerfs[k]) to the cell grid. Idempotent. */
export function applyKerf(sec, k) {
  const kf = sec.kerfs[k], R = sec.R;
  const ex = Math.cos(kf.phi), ey = Math.sin(kf.phi), tt = Math.tan(kf.tilt);
  const bit = 1 << k;
  for (let c = 0; c < NCELL; c++) {
    const cell = CELLS[c];
    const xin = R - (cell.x * ex + cell.y * ey) * R;   // inward distance from the entry side
    if (xin > kf.depth) continue;
    const z = kf.z0 + xin * tt;
    if (sec.state[c] === INTACT || (sec.state[c] === TORN && !sec.mask[c])) {
      sec.state[c] = CUT; sec.zmin[c] = z; sec.zmax[c] = z;
    } else {
      if (z < sec.zmin[c]) sec.zmin[c] = z;
      if (z > sec.zmax[c]) sec.zmax[c] = z;
    }
    sec.mask[c] |= bit;
  }
  sec.intact = intactCount(sec);
}

export function gapOf(sec, c) { return sec.zmax[c] - sec.zmin[c] + CFG.KERF_WIDTH; }

/**
 * Stress analysis of the remaining wood (host only).
 * Loads are those the DISTAL part applies at the section centre:
 *   Nax = F . a   (positive = pulling the distal part away = tension)
 *   Mu, Mv = M . u, M . v  (bending moment components, N m)
 * Fills sec.stress (Pa, tension positive), sec.maxT, sec.pinch[k] (N).
 *
 * Linear stress field s = s0 + s1 (x-cx) + s2 (y-cy) over a weighted section:
 * intact cells weight 1; closed kerfs / torn cells weight KERF_CONTACT but only
 * in compression (active-set iteration).
 * Equilibrium:  sum(s dA) = Nax ;  sum(s y dA) = Mu ;  -sum(s x dA) = Mv.
 */
export function analyse(sec, Nax, Mu, Mv) {
  const R = sec.R, dA = UNIT_DA * R * R, KC = CFG.KERF_CONTACT;
  const closedGap = CFG.KERF_WIDTH * 1.5;
  const st = sec.state, act = sec.act;
  let s0 = 0, s1 = 0, s2 = 0, cx = 0, cy = 0, ok = false;
  for (let it = 0; it < 6; it++) {
    let A = 0, Sx = 0, Sy = 0;
    for (let c = 0; c < NCELL; c++) {
      const w = st[c] === INTACT ? 1 : (act[c] ? KC : 0);
      if (!w) continue;
      A += w; Sx += w * CELLS[c].x; Sy += w * CELLS[c].y;
    }
    if (A < 1e-9) { ok = false; break; }
    cx = Sx / A * R; cy = Sy / A * R;
    let Ixx = 0, Iyy = 0, Ixy = 0;
    for (let c = 0; c < NCELL; c++) {
      const w = st[c] === INTACT ? 1 : (act[c] ? KC : 0);
      if (!w) continue;
      const dx = CELLS[c].x * R - cx, dy = CELLS[c].y * R - cy;
      Ixx += w * dy * dy; Iyy += w * dx * dx; Ixy += w * dx * dy;
    }
    A *= dA; Ixx *= dA; Iyy *= dA; Ixy *= dA;
    // each cell's own second moment keeps one-cell-thick strips well conditioned
    const own = A * (CELL_SIZE * R) * (CELL_SIZE * R) / 12;
    Ixx += own; Iyy += own;
    const det = Ixx * Iyy - Ixy * Ixy;
    const Mup = Mu - cy * Nax, Mxp = -Mv - cx * Nax;
    s0 = Nax / A;
    s1 = (Mxp * Ixx - Mup * Ixy) / det;
    s2 = (Mup * Iyy - Mxp * Ixy) / det;
    ok = true;
    let changed = false;
    for (let c = 0; c < NCELL; c++) {
      if (st[c] === INTACT) continue;
      const canClose = st[c] === TORN || gapOf(sec, c) <= closedGap;
      const lin = s0 + s1 * (CELLS[c].x * R - cx) + s2 * (CELLS[c].y * R - cy);
      const want = canClose && lin < 0 ? 1 : 0;
      if (want !== act[c]) { act[c] = want; changed = true; }
    }
    if (!changed) break;
  }
  let maxT = 0;
  const pinch = sec.pinch; pinch.length = sec.kerfs.length; pinch.fill(0);
  for (let c = 0; c < NCELL; c++) {
    if (!ok) { sec.stress[c] = 0; continue; }
    const lin = s0 + s1 * (CELLS[c].x * R - cx) + s2 * (CELLS[c].y * R - cy);
    if (st[c] === INTACT) {
      sec.stress[c] = lin; if (lin > maxT) maxT = lin;
    } else if (act[c]) {
      sec.stress[c] = KC * lin;
      const f = -KC * lin * dA, m = sec.mask[c];
      for (let k = 0; k < pinch.length; k++) if (m & (1 << k)) pinch[k] += f;
    } else sec.stress[c] = 0;
  }
  sec.maxT = maxT;
  return ok;
}

/**
 * Shape of the remaining intact wood, treated as a strip.
 * Returns {n, cx, cy (m), hx, hy (unit long axis), L, w (m)}.
 */
export function hingeShape(sec) {
  const R = sec.R;
  let n = 0, sx = 0, sy = 0;
  for (let c = 0; c < NCELL; c++) if (sec.state[c] === INTACT) { n++; sx += CELLS[c].x; sy += CELLS[c].y; }
  if (!n) return { n: 0 };
  const cx = sx / n, cy = sy / n;
  let xx = 0, yy = 0, xy = 0;
  for (let c = 0; c < NCELL; c++) if (sec.state[c] === INTACT) {
    const dx = CELLS[c].x - cx, dy = CELLS[c].y - cy;
    xx += dx * dx; yy += dy * dy; xy += dx * dy;
  }
  xx /= n; yy /= n; xy /= n;
  const th = 0.5 * Math.atan2(2 * xy, xx - yy);
  const hx = Math.cos(th), hy = Math.sin(th);
  const lmax = xx * hx * hx + 2 * xy * hx * hy + yy * hy * hy;
  const lmin = Math.max(0, xx + yy - lmax);
  const cs = CELL_SIZE;
  return {
    n, cx: cx * R, cy: cy * R, hx, hy,
    L: Math.sqrt(12 * lmax + cs * cs) * R,
    w: Math.sqrt(12 * lmin + cs * cs) * R,
  };
}

export function isHingeLike(h, R) {
  return h.n > 0 && h.w <= CFG.HINGE_MAX_THICK * 2 * R && h.L >= CFG.HINGE_MIN_ASPECT * h.w;
}

/**
 * How far the distal part can rotate about the hinge before cut faces meet.
 * Positive rotation is right-handed about (hx, hy). Returns {plus, minus} rad.
 * A cell at signed distance d = hx*ry - hy*rx from the hinge line moves
 * axially by theta*d; it closes when that equals -gap.
 */
export function closeAngles(sec, h) {
  let plus = Infinity, minus = Infinity;
  const R = sec.R, eps = CELL_SIZE * R * 0.75;
  for (let c = 0; c < NCELL; c++) {
    if (sec.state[c] !== CUT) continue;
    const rx = CELLS[c].x * R - h.cx, ry = CELLS[c].y * R - h.cy;
    const d = h.hx * ry - h.hy * rx, g = gapOf(sec, c);
    if (d < -eps) plus = Math.min(plus, g / -d);
    else if (d > eps) minus = Math.min(minus, g / d);
  }
  return { plus, minus };
}

// --- (de)serialization for the welcome message ---
export function packSection(s) {
  return {
    id: s.id, seg: s.seg, at: s.at, R: s.R, sep: s.sep, kerfs: s.kerfs,
    state: Array.from(s.state), zmin: Array.from(s.zmin), zmax: Array.from(s.zmax), mask: Array.from(s.mask),
  };
}
export function unpackSection(o) {
  const s = makeSection(o.id, o.seg, o.at, o.R);
  s.sep = o.sep; s.kerfs = o.kerfs;
  s.state.set(o.state); s.zmin.set(o.zmin); s.zmax.set(o.zmax); s.mask.set(o.mask);
  s.intact = intactCount(s);
  return s;
}
