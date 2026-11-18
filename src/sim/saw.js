// Chainsaw. Raising it plants the bar on the wood being looked at, lying
// across the stem. The look controls pivot it about that planted point;
// throttle presses it forward, carrying the point with it. Wood stops the bar:
// it rests against the fibres in its way and the chain works through them at
// CUT_RATE. There is no "cut" object - only fibres that have been severed,
// each remembering where. Host only. See docs/DESIGN.md 4.

import * as THREE from 'three';
import { CFG, MODE } from '../config.js';
import { segLen, segAxis, segParam, lerp3, lanyardLoop } from '../model/world.js';
import { bundleBasis, layout, INTACT, CUT } from '../model/fibres.js';
import { frameInverse } from '../model/flex.js';

const _h = new THREE.Vector3(), _d = new THREE.Vector3(), _d0 = new THREE.Vector3(), _d1 = new THREE.Vector3();
const _c0 = new THREE.Vector3(), _c1 = new THREE.Vector3(), _p = new THREE.Vector3(), _q = new THREE.Vector3();

export function sawOff(sim, p) { p.saw = { on: false }; }

function rotate(v, ax, ang) { return v.applyAxisAngle(ax, ang); }

export function sawStep(sim, p, inp, dt, can, aim) {
  let sw = p.saw;
  if (!can || inp.lt < 0.3) { if (sw.on) sawOff(sim, p); return; }
  const { o } = sim.eye(p);

  if (!sw.on) {
    // Plant the bar on the wood being looked at: lying across the stem, square to it, ready to feed straight in.
    const { d } = sim.eye(p);
    let A = null, f = null, b = null;
    if (aim && aim.dist <= CFG.SAW_REACH) {
      const s = sim.world.segs.get(aim.seg), ax = sim.segDirToWorld(s, segAxis(s), new THREE.Vector3());
      const loc = sim.segToLocal(s, aim.point), t = Math.min(1, Math.max(0, segParam(s, loc)));
      f = sim.segToWorld(s, lerp3(s.a, s.b, t), new THREE.Vector3()).sub(aim.point);
      f.addScaledVector(ax, -f.dot(ax));                                            // feed: from the bark toward the heart
      if (f.lengthSq() > 1e-8) { f.normalize(); b = new THREE.Vector3().crossVectors(ax, f).normalize(); A = aim.point.clone().addScaledVector(f, -0.02); }
    }
    if (!A) {
      // no wood there: a rope or lanyard being looked at will do (bar across it, feeding away from the eye)
      const end = o.clone().addScaledVector(d, CFG.SAW_REACH);
      for (const [p0, p1] of ropeSpans(sim)) {
        const r = segDist(o, end, p0, p1);
        if (r.d < 0.1 && r.s > 0.1) {
          f = d.clone(); b = new THREE.Vector3().crossVectors(_p.copy(p1).sub(p0).normalize(), f);
          if (b.lengthSq() < 1e-4) continue;
          b.normalize(); f.crossVectors(b, _p).normalize(); if (f.dot(d) < 0) f.negate();
          A = p0.clone().lerp(p1, r.t).addScaledVector(f, -0.06); break;
        }
      }
    }
    if (!A) { p.prompt = 'Look at wood (or a rope) within reach, then {raise} to plant the bar on it'; return; }
    if (b.x * Math.cos(inp.yaw) - b.z * Math.sin(inp.yaw) > 0) b.negate();          // powerhead on the player's right
    sw = p.saw = { on: true, A, b, f, sy: inp.sy, sp: inp.sp, stuck: false, cutting: false, prog: new Map(), ropeT: 0 };
  }
  if (sw.A.distanceTo(o) > CFG.SAW_REACH + 0.7) { sawOff(sim, p); return; }      // walked away from it

  const half = CFG.BAR_LEN / 2, run = inp.rt > 0.05;
  const blockers = [];
  let pinch = 0;
  // 1. pivot about the planted point: swing in the plane of the cut, and tilt that plane
  let dy = inp.sy - sw.sy, dp = inp.sp - sw.sp;
  sw.sy = inp.sy; sw.sp = inp.sp;
  const lim = 0.02 / half; dy = Math.max(-lim, Math.min(lim, dy)); dp = Math.max(-lim, Math.min(lim, dp));
  if (dy || dp) {
    const n = _d.crossVectors(sw.b, sw.f), up = n.y >= 0 ? 1 : -1;
    const b2 = rotate(_d0.copy(sw.b), n, dy * up), f2 = rotate(_d1.copy(sw.f), n, dy * up);
    rotate(f2, b2, dp * up);
    const res = probe(sim, _c0.copy(sw.A).addScaledVector(b2, -half), _c1.copy(sw.A).addScaledVector(b2, half));
    if (!res.block.length) { sw.b.copy(b2).normalize(); sw.f.copy(f2).addScaledVector(sw.b, -f2.dot(sw.b)).normalize(); }
    else blockers.push(...res.block);
    pinch = res.pinch;
  }
  // 2. throttle presses the bar forward from wherever it is; the planted point goes with it
  if (run) {
    const A2 = _h.copy(sw.A).addScaledVector(sw.f, CFG.SAW_FEED * inp.rt * dt);
    const res = probe(sim, _c0.copy(A2).addScaledVector(sw.b, -half), _c1.copy(A2).addScaledVector(sw.b, half));
    if (!res.block.length) sw.A.copy(A2); else blockers.push(...res.block);
    pinch = Math.max(pinch, res.pinch);
  }
  sw.stuck = pinch > CFG.PINCH_STUCK;
  sw.cutting = false;
  p.prompt = '{look}: pivot the bar   {throttle}: press it forward   release {raise} to lift it off';
  if (sw.stuck) p.prompt = 'BAR PINCHED - the kerf has closed on it';
  else if (run && blockers.length) {
    // the chain works through whatever the bar is being pushed against
    sw.cutting = true;
    // The chain clears wood at CUT_RATE (cross-section per second), shared between the fibres it is on:
    // one twig fibre goes at once, a full row across the trunk takes a while.
    const prog = new Map(), done = new Map(), uniq = new Map();
    for (const b of blockers) uniq.set(b.seg * 1024 + b.i + (b.live ? 0.5 : 0), b);
    let area = 0; for (const b of uniq.values()) area += b.A;
    const inc = inp.rt * dt * CFG.CUT_RATE / area;
    for (const [key, b] of uniq) {
      const v = (sw.prog.get(key) || 0) + inc;
      prog.set(key, v);
      if (v < 1) continue;
      prog.delete(key);
      const g = b.live ? 'L' + b.live : b.seg;
      let e = done.get(g); if (!e) done.set(g, e = { b, i: [], z: [] });
      e.i.push(b.i); e.z.push(+b.z.toFixed(4));
    }
    sw.prog = prog;
    for (const e of done.values()) sever(sim, e);
  } else if (!blockers.length) sw.prog.clear();

  // ropes and lanyards do not stop a chain: a moment of contact under throttle and they part
  const a0 = _c0.copy(sw.A).addScaledVector(sw.b, -half), a1 = _c1.copy(sw.A).addScaledVector(sw.b, half);
  let touching = null;
  if (inp.rt > 0.3) for (const [p0, p1, who] of ropeSpans(sim)) if (segDist(a0, a1, p0, p1).d < CFG.ROPE_RADIUS + 0.02) { touching = who; break; }
  sw.ropeT = touching ? sw.ropeT + dt : 0;
  if (touching && sw.ropeT > CFG.ROPE_CUT_TIME) {
    sw.ropeT = 0;
    if (touching === 'rope') sim.rope.cut(); else sim.players.cutLanyard(touching, p);
  }
}

