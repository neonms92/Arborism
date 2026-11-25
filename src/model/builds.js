// Breakable structures ("builds"): their shapes and their state. Plain data,
// part of the world model. sim/builds.js decides when they break, and
// view/builds.js draws them.
//
// A build is made of MODULES glued together. A module is one unit that is
// either intact (rigid, simple collision, no physics of its own) or broken
// (its parts are loose bodies). A shed is one module; a bigger structure is
// several modules with glue between them, so one part of it can be smashed
// while the rest stands.
//
// Every intact module is in a BODY. Modules glued, directly or through other
// intact modules, to a module that stands on the ground (ground: true) are in
// the build's own fixed body (id = build id, at the build's pose). Intact
// modules that lose that path to the ground move together as one loose body
// (a new id), which can itself break when it lands. All bodies of a build use
// the build's frame: a module's p, q are in it, and a loose body starts at
// the pose the body it came from had.
//
// world.builds = [{id, kind, p:[3], q:[4], mods: [mod...], glue: [[i, j]...],
//                  bodies: {id: {p, q}} (loose bodies, as they started)}]
// mod = {p, q, ground, parts: [part...] (its shape, module-local),
//        body: id of the body it is in while intact,
//        ids: null while intact, else [body id of each part] once broken,
//        at: {p, q} pose of its body when it broke}
// part = {c:[3], h:[3] half sizes, q:[4], mat}

// ---- small quaternion and frame helpers on plain arrays ----
export function qmul(a, b) {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
}
export function qrot(q, v) {
  const [x, y, z, w] = q, [vx, vy, vz] = v;
  const tx = 2 * (y * vz - z * vy), ty = 2 * (z * vx - x * vz), tz = 2 * (x * vy - y * vx);
  return [vx + w * tx + (y * tz - z * ty), vy + w * ty + (z * tx - x * tz), vz + w * tz + (x * ty - y * tx)];
}
/** Frame (p, q) followed by local frame (lp, lq). */
export function compose(p, q, lp, lq) {
  const r = qrot(q, lp);
  return { p: [p[0] + r[0], p[1] + r[1], p[2] + r[2]], q: qmul(q, lq) };
}
const I = [0, 0, 0, 1];
const rotX = (a) => [Math.sin(a / 2), 0, 0, Math.cos(a / 2)];

// ---- the shed: one module ----
// Module frame: origin on the ground in the middle of its footprint, +y up,
// +z out of the door side. A pent roof falls from the door side to the back.
export const SHED = { W: 2.4, D: 1.8, HF: 2.25, HB: 1.95, T: 0.03, FLOOR: 0.06, ROOF_T: 0.03, OVER: 0.15, DOOR: 0.8, DOOR_H: 1.9 };

