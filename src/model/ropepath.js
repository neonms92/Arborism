// Rope that lies on wood instead of passing through it (D125).
//
// A straight run of rope between two fixed points (a span) is routed round
// the wood as a taut string: a list of contact points, each on the surface of
// one segment (a tapered capsule). Every pass
//   1. slides each contact point over its wood the way that shortens the rope
//      (the tangential part of the pull of its two neighbours) and lets go of
//      any point the rope pulls away from the wood (it lifts off),
//   2. hands a point to a neighbouring segment it has slid into (crotches),
//   3. merges points that bunched up, and
//   4. adds a point where a run between two neighbours passes through wood.
// So a rope draped over a limb stays over it, slides off a tip or down into a
// crotch, and wraps a trunk it is pulled round. Frictionless at the contacts.
//
// Pure maths on plain [x,y,z] arrays in world space, so the host (forces,
// length, what a saw can cut) and the view (drawing, the tail) run the same
// rules. Obstacles: {id, a, b, r0, r1}. Points: {id, x}.

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const madd = (a, b, k) => [a[0] + b[0] * k, a[1] + b[1] * k, a[2] + b[2] * k];
const unit = (a) => { const l = len(a); return l > 1e-9 ? [a[0] / l, a[1] / l, a[2] / l] : null; };

/** How far off the bark a contact point sits: the rope's own radius, plus enough that a run between two points round a curve does not cut the bark. */
const contactR = (R, rr) => R + rr;
const placeR = (R, rr) => (R + rr) * 1.05 + 0.005;

/** Closest point of obstacle o's axis to x: centre, outward unit normal, bark radius there. */
function near(o, x) {
  const ab = sub(o.b, o.a), l2 = dot(ab, ab) || 1;
  const t = Math.min(1, Math.max(0, dot(sub(x, o.a), ab) / l2));
  const c = madd(o.a, ab, t), R = o.r0 + (o.r1 - o.r0) * t;
  const d = sub(x, c), dl = len(d);
  let n = dl > 1e-7 ? [d[0] / dl, d[1] / dl, d[2] / dl] : null;
  if (!n) n = unit(cross(ab, Math.abs(ab[1]) < 0.9 * Math.sqrt(l2) ? [0, 1, 0] : [1, 0, 0])) || [1, 0, 0];
  return { c, n, R, dist: dl };
}

/** x moved onto the placement surface of o. */
function onto(o, x, rr) { const q = near(o, x); return madd(q.c, q.n, placeR(q.R, rr)); }

/** Closest points between segments p0p1 and q0q1: [s, t]. */
function segSeg(p0, p1, q0, q1) {
  const d1 = sub(p1, p0), d2 = sub(q1, q0), r = sub(p0, q0);
  const a = dot(d1, d1), e = dot(d2, d2), f = dot(d2, r);
  let s, t;
  if (a < 1e-12 && e < 1e-12) return [0, 0];
  if (a < 1e-12) { s = 0; t = Math.min(1, Math.max(0, f / e)); }
  else {
    const c = dot(d1, r);
    if (e < 1e-12) { t = 0; s = Math.min(1, Math.max(0, -c / a)); }
    else {
      const b = dot(d1, d2), den = a * e - b * b;
      s = den > 1e-12 ? Math.min(1, Math.max(0, (b * f - c * e) / den)) : 0;
      t = (b * s + f) / e;
      if (t < 0) { t = 0; s = Math.min(1, Math.max(0, -c / a)); }
      else if (t > 1) { t = 1; s = Math.min(1, Math.max(0, (b - c) / a)); }
    }
  }
  return [s, t];
}

/** The obstacles a span could touch: those whose capsule box meets the box round the points. */
export function nearObstacles(obs, points, pad) {
  let lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const p of points) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], p[k]); hi[k] = Math.max(hi[k], p[k]); }
  const out = [];
  for (const o of obs) {
    const r = Math.max(o.r0, o.r1) + pad;
    let ok = true;
    for (let k = 0; k < 3 && ok; k++) ok = Math.min(o.a[k], o.b[k]) - r <= hi[k] && Math.max(o.a[k], o.b[k]) + r >= lo[k];
    if (ok) out.push(o);
  }
  return out;
}

/** x pushed out of any wood it is inside (an end of the rope never sits in wood). */
export function pushOut(x, obs, rr) {
  for (let pass = 0; pass < 3; pass++) {
    let moved = false;
    for (const o of obs) {
      const q = near(o, x);
      if (q.dist < contactR(q.R, rr)) { x = madd(q.c, q.n, placeR(q.R, rr)); moved = true; }
    }
    if (!moved) break;
  }
  return x;
}

