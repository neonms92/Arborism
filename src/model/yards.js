// Procedural yards round the tree. Plain data and a pure, seeded function:
// the host plans the neighbourhood with planYards, then puts its builds up
// and lays its pavers through the usual events (sim/builds.js, sim/pavers.js),
// so only those events cross the network.
//
// The neighbourhood is blocks of lots along x, separated by streets. A block
// is two rows of lots back to back, each row facing its own street; both rows
// of a block share their lot lines, so a lot line is one fence, not two. The
// tree stands anywhere in a lot (the tree's yard), a lot like the others: its
// trunk only has to be inside the lot, up to the height of a pole, so it may be
// right by a fence, the street or the house. The lot also gets paving round the
// trunk (a circle or a square, as big as fits) and the parked chipper. (Branches
// that would grow into anything are pruned when the trees are planted,
// model/prune.js.) Everything goes only where it fits:
// inside the lot and clear of what is already there. Each lot may have:
//   a house (rooms glued on a foundation, model/builds.js) facing the street, with a porch of pavers
//     at its door, a paver sidewalk out to the street, or both;
//   a patio of pavers behind the house; a shed in a back corner;
//   a fence round its sides and back, and sometimes along the front with a gap where the path is;
//   trees (model/stands.js), wherever there is room left, clear of everything above.
// DENSITY (0..1) raises the chance of each of these, and lots get smaller as it rises (LOT_MAX at 0,
// LOT_MIN at 1). The plan is laid out in x, z only: heights come later from the ground, which is made
// with the pads the plan asks for (houses, patios and sheds stand on level ground; fences and sidewalks
// follow the slopes).
//
// plan = {lots: [{x0, x1, z0, z1, face, tree}], builds: [{kind, p:[x, 0, z], q, ...}],
//         areas: [paver areas, model/pavers.js], pads: [{x, z, r, blend, yAt?}],
//         streets: [{z0, z1}] (strips along x, the whole width of the ground, flattened by the terrain),
//         chipper: {x, z, yaw} | null (where it is parked), treePave: radius of the tree's paving (or undefined),
//         trees: [[x, z, seed, height, diameter]] (the other trees), front: [x, z] (the tree's lot faces its street this way),
//         poles: [[x, z]], spans: [[pole, pole]], drops: [[pole, house's index in builds]] (power lines, only with o.poles)}

import { HOUSE, SHED, FENCE, houseFoot } from './builds.js';

