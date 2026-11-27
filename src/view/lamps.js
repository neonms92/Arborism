// Draws the lights of the neighbourhood at night: a streetlight on every utility pole (hardware LAMP in
// world.lines.hw), a porch light by every house's front door, and the windows of every house. Each comes on at its
// own point of dusk (a hash of what it is, so the street does not all switch at once) and goes off at dawn, and
// only while the grid feeds it (model/lines.js powerState: a snapped span darkens everything past it, a drop torn
// off darkens its house). No game rules: the power state is worked out from the model on every machine.
//
// Cheap on purpose, there are hundreds of lights: lit lenses and bulbs are flat colour (instanced), each has a
// glow (one Points cloud per kind) and a pool of light on the ground under it (an instanced additive disc). Only
// the few lit lamps nearest the camera get a real light (a SpotLight shining down) (CFG.LAMP_LIGHTS, fewer on a phone), which lights
// wood, players and walls too; its ground pool fades out while the light fades in, so nothing jumps.

import * as THREE from 'three';
import { CFG } from '../config.js';
import { HW, powerState, houseFed, nodeFed } from '../model/lines.js';
import { POLE } from '../model/stands.js';
import { HOUSE, compose } from '../model/builds.js';
import { groundY } from '../model/terrain.js';
import { touchFirst } from '../touch.js';

const WARM = new THREE.Color(1, 0.78, 0.48), STREET = new THREE.Color(1, 0.72, 0.38), OFF = new THREE.Color(0.22, 0.22, 0.2);
const ZERO = new THREE.Matrix4().makeScale(0, 0, 0), Y = new THREE.Vector3(0, 1, 0);
const _m = new THREE.Matrix4(), _P = new THREE.Vector3(), _Q = new THREE.Quaternion(), _o = new THREE.Vector3(), _s = new THREE.Vector3();
const _q = new THREE.Quaternion(), _n = new THREE.Vector3(), _c = new THREE.Color();
const ARM = Math.hypot(POLE.LAMP_OUT, POLE.LAMP_RISE), ARM_TILT = Math.atan2(POLE.LAMP_OUT, POLE.LAMP_RISE);
const hash = (a, b) => (Math.imul(a * 7919 + b + 1, 2654435761) >>> 0) / 4294967296;

export class LampsView {
  constructor(scene, world, view) {
    this.scene = scene; this.world = world; this.view = view;
    this.src = [];               // every light: {k: 'street' | 'porch', h (hardware) or b (build id), at: lens, pool: centre, n: pool normal, r, th, fed, on}
    this.dirty = true;           // the power state needs working out again
    this.ps = null;
    const lam = (c) => new THREE.MeshLambertMaterial({ color: c });
    const glowTex = glowTexture(), poolTex = poolTexture();
    this.geo = {
      arm: new THREE.CylinderGeometry(0.03, 0.04, 1, 6), head: new THREE.BoxGeometry(0.3, 0.13, 0.62),
      lens: new THREE.BoxGeometry(0.2, 0.03, 0.42), fix: new THREE.BoxGeometry(0.14, 0.24, 0.1), bulb: new THREE.BoxGeometry(0.1, 0.13, 0.06),
      pool: new THREE.CircleGeometry(1, 20).rotateX(-Math.PI / 2),
    };
    this.mats = {
      arm: lam(0x6d7275), head: lam(0x9aa0a2), fix: lam(0x2a2826),
      lens: new THREE.MeshBasicMaterial({ color: 0xffffff }), bulb: new THREE.MeshBasicMaterial({ color: 0xffffff }),
      pool: new THREE.MeshBasicMaterial({ map: poolTex, color: 0xffffff, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4, fog: false }),
      glass: new THREE.MeshBasicMaterial({ vertexColors: true }),     // a lit window: its own colour (view/builds.js windowShade)
    };
    this.glowMat = (size) => new THREE.PointsMaterial({ map: glowTex, size, sizeAttenuation: true, vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false });
    this.meshes = null;          // made for the lights there are (rebuild)
    this.lights = [];            // real PointLights: {L, s: the light it is on, w: how far it has faded in}
    this.pickT = 0;
  }

  onEvent(ev) {
    this.dirty = true;           // any event can change what is fed (snap, smash, a pole waking): working it out is cheap
    if (ev.t === 'lines' || ev.t === 'builds' || ev.t === 'load' || ev.t === 'reset' || ev.t === 'smash' || ev.t === 'freeze') this.rebuildWanted = true;
  }