/** Deepest wood the run u-v passes through: {o, x (where the rope would touch it)} or null. */
function deepest(u, v, obs, rr) {
  let best = null, bestPen = 0;
  for (const o of obs) {
    const [s, t] = segSeg(u, v, o.a, o.b);
    const pu = madd(u, sub(v, u), s), pa = madd(o.a, sub(o.b, o.a), t), R = o.r0 + (o.r1 - o.r0) * t;
    const d = sub(pu, pa), dl = len(d);
    const pen = contactR(R, rr) - dl - 0.003;
    if (pen <= bestPen) continue;
    let n = dl > 1e-6 ? [d[0] / dl, d[1] / dl, d[2] / dl] : unit(cross(sub(o.b, o.a), sub(v, u)));
    if (!n) n = near(o, madd(pa, [1, 0, 0], 1)).n;
    bestPen = pen; best = { o, x: madd(pa, n, placeR(R, rr)) };
  }
  return best;
}

const MAX_PTS = 24;

/**
 * Route one span P..Q round the wood. pts: the contact points from last time
 * (warm start, world space); returns the new list. byId: Map id -> obstacle.
 */
export function routeSpan(P, Q, pts, obs, byId, rr, iters = 2) {
  pts = pts.filter((q) => byId.has(q.id));
  for (let it = 0; it < iters; it++) {
    // 1-2. slide each point the way that shortens the rope; drop it if the rope lifts off
    for (let i = 0; i < pts.length; i++) {
      const prev = i ? pts[i - 1].x : P, next = i + 1 < pts.length ? pts[i + 1].x : Q;
      let o = byId.get(pts[i].id), w = pts[i].x;
      const q = near(o, w);
      const up = unit(sub(prev, w)), un = unit(sub(next, w));
      if (!up || !un) { pts.splice(i--, 1); continue; }
      const bv = [up[0] + un[0], up[1] + un[1], up[2] + un[2]], bn = dot(bv, q.n);
      if (bn > 0.03) { pts.splice(i--, 1); continue; }       // pulled off the wood
      const tg = madd(bv, q.n, -bn);
      const k = 0.3 * Math.min(len(sub(prev, w)), len(sub(next, w)), 2 * placeR(q.R, 0));
      w = onto(o, madd(w, tg, k), rr);
      // slid into a neighbouring segment (a crotch, the next piece of stem): that wood has it now
      let depth = 0.002, to = null;
      for (const o2 of obs) {
        if (o2 === o) continue;
        const q2 = near(o2, w), d2 = contactR(q2.R, rr) - q2.dist;
        if (d2 > depth) { depth = d2; to = o2; }
      }
      if (to) { o = to; w = onto(o, w, rr); }
      pts[i] = { id: o.id, x: w };
    }
    // 3. merge points that bunched up on the same wood, and points sitting on an end
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], o = byId.get(a.id), Rp = placeR(near(o, a.x).R, rr);
      if (len(sub(a.x, P)) < 0.01 || len(sub(a.x, Q)) < 0.01) { pts.splice(i--, 1); continue; }
      const b = pts[i + 1];
      if (b && b.id === a.id && len(sub(a.x, b.x)) < 0.35 * Rp) {
        pts.splice(i, 2, { id: a.id, x: onto(o, [(a.x[0] + b.x[0]) / 2, (a.x[1] + b.x[1]) / 2, (a.x[2] + b.x[2]) / 2], rr) });
        i--;
      }
    }
    // 4. a run through wood gets a contact point where it would touch it
    if (pts.length < MAX_PTS) {
      const out = [];
      for (let i = 0; i <= pts.length; i++) {
        const u = i ? pts[i - 1].x : P, v = i < pts.length ? pts[i].x : Q;
        const hit = out.length + (pts.length - i) < MAX_PTS ? deepest(u, v, obs, rr) : null;
        if (hit) out.push({ id: hit.o.id, x: hit.x });
        if (i < pts.length) out.push(pts[i]);
      }
      pts = out;
    }
  }
  return pts;
}

/** Length of P, the points, Q. */
export function spanLength(P, pts, Q) {
  let s = 0, u = P;
  for (const q of pts) { s += len(sub(q.x, u)); u = q.x; }
  return s + len(sub(Q, u));
}
