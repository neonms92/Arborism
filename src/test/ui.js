// The Testing menu (main menu -> Testing): pick tests, run them in parallel
// workers, see results tracked across runs, open any one run graphically.
// Headless: ?test=FM-10,FM-40 (or all) &mode=smoke|must|explore|sweep &n=N
// &workers=N &commit=SHA runs at load and prints one `ARBTEST {json}` line per
// record and `ARBTEST-DONE {json}` at the end; window.arbTests has the same.
// See docs/TESTS.md section 7.

import { TESTS, TEST_BY_ID } from './tests.js';
import { cases, sweep } from './sampling.js';
import { Pool } from './pool.js';
import * as store from './store.js';
import { summarise, boundary } from './report.js';
import { runCase } from './runcase.js';
import { segMass, segCentroidT, lerp3 } from '../model/world.js';
import { ROWS } from '../view/menu.js';
import { CFG, CFG_DEFAULTS } from '../config.js';
import { sawStep } from '../sim/saw.js';

// Tunings made in the viewer's Tune panel: CFG values that every run started from this menu uses (viewer
// replays and batches), unless the test sets that key itself. Kept in this browser.
const TUNE_KEY = 'arb-test-tune-v1';
export function loadTune() { try { return JSON.parse(localStorage.getItem(TUNE_KEY) || '{}') || {}; } catch { return {}; } }
function saveTune(t) { try { if (Object.keys(t).length) localStorage.setItem(TUNE_KEY, JSON.stringify(t)); else localStorage.removeItem(TUNE_KEY); } catch { /* private window */ } }
const tuned = () => { const t = loadTune(); return Object.keys(t).length ? t : undefined; };
import { frameApply } from '../model/flex.js';

/**
 * Centres of gravity for the viewer's plumb lines: every loose piece's (from its body), and for standing wood
 * the centre of gravity of everything the lowest cut on each stem holds up, with that cut's centre (the hinge).
 */
export function gravityCentres(sim) {
  const w = sim.world, flex = sim.structure.flex, out = [];
  for (const [id, body] of sim.bodies) {
    if (body.isFixed()) continue;
    const c = body.worldCom(); out.push({ c: [c.x, c.y, c.z], m: body.mass(), piece: id });
  }
  const cutRooted = (s) => s && s.f.ncut > 0 && s.f.ncut < s.f.n && sim.bodies.get(s.piece)?.isFixed();
  for (const s of w.segs.values()) {
    if (!cutRooted(s)) continue;
    let up = s.parent >= 0 ? w.segs.get(s.parent) : null, lower = false;
    for (; up; up = up.parent >= 0 ? w.segs.get(up.parent) : null) if (up.piece === s.piece && cutRooted(up)) { lower = true; break; }
    if (lower) continue;
    const f = s.f, acc = [0, 0, 0]; let m = 0;
    const add = (p, mm) => { acc[0] += p[0] * mm; acc[1] += p[1] * mm; acc[2] += p[2] * mm; m += mm; };
    const tc = segCentroidT(s, f.at, 1);
    add(frameApply(flex.at(s.id, tc), lerp3(s.a, s.b, tc)), segMass(s, f.at, 1));
    if (s.leaf) add(frameApply(flex.at(s.id, 1), s.b), s.leaf);
    const stack = [...w.kids(s.id)];
    while (stack.length) {
      const k = w.segs.get(stack.pop()); if (!k || k.piece !== s.piece) continue;
      const t = segCentroidT(k);
      add(frameApply(flex.at(k.id, t), lerp3(k.a, k.b, t)), segMass(k));
      if (k.leaf) add(frameApply(flex.at(k.id, 1), k.b), k.leaf);
      stack.push(...w.kids(k.id));
    }
    if (m > 0) out.push({ c: acc.map((x) => x / m), m, hinge: frameApply(flex.at(s.id, f.at), lerp3(s.a, s.b, f.at)), seg: s.id });
  }
  return out;
}

const CSS = `
#testing { position: fixed; inset: 0; overflow-y: auto; background: #141b12; color: #eee; font: 13.5px/1.4 system-ui, sans-serif; padding: 14px 18px 60px; box-sizing: border-box; z-index: 20; }
#testing h2 { margin: 0 0 2px; } #testing h3 { color: #e8a23a; margin: 18px 0 6px; font-size: 14px; }
#testing .muted { opacity: .65; } #testing .bar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin: 10px 0; }
#testing button, #testing select, #testing input { font: inherit; padding: 6px 10px; border-radius: 6px; border: 0; }
#testing button { background: #34452f; color: #fff; cursor: pointer; } #testing button.go { background: #e8a23a; color: #201400; font-weight: 700; }
#testing table { border-collapse: collapse; width: 100%; } #testing td, #testing th { padding: 4px 6px; border-bottom: 1px solid #2a3527; text-align: left; vertical-align: top; }
#testing tr.sel { background: #22301f; } #testing tr.t:hover { background: #1d281a; cursor: pointer; }
#testing .pass { color: #7fdc6f; } #testing .fail { color: #ff8a6a; } #testing .invalid { color: #ff5ab4; } #testing .skip, #testing .explore { color: #9fb7d8; }
#testing .cells { display: inline-grid; gap: 1px; vertical-align: middle; } #testing .cells span { width: 14px; height: 14px; display: block; }
#testing .prog { height: 6px; background: #2a3527; border-radius: 3px; overflow: hidden; width: 260px; } #testing .prog div { height: 100%; background: #e8a23a; width: 0; }
#testing code { font-size: 12px; opacity: .85; }
#testing td b { white-space: nowrap; }
#tview { position: fixed; inset: 0; z-index: 30; background: #000; color: #fff; font: 14px/1.35 system-ui, sans-serif; -webkit-user-select: none; user-select: none; }
#tview canvas { position: absolute; inset: 0; width: 100%; height: 100%; touch-action: none; }
#tview .top, #tview .bot { position: absolute; left: 0; right: 0; display: flex; gap: 8px; align-items: center; padding: 8px max(8px, env(safe-area-inset-right)) 8px max(8px, env(safe-area-inset-left)); pointer-events: none; }
#tview .top { top: 0; padding-top: max(8px, env(safe-area-inset-top)); } #tview .bot { bottom: 0; justify-content: center; padding-bottom: max(10px, env(safe-area-inset-bottom)); }
#tview button { pointer-events: auto; font: inherit; font-weight: 600; min-width: 48px; min-height: 44px; padding: 0 14px; border-radius: 22px; border: 0; background: rgba(20,27,18,.82); color: #fff; cursor: pointer; touch-action: manipulation; }
#tview button.on { background: #e8a23a; color: #201400; }
#tview .title { flex: 1; min-width: 0; background: rgba(0,0,0,.5); border-radius: 10px; padding: 4px 10px; font-size: 13px; }
#tview .title b { display: block; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
#tview .badge { display: inline-block; padding: 0 7px; border-radius: 8px; font-weight: 700; margin-right: 6px; }
#tview .badge.pass { background: #3d8a32; } #tview .badge.fail { background: #b8442b; } #tview .badge.invalid { background: #b02a7a; } #tview .badge.run { background: #555; } #tview .badge.skip, #tview .badge.explore { background: #4c6a91; }
#tview .params { position: absolute; left: 8px; right: 8px; bottom: calc(max(10px, env(safe-area-inset-bottom)) + 56px); max-width: 520px; margin: 0 auto; max-height: 45%; overflow-y: auto; background: rgba(0,0,0,.72); border-radius: 10px; padding: 8px 12px; font-size: 13px; }
#tview .params .row { display: grid; grid-template-columns: minmax(110px, 40%) 1fr; gap: 10px; align-items: center; min-height: 36px; }
#tview .params .lab { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
#tview .tune .trow { grid-template-columns: 1fr 64px; grid-template-areas: 'lab nb' 'sl sl'; row-gap: 2px; padding: 4px 0; border-top: 1px solid rgba(255,255,255,.08); }
#tview .tune .trow .lab { grid-area: lab; white-space: normal; } #tview .tune .trow input[type=range] { grid-area: sl; background: #555; }
#tview .tune .trow input[type=number] { grid-area: nb; width: 64px; font: inherit; padding: 4px; border-radius: 6px; border: 0; background: #2a3427; color: #fff; }
#tview .tune .lab.changed { color: #ffd166; font-weight: 600; } #tview .tune .grp { margin-top: 10px; font-weight: 700; color: #cfe3c4; }
#tview .tune { max-height: 55%; }
@media (max-width: 560px) { #tview .bot { gap: 4px; } #tview .bot button { padding: 0 9px; min-width: 0; font-size: 14px; } } #tview button.small { min-height: 30px; min-width: 0; padding: 0 10px; font-size: 12px; }
#tview .params input[type=range] { -webkit-appearance: none; appearance: none; width: 100%; height: 12px; border-radius: 6px; outline: none; touch-action: pan-x; }
#tview .params input[type=range]::-webkit-slider-thumb { -webkit-appearance: none; width: 26px; height: 26px; border-radius: 50%; background: #fff; border: 2px solid #222; }
#tview .params input[type=range]::-moz-range-thumb { width: 24px; height: 24px; border-radius: 50%; background: #fff; border: 2px solid #222; }
#tview .params .cross { margin-top: 6px; font-size: 12px; color: #ccc; } #tview .params .ok { color: #8fd17f; } #tview .params .no { color: #f08f7a; }
#tview .hud { pointer-events: none; position: absolute; left: 8px; right: 8px; top: calc(max(8px, env(safe-area-inset-top)) + 60px); max-width: 520px; max-height: calc(100% - 150px); overflow: hidden; background: rgba(0,0,0,.6); padding: 8px 10px; border-radius: 8px; font: 12px/1.4 ui-monospace, monospace; white-space: pre-wrap; }
`;

