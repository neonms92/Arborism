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
export function climbMove(w, cl, my, mx, sign, dt, nearGround) {
  let s = w.segs.get(cl.seg), msg = '';
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
    const next = w.stemNext(s.id), block = w.kids(s.id).some((k) => k !== next && w.isRealBranch(k));
    if (!w.kids(s.id).length) { if (endStop(1)) t = 1; else return { s, out: 'off', msg }; }
    else if (!next) { t = 1; msg = 'The stem ends here. Look at a branch and hold {interact} to move the lanyard onto it'; }
    else if (w.segs.get(next).r0 < CFG.SPUR_MIN_R) { t = 1; msg = 'Too thin for spurs'; }
    else if (block) { t = 1; msg = 'The lanyard stops at the union. Look at the stem you want and hold {interact} to move it'; }
    else { s = w.segs.get(next); cl.seg = next; t = 0.01; cl.side = perp(cl.side, segAxis(s)); }
  } else if (t < 0) {
    if (s.parent < 0) {
      // the bottom of the wood: stepping off onto the ground, or off the end of a hanging piece
      if (nearGround(s)) return { s, out: 'land', msg };
      if (endStop(-1)) t = 0; else return { s, out: 'off', msg };
    } else {
      const up = w.stemNext(s.parent), block = w.kids(s.parent).some((k) => k !== s.id && w.isRealBranch(k));
      if (up !== s.id || block) { t = 0; msg = 'The lanyard stops at the union. Look at the stem you want and hold {interact} to move it'; }
      else { s = w.segs.get(s.parent); cl.seg = s.id; t = 0.99; cl.side = perp(cl.side, segAxis(s)); }
    }
  }
  cl.t = t;
  return { s, out: null, msg };
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
