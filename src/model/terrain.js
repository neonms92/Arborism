// The ground: a seeded height field. Plain data, part of the world model.
//
// world.terrain is null (flat ground at y = 0, what the engine tests use) or
// a Terrain made from a spec by makeTerrain. The spec is all that goes over
// the network: every machine builds the same grid from it.
//
// spec = {seed, size, cell, hillH, hillW, ledges, ledgeH, ledgeW, ledgeSharp, pads}
//   size, cell   m: a square grid size x size centred on the origin, a height every cell metres
//   hillH, hillW m: rolling hills, about hillH high and hillW from one top to the next
//   ledges       how many ledge levels across the ledge field (0 = no ledges)
//   ledgeH       m, height of one ledge (a step in the ground)
//   ledgeW       m, how far apart ledges wind (the scale of the field they follow)
//   ledgeSharp   fraction of the gap between two ledges taken by the riser (small = steep, ledge-like)
//   ledgeGaps    about what fraction of a ledge's length eases into a slope you can walk up instead
//                (so no hollow is walled in by ledges too high to climb)
//   pads         [{x, z, r, blend, y}] level ground: flat at height y within r of (x, z), blending
//                into the natural ground over the next `blend` m. y omitted: the natural height at
//                (x, z), or at yAt [x, z] if given (a patio level with its house's pad). Applied in order, so a later pad wins where they overlap. This is how
//                anything that needs level ground (the tree's yard, a shed, a house) gets it.
//   root         {r, sink} or absent: the job tree's base radius and how deep it sits (see below)
//   streets      [{z0, z1}] strips along x, the whole width of the grid: level across, and along their
//                length the natural ground averaged over streetSmooth m either way, so hills and ledges
//                become long gentle grades. They blend into the ground over the next streetBlend m and
//                are applied after the pads, so a street stays smooth where a pad's blend reaches it.
//
// The natural ground is shifted so it is at 0 at the origin, where the tree
// is rooted (rooted pieces sit at the origin: structure.js relies on it).
// With spec.root = {r, sink} the finished ground (after pads and streets,
// whose blends can reach the trunk) is shifted again so its lowest point
// round the trunk's base, r m out, is `sink` m above the origin: the tree
// never floats, by the same rule as the other trees (D136).
//
// Heights between grid points follow the same two triangles per cell that
// Rapier's heightfield collider uses (split along the (x1, z0)-(x0, z1)
// diagonal), so heightAt is exactly the surface things collide with.

const TAU = Math.PI * 2;
const RAMP = 0.3;          // riser width where a ledge has eased into a slope, as a fraction of the gap between ledges

/** A seeded 2-D gradient noise, about -0.7..0.7. Integer hashing, so every machine gets the same field. */
function noise2(seed) {
  const hash = (i, j) => {
    let h = Math.imul(i, 0x27d4eb2d) ^ Math.imul(j, 0x165667b1) ^ Math.imul(seed, 0x9e3779b1);
    h = Math.imul(h ^ (h >>> 15), 0x85ebca6b); h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  };
  const grad = (i, j, x, y) => { const a = hash(i, j) * TAU; return Math.cos(a) * x + Math.sin(a) * y; };
  const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);
  return (x, y) => {
    const i = Math.floor(x), j = Math.floor(y), u = x - i, v = y - j, fu = fade(u), fv = fade(v);
    const a = grad(i, j, u, v), b = grad(i + 1, j, u - 1, v), c = grad(i, j + 1, u, v - 1), d = grad(i + 1, j + 1, u - 1, v - 1);
    return a + (b - a) * fu + (c - a) * fv + (a - b - c + d) * fu * fv;
  };
}

const smooth = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

/** The natural ground (before pads) for a spec: fn(x, z) -> y. */
function naturalFn(s) {
  const hills = noise2(s.seed | 0), ledgeN = noise2((s.seed | 0) + 7919), gapN = noise2((s.seed | 0) + 104729);
  const thr = (0.5 - Math.min(1, Math.max(0, s.ledgeGaps ?? 0))) * 0.7;   // the gap field is above this over about ledgeGaps of the ground
  const hw = Math.max(1, s.hillW), lw = Math.max(1, s.ledgeW), e = Math.min(1, Math.max(1e-3, s.ledgeSharp));
  const raw = (x, z) => {
    let y = 0;
    if (s.hillH) {
      // three octaves; the first sets the hills, the rest roughen them a little
      y += s.hillH * (hills(x / hw, z / hw) + 0.35 * hills(2.1 * x / hw + 17.3, 2.1 * z / hw - 4.1) + 0.12 * hills(4.3 * x / hw - 9.7, 4.3 * z / hw + 23.9));
    }
    if (s.ledges > 0 && s.ledgeH) {
      // a stair over a second field: flat treads, and a riser wherever the field crosses a level
      const L = ledgeN(x / lw, z / lw) + 0.3 * ledgeN(2.3 * x / lw + 41.2, 2.3 * z / lw - 13.7);
      // where the gap field is high the riser widens to a walkable slope (about RAMP of the gap between ledges)
      const g = smooth((gapN(1.7 * x / lw - 3.1, 1.7 * z / lw + 8.3) - thr) / 0.12 + 0.5), ee = e + (Math.max(e, RAMP) - e) * g;
      const t = (L / 0.9 + 1) * 0.5 * s.ledges, k = Math.floor(t), f = t - k;
      y += s.ledgeH * (k + Math.min(1, Math.max(0, (f - (1 - ee)) / ee)));
    }
    return y;
  };
  const y0 = raw(0, 0);
  return (x, z) => raw(x, z) - y0;
}

