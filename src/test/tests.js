// The fibre mechanics tests of docs/TESTS.md, as data + a scenario each.
// A test: { id, title, params, fixed, seed?, interior, exploreN, grid?, fix(p, mode),
//           run(env, p) -> metrics, judge(metrics, p) -> [criterion], view }
// params: name -> { must: [lo, hi] | {list}, explore: [lo, hi], def, unit, cfg?: CFG key, scale? }
// Values are in the manifest's units; `scale` converts a cfg param to CFG units.
// A criterion: { text, ok, value?, limit?, margin? } (margin > 0 = inside the limit, as a fraction of it).

import { CFG, CFG_DEFAULTS } from '../config.js';
import { segLen, segAxis, segMass, lerp3 } from '../model/world.js';
import { layout, gridFor } from '../model/fibres.js';
import { generateTree } from '../model/treegen.js';
import { frameApply } from '../model/flex.js';
import { DEG, Member, dot, sub, norm } from './harness.js';
import { cantilever, yieldMoment, edgeStress, bimodularCircle } from './analytic.js';

// ---------- criteria ----------
const rel = (lim) => Math.abs(lim) || 1;
export const le = (text, v, lim) => ({ text, ok: Number.isFinite(v) && v <= lim, value: num(v), limit: lim, margin: Number.isFinite(v) ? +((lim - v) / rel(lim)).toFixed(4) : null });
export const ge = (text, v, lim) => ({ text, ok: Number.isFinite(v) && v >= lim, value: num(v), limit: lim, margin: Number.isFinite(v) ? +((v - lim) / rel(lim)).toFixed(4) : null });
export const is = (text, ok, value) => ({ text, ok: !!ok, value: value === undefined ? !!ok : value });
const num = (v) => (Number.isFinite(v) ? +v.toFixed(5) : v ?? null);

// ---------- parameter helpers ----------
const P = (must, explore, def, unit = '') => ({ must, explore, def, unit });
const C = (key, must, explore, scale = 1, unit = '') => ({ cfg: key, must, explore, scale, unit, def: CFG_DEFAULTS[key] / scale });
const list = (...v) => ({ list: v });

const WOOD = {      // FM-10 must-pass and explore ranges for the wood
  MOR: C('MOR', [25, 50], [5, 80], 1e6, 'MPa'),
  COMP: C('COMP', [8, 20], [2, 60], 1e6, 'MPa'),
  DENSITY: C('DENSITY', [600, 1000], [200, 1400], 1, 'kg/m³'),
  TENS_STRAIN: C('TENS_STRAIN', [0.004, 0.01], [0.0005, 0.05]),
  COMP_STRAIN: C('COMP_STRAIN', [0.006, 0.015], [0.0005, 0.05]),
  FIBRE_STRETCH: C('FIBRE_STRETCH', [0.015, 0.04], [0.002, 0.08], 1, 'm'),
  FIBRE_SLIP: C('FIBRE_SLIP', [0.02, 0.05], [0.005, 0.1], 1, 'm'),
  BEND_MAX: C('BEND_MAX', [1.2, 2.0], [0.2, 3.1], 1, 'rad'),
  FIBRE_PITCH: C('FIBRE_PITCH', [0.02, 0.04], [0.008, 0.1], 1, 'm'),
  SEG_LEN: C('SEG_LEN', [0.4, 1.0], [0.15, 2], 1, 'm'),
};
const pick = (o, ...keys) => Object.fromEntries(keys.map((k) => [k, o[k]]));
const BEAM = {      // FM-01 / FM-02 resolution and stiffness ranges
  SEG_LEN: C('SEG_LEN', [0.3, 1.0], [0.15, 2], 1, 'm'),
  FIBRE_PITCH: C('FIBRE_PITCH', [0.02, 0.04], [0.008, 0.1], 1, 'm'),
  TENS_STRAIN: C('TENS_STRAIN', [0.004, 0.01], [0.0005, 0.1]),
  COMP_STRAIN: C('COMP_STRAIN', [0.006, 0.015], [0.0005, 0.1]),
  DENSITY: C('DENSITY', [600, 1000], [200, 1400], 1, 'kg/m³'),
};
// FM-10's default point (FM-13 names it), and the scenario values every felling run needs
export const FELL = { H: 11, D: 0.5, lean: 5, delta: 0, alpha: 55, dn: 0.25, th: 0.08, step: 0.01, hc: 0.5 };
const LIMB0 = { L: 3, D: 0.12 };

const wrap = (a) => { a = ((a + 180) % 360 + 360) % 360 - 180; return a === -180 ? 180 : a; };
const g = () => CFG.GRAVITY;
const Et = () => CFG.MOR / CFG.TENS_STRAIN, Ec = () => CFG.COMP / CFG.COMP_STRAIN;
const perpTo = (d, ax) => norm(sub(d, ax.map((a) => a * dot(d, ax))));
const elev = (d) => Math.asin(Math.max(-1, Math.min(1, d.y))) / DEG;

function spearman(xs, ys) {
  const rank = (v) => {
    const idx = v.map((x, i) => [x, i]).sort((a, b) => a[0] - b[0]), r = new Array(v.length);
    for (let i = 0; i < idx.length;) { let j = i; while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++; for (let k = i; k <= j; k++) r[idx[k][1]] = (i + j) / 2; i = j + 1; }
    return r;
  };
  const a = rank(xs), b = rank(ys), n = a.length, ma = a.reduce((s, x) => s + x, 0) / n, mb = b.reduce((s, x) => s + x, 0) / n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) { num += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2; }
  return da && db ? num / Math.sqrt(da * db) : (da === db ? 1 : 0);
}

// ================= scenarios shared by several tests =================

/** Load at which the root of Limb(L, D, 0) reaches MOR (bimodular section, self-weight included). */
function limbYield(L, D) {
  const c = cantilever({ L, D, rho: CFG.DENSITY, g: g(), E: 1 });
  return (yieldMoment(D / 2, Et(), Ec(), CFG.MOR) - c.Mself) / L;
}
const held = (ctx, piece) => !!ctx.world.pieces.get(piece) && ctx.sim.structure.isHeld(piece);

/**
 * Notch, settle, back cut on member m at height p.hc, the notch facing world
 * azimuth psiDeg. o.noNotch: straight back cut leaving the hinge on the psi
 * side. o.rows: hinge thickness as a number of fibre rows. Returns the
 * back-cut handle and the geometry used.
 */
async function fellCuts(ctx, m, p, psiDeg, o = {}) {
  const dN = perpTo([Math.cos(psiDeg * DEG), 0, Math.sin(psiDeg * DEG)], m.axis);
  const hc = p.hc, R = m.R(hc), D = 2 * R, tanA = Math.tan(p.alpha * DEG);
  const fibres = m.fibresAt(hc), cs = fibres[0].cs;
  const qA = o.noNotch ? R : R - p.dn * D;
  if (!o.noNotch) {
    m.cut((ov) => { const q = dot(ov, dN) * R; return q > qA ? [hc, hc + (q - qA) * tanA] : null; });
    await ctx.run(1);
  }
  const th = o.rows ? o.rows * cs : Math.max(p.th * D, cs);          // at least one full row of fibres
  const hingeBot = qA - th, hb = hc + (o.noNotch ? 0 : p.step);
  const hingeN = fibres.filter((f) => { const q = dot(f.o, dN) * R; return q >= hingeBot && q <= qA; }).length;
  const notchIdx = new Set(o.noNotch ? [] : fibres.filter((f) => dot(f.o, dN) * R > qA).map((f) => f.i));
  const back = ctx.progressive(m, hb, (ov) => (dot(ov, dN) * R < hingeBot ? [hb, hb] : null), (ov) => dot(ov, dN));
  return { back, dN, hingeN, hc, R, notchIdx };
}

