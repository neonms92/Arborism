// Chainsaw: precision-mode aiming and feeding a kerf into a section.
// Host only. See docs/DESIGN.md section 4.

import { CFG } from '../config.js';
import { segLen, segAxis, segRadius, segParam, lerp3 } from '../model/world.js';
import { sectionBasis } from '../model/section.js';

export function sawOff(sim, p) { p.saw = { on: false }; }

export function sawStep(sim, p, inp, dt, aim, canSaw) {
  const w = sim.world, sw = p.saw;
  if (!sw.on) {
    if (!canSaw || inp.lt < 0.3) return;
    if (!aim || aim.dist > CFG.SAW_REACH) { p.prompt = 'Look at wood within reach to place the bar'; return; }
    const s = w.segs.get(aim.seg), L = segLen(s);
    const loc = sim.toLocal(s.piece, aim.point);
    const tL = Math.min(1, Math.max(0, segParam(s, loc)));
    const R = segRadius(s, tL);
    if (R < CFG.SAW_MIN_R) return;
    // join a nearby section or plan a new one
    let secId = -1, at = tL;
    for (const sec of w.sections.values()) {
      if (sec.seg !== s.id || sec.sep >= 0) continue;
      if (Math.abs(sec.at - tL) * L <= Math.max(2 * R, 0.12)) { secId = sec.id; at = sec.at; break; }
    }
    if (secId < 0) {
      if (s.parent >= 0 && tL * L < 0.06) at = 0;
      else at = Math.min(0.96, Math.max(0.04, tL));
    }
    const ax = segAxis(s), { u, v } = sectionBasis(ax), c = lerp3(s.a, s.b, tL);
    const rad = [loc[0] - c[0], loc[1] - c[1], loc[2] - c[2]];
    const phi = Math.atan2(rad[0] * v[0] + rad[1] * v[1] + rad[2] * v[2], rad[0] * u[0] + rad[1] * u[1] + rad[2] * u[2]);
    p.saw = { on: true, seg: s.id, at, sec: secId, k: -1, phi, tilt: 0, z0: (tL - at) * L, depth: 0, R: segRadius(s, at), stuck: false, sent: 0, pinch: 0 };
    return;
  }

  const s = w.segs.get(sw.seg);
  const sec = sw.sec >= 0 ? w.sections.get(sw.sec) : null;
  if (!s || !canSaw || inp.lt < 0.2 || (sw.sec >= 0 && (!sec || sec.sep >= 0))) { sawOff(sim, p); return; }
  if (sec) sim.structure.watched.add(sec.id);
  p.prompt = sw.depth > 0 ? 'RT: feed   release LT to withdraw' : 'L-stick: slide / rotate   R-stick Y: tilt   RT: cut';

  if (sw.depth === 0) {                       // still placing: fine adjustment
    sw.z0 = Math.max(-2.5 * sw.R, Math.min(2.5 * sw.R, sw.z0 + inp.my * 0.2 * dt));
    sw.phi += inp.mx * 0.9 * dt;
    sw.tilt = Math.max(-CFG.TILT_MAX, Math.min(CFG.TILT_MAX, sw.tilt + inp.ty * 0.9 * dt));
  }
  if (inp.rt > 0.05) {
    if (sw.sec < 0) {
      sw.sec = w.newId();
      sim.emit({ t: 'section', id: sw.sec, seg: sw.seg, at: sw.at });
    }
    const sc = w.sections.get(sw.sec);
    if (sw.k < 0) {
      if (sc.kerfs.length >= 16) { p.prompt = 'Too many cuts here'; return; }
      sw.k = sc.kerfs.length;
    }
    sw.pinch = sc.pinch[sw.k] || 0;
    const f = Math.max(0, 1 - sw.pinch / CFG.PINCH_STUCK);
    sw.stuck = f <= 0;
    if (sw.stuck) p.prompt = 'BAR PINCHED - the kerf has closed on it';
    const max = 2 * sw.R + 0.02 + Math.abs(Math.tan(sw.tilt)) * 0;
    sw.depth = Math.min(max, sw.depth + inp.rt * CFG.FEED * f * dt);
    if (sw.depth - sw.sent >= 0.004 || (sw.depth >= max && sw.sent < max)) {
      sw.sent = sw.depth;
      sim.emit({ t: 'kerf', sec: sw.sec, k: sw.k, phi: sw.phi, tilt: sw.tilt, z0: sw.z0, depth: sw.depth });
    }
  }
}