const el = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) if (k === 'class') e.className = v; else if (k.startsWith('on')) e[k] = v; else if (v !== undefined && v !== null) e.setAttribute(k, v);
  for (const k of kids.flat()) if (k !== null && k !== undefined && k !== false) e.append(k.nodeType ? k : String(k));
  return e;
};
const fmt = (v) => (typeof v === 'number' ? (Math.abs(v) >= 1000 || (Math.abs(v) < 0.01 && v !== 0) ? v.toExponential(2) : +v.toFixed(3)) : v);
const paramText = (p) => Object.entries(p || {}).map(([k, v]) => `${k}=${fmt(v)}`).join(' ');
const commitOf = () => new URLSearchParams(location.search).get('commit') || 'local';

class Testing {
  constructor() {
    if (!document.getElementById('test-css')) document.head.append(el('style', { id: 'test-css' }, CSS));
    this.root = el('div', { id: 'testing' });
    document.body.append(this.root);
    this.recs = [];
    this.selected = new Set(TESTS.filter((t) => t.id !== 'FM-20').map((t) => t.id));
    this.focus = null;
    this.mode = 'smoke';
    this.n = 0;
    this.pool = null;
    this.progress = { done: 0, total: 0, running: false };
    this.build();
    this.load();
  }

  async load() { this.recs = await store.all(); this.render(); }

  build() {
    const r = this.root; r.textContent = '';
    const mode = el('select', { onchange: (e) => { this.mode = e.target.value; } },
      el('option', { value: 'smoke' }, 'Smoke: default point, one seed'),
      el('option', { value: 'must' }, 'Must-pass box (regression check)'),
      el('option', { value: 'explore' }, 'Explore (map where it breaks)'),
      el('option', { value: 'sweep' }, 'Axis sweep (one parameter at a time)'));
    mode.value = this.mode;
    const n = el('input', { type: 'number', min: 1, step: 1, placeholder: 'explore N', style: 'width: 90px', onchange: (e) => { this.n = +e.target.value || 0; } });
    const file = el('input', { type: 'file', accept: '.json,application/json', style: 'display:none', onchange: async (e) => { if (e.target.files[0]) { await store.importJSON(e.target.files[0]); this.load(); } } });
    this.status = el('span', { class: 'muted' });
    this.bar = el('div', { class: 'prog' }, el('div'));
    this.list = el('div'); this.detail = el('div');
    r.append(
      el('div', { class: 'bar', style: 'justify-content: space-between' },
        el('div', {}, el('h2', {}, 'Engine tests'), el('div', { class: 'muted' }, 'Fibre mechanics tests from docs/TESTS.md. Each run is a separate worker with its own copy of the settings; results are kept in this browser.')),
        el('button', { onclick: () => this.close() }, 'Back to the main menu')),
      el('div', { class: 'bar' }, mode, n,
        el('button', { class: 'go', onclick: () => this.runSelected() }, 'Run selected'),
        el('button', { onclick: () => this.stop() }, 'Stop'),
        el('button', { onclick: () => { for (const t of TESTS) this.selected.add(t.id); this.render(); } }, 'Select all'),
        el('button', { onclick: () => { this.selected.clear(); this.render(); } }, 'Select none'),
        el('button', { onclick: () => store.exportJSON() }, 'Export results'),
        el('button', { onclick: () => file.click() }, 'Import results'), file,
        el('button', { onclick: async (e) => {        // two clicks, so a stray one does not wipe the history
          const b = e.target;
          if (!b.dataset.armed) { b.dataset.armed = '1'; b.textContent = 'Click again to clear all results'; setTimeout(() => { delete b.dataset.armed; b.textContent = 'Clear results'; }, 3000); return; }
          await store.clear(); this.load();
        } }, 'Clear results')),
      el('div', { class: 'bar' }, this.bar, this.status),
      this.list, this.detail);
  }

