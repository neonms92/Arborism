// Breakable structures ("builds"): their shapes and their state. Plain data,
// part of the world model. sim/builds.js decides when they break, and
// view/builds.js draws them.
//
// A build is made of MODULES glued together. A module is one unit that is
// either intact (rigid, simple collision, no physics of its own) or broken
// (its parts are loose bodies). A shed is one module; a bigger structure is
// several modules with glue between them, so one part of it can be smashed
// while the rest stands: a fence is one module per section, a house one per room.
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
// mod = {p, q, ground, shape ('shed', a fence style, 'room', 'found' or a car's 'carbody', 'carcabin', 'carhood', 'carboot'), end (a fence's last section),
//        s (a room's or foundation's shape parameters),
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
// runs along +x for SPAN (or the run's own span), +z is its good face. Each section has its first
// post (unless the run starts on a post another run already has); the last section of a run also
// has the post that closes it (`end`, likewise).
export const FENCE = {
  rail2: { SPAN: 2.44, H: 1.2, POST: 0.09, RAILS: [0.45, 1.0], RAIL: [0.04, 0.14] },          // two-rail: square posts, two boards on edge
  split: { SPAN: 3.0, H: 1.3, POST: 0.16, RAILS: [0.35, 0.75, 1.1], RAIL: [0.1, 0.12] },      // split rail: rough posts and split logs
  privacy: { SPAN: 2.44, H: 1.83, POST: 0.09, RAILS: [0.25, 0.95, 1.6], RAIL: [0.04, 0.09], PICKET: [0.14, 0.016] },  // 6 ft privacy: pickets nailed to three rails
};

