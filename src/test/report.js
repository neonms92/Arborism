// Summaries of test records (TESTS.md 6): per test, the latest batch's pass
// count, worst margin per criterion and the change since the batch before;
// for explore runs, the boundary report (pass rate along each parameter and
// over the two-parameter maps a test names).

const judged = (r) => r.verdict !== 'skip' && r.mode !== 'summary';
const passed = (r) => (r.mode === 'explore' || r.mode === 'sweep' ? r.wouldPass : r.verdict === 'pass');

export function batchesOf(recs, test) {
  const by = new Map();
  for (const r of recs) {
    if (r.test !== test || !r.batch) continue;
    let b = by.get(r.batch); if (!b) by.set(r.batch, b = { batch: r.batch, mode: r.mode, time: r.time, recs: [] });
    b.recs.push(r); b.time = Math.max(b.time, r.time);
  }
  return [...by.values()].sort((a, b) => a.time - b.time);
}

export function summarise(recs, test) {
  const bs = batchesOf(recs, test);
  if (!bs.length) return null;
  const cur = bs[bs.length - 1], s = stats(cur.recs);
  const prev = [...bs].reverse().find((b) => b !== cur && b.mode === cur.mode && stats(b.recs).judged);
  let trend = null;
  if (prev && s.judged) {
    const ps = stats(prev.recs), a = s.pass / s.judged, b = ps.pass / ps.judged;
    trend = a > b + 1e-9 ? 'better' : a < b - 1e-9 ? 'worse' : 'same';
  }
  return { ...s, batch: cur.batch, mode: cur.mode, time: cur.time, trend, recs: cur.recs };
}

export function stats(recs) {
  const out = { total: 0, judged: 0, pass: 0, fail: 0, invalid: 0, skip: 0, worst: {} };
  for (const r of recs) {
    if (r.mode === 'summary') continue;
    out.total++;
    if (r.verdict === 'skip') { out.skip++; continue; }
    out.judged++;
    if (r.verdict === 'invalid') out.invalid++;
    else if (passed(r)) out.pass++; else out.fail++;
    for (const c of r.criteria || []) {
      const w = out.worst[c.text] || (out.worst[c.text] = { fails: 0, margin: null, n: 0 });
      w.n++; if (!c.ok) w.fails++;
      if (c.margin !== null && c.margin !== undefined && (w.margin === null || c.margin < w.margin)) w.margin = c.margin;
    }
  }
  return out;
}

/** Pass rate in `bins` bins along every parameter, and over each map pair. */
export function boundary(test, recs, bins = 10, mapBins = 8) {
  const rs = recs.filter((r) => judged(r) && r.params);
  const per = {};
  for (const [k, d] of Object.entries(test.params)) {
    const [lo, hi] = d.explore, cells = Array.from({ length: bins }, () => [0, 0]);
    for (const r of rs) { const v = r.params[k]; if (!Number.isFinite(v)) continue; const b = Math.min(bins - 1, Math.max(0, Math.floor((v - lo) / (hi - lo) * bins))); cells[b][1]++; if (passed(r) && r.verdict !== 'invalid') cells[b][0]++; }
    per[k] = { lo, hi, cells };
  }
  const maps = (test.maps || []).map(([a, b]) => {
    const A = test.params[a].explore, B = test.params[b].explore, g = Array.from({ length: mapBins * mapBins }, () => [0, 0]);
    for (const r of rs) {
      const x = Math.floor((r.params[a] - A[0]) / (A[1] - A[0]) * mapBins), y = Math.floor((r.params[b] - B[0]) / (B[1] - B[0]) * mapBins);
      if (!(x >= 0 && x < mapBins && y >= 0 && y < mapBins)) continue;
      const c = g[y * mapBins + x]; c[1]++; if (passed(r) && r.verdict !== 'invalid') c[0]++;
    }
    return { a, b, A, B, n: mapBins, cells: g };
  });
  return { per, maps, n: rs.length };
}