  render() {
    const rows = TESTS.map((t) => {
      const s = summarise(this.recs, t.id);
      const cb = el('input', { type: 'checkbox', onclick: (e) => e.stopPropagation(), onchange: (e) => { if (e.target.checked) this.selected.add(t.id); else this.selected.delete(t.id); } });
      cb.checked = this.selected.has(t.id);
      const res = s ? el('span', {}, el('span', { class: s.fail || s.invalid ? 'fail' : 'pass' }, `${s.pass} / ${s.judged} pass`),
        s.invalid ? el('span', { class: 'invalid' }, ` · ${s.invalid} invalid`) : '', s.skip ? el('span', { class: 'skip' }, ` · ${s.skip} skipped`) : '',
        el('span', { class: 'muted' }, ` · ${s.mode}${s.trend ? ' · ' + s.trend + ' than before' : ''}`)) : el('span', { class: 'muted' }, 'not run');
      return el('tr', { class: 't' + (this.focus === t.id ? ' sel' : ''), onclick: () => { this.focus = t.id; this.render(); if (innerWidth < 800) this.detail.scrollIntoView({ behavior: 'smooth' }); } },
        el('td', {}, cb), el('td', {}, el('b', {}, t.id)), el('td', {}, t.title, t.dependsOn ? el('span', { class: 'muted' }, ` (needs ${t.dependsOn.join(', ')})`) : ''), el('td', {}, res));
    });
    this.list.replaceChildren(el('table', {}, el('tr', {}, el('th', {}, ''), el('th', {}, 'Test'), el('th', {}, ''), el('th', {}, 'Latest batch')), rows));
    this.renderDetail();
    this.renderStatus();
  }

  renderStatus() {
    const p = this.progress, pool = this.pool;
    this.bar.firstChild.style.width = p.total ? `${100 * p.done / p.total}%` : '0';
    this.status.textContent = (p.running ? `Running: ${p.done} / ${p.total || '?'} runs` : p.total ? `Done: ${p.done} runs` : 'Idle') +
      (pool ? ` · ${pool.busy} of ${pool.workers.length} workers busy (target ${pool.target}) · ${pool.rate.toFixed(1)} sim-s per s · frame ${pool.frameMs.toFixed(0)} ms` : '');
  }

  renderDetail() {
    const t = this.focus && TEST_BY_ID.get(this.focus);
    if (!t) { this.detail.replaceChildren(el('p', { class: 'muted' }, 'Pick a test to see its results.')); return; }
    const s = summarise(this.recs, t.id), kids = [el('h3', {}, `${t.id} ${t.title}`)];
    if (t.dependsOn) {
      // a test that relies on another one to check part of the story (FM-19 needs FM-10's ordinary fell not to split)
      kids.push(el('div', {}, 'Depends on: ', ...t.dependsOn.map((id) => {
        const d = summarise(this.recs, id);
        return el('span', {}, el('b', {}, id + ' '), d ? el('span', { class: d.fail || d.invalid ? 'fail' : 'pass' }, `${d.pass} / ${d.judged} pass `) : el('span', { class: 'muted' }, 'not run '));
      })));
    }
    kids.push(el('div', { class: 'muted' }, 'Parameters: ', Object.entries(t.params).map(([k, d]) => `${k} ${fmtRange(d.must)} (explore ${fmtRange(d.explore)}) ${d.unit || ''}`).join(' · ') || 'none'));
    kids.push(el('div', { class: 'bar' }, el('button', { class: 'go', onclick: () => this.viewDefault(t.id) }, 'View the default point')));
    if (!s) { this.detail.replaceChildren(...kids); return; }
    kids.push(el('h3', {}, `Latest batch (${s.mode}, ${new Date(s.time).toLocaleString()})`));
    kids.push(el('table', {}, el('tr', {}, el('th', {}, 'Criterion'), el('th', {}, 'Failed'), el('th', {}, 'Worst margin')),
      Object.entries(s.worst).map(([k, w]) => el('tr', {}, el('td', {}, k), el('td', { class: w.fails ? 'fail' : 'pass' }, `${w.fails} / ${w.n}`), el('td', {}, w.margin === null ? '' : `${(w.margin * 100).toFixed(1)} %`)))));
    if (s.mode === 'explore') kids.push(this.boundaryView(t, s.recs));
    const sweepRec = this.recs.filter((r) => r.test === t.id && r.mode === 'summary').sort((a, b) => b.time - a.time)[0];
    if (sweepRec) kids.push(el('h3', {}, 'Axis sweep: passing interval around the default'), el('table', {}, Object.entries(sweepRec.metrics.boundary).map(([k, v]) => el('tr', {}, el('td', {}, k), el('td', {}, `${fmt(v.lo)} … ${fmt(v.hi)}`), el('td', { class: 'muted' }, `explore ${fmtRange(t.params[k].explore)}`)))));
    const runs = [...s.recs].filter((r) => r.mode !== 'summary').sort((a, b) => rank(a) - rank(b)).slice(0, 300);
    kids.push(el('h3', {}, `Runs (${s.recs.length}${s.recs.length > 300 ? ', first 300 shown, failures first' : ''})`));
    kids.push(el('table', {}, el('tr', {}, el('th', {}, 'Verdict'), el('th', {}, 'Parameters'), el('th', {}, 'Failed / why'), el('th', {}, 'Sim / wall s'), el('th', {}, '')),
      runs.map((r) => el('tr', {},
        el('td', { class: r.verdict }, r.verdict === 'explore' ? (r.wouldPass ? 'explore ✓' : 'explore ✗') : r.verdict),
        el('td', {}, el('code', {}, paramText(r.params) + (r.seed !== null ? ` seed=${r.seed}` : ''))),
        el('td', {}, r.breach ? `${r.breach.inv}: ${r.breach.detail.split('\n')[0]}` : r.error ? r.error.split('\n')[0] : r.metrics && r.metrics.skip ? r.metrics.skip : r.failed.join('; ')),
        el('td', {}, `${r.simTime} / ${r.wallTime}`),
        el('td', {}, el('button', { onclick: () => this.view(r) }, 'View'), ' ', el('button', { title: 'Print the full record to the browser console', onclick: () => console.log(r) }, 'Log'))))));
    this.detail.replaceChildren(...kids);
  }

  boundaryView(t, recs) {
    const b = boundary(t, recs), box = el('div');
    const color = ([p, n]) => (n ? `hsl(${120 * p / n}, 60%, ${30 + 15 * Math.min(1, n / 4)}%)` : '#222');
    box.append(el('h3', {}, `Boundary report (${b.n} explore runs): pass rate along each parameter`));
    box.append(el('table', { style: 'width: auto' }, Object.entries(b.per).map(([k, v]) => el('tr', {}, el('td', {}, k), el('td', {}, fmt(v.lo)),
      el('td', {}, el('span', { class: 'cells', style: `grid-template-columns: repeat(${v.cells.length}, 14px)` }, v.cells.map((c) => el('span', { style: `background:${color(c)}`, title: `${c[0]} / ${c[1]} pass` })))),
      el('td', {}, fmt(v.hi))))));
    for (const m of b.maps) {
      box.append(el('h3', {}, `${m.b} (up) × ${m.a} (across)`));
      const rows = [];
      for (let y = m.n - 1; y >= 0; y--) rows.push(...m.cells.slice(y * m.n, (y + 1) * m.n));
      box.append(el('div', {}, el('span', { class: 'muted' }, `${fmt(m.B[1])} `), el('br'),
        el('span', { class: 'cells', style: `grid-template-columns: repeat(${m.n}, 14px)` }, rows.map((c) => el('span', { style: `background:${color(c)}`, title: `${c[0]} / ${c[1]} pass` }))),
        el('div', { class: 'muted' }, `${m.a}: ${fmt(m.A[0])} … ${fmt(m.A[1])}; ${m.b} from ${fmt(m.B[0])}`)));
    }
    return box;
  }