/** The felling scenario of FM-10 (FM-11 with o.noNotch). Returns its measurements. */
async function fell(env, p, o = {}) {
  const ctx = await env.ctx();
  const m = ctx.stem(p.H, p.D, p.lean * DEG, 0);
  const st = ctx.trackSettle();
  await ctx.run(2);
  const psi = o.noNotch ? 0 : p.delta;
  const { back, dN, hingeN, hc, notchIdx } = await fellCuts(ctx, m, p, psi, o);
  const notchShut = (J) => [...J.contact].some((i) => notchIdx.has(i));
  let release = null, peakU = 0;
  ctx.hooks.push((c) => {
    const J = c.allJoints()[0];
    if (J && J.end < 0) peakU = Math.max(peakU, c.worstU().U);
    if (J && J.end >= 0 && release === null) {
      const d = m.dirOf(m.topPiece());
      release = { t: c.t, angle: d ? Math.acos(Math.min(1, Math.max(-1, d.y))) / DEG : null, notchClosed: notchShut(J) };
    }
  });
  await ctx.run(90, () => back.done);
  const fallFrom = ctx.stepMs.length;
  await ctx.run(25, () => m.top().p.y < 1.5 && ctx.trackSettle().settled);
  const piece = m.topPiece(), free = !ctx.world.pieces.get(piece).fixed && !held(ctx, piece);
  const d = m.dirOf(piece), heading = Math.atan2(d.z, d.x) / DEG;
  const J = ctx.allJoints()[0];
  const stump = lerp3(m.base, m.axis.map((a) => a * hc), 1), butt = m.butt(piece);
  const hz = norm([dN[0], 0, dN[2]]);
  const along = butt ? (butt.x - stump[0]) * hz[0] + (butt.z - stump[2]) * hz[2] : 0;
  return {
    ctx, free, heading: +heading.toFixed(2), err: +wrap(heading - psi).toFixed(2), psi,
    topY: +m.top().p.y.toFixed(3), settled: st.settled,
    backCutTime: +((back.end >= 0 ? back.end : ctx.tick) - back.start) * CFG.TICK,
    firstLive: J ? +((J.start - back.start) * CFG.TICK).toFixed(3) : null,
    hingeLife: J ? +(((J.end >= 0 ? J.end : ctx.tick) - J.start) * CFG.TICK).toFixed(3) : null,
    hingeReleased: !!(J && J.end >= 0),
    releaseAngle: release && release.angle !== null ? +release.angle.toFixed(2) : null,
    notchClosedBeforeRelease: release ? release.notchClosed : (J ? notchShut(J) : false), kerfContact: !!(J && J.closed),
    buttAlong: +along.toFixed(3),
    hingePlanned: hingeN, hingeStart: J ? J.startElastic : null, hingeSnapped: J ? J.snapped.length : null,
    hingeEnd: J ? (J.end >= 0 ? J.endElastic : null) : null,
    peakU: +peakU.toFixed(4), stepFall: ctx.stepStats(fallFrom), splits: ctx.splits.length,
  };
}

/** FM-04's ramped tip load (o.stopAtLive: stop as soon as the limb goes live; o.cap: hold the load at that). */
async function overload(env, p, o = {}) {
  const ctx = await env.ctx();
  const m = ctx.limb(p.L, p.D, 0);
  const Py = limbYield(p.L, p.D), Pmax = 2 * Math.max(Py, 50), t0 = ctx.t;
  const P = (c) => Math.min(o.cap ?? Infinity, Pmax * Math.min(1, (c.t - t0) / 10));
  ctx.addLoad(m, p.L, (c) => [0, -P(c), 0], { hang: true });
  let Plive = null, liveT = null, freeT = null, droopFree = null;
  const e0 = elev({ y: m.axis[1] });
  ctx.hooks.push((c) => {
    const J = c.allJoints()[0];
    if (J && Plive === null) { Plive = P(c); liveT = c.t; }
    if (J && freeT === null && !held(c, m.topPiece())) { freeT = c.t; const d = m.dirOf(m.topPiece()); droopFree = d ? e0 - elev(d) : null; }
  });
  return { ctx, m, Py, Pmax, P, get Plive() { return Plive; }, get liveT() { return liveT; }, get freeT() { return freeT; }, get droopFree() { return droopFree; } };
}

/** Grow a tree from the TREE_* settings (FM-40's scenario) and watch it for `T` s. */
async function standUp(env, T = 30) {
  const ctx = await env.ctx();
  ctx.sim.grow();
  const ids = ctx.treeSegs, w = ctx.world;
  const nTrunk = Math.min(ids.length, Math.max(1, Math.round(CFG.TREE_HEIGHT / Math.max(0.1, CFG.SEG_LEN))));
  const trunk = new Set(ids.slice(0, nTrunk));
  let total = 0; for (const id of ids) { const s = w.segs.get(id); total += segMass(s) + s.leaf; }
  const st = ctx.trackSettle();
  const info = { ctx, trunk, nTrunk, ids, total, lost: 0, trunkLive: false, maxPiece: 0, at10: null };
  const kind = (s) => (trunk.has(s.id) ? 'trunk' : s.r0 < 0.04 ? 'twig' : 'limb');
  const depth = (s) => { let d = 0; for (let x = s; x && x.parent >= 0; x = w.segs.get(x.parent)) d++; return d; };
  info.kind = kind;
  let seen = 0;
  const collapsed = () => info.trunkLive || info.lost >= 0.25 * total;
  ctx.hooks.push((c) => {
    for (; seen < c.splits.length; seen++) {
      const sp = c.splits[seen];
      if (!sp.fromFixed) continue;
      info.lost += sp.mass; info.maxPiece = Math.max(info.maxPiece, sp.mass);
      if (sp.live && trunk.has(sp.seg)) info.trunkLive = true;
      if (!info.first) { const s = w.segs.get(sp.seg); info.first = { t: +c.t.toFixed(3), kind: s ? kind(s) : '?', depth: s ? depth(s) : null, diam: s ? +(2 * s.r0).toFixed(3) : null }; }
    }
  });
  const rest = new Map(); for (const id of ids) rest.set(id, w.segs.get(id).b.slice());
  await ctx.run(Math.min(T, 10), collapsed);
  if (ctx.t >= 9.99) {
    const U = ctx.worstU(), flex = ctx.sim.structure.flex;
    let sag = 0;
    for (const s of w.segs.values()) {
      if (w.kids(s.id).length || trunk.has(s.id) || !w.pieces.get(s.piece)?.fixed || !rest.has(s.id)) continue;
      const p = frameApply(flex.at(s.id, 1), s.b), r = rest.get(s.id);
      let len = 0; for (let x = s; x && !trunk.has(x.id); x = w.segs.get(x.parent)) len += segLen(x);
      sag = Math.max(sag, Math.hypot(p[0] - r[0], p[1] - r[1], p[2] - r[2]) / Math.max(0.1, len));
    }
    info.at10 = { U: +U.U.toFixed(4), Ukind: U.seg >= 0 && w.segs.get(U.seg) ? kind(w.segs.get(U.seg)) : null, settled: st.settled, sagFrac: +sag.toFixed(4), splits: ctx.splits.length };
  }
  if (T > 10 && !collapsed()) await ctx.run(T - 10, collapsed);
  info.collapsed = collapsed();
  return info;
}

