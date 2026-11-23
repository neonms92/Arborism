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
        el('td', {}, cb), el('td', {}, el('b', {}, t.id)), el('td', {}, t.title), el('td', {}, res));
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
    const work = [];
    for (const t of tests) {
      if (mode === 'sweep') {
        if (!Object.keys(t.params).length) continue;
        const memo = new Map();
        const runAt = (params, seed) => {
          const key = JSON.stringify([params, seed]);
          if (!memo.has(key)) { this.progress.total++; const job = { test: t.id, params, seed, mode, batch, commit }; memo.set(key, this.pool.run(job).then(onRec, fail(job)).then((r) => !!(r && r.wouldPass))); }
          return memo.get(key);
        };
        work.push(sweep(t, runAt).then((bd) => onRec({ test: t.id, run: 'sweep-' + batch + t.id, batch, mode: 'summary', time: Date.now(), verdict: 'summary', params: null, seed: null, failed: [], criteria: [], metrics: { boundary: bd }, simTime: 0, wallTime: 0 }).then(() => { this.progress.done--; })).catch(() => {}));
        continue;
      }
      for (const c of cases(t, mode, { n: opts.n })) {
        const job = { test: t.id, params: c.params, seed: c.seed, mode, batch, commit };
        this.progress.total++;
        work.push(this.pool.run(job).then(onRec, fail(job)));
      }
    }
    this.renderStatus();
    await Promise.all(work);
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
   * (it moves; the lens does not zoom) and drag to pan, double tap resets the camera. Mouse: drag, wheel.
   * Replay starts the run again from the beginning; the phone's back gesture returns to the list.
   */
  async view(rec) {
    const T = TEST_BY_ID.get(rec.test);
    const { View } = await import('../view/view.js');
    const THREE = await import('three');
    const canvas = el('canvas'), hud = el('div', { class: 'hud' }), title = el('div', { class: 'title' });
    let speed = 1, paused = false, closed = false, gen = 0, vw = null, ctxNow = null, params = null;
    let wall0 = performance.now(), sim0 = 0, lastDraw = 0, done = null, camView = null, camTouched = false;
    const speeds = [[1, '1×'], [4, '4×'], [Infinity, 'Max'], [0.25, '¼×']];
    const spb = el('button', { title: 'Playback speed', onclick: () => {
      const i = (speeds.findIndex(([v]) => v === speed) + 1) % speeds.length;
      speed = speeds[i][0]; spb.textContent = speeds[i][1]; wall0 = performance.now(); sim0 = ctxNow ? ctxNow.t : 0;
    } }, '1×');
    const pb = el('button', { onclick: () => { paused = !paused; pb.textContent = paused ? 'Play' : 'Pause'; } }, 'Pause');
    let showHud = innerWidth >= 800;
    const ib = el('button', { class: showHud ? 'on' : '', title: 'Show the run details', onclick: () => { showHud = !showHud; ib.classList.toggle('on', showHud); hud.style.display = showHud ? '' : 'none'; } }, 'Info');
    hud.style.display = showHud ? '' : 'none';
    const wrapEl = el('div', { id: 'tview' }, canvas, hud,
      el('div', { class: 'top' }, el('button', { title: 'Back to the test list', onclick: () => close() }, '‹ Tests'), title),
      el('div', { class: 'bot' }, el('button', { onclick: () => replay() }, 'Replay'), pb, spb, ib));
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
    const pts = new Map();
    let lastTap = 0, moved = 0;
    const two = () => { const [a, b] = [...pts.values()]; return { d: Math.hypot(a.x - b.x, a.y - b.y), x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }; };
    canvas.onpointerdown = (e) => { try { canvas.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ } pts.set(e.pointerId, { x: e.clientX, y: e.clientY }); moved = 0; };
    canvas.onpointermove = (e) => {
      const p = pts.get(e.pointerId); if (!p) return;
      if (pts.size === 1) { orbit(e.clientX - p.x, e.clientY - p.y); moved += Math.abs(e.clientX - p.x) + Math.abs(e.clientY - p.y); p.x = e.clientX; p.y = e.clientY; camTouched = true; return; }
      const before = two(); p.x = e.clientX; p.y = e.clientY; const after = two();
      if (before.d > 10 && after.d > 10) dolly(before.d / after.d);     // fingers apart: forward
      pan(after.x - before.x, after.y - before.y);
      moved += 99; camTouched = true;
    };
    const up = (e) => {
      if (!pts.delete(e.pointerId)) return;
      if (pts.size || e.type === 'pointercancel') return;
      const now = performance.now();
      if (moved < 12) { if (now - lastTap < 320) { if (camView) setView(camView); camTouched = false; lastTap = 0; } else lastTap = now; }
    };
    canvas.onpointerup = up; canvas.onpointercancel = up;
    canvas.onwheel = (e) => { e.preventDefault(); dolly(Math.exp(e.deltaY * 0.001)); camTouched = true; };

    // ---- the phone's back gesture closes the viewer, not the page
    history.pushState({ tview: 1 }, '');
    const onPop = () => close(true);
    addEventListener('popstate', onPop);
    const close = (fromPop) => {
      if (closed) return;
      closed = true; gen++;
      removeEventListener('popstate', onPop);
      if (vw) { vw.renderer.dispose(); vw.renderer.forceContextLoss?.(); }
      wrapEl.remove();
      if (!fromPop) history.back();
    };

    const raf = () => new Promise((r) => requestAnimationFrame(r));
    const draw = (ctx) => {
      if (!vw) return;
      lastDraw = performance.now();
      const c = vw.camera, t = cam.target, cp = Math.cos(cam.pitch);
      c.position.set(t[0] + cam.dist * cp * Math.sin(cam.yaw), t[1] + cam.dist * Math.sin(cam.pitch), t[2] + cam.dist * cp * Math.cos(cam.yaw));
      c.lookAt(t[0], t[1], t[2]);
      const sim = ctx.sim, U = ctx.worstU();
      vw.update(1 / 60, { pose: (id) => sim.pose(id), get flex() { return sim.structure.flex; } }, sim.aux(), -1, null);
      const v = done ? (done.verdict === 'explore' ? (done.wouldPass ? 'pass' : 'fail') : done.verdict) : null;
      title.replaceChildren(el('b', {}, `${rec.test} ${T.title}`),
        el('span', { class: 'badge ' + (v || 'run') }, v ? (v === 'pass' ? '✓ pass' : v === 'fail' ? '✗ fail' : v) : paused ? 'paused' : 'running'),
        `t = ${ctx.t.toFixed(1)} s${done && done.failed && done.failed.length ? ` · ${done.failed.length} failed` : ''}`);
      if (!showHud) return;
      hud.textContent = `${paramText(params)}${rec.seed !== null && rec.seed !== undefined ? ' seed=' + rec.seed : ''}\n` +
        `run ${ctx === ctxNow ? '' : '(earlier) '}t = ${ctx.t.toFixed(2)} s   pieces ${sim.world.pieces.size}   live bundles ${sim.structure.live.size}   splits ${ctx.splits.length}\n` +
        `worst U ${U.U.toFixed(3)}   step ${ctx.stepMs.length ? ctx.stepMs[ctx.stepMs.length - 1].toFixed(2) : 0} ms` +
        (done ? `\n\nverdict: ${done.verdict}${done.failed.length ? '\nfailed: ' + done.failed.join('\n        ') : ''}${done.breach ? '\n' + done.breach.inv + ': ' + done.breach.detail : ''}${done.error ? '\n' + done.error.split('\n')[0] : ''}` : '') +
        '\n\none finger: orbit · pinch: move forward / back · two fingers: pan · double tap: reset camera';
    };
    const start = async () => {
      const my = ++gen;
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
      const r = await runCase({ test: rec.test, params: rec.params, seed: rec.seed, mode: 'view' }, { frame, onCtx });
      if (my !== gen) return;
      done = r;
      while (my === gen && !closed) { if (ctxNow) draw(ctxNow); await raf(); }
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