export function shedParts() {
  const { W, D, HF, HB, T, FLOOR, ROOF_T, OVER, DOOR, DOOR_H } = SHED, s = (HF - HB) / D, out = [];
  const roofY = (z) => HB + (z + D / 2) * s;           // underside of the roof boards
  const box = (x0, x1, y0, y1, z0, z1, mat, q = I) => out.push({ c: [(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2], h: [(x1 - x0) / 2, (y1 - y0) / 2, (z1 - z0) / 2], q, mat });
  const gap = 0.004;                                   // so no two parts start overlapping when it comes apart
  // floor: four boards inside the walls
  for (let i = 0; i < 4; i++) { const z0 = -D / 2 + T + i * (D - 2 * T) / 4; box(-W / 2 + T, W / 2 - T, 0, FLOOR, z0 + gap, z0 + (D - 2 * T) / 4 - gap, 'floor'); }
  // corner posts, inside the walls, on the floor
  const P = 0.07;
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const x0 = sx < 0 ? -W / 2 + T + gap : W / 2 - T - gap - P, z0 = sz < 0 ? -D / 2 + T + gap : D / 2 - T - gap - P;
    box(x0, x0 + P, FLOOR + gap, roofY(Math.min(z0, z0 + P)) - gap, z0, z0 + P, 'post');
  }
  // back wall: vertical planks the full width
  const nb = 8, pw = W / nb;
  for (let i = 0; i < nb; i++) box(-W / 2 + i * pw + gap, -W / 2 + (i + 1) * pw - gap, 0, roofY(-D / 2) - gap, -D / 2, -D / 2 + T, 'wall');
  // front wall: planks either side of the door, the door, a board over it
  const fy = roofY(D / 2 - T) - gap, side = (W - DOOR) / 2;
  for (const sx of [-1, 1]) for (let i = 0; i < 3; i++) {
    const a = sx < 0 ? -W / 2 + i * side / 3 : DOOR / 2 + i * side / 3;
    box(a + gap, a + side / 3 - gap, 0, fy, D / 2 - T, D / 2, 'wall');
  }
  box(-DOOR / 2 + gap, DOOR / 2 - gap, 0.01, DOOR_H, D / 2 - T, D / 2, 'door');
  box(-DOOR / 2 + gap, DOOR / 2 - gap, DOOR_H + gap, fy, D / 2 - T, D / 2, 'wall');
  // side walls: planks along the depth, between the front and back walls, cut to the slope
  const ns = 6, sl = (D - 2 * T) / ns;
  for (const sx of [-1, 1]) for (let i = 0; i < ns; i++) {
    const z0 = -D / 2 + T + i * sl, x0 = sx < 0 ? -W / 2 : W / 2 - T;
    box(x0, x0 + T, 0, roofY(z0) - gap, z0 + gap, z0 + sl - gap, 'wall');
  }
  // roof: boards down the slope, with an overhang all round
  const th = Math.atan(s), q = rotX(-th), nr = 4, rw = (W + 2 * OVER) / nr, hl = (D / 2 + OVER) / Math.cos(th);
  const n = qrot(q, [0, 1, 0]), cy = roofY(0);
  for (let i = 0; i < nr; i++) {
    const x = -W / 2 - OVER + (i + 0.5) * rw;
    out.push({ c: [x + n[0] * ROOF_T / 2, cy + n[1] * ROOF_T / 2, n[2] * ROOF_T / 2], h: [rw / 2 - gap, ROOF_T / 2, hl], q, mat: 'roof' });
  }
  return out;
}

/** Kinds of build: module poses (build frame) and glue. 'stack' is two sheds glued one on the other (not placed by default). */
function layout(kind) {
  const S = SHED;
  if (kind === 'stack') return { mods: [{ p: [0, 0, 0], q: I, ground: true }, { p: [0, S.HF + S.ROOF_T + 0.01, 0], q: I, ground: false }], glue: [[0, 1]] };
  return { mods: [{ p: [0, 0, 0], q: I, ground: true }], glue: [] };
}

/** A build, fresh and intact, from {id, kind, p, q}. */
export function newBuild(b) {
  const L = layout(b.kind), parts = shedParts();
  return {
    id: b.id, kind: b.kind, p: b.p, q: b.q, glue: L.glue, bodies: {},
    mods: L.mods.map((m) => ({ p: m.p, q: m.q, ground: m.ground, parts, body: b.id, ids: null, at: null })),
  };
}

/** Mass of a part (kg) at density rho. */
export function partMass(pt, rho) { return 8 * pt.h[0] * pt.h[1] * pt.h[2] * rho; }

/** A smash event applied to the model (see sim/builds.js). */
export function smashBuild(builds, ev) {
  const b = builds.find((x) => x.id === ev.b); if (!b) return;
  const m = b.mods[ev.m]; if (!m || m.ids) return;
  m.ids = ev.parts; m.at = { p: ev.at.p, q: ev.at.q };
  for (const l of ev.loose) {
    b.bodies[l.body] = { p: l.p, q: l.q };
    for (const i of l.mods) b.mods[i].body = l.body;
  }
}

/**
 * Intact modules of body `body` once module `gone` breaks, grouped by glue:
 * {stay: [mods still held by the ground in the fixed body], loose: [[mods], ...]}.
 */
export function regroup(b, body, gone) {
  const live = new Set();
  b.mods.forEach((m, i) => { if (i !== gone && !m.ids && m.body === body) live.add(i); });
  const adj = new Map([...live].map((i) => [i, []]));
  for (const [i, j] of b.glue) if (live.has(i) && live.has(j)) { adj.get(i).push(j); adj.get(j).push(i); }
  const seen = new Set(), comps = [];
  for (const i of live) {
    if (seen.has(i)) continue;
    const c = [i]; seen.add(i);
    for (let k = 0; k < c.length; k++) for (const j of adj.get(c[k])) if (!seen.has(j)) { seen.add(j); c.push(j); }
    comps.push(c);
  }
  const fixed = body === b.id, stay = [], loose = [];
  for (const c of comps) { if (fixed && c.some((i) => b.mods[i].ground)) stay.push(...c); else loose.push(c); }
  return { stay, loose };
}