function treeMetrics(info) {
  const ctx = info.ctx, w = ctx.world, top = w.segs.get(info.ids[info.nTrunk - 1]);
  const fromFixed = ctx.splits.filter((s) => s.fromFixed);
  let grade;
  if (info.collapsed) grade = 'collapse';
  else if (!fromFixed.length) grade = info.at10 && info.at10.settled ? 'stable' : 'restless';
  else if (info.maxPiece < CFG.DEBRIS_MASS) grade = 'sheds';
  else grade = 'limb loss';
  const lean = top ? Math.acos(Math.min(1, top.b[1] / Math.hypot(top.b[0], top.b[1], top.b[2]))) / DEG : null;
  let limbs = 0; for (const id of info.ids) { const s = w.segs.get(id); if (s && info.trunk.has(s.parent) && !info.trunk.has(s.id)) limbs++; }
  return {
    grade, firstSplit: info.first || null, at10: info.at10, massLost: +info.lost.toFixed(2), totalMass: +info.total.toFixed(1),
    segs: info.ids.length, fibres: ctx.fibreCount(), capHit: info.ids.length >= CFG.SEG_CAP,
    step: ctx.stepStats(), lean: lean !== null ? +lean.toFixed(2) : null, limbs,
  };
}
const TREE_PARAMS = {
  TREE_HEIGHT: C('TREE_HEIGHT', [6, 18], [3, 30], 1, 'm'),
  TREE_DIAMETER: C('TREE_DIAMETER', [0.3, 0.8], [0.1, 1.5], 1, 'm'),
  BRANCH_DENSITY: C('BRANCH_DENSITY', [0.5, 1.5], [0, 3]),
  BRANCH_LENGTH: C('BRANCH_LENGTH', [0.6, 1.5], [0.2, 3]),
  FIBRE_PITCH: C('FIBRE_PITCH', [0.02, 0.04], [0.008, 0.1], 1, 'm'),
  GRID_MAX: C('GRID_MAX', [11, 21], [3, 25]),
  SEG_LEN: C('SEG_LEN', [0.4, 1.0], [0.15, 2], 1, 'm'),
  MOR: C('MOR', [25, 50], [2, 80], 1e6, 'MPa'),
  DENSITY: C('DENSITY', [600, 1000], [200, 1400], 1, 'kg/m³'),
  TENS_STRAIN: C('TENS_STRAIN', [0.004, 0.01], [0.0005, 0.1]),
  COMP_STRAIN: C('COMP_STRAIN', [0.006, 0.015], [0.0005, 0.1]),
};
const TREE_SEED = { key: 'TREE_SEED', must: Array.from({ length: 20 }, (_, i) => i + 1), explore: [1, 200] };
/** Slenderness (height / diameter) must stay in range; GRID_MAX must be odd. */
function fixTree(p, mode) {
  const [lo, hi] = mode === 'must' ? [15, 35] : [2, 400];
  p.TREE_DIAMETER = Math.min(Math.max(p.TREE_DIAMETER, p.TREE_HEIGHT / hi), p.TREE_HEIGHT / lo);
  p.GRID_MAX = Math.round(p.GRID_MAX); if (p.GRID_MAX % 2 === 0) p.GRID_MAX += 1;
  return p;
}

