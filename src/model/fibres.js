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
    act: new Uint8Array(n), sgn: null, e0: 0, e1: 0, e2: 0, maxT: 0, minC: 0, closed: false,
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
 * Static load sharing between the fibres of a bundle (host only).
 *
 * Every fibre changes length in proportion to the force on it: it stretches
 * by TENS_STRAIN of its length at MOR, and shortens by COMP_STRAIN of its
 * length at COMP. The two faces the fibres run between stay flat, so the
 * fibres' strains lie on a plane:
 *
 *     strain(x, y) = b.e0 + b.e1 x + b.e2 y        (x, y in metres, + = stretched)
 *
 * and that plane is found from equilibrium with the load the DISTAL wood
 * applies at the bundle centre:
 *   Nax = F . a  (positive = pulling the distal part away),  Mu, Mv = M . u, M . v
 *   sum(E eps dA) = Nax ;  sum(E eps y dA) = Mu ;  -sum(E eps x dA) = Mv
 * where E is each fibre's own stiffness: MOR/TENS_STRAIN if it is stretched,
 * COMP/COMP_STRAIN if it is squeezed (found by iteration, since which is which
 * depends on the answer). Severed fibres carry nothing and have no say in the
 * plane -- unless the wood beside the kerf is being crushed, in which case the
 * kerf has closed and its faces carry compression too (b.act marks those;
 * they are what clamps a saw bar).
 *
 * b.maxT / b.minC: worst tension / compression stress at a fibre's edge (Pa).
 * The plane is also the bend: see model/flex.js.
 */
export function analyse(b, R, Nax, Mu, Mv) {
  const L = layout(b.N), n = L.n, X = L.X, Y = L.Y, dA = L.dA * R * R;
  const Et = CFG.MOR / CFG.TENS_STRAIN, Ec = CFG.COMP / CFG.COMP_STRAIN, Ek = CFG.KERF_CONTACT * Ec;
  const closedGap = CFG.KERF_WIDTH * 1.5, half = L.cs * R / 2;
  const st = b.state, act = b.act;
  if (!b.sgn) b.sgn = new Int8Array(n);
  const sgn = b.sgn;
  let e0 = 0, e1 = 0, e2 = 0, cx = 0, cy = 0, ok = false;
  act.fill(0); b.closed = false;
  for (let it = 0; it < 12; it++) {
    let A = 0, Sx = 0, Sy = 0;
    for (let c = 0; c < n; c++) {
      const w = st[c] === INTACT ? (sgn[c] < 0 ? Ec : Et) : (act[c] ? Ek : 0);
      if (w) { A += w; Sx += w * X[c]; Sy += w * Y[c]; }
    }
    if (A < 1e-9) { ok = false; break; }
    cx = Sx / A * R; cy = Sy / A * R;
    let Ixx = 0, Iyy = 0, Ixy = 0;
    for (let c = 0; c < n; c++) {
      const w = st[c] === INTACT ? (sgn[c] < 0 ? Ec : Et) : (act[c] ? Ek : 0);
      if (!w) continue;
      const dx = X[c] * R - cx, dy = Y[c] * R - cy;
      Ixx += w * dy * dy; Iyy += w * dx * dx; Ixy += w * dx * dy;
    }
    A *= dA; Ixx *= dA; Iyy *= dA; Ixy *= dA;
    const own = A * (2 * half) * (2 * half) / 12;       // each fibre's own width
    Ixx += own; Iyy += own;
    const det = Ixx * Iyy - Ixy * Ixy;
    const Mup = Mu - cy * Nax, Mxp = -Mv - cx * Nax;
    e1 = (Mxp * Ixx - Mup * Ixy) / det; e2 = (Mup * Iyy - Mxp * Ixy) / det;
    e0 = Nax / A - e1 * cx - e2 * cy;
    ok = true;
    // which fibres are stretched and which squeezed? (their stiffness depends on it)
    let changed = false, minE = 0;
    const edge = (Math.abs(e1) + Math.abs(e2)) * half;
    for (let c = 0; c < n; c++) {
      const eps = e0 + e1 * X[c] * R + e2 * Y[c] * R;
      if (st[c] === INTACT) {
        const sg = eps < 0 ? -1 : 1;
        if (sg !== sgn[c]) { sgn[c] = sg; changed = true; }
        if (eps - edge < minE) minE = eps - edge;
      } else if (b.closed) {
        const want = gapOf(b, c) <= closedGap && eps < 0 ? 1 : 0;
        if (want !== act[c]) { act[c] = want; changed = true; }
      }
    }
    if (!b.closed && b.ncut > 0 && minE < -CFG.COMP_STRAIN) { b.closed = true; changed = true; }
    if (!changed) break;
  }
  if (!ok) { b.e0 = b.e1 = b.e2 = 0; b.maxT = b.minC = 0; return false; }
  b.e0 = e0; b.e1 = e1; b.e2 = e2;
  const edge = (Math.abs(e1) + Math.abs(e2)) * half;
  let hi = 0, lo = 0;
  for (let c = 0; c < n; c++) if (st[c] === INTACT) {
    const eps = e0 + e1 * X[c] * R + e2 * Y[c] * R;
    if (eps + edge > hi) hi = eps + edge;
    if (eps - edge < lo) lo = eps - edge;
  }
  b.maxT = hi * Et; b.minC = lo * Ec;
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