/** Every straight run of rope in the world: [from, to, 'rope' | the climber whose lanyard it is]. */
function ropeSpans(sim) {
  const out = sim.rope.spans().map(([a, b]) => [a, b, 'rope']);
  for (const q of sim.players.list.values()) {
    if (q.mode !== MODE.CLIMB) continue;
    const s = sim.world.segs.get(q.cl.seg); if (!s) continue;
    const pts = lanyardLoop(s, q.cl.t, q.cl.side, CFG.STANDOFF).map((x) => sim.segToWorld(s, x));
    for (let i = 0; i + 1 < pts.length; i++) out.push([pts[i], pts[i + 1], q]);
  }
  return out;
}

function sever(sim, e) {
  const w = sim.world, b = e.b;
  if (b.live) { sim.structure.cutLive(b.live, e.i); return; }
  const s = w.segs.get(b.seg); if (!s) return;
  const L = segLen(s), f = s.f, zm = e.z.reduce((a, x) => a + x, 0) / e.z.length;
  const ev = { t: 'cut', seg: s.id, i: e.i, z: e.z };
  if (f.ncut === 0) {
    let at = zm / L;
    if (s.parent >= 0 && zm < 0.05) at = 0; else at = Math.min(0.96, Math.max(0.04, at));
    ev.at = at;
  } else if (Math.abs(zm - f.at * L) > Math.max(2 * s.r0, 0.15)) {
    // a second cut plane well away from the first: give it its own bundle (next tick the bar cuts into that)
    const t = Math.min(0.95, Math.max(0.05, (zm / L + f.at) / 2));
    sim.emit({ t: 'divide', seg: s.id, at: t, newSeg: w.newId() });
    return;
  }
  sim.emit(ev);
  sim.structure.afterCut(s);
}

/**
 * What a bar lying from c0 to c1 (world) touches.
 * block: fibres of solid wood in its way [{seg, i, z, live?}]
 * pinch: compressive force (N) carried by closed kerfs the bar is lying in
 */
