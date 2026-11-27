// Climbing on spurs: how the stick moves a climber along and round the wood (D103).
// Pure: the host (sim/players.js) and a joined client predicting its own climber (net/predict.js) run this
// same rule on the same model, so the client's guess only differs from the host by timing.
// cl = { seg, t, side, end, armed } is changed in place. Side effects (toasts, landing, falling off) are
// returned for the caller: { s, out: null | 'land' | 'off', msg }.

import { CFG } from '../config.js';
import { segLen, segAxis, segRadius, perp } from './world.js';

/**
 * my, mx: stick along / round the stem; sign: +1 when pushing the stick forward climbs toward the
 * segment's b end (the caller works it out from where the climber looks); nearGround(s): is the bottom
 * end of root segment s within a step of the ground.
 */
export function climbMove(w, cl, my, mx, sign, dt, nearGround, link = null) {
  let s = w.segs.get(cl.seg), msg = '';
  // Wood that has cracked but is still held by fibres is its own piece, so the model no longer lists it as a
  // child of the wood below. link (D127) puts the live joints back: up(id) -> root segments of held pieces
  // joined at the top of segment id, down(id) -> the segment below the joint at the base of root segment id.
  const kids = (id) => { const k = w.kids(id), u = link ? link.up(id) : null; return u && u.length ? k.concat(u) : k; };
  const parentOf = (x) => (x.parent >= 0 ? x.parent : link ? link.down(x.id) ?? -1 : -1);
  if (!s) return { s: null, out: 'off', msg };
  const ax = segAxis(s), L = segLen(s);
  // around the stem
  const r = segRadius(s, cl.t);
  const ang = mx * sign * CFG.AROUND * dt / (r + CFG.STANDOFF);
  if (ang) cl.side = rotateAbout(cl.side, ax, ang);
  // along the stem
  let t = cl.t + my * sign * CFG.CLIMB * dt / L;
  // The end of the wood stops you once (D85): to climb off it, let go of {move} and push on again. A late
  // view can then never carry anyone off the top unawares.
  const push = Math.sign(my * sign);
  if (cl.end && push !== cl.end) cl.armed = true;
  if (cl.end && (cl.end > 0 ? t < 1 - 0.3 / L : t > 0.3 / L)) cl.end = cl.armed = 0;
  const endStop = (dir) => {
    if (cl.end === dir && cl.armed) return false;
    cl.end = dir; cl.armed = false;
    msg = 'The end of the wood. Let go of {move} and push on again to climb off it';
    return true;
  };
  if (t > cl.t && segRadius(s, Math.min(1, t)) < CFG.SPUR_MIN_R) { t = cl.t; msg = 'Too thin for spurs'; }
  if (t > 1) {
    // the lanyard only slides on along the same stem; onto a branch it has to be thrown ({interact})
    const ks = kids(s.id), next = w.stemNext(s.id, ks), block = ks.some((k) => k !== next && w.isRealBranch(k, s.id));
    if (!ks.length) { if (endStop(1)) t = 1; else return { s, out: 'off', msg }; }
    else if (!next) { t = 1; msg = 'The stem ends here. Look at a branch and hold {interact} to move the lanyard onto it'; }
    else if (w.segs.get(next).r0 < CFG.SPUR_MIN_R) { t = 1; msg = 'Too thin for spurs'; }
    else if (block) { t = 1; msg = 'The lanyard stops at the union. Look at the stem you want and hold {interact} to move it'; }
    else { s = w.segs.get(next); cl.seg = next; t = 0.01; cl.side = perp(cl.side, segAxis(s)); }
  } else if (t < 0) {
    const par = parentOf(s);
    if (par < 0 || !w.segs.has(par)) {
      // the bottom of the wood: stepping off onto the ground, or off the end of a hanging piece
      if (nearGround(s)) return { s, out: 'land', msg };
      if (endStop(-1)) t = 0; else return { s, out: 'off', msg };
    } else {
      const ks = kids(par), up = w.stemNext(par, ks), block = ks.some((k) => k !== s.id && w.isRealBranch(k, par));
      if (up !== s.id || block) { t = 0; msg = 'The lanyard stops at the union. Look at the stem you want and hold {interact} to move it'; }
      else { s = w.segs.get(par); cl.seg = s.id; t = 0.99; cl.side = perp(cl.side, segAxis(s)); }
    }
  }
  cl.t = t;
  return { s, out: null, msg };
}

/**
 * The live joints a climber can cross (climbMove's link), from [rootSeg, stubSeg] pairs: the host's
 * structure.live, or a client's aux.live ({seg, stub}).
 */
export function jointLink(pairs) {
  if (!pairs || !pairs.length) return null;
  const up = new Map(), down = new Map();
  for (const [root, stub] of pairs) { let u = up.get(stub); if (!u) up.set(stub, u = []); u.push(root); down.set(root, stub); }
  return { up: (id) => up.get(id) || null, down: (id) => down.get(id) };
}

/** Which way along segment s the stick climbs: +1 toward b when the axis (in world) points up or where you look. */
export function climbSign(axWorld, yaw) {
  const lx = -Math.sin(yaw), lz = -Math.cos(yaw);
  return axWorld[0] * lx * 0.6 + axWorld[1] + axWorld[2] * lz * 0.6 >= 0 ? 1 : -1;
}

export function rotateAbout(v, ax, ang) {
  const c = Math.cos(ang), s = Math.sin(ang), d = v[0] * ax[0] + v[1] * ax[1] + v[2] * ax[2];
  const cr = [ax[1] * v[2] - ax[2] * v[1], ax[2] * v[0] - ax[0] * v[2], ax[0] * v[1] - ax[1] * v[0]];
  return perp([v[0] * c + cr[0] * s + ax[0] * d * (1 - c), v[1] * c + cr[1] * s + ax[1] * d * (1 - c), v[2] * c + cr[2] * s + ax[2] * d * (1 - c)], ax);
}