  // ---------- running ----------
  async runSelected() { return this.runTests([...this.selected], this.mode, { n: this.n }); }

  async runTests(ids, mode, opts = {}) {
    if (this.progress.running) return null;
    // a test's dependencies run with it, so its result can be read together with theirs
    for (let i = 0; i < ids.length; i++) for (const d of TEST_BY_ID.get(ids[i])?.dependsOn || []) if (!ids.includes(d)) ids = [...ids, d];
    const batch = Date.now().toString(36) + Math.random().toString(36).slice(2, 5), commit = commitOf();
    this.pool = this.pool || new Pool(opts.workers || 0);
    this.pool.onChange = () => this.renderStatus();
    const ui = setInterval(() => this.renderStatus(), 1000);
    this.progress = { done: 0, total: 0, running: true };
    const out = [];
    const onRec = async (rec) => {
      out.push(rec); this.recs.push(rec); this.progress.done++;
      await store.put(rec);
      if (opts.onRecord) opts.onRecord(rec);
      if (this.progress.done % 5 === 0 || this.progress.done === this.progress.total) this.render(); else this.renderStatus();
      return rec;
    };
    const fail = (job) => (e) => (e.cancelled ? null : onRec({ test: job.test, run: 'err-' + Math.random().toString(36).slice(2), batch, mode, time: Date.now(), params: job.params, seed: job.seed, verdict: 'invalid', failed: [], criteria: [], error: String(e.message || e), simTime: 0, wallTime: 0 }));
    const tests = ids.map((id) => TEST_BY_ID.get(id)).filter(Boolean);
    const work = [], later = [];
    for (const t of tests) {
      if (mode === 'sweep') {
        if (!Object.keys(t.params).length) continue;
        const memo = new Map();
        const runAt = (params, seed) => {
          const key = JSON.stringify([params, seed]);
          if (!memo.has(key)) { this.progress.total++; const job = { test: t.id, params, seed, mode, batch, commit, cfg: tuned() }; memo.set(key, this.pool.run(job).then(onRec, fail(job)).then((r) => !!(r && r.wouldPass))); }
          return memo.get(key);
        };
        work.push(sweep(t, runAt).then((bd) => onRec({ test: t.id, run: 'sweep-' + batch + t.id, batch, mode: 'summary', time: Date.now(), verdict: 'summary', params: null, seed: null, failed: [], criteria: [], metrics: { boundary: bd }, simTime: 0, wallTime: 0 }).then(() => { this.progress.done--; })).catch(() => {}));
        continue;
      }
      for (const c of cases(t, mode, { n: opts.n })) {
        const job = { test: t.id, params: c.params, seed: c.seed, mode, batch, commit, cfg: tuned() };
        this.progress.total++;
        if (t.alone) later.push(job); else work.push(this.pool.run(job).then(onRec, fail(job)));
      }
    }
    this.renderStatus();
    await Promise.all(work);
    // tests that time the engine run last, one at a time, with no other worker busy
    for (const job of later) await this.pool.run(job).then(onRec, fail(job));
    clearInterval(ui);
    this.progress.running = false;
    this.render();
    return { batch, records: out };
  }

  stop() { if (this.pool) this.pool.cancel(); }

  close() {
    if (this.pool) { this.pool.close(); this.pool = null; }
    this.progress.running = false;
    this.root.remove(); current = null;
    if (this.onClose) this.onClose();
  }

  // ---------- graphical view of one run ----------
  /** Open the viewer on a test's default point (also what ?view=FM-10 does). */
  viewDefault(id) {
    const t = TEST_BY_ID.get(String(id).toUpperCase());
    if (!t) return;
    this.focus = t.id; this.render();
    this.view({ test: t.id, params: defaultsOf(t), seed: t.seed ? t.seed.must[0] : null, mode: 'view' });
  }