// ================= the tests =================
export const TESTS = [
  {
    id: 'FM-01', title: 'Cantilever sags as beam theory says', time: 10,
    params: { L: P([1.5, 6], [0.5, 10], 3, 'm'), D: P([0.06, 0.3], [0.03, 0.6], 0.12, 'm'), ...BEAM },
    async run(env, p) {
      const ctx = await env.ctx(), m = ctx.limb(p.L, p.D, 0), tip0 = m.top().p.clone(), st = ctx.trackSettle();
      await ctx.run(10, () => st.settled);
      const sag = tip0.y - m.top().p.y, c = { L: p.L, D: p.D, rho: CFG.DENSITY, g: g(), stubL: 0.5, stubD: 1.5 * p.D };
      const f = m.segs()[0].s.f;
      return {
        sag: +sag.toFixed(5), sagStiff: +cantilever({ ...c, E: Et() }).sag.toFixed(5), sagSoft: +cantilever({ ...c, E: Ec() }).sag.toFixed(5),
        sagBimodular: +cantilever({ ...c, Et: Et(), Ec: Ec() }).sag.toFixed(5),
        rootMaxT: f.maxT, rootMinC: f.minC, settleTime: st.settled ? +st.since.toFixed(2) : null, splits: ctx.splits.length,
      };
    },
    judge: (m) => [
      ge('sag >= stiff bound - 20%', m.sag, 0.8 * m.sagStiff), le('sag <= soft bound + 20%', m.sag, 1.2 * m.sagSoft),
      le('settles within 5 s', m.settleTime ?? Infinity, 5), is('no split', m.splits === 0, m.splits),
    ],
    view: (p) => ({ target: [p.L / 2, p.L + 1.5, 0], dist: p.L * 1.4 + 1, yaw: 0, pitch: 0 }),
  },
  {
    id: 'FM-02', title: 'Fibre stress matches beam theory at the root', time: 5,
    params: { L: P([1.5, 6], [0.5, 10], 3, 'm'), D: P([0.06, 0.3], [0.03, 0.6], 0.12, 'm'), Pfrac: P([0, 0.5], [0, 0.95], 0.3), ...BEAM },
    async run(env, p) {
      const ctx = await env.ctx(), m = ctx.limb(p.L, p.D, 0);
      const Py = limbYield(p.L, p.D), Ptop = p.Pfrac * Math.max(0, Py), lv = [0.2, 0.4, 0.6, 0.8, 1.0];
      let k = 0, tk = ctx.t;
      ctx.addLoad(m, p.L, (c) => { const a = k ? lv[k - 1] : 0, b = lv[k]; return [0, -Ptop * (a + (b - a) * Math.min(1, (c.t - tk) / 0.5)), 0]; });
      const steps = [];
      for (k = 0; k < lv.length; k++) { tk = ctx.t; await ctx.run(1); const f = m.segs()[0].s.f; steps.push([f.maxT, f.minC]); }
      const M = cantilever({ L: p.L, D: p.D, rho: CFG.DENSITY, g: g(), E: 1 }).Mself + Ptop * p.L, R = p.D / 2;
      const { c, EI } = bimodularCircle(R, Et(), Ec());
      const [maxT, minC] = steps[steps.length - 1], McI = edgeStress(M, R);
      let mono = true; for (let i = 1; i < steps.length; i++) if (steps[i][0] < steps[i - 1][0] * (1 - 1e-6) - 1) mono = false;
      return { P: +Ptop.toFixed(1), Py: +Py.toFixed(1), maxT, minC, McI, ratioT: maxT / McI, ratioC: -minC / McI,
        bimodT: Et() * M / EI * (R - c), bimodC: Ec() * M / EI * (R + c), monotonic: mono, levels: steps.map((s) => s[0]), splits: ctx.splits.length };
    },
    judge: (m) => [
      // the owner's call (FM-02 card): against the bimodular section, whose tension and compression stiffness
      // differ, not the symmetric M c / I
      ge('maxT >= 0.6 x bimodular', m.maxT / m.bimodT, 0.6), le('maxT <= 1.6 x bimodular', m.maxT / m.bimodT, 1.6),
      ge('|minC| >= 0.6 x bimodular', -m.minC / m.bimodC, 0.6), le('|minC| <= 1.6 x bimodular', -m.minC / m.bimodC, 1.6),
      is('maxT rises monotonically with P', m.monotonic), is('no split', m.splits === 0, m.splits),
    ],
    view: (p) => ({ target: [0, p.L + 1.5, 0], dist: 1.2, yaw: 0.6, pitch: 0.2 }),
  },
  {
    id: 'FM-03', title: 'A plain stem stands and settles', time: 15,
    params: {
      H: P([4, 20], [2, 35], 11, 'm'), D: P([0.2, 0.8], [0.05, 1.5], 0.5, 'm'), lean: P([0, 10], [0, 30], 5, '°'),
      SEG_LEN: C('SEG_LEN', [0.3, 1.0], [0.15, 2], 1, 'm'),
      FLEX_FREQ: C('FLEX_FREQ', [4.5, 13.5], [2, 30], 1, 'rad/s'), FLEX_DAMP: C('FLEX_DAMP', [0.175, 0.525], [0.05, 1.5]),
      TENS_STRAIN: BEAM.TENS_STRAIN, COMP_STRAIN: BEAM.COMP_STRAIN,
    },
    fix(p, mode) { const [lo, hi] = mode === 'must' ? [15, 60] : [5, 200]; p.D = Math.min(Math.max(p.D, p.H / hi), p.H / lo); return p; },
    async run(env, p) {
      const ctx = await env.ctx(), m = ctx.stem(p.H, p.D, p.lean * DEG, 0), top0 = m.top().p.clone(), st = ctx.trackSettle();
      let peak = 0;
      ctx.hooks.push(() => { peak = Math.max(peak, m.top().p.distanceTo(top0)); });
      await ctx.run(15, (c) => st.settled && c.t > st.since + 1);
      const rest = m.top().p.distanceTo(top0);
      return { rest: +rest.toFixed(5), restFrac: rest / p.H, peak: +peak.toFixed(5), U: ctx.worstU().U, settleTime: st.settled ? +st.since.toFixed(2) : null, splits: ctx.splits.length };
    },
    judge: (m) => [
      le('settles within 8 s', m.settleTime ?? Infinity, 8), le('extra lean at rest < 2% of H', m.restFrac, 0.02),
      le('peak overshoot < 3x resting displacement', m.peak, 3 * Math.max(m.rest, 0.001)), is('no split', m.splits === 0, m.splits), le('U < 0.5', m.U, 0.5),
    ],
    view: (p) => ({ target: [0, p.H / 2, 0], dist: p.H * 1.3, yaw: Math.PI / 2, pitch: 0 }),
  },
  {
    id: 'FM-04', title: 'Overload: breaks at the right load, in the right order', time: 20,
    params: {
      L: P([1.5, 5], [0.5, 10], 3, 'm'), D: P([0.06, 0.25], [0.03, 0.5], 0.12, 'm'), MOR: C('MOR', [20, 50], [2, 80], 1e6, 'MPa'),
      FIBRE_STRETCH: C('FIBRE_STRETCH', [0.01, 0.04], [0.002, 0.08], 1, 'm'), FIBRE_PITCH: C('FIBRE_PITCH', [0.02, 0.04], [0.008, 0.1], 1, 'm'),
    },
    async run(env, p) {
      const o = await overload(env, p), ctx = o.ctx;
      await ctx.run(20, (c) => o.freeT !== null && c.t > o.freeT + 1);
      const J = ctx.allJoints()[0];
      let first = null, rho = null, n = 0;
      if (J && J.snapped.length) {
        const lay = layout(J.j.N), R = J.j.R, up = (i) => (J.j.u[1] * lay.X[i] + J.j.v[1] * lay.Y[i]) * R;
        first = +up(J.snapped[0].i).toFixed(4); n = J.snapped.length;
        if (n >= 3) rho = spearman(J.snapped.map((s) => s.tick), J.snapped.map((s) => -up(s.i)));
      }
      return { Py: +o.Py.toFixed(1), Plive: o.Plive !== null ? +o.Plive.toFixed(1) : null, ratio: o.Plive !== null && o.Py > 0 ? o.Plive / o.Py : null,
        firstSnapHeight: first, spearman: rho !== null ? +rho.toFixed(3) : null, nSnapped: n, free: o.freeT !== null,
        liveToFree: o.freeT !== null && o.liveT !== null ? +(o.freeT - o.liveT).toFixed(3) : null, droopAtFree: o.droopFree !== null ? +o.droopFree.toFixed(1) : null };
    },
    judge: (m) => [
      ge('P_live >= 0.75 analytic', m.ratio ?? NaN, 0.75), le('P_live <= 1.25 analytic', m.ratio ?? NaN, 1.25),
      is('first fibre to snap is on the tension face', m.firstSnapHeight > 0, m.firstSnapHeight),
      m.nSnapped >= 3 ? ge('snap order follows tension-side distance (Spearman > 0.8)', m.spearman, 0.8) : is('snap order (fewer than 3 snapped: not judged)', true, m.nSnapped),
      is('limb comes free', m.free),
    ],
    view: (p) => ({ target: [p.L / 2, p.L + 1, 0], dist: p.L * 1.6 + 1, yaw: 0, pitch: 0.1 }),
  },
  {
    id: 'FM-05', title: 'Cracked but holding', time: 20,
    params: { k: P([1.0, 1.1], [1.0, 1.5], 1.05) },
    fixed: { ...LIMB0 },
    async run(env, p) {
      const a = await overload(env, p);
      await a.ctx.run(20, () => a.Plive !== null);
      if (a.Plive === null) return { Plive: null, held: true, settleAfterHold: 0, lateSnaps: 0, note: 'never went live under 2x the analytic load' };
      const cap = p.k * a.Plive, b = await overload(env, p, { cap }), ctx = b.ctx;
      let holdT = null, peak = 0, lastAbove = null;
      const ke = [];
      ctx.hooks.push((c) => {
        if (holdT === null && b.P(c) >= cap) holdT = c.t;
        const piece = b.m.topPiece(), body = c.sim.bodies.get(piece);
        let e = 0;
        if (body && !c.world.pieces.get(piece).fixed) { const v = body.linvel(), w = body.angvel(), M = body.mass(); e = 0.5 * M * (v.x ** 2 + v.y ** 2 + v.z ** 2) + 0.5 * M * (p.L / 2) ** 2 * (w.x ** 2 + w.y ** 2 + w.z ** 2); }
        ke.push([c.t, e]); peak = Math.max(peak, e);
      });
      await ctx.run(20);
      for (const [t, e] of ke) if (e > 0.01 * peak) lastAbove = t;
      const J = ctx.allJoints()[0], late = J ? J.snapped.filter((s) => s.tick * CFG.TICK > ctx.t - 5).length : 0;
      return { Plive: +a.Plive.toFixed(1), cap: +cap.toFixed(1), held: held(ctx, b.m.topPiece()), holdT, peakKE: +peak.toFixed(3),
        settleAfterHold: holdT !== null && lastAbove !== null ? +(lastAbove - holdT).toFixed(3) : 0, lateSnaps: late };
    },
    judge: (m) => [is('limb still held at the end', m.held), le('kinetic energy below 1% of peak within 5 s', m.settleAfterHold, 5), is('no fibre snaps in the last 5 s', m.lateSnaps === 0, m.lateSnaps)],
    view: () => ({ target: [1.5, 4, 0], dist: 5, yaw: 0, pitch: 0.1 }),
  },
  {
    id: 'FM-10', title: 'A notch steers a leaning trunk away from its lean', time: 40, interior: 48,
    params: {
      H: P([8, 20], [4, 30], FELL.H, 'm'), D: P([0.3, 0.7], [0.15, 1.2], FELL.D, 'm'), lean: P([0, 8], [0, 20], FELL.lean, '°'),
      delta: P(list(-30, -15, 0, 15, 30), [-90, 90], FELL.delta, '°'), alpha: P([45, 70], [20, 90], FELL.alpha, '°'),
      dn: P([0.2, 0.33], [0.1, 0.5], FELL.dn, '× D'), th: P([0.06, 0.12], [0, 0.3], FELL.th, '× D'),
      step: P([0, 0.03], [-0.05, 0.1], FELL.step, 'm'), hc: P([0.3, 1.0], [0.1, 1.5], FELL.hc, 'm'), ...WOOD,
    },
    fix(p, mode) { if (mode === 'must' && p.lean > 5 && Math.abs(p.delta) > 15) p.delta = Math.sign(p.delta) * 15; return p; },
    async run(env, p) { const m = await fell(env, p); delete m.ctx; return m; },
    judge: (m, p) => [
      is('came free and lies on the ground (top < 1.5 m)', m.free && m.topY < 1.5), is('settled at the end', m.settled),
      le('|e| <= 15°', Math.abs(m.err), 15),
      ...(p.delta ? [ge('turned from the lean by >= |Δ| - 15° on the notch side', Math.sign(p.delta) * m.heading, Math.abs(p.delta) - 15)] : []),
      ge('hinge life >= 0.5 s', m.hingeLife ?? NaN, 0.5), ge('hinge-release angle >= 10°', m.releaseAngle ?? NaN, 10),
      le('butt <= 1.5 m towards the notch', m.buttAlong, 1.5), le('butt <= 0.5 m back over the stump', -m.buttAlong, 0.5),
      le('step cost p95 <= 4 ms', m.stepFall.p95, 4),
    ],
    view: (p) => ({ target: [p.H / 4, p.H / 4, 0], dist: p.H * 1.2, yaw: Math.PI, pitch: 0.4, arrows: true }),
  },
  {
    id: 'FM-11', title: 'No notch: the trunk goes with its lean', time: 40,
    params: { lean: P([4, 10], [2, 20], 6, '°'), th: P([0.06, 0.12], [0, 0.3], FELL.th, '× D'), ...WOOD },
    fixed: { ...FELL },
    async run(env, p) { const m = await fell(env, p, { noNotch: true }); delete m.ctx; return m; },
    judge: (m) => [is('comes free', m.free), le('|heading - lean| <= 25°', Math.abs(m.err), 25)],
    view: (p) => ({ target: [p.H / 4, p.H / 4, 0], dist: p.H * 1.2, yaw: Math.PI, pitch: 0.4, arrows: true }),
  },
  {
    id: 'FM-12', title: 'Cutting into the lean pinches and the tree stands', time: 30,
    params: {
      lean: P([4, 10], [2, 20], 6, '°'), d: P([0.2, 0.5], [0.1, 0.8], 0.4, '× D'),
      COMP: WOOD.COMP, COMP_STRAIN: WOOD.COMP_STRAIN, KERF_CONTACT: C('KERF_CONTACT', [0.3, 0.7], [0.05, 1]),
    },
    fixed: { H: FELL.H, D: FELL.D, hc: FELL.hc },
    async run(env, p) {
      const ctx = await env.ctx(), m = ctx.stem(p.H, p.D, p.lean * DEG, 0), st = ctx.trackSettle();
      await ctx.run(2);
      const dL = perpTo([1, 0, 0], m.axis), R = m.R(p.hc), D = 2 * R;
      const back = ctx.progressive(m, p.hc, (o) => (dot(o, dL) * R > R - p.d * D ? [p.hc, p.hc] : null), (o) => -dot(o, dL));
      let pinchMax = 0, depthPinch = null, depthLive = null;
      const depth = () => (back.count ? R - (-back.list[back.count - 1].k) * R : 0);
      ctx.hooks.push((c) => {
        const s = m.segAt(p.hc).s, f = s.f, lay = layout(f.N), r = m.R(p.hc), Ek = CFG.KERF_CONTACT * Ec();
        let pinch = 0;
        for (let i = 0; i < f.n; i++) if (f.act[i]) pinch += Math.max(0, -Ek * (f.e0 + f.e1 * lay.X[i] * r + f.e2 * lay.Y[i] * r)) * lay.dA * r * r;
        pinchMax = Math.max(pinchMax, pinch);
        if (depthPinch === null && pinch > CFG.PINCH_STUCK) depthPinch = depth();
        if (depthLive === null && c.allJoints().length) depthLive = depth();
      });
      await ctx.run(90, () => back.done);
      await ctx.run(10);
      const f = m.segAt(p.hc).s.f;
      return { closed: !!f.closed, pinchMax: +pinchMax.toFixed(1), depthPinch: depthPinch !== null ? +(depthPinch / D).toFixed(3) : null,
        depthLive: depthLive !== null ? +(depthLive / D).toFixed(3) : null, splits: ctx.splits.length, settled: st.settled, U: ctx.worstU().U };
    },
    judge: (m) => [
      is('kerf reported closed', m.closed), le('pinch > PINCH_STUCK before the cut reaches 0.5 D (depth / D)', m.depthPinch ?? NaN, 0.5),
      is('no split', m.splits === 0, m.splits), is('settles', m.settled),
    ],
    view: (p) => ({ target: [0, 1, 0], dist: 3, yaw: -Math.PI / 2, pitch: 0.2 }),
  },
  {
    id: 'FM-13', title: 'A thicker hinge holds longer (monotonic)', time: 160, grid: true,
    params: { FIBRE_STRETCH: C('FIBRE_STRETCH', list(0.015, 0.0275, 0.04), [0.002, 0.08], 1, 'm'), FIBRE_PITCH: C('FIBRE_PITCH', list(0.02, 0.03, 0.04), [0.008, 0.1], 1, 'm') },
    fixed: { ...FELL },
    async run(env, p) {
      const out = [];
      for (const rows of [1, 2, 3, 4]) { const m = await fell(env, p, { rows }); out.push({ rows, angle: m.releaseAngle, life: m.hingeLife }); }
      let dec = true; for (let i = 1; i < out.length; i++) if (!(out[i].angle < out[i - 1].angle)) dec = false;
      return { byRows: out, decreasing: dec, oneRow: out[0].angle };
    },
    judge: (m) => [is('hinge-release angle decreases as the hinge thickens', m.decreasing), ge('1-row hinge folds to at least 20°', m.oneRow ?? NaN, 20)],
    view: () => ({ target: [0, 3, 0], dist: 14, yaw: -Math.PI / 2, pitch: 0.35 }),
  },
  {
    id: 'FM-14', title: 'Top cut only: the limb hangs on a strap', time: 15,
    params: { L: P([2, 5], [0.5, 10], 3, 'm'), D: P([0.08, 0.25], [0.03, 0.5], 0.12, 'm'), angle: P([0, 30], [-20, 60], 10, '°'), t: P([0.1, 0.3], [0, 0.6], 0.2, '× D'),
      MOR: C('MOR', [20, 50], [2, 80], 1e6, 'MPa'), FIBRE_STRETCH: C('FIBRE_STRETCH', [0.01, 0.04], [0.002, 0.08], 1, 'm'), FIBRE_PITCH: C('FIBRE_PITCH', [0.02, 0.04], [0.008, 0.1], 1, 'm') },
    async run(env, p) {
      const ctx = await env.ctx(), m = ctx.limb(p.L, p.D, p.angle * DEG), x = Math.min(0.4, p.L / 3), R = m.R(x);
      const up = perpTo([0, 1, 0], m.axis), e0 = elev({ y: m.axis[1] });
      await ctx.run(1);
      const sawn = m.cut((o) => (dot(o, up) * R > -R + p.t * 2 * R ? [x, x] : null));
      let liveT = null, reachT = null, freeT = null, droop = 0;
      ctx.hooks.push((c) => {
        const piece = m.topPiece(), h = held(c, piece);
        if (liveT === null && c.allJoints().length) liveT = c.t;
        if (!c.world.pieces.get(piece).fixed && !h && freeT === null) freeT = c.t;
        if (h) { const d = m.dirOf(piece); if (d) { droop = Math.max(droop, e0 - elev(d)); if (reachT === null && e0 - elev(d) >= 45 + p.angle) reachT = c.t; } }
      });
      await ctx.run(15, (c) => freeT !== null && c.t > freeT + 1);
      const torn = ctx.allJoints().reduce((s, J) => s + J.snapped.length, 0);
      return { wentLive: liveT !== null, liveAfterCut: liveT !== null ? +(liveT - 1).toFixed(3) : null, peakDroop: +droop.toFixed(1),
        reachT, heldAfterReach: reachT !== null ? +((freeT ?? ctx.t) - reachT).toFixed(3) : null, free: freeT !== null, freeT, torn, sawn };
    },
    judge: (m, p) => [is('limb goes live', m.wentLive), ge(`droops >= 45° + angle (${45 + p.angle}°) while held`, m.peakDroop, 45 + p.angle), ge('strap holds >= 1 s after that droop', m.heldAfterReach ?? NaN, 1)],
    view: (p) => ({ target: [p.L / 3, p.L + 1, 0], dist: p.L * 1.6 + 1, yaw: 0, pitch: 0.1 }),
  },
  {
    id: 'FM-15', title: 'Undercut then top cut: a clean part', time: 10,
    params: { L: P([2, 5], [0.5, 10], 3, 'm'), D: P([0.08, 0.25], [0.03, 0.5], 0.12, 'm'), angle: P([0, 30], [-20, 60], 10, '°'), u: P([0.2, 0.35], [0.05, 0.7], 0.25, '× D'),
      MOR: C('MOR', [20, 50], [2, 80], 1e6, 'MPa'), FIBRE_STRETCH: C('FIBRE_STRETCH', [0.01, 0.04], [0.002, 0.08], 1, 'm'), FIBRE_PITCH: C('FIBRE_PITCH', [0.02, 0.04], [0.008, 0.1], 1, 'm') },
    async run(env, p) {
      const ctx = await env.ctx(), m = ctx.limb(p.L, p.D, p.angle * DEG), x = Math.min(0.4, p.L / 3), R = m.R(x), up = perpTo([0, 1, 0], m.axis);
      await ctx.run(1);
      const cutSeg = m.segAt(x).s, n = cutSeg.f.n;
      let sawn = m.cut((o) => (dot(o, up) * R < -R + p.u * 2 * R ? [x, x] : null));
      await ctx.run(0.5);
      const xt = x + 0.05, top = ctx.progressive(m, xt, (o) => (dot(o, up) * R >= -R + p.u * 2 * R ? [xt, xt] : null), (o) => -dot(o, up));
      let freeT = null;
      ctx.hooks.push((c) => { const piece = m.topPiece(); if (freeT === null && !c.world.pieces.get(piece).fixed && !held(c, piece)) freeT = c.t; });
      await ctx.run(60, () => top.done && (freeT !== null || ctx.t > top.end * CFG.TICK + 0.6));
      await ctx.run(10, (c) => freeT !== null && c.t > freeT + 1);
      sawn += top.count;
      const js = ctx.allJoints(), torn = js.reduce((s, J) => s + J.snapped.length, 0);
      const other = js.filter((J) => J.parentSeg !== cutSeg.id && J.rootSeg !== cutSeg.id).reduce((s, J) => s + J.snapped.length, 0);
      return { free: freeT !== null, heldAfterTopCut: freeT !== null ? +(freeT - top.end * CFG.TICK).toFixed(3) : null, torn, tornFrac: torn / n, sawn, otherSnapped: other, wentLive: js.length > 0 };
    },
    judge: (m) => [le('comes free within 0.5 s of the top cut', m.heldAfterTopCut ?? NaN, 0.5), le('torn fibres <= 10% of the bundle', m.tornFrac, 0.1), is('no fibre snaps on another segment', m.otherSnapped === 0, m.otherSnapped)],
    view: (p) => ({ target: [0.4, p.L + 1.5, 0], dist: 2, yaw: 0.5, pitch: 0.1 }),
  },
  {
    id: 'FM-16', title: 'Straight through: free, no launch', time: 20,
    params: { H: P([4, 20], [2, 35], 11, 'm'), D: P([0.2, 0.8], [0.05, 1.5], 0.5, 'm'), lean: P([0, 10], [0, 30], 5, '°') },
    fix(p) { p.D = Math.min(Math.max(p.D, p.H / 200), p.H / 5); return p; },
    async run(env, p) {
      const ctx = await env.ctx(), m = ctx.stem(p.H, p.D, p.lean * DEG, 0), st = ctx.trackSettle();
      await ctx.run(1);
      const hc = 0.5;
      m.cut(() => [hc, hc]);
      // The owner's call (FM-16 card): a stem balanced on its stump gets a small push. Half a second after the
      // cut, a level push at the top, the way it leans (+x), ramping up by 2 % of the stem's weight per
      // second, and let go once it tilts 10° past its lean: the least push that tips it (a rocking stem that
      // swings back is pushed again).
      const t0 = ctx.t + 0.5, Wt = m.segs().reduce((a, e) => a + segMass(e.s), 0) * CFG.GRAVITY;
      let pushing = true, pushPeak = 0;
      ctx.hooks.push((c) => {
        if (!pushing || c.t < t0) return;
        const tp = m.top();
        const d = m.dirOf(m.topPiece()), tilt = d ? Math.acos(Math.max(-1, Math.min(1, d.y / Math.hypot(d.x, d.y, d.z)))) / DEG : 0;
        if (tilt > p.lean + 10 || tp.p.y < 1.5) { pushing = false; return; }
        const F = 0.02 * Wt * (c.t - t0); pushPeak = F;
        c.sim.applyForce(tp.seg.id, tp.p, { x: F, y: 0, z: 0 });
      });
      await ctx.run(20, () => m.top().p.y < 1.5 && st.settled);
      const piece = m.topPiece(), d = m.dirOf(piece), heading = d ? Math.atan2(d.z, d.x) / DEG : null, butt = m.butt(piece);
      const stump = m.axis.map((a) => a * hc);
      return { splits: ctx.splits.length, clean: ctx.splits.length > 0 && !ctx.splits[0].live, topY: +m.top().p.y.toFixed(3), heading,
        slide: butt ? +Math.hypot(butt.x - stump[0], butt.z - stump[2]).toFixed(3) : null, pushPeak: +pushPeak.toFixed(1), pushOfWeight: +(pushPeak / Wt).toFixed(4) };
    },
    judge: (m, p) => [
      is('one clean split', m.splits === 1 && m.clean, m.splits), le('falls (top < 1.5 m)', m.topY, 1.5),
      ...(p.lean >= 3 ? [le('falls within 30° of the lean', Math.abs(wrap(m.heading ?? 180)), 30)] : []),
      le('butt slides <= 2 m', m.slide ?? NaN, 2),
    ],
    view: (p) => ({ target: [0, p.H / 3, 0], dist: p.H * 1.4, yaw: -Math.PI / 2, pitch: 0.35 }),
  },
  {
    // The owner's (2026-11-23): a dead-straight stem cut dead level has nothing to tip it over.
    id: 'FM-17', title: 'Straight stem, level cut: it stands', time: 20,
    params: { H: P([4, 20], [2, 35], 11, 'm'), D: P([0.2, 0.8], [0.05, 1.5], 0.5, 'm') },
    fix(p) { p.D = Math.min(Math.max(p.D, p.H / 200), p.H / 5); return p; },
    async run(env, p) {
      const ctx = await env.ctx(), m = ctx.stem(p.H, p.D, 0, 0);
      await ctx.run(1);
      const hc = 0.5, top0 = m.top().p.clone();
      m.cut(() => [hc, hc]);
      await ctx.run(20);
      const t = m.top().p;
      return { splits: ctx.splits.length, clean: ctx.splits.length > 0 && !ctx.splits[0].live, topY: +t.y.toFixed(3), H: p.H,
        drift: +Math.hypot(t.x - top0.x, t.z - top0.z).toFixed(4) };
    },
    judge: (m) => [is('one clean split', m.splits === 1 && m.clean, m.splits), ge('still standing (top >= 0.95 H)', m.topY / m.H, 0.95), le('top drifts < 0.1 m', m.drift, 0.1)],
    view: (p) => ({ target: [0, p.H / 3, 0], dist: p.H * 1.4, yaw: -Math.PI / 2, pitch: 0.35 }),
  },
  {
    // The owner's (2026-11-23): a notch alone, deepened step by step, takes away wood on one side, so the
    // wood above should sit off-centre on what is left and lean the notch's way before anything lets go.
    // Four notch directions, each in its own world.
    id: 'FM-18', title: 'Straight stem, notch only: it leans into the notch (4 directions)', time: 160,
    params: { H: P([4, 20], [2, 35], 11, 'm'), D: P([0.2, 0.8], [0.05, 1.5], 0.5, 'm'), alpha: P([45, 70], [30, 90], 55, '°') },
    fix(p) { p.D = Math.min(Math.max(p.D, p.H / 200), p.H / 5); return p; },
    async run(env, p) {
      const out = [];
      for (const psi of [0, 90, 180, 270]) {
        const ctx = await env.ctx(), m = ctx.stem(p.H, p.D, 0, 0);
        await ctx.run(1);
        const hc = 0.5, R = m.R(hc), tanA = Math.tan(p.alpha * DEG), dN = perpTo([Math.cos(psi * DEG), 0, Math.sin(psi * DEG)], m.axis);
        const top0 = m.top().p.clone(), lean = () => { const t = m.top().p; return [t.x - top0.x, t.z - top0.z]; };
        let rel = null, before = null, depth = 0;
        for (let dn = 0.05; dn <= 0.9 + 1e-9 && rel === null; dn += 0.05) {
          const qA = R - dn * 2 * R;
          m.cut((ov) => { const q = dot(ov, dN) * R; return q > qA ? [hc, hc + (q - qA) * tanA] : null; });
          await ctx.run(1);
          if (ctx.splits.length) { rel = { dn: +dn.toFixed(2), lean: lean() }; break; }
          before = lean(); depth = dn;
        }
        await ctx.run(rel ? 10 : 0);
        const d = m.dirOf(m.topPiece()), fell = d ? Math.atan2(d.z, d.x) / DEG : null;
        const head = (v) => (v && Math.hypot(v[0], v[1]) > 1e-6 ? Math.atan2(v[1], v[0]) / DEG : null);
        out.push({ psi, depthBefore: +depth.toFixed(2), leanBefore: before ? +Math.hypot(before[0], before[1]).toFixed(5) : 0,
          headingBefore: head(before), releaseDepth: rel ? rel.dn : null, fellHeading: rel && d && d.y < 0.7 ? +fell.toFixed(1) : null });
      }
      return { dirs: out };
    },
    judge: (m) => m.dirs.flatMap((o) => [
      ge(`notch at ${o.psi}°: leans before release (> 1 mm)`, o.leanBefore, 0.001),
      le(`notch at ${o.psi}°: leans toward the notch (within 30°)`, Math.abs(wrap((o.headingBefore ?? o.psi + 180) - o.psi)), 30),
    ]),
    view: (p) => ({ target: [0, p.H / 3, 0], dist: p.H * 1.4, yaw: -Math.PI / 2, pitch: 0.35 }),
  },
  {
    // The owner's (2026-11-23): a hard-leaning trunk with a shallow notch, back-cut straight in from behind,
    // splits up the stem ahead of the saw (a barber chair). Nothing in the engine knows about barber chairs:
    // a lengthwise split happens wherever severed fibres leave more shear along the grain than the wood can
    // carry (DECISIONS D50). The control is FM-10's ordinary fell, which must not split.
    id: 'FM-19', title: 'Barber chair: a hard lean back-cut without a proper notch splits up the stem', time: 60,
    params: {
      lean: P([15, 25], [8, 35], 20, '°'), dn: P([0.05, 0.12], [0, 0.2], 0.1, '× D'),
      H: P([12, 20], [6, 30], 15, 'm'), D: P([0.4, 0.7], [0.2, 1.2], 0.5, 'm'),
    },
    async run(env, p) {
      const out = {};
      // the control first, so the viewer ends on the barber chair
      for (const [k, q, o] of [['control', { ...FELL }, {}], ['chair', { ...FELL, ...p, step: 0 }, p.dn > 0 ? {} : { noNotch: true }]]) {
        const ctx = await env.ctx(), m = ctx.stem(q.H, q.D, q.lean * DEG, 0);
        await ctx.run(2);
        const { back } = await fellCuts(ctx, m, q, 0, o);
        let backAtRip = null;
        ctx.hooks.push((c) => { if (backAtRip === null && c.rips.length) backAtRip = back.count; });
        await ctx.run(90, () => back.done || (ctx.rips.length && ctx.t > ctx.rips[0].tick * CFG.TICK + 5));
        await ctx.run(5);
        const hc = q.hc, rise = ctx.rips.length ? Math.max(...ctx.rips.map((r) => r.hi)) - hc : 0;
        out[k] = { rips: ctx.rips.length, rise: +rise.toFixed(2), backDone: !!back.done, backAtRip, backN: back.list.length };
      }
      return out;
    },
    judge: (m) => [
      ge('barber chair: the stem splits lengthwise >= 1 m above the cut (m)', m.chair.rise, 1),
      is('barber chair: it splits before the back cut is finished', !m.chair.backDone || m.chair.backAtRip !== null),
      is('control (FM-10 defaults): no lengthwise split', m.control.rips === 0, m.control.rips),
    ],
    view: (p) => ({ target: [0.5, 2, 0], dist: 8, yaw: 0, pitch: 0.2 }),      // side on to the lean
  },
  {
    id: 'FM-20', title: 'Results do not depend on the discretisation', time: 500,
    params: {},
    async run(env) {
      const fells = [], lives = [];
      for (const SEG_LEN of [0.3, 0.5, 0.8]) for (const FIBRE_PITCH of [0.02, 0.03, 0.04]) {
        Object.assign(CFG, { SEG_LEN, FIBRE_PITCH });
        const f = await fell(env, FELL); fells.push({ SEG_LEN, FIBRE_PITCH, heading: f.heading, releaseAngle: f.releaseAngle });
        const o = await overload(env, LIMB0); await o.ctx.run(20, () => o.Plive !== null); lives.push(o.Plive);
      }
      Object.assign(CFG, { SEG_LEN: CFG_DEFAULTS.SEG_LEN, FIBRE_PITCH: CFG_DEFAULTS.FIBRE_PITCH });
      const spread = (a) => Math.max(...a) - Math.min(...a), med = (a) => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };
      const hs = fells.map((f) => f.heading), ra = fells.map((f) => f.releaseAngle);
      const angSpread = Math.max(...hs.map((h) => Math.max(...hs.map((k) => Math.abs(wrap(h - k))))));
      return { runs: fells, Plive: lives, headingSpread: +angSpread.toFixed(2),
        releaseSpreadFrac: ra.every(Number.isFinite) ? spread(ra) / med(ra) : null, PliveSpreadFrac: lives.every(Number.isFinite) ? spread(lives) / med(lives) : null };
    },
    judge: (m) => [le('heading spread <= 10°', m.headingSpread, 10), le('hinge-release angle spread <= 50% of median', m.releaseSpreadFrac ?? NaN, 0.5), le('P_live spread <= 20% of median', m.PliveSpreadFrac ?? NaN, 0.2)],
    view: () => ({ target: [0, 3, 0], dist: 14, yaw: -Math.PI / 2, pitch: 0.35 }),
  },
  {
    id: 'FM-21', title: 'Same input, same result', time: 140,
    params: {},
    async run(env) {
      const digest = (ctx) => {
        const bodies = {};
        for (const [id, b] of ctx.sim.bodies) { const t = b.translation(), q = b.rotation(); bodies[id] = [t.x, t.y, t.z, q.x, q.y, q.z, q.w]; }
        return { hash: ctx.evHash, count: ctx.evCount, ticks: ctx.tick, bodies };
      };
      const runs = { fell: [], tree: [] };
      for (let k = 0; k < 2; k++) { const f = await fell(env, FELL); runs.fell.push(digest(f.ctx)); const t = await standUp(env, 30); runs.tree.push(digest(t.ctx)); }
      const cmp = ([a, b]) => {
        const ids = new Set([...Object.keys(a.bodies), ...Object.keys(b.bodies)]);
        let worst = 0, missing = 0;
        for (const id of ids) { const x = a.bodies[id], y = b.bodies[id]; if (!x || !y) { missing++; continue; } for (let i = 0; i < 7; i++) worst = Math.max(worst, Math.abs(x[i] - y[i])); }
        return { sameEvents: a.hash === b.hash && a.count === b.count && a.ticks === b.ticks, worst, missing, events: a.count };
      };
      return { fell: cmp(runs.fell), tree: cmp(runs.tree), note: 'each run in a fresh World and Rapier world, one after the other in the same worker' };
    },
    judge: (m) => [
      is('FM-10: identical event log', m.fell.sameEvents), le('FM-10: final transforms equal (1e-6)', m.fell.missing ? Infinity : m.fell.worst, 1e-6),
      is('FM-40: identical event log', m.tree.sameEvents), le('FM-40: final transforms equal (1e-6)', m.tree.missing ? Infinity : m.tree.worst, 1e-6),
    ],
    view: () => ({ target: [0, 3, 0], dist: 14, yaw: -Math.PI / 2, pitch: 0.35 }),
  },
  {
    id: 'FM-22', title: 'Step cost stays in budget', time: 60, alone: true,
    params: {},
    async run(env) {
      const ctx = await env.ctx();
      ctx.sim.grow();
      await ctx.run(10);
      const idle = ctx.stepStats(), w = ctx.world, ids = ctx.treeSegs;
      const nTrunk = Math.max(1, Math.round(CFG.TREE_HEIGHT / Math.max(0.1, CFG.SEG_LEN))), s0 = w.segs.get(ids[0]), top = w.segs.get(ids[nTrunk - 1]);
      const m = new Member(ctx, s0.a, segAxis(s0), segLen(s0), s0.r0, s0.r1);
      const az = Math.atan2(top.b[2], top.b[0]) / DEG;
      const { back } = await fellCuts(ctx, m, { ...FELL, hc: Math.min(FELL.hc, segLen(s0) * 0.5) }, az);
      await ctx.run(90, () => back.done);
      const from = ctx.stepMs.length;
      await ctx.run(20);
      return { idle, falling: ctx.stepStats(from), segs: w.segs.size, fibres: ctx.fibreCount(), fell: ctx.splits.length > 0 };
    },
    judge: (m) => [le('idle step p95 <= 1 ms', m.idle.p95, 1), le('falling step p95 <= 4 ms', m.falling.p95, 4)],
    view: () => ({ target: [0, 5, 0], dist: 18, yaw: -0.8, pitch: 0.3 }),
  },
  {
    id: 'FM-40', title: 'A generated tree stands up', time: 30, exploreN: 2000, seed: TREE_SEED,
    params: TREE_PARAMS, fix: fixTree,
    maps: [['TREE_HEIGHT', 'TREE_DIAMETER'], ['BRANCH_DENSITY', 'BRANCH_LENGTH'], ['MOR', 'DENSITY']],
    async run(env) { const info = await standUp(env, 30); return treeMetrics(info); },
    judge: (m) => [is('grade is stable', m.grade === 'stable', m.grade), le('U < 0.7 at 10 s', m.at10 ? m.at10.U : NaN, 0.7), is('SEG_CAP not hit', !m.capHit, m.segs)],
    view: (p) => ({ target: [0, p.TREE_HEIGHT * 0.55, 0], dist: p.TREE_HEIGHT * 1.6, yaw: -0.8, pitch: 0.25 }),
  },
  {
    id: 'FM-41', title: 'A generated tree can be climbed', time: 120, seed: TREE_SEED,
    params: TREE_PARAMS, fix: fixTree,
    async run(env) {
      const info = await standUp(env, 10), base = treeMetrics(info), ctx = info.ctx, w = ctx.world;
      if (base.grade !== 'stable') return { skip: `tree graded ${base.grade} before loading`, grade: base.grade };
      const limbs = [];
      for (const id of info.ids) { const s = w.segs.get(id); if (s && info.trunk.has(s.parent) && !info.trunk.has(id)) limbs.push(id); }
      const F = CFG.P_MASS * CFG.GRAVITY * CFG.CLIMB_BOUNCE, out = [];
      for (const root of limbs) {
        if (!w.segs.has(root) || !w.pieces.get(w.segs.get(root).piece)?.fixed) continue;
        const chain = [root]; for (;;) { const k = w.kids(chain[chain.length - 1]).find((x) => x === chain[chain.length - 1] + 1); if (k === undefined) break; chain.push(k); }
        const len = chain.reduce((a, id) => a + segLen(w.segs.get(id)), 0);
        let acc = 0, at = null;
        for (const id of chain) { const s = w.segs.get(id), l = segLen(s); if (acc + l >= len * 2 / 3) { at = { s, p: lerp3(s.a, s.b, (len * 2 / 3 - acc) / l) }; break; } acc += l; }
        const sub = new Set(w.subtree(root)), from = ctx.splits.length;
        const load = ctx.addLoadAt(() => (w.segs.has(at.s.id) ? at : null), () => [0, -F, 0]);
        let U = 0; const hook = (c) => { U = Math.max(U, c.worstU().U); }; ctx.hooks.push(hook);
        await ctx.run(3);
        load.on = false; ctx.hooks = ctx.hooks.filter((h) => h !== hook);
        const live = ctx.splits.slice(from).some((sp) => sub.has(sp.seg));
        out.push({ seg: root, diam: +(2 * w.segs.get(root).r0).toFixed(3), U: +U.toFixed(3), live });
        await ctx.run(1);
      }
      const thick = out.filter((l) => l.diam >= 0.12), thin = out.filter((l) => l.diam < 0.12);
      return { limbs: out, thickLive: thick.filter((l) => l.live).length, thinLiveFrac: thin.length ? thin.filter((l) => l.live).length / thin.length : 0 };
    },
    judge: (m) => [is('no limb >= 0.12 m goes live under a climber', m.thickLive === 0, m.thickLive)],
    view: (p) => ({ target: [0, p.TREE_HEIGHT * 0.55, 0], dist: p.TREE_HEIGHT * 1.6, yaw: -0.8, pitch: 0.25 }),
  },
  {
    id: 'FM-42', title: 'Generator output is well formed', time: 0, seed: TREE_SEED,
    params: TREE_PARAMS, fix: fixTree,
    async run() {
      let n = 0;
      const segs = generateTree(CFG.TREE_SEED, () => ++n), again = (() => { let k = 0; return generateTree(CFG.TREE_SEED, () => ++k); })();
      const pos = new Map(segs.map((s, i) => [s.id, i]));
      let order = true, roots = 0, radii = true, lengths = true, grids = true, maxSub = 0;
      const kids = new Map();
      for (const [i, s] of segs.entries()) {
        if (s.parent < 0) roots++; else { if (!(pos.get(s.parent) < i)) order = false; let k = kids.get(s.parent); if (!k) kids.set(s.parent, k = []); k.push(s.id); }
        if (!(s.r0 > 0 && s.r1 > 0)) radii = false;
        if (!(Math.hypot(s.b[0] - s.a[0], s.b[1] - s.a[1], s.b[2] - s.a[2]) > 0.05)) lengths = false;
        if (!(s.N % 2 === 1 && s.N >= 3 && s.N <= CFG.GRID_MAX && s.N === gridFor(s.r0))) grids = false;
      }
      const nTrunk = Math.max(1, Math.round(CFG.TREE_HEIGHT / Math.max(0.1, CFG.SEG_LEN))), trunk = new Set(segs.slice(0, nTrunk).map((s) => s.id));
      const size = (id) => { let c = 1; for (const k of kids.get(id) || []) c += size(k); return c; };
      for (const s of segs) if (trunk.has(s.parent) && !trunk.has(s.id)) maxSub = Math.max(maxSub, size(s.id));
      return { segs: segs.length, order, roots, radii, lengths, grids, capOk: segs.length <= CFG.SEG_CAP + maxSub, deterministic: JSON.stringify(segs) === JSON.stringify(again) };
    },
    judge: (m) => [
      is('parents come before children and exist', m.order), is('exactly one root', m.roots === 1, m.roots), is('every r0, r1 > 0', m.radii),
      is('every segment longer than 5 cm', m.lengths), is('N odd, 3 <= N <= GRID_MAX, = gridFor(r0)', m.grids), is('segment count <= SEG_CAP + one limb', m.capOk, m.segs),
      is('same seed and settings give the same segments', m.deterministic),
    ],
  },
];

export const TEST_BY_ID = new Map(TESTS.map((t) => [t.id, t]));
