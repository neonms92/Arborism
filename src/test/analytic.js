// Textbook answers the fibre model is checked against (TESTS.md FM-01, 02, 04).
// Continuous sections integrated finely, independent of the fibre grid.

/**
 * A solid circle of radius R whose material has stiffness Et in tension and
 * Ec in compression, bent so the tension side is +y. Returns the neutral-axis
 * offset c (towards +y) and the bending stiffness EI about it.
 */
export function bimodularCircle(R, Et, Ec, n = 400) {
  const strips = [];
  for (let k = 0; k < n; k++) {
    const y = -R + (k + 0.5) * 2 * R / n, w = 2 * Math.sqrt(Math.max(0, R * R - y * y));
    strips.push([y, w * 2 * R / n]);
  }
  const axial = (c) => { let s = 0; for (const [y, a] of strips) s += (y > c ? Et : Ec) * (y - c) * a; return s; };
  let lo = -R, hi = R;
  for (let it = 0; it < 60; it++) { const m = (lo + hi) / 2; if (axial(m) > 0) lo = m; else hi = m; }
  const c = (lo + hi) / 2;
  let EI = 0; for (const [y, a] of strips) EI += (y > c ? Et : Ec) * (y - c) * (y - c) * a;
  return { c, EI };
}

/**
 * Horizontal tapered cantilever under self-weight (+ tip load P), root at
 * x = 0 on a vertical stub. Stiffness E, or bimodular {Et, Ec}. Returns tip
 * sag (m, down positive), root moment (N·m), and the stub's share of the sag.
 */
export function cantilever({ L, D, taper = 0.4, rho, g, E, Et, Ec, P = 0, stubL = 0, stubD = 0, n = 600 }) {
  const r = (x) => D / 2 * (1 - (1 - taper) * x / L);
  const EIof = (R) => (E ? E * Math.PI * R ** 4 / 4 : bimodularCircle(R, Et, Ec, 120).EI);
  const dx = L / n, w = [], xs = [];
  for (let k = 0; k <= n; k++) { xs.push(k * dx); w.push(rho * g * Math.PI * r(k * dx) ** 2); }
  // bending moment at each station from everything beyond it
  const M = new Float64Array(n + 1);
  for (let k = 0; k <= n; k++) {
    let m = P * (L - xs[k]);
    for (let q = k; q < n; q++) { const xm = (xs[q] + xs[q + 1]) / 2; m += (w[q] + w[q + 1]) / 2 * dx * (xm - xs[k]); }
    M[k] = m;
  }
  let th = 0, y = 0;
  const EIs = []; for (let k = 0; k <= n; k++) EIs.push(EIof(r(xs[k])));
  for (let k = 0; k < n; k++) {
    const k0 = M[k] / EIs[k], k1 = M[k + 1] / EIs[k + 1];
    const th1 = th + (k0 + k1) / 2 * dx;
    y += (th + th1) / 2 * dx; th = th1;
  }
  const stubTheta = stubL ? M[0] * stubL / EIof(stubD / 2) : 0;
  return { sag: y + stubTheta * L, stubSag: stubTheta * L, Mroot: M[0], Mself: M[0] - P * L };
}

/** Moment that brings the tension edge of a bimodular circle to stress S. */
export function yieldMoment(R, Et, Ec, S) {
  const { c, EI } = bimodularCircle(R, Et, Ec);
  return S * EI / (Et * (R - c));
}
/** Symmetric-section edge stress M c / I for a solid circle. */
export function edgeStress(M, R) { return M * R / (Math.PI * R ** 4 / 4); }