  /**
   * Watch one run in 3D. Touch: one finger orbits, two fingers pinch to dolly the camera forward / back
   * (it moves; the lens does not zoom) and drag to pan, double tap resets the camera. Mouse: drag orbits, right / shift drag
   * pans, wheel moves forward / back. Trackpad: two-finger swipe pans, pinch moves forward / back.
   * Replay starts the run again from the beginning; the phone's back gesture returns to the list.
   */
  async view(rec) {
    const T = TEST_BY_ID.get(rec.test);
    const { View } = await import('../view/view.js');
    const THREE = await import('three');
    const canvas = el('canvas'), hud = el('div', { class: 'hud' }), title = el('div', { class: 'title' });
    let gameCfg = null;          // the game's settings, while the viewer runs on past the end of a test with the saw
    let speed = 1, paused = false, closed = false, gen = 0, vw = null, ctxNow = null, params = null;
    let wall0 = performance.now(), sim0 = 0, lastDraw = 0, done = null, camView = null, camTouched = false;
    const speeds = [[1, '1×'], [4, '4×'], [Infinity, 'Max'], [0.25, '¼×']];
    const spb = el('button', { title: 'Playback speed', onclick: () => {
      const i = (speeds.findIndex(([v]) => v === speed) + 1) % speeds.length;
      speed = speeds[i][0]; spb.textContent = speeds[i][1]; wall0 = performance.now(); sim0 = ctxNow ? ctxNow.t : 0;
    } }, '1×');
    const pb = el('button', { onclick: () => { paused = !paused; pb.textContent = paused ? 'Play' : 'Pause'; } }, 'Pause');
    let showHud = innerWidth >= 800, showPlumb = true, plumbGroup = null;
    const plb = el('button', { class: 'on', title: 'Plumb lines from the centres of gravity', onclick: () => { showPlumb = !showPlumb; plb.classList.toggle('on', showPlumb); } }, 'Plumb');
    const ib = el('button', { class: showHud ? 'on' : '', title: 'Show the run details', onclick: () => { showHud = !showHud; ib.classList.toggle('on', showHud); hud.style.display = showHud ? '' : 'none'; } }, 'Info');
    hud.style.display = showHud ? '' : 'none';
    // ---- sliders: every parameter of the test, and its steps (one of the runs a comparison test makes).
    // Each track is coloured by the stored runs near the other sliders' values: green passed, red failed,
    // grey not run. Letting go of a slider restarts the run there.
    rec.params = { ...rec.params };
    if (T.steps) for (const [k, vals] of Object.entries(T.steps)) if (rec.params[k] === undefined) rec.params[k] = vals[0];
    const panel = el('div', { class: 'params' }), sliders = [];
    const runs = this.recs.filter((r) => r.test === rec.test && r.params && r.mode !== 'view');
    const latest = runs.length ? runs.reduce((a, b) => (b.time > a.time ? b : a)) : null;
    const span = (d) => { const r = d.explore || d.must; return Array.isArray(r) ? r : null; };
    // distance between a stored run and the sliders' current point, each parameter scaled to its range
    const gap = (r, k, v) => {
      let d2 = 0;
      for (const [j, d] of Object.entries(T.params)) {
        const a = r.params[j], b = j === k ? v : rec.params[j]; if (a === undefined || b === undefined) continue;
        const sp = span(d), x = sp ? (a - b) / (sp[1] - sp[0] || 1) : (a === b ? 0 : 1 / Math.max(1, d.must.list.length - 1) * Math.abs(d.must.list.indexOf(a) - d.must.list.indexOf(b)));
        d2 += x * x;
      }
      return Math.sqrt(d2);
    };
    // each stretch of a track takes the result of the stored run nearest to it; faded where none is near
    const track = (k, d) => {
      const sp = span(d), vals = sp ? null : d.must.list, B = sp ? 40 : vals.length, stops = [];
      const judged = runs.filter((r) => r.verdict !== 'skip');
      for (let i = 0; i < B; i++) {
        const v = sp ? sp[0] + (sp[1] - sp[0]) * (i + 0.5) / B : vals[i];
        let best = null, bd = Infinity;
        for (const r of judged) { const g = gap(r, k, v); if (g < bd) { bd = g; best = r; } }
        let c = '#555';
        if (best && bd < 0.45) {
          const ok = best.verdict === 'pass' || (best.verdict === 'explore' && best.wouldPass);
          c = best.verdict === 'invalid' ? '#b02a7a' : ok ? '#3d9a32' : '#c0442b';
          if (bd > 0.2) c = ok ? '#2f5f2a' : '#6d3328';            // only a distant run to go on
        }
        stops.push(`${c} ${(100 * i / B).toFixed(1)}% ${(100 * (i + 1) / B).toFixed(1)}%`);
      }
      return `linear-gradient(90deg, ${stops.join(', ')})`;
    };
    const fmtV = (v) => (typeof v === 'number' ? +v.toPrecision(3) : v);
    const addSlider = (k, vals, sp, unit, d) => {
      const lab = el('span', { class: 'lab' }), inp = el('input', { type: 'range' });
      const show = () => { lab.textContent = `${k} ${fmtV(rec.params[k])}${unit ? ' ' + unit : ''}`; };
      if (vals) { inp.min = 0; inp.max = vals.length - 1; inp.step = 1; inp.value = Math.max(0, vals.indexOf(rec.params[k])); }
      else { inp.min = sp[0]; inp.max = sp[1]; inp.step = (sp[1] - sp[0]) / 200; inp.value = rec.params[k]; }
      const val = () => (vals ? vals[+inp.value] : +inp.value);
      inp.oninput = () => { rec.params[k] = val(); show(); };
      inp.onchange = () => { rec.params[k] = val(); show(); recolour(); replay(); };
      sliders.push({ k, d, inp });
      show();
      panel.append(el('div', { class: 'row' }, lab, inp));
    };
    for (const [k, d] of Object.entries(T.params)) {
      if (rec.params[k] === undefined) rec.params[k] = d.def;
      addSlider(k, span(d) ? null : d.must.list, span(d), d.unit, d);
    }
    for (const [k, vals] of Object.entries(T.steps || {})) addSlider(k, vals, null, '', null);
    const recolour = () => { for (const { k, d, inp } of sliders) inp.style.background = d ? track(k, d) : '#555'; };
    recolour();
    if (T.steps && latest) {
      // the checks that compare several runs can only be judged over a whole batch
      panel.append(el('div', { class: 'cross' }, 'Across runs, latest batch: ',
        ...(latest.criteria || []).map((c) => el('span', { class: c.ok ? 'ok' : 'no' }, `${c.ok ? '✓' : '✗'} ${c.text}  `))));
    }
    if (T.dependsOn) panel.append(el('div', { class: 'cross' }, `Depends on ${T.dependsOn.join(', ')} (run it from the list).`));
    // ---- Tune: every engine setting from the game's Tab menu, for phones too. A change restarts the run and
    // is kept for later runs and batches started from this menu.
    const tunePanel = el('div', { class: 'params tune' }), owned = new Set(Object.values(T.params).map((d) => d.cfg).filter(Boolean));
    const buildTune = () => {
      const t = loadTune(); tunePanel.replaceChildren();
      const n = Object.keys(t).length;
      tunePanel.append(el('div', { class: 'cross' }, n ? `${n} changed from the defaults; used by every run from the test menu. ` : 'Defaults. A change restarts the run and is used by every run from the test menu. ',
        n ? el('button', { class: 'small', onclick: () => { saveTune({}); buildTune(); replay(); } }, 'Reset all') : ''));
      // wood first, then the rest of the simulation, view last; the player's controls are left out
      const groups = []; for (const r of ROWS) if (r.length === 1) groups.push([r]); else if (groups.length) groups[groups.length - 1].push(r);
      const rank = (g) => (g[0][0] === 'Wood fibres' ? 0 : g[0][0] === 'View' ? 2 : 1);
      const rows = groups.filter((g) => g[0][0] !== 'Controls').sort((a, b) => rank(a) - rank(b)).flat();
      for (const r of rows) {
        if (r.length === 1) { tunePanel.append(el('div', { class: 'grp' }, r[0])); continue; }
        const [key, label, min, max, step, scale] = r;
        if (!(key in CFG_DEFAULTS) || typeof CFG_DEFAULTS[key] !== 'number' || key.startsWith('@')) continue;
        const cur = () => (key in loadTune() ? loadTune()[key] : CFG_DEFAULTS[key]);
        const lab = el('span', { class: 'lab', title: label }), inp = el('input', { type: 'range' }), nb = el('input', { type: 'number' });
        for (const i of [inp, nb]) { i.min = min; i.max = max; i.step = step; }
        const show = () => { const v = +(cur() / scale).toFixed(4); inp.value = v; nb.value = v; lab.textContent = label; lab.classList.toggle('changed', key in loadTune()); };
        const set = (v) => {
          const t2 = loadTune(), x = v * scale;
          if (Math.abs(x - CFG_DEFAULTS[key]) <= Math.abs(CFG_DEFAULTS[key]) * 1e-9) delete t2[key]; else t2[key] = x;
          saveTune(t2); buildTune(); replay();
        };
        inp.oninput = () => { nb.value = inp.value; };
        inp.onchange = () => set(+inp.value);
        nb.onchange = () => { if (nb.value !== '' && Number.isFinite(+nb.value)) set(+nb.value); };   // the box may go outside the slider's range
        show();
        if (owned.has(key)) { inp.disabled = nb.disabled = true; lab.textContent = label + ' (set by this test: Params)'; }
        tunePanel.append(el('div', { class: 'row trow' }, lab, inp, nb));
      }
    };
    buildTune();
    tunePanel.style.display = 'none';
    let showTune = false;
    const tbtn = el('button', { title: 'Engine settings', onclick: () => {
      showTune = !showTune; tbtn.classList.toggle('on', showTune); tunePanel.style.display = showTune ? '' : 'none';
      if (showTune && showPanel) pbtn.onclick();
    } }, 'Tune');
    let showPanel = false;
    panel.style.display = 'none';
    const pbtn = el('button', { title: 'Parameters', onclick: () => {
      showPanel = !showPanel; pbtn.classList.toggle('on', showPanel); panel.style.display = showPanel ? '' : 'none';
      if (showPanel && showTune) tbtn.onclick();
    } }, 'Params');
    if (!sliders.length) pbtn.style.display = 'none';
    // ---- Saw (prototype of draw-to-cut, STATUS.md): put a finger on the wood to plant the bar there, drag to pivot it,
    // and hold a second finger anywhere to run the chain and press it in. Lift the first finger to take the bar off.
    // Mouse: left button plants and drags, hold Space to cut. The run keeps going after the test is done while Saw is on.
    let sawMode = false;
    const sawb = el('button', { title: 'Cut with your fingers (prototype)', onclick: () => { sawMode = !sawMode; sawb.classList.toggle('on', sawMode); if (!sawMode) sawLift(); } }, 'Saw');

    const wrapEl = el('div', { id: 'tview' }, canvas, hud, panel, tunePanel,
      el('div', { class: 'top' }, el('button', { title: 'Back to the test list', onclick: () => close() }, '‹ Tests'), title),
      el('div', { class: 'bot' }, el('button', { onclick: () => replay() }, 'Replay'), pb, spb, sawb, pbtn, tbtn, plb, ib));
    document.body.append(wrapEl);

    // ---- camera: an orbit about a target; dolly moves the camera, and carries the target along once it gets close
    const cam = { target: [0, 3, 0], dist: 12, yaw: 0, pitch: 0.3 };
    const setView = (v) => { cam.target = [...(v.target || cam.target)]; for (const k of ['dist', 'yaw', 'pitch']) if (v[k] !== undefined) cam[k] = v[k]; };
    const fwd = () => { const cp = Math.cos(cam.pitch); return [-cp * Math.sin(cam.yaw), -Math.sin(cam.pitch), -cp * Math.cos(cam.yaw)]; };
    const MIN_D = 0.6;
    const dolly = (ratio) => {
      const d = cam.dist * ratio;
      if (d >= MIN_D) { cam.dist = Math.min(300, d); return; }
      const f = fwd(), step = cam.dist - d;            // keep going forward: the target moves ahead of the camera
      cam.target = cam.target.map((x, i) => x + f[i] * step); cam.dist = MIN_D;
    };
    const pan = (dx, dy) => {
      const h = canvas.clientHeight || 1, fov = vw ? vw.camera.fov : 60, k = 2 * cam.dist * Math.tan(fov * Math.PI / 360) / h;
      const right = [Math.cos(cam.yaw), 0, -Math.sin(cam.yaw)], sp = Math.sin(cam.pitch), cp = Math.cos(cam.pitch);
      const up = [-sp * Math.sin(cam.yaw), cp, -sp * Math.cos(cam.yaw)];
      cam.target = cam.target.map((x, i) => x - right[i] * dx * k + up[i] * dy * k);
    };
    const orbit = (dx, dy) => { cam.yaw -= dx * 0.007; cam.pitch = Math.max(-1.4, Math.min(1.5, cam.pitch + dy * 0.007)); };
    // the saw: a stand-in climber with no body, whose eyes are 1 m back from where the finger met the wood
    const saw = { err: '', id: null, run: new Set(), key: false, p: null, inp: null, eye: null, mesh: null };
    const sawLift = () => { saw.id = null; saw.run.clear(); if (saw.inp) saw.inp.lt = saw.inp.rt = 0; };
    const sawPlant = (e) => {
      if (!vw || !ctxNow) return false;
      const r = canvas.getBoundingClientRect(), c = vw.camera;
      const d = new THREE.Vector3(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1, 0.5).unproject(c).sub(c.position).normalize();
      const hit = ctxNow.sim.ray(c.position.clone(), d, 200);
      if (!hit) return false;
      saw.eye = { o: hit.point.clone().addScaledVector(d, -1), d, aim: { seg: hit.seg, point: hit.point, dist: 1 } };
      saw.p = { saw: { on: false }, prompt: '' };
      saw.inp = { lt: 1, rt: 0, sy: 0, sp: 0, yaw: cam.yaw };
      saw.id = e.pointerId;
      return true;
    };
    const sawTick = (c) => {
      if (!saw.p || c !== ctxNow) return;
      if (saw.inp.lt > 0) saw.inp.rt = saw.run.size || saw.key ? 1 : 0;
      const ps = Object.create(c.sim);            // the same sim, seen through the stand-in's eyes
      ps.eye = () => ({ o: saw.eye.o.clone(), d: saw.eye.d.clone() });
      sawStep(ps, saw.p, saw.inp, CFG.TICK, true, saw.p.saw.on ? null : saw.eye.aim);
      if (!saw.p.saw.on && saw.inp.lt === 0) saw.p = null;
    };
    const drawSaw = () => {
      if (saw.mesh && saw.mesh.parent !== vw.scene) saw.mesh = null;
      if (!saw.mesh) {
        saw.mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial({ color: 0xff8a20, depthTest: false, transparent: true, opacity: 0.85 }));
        saw.mesh.renderOrder = 11; saw.mesh.matrixAutoUpdate = false; vw.scene.add(saw.mesh);
      }
      const sw = saw.p && saw.p.saw;
      saw.mesh.visible = !!(sw && sw.on);
      if (!saw.mesh.visible) return;
      const y = new THREE.Vector3().crossVectors(sw.f, sw.b);
      saw.mesh.material.color.set(sw.stuck ? 0xff2020 : sw.cutting ? 0xffe040 : 0xff8a20);
      saw.mesh.matrix.makeBasis(sw.b, y, sw.f).scale(new THREE.Vector3(CFG.BAR_LEN, 0.012, 0.07)).setPosition(sw.A.clone().addScaledVector(sw.f, 0.035));
    };
    addEventListener('keydown', (e) => { if (e.code === 'Space' && sawMode) { saw.key = true; e.preventDefault(); } });
    addEventListener('keyup', (e) => { if (e.code === 'Space') saw.key = false; });
    const pts = new Map();
    let lastTap = 0, moved = 0, g2 = null;
    const two = () => { const [a, b] = [...pts.values()]; return { d: Math.hypot(a.x - b.x, a.y - b.y), x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }; };
    canvas.onpointerdown = (e) => {
      if (sawMode) {
        if (saw.id !== null) { saw.run.add(e.pointerId); return; }          // a second finger: run the chain
        if (sawPlant(e)) { try { canvas.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ } pts.set(e.pointerId, { x: e.clientX, y: e.clientY, saw: true }); return; }
      }
      g2 = null; try { canvas.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ } pts.set(e.pointerId, { x: e.clientX, y: e.clientY }); moved = 0; };
    canvas.onpointermove = (e) => {
      const p = pts.get(e.pointerId); if (!p) return;
      if (p.saw) {
        // same feel as the game's mouse: SAW_SENS turns per screen width, times the touch factor
        const perPx = CFG.SAW_SENS / Math.max(600, innerWidth) * (e.pointerType === 'mouse' ? 1 : CFG.TOUCH_SAW_SENS), inv = CFG.INVERT_Y ? 1 : -1;
        saw.inp.sy -= (e.clientX - p.x) * perPx; saw.inp.sp += inv * (e.clientY - p.y) * perPx;
        p.x = e.clientX; p.y = e.clientY; return;
      }
      if (pts.size === 1 && e.pointerType === 'mouse' && (e.buttons & 6 || e.shiftKey)) {   // right / middle / shift drag pans
        pan(e.clientX - p.x, e.clientY - p.y); moved += 99; p.x = e.clientX; p.y = e.clientY; camTouched = true; return;
      }
      if (pts.size === 1) { orbit(e.clientX - p.x, e.clientY - p.y); moved += Math.abs(e.clientX - p.x) + Math.abs(e.clientY - p.y); p.x = e.clientX; p.y = e.clientY; camTouched = true; return; }
      // Two fingers: decide once per gesture whether it is a pinch or a pan, from whichever has moved further
      // after the first 16 px, so a two-finger drag does not creep forward or back as the fingers shift.
      const before = two(); p.x = e.clientX; p.y = e.clientY; const after = two();
      if (!g2) g2 = { d0: before.d, x0: before.x, y0: before.y, mode: null };
      if (!g2.mode) {
        const pinch = Math.abs(after.d - g2.d0), drag = Math.hypot(after.x - g2.x0, after.y - g2.y0);
        if (Math.max(pinch, drag) > 16) {
          g2.mode = pinch > drag ? 'pinch' : 'pan';
          if (g2.mode === 'pinch' && g2.d0 > 10) dolly(g2.d0 / after.d); else pan(after.x - g2.x0, after.y - g2.y0);
        }
      } else if (g2.mode === 'pinch') { if (before.d > 10 && after.d > 10) dolly(before.d / after.d); }     // fingers apart: forward
      else pan(after.x - before.x, after.y - before.y);
      moved += 99; camTouched = true;
    };
    const up = (e) => {
      saw.run.delete(e.pointerId);
      if (e.pointerId === saw.id) { pts.delete(e.pointerId); sawLift(); return; }
      if (!pts.delete(e.pointerId)) return;
      if (pts.size < 2) g2 = null;
      if (pts.size || e.type === 'pointercancel') return;
      const now = performance.now();
      if (moved < 12) { if (now - lastTap < 320) { if (camView) setView(camView); camTouched = false; lastTap = 0; } else lastTap = now; }
    };
    canvas.onpointerup = up; canvas.onpointercancel = up;
    // A trackpad's two-finger swipe arrives as small pixel wheel steps (often with some deltaX) and its pinch as
    // ctrl + wheel; a mouse wheel arrives in lines or big notches. Swipes pan, pinches and mouse wheels dolly.
    canvas.onwheel = (e) => {
      e.preventDefault(); camTouched = true;
      const mouse = e.deltaMode !== 0 || (e.deltaX === 0 && Math.abs(e.deltaY) >= 50 && Number.isInteger(e.deltaY));
      if (e.ctrlKey) dolly(Math.exp(e.deltaY * 0.01));
      else if (mouse && !e.shiftKey) dolly(Math.exp((e.deltaMode ? e.deltaY * 33 : e.deltaY) * 0.001));
      else pan(-e.deltaX, -e.deltaY);
    };
    canvas.oncontextmenu = (e) => e.preventDefault();