  rebuild() {
    this.rebuildWanted = false;
    if (this.meshes) for (const o of Object.values(this.meshes)) { this.scene.remove(o); if (o.dispose) o.dispose(); else o.geometry.dispose(); }
    this.meshes = null;
    const w = this.world, src = [];
    for (const h of (w.lines && w.lines.hw) || []) if (h.k === HW.LAMP) src.push({ k: 'street', h, r: CFG.STREETLIGHT_POOL, th: 0.12 + 0.3 * hash(h.g || 0, 1), at: new THREE.Vector3(), pool: new THREE.Vector3(), n: new THREE.Vector3(0, 1, 0), ok: true, on: 0 });
    for (const b of w.builds || []) {
      if (b.kind !== 'house') continue;
      const door = porchOf(b); if (!door) continue;
      const at = new THREE.Vector3(...door.at), pool = new THREE.Vector3(door.pool[0], groundY(w.terrain, door.pool[0], door.pool[2]) + 0.04, door.pool[2]);
      src.push({ k: 'porch', b: b.id, r: CFG.PORCH_POOL, th: 0.05 + 0.5 * hash(b.id, 2), at, pool, n: new THREE.Vector3(0, 1, 0), q: door.q, fix: door.fix, ok: true, on: 0 });
    }
    this.src = src;
    for (const R of this.lights) { R.s = R.next = null; R.w = 0; }
    const nS = src.filter((s) => s.k === 'street').length, nP = src.length - nS;
    const inst = (g, m, n) => { const im = new THREE.InstancedMesh(g, m, Math.max(1, n)); im.count = n; im.frustumCulled = false; this.scene.add(im); return im; };
    const pts = (n, size) => {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(Math.max(1, n) * 3), 3));
      g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(Math.max(1, n) * 3), 3));
      g.setDrawRange(0, n);
      const p = new THREE.Points(g, this.glowMat(size)); p.frustumCulled = false; p.renderOrder = 3; this.scene.add(p); return p;
    };
    const M = this.meshes = {
      arm: inst(this.geo.arm, this.mats.arm, nS), head: inst(this.geo.head, this.mats.head, nS), lens: inst(this.geo.lens, this.mats.lens, nS),
      fix: inst(this.geo.fix, this.mats.fix, nP), bulb: inst(this.geo.bulb, this.mats.bulb, nP),
      pool: inst(this.geo.pool, this.mats.pool, src.length),
      gS: pts(nS, 2.2), gP: pts(nP, 0.9),
    };
    for (const k of ['arm', 'head', 'fix']) { M[k].castShadow = true; M[k].receiveShadow = true; }
    M.pool.renderOrder = 1;
    for (let i = 0; i < src.length; i++) M.pool.setColorAt(i, _c.setRGB(0, 0, 0));
    for (let i = 0; i < nS; i++) M.lens.setColorAt(i, OFF);
    for (let i = 0; i < nP; i++) M.bulb.setColorAt(i, OFF);
    // porches never move (a porch whose room breaks or shifts goes out, rebuild drops it): place them once
    let p = 0;
    for (const s of src) {
      if (s.k !== 'porch') continue;
      _Q.set(...s.q);
      M.fix.setMatrixAt(p, _m.compose(_o.set(...s.fix), _Q, _s.set(1, 1, 1)));
      M.bulb.setMatrixAt(p, _m.compose(s.at, _Q, _s.set(1, 1, 1)));
      p++;
    }
    this.poseStreet(true);
    this.dirty = true;
  }

  /** Streetlights where their poles are (a dormant pole's only once; a woken one's every frame). */
  poseStreet(all) {
    const M = this.meshes, lv = this.view.linesView; let i = 0, moved = false;
    for (const s of this.src) {
      if (s.k !== 'street') continue;
      const j = i++;
      if (!all && s.h.e.seg === undefined) continue;
      moved = true;
      s.ok = lv.endPose(s.h.e, _P, _Q);
      if (!s.ok) { M.arm.setMatrixAt(j, ZERO); M.head.setMatrixAt(j, ZERO); M.lens.setMatrixAt(j, ZERO); continue; }
      const put = (im, x, y, z, q, sy = 1) => { _o.set(x, y, z).applyQuaternion(_Q).add(_P); im.setMatrixAt(j, _m.compose(_o, q, _s.set(1, sy, 1))); };
      _q.setFromAxisAngle(_n.set(1, 0, 0), ARM_TILT).premultiply(_Q);
      put(M.arm, 0, POLE.LAMP_RISE / 2, POLE.LAMP_OUT / 2, _q, ARM);
      put(M.head, 0, POLE.LAMP_RISE + 0.03, POLE.LAMP_OUT + 0.22, _Q);
      put(M.lens, 0, POLE.LAMP_RISE - 0.045, POLE.LAMP_OUT + 0.26, _Q);
      s.at.set(0, POLE.LAMP_RISE - 0.08, POLE.LAMP_OUT + 0.26).applyQuaternion(_Q).add(_P);
      // its pool: on the ground straight under it, tilted to the ground there
      const t = this.world.terrain, x = s.at.x, z = s.at.z, e = 1.5;
      s.pool.set(x, groundY(t, x, z) + 0.05, z);
      s.n.set(groundY(t, x - e, z) - groundY(t, x + e, z), 2 * e, groundY(t, x, z - e) - groundY(t, x, z + e)).normalize();
    }
    if (moved) for (const k of ['arm', 'head', 'lens']) M[k].instanceMatrix.needsUpdate = true;
    return moved;
  }

  update(dt, camera) {
    if (this.rebuildWanted || !this.meshes) this.rebuild();
    const M = this.meshes, src = this.src, w = this.world, sky = this.view.sky;
    if (this.dirty) { this.dirty = false; this.ps = powerState(w.lines); }
    const ps = this.ps, dark = sky ? sky.dark : 0, on = CFG.LAMPS;
    const moved = this.poseStreet(false);
    // windows: a fed house lights up at its own point of dusk
    for (const [id, mesh] of this.view.buildsView.glass) {
      const lit = on && dark > 0.05 + 0.55 * hash(id, 3) && houseFed(ps, id);
      const m = lit ? this.mats.glass : mesh.userData.day;
      if (mesh.material !== m) mesh.material = m;
    }
    // each light eases towards on or off (off at once when the power goes)
    let iS = 0, iP = 0, any = false, changed = moved;
    for (const s of src) {
      const fed = s.k === 'street' ? nodeFed(ps, s.h.g) : houseFed(ps, s.b);
      const want = on && s.ok && fed && dark > s.th ? 1 : 0;
      const was = s.on;
      s.on = !fed ? 0 : want > s.on ? Math.min(1, s.on + dt / (s.k === 'street' ? 2.5 : 0.15)) : Math.max(0, s.on - dt / 0.3);
      if (s.on > 0) any = true;
      if (s.on !== was) {
        changed = true;
        _c.copy(OFF).lerp(s.k === 'street' ? STREET : WARM, s.on);
        (s.k === 'street' ? M.lens : M.bulb).setColorAt(s.k === 'street' ? iS : iP, _c);
      }
      if (s.k === 'street') iS++; else iP++;
    }
    if (changed) { if (M.lens.instanceColor) M.lens.instanceColor.needsUpdate = true; if (M.bulb.instanceColor) M.bulb.instanceColor.needsUpdate = true; }
    // the real lights: the few lit lamps nearest the eye; their pools give way to them as they fade in
    this.realLights(dt, camera);
    M.pool.visible = M.gS.visible = M.gP.visible = any;
    if (!any) return;
    const gS = M.gS.geometry.attributes, gP = M.gP.geometry.attributes;
    iS = 0; iP = 0;
    src.forEach((s, i) => {
      const k = s.k === 'street', g = k ? gS : gP, j = k ? iS++ : iP++;
      const I = s.on * (k ? CFG.STREETLIGHT_GLOW : CFG.PORCH_GLOW);
      g.position.setXYZ(j, s.at.x, s.at.y, s.at.z);
      _c.copy(k ? STREET : WARM).multiplyScalar(I); g.color.setXYZ(j, _c.r, _c.g, _c.b);
      const pw = s.on * (1 - (s.real || 0)) * (k ? CFG.STREETLIGHT_POOL_I : CFG.PORCH_POOL_I);
      if (pw <= 0.002) { M.pool.setMatrixAt(i, ZERO); return; }
      _q.setFromUnitVectors(Y, s.n);
      M.pool.setMatrixAt(i, _m.compose(s.pool, _q, _s.set(s.r, 1, s.r)));
      M.pool.setColorAt(i, _c.copy(k ? STREET : WARM).multiplyScalar(pw));
    });
    gS.position.needsUpdate = gS.color.needsUpdate = gP.position.needsUpdate = gP.color.needsUpdate = true;
    M.pool.instanceMatrix.needsUpdate = true; if (M.pool.instanceColor) M.pool.instanceColor.needsUpdate = true;
  }

  /** CFG.LAMP_LIGHTS SpotLights (LAMP_LIGHTS_PHONE on a phone) on the lit lamps nearest the eye, re-picked a few times a second. */
  realLights(dt, camera) {
    const want = Math.max(0, Math.round(touchFirst() ? CFG.LAMP_LIGHTS_PHONE : CFG.LAMP_LIGHTS));
    while (this.lights.length < want) { const L = new THREE.SpotLight(0xffd29a, 0, 1, 1.25, 0.5, 2); this.scene.add(L, L.target); this.lights.push({ L, s: null, w: 0 }); }
    while (this.lights.length > want) { const R = this.lights.pop(); this.scene.remove(R.L, R.L.target); R.L.dispose(); if (R.s) R.s.real = 0; }
    if (!this.lights.length) return;
    this.pickT -= dt;
    if (this.pickT <= 0) {
      this.pickT = 0.3;
      const eye = camera.position, near = this.src.filter((s) => s.on > 0.5).map((s) => [s.at.distanceToSquared(eye), s]).sort((a, b) => a[0] - b[0]).slice(0, this.lights.length).map((x) => x[1]);
      for (const R of this.lights) R.next = near.includes(R.s) ? R.s : null;     // a light stays on a lamp still among the nearest
      for (const s of near) if (!this.lights.some((R) => R.next === s)) { const R = this.lights.find((x) => x.next === null); if (R) R.next = s; }
    }
    for (const R of this.lights) {
      // fade out on the old lamp before moving to the new one
      if (R.s !== R.next) { R.w = Math.max(0, R.w - dt / 0.4); if (R.w === 0) { if (R.s) R.s.real = 0; R.s = R.next; } }
      else if (R.s) R.w = Math.min(1, R.w + dt / 0.4);
      const s = R.s;
      if (!s) { R.L.intensity = 0; continue; }
      s.real = R.w;
      const k = s.k === 'street';
      R.L.position.copy(s.at); R.L.position.y -= 0.05;
      R.L.target.position.copy(R.L.position); R.L.target.position.y -= 1; R.L.target.updateMatrixWorld();
      R.L.angle = k ? 1.25 : 1.45;                // shades: a streetlight shines down, a porch light out and down
      R.L.distance = k ? CFG.STREETLIGHT_REACH : CFG.PORCH_REACH;
      R.L.color.copy(k ? STREET : WARM);
      R.L.intensity = R.w * s.on * (k ? CFG.STREETLIGHT : CFG.PORCH);
    }
  }
}