export function fenceParts(style, end, span = FENCE[style].SPAN, start = true) {
  const F = { ...FENCE[style], SPAN: span }, P = F.POST, out = [], gap = 0.004;
  const box = (x0, x1, y0, y1, z0, z1, mat, q = I) => out.push({ c: [(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2], h: [(x1 - x0) / 2, (y1 - y0) / 2, (z1 - z0) / 2], q, mat });
  const post = (x) => box(x - P / 2, x + P / 2, 0, F.H + (style === 'split' ? 0.08 : 0), -P / 2, P / 2, style === 'split' ? 'rough' : 'post');
  if (start) post(0); if (end) post(F.SPAN);
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

// ---- houses: one module per room, on a foundation ----
// A house is a grid of rooms (nx along its x, nz along its z, st storeys; `cut` [ix, iz] leaves one corner
// room out for an L), with a gable roof whose ridge runs along x through the middle of its depth. Its frame:
// origin at the bottom of the ground floor in the middle of the grid, +z is the front (the street side),
// where the door is, in front room column `door`. Every room is a module, glued to its neighbours on its
// storey and to the room under it; the ground floor's rooms are glued to the FOUNDATION, a module that
// stands on the ground and does not break (concrete), so a room only comes loose when every glued path from
// it to the foundation is gone.
//
// house spec (build.h) = {nx, nz, st, cut, door, rw, rd, pitch, depth}
//   rw, rd   m, room size along x and z;  pitch: roof rise per m;  depth: m of foundation under the floor
//            (down to below the lowest ground under the house; set when it is put up)
export const HOUSE = { WH: 2.6, T: 0.1, FL: 0.12, ROOF_T: 0.06, OVER: 0.4, DOOR: 0.95, DOOR_H: 2.05, WIN: 1.1, SILL: 0.9, WIN_TOP: 2.05, PANEL: 1.3, GABLE: 0.25 };

/** The rooms of a house: [{ix, iz, k (storey)}], and a lookup has(ix, iz). */
export function houseRooms(h) {
  const has = (ix, iz) => ix >= 0 && ix < h.nx && iz >= 0 && iz < h.nz && !(h.cut && h.cut[0] === ix && h.cut[1] === iz);
  const out = [];
  for (let k = 0; k < h.st; k++) for (let iz = 0; iz < h.nz; iz++) for (let ix = 0; ix < h.nx; ix++) if (has(ix, iz)) out.push({ ix, iz, k });
  return { list: out, has };
}

/** Footprint corners of a house in its own frame (the whole grid, overhangs left out). */
export function houseFoot(h) {
  const W = h.nx * h.rw / 2, D = h.nz * h.rd / 2;
  return [[-W, -D], [W, -D], [W, D], [-W, D]];
}

function houseLayout(h) {
  const { WH } = HOUSE, R = houseRooms(h), mods = [], glue = [], at = new Map();
  const cx = (ix) => (ix - (h.nx - 1) / 2) * h.rw, cz = (iz) => (iz - (h.nz - 1) / 2) * h.rd;
  // the foundation: one slab under each ground-floor room
  mods.push({ p: [0, 0, 0], q: I, ground: true, shape: 'found', s: { cells: R.list.filter((r) => !r.k).map((r) => [cx(r.ix), cz(r.iz), h.rw, h.rd]), depth: h.depth } });
  for (const r of R.list) {
    const top = r.k === h.st - 1, nb = (dx, dz) => R.has(r.ix + dx, r.iz + dz);
    // a wall on each outside edge, and an inside wall (with a doorway) on the +x and +z edges where there is a neighbour
    const walls = {
      nx: nb(-1, 0) ? 0 : 'ext', px: nb(1, 0) ? 'int' : 'ext',
      nz: nb(0, -1) ? 0 : 'ext', pz: nb(0, 1) ? 'int' : (!r.k && r.iz === h.nz - 1 && r.ix === h.door ? 'door' : 'ext'),
    };
    const s = {
      w: h.rw, d: h.rd, walls,
      roof: top ? { mz: cz(r.iz), half: h.nz * h.rd / 2, top: WH, pitch: h.pitch, over: { nx: !nb(-1, 0), px: !nb(1, 0), nz: !nb(0, -1), pz: !nb(0, 1) } } : null,
    };
    at.set(`${r.ix},${r.iz},${r.k}`, mods.length);
    mods.push({ p: [cx(r.ix), r.k * (WH + 0.01), cz(r.iz)], q: I, ground: false, shape: 'room', s });
  }
  for (const r of R.list) {
    const i = at.get(`${r.ix},${r.iz},${r.k}`);
    for (const [dx, dz, dk] of [[1, 0, 0], [0, 1, 0], [0, 0, 1]]) { const j = at.get(`${r.ix + dx},${r.iz + dz},${r.k + dk}`); if (j !== undefined) glue.push([i, j]); }
    if (!r.k) glue.push([0, i]);
  }
  return { mods, glue };
}

/** The foundation's parts: a concrete slab under each ground-floor room, from the floor down `depth`. */
export function foundParts(s) {
  return s.cells.map(([x, z, w, d]) => ({ c: [x, -s.depth / 2, z], h: [w / 2, s.depth / 2, d / 2], q: I, mat: 'found' }));
}

/** One room's parts (module frame: origin on its floor's underside in its middle, +z the house's front). */
export function roomParts(s) {
  const { WH, T, FL, ROOF_T, OVER, DOOR, DOOR_H, WIN, SILL, WIN_TOP, PANEL, GABLE } = HOUSE, out = [], gap = 0.004;
  const { w, d, walls, roof } = s, W = w / 2, D = d / 2;
  const box = (x0, x1, y0, y1, z0, z1, mat, q = I) => { if (x1 - x0 > 0.01 && y1 - y0 > 0.01 && z1 - z0 > 0.01) out.push({ c: [(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2], h: [(x1 - x0) / 2, (y1 - y0) / 2, (z1 - z0) / 2], q, mat }); };
  // underside of the roof at module z (room-local): rises from the eaves to the ridge
  const roofY = (z) => roof.top + roof.pitch * (roof.half - Math.abs(z + roof.mz));
  // floor: two boards inside the walls this room owns
  const fx0 = -W + (walls.nx ? T : 0), fx1 = W - (walls.px ? T : 0), fz0 = -D + (walls.nz ? T : 0), fz1 = D - (walls.pz ? T : 0);
  for (let i = 0; i < 2; i++) { const a = fz0 + (fz1 - fz0) * i / 2, b = fz0 + (fz1 - fz0) * (i + 1) / 2; box(fx0, fx1, 0, FL, a + gap, b - gap, 'floor'); }

  // A wall along one edge: span [a0, a1] along it, `put(a0, a1, y0, y1, mat)` makes a box over that stretch.
  // Openings (door, window, doorway) are cut out; the solid wall is panels at most PANEL wide.
  const wall = (type, a0, a1, put, alongZ, zAt) => {
    const L = a1 - a0, mid = (a0 + a1) / 2, op = [];
    if (type === 'door') { op.push({ c: mid - L / 4, w: DOOR, y0: FL, y1: DOOR_H, mat: 'door' }); if (L > 3.2) op.push({ c: mid + L / 4, w: WIN, y0: SILL, y1: WIN_TOP, mat: 'glass' }); }
    else if (type === 'int') op.push({ c: mid, w: DOOR, y0: FL, y1: DOOR_H, mat: null });
    else if (L > 2.2) op.push({ c: mid, w: Math.min(WIN, L - 1.2), y0: SILL, y1: WIN_TOP, mat: 'glass' });
    const solid = (b0, b1, y0, y1, step) => { const n = Math.max(1, Math.ceil((b1 - b0) / step - 1e-6)); for (let i = 0; i < n; i++) put(b0 + (b1 - b0) * i / n + gap, b0 + (b1 - b0) * (i + 1) / n - gap, y0, y1, 'wall'); };
    let a = a0;
    for (const o of op) {
      const o0 = o.c - o.w / 2, o1 = o.c + o.w / 2;
      solid(a, o0, 0, WH, PANEL);
      if (o.y0 > FL) put(o0 + gap, o1 - gap, 0, o.y0 - gap, 'wall');
      if (o.mat) put(o0 + gap, o1 - gap, o.y0 + gap, o.y1 - gap, o.mat);
      put(o0 + gap, o1 - gap, o.y1, WH, 'wall');
      a = o1;
    }
    solid(a, a1, 0, WH, PANEL);
    // under the roof, an outside wall goes on up to it (a gable end, or an eaves wall that meets the roof high up)
    if (roof && type !== 'int') {
      const step = alongZ ? GABLE : PANEL, n = Math.max(1, Math.ceil(L / step - 1e-6));
      for (let i = 0; i < n; i++) {
        const b0 = a0 + L * i / n, b1 = a0 + L * (i + 1) / n, top = alongZ ? Math.min(roofY(b0), roofY(b1)) : roofY(zAt);
        if (top - WH > 0.05) put(b0 + gap, b1 - gap, WH + gap, top - gap, 'wall');
      }
    }
  };
  // walls along x (front pz, back nz) run the room's full width; walls along z fit between them
  if (walls.pz) wall(walls.pz, -W, W, (a, b, y0, y1, m) => box(a, b, y0, y1, D - T, D, m), false, D - T);
  if (walls.nz) wall(walls.nz, -W, W, (a, b, y0, y1, m) => box(a, b, y0, y1, -D, -D + T, m), false, -D + T);
  const z0 = -D + (walls.nz ? T + gap : 0), z1 = D - (walls.pz ? T + gap : 0);
  if (walls.px) wall(walls.px, z0, z1, (a, b, y0, y1, m) => box(W - T, W, y0, y1, a, b, m), true);
  if (walls.nx) wall(walls.nx, z0, z1, (a, b, y0, y1, m) => box(-W, -W + T, y0, y1, a, b, m), true);

  // roof: boards over this room, split at the ridge, overhanging where the house ends
  if (roof) {
    const o = roof.over, x0 = -W - (o.nx ? OVER : 0), x1 = W + (o.px ? OVER : 0);
    const za = -D - (o.nz ? OVER : 0), zb = D + (o.pz ? OVER : 0), zr = -roof.mz, th = Math.atan(roof.pitch);
    const spans = zr > za + 0.01 && zr < zb - 0.01 ? [[za, zr], [zr, zb]] : [[za, zb]];
    const nb = Math.max(1, Math.round((x1 - x0) / 2.2)), bw = (x1 - x0) / nb;
    for (const [p0, p1] of spans) {
      const up = (p0 + p1) / 2 < zr, q = rotX(up ? -th : th), n = qrot(q, [0, 1, 0]), zc = (p0 + p1) / 2, yc = roofY(zc), hl = (p1 - p0) / 2 / Math.cos(th);
      for (let i = 0; i < nb; i++) {
        const x = x0 + (i + 0.5) * bw;
        out.push({ c: [x + n[0] * ROOF_T / 2, yc + n[1] * ROOF_T / 2 + gap, zc + n[2] * ROOF_T / 2], h: [bw / 2 - gap, ROOF_T / 2, hl - gap], q, mat: 'roof' });
      }
    }
  }
  return out;
}

// ---- parked cars: four modules (body, cabin, bonnet, boot) ----
// Car frame: origin on the ground in the middle between the wheels, +y up, +z toward the nose. The body (floor,
// doors, seats and the four wheels) stands on the ground; the cabin (roof, pillars, glass), the bonnet (engine,
// wings, grille, bumper, lamps) and the boot are glued to it and to each other, so a branch on the roof smashes
// the cabin and leaves the rest parked. A wheel is a box to the physics; the view draws it round (mat 'tyre').
export const CAR = { L: 4.6, W: 1.84, WHEEL_R: 0.32, TYRE: 0.22, AXLE: 1.35, TRACK: 0.76, BELT: 0.92, ROOF: 1.42 };

function carParts(shape) {
  const { WHEEL_R: r, TYRE, AXLE, TRACK, BELT, ROOF } = CAR, out = [], g = 0.004, X = 0.91;
  const box = (x0, x1, y0, y1, z0, z1, mat, q = I) => out.push({ c: [(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2], h: [(x1 - x0) / 2, (y1 - y0) / 2, (z1 - z0) / 2], q, mat });
  // a thin panel from (ya, za) to (yb, zb) in the y-z plane, half width hx about x = cx, half thickness t
  const slant = (cx, hx, ya, za, yb, zb, t, mat) => {
    const dy = yb - ya, dz = zb - za, L = Math.hypot(dy, dz), a = Math.atan2(-dy, dz);
    out.push({ c: [cx, (ya + yb) / 2, (za + zb) / 2], h: [hx, t, L / 2 - 0.02], q: rotX(a), mat });
  };
  if (shape === 'carbody') {
    box(-0.86, 0.86, 0.24, 0.36, -1.0 + g, 1.0 - g, 'under');                   // floor pan, between the wheels
    for (const sx of [-1, 1]) {
      box(sx < 0 ? -X : 0.87, sx < 0 ? -0.87 : X, 0.28, BELT, -1.0 + g, 1.0 - g, 'paint');   // the doors
      for (const sz of [-1, 1]) box(sx * TRACK - TYRE / 2, sx * TRACK + TYRE / 2, 0, 2 * r, sz * AXLE - r, sz * AXLE + r, 'tyre');   // a wheel (drawn round)
    }
    // seats: two in front, a bench behind
    for (const sx of [-1, 1]) { box(sx * 0.4 - 0.25, sx * 0.4 + 0.25, 0.36 + g, 0.6, 0.22, 0.65, 'seat'); box(sx * 0.4 - 0.25, sx * 0.4 + 0.25, 0.36 + g, 1.15, 0.05, 0.2, 'seat'); }
    box(-0.7, 0.7, 0.36 + g, 0.6, -0.76, -0.3, 'seat'); box(-0.7, 0.7, 0.36 + g, 1.02, -0.9, -0.78, 'seat');
  } else if (shape === 'carhood' || shape === 'carboot') {
    const s = shape === 'carhood' ? 1 : -1, z = (a, b) => (s > 0 ? [a, b] : [-b, -a]);    // z ranges measured from the middle toward this end
    box(-0.55, 0.55, 0.36, 0.84, ...z(1.05, 2.1), s > 0 ? 'engine' : 'under');      // the engine, or the boot's floor and spare
    for (const sx of [-1, 1]) box(sx < 0 ? -X : 0.87, sx < 0 ? -0.87 : X, 0.36, BELT, ...z(1.0 + g, 2.15), 'paint');   // wings
    box(-X, X, BELT + g, BELT + 0.04, ...z(1.0 + g, 2.15), 'paint');                // bonnet or boot lid
    box(-X, X, 0.3, BELT, ...z(2.15 + g, 2.22), s > 0 ? 'grille' : 'paint');       // the front or back panel
    box(-0.93, 0.93, 0.24, 0.42, ...z(2.22 + g, 2.3), 'bumper');
    for (const sx of [-1, 1]) box(sx * 0.67 - 0.14, sx * 0.67 + 0.14, 0.66, 0.8, ...z(2.22 + g, 2.25), s > 0 ? 'lamp' : 'tail');
  } else {                                                                       // the cabin
    const zf = 0.45, zb = -0.75, yb = BELT + 0.04 + g;
    box(-0.8, 0.8, ROOF, ROOF + 0.05, zb, zf, 'paint');                          // roof
    slant(0, 0.78, yb, 1.0, ROOF - g, zf, 0.008, 'cglass');                      // windscreen
    slant(0, 0.78, yb, -1.0, ROOF - g, zb, 0.008, 'cglass');                     // back window
    for (const sx of [-1, 1]) {
      slant(sx * 0.83, 0.04, yb, 1.0, ROOF - g, zf, 0.03, 'paint');              // A pillar
      slant(sx * 0.83, 0.04, yb, -1.0, ROOF - g, zb, 0.03, 'paint');             // C pillar
      box(sx * 0.84 - 0.04, sx * 0.84 + 0.04, yb, ROOF - g, -0.17, -0.13, 'paint');   // B pillar
      box(sx * 0.84 - 0.01, sx * 0.84 + 0.01, yb + 0.02, ROOF - 0.03, -0.12, zf - 0.06, 'cglass');   // door glass, front
      box(sx * 0.84 - 0.01, sx * 0.84 + 0.01, yb + 0.02, ROOF - 0.03, zb + 0.06, -0.18, 'cglass');   // and back
    }
  }
  return out;
}

/** The parts of one module, from its shape. */
export function modParts(m) {
  if (m.shape === 'shed') return shedParts();
  if (m.shape === 'room') return roomParts(m.s);
  if (m.shape === 'found') return foundParts(m.s);
  if (m.shape.startsWith('car')) return carParts(m.shape);
  return fenceParts(m.shape, m.end, m.s?.span, m.s?.start ?? true);
}

/**
 * Kinds of build: module poses (build frame), shapes and glue. 'shed'; 'stack' (two sheds glued one on the
 * other, not placed by default); 'fence:<style>' with n sections in a row, each glued to the next
 * (b.span: their length, else the style's; b.start / b.end false: no post at that end of the run); 'house' from b.h;
 * 'car' (a parked car, four modules).
 */
function layout(b) {
  const S = SHED, kind = b.kind, n = b.n || 4;
  if (kind === 'house') return houseLayout(b.h);
  if (kind === 'car') {
    const mod = (shape, ground) => ({ p: [0, 0, 0], q: I, ground, shape });
    return { mods: [mod('carbody', true), mod('carcabin', false), mod('carhood', false), mod('carboot', false)], glue: [[0, 1], [0, 2], [0, 3], [1, 2], [1, 3]] };
  }
  if (kind.startsWith('fence:')) {
    const style = kind.slice(6), span = b.span || FENCE[style].SPAN, mods = [], glue = [];
    for (let i = 0; i < n; i++) {
      const s = b.span ? { span, start: i > 0 || b.start !== false } : undefined;
      mods.push({ p: [i * span, 0, 0], q: I, ground: true, shape: style, end: i === n - 1 && b.end !== false, s });
      if (i) glue.push([i - 1, i]);
    }
    return { mods, glue };
  }
  if (kind === 'stack') return { mods: [{ p: [0, 0, 0], q: I, ground: true, shape: 'shed' }, { p: [0, S.HF + S.ROOF_T + 0.01, 0], q: I, ground: false, shape: 'shed' }], glue: [[0, 1]] };
  return { mods: [{ p: [0, 0, 0], q: I, ground: true, shape: 'shed' }], glue: [] };
}

/** A build, fresh and intact, from {id, kind, p, q, n, ys, h}. ys: each module's height above p (a fence stepping down a slope). */
export function newBuild(b) {
  const L = layout(b);
  if (b.ys) L.mods.forEach((m, i) => { if (b.ys[i]) m.p = [m.p[0], m.p[1] + b.ys[i], m.p[2]]; });
  return {
    id: b.id, kind: b.kind, p: b.p, q: b.q, glue: L.glue, bodies: {},
    mods: L.mods.map((m) => ({ p: m.p, q: m.q, ground: m.ground, shape: m.shape, end: !!m.end, s: m.s, parts: modParts(m), body: b.id, ids: null, at: null })),
  };
}

/** Builds for a welcome message: the parts are left out (every machine makes them again from the shape). */
export function packBuilds(list) { return list.map((b) => ({ ...b, mods: b.mods.map(({ parts, ...m }) => m) })); }
export function unpackBuilds(list) { return (list || []).map((b) => ({ ...b, mods: b.mods.map((m) => ({ ...m, parts: m.parts || modParts(m) })) })); }

/**
 * The boxes an intact module collides as: its parts, with neighbours that line up merged into one box (wall
 * panels into a wall, pickets into a fence panel, a window's sill, glass and lintel into a column), so a
 * neighbourhood of thousands of boards is a few hundred colliders while it stands. Two boxes turned alike are
 * merged when the box round both is no bigger than the two together (to MERGE_SLACK): they touch along a whole
 * face. Each proxy is {c, h, q, v (volume of the parts in it)}. The parts themselves come back when it breaks.
 */
const MERGE_SLACK = 0.03;
export function modProxies(m) {
  const groups = new Map();
  for (const pt of m.parts) {
    const k = pt.q.map((x) => Math.round(x * 1e4)).join(',');
    let g = groups.get(k); if (!g) groups.set(k, g = { q: pt.q, boxes: [] });
    const c = qrot([-pt.q[0], -pt.q[1], -pt.q[2], pt.q[3]], pt.c);     // centre in the parts' own (shared) frame
    g.boxes.push({ lo: [c[0] - pt.h[0], c[1] - pt.h[1], c[2] - pt.h[2]], hi: [c[0] + pt.h[0], c[1] + pt.h[1], c[2] + pt.h[2]], v: 8 * pt.h[0] * pt.h[1] * pt.h[2] });
  }
  const vol = (lo, hi) => (hi[0] - lo[0]) * (hi[1] - lo[1]) * (hi[2] - lo[2]);
  const out = [];
  for (const g of groups.values()) {
    const B = g.boxes;
    for (let merged = true; merged; ) {
      merged = false;
      for (let i = 0; i < B.length && !merged; i++) for (let j = i + 1; j < B.length; j++) {
        const a = B[i], b = B[j], lo = a.lo.map((x, k) => Math.min(x, b.lo[k])), hi = a.hi.map((x, k) => Math.max(x, b.hi[k]));
        if (vol(lo, hi) > (vol(a.lo, a.hi) + vol(b.lo, b.hi)) * (1 + MERGE_SLACK)) continue;
        B[i] = { lo, hi, v: a.v + b.v }; B.splice(j, 1); merged = true; break;
      }
    }
    for (const b of B) {
      const c = qrot(g.q, [(b.lo[0] + b.hi[0]) / 2, (b.lo[1] + b.hi[1]) / 2, (b.lo[2] + b.hi[2]) / 2]);
      out.push({ c, h: [(b.hi[0] - b.lo[0]) / 2, (b.hi[1] - b.lo[1]) / 2, (b.hi[2] - b.lo[2]) / 2], q: g.q, v: b.v });
    }
  }
  return out;
}

/** Contact force (N) that breaks an intact module of this shape. */
export function breakForce(m, CFG) {
  if (m.shape === 'found') return Infinity;
  if (m.shape === 'room') return CFG.HOUSE_BREAK_F;
  if (m.shape.startsWith('car')) return CFG.CAR_BREAK_F;
  return m.shape === 'shed' ? CFG.SHED_BREAK_F : CFG.FENCE_BREAK_F;
}

/** Density (kg/m3) of a build's loose parts. */
export function buildDensity(b, CFG) { return b.kind === 'car' ? CFG.CAR_DENSITY : CFG.SHED_DENSITY; }

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
 * A 'freeze' event (sim/builds.js): loose bodies of build ev.b (parts of broken modules, or loose groups of
 * intact ones) that have lain still for CFG.DEBRIS_FREEZE are scenery from now on, at the pose they came to
 * rest in: ev.list = [{id, p, q}]. b.still[id] = {p, q}; nothing collides with them any more.
 */
export function freezeBuild(builds, ev) {
  const b = builds.find((x) => x.id === ev.b); if (!b) return;
  if (!b.still) b.still = {};
  for (const r of ev.list) {
    b.still[r.id] = { p: r.p, q: r.q };
    if (b.bodies[r.id]) b.bodies[r.id] = { p: r.p, q: r.q };
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