    // ---- the phone's back gesture closes the viewer, not the page
    history.pushState({ tview: 1 }, '');
    const onPop = () => close(true);
    addEventListener('popstate', onPop);
    const close = (fromPop) => {
      if (closed) return;
      closed = true; gen++;
      removeEventListener('popstate', onPop);
      if (gameCfg) Object.assign(CFG, gameCfg);
      if (vw) { vw.renderer.dispose(); vw.renderer.forceContextLoss?.(); }
      wrapEl.remove();
      if (!fromPop) history.back();
    };

    // ---- plumb lines: yellow from each centre of gravity straight down to the ground; for standing wood above a
    // cut, cyan from the cut's centre too, so you can see when the weight has moved past the hinge
    const drawPlumbs = (sim) => {
      if (plumbGroup && plumbGroup.parent !== vw.scene) plumbGroup = null;
      if (!plumbGroup) { plumbGroup = new THREE.Group(); plumbGroup.renderOrder = 10; vw.scene.add(plumbGroup); }
      plumbGroup.visible = showPlumb;
      if (!showPlumb) return;
      const list = gravityCentres(sim), segs = [], cols = [], dots = [], dcols = [];
      const seg = (a, b, col) => { segs.push(a[0], a[1], a[2], b[0], b[1], b[2]); cols.push(...col, ...col); };
      const line = (p, col) => {          // straight down, with a cross where it meets the ground
        const g = [p[0], 0.02, p[2]], r = 0.25;
        seg(p, g, col); seg([g[0] - r, 0.02, g[2]], [g[0] + r, 0.02, g[2]], col); seg([g[0], 0.02, g[2] - r], [g[0], 0.02, g[2] + r], col);
        dots.push(p); dcols.push(...col);
      };
      const Y = [1, 0.85, 0.1], C = [0.2, 0.9, 1];
      for (const g of list) {
        line(g.c, Y);
        if (g.hinge) { line(g.hinge, C); seg([g.hinge[0], 0.02, g.hinge[2]], [g.c[0], 0.02, g.c[2]], [1, 1, 1]); }   // on the ground: how far the weight is past the hinge
      }
      for (const o of plumbGroup.children) o.geometry.dispose();
      plumbGroup.clear();
      if (!segs.length) return;
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(segs, 3)); geo.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
      plumbGroup.add(new THREE.LineSegments(geo, plumbMat));
      const pg = new THREE.BufferGeometry(); pg.setAttribute('position', new THREE.Float32BufferAttribute(dots.flat(), 3));
      pg.setAttribute('color', new THREE.Float32BufferAttribute(dcols, 3));
      plumbGroup.add(new THREE.Points(pg, dotMat));
    };
    const plumbMat = new THREE.LineBasicMaterial({ vertexColors: true, depthTest: false, transparent: true });
    const dotMat = new THREE.PointsMaterial({ vertexColors: true, size: 10, sizeAttenuation: false, depthTest: false, transparent: true });
    const raf = () => new Promise((r) => requestAnimationFrame(r));
    const draw = (ctx) => {
      if (!vw) return;
      lastDraw = performance.now();
      const c = vw.camera, t = cam.target, cp = Math.cos(cam.pitch);
      c.position.set(t[0] + cam.dist * cp * Math.sin(cam.yaw), t[1] + cam.dist * Math.sin(cam.pitch), t[2] + cam.dist * cp * Math.cos(cam.yaw));
      c.lookAt(t[0], t[1], t[2]);
      const sim = ctx.sim, U = ctx.worstU();
      vw.update(1 / 60, { pose: (id) => sim.pose(id), get flex() { return sim.structure.flex; } }, sim.aux(), -1, null);
      drawPlumbs(sim);
      drawSaw();
      // one step of a comparison test may have nothing of its own to judge: its checks are across the batch
      const v = done ? (done.metrics && done.metrics.one && !done.criteria.length ? 'one step' : done.verdict === 'explore' ? (done.wouldPass ? 'pass' : 'fail') : done.verdict) : null;
      title.replaceChildren(el('b', {}, `${rec.test} ${T.title}`),
        el('span', { class: 'badge ' + (v === 'one step' ? 'skip' : v || 'run') }, v ? (v === 'pass' ? '✓ pass' : v === 'fail' ? '✗ fail' : v) : paused ? 'paused' : 'running'),
        `t = ${ctx.t.toFixed(1)} s${done && done.failed && done.failed.length ? ` · ${done.failed.length} failed` : ''}`);
      if (!showHud) return;
      hud.textContent = `${paramText(params)}${rec.seed !== null && rec.seed !== undefined ? ' seed=' + rec.seed : ''}\n` +
        `run ${ctx === ctxNow ? '' : '(earlier) '}t = ${ctx.t.toFixed(2)} s   pieces ${sim.world.pieces.size}   live bundles ${sim.structure.live.size}   splits ${ctx.splits.length}\n` +
        `worst U ${U.U.toFixed(3)}   step ${ctx.stepMs.length ? ctx.stepMs[ctx.stepMs.length - 1].toFixed(2) : 0} ms` +
        (done ? `\n\nverdict: ${done.verdict}${done.failed.length ? '\nfailed: ' + done.failed.join('\n        ') : ''}${done.breach ? '\n' + done.breach.inv + ': ' + done.breach.detail : ''}${done.error ? '\n' + done.error.split('\n')[0] : ''}` : '') +
        (sawMode ? `\n\nSAW: finger on the wood plants the bar · drag pivots it · hold a second finger (or Space) to cut · lift to take it off${saw.p && saw.p.prompt && /PINCH/.test(saw.p.prompt) ? '\nBAR PINCHED' : ''}${saw.err ? '\n' + saw.err : ''}` : '') +
        '\n\none finger: orbit · pinch: move forward / back · two fingers: pan · double tap: reset camera'
        + '\nmouse: drag orbit · right drag: pan · wheel: forward / back · trackpad swipe: pan'
        + '\nplumb: yellow = centre of gravity straight down, cyan = the cut (hinge) straight down';
    };
    const start = async () => {
      const my = ++gen;
      if (gameCfg) { Object.assign(CFG, gameCfg); gameCfg = null; }
      done = null; ctxNow = null;
      const frame = async (ctx) => {
        if (my !== gen) throw { abort: true };
        for (;;) {
          const now = performance.now(), due = wall0 + (ctx.t - sim0) * 1000 / speed;
          if (paused || now < due) { draw(ctx); await raf(); if (my !== gen) throw { abort: true }; if (paused) { wall0 = performance.now(); sim0 = ctx.t; } continue; }
          if (now - lastDraw > (speed === Infinity ? 250 : 30)) { draw(ctx); await raf(); if (my !== gen) throw { abort: true }; }   // behind: still show it now and then
          return;
        }
      };
      const onCtx = (ctx, p) => {
        if (my !== gen) return;
        params = p; ctxNow = ctx; sim0 = 0; wall0 = performance.now();
        saw.p = null; saw.err = ''; sawLift();
        ctx.actions.push(sawTick);
        if (vw) { vw.renderer.dispose(); }
        vw = new View(canvas, ctx.world);
        const v = T.view ? T.view(p) : null;
        camView = v || camView || { ...cam, target: [...cam.target] };
        if (v && !camTouched) setView(v);
        if (v && v.arrows) {
          const arrow = (az, col) => vw.scene.add(new THREE.ArrowHelper(new THREE.Vector3(Math.cos(az), 0, Math.sin(az)), new THREE.Vector3(0, 0.05, 0), 6, col, 0.6, 0.35));
          arrow(0, 0xff4040);                                                   // lean (+x)
          if (p.delta !== undefined && T.id === 'FM-10') arrow(p.delta * Math.PI / 180, 0xffe040);   // the way the notch faces
        }
      };
      const r = await runCase({ test: rec.test, params: rec.params, seed: rec.seed, mode: 'view', cfg: tuned() }, { frame, onCtx });
      if (my !== gen) return;
      done = r;
      // with the saw on, the world carries on after the test has finished (at the test's own settings)
      let t0 = performance.now(), broke = false;
      while (my === gen && !closed) {
        const now = performance.now();
        if (sawMode && ctxNow && !paused && !broke) {
          if (!gameCfg) { gameCfg = { ...CFG }; Object.assign(CFG, r.cfg); }
          let n = Math.min(4, Math.round((now - t0) * Math.min(4, speed) / 1000 / CFG.TICK));
          if (n > 0) t0 = now;
          try { while (n-- > 0) ctxNow.stepOnce(); } catch (err) { broke = true; saw.err = `stopped: ${err.inv || ''} ${String(err.detail || err).split('\n')[0]}`; }
        } else t0 = now;
        if (ctxNow) draw(ctxNow);
        await raf();
      }
    };
    const replay = () => {
      if (closed) return;
      paused = false; pb.textContent = 'Pause';
      start();
    };
    start();
  }
}