/** The porch light of house b, if its front door's room still stands where it was put up: lamp, fixture, pool centre, rotation. */
function porchOf(b) {
  for (const m of b.mods) {
    if (m.ids || m.body !== b.id || m.shape !== 'room') continue;
    const pt = m.parts && m.parts.find((x) => x.mat === 'door'); if (!pt) continue;
    const fr = compose(b.p, b.q, m.p, m.q), loc = (x, y, z) => compose(fr.p, fr.q, [x, y, z], [0, 0, 0, 1]).p;
    const [cx, cy, cz] = pt.c, [hx, hy, hz] = pt.h, x = cx + hx + 0.22, y = cy + hy + 0.3, z = cz + hz;
    return { at: loc(x, y, z + 0.08), fix: loc(x, y + 0.02, z + 0.05), pool: loc(cx + 0.3, 0, z + 1.3), q: fr.q };
  }
  return null;
}

function glowTexture() {
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const g = c.getContext('2d'), gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.12, 'rgba(255,240,210,0.85)'); gr.addColorStop(0.4, 'rgba(255,200,140,0.22)'); gr.addColorStop(1, 'rgba(255,190,120,0)');
  g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}
function poolTexture() {
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const g = c.getContext('2d'), gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  // roughly 1 / (1 + (r / h)^2)^1.5 for a lamp a third of the pool's radius up, eased to nothing at the rim
  for (let i = 0; i <= 10; i++) { const r = i / 10, v = Math.pow(1 + 9 * r * r, -1.5) * (1 - r * r); gr.addColorStop(r, `rgba(255,255,255,${v.toFixed(3)})`); }
  g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}
