// Which parameter points a test runs at (TESTS.md 1.1).
// must:    every corner of the must-pass box (at most 64, a seeded random subset),
//          the centre, and `interior` Latin-hypercube points; x every must seed.
// explore: N Latin-hypercube points over the explore box, one seed each.
// smoke:   the centre (defaults where they sit inside the box) and the first seed only.
// grid:    tests marked grid run the full product of their listed values.

export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const hashStr = (s) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };

const isList = (r) => r && !Array.isArray(r) && Array.isArray(r.list);
const lo = (r) => (isList(r) ? Math.min(...r.list) : r[0]);
const hi = (r) => (isList(r) ? Math.max(...r.list) : r[1]);
/** Value at fraction u (0..1) of a range: lists pick an element. */
const at = (r, u) => (isList(r) ? r.list[Math.min(r.list.length - 1, Math.floor(u * r.list.length))] : r[0] + (r[1] - r[0]) * u);
const mid = (r) => (isList(r) ? r.list[(r.list.length - 1) >> 1] : (r[0] + r[1]) / 2);

function lhs(ranges, n, R) {
  const keys = Object.keys(ranges), cols = {};
  for (const k of keys) {
    const perm = Array.from({ length: n }, (_, i) => i);
    for (let i = n - 1; i > 0; i--) { const j = Math.floor(R() * (i + 1)); [perm[i], perm[j]] = [perm[j], perm[i]]; }
    cols[k] = perm.map((s) => at(ranges[k], (s + R()) / n));
  }
  return Array.from({ length: n }, (_, i) => Object.fromEntries(keys.map((k) => [k, cols[k][i]])));
}

/** [{params, seed}] for a test in a mode. opts.n overrides the explore count. */
export function cases(test, mode, opts = {}) {
  const ranges = {}, R = rng(hashStr(test.id + mode) ^ (opts.salt || 0));
  for (const [k, p] of Object.entries(test.params)) ranges[k] = mode === 'explore' ? p.explore : p.must;
  const keys = Object.keys(ranges);
  let pts = [];
  if (!keys.length) pts = [{}];
  else if (mode === 'smoke') pts = [Object.fromEntries(keys.map((k) => { const p = test.params[k], r = ranges[k]; return [k, p.def >= lo(r) && p.def <= hi(r) ? p.def : mid(r)]; }))];
  else if (mode === 'explore') pts = lhs(ranges, opts.n || test.exploreN || 200, R);
  else if (test.grid) {
    pts = [{}];
    for (const k of keys) { const vals = isList(ranges[k]) ? ranges[k].list : [lo(ranges[k]), hi(ranges[k])]; pts = pts.flatMap((p) => vals.map((v) => ({ ...p, [k]: v }))); }
  } else {
    const nc = 2 ** keys.length, corners = [];
    const corner = (bits) => Object.fromEntries(keys.map((k, i) => [k, (bits >> i) & 1 ? hi(ranges[k]) : lo(ranges[k])]));
    if (nc <= 64) for (let b = 0; b < nc; b++) corners.push(corner(b));
    else { const seen = new Set(); while (corners.length < 64) { let b = 0; for (let i = 0; i < keys.length; i++) if (R() < 0.5) b |= 1 << i; if (!seen.has(b)) { seen.add(b); corners.push(corner(b)); } } }
    pts = [...corners, Object.fromEntries(keys.map((k) => [k, mid(ranges[k])])), ...lhs(ranges, test.interior || 16, R)];
  }
  if (test.fix) pts = pts.map((p) => test.fix({ ...p }, mode === 'smoke' ? 'must' : mode === 'explore' ? 'explore' : 'must'));
  const sd = test.seed;
  let seeds = [null];
  if (sd) seeds = mode === 'must' ? sd.must : mode === 'smoke' ? [sd.must[0]] : null;
  const out = [];
  for (const p of pts) {
    if (seeds) for (const s of seeds) out.push({ params: p, seed: s });
    else out.push({ params: p, seed: Math.round(sd.explore[0] + R() * (sd.explore[1] - sd.explore[0])) });
  }
  return out;
}

/** The default point of a test (every parameter at its default). */
export function defaults(test) {
  const p = Object.fromEntries(Object.entries(test.params).map(([k, d]) => [k, d.def]));
  return test.fix ? test.fix(p, 'explore') : p;
}

/**
 * Axis sweep (TESTS.md 1.1): one parameter at a time from its default to each
 * end of its explore range, others at default, bisecting to locate the first
 * failure to within 5 % of the range. runAt(params) -> Promise<bool passed>.
 * Returns {param: {lo, hi}} = the passing interval found around the default.
 */
export async function sweep(test, runAt, onlyKeys) {
  const base = defaults(test), seed = test.seed ? test.seed.must[0] : null, out = {};
  await Promise.all(Object.entries(test.params).filter(([k]) => !onlyKeys || onlyKeys.includes(k)).map(async ([k, d]) => {
    const r = d.explore, span = r[1] - r[0], res = {};
    for (const [end, name] of [[r[0], 'lo'], [r[1], 'hi']]) {
      const p = (v) => { const q = { ...base, [k]: v }; return test.fix ? test.fix(q, 'explore') : q; };
      if (await runAt(p(end), seed, k)) { res[name] = end; continue; }
      let good = d.def, bad = end;
      if (!(await runAt(p(good), seed, k))) { res[name] = null; continue; }      // fails at its own default
      while (Math.abs(bad - good) > 0.05 * span) { const m = (good + bad) / 2; if (await runAt(p(m), seed, k)) good = m; else bad = m; }
      res[name] = good;
    }
    out[k] = res;
  }));
  return out;
}