function probe(sim, c0, c1) {
  const w = sim.world, block = [];
  let pinch = 0;
  const liveAt = new Map();          // seg id -> [piece id, joint, isRootSide]
  for (const [id, j] of sim.structure.live) { liveAt.set(j.rootSeg, [id, j, true]); if (w.segs.get(j.parentSeg)?.id !== undefined && j.rootSeg !== j.parentSeg) liveAt.set(j.parentSeg, [id, j, false]); }
  const loc = new Map();             // piece id -> bar in that piece's frame
  for (const s of w.segs.values()) {
    // the bar in this segment's own (unbent) coordinates
    const pl = loc.get(s.piece) || [sim.toLocal(s.piece, c0), sim.toLocal(s.piece, c1)];
    loc.set(s.piece, pl);
    const fr = sim.structure.flex.frame(s.id), lc = fr ? [frameInverse(fr, pl[0]), frameInverse(fr, pl[1])] : pl;
    const rmax = Math.max(s.r0, s.r1);
    if (segDistA(lc[0], lc[1], s.a, s.b).d > rmax + 0.02) continue;
    const f = s.f, L = segLen(s), Ly = layout(f.N), ax = segAxis(s), { u, v } = bundleBasis(ax);
    const lv = liveAt.get(s.id);
    const liveSameAxis = lv && (lv[2] || Math.abs(ax[0] * lv[1].n[0] + ax[1] * lv[1].n[1] + ax[2] * lv[1].n[2]) > 0.99);
    const zone = Math.max(0.05, 0.6 * s.r0), fa = Ly.dA * s.r0 * s.r0;
    for (let i = 0; i < f.n; i++) {
      const X = Ly.X[i], Y = Ly.Y[i];
      const p0 = [s.a[0] + (u[0] * X + v[0] * Y) * s.r0, s.a[1] + (u[1] * X + v[1] * Y) * s.r0, s.a[2] + (u[2] * X + v[2] * Y) * s.r0];
      const p1 = [s.b[0] + (u[0] * X + v[0] * Y) * s.r1, s.b[1] + (u[1] * X + v[1] * Y) * s.r1, s.b[2] + (u[2] * X + v[2] * Y) * s.r1];
      const r = segDistA(lc[0], lc[1], p0, p1), z = r.t * L;
      const hw = (s.r0 + (s.r1 - s.r0) * r.t) / f.N;
      if (r.d > hw * 0.9 + 0.004) continue;
      if (z < (f.lo ? f.lo[i] : 0) - 1e-4 || z > (f.hi ? f.hi[i] : L) + 1e-4) continue;      // this fibre ends before here
      if (f.state[i] === CUT && z > f.zmin[i] - CFG.KERF_WIDTH && z < f.zmax[i] + CFG.KERF_WIDTH) {
        // lying in an existing kerf: free to move, unless the kerf has closed on the bar
        if (f.act[i]) pinch += Math.max(0, -CFG.KERF_CONTACT * CFG.COMP / CFG.COMP_STRAIN * (f.e0 + f.e1 * X * s.r0 + f.e2 * Y * s.r0)) * Ly.dA * s.r0 * s.r0;
        continue;
      }
      // the last fibres of a live bundle are cut where the two bodies meet
      if (liveSameAxis && (lv[2] ? z < zone : z > L - zone)) {
        if (lv[1].st[i] === 0) block.push({ seg: s.id, i, z, A: fa, live: lv[0] });
        continue;
      }
      block.push({ seg: s.id, i, z, A: fa });
    }
  }
  return { block, pinch };
}

// ---- closest distance between two segments; t = fraction along the second ----
export function segDist(a0, a1, b0, b1) {
  return segDistA([a0.x, a0.y, a0.z], [a1.x, a1.y, a1.z], [b0.x, b0.y, b0.z], [b1.x, b1.y, b1.z]);
}
function segDistA(p1, q1, p2, q2) {
  const d1 = [q1[0] - p1[0], q1[1] - p1[1], q1[2] - p1[2]], d2 = [q2[0] - p2[0], q2[1] - p2[1], q2[2] - p2[2]];
  const r = [p1[0] - p2[0], p1[1] - p2[1], p1[2] - p2[2]];
  const a = d1[0] * d1[0] + d1[1] * d1[1] + d1[2] * d1[2], e = d2[0] * d2[0] + d2[1] * d2[1] + d2[2] * d2[2];
  const f = d2[0] * r[0] + d2[1] * r[1] + d2[2] * r[2];
  let s, t;
  if (a < 1e-12 && e < 1e-12) { s = 0; t = 0; }
  else if (a < 1e-12) { s = 0; t = Math.min(1, Math.max(0, f / e)); }
  else {
    const c = d1[0] * r[0] + d1[1] * r[1] + d1[2] * r[2];
    if (e < 1e-12) { t = 0; s = Math.min(1, Math.max(0, -c / a)); }
    else {
      const b = d1[0] * d2[0] + d1[1] * d2[1] + d1[2] * d2[2], den = a * e - b * b;
      s = den > 1e-12 ? Math.min(1, Math.max(0, (b * f - c * e) / den)) : 0;
      t = (b * s + f) / e;
      if (t < 0) { t = 0; s = Math.min(1, Math.max(0, -c / a)); } else if (t > 1) { t = 1; s = Math.min(1, Math.max(0, (b - c) / a)); }
    }
  }
  const dx = r[0] + d1[0] * s - d2[0] * t, dy = r[1] + d1[1] * s - d2[1] * t, dz = r[2] + d1[2] * s - d2[2] * t;
  return { d: Math.hypot(dx, dy, dz), s, t };
}
