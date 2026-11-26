// Host handover (D104): a player whose host has gone builds the simulation again from its own copy of the
// world, the last transforms it saw and the last aux packet, and carries on as the host.
//
// What comes back: the ground, the job tree and every loose piece where it was (at rest), the wood still
// hanging by fibres (its fibres as the last aux showed them), the chippers, bins and intact structures,
// the other yard trees, the power lines (as last seen), players (climbers on the wood they were on), rope length and wraps, the clock.
// Stickers handed out so far are in the world (world.awards), so none is handed out twice.
// What does not: speeds (everything starts still), the state of a chipper mid-feed, debris of broken
// structures (drawn, no longer solid), someone holding the rope or wood (they let go).
// Runs in the main thread or a worker: no DOM.

import { CFG, MODE } from '../config.js';
import { PLAYER_BODY_ID } from './sim.js';
import { CHIPPER_BODY_ID } from '../model/chipper.js';

/**
 * st = { poses: Map(id -> {p:{x,y,z}, q:{x,y,z,w}}), aux } from the client that takes over.
 * Players in the world are all put back; the caller removes the ones that never come back.
 */
export function resume(sim, st) {
  const w = sim.world, aux = st.aux || null, on = (ev, info = {}) => sim.onEvent(ev, info);
  w.nextId = maxId(w) + 1;

  // fixed things first, in the order grow() makes them
  if (w.chipper) {
    w.chipper.units.forEach((u, k) => {
      if (!u) return;
      on({ t: 'chipper', add: k > 0 ? 1 : 0, k, p: u.p, q: u.q });
      if (u.wreck) on({ t: 'chipwreck', k, at: u.wreck.at, ids: u.wreck.ids });
    });
    (w.chipper.piles || []).forEach((pl, i) => sim.chipper.pileCollider(i, pl));
  }
  if (w.bins && w.bins.length) on({ t: 'bins', list: w.bins.map((b) => [b.p, b.q]) });
  if (w.builds && w.builds.length) on({ t: 'builds' });
  if (w.stands) on({ t: 'stands' });
  if (w.lines) { on({ t: 'lines' }); sim.lines.restore(st.lines && st.lines.m); }   // the power lines where this player last saw them

  // wood: rooted pieces as the tree was made, loose ones as bodies of their own
  const R = sim.R;
  for (const piece of w.pieces.values()) {
    if (piece.fixed) {
      const stand = w.stands ? w.stands.list.findIndex((x) => x.piece === piece.id) : -1;
      on({ t: 'tree', piece: piece.id, ...(stand >= 0 ? { stand } : {}) });
      continue;
    }
    const body = sim.rapier.createRigidBody(sim.dynamic().setLinearDamping(0.05).setAngularDamping(0.2));
    sim.bodies.set(piece.id, body); sim.born.set(piece.id, sim.tick);
    for (const s of w.segsOf(piece.id)) sim.addCollider(s, body);
  }

  // transforms: everything that moves goes where this player last saw it, still
  for (const [id, ps] of st.poses) {
    if (id >= PLAYER_BODY_ID) continue;
    const b = bodyOf(sim, id); if (!b || b.isFixed()) continue;
    b.setTranslation(ps.p, true); b.setRotation(ps.q, true);
    b.setLinvel({ x: 0, y: 0, z: 0 }, true); b.setAngvel({ x: 0, y: 0, z: 0 }, true);
  }

  // wood still hanging by its fibres
  if (aux && Array.isArray(aux.live)) {
    for (const l of aux.live) {
      const r = w.segs.get(l.seg); if (!r) continue;
      const piece = w.pieces.get(r.piece); if (!piece || piece.fixed) continue;
      sim.structure.restoreJoint(r.piece, l.seg, l.stub, l.f);
    }
  }

  // players: everyone in the world, where they were; climbers back on their spurs
  const pl = new Map(); if (aux) for (const a of aux.pl) pl.set(a.id, a);
  for (const m of w.players.values()) {
    sim.players.add(m.id, m.name, m.color, m.st);
    const p = sim.players.list.get(m.id), a = pl.get(m.id), ps = st.poses.get(PLAYER_BODY_ID + m.id);
    if (ps) { p.body.setTranslation(ps.p, true); p.body.setLinvel({ x: 0, y: 0, z: 0 }, true); }
    if (a && a.m === MODE.CLIMB && Array.isArray(a.cl) && w.segs.has(a.cl[0])) {
      sim.players.toClimb(p, a.cl[0], a.cl[1], a.cl[2].slice());
      p.cl.end = a.cl[3] || 0; p.cl.armed = !!a.cl[4];
    }
    if (a) { p.inj = a.inj || 0; }
  }

  // rope and clock
  if (aux && aux.rope) { sim.rope.L0 = aux.rope.L0 || 0; sim.rope.wraps = aux.rope.wraps ?? sim.rope.wraps; sim.rope.holder = -1; }
  if (aux && Array.isArray(aux.sky)) { sim.days = aux.sky[0]; sim.cloud = sim.cloudTo = aux.sky[2]; sim.cloudNext = sim.days; }
  if (aux && Number.isFinite(aux.tick)) sim.tick = aux.tick;
  sim.outbox = [];                      // nothing above is news to anyone: every machine already has this world
  return sim;
}

function bodyOf(sim, id) {
  if (id >= CHIPPER_BODY_ID && id < CHIPPER_BODY_ID + 1000) return sim.chipper.bodyOf(id);
  return sim.bodies.get(id) || sim.builds.body(id) || sim.chipper.partBody(id) || sim.bins.body(id) || null;
}

/** The largest id the old host handed out that this world still mentions (the next one must be new). */
function maxId(w) {
  let m = 0;
  const KEYS = new Set(['id', 'ids', 'piece', 'parts', 'body', 'seg', 'parent', 'newSeg', 'newPiece']);
  const walk = (o, key, d) => {
    if (d > 8 || o == null) return;
    if (typeof o === 'number') { if (KEYS.has(key) && Number.isInteger(o) && o < 50000) m = Math.max(m, o); return; }
    if (ArrayBuffer.isView(o)) return;
    if (Array.isArray(o)) { for (const x of o) walk(x, key, d + 1); return; }
    if (typeof o === 'object') for (const k of Object.keys(o)) { const n = +k; if (Number.isInteger(n) && n < 50000 && (key === 'bodies' || key === 'still')) m = Math.max(m, n); walk(o[k], k, d + 1); }
  };
  for (const s of w.segs.values()) m = Math.max(m, s.id);
  for (const p of w.pieces.values()) m = Math.max(m, p.id);
  walk({ builds: w.builds, chipper: w.chipper, stands: w.stands, rope: w.rope }, '', 0);
  return m;
}