export function rng(seed) {      // mulberry32
  let a = (seed | 0) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const yawQ = (a) => [0, Math.sin(a / 2), 0, Math.cos(a / 2)];
const r4 = (v) => +v.toFixed(4);

/**
 * The plan for these settings.
 * o = {seed, density, lotMax, lotMin, extent, street, fence, blend, paver (cell),
 *      tree: {foot: [[x, z]...] (points on the trunk's axis from its base up to the height of a pole, the base at
 *             [0, 0]), r (its radius at the base), edge (m from the trunk to the lot's lines), clear (m beyond the
 *             trunk kept free of houses, sheds and the chipper), paveMax (largest paving round it), pit,
 *             chip: {x0, x1, hz, gap} (the chipper's length along its own x from its origin, half width, and its
 *             gap from the paving)}}
 */
export function planYards(o) {
  const R = rng(o.seed * 7919 + 17), d = Math.min(1, Math.max(0, o.density));
  const lotW = o.lotMax + (o.lotMin - o.lotMax) * d, lotD = lotW * 1.4, E = o.extent, ST = o.street;
  const plan = { lots: [], builds: [], areas: [], pads: [], streets: [], chipper: null, trees: [], front: [0, 1] };
  const jit = (v, f = 0.15) => v * (1 + (R() * 2 - 1) * f);

  // The tree's lot is a lot like the others (the same width and depth for the density), placed so that the tree
  // stands anywhere in it: its trunk (as it leans, up to the height of a pole) `edge` inside its lines.
  const tW = jit(lotW), tD = jit(lotD), T = o.tree, foot = T.foot || [[0, 0]], m = T.r + T.edge;
  const fx = foot.map((p) => p[0]), fz = foot.map((p) => p[1]);
  const span = (lo, hi) => (hi > lo ? lo + (hi - lo) * R() : (lo + hi) / 2);
  const tu = span(-tW / 2 + m - Math.min(...fx), tW / 2 - m - Math.max(...fx)), tw = span(m - Math.min(...fz), tD - m - Math.max(...fz));
  const tx0 = -tu - tW / 2, tz0 = -tw, tz1 = tD - tw;

  // lot lines along x for a block: the tree's block grows from the tree's lot, others from a random offset
  const cuts = (tree) => {
    const xs = tree ? [tx0, tx0 + tW] : [(R() - 0.5) * lotW];
    if (!tree) xs.push(xs[0] + jit(lotW));
    while (xs[0] > -E) xs.unshift(xs[0] - jit(lotW));
    while (xs[xs.length - 1] < E) xs.push(xs[xs.length - 1] + jit(lotW));
    return xs;
  };

  // rows along z: the tree's block (a row behind facing -z, the tree's row facing +z), then blocks either side
  const rows = [];
  const block = (zb, zt, tree) => {           // a block between zb and zt, its lot lines shared, split where the rows meet
    const xs = cuts(tree), zm = tree ? tz0 : (zb + zt) / 2;
    rows.push({ xs, z0: zb, z1: zm, face: -1, tree: false }, { xs, z0: zm, z1: zt, face: 1, tree });
  };
  const treeBack = tz0 - jit(lotD);
  block(treeBack, tz1, true);
  for (let z = tz1 + ST; z < E; ) { const D = jit(lotD) * 2; block(z, z + D, false); z += D + ST; }
  for (let z = treeBack - ST; z > -E; ) { const D = jit(lotD) * 2; block(z - D, z, false); z -= D + ST; }

  const posts = new Set(), edges = new Set();
  const key = (x, z) => `${Math.round(x * 20)},${Math.round(z * 20)}`;
  for (const row of rows) {
    const nLots = plan.lots.length;
    for (let k = 0; k + 1 < row.xs.length; k++) {
      const x0 = row.xs[k], x1 = row.xs[k + 1], tree = row.tree && x0 <= 0 && x1 > 0;
      if (!tree && (Math.abs((x0 + x1) / 2) > E || Math.abs((row.z0 + row.z1) / 2) > E)) continue;
      const lot = { x0, x1, z0: row.z0, z1: row.z1, face: row.face, tree };
      plan.lots.push(lot);
      if (tree) plan.front = [0, row.face];
      fillLot(plan, lot, R, d, o, posts, edges, key);
    }
    // the street this row faces (two rows across a street share it), if the row has any lots
    if (plan.lots.length > nLots) {
      const z0 = r4(row.face > 0 ? row.z1 : row.z0 - ST), z1 = r4(z0 + ST);
      if (!plan.streets.some((s) => Math.abs(s.z0 - z0) < 0.01)) plan.streets.push({ z0, z1 });
    }
  }
  plan.streets.sort((a, b) => a.z0 - b.z0);
  if (o.poles) planPoles(plan, o);
  return plan;
}

/**
 * Utility poles along every street, on its -z kerb just inside the asphalt, POLE_SPACING apart (each gap within
 * 10%) across the whole ground, and a line from each to the next (spans). Each house gets a drop from the nearest
 * pole within dropMax of its front whose line to it passes no trunk (drops: [pole, index of the house in plan.builds]). A pole that would stand on
 * the parked chipper is left out (the line then spans the gap). Its own random stream, so the rest of the plan
 * is the same with or without poles.
 */
function planPoles(plan, o) {
  const P = o.poles, R = rng(o.seed * 104729 + 3), half = P.size / 2 - 3, ch = plan.chipper;
  plan.poles = []; plan.spans = []; plan.drops = [];
  for (const st of plan.streets) {
    const z = st.z0 + 0.7;
    let prev = -1;
    for (let x = -half + R() * P.spacing * 0.5; x <= half; x += P.spacing * (0.9 + 0.2 * R())) {
      if (ch && Math.hypot(ch.x - x, ch.z - z) < 5) continue;
      const i = plan.poles.length; plan.poles.push([r4(x), r4(z)]);
      if (prev >= 0) plan.spans.push([prev, i]);
      prev = i;
    }
  }
  // a drop never passes through a trunk (seen from above): the job tree's as it leans, the others' allowing for a
  // lean of 0.15 over the height of a drop (their branches are pruned where a line passes, model/prune.js)
  const trunks = (o.tree && o.tree.foot || []).map(([x, z]) => [x, z, o.tree.r + 0.3]);
  for (const [x, z, , h, dia] of plan.trees) trunks.push([x, z, dia / 2 + 0.15 * Math.min(h, 8) + 0.3]);
  const blocked = (ax, az, bx, bz) => trunks.some(([x, z, r]) => {
    const dx = bx - ax, dz = bz - az, L2 = dx * dx + dz * dz || 1, t = Math.min(1, Math.max(0, ((x - ax) * dx + (z - az) * dz) / L2));
    return Math.hypot(ax + dx * t - x, az + dz * t - z) < r;
  });
  plan.builds.forEach((b, bi) => {
    if (b.kind !== 'house') return;
    const [, y, , w] = b.q, a = 2 * Math.atan2(y, w), fd = b.h.nz * b.h.rd / 2;
    const fx = b.p[0] + Math.sin(a) * fd, fz = b.p[2] + Math.cos(a) * fd;
    let best = -1, bd = P.dropMax;
    plan.poles.forEach(([x, z], i) => { const d = Math.hypot(x - fx, z - fz); if (d < bd && !blocked(x, z, fx, fz)) { bd = d; best = i; } });
    if (best >= 0) plan.drops.push([best, bi]);
  });
}

/** Lot-local frame: u across the lot (along x), w from its back (w = 0) to its front (w = depth), toward the street. */
function lotFrame(lot) {
  const W = lot.x1 - lot.x0, D = lot.z1 - lot.z0, f = lot.face;
  const cx = (lot.x0 + lot.x1) / 2;
  // face +1: front at z1, the lot's u is +x; face -1: front at z0, turned half round (u is -x)
  const toW = (u, w) => (f > 0 ? [cx + u, lot.z0 + w] : [cx - u, lot.z1 - w]);
  const toL = (x, z) => (f > 0 ? [x - cx, z - lot.z0] : [cx - x, lot.z1 - z]);
  const yaw = f > 0 ? 0 : Math.PI;            // +z of a house or shed (its front) toward the street
  return { W, D, toW, toL, yaw };
}

/**
 * What goes on one lot. Everything is placed in the lot's frame, and only where it fits: inside the lot and
 * clear of what is already there (`taken`, rectangles in the lot frame). The tree's lot starts with the trunk
 * taken, then gets paving round it and the chipper; after that every lot is filled by the same rules.
 */
function fillLot(plan, lot, R, d, o, posts, edges, key) {
  const F = lotFrame(lot), { W, D, toW, yaw } = F, B = o.blend;
  const pick = (p) => R() < p;
  const add = (kind, u, w, a, extra = {}) => { const [x, z] = toW(u, w); plan.builds.push({ kind, p: [r4(x), 0, r4(z)], q: yawQ(yaw + a), ...extra }); };
  const rect = (u, w, aw, ad) => { const [x, z] = toW(u, w); plan.areas.push({ shape: 'rect', x: r4(x), z: r4(z), yaw, w: aw, d: ad }); };
  const c = o.paver;
  const cells = (m) => Math.max(1, Math.round(m / c)) * c;       // a length of whole basket-weave cells
  const taken = [];                                              // [u0, u1, w0, w1]
  const inLot = (u0, u1, w0, w1, m = 0.5) => u0 >= -W / 2 + m && u1 <= W / 2 - m && w0 >= m && w1 <= D - m;
  const free = (u0, u1, w0, w1, m = 0.5) => inLot(u0, u1, w0, w1, m) && !taken.some((t) => u0 < t[1] && u1 > t[0] && w0 < t[3] && w1 > t[2]);
  const take = (u0, u1, w0, w1) => taken.push([u0, u1, w0, w1]);

  // ---- the tree's lot: the trunk (the paving round it once the house is placed, then the chipper) ----
  const T = o.tree, [tu, tw] = F.toL(0, 0), k = T.r + T.clear;
  if (lot.tree) {
    // the trunk as it leans (its points in the lot frame), and `clear` beyond it
    const pts = (T.foot || [[0, 0]]).map(([x, z]) => F.toL(x, z)), us = pts.map((p) => p[0]), ws = pts.map((p) => p[1]);
    take(Math.min(...us) - k, Math.max(...us) + k, Math.min(...ws) - k, Math.max(...ws) + k);
  }
  // paving round the trunk, as often as a patio elsewhere: a circle or a square, as big as there is room for
  const pave = () => {
    if (!pick(0.5 + 0.4 * d)) return;
    // room: the biggest square round the trunk inside the lot and clear of what is there (but the trunk itself)
    let room = Math.min(tu + W / 2, W / 2 - tu, tw, D - tw) - 0.5;
    for (const t of taken.slice(1)) room = Math.min(room, Math.max(t[0] - tu, tu - t[1], t[2] - tw, tw - t[3]) - 0.3);
    const r = Math.min(T.paveMax * (0.6 + 0.4 * R()), room);
    if (r < T.pit + 3 * c) return;                               // (less would be a few slabs round the pit)
    if (pick(0.5)) plan.areas.push({ shape: 'circle', x: 0, z: 0, r: r4(r), pit: T.pit });
    else { const s = Math.floor(2 * r / 1.42 / c) * c; plan.areas.push({ shape: 'rect', x: 0, z: 0, yaw, w: r4(s), d: r4(s), pit: T.pit }); }
    plan.treePave = r; take(tu - r, tu + r, tw - r, tw + r);
  };

  // (after the house, so a house gets the front yard first)
  const parkChipper = () => {
    // the chipper: parked back to the tree, just outside the paving (or the trunk), wherever it fits
    // (further out if it fits nowhere near; if it fits nowhere in the lot, in the street)
    const C = T.chip, d0 = Math.max(plan.treePave || 0, k) + C.gap, a0 = R() * Math.PI * 2;
    let best = null, dist = d0;
    for (let i = 0; i < 36 && !best; i++) {
      const a = a0 + (i % 12) * Math.PI / 6, cu = Math.cos(a), cw = Math.sin(a);
      dist = d0 + 2 * Math.floor(i / 12);
      // its footprint in the lot frame, sampled (it is turned to point away from the tree)
      const pts = [];
      for (let s = 0; s <= 4; s++) for (const t of [-1, 0, 1]) {
        const l = dist + (C.x1 - C.x0) * s / 4, side = t * C.hz;
        pts.push([tu + cu * l - cw * side, tw + cw * l + cu * side]);
      }
      if (pts.every(([u, w]) => free(u, u, w, w, 0.3))) best = { a, cu, cw };
    }
    if (!best) {
      // no room in the lot: parked in the street in front of it, along the kerb
      const l = (C.x1 + C.x0) / 2, [x, z] = toW(tu - l, D + o.street / 2), [xd, zd] = toW(tu - l + 1, D + o.street / 2);
      plan.chipper = { x: r4(x), z: r4(z), yaw: r4(Math.atan2(-(zd - z), xd - x)) };
      return;
    }
    {
      const l = dist - C.x0, [x, z] = toW(tu + best.cu * l, tw + best.cw * l), [xd, zd] = toW(tu + best.cu * (l + 1), tw + best.cw * (l + 1));
      plan.chipper = { x: r4(x), z: r4(z), yaw: r4(Math.atan2(-(zd - z), xd - x)) };
      const l0 = dist, l1 = dist + C.x1 - C.x0, us = [tu + best.cu * l0, tu + best.cu * l1], ws = [tw + best.cw * l0, tw + best.cw * l1];
      take(Math.min(...us) - C.hz, Math.max(...us) + C.hz, Math.min(...ws) - C.hz, Math.max(...ws) + C.hz);
    }
  };

  // ---- the house: the biggest that fits, set back from the street ----
  const side = 1.5 + 2.5 * (1 - d) * R(), setback = 3 + 3 * (1 - d) * R();
  let house = null;
  if (pick(lot.tree ? 0.85 : 0.5 + 0.45 * d)) {
    const maxW = Math.min(14, W - 2 * side), nx0 = Math.min(3, Math.floor(maxW / 3.4)), nz0 = pick(0.6) ? 2 : 1;
    const st = pick(0.2 + 0.35 * d) ? 2 : 1, slide = R() - 0.5, pitch = r4(0.4 + 0.3 * R()), shrink = 0.85 + 0.15 * R(), lshape = R(), cutSide = R(), doorR = R();
    for (let nz = nz0; nz >= 1 && !house; nz--) for (let nx = nx0; nx >= 1 && !house; nx--) {
      const rw = r4(Math.min(4.5, maxW / nx) * shrink), rd = r4(4.3 * shrink), hw = nx * rw, hd = nz * rd, w = D - setback - hd / 2;
      for (const s of [slide, -slide, 0]) {
        const u = s * Math.max(0, W - 2 * side - hw);
        // the house and its porch in front
        if (!free(u - hw / 2, u + hw / 2, w - hd / 2, w + hd / 2 + 2)) continue;
        let cut = null;
        if (nx >= 2 && nz === 2 && lshape < 0.35) cut = [cutSide < 0.5 ? 0 : nx - 1, 1];
        let door = Math.floor(doorR * nx); if (cut && door === cut[0]) door = cut[0] === 0 ? 1 : nx - 2;
        house = { h: { nx, nz, st, cut, door, rw, rd, pitch, depth: 0.5 }, u, w, hw, hd };
        break;
      }
    }
  }
  if (house) take(house.u - house.hw / 2, house.u + house.hw / 2, house.w - house.hd / 2, house.w + house.hd / 2 + 2);   // with its porch
  if (lot.tree) { pave(); parkChipper(); }
  if (house) {
    const { h, u, w, hw, hd } = house;
    add('house', u, w, 0, { h });
    // the house's level ground reaches its porch
    const [x, z] = toW(u, w);
    plan.pads.push({ x: r4(x), z: r4(z), r: r4(Math.hypot(hw / 2, hd / 2 + 2) + 0.5), blend: B });

    // porch and sidewalk from the door
    const du = u + (h.door - (h.nx - 1) / 2) * h.rw - h.rw / 4, front = w + hd / 2, kind = R();
    const porchD = cells(1.8), walkW = cells(1.2);
    let walkFrom = front;
    if (kind < 0.65) { rect(du, front + porchD / 2 + 0.05, cells(2.4), porchD); walkFrom = front + porchD + 0.06; }
    if (kind >= 0.35) {
      // (only where nothing stands in the way: the tree may be in the front yard)
      const L = Math.floor((D - walkFrom - 0.05) / c) * c;
      if (L > 0.5 && free(du - walkW / 2, du + walkW / 2, walkFrom + 0.01, walkFrom + L, 0)) { rect(du, walkFrom + L / 2, walkW, r4(L)); take(du - walkW / 2, du + walkW / 2, walkFrom, walkFrom + L); }
    }
    house.door = du;

    // a patio behind the house
    if (pick(0.25 + 0.3 * d)) {
      const pw = cells(Math.min(hw, 3.6)), pd = cells(3), pu = u + (R() - 0.5) * (hw - pw), pwc = w - hd / 2 - pd / 2 - 0.05;
      if (free(pu - pw / 2, pu + pw / 2, pwc - pd / 2, pwc + pd / 2 - 0.1, 1)) {
        rect(pu, pwc, pw, pd); take(pu - pw / 2, pu + pw / 2, pwc - pd / 2, pwc + pd / 2);
        const [px, pz] = toW(pu, pwc);
        plan.pads.push({ x: r4(px), z: r4(pz), r: r4(Math.hypot(pw, pd) / 2 + 0.3), blend: B, yAt: [r4(x), r4(z)] });
      }
    }
  }

  // ---- a shed in a back corner, its door toward the house ----
  if (pick(lot.tree ? 0.8 : 0.2 + 0.4 * d)) {
    const s0 = pick(0.5) ? -1 : 1, hw = SHED.W / 2, hd = SHED.D / 2;
    for (const s of [s0, -s0]) {
      const u = s * (W / 2 - 1 - hw), w = 1 + hd;
      if (!free(u - hw, u + hw, w - hd, w + hd + 1, 0.9)) continue;
      add('shed', u, w, 0); take(u - hw, u + hw, w - hd, w + hd + 1);
      const [x, z] = toW(u, w);
      plan.pads.push({ x: r4(x), z: r4(z), r: r4(Math.hypot(SHED.W, SHED.D) / 2 + 0.3), blend: B });
      break;
    }
  }

  // ---- fences: the sides and back, sometimes the front with a gap at the path ----
  if (pick(o.fence)) {
    const styles = ['privacy', 'rail2', 'split'], wts = [0.4, 0.35, 0.25];
    let r = R(), style = styles[2];
    for (let i = 0; i < 3; i++) { if (r < wts[i]) { style = styles[i]; break; } r -= wts[i]; }
    const L = (u, w) => toW(u, w);
    const corners = { bl: L(-W / 2, 0), br: L(W / 2, 0), fl: L(-W / 2, D), fr: L(W / 2, D) };
    fenceRun(plan, style, corners.bl, corners.br, posts, edges, key);
    fenceRun(plan, style, corners.fl, corners.bl, posts, edges, key);
    fenceRun(plan, style, corners.br, corners.fr, posts, edges, key);
    if (pick(0.35)) {
      const g = house ? house.door : 0, gap = 0.8;
      fenceRun(plan, style, corners.fr, L(g + gap, D), posts, edges, key);
      fenceRun(plan, style, L(g - gap, D), corners.fl, posts, edges, key);
    }
  }

  // ---- trees, where there is room left: their own random numbers (seeded by the lot), so that adding them did
  // not move anything else ----
  const TR = o.trees;
  if (TR && TR.n > 0) {
    const Rt = rng(o.seed * 9973 + Math.round(lot.x0 * 10) * 7919 + Math.round(lot.z0 * 10) * 104729);
    const want = Math.floor(TR.n) + (Rt() < TR.n - Math.floor(TR.n) ? 1 : 0);
    for (let i = 0, got = 0; i < want * 12 && got < want; i++) {
      const h = TR.hmin + (Math.max(TR.hmin, TR.hmax) - TR.hmin) * Rt(), dia = h * TR.thick * (0.8 + 0.4 * Rt());
      const u = (Rt() - 0.5) * W, w = Rt() * D, seed = 1 + Math.floor(Rt() * 1e6);
      // the trunk clear of the lot's edges (its fences) and of everything else by a fifth of its height
      const k = dia / 2 + Math.max(1.5, 0.2 * h);
      if (!free(u - k, u + k, w - k, w + k, 1)) continue;
      take(u - k, u + k, w - k, w + k);
      const [x, z] = toW(u, w);
      plan.trees.push([r4(x), r4(z), seed, r4(h), r4(dia)]);
      got++;
    }
  }
}

/**
 * A fence run from a to b ([x, z]), as many whole sections as come closest to the style's span. A lot line two
 * lots share is fenced once; a corner post two runs share is put up once.
 */
function fenceRun(plan, style, a, b, posts, edges, key) {
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]); if (len < 1) return;
  const ek = [key(...a), key(...b)].sort().join('|'); if (edges.has(ek)) return; edges.add(ek);
  const S = FENCE[style].SPAN, n = Math.max(1, Math.round(len / S)), span = r4(len / n);
  const ka = key(...a), kb = key(...b), start = !posts.has(ka), end = !posts.has(kb);
  posts.add(ka); posts.add(kb);
  // the run goes along its own +x; turned about y so that +x points from a to b
  const yaw = Math.atan2(-(b[1] - a[1]), b[0] - a[0]);
  plan.builds.push({ kind: `fence:${style}`, n, span, start, end, p: [r4(a[0]), 0, r4(a[1])], q: yawQ(yaw) });
}

/** Corners of a build's footprint in world x, z (for seating it on the ground): sheds and houses. */
export function footprint(b) {
  const pts = b.kind === 'house' ? houseFoot(b.h) : [[-SHED.W / 2, -SHED.D / 2], [SHED.W / 2, -SHED.D / 2], [SHED.W / 2, SHED.D / 2], [-SHED.W / 2, SHED.D / 2]];
  const [, y, , w] = b.q, a = 2 * Math.atan2(y, w), ca = Math.cos(a), sa = Math.sin(a);
  return pts.map(([x, z]) => [b.p[0] + x * ca + z * sa, b.p[2] - x * sa + z * ca]);
}