/** Weight of a street at z: 1 on it, easing to 0 over blend m beside it. */
function streetW(st, z, blend) {
  const d = z < st.z0 ? st.z0 - z : z > st.z1 ? z - st.z1 : 0;
  return d <= 0 ? 1 : blend <= 0 ? 0 : 1 - smooth(d / blend);
}

/**
 * A street's height at each grid column: the natural ground averaged across the street, then along it
 * with two passes of a running mean `reach` m either way (a smooth, gentle grade; clamped at the ends).
 */
function streetProfile(nat, st, n, cell, half, reach) {
  const N = n + 1, a = new Float64Array(N), m = Math.max(1, Math.round((st.z1 - st.z0) / cell));
  for (let j = 0; j < N; j++) {
    const x = -half + j * cell;
    let sum = 0; for (let k = 0; k <= m; k++) sum += nat(x, st.z0 + (st.z1 - st.z0) * k / m);
    a[j] = sum / (m + 1);
  }
  const r = Math.round(Math.max(0, reach) / cell);
  let p = a;
  for (let pass = 0; pass < 2 && r > 0; pass++) {
    const pre = new Float64Array(N + 1), q = new Float64Array(N);
    for (let j = 0; j < N; j++) pre[j + 1] = pre[j] + p[j];
    for (let j = 0; j < N; j++) {
      // a window that keeps its full width at the ends of the grid (shifted inward), so the ends do not dip
      const lo = Math.max(0, Math.min(j - r, N - 1 - 2 * r)), hi = Math.min(N - 1, lo + 2 * r);
      q[j] = (pre[hi + 1] - pre[lo]) / (hi - lo + 1);
    }
    p = q;
  }
  return Float32Array.from(p);
}

export class Terrain {
  constructor(spec) {
    const s = this.spec = spec, cell = this.cell = Math.max(0.1, s.cell);
    const n = this.n = Math.max(2, Math.round(s.size / cell));     // cells along each side
    this.half = n * cell / 2;
    const nat = naturalFn(s);
    const pads = (s.pads || []).map((p) => ({ ...p, y: p.y ?? (p.yAt ? nat(p.yAt[0], p.yAt[1]) : nat(p.x, p.z)), blend: p.blend ?? 0 }));
    this.pads = pads;
    const streets = this.streets = (s.streets || []).map((st) => ({ z0: Math.min(st.z0, st.z1), z1: Math.max(st.z0, st.z1), prof: null }));
    const sb = this.streetBlend = Math.max(0, s.streetBlend ?? 0);
    for (const st of streets) st.prof = streetProfile(nat, st, n, cell, this.half, s.streetSmooth ?? 0);
    // Rapier's layout: column-major, heights[i + j * (n + 1)] for row i (along z) and column j (along x)
    const H = this.h = new Float32Array((n + 1) * (n + 1));
    for (let j = 0; j <= n; j++) {
      const x = -this.half + j * cell;
      for (let i = 0; i <= n; i++) {
        const z = -this.half + i * cell;
        let y = nat(x, z);
        for (const p of pads) {
          const w = 1 - smooth((Math.hypot(x - p.x, z - p.z) - p.r) / Math.max(1e-6, p.blend));
          if (w > 0) y += (p.y - y) * w;
        }
        for (const st of streets) {
          const w = streetW(st, z, sb);
          if (w > 0) y += (st.prof[j] - y) * w;
        }
        H[i + j * (n + 1)] = y;
      }
    }
    // the job tree stands at the origin: seat it on the finished ground, not the natural ground (D136)
    if (s.root) {
      const r = Math.max(0, s.root.r || 0);
      let low = this.heightAt(0, 0);
      for (let k = 0; k < 16; k++) low = Math.min(low, this.heightAt(Math.cos(k * TAU / 16) * r, Math.sin(k * TAU / 16) * r));
      const dy = (s.root.sink || 0) - low;
      for (let q = 0; q < H.length; q++) H[q] += dy;
      for (const p of pads) p.y += dy;
    }
    let lo = Infinity, hi = -Infinity;
    for (const y of H) { if (y < lo) lo = y; if (y > hi) hi = y; }
    this.lo = lo; this.hi = hi;
  }

