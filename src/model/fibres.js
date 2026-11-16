// Every segment of wood is a BUNDLE of fibres running along it. A bundle is
// the unit of structure: load is shared between its fibres, the saw severs
// them one by one, and what is left decides what happens.
// Pure functions: no physics engine, no rendering. See docs/DESIGN.md 3 and 4.
//
// Bundle coordinates: origin on the stem axis, x along `u`, y along `v`,
// z along the stem axis `a` (base -> tip, metres from the segment's base).
// (u, v, a) is right-handed and comes from bundleBasis(), identically on every
// machine. Fibre i sits at (X[i], Y[i]) * radius.

import { CFG } from '../config.js';

export const INTACT = 0, CUT = 1;

const LAYOUTS = new Map();
/** Fibre positions for a bundle N fibres across, in unit-radius coordinates. */
export function layout(N) {
  let l = LAYOUTS.get(N);
  if (!l) {
    const xs = [], ys = [];
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const x = (i + 0.5) / N * 2 - 1, y = (j + 0.5) / N * 2 - 1;
      if (x * x + y * y <= 1) { xs.push(x); ys.push(y); }
    }
    l = { N, n: xs.length, X: Float32Array.from(xs), Y: Float32Array.from(ys), dA: Math.PI / xs.length, cs: 2 / N };
    LAYOUTS.set(N, l);
  }
  return l;
}
/** How many fibres across for a stem of radius R. Always odd. */
export function gridFor(R) {
  let N = Math.round(2 * R / CFG.FIBRE_PITCH);
  if (N % 2 === 0) N++;
  return Math.max(3, Math.min(CFG.GRID_MAX, N));
}

