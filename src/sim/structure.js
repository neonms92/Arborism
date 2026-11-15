// Structure: what each piece of wood is carrying and whether it holds.
// Beam analysis over rooted pieces, section analysis (tear / hinge / free),
// hinge joints. Host only. See docs/DESIGN.md 3.2, 3.3.
//
// Rooted (fixed) pieces are created at the origin with identity rotation, so
// for them piece-local coordinates ARE world coordinates. This file relies on
// that for the beam pass.

import * as THREE from 'three';
import { CFG } from '../config.js';
import { segLen, segAxis, segMass, segCentroidT, segParam, lerp3 } from '../model/world.js';
import { analyse, hingeShape, isHingeLike, closeAngles, sectionBasis, NCELL, INTACT } from '../model/section.js';

const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const G = CFG.GRAVITY;

export class Structure {
  constructor(sim) {
    this.sim = sim;
    this.beam = new Map();     // seg id -> {F:[3], M:[3]}  (distal force, moment about origin)
    this.util = new Map();     // seg id -> utilisation at its base
    this.hinges = new Map();   // piece id -> hinge record
    this.watched = new Set();  // section ids some player is sawing (stress sent to clients)
  }

  onRemove(piece) {
    const h = this.hinges.get(piece);
    if (h) { this.hinges.delete(piece); }
    for (const [id, hh] of [...this.hinges]) if (hh.parent === piece) this.hinges.delete(id);
  }

  step(dt) {
    const w = this.sim.world;
    this.util.clear();
    for (const piece of w.pieces.values()) if (piece.fixed) this.beamPass(piece);
    for (const sec of [...w.sections.values()]) if (sec.sep < 0) this.sectionStep(sec);
    for (const [id, h] of [...this.hinges]) this.hingeStep(id, h);
  }

  // ---- beam analysis ----
  beamPass(piece) {
    const w = this.sim.world, order = w.segsOf(piece.id), beam = this.beam;
    for (const s of order) {
      let b = beam.get(s.id); if (!b) beam.set(s.id, b = { F: [0, 0, 0], M: [0, 0, 0] });
      b.F[0] = b.F[1] = b.F[2] = b.M[0] = b.M[1] = b.M[2] = 0;
    }
    for (const l of this.sim.loads) {
      const b = beam.get(l.seg); if (!b) continue;
      const m = cross(l.p, l.f);
      b.F[0] += l.f[0]; b.F[1] += l.f[1]; b.F[2] += l.f[2];
      b.M[0] += m[0]; b.M[1] += m[1]; b.M[2] += m[2];
    }
    for (let i = order.length - 1; i >= 0; i--) {
      const s = order[i], b = beam.get(s.id);
      addWeight(b, lerp3(s.a, s.b, segCentroidT(s)), segMass(s));
      if (s.leaf) addWeight(b, s.b, s.leaf);
      // utilisation at the base joint
      const ax = segAxis(s), pxF = cross(s.a, b.F);
      const M = [b.M[0] - pxF[0], b.M[1] - pxF[1], b.M[2] - pxF[2]];
      const N = dot(b.F, ax), T = dot(M, ax);
      const Mb = Math.hypot(M[0] - T * ax[0], M[1] - T * ax[1], M[2] - T * ax[2]);
      const r = s.r0, r3 = Math.PI * r * r * r;
      const u = (4 * Mb / r3 + Math.max(0, N) / (Math.PI * r * r)) / CFG.MOR + Math.pow(2 * Math.abs(T) / r3 / CFG.SHEAR, 2);
      this.util.set(s.id, u);
      if (s.parent >= 0) {
        const pb = beam.get(s.parent);
        pb.F[0] += b.F[0]; pb.F[1] += b.F[1]; pb.F[2] += b.F[2];
        pb.M[0] += b.M[0]; pb.M[1] += b.M[1]; pb.M[2] += b.M[2];
        if (u > CFG.OVERLOAD_WATCH && !this.hasBaseSection(s.id))
          this.sim.emit({ t: 'section', id: w.newId(), seg: s.id, at: 0 });
      }
    }
  }

  hasBaseSection(segId) {
    for (const sec of this.sim.world.sections.values()) if (sec.seg === segId && sec.at < 0.02 && sec.sep < 0) return true;
    return false;
  }

