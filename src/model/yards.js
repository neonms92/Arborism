// Procedural yards round the tree. Plain data and a pure, seeded function:
// the host plans the neighbourhood with planYards, then puts its builds up
// and lays its pavers through the usual events (sim/builds.js, sim/pavers.js),
// so only those events cross the network.
//
// The neighbourhood is blocks of lots along x, separated by streets. A block
// is two rows of lots back to back, each row facing its own street; both rows
// of a block share their lot lines, so a lot line is one fence, not two. The
// tree stands in the back half of a lot (the tree's yard), wider and deeper
// than the rest so the paved circle, the shed and the parked chipper fit in
// it. Each lot may have:
//   a house (rooms glued on a foundation, model/builds.js) facing the street, with a porch of pavers
//     at its door, a paver sidewalk out to the street, or both;
//   a patio of pavers behind the house; a shed in a back corner;
//   a fence round its sides and back, and sometimes along the front with a gap where the path is.
// DENSITY (0..1) raises the chance of each of these, and lots get smaller as it rises (LOT_MAX at 0,
// LOT_MIN at 1). The plan is laid out in x, z only: heights come later from the ground, which is made
// with the pads the plan asks for (houses, patios and sheds stand on level ground; fences and sidewalks
// follow the slopes).
//
// plan = {lots: [{x0, x1, z0, z1, face, tree}], builds: [{kind, p:[x, 0, z], q, ...}],
//         areas: [paver areas, model/pavers.js], pads: [{x, z, r, blend, yAt?}]}

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
 * o = {seed, density, lotMax, lotMin, extent, street, fence, blend, paver (cell), paveR (the tree's paved circle),
 *      treeLot: {x0, x1, z0} (the least the tree's lot must cover: the tree's circle, the shed, the chipper),
 *      treeOnly (only the tree's lot)}
 */
export function planYards(o) {
  const R = rng(o.seed * 7919 + 17), d = Math.min(1, Math.max(0, o.density));
  const lotW = o.lotMax + (o.lotMin - o.lotMax) * d, lotD = lotW * 1.4, E = o.extent, ST = o.street;
  const plan = { lots: [], builds: [], areas: [], pads: [] };
  const jit = (v, f = 0.15) => v * (1 + (R() * 2 - 1) * f);

  // the tree's lot: its back far enough behind the tree for the shed, its front leaving room for a house
  // (in front of the paving: a 2 m gap, a house up to about 9 m deep and a front yard)
  const T = o.treeLot, tW = Math.max(lotW, 2 * Math.max(-T.x0, T.x1) + 2), tz0 = T.z0 - 1.5, tz1 = o.paveR + 15;

  // lot lines along x for a block: the tree's block starts from the tree's lot, others from a random offset
  const cuts = (tree) => {
    const xs = tree ? [-tW / 2, tW / 2] : [(R() - 0.5) * lotW];
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
  if (!o.treeOnly) {
    for (let z = tz1 + ST; z < E; ) { const D = jit(lotD) * 2; block(z, z + D, false); z += D + ST; }
    for (let z = treeBack - ST; z > -E; ) { const D = jit(lotD) * 2; block(z - D, z, false); z -= D + ST; }
  }

  const posts = new Set(), edges = new Set();
  const key = (x, z) => `${Math.round(x * 20)},${Math.round(z * 20)}`;
  for (const row of rows) {
    for (let k = 0; k + 1 < row.xs.length; k++) {
      const x0 = row.xs[k], x1 = row.xs[k + 1], tree = row.tree && Math.abs(x0 + x1) < 1e-6;
      if (o.treeOnly && !tree) continue;
      if (!tree && (Math.abs((x0 + x1) / 2) > E || Math.abs((row.z0 + row.z1) / 2) > E)) continue;
      const lot = { x0, x1, z0: row.z0, z1: row.z1, face: row.face, tree };
      plan.lots.push(lot);
      fillLot(plan, lot, R, d, o, posts, edges, key);
    }
  }
  return plan;
}

/** Lot-local frame: u across the lot (along x), w from its back (w = 0) to its front (w = depth), toward the street. */
function lotFrame(lot) {
  const W = lot.x1 - lot.x0, D = lot.z1 - lot.z0, f = lot.face;
  const cx = (lot.x0 + lot.x1) / 2;
  // face +1: front at z1, the lot's u is +x; face -1: front at z0, turned half round (u is -x)
  const toW = (u, w) => (f > 0 ? [cx + u, lot.z0 + w] : [cx - u, lot.z1 - w]);
  const yaw = f > 0 ? 0 : Math.PI;            // +z of a house or shed (its front) toward the street
  return { W, D, toW, yaw };
}

function fillLot(plan, lot, R, d, o, posts, edges, key) {
  const F = lotFrame(lot), { W, D, toW, yaw } = F, B = o.blend;
  const pick = (p) => R() < p;
  const add = (kind, u, w, a, extra = {}) => { const [x, z] = toW(u, w); plan.builds.push({ kind, p: [r4(x), 0, r4(z)], q: yawQ(yaw + a), ...extra }); };
  const rect = (u, w, aw, ad) => { const [x, z] = toW(u, w); plan.areas.push({ shape: 'rect', x: r4(x), z: r4(z), yaw, w: aw, d: ad }); };
  const c = o.paver;
  const cells = (m) => Math.max(1, Math.round(m / c)) * c;       // a length of whole basket-weave cells

  // ---- the house ----
  const side = 1.5 + 2.5 * (1 - d) * R(), setback = 3 + 3 * (1 - d) * R();
  let house = null;
  const backLimit = lot.tree ? (o.paveR + 2) - lot.z0 : 0;      // in the tree's lot the house stays clear of the paving
  if (lot.tree || pick(0.5 + 0.45 * d)) {
    const maxW = Math.min(14, W - 2 * side), room = D - setback - Math.max(backLimit, 4);
    const nx = Math.min(3, Math.floor(maxW / 3.4)), nzMax = room >= 8.5 ? 2 : room >= 4 ? 1 : 0;
    if (nx >= 1 && nzMax >= 1) {
      const rw = r4(Math.min(4.5, maxW / nx) * (0.85 + 0.15 * R())), nz = nzMax === 2 && pick(0.6) ? 2 : 1, rd = r4(Math.min(4.3, (room - 0.5) / nz) * (0.85 + 0.15 * R()));
      const st = pick(0.2 + 0.35 * d) ? 2 : 1;
      let cut = null;
      if (nx >= 2 && nz === 2 && pick(0.35)) cut = [pick(0.5) ? 0 : nx - 1, 1];
      let door = Math.floor(R() * nx); if (cut && door === cut[0]) door = cut[0] === 0 ? 1 : nx - 2;
      const h = { nx, nz, st, cut, door, rw, rd, pitch: r4(0.4 + 0.3 * R()), depth: 0.5 };
      const hw = nx * rw, hd = nz * rd, u = (R() - 0.5) * Math.max(0, W - 2 * side - hw), w = D - setback - hd / 2;
      house = { h, u, w, hw, hd };
      add('house', u, w, 0, { h });
      // the house's level ground reaches its porch
      const [x, z] = toW(u, w);
      plan.pads.push({ x: r4(x), z: r4(z), r: r4(Math.hypot(hw / 2, hd / 2 + 2) + 0.5), blend: B });

      // porch and sidewalk from the door
      const du = u + (door - (nx - 1) / 2) * rw - rw / 4, front = w + hd / 2, kind = R();
      const porchD = cells(1.8), walkW = cells(1.2);
      let walkFrom = front;
      if (kind < 0.65) { rect(du, front + porchD / 2 + 0.05, cells(2.4), porchD); walkFrom = front + porchD + 0.06; }
      if (kind >= 0.35) { const L = Math.floor((D - walkFrom - 0.05) / c) * c; if (L > 0.5) rect(du, walkFrom + L / 2, walkW, r4(L)); }
      house.door = du;

      // a patio behind the house
      const behind = w - hd / 2 - (lot.tree ? backLimit : 0);
      if (!lot.tree && behind > 4.5 && pick(0.25 + 0.3 * d)) {
        const pw = cells(Math.min(hw, 3.6)), pd = cells(Math.min(behind - 1.5, 3)), pu = u + (R() - 0.5) * (hw - pw), pwc = w - hd / 2 - pd / 2 - 0.05;
        rect(pu, pwc, pw, pd);
        const [px, pz] = toW(pu, pwc);
        plan.pads.push({ x: r4(px), z: r4(pz), r: r4(Math.hypot(pw, pd) / 2 + 0.3), blend: B, yAt: [r4(x), r4(z)] });
      }
    }
  }

  // ---- a shed in a back corner, its door toward the house (the tree's own shed is put up by sim/builds.js) ----
  if (!lot.tree) {
    const behind = house ? house.w - house.hd / 2 : D;
    if (behind > SHED.D + 3 && pick(0.2 + 0.4 * d)) {
      const s = pick(0.5) ? -1 : 1, u = s * (W / 2 - 1 - SHED.W / 2), w = 1 + SHED.D / 2;
      add('shed', u, w, 0);
      const [x, z] = toW(u, w);
      plan.pads.push({ x: r4(x), z: r4(z), r: r4(Math.hypot(SHED.W, SHED.D) / 2 + 0.3), blend: B });
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