/** Right-handed basis (u, v) perpendicular to unit axis a. Arrays of 3. */
export function bundleBasis(a) {
  const ref = Math.abs(a[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  let u = [a[1] * ref[2] - a[2] * ref[1], a[2] * ref[0] - a[0] * ref[2], a[0] * ref[1] - a[1] * ref[0]];
  const l = Math.hypot(u[0], u[1], u[2]); u = [u[0] / l, u[1] / l, u[2] / l];
  const v = [a[1] * u[2] - a[2] * u[1], a[2] * u[0] - a[0] * u[2], a[0] * u[1] - a[1] * u[0]];
  return { u, v };
}

export function makeBundle(N) {
  const n = layout(N).n;
  return {
    N, n,
    at: 0,                              // fraction along the segment where this bundle is weakest (the cut plane; 0 = base joint)
    ncut: 0,
    state: new Uint8Array(n),           // INTACT / CUT
    zmin: new Float32Array(n),          // for CUT fibres: axial extent of the wood removed (m from the segment base)
    zmax: new Float32Array(n),
    lo: null, hi: null,                 // per-fibre drawn extent (m) once a split has trimmed them; null = whole segment
    // host-only scratch from analyse():
    act: new Uint8Array(n), c0: 0, s1: 0, s2: 0, maxT: 0, closed: false,
  };
}

export function gapOf(b, i) { return b.zmax[i] - b.zmin[i] + CFG.KERF_WIDTH; }

/** Sever fibres idx[] at axial positions z[] (m from the segment base). */
export function cutFibres(b, idx, z) {
  for (let k = 0; k < idx.length; k++) {
    const i = idx[k];
    if (b.state[i] === INTACT) { b.state[i] = CUT; b.zmin[i] = b.zmax[i] = z[k]; b.ncut++; }
    else { if (z[k] < b.zmin[i]) b.zmin[i] = z[k]; if (z[k] > b.zmax[i]) b.zmax[i] = z[k]; }
  }
}

/**
 * Static load sharing between the fibres of a bundle (host only). This is the
 * exact solution for parallel elastic fibres between two rigid faces -- plane
 * sections stay plane -- so it IS the fibre model in its stiff limit.
 *
 * Loads are those the DISTAL part applies at the bundle centre:
 *   Nax = F . a  (positive = pulling the distal part away = tension)
 *   Mu, Mv = M . u, M . v  (N m)
 * Result: stress(x, y) = b.c0 + b.s1 x + b.s2 y  (Pa, tension positive, x y in
 * metres) for intact fibres; b.maxT / b.minC at the extreme fibre edges.
 * Equilibrium:  sum(s dA) = Nax ;  sum(s y dA) = Mu ;  -sum(s x dA) = Mv.
 *
 * Pass 1: intact fibres alone carry the load (a kerf is an 8 mm gap).
 * Pass 2: only if a fibre is past compressive yield (it crushes, the kerf
 * closes): severed fibres whose kerf is a plain saw cut also carry
 * compression, at relative stiffness KERF_CONTACT, never tension.
 * b.act[i] marks those; they are what clamps a saw bar.
 */
export function analyse(b, R, Nax, Mu, Mv) {
  const L = layout(b.N), n = L.n, X = L.X, Y = L.Y, dA = L.dA * R * R, KC = CFG.KERF_CONTACT;
  const closedGap = CFG.KERF_WIDTH * 1.5, half = L.cs * R / 2;
  const st = b.state, act = b.act;
  let s0 = 0, s1 = 0, s2 = 0, cx = 0, cy = 0, ok = false;
  act.fill(0); b.closed = false;
  for (let it = 0; it < 7; it++) {
    let A = 0, Sx = 0, Sy = 0;
    for (let c = 0; c < n; c++) {
      const w = st[c] === INTACT ? 1 : (act[c] ? KC : 0);
      if (w) { A += w; Sx += w * X[c]; Sy += w * Y[c]; }
    }
    if (A < 1e-9) { ok = false; break; }
    cx = Sx / A * R; cy = Sy / A * R;
    let Ixx = 0, Iyy = 0, Ixy = 0;
    for (let c = 0; c < n; c++) {
      const w = st[c] === INTACT ? 1 : (act[c] ? KC : 0);
      if (!w) continue;
      const dx = X[c] * R - cx, dy = Y[c] * R - cy;
      Ixx += w * dy * dy; Iyy += w * dx * dx; Ixy += w * dx * dy;
    }
    A *= dA; Ixx *= dA; Iyy *= dA; Ixy *= dA;
    const own = A * (2 * half) * (2 * half) / 12;       // each fibre's own second moment
    Ixx += own; Iyy += own;
    const det = Ixx * Iyy - Ixy * Ixy;
    const Mup = Mu - cy * Nax, Mxp = -Mv - cx * Nax;
    s0 = Nax / A; s1 = (Mxp * Ixx - Mup * Ixy) / det; s2 = (Mup * Iyy - Mxp * Ixy) / det;
    ok = true;
    if (it === 0) {
      const edge = (Math.abs(s1) + Math.abs(s2)) * half;
      let minC = 0;
      for (let c = 0; c < n; c++) if (st[c] === INTACT) {
        const lin = s0 + s1 * (X[c] * R - cx) + s2 * (Y[c] * R - cy) - edge;
        if (lin < minC) minC = lin;
      }
      b.minC = minC;
      if (minC > -CFG.COMP || b.ncut === 0) break;
      b.closed = true;
    }
    let changed = false;
    for (let c = 0; c < n; c++) {
      if (st[c] === INTACT) continue;
      const lin = s0 + s1 * (X[c] * R - cx) + s2 * (Y[c] * R - cy);
      const want = gapOf(b, c) <= closedGap && lin < 0 ? 1 : 0;
      if (want !== act[c]) { act[c] = want; changed = true; }
    }
    if (!changed) break;
  }
  if (!ok) { b.c0 = b.s1 = b.s2 = 0; b.maxT = 0; return false; }
  b.c0 = s0 - s1 * cx - s2 * cy; b.s1 = s1; b.s2 = s2;
  const edge = (Math.abs(s1) + Math.abs(s2)) * half;
  let maxT = 0;
  for (let c = 0; c < n; c++) if (st[c] === INTACT) {
    const lin = b.c0 + s1 * X[c] * R + s2 * Y[c] * R + edge;
    if (lin > maxT) maxT = lin;
  }
  b.maxT = maxT;
  return true;
}

// ---- (de)serialization for the welcome message ----
export function packBundle(b) {
  const cut = [];
  for (let i = 0; i < b.n; i++) if (b.state[i] === CUT) cut.push(i, +b.zmin[i].toFixed(4), +b.zmax[i].toFixed(4));
  const r = (a) => (a ? Array.from(a, (v) => +v.toFixed(4)) : 0);
  return { N: b.N, at: b.at, cut, lo: r(b.lo), hi: r(b.hi) };
}
export function unpackBundle(o) {
  const b = makeBundle(o.N);
  b.at = o.at;
  for (let k = 0; k < o.cut.length; k += 3) { const i = o.cut[k]; b.state[i] = CUT; b.zmin[i] = o.cut[k + 1]; b.zmax[i] = o.cut[k + 2]; b.ncut++; }
  if (o.lo) b.lo = Float32Array.from(o.lo);
  if (o.hi) b.hi = Float32Array.from(o.hi);
  return b;
}