const fmtRange = (r) => (!r ? '' : Array.isArray(r) ? `${fmt(r[0])}–${fmt(r[1])}` : `{${r.list.join(', ')}}`);
const rank = (r) => ({ invalid: 0, fail: 1, explore: r.wouldPass ? 4 : 2, skip: 5, pass: 6 }[r.verdict] ?? 3);
const defaultsOf = (t) => { const p = Object.fromEntries(Object.entries(t.params).map(([k, d]) => [k, d.def])); return t.fix ? t.fix(p, 'explore') : p; };

let current = null;
/** Open the Testing menu (from the main menu). onClose is called when it is closed. */
export function openTesting(onClose) {
  if (!current) current = new Testing();
  current.onClose = onClose;
  return current;
}

/** ?test=... : run without the menu being touched and print the records. */
export async function headless(q, onClose) {
  const t = openTesting(onClose), want = q.get('test');
  const ids = want === 'all' || want === '' ? TESTS.map((x) => x.id) : want.split(',').map((s) => s.trim().toUpperCase());
  const mode = q.get('mode') || 'smoke';
  window.arbTests = { done: false, records: [], summary: null };
  t.mode = mode; t.selected = new Set(ids); t.build(); t.render();
  const res = await t.runTests(ids, mode, {
    n: +q.get('n') || 0, workers: +q.get('workers') || 0,
    onRecord: (r) => { const { cfg, ...rest } = r; void cfg; window.arbTests.records.push(rest); console.log('ARBTEST ' + JSON.stringify(rest)); },
  });
  const summary = {};
  for (const id of ids) { const s = summarise(res.records, id); if (s) summary[id] = { mode: s.mode, pass: s.pass, judged: s.judged, fail: s.fail, invalid: s.invalid, skip: s.skip }; }
  window.arbTests.summary = summary; window.arbTests.done = true;
  console.log('ARBTEST-DONE ' + JSON.stringify({ batch: res.batch, summary }));
  return res;
}
