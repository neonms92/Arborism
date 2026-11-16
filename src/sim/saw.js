// Chainsaw. The bar is a rod in the world, held in front of the player's eyes
// and swung with the mouse / right stick. Wood stops it: the bar rests against
// the fibres in its way, and throttle severs those fibres after CUT_TIME. Then
// it moves on. There is no "cut" object - only fibres that have been severed,
// each remembering where. Host only. See docs/DESIGN.md 4.

import * as THREE from 'three';
import { CFG, MODE } from '../config.js';
import { segLen, segAxis, lanyardLoop } from '../model/world.js';
import { bundleBasis, layout, INTACT, CUT } from '../model/fibres.js';

const _h = new THREE.Vector3(), _d = new THREE.Vector3(), _d0 = new THREE.Vector3(), _d1 = new THREE.Vector3();
const _c0 = new THREE.Vector3(), _c1 = new THREE.Vector3(), _p = new THREE.Vector3(), _q = new THREE.Vector3();

export function sawOff(sim, p) { p.saw = { on: false }; }

export function sawStep(sim, p, inp, dt, can) {
  let sw = p.saw;
  if (!can || inp.lt < 0.3) { if (sw.on) sawOff(sim, p); return; }

  // where the hands want the bar: level by default, swung by (sy, sp) about the hands
  const { o, d } = sim.eye(p);
  const H = _h.copy(o).addScaledVector(d, CFG.SAW_HOLD); H.y -= 0.2;
  const Y = inp.yaw + inp.sy, P = inp.sp, cp = Math.cos(P);
  _d.set(-Math.sin(Y) * cp, Math.sin(P), -Math.cos(Y) * cp);
  const D0 = _d0.copy(H), D1 = _d1.copy(H).addScaledVector(_d, CFG.BAR_LEN);
  if (!sw.on) sw = p.saw = { on: true, a0: D0.clone(), a1: D1.clone(), stuck: false, cutting: false, prog: new Map() };

  // the bar follows the hands, a short step per tick, unless wood is in the way
  const far = Math.max(D0.distanceTo(sw.a0), D1.distanceTo(sw.a1));
  if (far > CFG.SAW_YANK) { sw.a0.copy(D0); sw.a1.copy(D1); sw.prog.clear(); return; }     // pulled clear
  const k = Math.min(1, CFG.BAR_SPEED * dt / (far || 1));
  const c0 = _c0.copy(sw.a0).lerp(D0, k), c1 = _c1.copy(sw.a1).lerp(D1, k);
  const res = probe(sim, c0, c1);
  sw.stuck = res.pinch > CFG.PINCH_STUCK;
  sw.cutting = false;
  p.prompt = '{throttle}: run the chain   {look}: swing the bar   {move}: move';
  if (!res.block.length) { sw.a0.copy(c0); sw.a1.copy(c1); sw.prog.clear(); }
  else if (sw.stuck) p.prompt = 'BAR PINCHED - the kerf has closed on it. Back it out.';
  else if (inp.rt > 0.05) {
    sw.cutting = true;
    const prog = new Map(), done = new Map();
    for (const b of res.block) {
      const key = b.seg * 1024 + b.i + (b.live ? 0.5 : 0);
      const v = (sw.prog.get(key) || 0) + inp.rt * dt / CFG.CUT_TIME;
      if (v < 1) { prog.set(key, v); continue; }
      const g = b.live ? 'L' + b.live : b.seg;
      let e = done.get(g); if (!e) done.set(g, e = { b, i: [], z: [] });
      e.i.push(b.i); e.z.push(+b.z.toFixed(4));
    }
    sw.prog = prog;
    for (const e of done.values()) sever(sim, e);
  } else p.prompt = 'The bar is against the wood - {throttle} to cut';

  // ropes and lanyards do not stop a chain: a moment of contact under throttle and they part
  let touching = null;
  if (inp.rt > 0.3) {
    for (const [a, b] of sim.rope.spans()) if (segDist(sw.a0, sw.a1, a, b).d < CFG.ROPE_RADIUS + 0.02) { touching = 'rope'; break; }
    for (const q of sim.players.list.values()) {
      if (touching || q.mode !== MODE.CLIMB) continue;
      const s = sim.world.segs.get(q.cl.seg); if (!s) continue;
      const pts = lanyardLoop(s, q.cl.t, q.cl.side, CFG.STANDOFF);
      for (let i = 0; i + 1 < pts.length; i++) {
        if (segDist(sw.a0, sw.a1, sim.toWorld(s.piece, pts[i], _p), sim.toWorld(s.piece, pts[i + 1], _q)).d < 0.03) { touching = q; break; }
      }
    }
  }
  sw.ropeT = touching ? (sw.ropeT || 0) + dt : 0;
  if (touching && sw.ropeT > CFG.ROPE_CUT_TIME) {
    sw.ropeT = 0;
    if (touching === 'rope') sim.rope.cut(); else sim.players.cutLanyard(touching, p);
  }
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
    let lc = loc.get(s.piece);
    if (!lc) { lc = [sim.toLocal(s.piece, c0), sim.toLocal(s.piece, c1)]; loc.set(s.piece, lc); }
    const rmax = Math.max(s.r0, s.r1);
    if (segDistA(lc[0], lc[1], s.a, s.b).d > rmax + 0.02) continue;
    const f = s.f, L = segLen(s), Ly = layout(f.N), ax = segAxis(s), { u, v } = bundleBasis(ax);
    const lv = liveAt.get(s.id);
    const liveSameAxis = lv && (lv[2] || Math.abs(ax[0] * lv[1].n[0] + ax[1] * lv[1].n[1] + ax[2] * lv[1].n[2]) > 0.99);
    const zone = Math.max(0.05, 0.6 * s.r0);
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
        if (f.act[i]) pinch += Math.max(0, -CFG.KERF_CONTACT * (f.c0 + f.s1 * X * s.r0 + f.s2 * Y * s.r0)) * Ly.dA * s.r0 * s.r0;
        continue;
      }
      // the last fibres of a live bundle are cut where the two bodies meet
      if (liveSameAxis && (lv[2] ? z < zone : z > L - zone)) {
        if (lv[1].st[i] === 0) block.push({ seg: s.id, i, z, live: lv[0] });
        continue;
      }
      block.push({ seg: s.id, i, z });
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