  /** How much of world (x, z) is street surface: 1 on a street, 0 off it (the blend beside it is not street). */
  streetAt(x, z) {
    for (const st of this.streets) if (z >= st.z0 && z <= st.z1) return 1;
    return 0;
  }

  /** Grid height at row i (z), column j (x), clamped to the grid. */
  at(i, j) {
    const n = this.n;
    i = i < 0 ? 0 : i > n ? n : i; j = j < 0 ? 0 : j > n ? n : j;
    return this.h[i + j * (n + 1)];
  }

  /** The cell and the triangle under world (x, z): {i, j, u, v, up} (up: the triangle on the far side of the diagonal). */
  _cell(x, z) {
    const n = this.n, fx = Math.min(n - 1e-9, Math.max(0, (x + this.half) / this.cell)), fz = Math.min(n - 1e-9, Math.max(0, (z + this.half) / this.cell));
    const j = Math.floor(fx), i = Math.floor(fz), u = fx - j, v = fz - i;
    return { i, j, u, v, up: u + v >= 1 };
  }

  /** Ground height at world (x, z), m. Outside the grid: the height at its nearest edge. */
  heightAt(x, z) {
    const { i, j, u, v, up } = this._cell(x, z);
    if (!up) { const h00 = this.at(i, j); return h00 + u * (this.at(i, j + 1) - h00) + v * (this.at(i + 1, j) - h00); }
    const h11 = this.at(i + 1, j + 1);
    return h11 + (1 - u) * (this.at(i + 1, j) - h11) + (1 - v) * (this.at(i, j + 1) - h11);
  }

  /** Upward unit normal of the ground at world (x, z): [nx, ny, nz]. */
  normalAt(x, z) {
    const { i, j, up } = this._cell(x, z), c = this.cell;
    let dx, dz;            // dy/dx and dy/dz on that triangle
    if (!up) { const h00 = this.at(i, j); dx = (this.at(i, j + 1) - h00) / c; dz = (this.at(i + 1, j) - h00) / c; }
    else { const h11 = this.at(i + 1, j + 1); dx = (h11 - this.at(i + 1, j)) / c; dz = (h11 - this.at(i, j + 1)) / c; }
    const l = Math.hypot(dx, 1, dz);
    return [-dx / l, 1 / l, -dz / l];
  }

  /** Slope of the ground at world (x, z), rad from level. */
  slopeAt(x, z) { return Math.acos(Math.min(1, this.normalAt(x, z)[1])); }

  /**
   * Lowest and highest ground over a footprint: the points pts [[x, z], ...] and every grid point inside
   * their bounding box. {lo, hi}.
   */
  range(pts) {
    let lo = Infinity, hi = -Infinity, x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const [x, z] of pts) {
      const y = this.heightAt(x, z); if (y < lo) lo = y; if (y > hi) hi = y;
      x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z);
    }
    const c = this.cell, h = this.half;
    for (let j = Math.ceil((x0 + h) / c); j <= Math.floor((x1 + h) / c); j++) {
      for (let i = Math.ceil((z0 + h) / c); i <= Math.floor((z1 + h) / c); i++) { const y = this.at(i, j); if (y < lo) lo = y; if (y > hi) hi = y; }
    }
    return { lo, hi };
  }
}

/** A terrain from a spec, or null for flat ground. */
export function makeTerrain(spec) { return spec ? new Terrain(spec) : null; }

/** The spec for the current settings, with these pads. CFG.TERRAIN_* (config.js). */
export function terrainSpec(CFG, pads = [], streets = [], root = { r: CFG.TREE_DIAMETER / 2, sink: CFG.ROOT_SINK }) {
  return {
    seed: CFG.TERRAIN_SEED, size: CFG.TERRAIN_SIZE, cell: CFG.TERRAIN_CELL,
    hillH: CFG.TERRAIN_HILL_H, hillW: CFG.TERRAIN_HILL_W,
    ledges: CFG.TERRAIN_LEDGES, ledgeH: CFG.TERRAIN_LEDGE_H, ledgeW: CFG.TERRAIN_LEDGE_W, ledgeSharp: CFG.TERRAIN_LEDGE_SHARP,
    ledgeGaps: CFG.TERRAIN_LEDGE_GAPS, pads,
    streets, streetSmooth: CFG.STREET_SMOOTH, streetBlend: CFG.STREET_BLEND, root,
  };
}

// Queries that take world.terrain as it is (null = flat at y = 0).
export const groundY = (t, x, z) => (t ? t.heightAt(x, z) : 0);
export const groundN = (t, x, z) => (t ? t.normalAt(x, z) : [0, 1, 0]);
export const groundRange = (t, pts) => (t ? t.range(pts) : { lo: 0, hi: 0 });