  // ---- one section ----
  sectionStep(sec) {
    const sim = this.sim, w = sim.world, s = w.segs.get(sec.seg);
    if (!s) { w.sections.delete(sec.id); return; }
    if (sec.intact === 0) { this.separate(sec, null); return; }
    const fixed = w.pieces.get(s.piece).fixed;
    let N = 0, Mu = 0, Mv = 0;
    if (fixed) {
      // distal load at the section: children + rest of this segment + point loads beyond it
      const F = [0, 0, 0], M = [0, 0, 0], acc = { F, M };
      for (const k of w.kids(s.id)) {
        const b = this.beam.get(k); if (!b) continue;
        F[0] += b.F[0]; F[1] += b.F[1]; F[2] += b.F[2]; M[0] += b.M[0]; M[1] += b.M[1]; M[2] += b.M[2];
      }
      addWeight(acc, lerp3(s.a, s.b, segCentroidT(s, sec.at, 1)), segMass(s, sec.at, 1));
      if (s.leaf) addWeight(acc, s.b, s.leaf);
      for (const l of sim.loads) {
        if (l.seg !== s.id || segParam(s, l.p) < sec.at) continue;
        const m = cross(l.p, l.f);
        F[0] += l.f[0]; F[1] += l.f[1]; F[2] += l.f[2]; M[0] += m[0]; M[1] += m[1]; M[2] += m[2];
      }
      const ax = segAxis(s), { u, v } = sectionBasis(ax), C = lerp3(s.a, s.b, sec.at), cxF = cross(C, F);
      const Mc = [M[0] - cxF[0], M[1] - cxF[1], M[2] - cxF[2]];
      N = dot(F, ax); Mu = dot(Mc, u); Mv = dot(Mc, v);
    } else if (sec.intact === NCELL) return;
    sec.load = [N, Mu, Mv];
    if (!analyse(sec, N, Mu, Mv)) { this.separate(sec, null); return; }
    if (sec.maxT <= CFG.MOR) return;

    // gross overload on wood that has not started to fail: a clean snap (shock load)
    if (sec.maxT > CFG.SNAP_FACTOR * CFG.MOR && !sec.cracked) {
      sim.emit({ t: 'tear', sec: sec.id, all: 1 });
      sim.toast('SNAP!');
      this.separate(sec, null);
      return;
    }
    const h = hingeShape(sec);
    if (isHingeLike(h, sec.R)) { this.separate(sec, h); return; }
    const over = [];
    for (let c = 0; c < NCELL; c++) if (sec.state[c] === INTACT && sec.stress[c] + sec.edge > CFG.MOR) over.push(c);
    over.sort((a, b) => sec.stress[b] - sec.stress[a]);
    over.length = Math.min(over.length, Math.max(1, Math.ceil(CFG.TEAR_FRACTION * NCELL)));
    sim.emit({ t: 'tear', sec: sec.id, cells: over });
    if (!sec.cracked) { sec.cracked = true; sim.toast('crack...'); }
  }

  /** The wood at this section parts: free (h = null) or on a hinge (h = hingeShape). */
  separate(sec, h) {
    const sim = this.sim, w = sim.world, s = w.segs.get(sec.seg);
    let at = sec.at;
    if (at < 0.02) at = s.parent >= 0 ? 0 : 0.02;
    if (at > 0.98) at = 0.98;
    const ax = segAxis(s), { u, v } = sectionBasis(ax), C = lerp3(s.a, s.b, sec.at);
    const parent = s.piece, newPiece = w.newId(), newSeg = at > 0 ? w.newId() : s.id;
    sim.emit({ t: 'split', seg: s.id, at, newSeg, newPiece, sec: sec.id });
    if (!h) return;

    const R = sim.R;
    const anchor = { x: C[0] + h.cx * u[0] + h.cy * v[0], y: C[1] + h.cx * u[1] + h.cy * v[1], z: C[2] + h.cx * u[2] + h.cy * v[2] };
    const axis = [h.hx * u[0] + h.hy * v[0], h.hx * u[1] + h.hy * v[1], h.hx * u[2] + h.hy * v[2]];
    const joint = sim.rapier.createImpulseJoint(
      R.JointData.revolute(anchor, anchor, { x: axis[0], y: axis[1], z: axis[2] }),
      sim.bodies.get(parent), sim.bodies.get(newPiece), true);
    joint.setContactsEnabled(false);
    const plastic = CFG.MOR * h.L * h.w * h.w / 4;
    // Bending fibres resist with a roughly constant moment (a plastic hinge): a
    // velocity-0 motor with a torque cap.
    // It is capped at a fraction of the moment that was driving the hinge when it
    // formed, so a hinge always commits instead of stalling.
    const [N, Mu, Mv] = sec.load || [0, 0, 0];
    const drive = Math.abs((Mu - h.cy * N) * h.hx + (Mv + h.cx * N) * h.hy);
    joint.configureMotorModel(R.MotorModel.ForceBased);
    joint.configureMotorVelocity(0, plastic * 50);
    joint.setMotorMaxForce(Math.min(plastic * 0.6, drive > 1 ? drive * CFG.HINGE_RESIST : plastic * 0.3));
    const ca = closeAngles(sec, h);
    const fibre = Math.min(CFG.FIBRE_MAX, Math.max(CFG.FIBRE_MIN, CFG.FIBRE_K / (h.w / (2 * sec.R))));
    this.hinges.set(newPiece, {
      joint, parent, anchor: [anchor.x, anchor.y, anchor.z], axis, stem: ax,
      plus: Math.min(ca.plus, fibre), minus: Math.min(ca.minus, fibre),
      L: h.L, w: h.w, angle: 0,
    });
    sim.toast('hinging');
  }

