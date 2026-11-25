// Run one test case and produce its record (TESTS.md 6). The same code runs
// headless in a worker and on the main thread for the graphical view.

import { CFG, TEST_DEFAULTS } from '../config.js';
import { Ctx, Breach } from './harness.js';
import { TEST_BY_ID } from './tests.js';

const uuid = () => (globalThis.crypto && crypto.randomUUID ? crypto.randomUUID() : 'r' + Math.random().toString(36).slice(2) + Date.now().toString(36));
export const machine = () => `${navigator.userAgent} | ${navigator.hardwareConcurrency || '?'} cores`;

/**
 * job: {test, params, seed, mode, batch, commit}
 * opts.frame(ctx): awaited after every tick (viewer); opts.onCtx(ctx): a new run world was made.
 * opts.maxSimTime: abort past this many simulated seconds in all (default 4x the test's time + 120 s).
 */
export async function runCase(job, opts = {}) {
  const T = TEST_BY_ID.get(job.test);
  if (!T) throw new Error('no such test ' + job.test);
  const saved = { ...CFG };
  Object.assign(CFG, TEST_DEFAULTS);
  if (job.cfg) Object.assign(CFG, job.cfg);            // the owner's tunings from the viewer's Tune panel; the test's own parameters still win
  const p = { ...(T.fixed || {}), ...job.params };
  for (const [k, d] of Object.entries(T.params)) if (d.cfg && p[k] !== undefined) CFG[d.cfg] = p[k] * d.scale;
  if (T.seed && job.seed !== null && job.seed !== undefined) CFG[T.seed.key] = job.seed;
  const cfg = { ...CFG };
  const ctxs = [], budget = Math.round(((opts.maxSimTime ?? (T.time || 30) * 4 + 120)) / CFG.TICK);
  const env = {
    ctxs,
    async ctx() {
      const c = await Ctx.create({ frame: opts.frame });
      const used = ctxs.reduce((a, x) => a + x.tick, 0);
      c.maxTicks = Math.max(1, budget - used);
      ctxs.push(c); if (opts.onCtx) opts.onCtx(c, p);
      return c;
    },
  };
  const wall0 = performance.now();
  let metrics = null, criteria = [], breach = null, error = null;
  try {
    metrics = await T.run(env, p);
    if (!metrics.skip) criteria = T.judge(metrics, p);
  } catch (e) {
    if (e instanceof Breach) breach = { inv: e.inv, tick: e.tick, detail: String(e.detail).slice(0, 2000) };
    else if (e && e.abort) error = 'aborted';
    else error = String((e && e.stack) || e).slice(0, 2000);
  } finally {
    for (const k of Object.keys(CFG)) CFG[k] = saved[k];
  }
  const failed = criteria.filter((c) => !c.ok).map((c) => c.text);
  const ok = !breach && !error && failed.length === 0;
  let verdict;
  if (breach || error) verdict = 'invalid';
  else if (metrics && metrics.skip) verdict = 'skip';
  else if (job.mode === 'explore' || job.mode === 'sweep') verdict = 'explore';
  else verdict = ok ? 'pass' : 'fail';
  const steps = ctxs.flatMap((c) => c.stepMs), ticks = ctxs.reduce((a, c) => a + c.tick, 0);
  const sorted = Float64Array.from(steps).sort();
  return {
    test: job.test, run: uuid(), batch: job.batch || null, mode: job.mode || 'must', commit: job.commit || 'local', machine: machine(), time: Date.now(),
    params: job.params, seed: job.seed ?? null, tuned: job.cfg || null, cfg, verdict, wouldPass: ok, failed, criteria, metrics, breach, error,
    rips: ctxs.reduce((a, c) => a + c.rips.length, 0), simTime: +(ticks * cfg.TICK).toFixed(3), wallTime: +((performance.now() - wall0) / 1000).toFixed(3), ticks,
    stepMs: { mean: steps.length ? +(steps.reduce((a, x) => a + x, 0) / steps.length).toFixed(4) : 0, p95: sorted.length ? +sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))].toFixed(4) : 0 },
  };
}
