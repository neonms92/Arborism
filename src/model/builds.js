// Breakable structures ("builds"): their shapes and their state. Plain data,
// part of the world model. sim/builds.js decides when they break, and
// view/builds.js draws them.
//
// A build is made of MODULES glued together. A module is one unit that is
// either intact (rigid, simple collision, no physics of its own) or broken
// (its parts are loose bodies). A shed is one module; a bigger structure is
// several modules with glue between them, so one part of it can be smashed
// while the rest stands: a fence is one module per section.
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
// mod = {p, q, ground, shape ('shed' or a fence style), end (a fence's last section),
//        parts: [part...] (from its shape, module-local),
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

// ---- fences: one module per section between posts ----
// Module frame: origin on the ground at the section's first post, the fence
// runs along +x for SPAN, +z is its good face. Each section has its first
// post; the last section of a run also has the post that closes it.
export const FENCE = {
  rail2: { SPAN: 2.44, H: 1.2, POST: 0.09, RAILS: [0.45, 1.0], RAIL: [0.04, 0.14] },          // two-rail: square posts, two boards on edge
  split: { SPAN: 3.0, H: 1.3, POST: 0.16, RAILS: [0.35, 0.75, 1.1], RAIL: [0.1, 0.12] },      // split rail: rough posts and split logs
  privacy: { SPAN: 2.44, H: 1.83, POST: 0.09, RAILS: [0.25, 0.95, 1.6], RAIL: [0.04, 0.09], PICKET: [0.14, 0.016] },  // 6 ft privacy: pickets nailed to three rails
};

export function fenceParts(style, end) {
  const F = FENCE[style], P = F.POST, out = [], gap = 0.004;
  const box = (x0, x1, y0, y1, z0, z1, mat, q = I) => out.push({ c: [(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2], h: [(x1 - x0) / 2, (y1 - y0) / 2, (z1 - z0) / 2], q, mat });
  const post = (x) => box(x - P / 2, x + P / 2, 0, F.H + (style === 'split' ? 0.08 : 0), -P / 2, P / 2, style === 'split' ? 'rough' : 'post');
  post(0); if (end) post(F.SPAN);
  const x0 = P / 2 + gap, x1 = F.SPAN - P / 2 - gap, [rt, rh] = F.RAIL;
  F.RAILS.forEach((y, i) => {
    if (style === 'split') {                 // a split log, turned a little about its length so the rails are not all alike
      const tw = (i % 2 ? 1 : -1) * 0.25;
      out.push({ c: [(x0 + x1) / 2, y, 0], h: [(x1 - x0) / 2, rh / 2, rt / 2], q: [Math.sin(tw / 2), 0, 0, Math.cos(tw / 2)], mat: 'rough' });
    } else {
      const zf = style === 'privacy' ? P / 2 : rt / 2;     // a privacy fence's rails are flush with the posts' good face, for the pickets
      box(x0, x1, y - rh / 2, y + rh / 2, zf - rt, zf, 'rail');
    }
  });
  if (style === 'privacy') {                 // pickets on the good face, from the first post's middle to the next one's
    const [pw, pt] = F.PICKET, n = Math.round(F.SPAN / (pw + gap));
    const w = F.SPAN / n;
    for (let i = 0; i < n; i++) box(i * w + gap / 2, (i + 1) * w - gap / 2, 0.03, F.H, P / 2 + gap, P / 2 + gap + pt, 'picket');
  }
  return out;
}

/** The parts of one module, from its shape. */
export function modParts(m) { return m.shape === 'shed' ? shedParts() : fenceParts(m.shape, m.end); }

/**
 * Kinds of build: module poses (build frame), shapes and glue. 'shed'; 'stack' (two sheds glued one on the
 * other, not placed by default); 'fence:<style>' with n sections in a row, each glued to the next.
 */
function layout(kind, n = 4) {
  const S = SHED;
  if (kind.startsWith('fence:')) {
    const style = kind.slice(6), F = FENCE[style], mods = [], glue = [];
    for (let i = 0; i < n; i++) { mods.push({ p: [i * F.SPAN, 0, 0], q: I, ground: true, shape: style, end: i === n - 1 }); if (i) glue.push([i - 1, i]); }
    return { mods, glue };
  }
  if (kind === 'stack') return { mods: [{ p: [0, 0, 0], q: I, ground: true, shape: 'shed' }, { p: [0, S.HF + S.ROOF_T + 0.01, 0], q: I, ground: false, shape: 'shed' }], glue: [[0, 1]] };
  return { mods: [{ p: [0, 0, 0], q: I, ground: true, shape: 'shed' }], glue: [] };
}

/** A build, fresh and intact, from {id, kind, p, q, n}. */
export function newBuild(b) {
  const L = layout(b.kind, b.n);
  return {
    id: b.id, kind: b.kind, p: b.p, q: b.q, glue: L.glue, bodies: {},
    mods: L.mods.map((m) => ({ p: m.p, q: m.q, ground: m.ground, shape: m.shape, end: !!m.end, parts: modParts(m), body: b.id, ids: null, at: null })),
  };
}

/** Contact force (N) that breaks an intact module of this shape. */
export function breakForce(m, CFG) { return m.shape === 'shed' ? CFG.SHED_BREAK_F : CFG.FENCE_BREAK_F; }

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
