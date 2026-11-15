// Seeded tree generator. Host only: the result travels to clients as data,
// so this does not need to be bit-identical across machines.
// Returns [{id, parent, a, b, r0, r1, leaf}] with parents before children.

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function generateTree(seed, newId, origin = [0, 0, 0]) {
  const R = rng(seed), segs = [];
  const rnd = (a, b) => a + (b - a) * R();
  const add = (parent, a, b, r0, r1, leaf = 0) => {
    const s = { id: newId(), parent, a, b, r0, r1, leaf }; segs.push(s); return s;
  };
  const norm = (v) => { const l = Math.hypot(v[0], v[1], v[2]); return [v[0] / l, v[1] / l, v[2] / l]; };

  // Grow a branch as a chain of segments; returns the list of its segments.
  function chain(parent, start, dir, length, rBase, rTip, segLen, lift, wobble) {
    const n = Math.max(1, Math.round(length / segLen)), out = [];
    let p = start, d = norm(dir), par = parent;
    for (let i = 0; i < n; i++) {
      const t0 = i / n, t1 = (i + 1) / n;
      d = norm([d[0] + rnd(-wobble, wobble), d[1] + lift + rnd(-wobble, wobble), d[2] + rnd(-wobble, wobble)]);
      const q = [p[0] + d[0] * segLen, p[1] + d[1] * segLen, p[2] + d[2] * segLen];
      const r0 = rBase + (rTip - rBase) * t0, r1 = rBase + (rTip - rBase) * t1;
      const s = add(par, p, q, r0, r1, r1 < 0.04 ? 0.6 : 0);
      out.push(s); par = s.id; p = q;
    }
    out[out.length - 1].leaf += 1.5;
    return out;
  }

  // Trunk: slight lean so a felling cut has something to work with.
  const lean = rnd(0.02, 0.06), leanAz = rnd(0, Math.PI * 2);
  const trunk = chain(-1, origin, [Math.sin(lean) * Math.cos(leanAz), 1, Math.sin(lean) * Math.sin(leanAz)],
    11, 0.27, 0.06, 1.0, 0.25, 0.02);

  let az = rnd(0, Math.PI * 2);
  for (let i = 3; i < trunk.length; i++) {            // first limb at ~4 m
    if (i > 3 && R() < 0.12) continue;
    const t = trunk[i];
    az += 2.4 + rnd(-0.4, 0.4);
    const elev = rnd(0.25, 0.75) + (i / trunk.length) * 0.4;
    const dir = [Math.cos(az) * Math.cos(elev), Math.sin(elev), Math.sin(az) * Math.cos(elev)];
    const rb = t.r1 * rnd(0.45, 0.62);
    const length = (i === 3 ? 5.6 : rnd(2.6, 4.8)) * (1 - 0.45 * i / trunk.length);
    const limb = chain(t.id, t.b, dir, length, i === 3 ? Math.max(rb, 0.085) : rb, 0.02, 0.8, 0.06, 0.07);
    for (let j = 1; j < limb.length - 1; j++) {
      if (R() < 0.45) continue;
      const l = limb[j], a2 = rnd(0, Math.PI * 2);
      const d2 = [dir[0] * 0.5 + Math.cos(a2), 0.3 + rnd(0, 0.6), dir[2] * 0.5 + Math.sin(a2)];
      chain(l.id, l.b, d2, rnd(1.0, 2.2), l.r1 * rnd(0.45, 0.6), 0.015, 0.7, 0.08, 0.1);
    }
  }
  return segs;
}