  // ---- hinged pieces ----
  hingeStep(id, h) {
    const sim = this.sim, pb = sim.bodies.get(h.parent), b = sim.bodies.get(id);
    if (!pb || !b) { this.hinges.delete(id); return; }
    const qp = pb.rotation(), qb = b.rotation();
    _qa.set(qp.x, qp.y, qp.z, qp.w).invert().multiply(_qb.set(qb.x, qb.y, qb.z, qb.w));
    let th = 2 * Math.atan2(_qa.x * h.axis[0] + _qa.y * h.axis[1] + _qa.z * h.axis[2], _qa.w);
    if (th > Math.PI) th -= 2 * Math.PI; else if (th < -Math.PI) th += 2 * Math.PI;
    h.angle = th;
    let why = null;
    if (th > h.plus || th < -h.minus) why = 'hinge broke';
    else {
      // side load on the strip (quasi-static: gravity + rope)
      const aw = sim.toWorld(h.parent, h.anchor, _a), com = b.worldCom(), m = b.mass();
      const r = [com.x - aw.x, com.y - aw.y, com.z - aw.z];
      const M = cross(r, [0, -m * G, 0]);
      const rf = sim.rope.lastForce;
      if (rf && rf.piece === id) {
        const mr = cross([rf.p.x - aw.x, rf.p.y - aw.y, rf.p.z - aw.z], [rf.f.x, rf.f.y, rf.f.z]);
        M[0] += mr[0]; M[1] += mr[1]; M[2] += mr[2];
      }
      const hw = sim.dirToWorld(h.parent, h.axis, _b), sw = sim.dirToWorld(h.parent, h.stem, _c);
      const hv = [hw.x, hw.y, hw.z], sv = [sw.x, sw.y, sw.z], nv = cross(hv, sv);
      if (Math.abs(dot(M, nv)) > CFG.MOR * h.w * h.L * h.L / 6) why = 'hinge tore sideways';
      else if (Math.abs(dot(M, sv)) > CFG.SHEAR * h.w * h.L * h.L / 4) why = 'hinge twisted off';
    }
    if (why) {
      sim.rapier.removeImpulseJoint(h.joint, true);
      this.hinges.delete(id);
      sim.toast(why);
    }
  }

  /** Stress fields of sections being sawn, for the clients' cross-section HUD. */
  watchAux() {
    const out = {};
    for (const id of this.watched) {
      const sec = this.sim.world.sections.get(id); if (!sec) continue;
      const a = new Array(NCELL);
      for (let c = 0; c < NCELL; c++) a[c] = Math.max(-127, Math.min(127, Math.round(sec.stress[c] / CFG.MOR * 100)));
      out[id] = a;
    }
    this.watched.clear();
    return out;
  }
}

function addWeight(b, p, m) {
  const f = -m * G;                       // force (0, f, 0) at p; moment = p x f
  b.F[1] += f; b.M[0] += -p[2] * f; b.M[2] += p[0] * f;
}

const _qa = new THREE.Quaternion(), _qb = new THREE.Quaternion();
const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3();
