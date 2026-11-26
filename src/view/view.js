// Three.js view. Builds meshes from the world model, poses them from a
// transform source (the sim on the host, the interpolator on clients).
// No game rules in here. See docs/DESIGN.md 1.1.
//
// Wood is drawn twice, both from the fibre bundles:
//  * fibres - one box per fibre (two where the saw has parted it), coloured by
//    load when CFG.STRESS_COLORS: woody yellow = none, red = compression (to
//    crushing), blue = tension (to breaking), green = being bent over in a
//    live bundle, dark = snapped;
//  * bark - a skin of panels, each owned by the outermost fibre behind it and
//    drawn only where that fibre still is. So a kerf is a slot in the bark, a
//    notch is a missing wedge, and a stump ends where its fibres end.
// CFG.BARK_OPACITY blends between them (the Tab menu).

import * as THREE from 'three';
import { segAxis, segLen, segParam, lanyardLoop, playerName } from '../model/world.js';
import { bundleBasis, layout, CUT } from '../model/fibres.js';
import { Flex, frameApply } from '../model/flex.js';
import { CFG, MODE, INJ } from '../config.js';
import { PaverView } from './pavers.js';
import { Sky } from './sky.js';
import { TerrainView } from './terrain.js';
import { groundY } from '../model/terrain.js';
import { ChipperView, saladGeometry } from './chipper.js';
import { BuildsView } from './builds.js';
import { SHAPE } from '../model/chipper.js';
import { woodInto, fibreWidth } from './wood.js';
import { StandsView } from './stands.js';
import { WeedsView } from './weeds.js';

const PLAYER_COLORS = [0xe8a23a, 0x3a9be8, 0xd94f6a, 0x62c462, 0xb07be0, 0xe0d24a];   // shirts for players who picked none
const HEAD_R = 0.19, HEAD_Y = 0.56;   // m: the head on the player capsule (centre above the body centre)
const Y = new THREE.Vector3(0, 1, 0);
const _v = new THREE.Vector3(), _w = new THREE.Vector3(), _m = new THREE.Matrix4(), _c = new THREE.Color();
const _q2 = new THREE.Quaternion(), _e0 = [0, 0, 0], _e1 = [0, 0, 0];
const _bx = new THREE.Vector3(), _by = new THREE.Vector3(), _bz = new THREE.Vector3(), _s = new THREE.Vector3(), _q = new THREE.Quaternion();
const NEUTRAL = [0.86, 0.69, 0.33], RED = [0.92, 0.08, 0.06], BLUE = [0.08, 0.25, 0.98], GREEN = [0.1, 0.85, 0.2], DEAD = [0.3, 0.22, 0.14];

// Bark this solid hides what is behind it (it also writes depth from 0.95, applySettings).
const hidesWhole = () => CFG.BARK_OPACITY >= 0.99;

// A bundle with every fibre there end to end: nothing cut, nothing trimmed by a split.
function whole(s) {
  const f = s.f; if (f.ncut > 0) return false;
  if (f.lo) { const L = segLen(s) - 1e-4; for (let i = 0; i < f.n; i++) if (f.lo[i] > 1e-4 || f.hi[i] < L) return false; }
  return true;
}

/**
 * Ids of the segments whose fibres solid bark hides completely: the bundle is whole, so the bark round it is
 * whole too; its base is shut by the wood it grows from (a parent in the piece), or by the ground under a standing trunk; its top is shut by the stem
 * carrying on from it (a child starting where it ends); and those neighbours are whole as well, so no kerf or
 * break next door looks into it. Twig tips and the ends of pieces stay drawn: the bark is open there.
 */
function sealed(segs, world) {
  const ok = new Map(), out = new Set();
  for (const s of segs) ok.set(s.id, whole(s));
  for (const s of segs) {
    if (!ok.get(s.id)) continue;
    const rooted = s.parent < 0 && world.pieces.get(s.piece)?.fixed;     // the standing trunk's foot is in the ground
    if (!rooted && !ok.get(s.parent)) continue;                      // a parent elsewhere (or none) is not in the map
    let top = false, near = true;
    for (const k of world.kids(s.id)) {
      const c = world.segs.get(k); if (!c || c.piece !== s.piece) continue;
      if (Math.abs(c.a[0] - s.b[0]) + Math.abs(c.a[1] - s.b[1]) + Math.abs(c.a[2] - s.b[2]) < 1e-4) { top = true; if (!ok.get(k)) near = false; }
    }
    if (top && near) out.add(s.id);
  }
  return out;
}

const _fpTilt = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.35, 0, -0.25));   // the salad in your hand, tipped toward you

export class View {
  constructor(canvas, world) {
    this.world = world;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(1);
    this.renderer.shadowMap.enabled = true;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x9fc4e0);
    this.fog = new THREE.Fog(0x9fc4e0, 40, 140);   // the sky's colour, so fully fogged ground meets the sky with no seam
    this.camera = new THREE.PerspectiveCamera(72, 1, 0.05, 300);
    this.drawDist = CFG.DRAW_DIST;   // m, now: CFG.DRAW_DIST, ridden down towards CFG.DRAW_DIST_MIN while frames are slow (adaptDraw)
    this.frameMs = 0; this.lastFrame = 0;
    this.camera.position.set(6, 3, 9); this.camera.lookAt(0, 4, 0);

    const hemi = new THREE.HemisphereLight(0xdfeeff, 0x4a5a3a, 1.2);
    const sun = new THREE.DirectionalLight(0xfff2d8, 2.0);   // the sun by day, the moon by night (sky.js)
    sun.position.set(14, 26, 10); sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);
    Object.assign(sun.shadow.camera, { left: -18, right: 18, top: 18, bottom: -18, near: 1, far: 70 });
    this.scene.add(hemi, sun);
    this.sky = new Sky(this.scene, hemi, sun);

    this.terrainView = new TerrainView(this.scene, world);  // the ground: hills and ledges, or flat
    this.paverView = new PaverView(this.scene, world);   // concrete pavers round the tree, and their cracks
    this.chipperView = new ChipperView(this.scene, world);   // the wood chipper and its chip piles
    this.buildsView = new BuildsView(this.scene, world);     // the shed, whole or in pieces
    this.weedsView = new WeedsView(this.scene, world);       // long grass at the foot of fences, buildings and trunks

    this.barkMat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true, transparent: true, side: THREE.DoubleSide });
    this.leafMat = new THREE.MeshLambertMaterial({ color: 0x3f7d3a, flatShading: true, transparent: true });
    this.standsView = new StandsView(this.scene, world, this.leafMat);   // the other trees in the yards, until they come to life
    this.fibreMat = new THREE.MeshLambertMaterial({ color: 0xffffff });   // lit like the bark: dark at night, seen by headlamp (D84)
    this.fibreGeo = new THREE.BoxGeometry(1, 1, 1);
    this.ropeMat = new THREE.MeshLambertMaterial({ color: 0xf2e9d0, flatShading: true });
    this.lanyardMat = new THREE.MeshLambertMaterial({ color: 0xffd21a, flatShading: true });
    this.flex = new Flex(world);   // bending, from the stress planes in aux (clients; the host hands over the sim's own)
    this.pieces = new Map();      // piece id -> {group, bark, leaves, fibres, segStart, ...}
    this.players = new Map();     // player id -> {group, saw, lanyard}
    this.lastAuxTick = -1;

    this.ropeMesh = new THREE.Mesh(new THREE.BufferGeometry(), this.ropeMat);
    this.ropeMesh.frustumCulled = false; this.ropeMesh.castShadow = true; this.scene.add(this.ropeMesh);
    this.blockMesh = new THREE.Mesh(new THREE.OctahedronGeometry(0.12), new THREE.MeshLambertMaterial({ color: 0xf0c020, flatShading: true }));
    this.deviceMesh = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.35, 6), new THREE.MeshLambertMaterial({ color: 0xc03030, flatShading: true }));
    this.knotMesh = new THREE.Mesh(new THREE.OctahedronGeometry(0.08), new THREE.MeshLambertMaterial({ color: 0xf2e9d0, flatShading: true }));
    this.scene.add(this.blockMesh, this.deviceMesh, this.knotMesh);

    world.on((ev, info) => this.onEvent(ev, info));
    window.addEventListener('resize', () => this.resize()); this.resize();
    this.applySettings();
  }

  resize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h; this.camera.updateProjectionMatrix();
  }

  /** Re-read the view settings in CFG (called at start and whenever the menu changes one). */
  applySettings() {
    const bo = CFG.BARK_OPACITY;
    this.barkMat.opacity = bo; this.barkMat.depthWrite = bo > 0.95;
    this.leafMat.opacity = CFG.LEAF_OPACITY; this.leafMat.depthWrite = CFG.LEAF_OPACITY > 0.95;
    if (this.paverView.gravel !== CFG.PAVER_GRAVEL) { this.paverView.gravel = CFG.PAVER_GRAVEL; this.paverView.refresh(); }
    for (const p of this.pieces.values()) { p.bark.visible = bo > 0.01; p.leaves.visible = CFG.LEAF_OPACITY > 0.01; p.fibres.visible = CFG.SHOW_FIBRES; }
    // solid bark hides whole bundles, see-through bark shows them: crossing over redraws the fibres
    if (this.hideWhole !== hidesWhole()) { this.hideWhole = hidesWhole(); for (const [id, p] of this.pieces) { this.buildFibres(p, this.world.segsOf(id)); p.ver = -1; } }
    this.lastAuxTick = -1; this.painted = false;
  }

  // ---- model -> meshes ----
  onEvent(ev, info) {
    this.terrainView.onEvent(ev);
    this.paverView.onEvent(ev);
    this.chipperView.onEvent(ev);
    this.buildsView.onEvent(ev);
    this.standsView.onEvent(ev);
    this.weedsView.onEvent(ev);
    switch (ev.t) {
      case 'reset':
        for (const id of [...this.pieces.keys()]) this.dropPiece(id);
        this.flex.clear();
        break;
      case 'load':
        for (const id of [...this.pieces.keys()]) this.dropPiece(id);
        for (const id of this.world.pieces.keys()) this.buildPiece(id);
        break;
      case 'tree': this.buildPiece(ev.piece); break;
      case 'split': {
        if (!info.moved) break;
        const old = this.pieces.get(info.oldPiece), fr = this.flexNow && (ev.at > 0 ? this.flexNow.at(ev.seg, ev.at) : this.flexNow.joint(ev.seg));
        this.flex.release(info.moved, fr);
        this.buildPiece(info.oldPiece);
        const np = this.buildPiece(ev.newPiece);
        if (old) {
          np.group.position.copy(old.group.position); np.group.quaternion.copy(old.group.quaternion);
          if (fr) {         // ...bent as its root segment was, until the first snapshot of the new body arrives
            np.group.position.add(_v.set(fr.t[0], fr.t[1], fr.t[2]).applyQuaternion(old.group.quaternion));
            np.group.quaternion.multiply(_q.set(fr.q[0], fr.q[1], fr.q[2], fr.q[3]));
          }
        }
        break;
      }
      case 'cut': case 'divide': case 'rip': { const s = this.world.segs.get(ev.seg); if (s) this.buildPiece(s.piece); break; }
      case 'rmpiece': this.dropPiece(ev.piece); break;
      case 'chip':
        for (const id of info.touched || []) { if (this.world.pieces.has(id)) this.buildPiece(id); else this.dropPiece(id); }
        break;
    }
  }

  dropPiece(id) {
    const p = this.pieces.get(id); if (!p) return;
    this.scene.remove(p.group);
    p.bark.geometry.dispose(); p.leaves.geometry.dispose(); p.fibres.dispose();
    this.pieces.delete(id);
  }

  buildPiece(id) {
    let p = this.pieces.get(id);
    if (!p) {
      const group = new THREE.Group();
      const bark = new THREE.Mesh(new THREE.BufferGeometry(), this.barkMat);
      const leaves = new THREE.Mesh(new THREE.BufferGeometry(), this.leafMat);
      bark.castShadow = leaves.castShadow = true; bark.receiveShadow = true;
      group.add(bark, leaves); this.scene.add(group);
      p = { group, bark, leaves, fibres: null };
      this.pieces.set(id, p);
    }
    const segs = this.world.segsOf(id);
    const { pos, col, lpos, barkSpan, leafSeg } = woodInto(segs, this.world.mark);
    const set = (mesh, arr, colors) => {
      mesh.geometry.dispose();
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(arr, 3));
      if (colors) g.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
      g.computeVertexNormals(); g.computeBoundingSphere();
      mesh.geometry = g;
    };
    set(p.bark, pos, col); set(p.leaves, lpos, null);
    p.barkBase = Float32Array.from(pos); p.leafBase = Float32Array.from(lpos); p.barkSpan = barkSpan; p.leafSeg = leafSeg; p.ver = -1; p.bent = false;
    this.buildFibres(p, segs);
    p.bark.visible = CFG.BARK_OPACITY > 0.01; p.leaves.visible = CFG.LEAF_OPACITY > 0.01;
    this.lastAuxTick = -1; this.painted = false;
    return p;
  }

  // One box per fibre (two where the saw has parted it). Instances are grouped by segment.
  // Under solid bark, a bundle that is whole and shut in on both ends cannot be seen, so it is not drawn (sealed).
  buildFibres(p, segs) {
    if (p.fibres) { p.group.remove(p.fibres); p.fibres.dispose(); }
    if (hidesWhole()) { const shut = sealed(segs, this.world); segs = segs.filter((s) => !shut.has(s.id)); }
    let cap = 0; for (const s of segs) cap += s.f.n + s.f.ncut;
    const mesh = new THREE.InstancedMesh(this.fibreGeo, this.fibreMat, Math.max(1, cap));
    mesh.frustumCulled = false;
    const info = [];              // per instance: [seg, fibre index]
    const ends = [];              // per instance: its two ends (unbent, piece-local), where along the segment they are, its width
    let k = 0;
    for (const s of segs) {
      const f = s.f, Ly = layout(f.N), L = segLen(s), ax = segAxis(s), { u, v } = bundleBasis(ax);
      // box Y runs along the grain. (v, axis, u) is right-handed; (u, axis, v) is a mirror and is NOT a rotation.
      _bx.set(v[0], v[1], v[2]); _by.set(ax[0], ax[1], ax[2]); _bz.set(u[0], u[1], u[2]);
      _m.makeBasis(_bx, _by, _bz); _q.setFromRotationMatrix(_m);
      const fw = fibreWidth(s);
      const part = (i, z0, z1) => {
        if (z1 - z0 < 0.004) return;
        const zm = (z0 + z1) / 2, R = s.r0 + (s.r1 - s.r0) * Math.min(1, Math.max(0, zm / L)), h = fw;
        const x = Ly.X[i] * R, y = Ly.Y[i] * R;
        _v.set(s.a[0] + ax[0] * zm + u[0] * x + v[0] * y, s.a[1] + ax[1] * zm + u[1] * x + v[1] * y, s.a[2] + ax[2] * zm + u[2] * x + v[2] * y);
        // fibres converge with the stem's taper, exactly as the physics has them (base at X*r0, tip at X*r1)
        const k2 = (s.r1 - s.r0) / L, ox = Ly.X[i] * k2, oy = Ly.Y[i] * k2;
        _w.set(ax[0] + u[0] * ox + v[0] * oy, ax[1] + u[1] * ox + v[1] * oy, ax[2] + u[2] * ox + v[2] * oy);
        const stretch = _w.length(); _w.multiplyScalar(1 / stretch);
        _q2.setFromUnitVectors(_by, _w).multiply(_q);
        mesh.setMatrixAt(k, _m.compose(_v, _q2, _s.set(h, (z1 - z0) * stretch, h)));
        const ra = s.r0 + (s.r1 - s.r0) * z0 / L, rb = s.r0 + (s.r1 - s.r0) * z1 / L;
        ends.push(s.a[0] + ax[0] * z0 + (u[0] * Ly.X[i] + v[0] * Ly.Y[i]) * ra, s.a[1] + ax[1] * z0 + (u[1] * Ly.X[i] + v[1] * Ly.Y[i]) * ra, s.a[2] + ax[2] * z0 + (u[2] * Ly.X[i] + v[2] * Ly.Y[i]) * ra,
          s.a[0] + ax[0] * z1 + (u[0] * Ly.X[i] + v[0] * Ly.Y[i]) * rb, s.a[1] + ax[1] * z1 + (u[1] * Ly.X[i] + v[1] * Ly.Y[i]) * rb, s.a[2] + ax[2] * z1 + (u[2] * Ly.X[i] + v[2] * Ly.Y[i]) * rb,
          z0 / L, z1 / L, h, _q2.x, _q2.y, _q2.z, _q2.w);
        info.push(s, i); k++;
      };
      for (let i = 0; i < f.n; i++) {
        const lo = f.lo ? f.lo[i] : 0, hi = f.hi ? f.hi[i] : L;
        if (f.state[i] === CUT) { part(i, lo, f.zmin[i] - 0.008); part(i, f.zmax[i] + 0.008, hi); }   // gap drawn a little wide so a kerf reads
        else part(i, lo, hi);
      }
    }
    mesh.count = k;
    for (let i = 0; i < k; i++) mesh.setColorAt(i, _c.setRGB(NEUTRAL[0], NEUTRAL[1], NEUTRAL[2]));
    mesh.instanceMatrix.needsUpdate = true;
    mesh.visible = CFG.SHOW_FIBRES;
    p.fibres = mesh; p.info = info; p.fibBase = Float32Array.from(mesh.instanceMatrix.array.subarray(0, k * 16)); p.ends = Float32Array.from(ends);
    p.group.add(mesh);
  }

  /** Colour every fibre from the host's per-bundle stress (aux.fs) and per-fibre live forces (aux.live). */
  paintFibres(aux) {
    const fs = new Map(), live = new Map();
    for (let i = 0; i < aux.fs.length; i += 4) fs.set(aux.fs[i], i);
    for (const l of aux.live) { live.set(l.seg, l); live.set(l.stub, l); }
    const g = CFG.COLOR_GAMMA, cm = CFG.COMP / CFG.MOR, stress = CFG.STRESS_COLORS;
    for (const p of this.pieces.values()) {
      const info = p.info, mesh = p.fibres, arr = mesh.instanceColor.array;
      for (let k = 0; k < mesh.count; k++) {
        const s = info[k * 2], i = info[k * 2 + 1], f = s.f;
        let t = 0, bend = 0, dead = false;          // t = stress as a fraction of the limit: + tension, - compression
        const lv = live.get(s.id);
        if (!stress) { /* plain wood */ } else if (lv && lv.f.length === f.n) {
          if (lv.f[i] === -128) dead = true; else { t = lv.f[i] / 100; if (t < 0) t /= cm; bend = Math.min(1, lv.a / 0.6); }
        } else if (f.state[i] !== CUT) {
          const o = fs.get(s.id);
          if (o !== undefined) {
            const Ly = layout(f.N), R = s.r0 + (s.r1 - s.r0) * f.at;
            const eps = (aux.fs[o + 1] + aux.fs[o + 2] * Ly.X[i] * R + aux.fs[o + 3] * Ly.Y[i] * R) * 1e-7;    // this fibre's strain
            t = eps >= 0 ? eps / CFG.TENS_STRAIN : eps / CFG.COMP_STRAIN;
          }
        }
        let r = NEUTRAL[0], gg = NEUTRAL[1], b = NEUTRAL[2];
        if (dead) { r = DEAD[0]; gg = DEAD[1]; b = DEAD[2]; }
        else {
          const to = t >= 0 ? BLUE : RED, a = Math.pow(Math.min(1, Math.abs(t)), g);
          r += (to[0] - r) * a; gg += (to[1] - gg) * a; b += (to[2] - b) * a;
          if (bend > 0) { r += (GREEN[0] - r) * bend; gg += (GREEN[1] - gg) * bend; b += (GREEN[2] - b) * bend; }
        }
        const sh = 0.9 + ((i * 7 + s.id * 3) % 5) * 0.035;      // slight per-fibre shade so neighbours can be told apart
        arr[k * 3] = r * sh; arr[k * 3 + 1] = gg * sh; arr[k * 3 + 2] = b * sh;
      }
      mesh.instanceColor.needsUpdate = true;
    }
  }

  /**
   * Put a piece's wood where the fibres' lengths say it is (flex = a Flex). Every fibre is redrawn between its
   * own two ends - each end riding on the tilted cross-section it belongs to - so fibres visibly lean, stretch
   * and shorten individually. Bark panels and foliage follow the same cross-sections.
   */
  bendPiece(p, flex) {
    if (p.ver === flex.ver) return;
    p.ver = flex.ver;
    let any = false;
    const cache = new Map();                    // seg id * 4096 + t -> frame
    const at = (id, t) => { const key = id * 4096 + Math.round(t * 2048); let f = cache.get(key); if (f === undefined) { f = flex.at(id, t); cache.set(key, f); } return f; };
    const put = (f, base, i, out) => {
      if (!f) { out[i] = base[i]; out[i + 1] = base[i + 1]; out[i + 2] = base[i + 2]; return; }
      _v.set(base[i], base[i + 1], base[i + 2]).applyQuaternion(_q.set(f.q[0], f.q[1], f.q[2], f.q[3]));
      out[i] = _v.x + f.t[0]; out[i + 1] = _v.y + f.t[1]; out[i + 2] = _v.z + f.t[2];
    };
    const end = (f, base, i, out) => {
      if (!f) { out[0] = base[i]; out[1] = base[i + 1]; out[2] = base[i + 2]; return; }
      _v.set(base[i], base[i + 1], base[i + 2]).applyQuaternion(_q.set(f.q[0], f.q[1], f.q[2], f.q[3]));
      out[0] = _v.x + f.t[0]; out[1] = _v.y + f.t[1]; out[2] = _v.z + f.t[2];
    };
    const bp = p.bark.geometry.getAttribute('position'), lp = p.leaves.geometry.getAttribute('position');
    if (bp) {
      const sp = p.barkSpan, base = p.barkBase, out = bp.array;
      for (let n = 0; n < sp.length; n += 4) {
        const f0 = at(sp[n], sp[n + 2]), f1 = at(sp[n], sp[n + 3]), i = sp[n + 1] * 3;
        if (f0 || f1) any = true;
        put(f0, base, i, out); put(f0, base, i + 3, out); put(f1, base, i + 6, out);       // p00 p10 p11
        put(f0, base, i + 9, out); put(f1, base, i + 12, out); put(f1, base, i + 15, out); // p00 p11 p01
      }
      bp.needsUpdate = true;
    }
    if (lp) {
      const sg = p.leafSeg, base = p.leafBase, out = lp.array;
      for (let n = 0; n < sg.length; n += 3) { const f = at(sg[n], 1); for (let i = sg[n + 1] * 3, e = i + sg[n + 2] * 3; i < e; i += 3) put(f, base, i, out); }
      lp.needsUpdate = true;
    }
    const info = p.info, arr = p.fibres.instanceMatrix.array, base = p.fibBase, E = p.ends;
    for (let k = 0; k < p.fibres.count; k++) {
      const id = info[k * 2].id, o = k * 13, f0 = at(id, E[o + 6]), f1 = at(id, E[o + 7]);
      if (!f0 && !f1) { for (let i = k * 16; i < k * 16 + 16; i++) arr[i] = base[i]; continue; }
      any = true;
      end(f0, E, o, _e0); end(f1, E, o + 3, _e1);
      _bx.set(E[o + 3] - E[o], E[o + 4] - E[o + 1], E[o + 5] - E[o + 2]).normalize();            // how it lay when grown
      _by.set(_e1[0] - _e0[0], _e1[1] - _e0[1], _e1[2] - _e0[2]); const len = _by.length(); _by.multiplyScalar(1 / (len || 1));
      _q2.setFromUnitVectors(_bx, _by).multiply(_q.set(E[o + 9], E[o + 10], E[o + 11], E[o + 12]));
      _m.compose(_v.set((_e0[0] + _e1[0]) / 2, (_e0[1] + _e1[1]) / 2, (_e0[2] + _e1[2]) / 2), _q2, _s.set(E[o + 8], len, E[o + 8])).toArray(arr, k * 16);
    }
    p.fibres.instanceMatrix.needsUpdate = true;
    p.bent = any;
  }

  playerMesh(id) {
    let p = this.players.get(id);
    if (p) return p;
    // The body is drawn round the physics capsule (P_HALF + P_RADIUS = 0.88 m from its centre to each end):
    // a short tube torso in the shirt colour, a round head, the white helmet with its headlamp, and a face of
    // two flat eyes. A name tag on the chest and the name again across the back of the helmet.
    const group = new THREE.Group();
    const shirt = new THREE.MeshLambertMaterial({ color: 0xe8a23a, flatShading: true });
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.26, 0.7, 2, 9), shirt);
    body.position.y = -0.25;                        // feet at -0.86, shoulders at 0.36
    const head = new THREE.Mesh(new THREE.SphereGeometry(HEAD_R, 12, 9), new THREE.MeshLambertMaterial({ color: 0xe9c29a, flatShading: true }));
    head.position.y = HEAD_Y;
    const helmetMat = new THREE.MeshLambertMaterial({ color: 0xf4f4f4, flatShading: true });
    const helmet = new THREE.Mesh(new THREE.SphereGeometry(0.205, 10, 5, 0, 2 * Math.PI, 0, 1.3), helmetMat);
    helmet.position.y = HEAD_Y + 0.025;
    const brim = new THREE.Mesh(new THREE.CylinderGeometry(0.235, 0.235, 0.012, 12), helmetMat);
    brim.position.y = helmet.position.y + 0.205 * Math.cos(1.3) + 0.004;
    body.castShadow = head.castShadow = helmet.castShadow = true;
    const lampMat = new THREE.MeshBasicMaterial({ color: 0x555555 });
    const lampBox = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.06, 0.05), lampMat);
    lampBox.position.set(0, HEAD_Y + 0.13, -0.175);
    group.add(body, head, helmet, brim, lampBox);
    // eyes: one drawing of the viewer's-left eye; the other eye shows it mirrored (its UVs flipped)
    const eyeCv = document.createElement('canvas'); eyeCv.width = eyeCv.height = 64;
    const eyeTex = new THREE.CanvasTexture(eyeCv); eyeTex.colorSpace = THREE.SRGBColorSpace;
    const eyeMat = new THREE.MeshLambertMaterial({ map: eyeTex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 });
    const eyeGeo = new THREE.PlaneGeometry(0.085, 0.085), eyeGeoM = eyeGeo.clone(), uv = eyeGeoM.attributes.uv;
    for (let i = 0; i < uv.count; i++) uv.setX(i, 1 - uv.getX(i));
    for (const side of [1, -1]) {                   // +x is the viewer's left when the player faces you (-z is their front)
      const az = 0.36 * side, el = 0.1, d = new THREE.Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el));
      const eye = new THREE.Mesh(side > 0 ? eyeGeo : eyeGeoM, eyeMat);
      eye.position.set(0, HEAD_Y, 0).addScaledVector(d, HEAD_R + 0.004);
      eye.lookAt(_v.set(0, HEAD_Y, 0).addScaledVector(d, 2));   // the group is still at the origin here
      group.add(eye);
    }
    // name tag on the chest (a strip of the torso's own tube) and the name across the back of the helmet
    const tagCv = document.createElement('canvas'); tagCv.width = 256; tagCv.height = 80;
    const tagTex = new THREE.CanvasTexture(tagCv); tagTex.colorSpace = THREE.SRGBColorSpace; tagTex.anisotropy = 4;
    // over the left breast pocket: upper chest, off to the wearer's left (-x; they face -z)
    const tagW = 0.15, tagAt = Math.PI + 0.5, tag = new THREE.Mesh(new THREE.CylinderGeometry(0.263, 0.263, 0.047, 4, 1, true, tagAt - tagW / 0.263 / 2, tagW / 0.263),
      new THREE.MeshLambertMaterial({ map: tagTex, polygonOffset: true, polygonOffsetFactor: -2 }));
    tag.position.y = 0.02 + 1.25 * 0.047;            // raised 1.25 tag heights (owner)
    const backCv = document.createElement('canvas'); backCv.width = 256; backCv.height = 64;
    const backTex = new THREE.CanvasTexture(backCv); backTex.colorSpace = THREE.SRGBColorSpace; backTex.anisotropy = 4;
    const back = new THREE.Mesh(new THREE.SphereGeometry(0.207, 10, 3, Math.PI / 2 - 0.75, 1.5, 0.72, 0.5),
      new THREE.MeshLambertMaterial({ map: backTex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 }));
    back.position.y = helmet.position.y;
    group.add(tag, back);
    // a tube salad in the right hand (+x: they face -z), held up in front, while aux says they have one
    const salad = new THREE.Mesh(this.saladGeo || (this.saladGeo = saladGeometry()), this.saladMat || (this.saladMat = new THREE.MeshLambertMaterial({ color: 0x3fae3a, flatShading: true })));
    salad.position.set(0.3, -0.12, -0.24); salad.rotation.x = 1.1; salad.castShadow = true; salad.visible = false;
    group.add(salad);
    // headlamp: in the scene, not the body, so it still shines from your own head while your body is hidden
    const lamp = new THREE.SpotLight(0xfff4e0, 0, 0, CFG.HEADLAMP_ANGLE, 0.55, 2);
    this.scene.add(lamp, lamp.target);
    const saw = new THREE.Group();
    const engMat = new THREE.MeshLambertMaterial({ color: 0xe05a1a, flatShading: true });   // the shirt colour (setLook)
    const eng = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.13, 0.1), engMat);
    // the planted point is the middle of the bar's leading edge; the powerhead hangs off the -X end
    // unit length; stretched to the host's bar length each frame (BAR_LEN is tunable)
    const bar = new THREE.Mesh(new THREE.BoxGeometry(1, 0.012, 0.07), new THREE.MeshLambertMaterial({ color: 0xbbbbbb }));
    bar.position.z = -0.035; eng.position.set(-0.35, 0, -0.06); saw.add(eng, bar); saw.visible = false;
    const lanyard = new THREE.Mesh(new THREE.BufferGeometry(), this.lanyardMat);
    lanyard.frustumCulled = false; lanyard.visible = false;
    const grab = new THREE.Mesh(new THREE.BufferGeometry(), this.ropeMat);
    grab.frustumCulled = false; grab.visible = false;
    this.scene.add(group, saw, lanyard, grab);
    p = { id, group, salad, saw, bar, eng, lanyard, grab, lamp, lampMat, shirt, engMat, eyeCv, eyeTex, eyeState: '', blinkT: 1 + Math.random() * CFG.BLINK_GAP, tagCv, tagTex, backCv, backTex, lookKey: '' };
    this.players.set(id, p);
    return p;
  }

  /** Shirt, saw and name from the model (the 'player' event), redrawn only when they change. */
  setLook(pm) {
    const w = this.world.players.get(pm.id), name = playerName(this.world, pm.id);
    const c = w && w.color >= 0 ? w.color : PLAYER_COLORS[(pm.id - 1) % PLAYER_COLORS.length], key = name + '|' + c;
    if (key === pm.lookKey) return;
    pm.lookKey = key;
    pm.shirt.color.setHex(c); pm.engMat.color.setHex(c);
    const fit = (g, text, max, wMax) => { let f = max; do { g.font = `700 ${f}px system-ui, sans-serif`; f -= 2; } while (f > 10 && g.measureText(text).width > wMax); };
    let g = pm.tagCv.getContext('2d');
    g.fillStyle = '#f7f7f2'; g.fillRect(0, 0, 256, 80);
    g.fillStyle = '#c33'; g.fillRect(0, 0, 256, 14);                    // "HELLO my name is" stripe
    g.fillStyle = '#1b1b1b'; g.textAlign = 'center'; g.textBaseline = 'middle';
    fit(g, name, 44, 236); g.fillText(name, 128, 48);
    pm.tagTex.needsUpdate = true;
    g = pm.backCv.getContext('2d'); g.clearRect(0, 0, 256, 64);
    g.fillStyle = '#222'; g.textAlign = 'center'; g.textBaseline = 'middle';
    fit(g, name, 40, 240); g.fillText(name, 128, 34);
    pm.backTex.needsUpdate = true;
  }

  /** The eyes: open, blinking, wincing while shaken, worried while hurt, crosses when down. */
  poseFace(pm, a, dt) {
    pm.blinkT -= dt;
    if (pm.blinkT < -0.13) pm.blinkT = CFG.BLINK_GAP * (0.4 + 1.2 * Math.random());
    const st = a.inj === INJ.DOWN ? 'x' : a.sk ? 'wince' : pm.blinkT < 0 ? 'blink' : a.inj === INJ.HURT ? 'worry' : 'open';
    if (st === pm.eyeState) return;
    pm.eyeState = st;
    const g = pm.eyeCv.getContext('2d');
    g.clearRect(0, 0, 64, 64);
    g.strokeStyle = g.fillStyle = '#1a1410'; g.lineWidth = 7; g.lineCap = g.lineJoin = 'round';
    const line = (...xy) => { g.beginPath(); g.moveTo(xy[0], xy[1]); for (let i = 2; i < xy.length; i += 2) g.lineTo(xy[i], xy[i + 1]); g.stroke(); };
    if (st === 'x') { line(16, 18, 48, 50); line(48, 18, 16, 50); }
    else if (st === 'blink') { g.beginPath(); g.arc(32, 26, 16, 0.25 * Math.PI, 0.75 * Math.PI); g.stroke(); }
    else if (st === 'wince') line(18, 18, 46, 34, 18, 50);                // ">" squeezed shut toward the nose (the other eye mirrors it)
    else {
      const worry = st === 'worry', r = worry ? 9 : 11;
      g.beginPath(); g.ellipse(32, worry ? 38 : 34, r, r * 1.35, 0, 0, 2 * Math.PI); g.fill();
      g.fillStyle = '#fff'; g.beginPath(); g.arc(28, worry ? 32 : 28, 3.5, 0, 2 * Math.PI); g.fill();
      if (worry) { g.lineWidth = 5; line(12, 16, 50, 6); }                 // brow raised toward the nose
    }
    pm.eyeTex.needsUpdate = true;
  }

  /**
   * src.pose(id) -> {p, q} | null.  aux = latest aux packet (or null).
   * me = local player id. inp = local InputState (look angles).
   */
  update(dt, src, aux, me, inp) {
    for (const [id, p] of this.pieces) {
      const pose = src.pose(id);
      if (pose) { p.group.position.set(pose.p.x, pose.p.y, pose.p.z); p.group.quaternion.set(pose.q.x, pose.q.y, pose.q.z, pose.q.w); }
    }
    // bending: the host hands over the sim's own; a client works it out from the stress planes in aux
    let flex = src.flex || null;
    if (!flex && aux) {
      const at = new Map(); for (let i = 0; i < aux.fs.length; i += 4) at.set(aux.fs[i], i);
      this.flex.update(Math.min(dt, 0.05), (s) => { const o = at.get(s.id); return o === undefined ? null : [aux.fs[o + 1] * 1e-7, aux.fs[o + 2] * 1e-7, aux.fs[o + 3] * 1e-7]; });
      flex = this.flex;
    }
    this.flexNow = flex;
    if (flex) for (const p of this.pieces.values()) this.bendPiece(p, flex);
    if (aux && CFG.SHOW_FIBRES && aux.tick !== this.lastAuxTick && (CFG.STRESS_COLORS || !this.painted)) { this.lastAuxTick = aux.tick; this.painted = true; this.paintFibres(aux); }
    this.chipperView.update(dt, src, aux);
    this.poseWinch(aux);
    this.buildsView.update(src);
    this.weedsView.update(this.camera);
    const seen = new Set();
    let mePos = null, meA = null;
    if (aux) for (const a of aux.pl) {
      seen.add(a.id);
      const pm = this.playerMesh(a.id), pose = src.pose(60000 + a.id);
      if (pose) pm.group.position.set(pose.p.x, pose.p.y, pose.p.z);
      pm.group.rotation.y = a.yaw;
      pm.group.rotation.z = a.inj === INJ.DOWN ? Math.PI / 2 : 0;
      pm.group.visible = a.id !== me;                 // first person: you do not see your own body
      pm.salad.visible = !!a.hd;
      this.setLook(pm);
      if (pm.group.visible) this.poseFace(pm, a, dt);
      if (a.id === me) { mePos = pm.group.position; meA = a; }
      this.poseSaw(pm, a);
      this.poseLanyard(pm, a);
      this.poseGrab(pm, a);
    }
    for (const [id, pm] of [...this.players]) if (!seen.has(id)) { this.scene.remove(pm.group, pm.saw, pm.lanyard, pm.grab, pm.lamp, pm.lamp.target); pm.lamp.dispose(); this.players.delete(id); }
    this.updateRope(aux);

    if (mePos) {                                      // first person
      this.camera.position.copy(mePos).addScaledVector(Y, CFG.EYE);
      let pitch = inp.pitch, yaw = inp.yaw, roll = 0;
      if (meA && meA.inj === INJ.DOWN) {
        // down: the eyes are on the ground, the head turned on its side
        this.camera.position.y = groundY(this.world.terrain, mePos.x, mePos.z) + CFG.DOWN_EYE;
        roll = Math.PI / 2;
      }
      // shaken (or the shock of being hurt): the view swims, easing in and out over the pause
      this.wobble = Math.max(0, Math.min(1, (this.wobble || 0) + (meA && meA.sk ? dt : -dt) / 0.4));
      if (this.wobble > 0 && CFG.WOBBLE > 0) {
        const t = (this.wobT = (this.wobT || 0) + dt) * 2 * Math.PI * CFG.WOBBLE_HZ, A = CFG.WOBBLE * this.wobble;
        roll += A * Math.sin(t); pitch += 0.6 * A * Math.sin(1.7 * t + 1); yaw += 0.5 * A * Math.sin(0.8 * t + 2);
      }
      this.camera.quaternion.setFromEuler(new THREE.Euler(pitch, yaw, roll, 'YXZ'));
    }
    // your own tube salad, low in the bottom right of the view
    const fp = this.fpSalad || (this.fpSalad = this.handSalad());
    fp.visible = !!(mePos && meA && meA.hd && meA.inj !== INJ.DOWN);
    if (fp.visible) {
      fp.position.set(0.26, -0.27, -0.62).applyQuaternion(this.camera.quaternion).add(this.camera.position);
      fp.quaternion.copy(this.camera.quaternion).multiply(_fpTilt);
    }
    this.adaptDraw();
    this.sky.update(dt, aux, this.camera);
    this.scene.background.copy(this.sky.color); this.fog.color.copy(this.sky.color);
    if (aux) for (const a of aux.pl) this.poseLamp(this.players.get(a.id), a, a.id === me ? inp : null);
    this.renderer.render(this.scene, this.camera);
  }

  /** The salad drawn in your own hand (first person: your body is hidden). */
  handSalad() {
    const m = new THREE.Mesh(this.saladGeo || (this.saladGeo = saladGeometry()), this.saladMat || (this.saladMat = new THREE.MeshLambertMaterial({ color: 0x3fae3a, flatShading: true })));
    m.visible = false; this.scene.add(m); return m;
  }

  // a headlamp shines where its wearer looks (your own from the camera, so it follows your view exactly)
  poseLamp(pm, a, mine) {
    const on = this.sky.lamps, L = pm.lamp;
    L.intensity = CFG.HEADLAMP * on; L.angle = CFG.HEADLAMP_ANGLE;
    pm.lampMat.color.setHex(on > 0.5 ? 0xfff6c8 : 0x555555);
    if (mine) {
      L.position.copy(this.camera.position).addScaledVector(Y, 0.08);
      this.camera.getWorldDirection(_v);
    } else {
      const yaw = a.yaw, p = a.pt || 0;
      L.position.copy(pm.group.position).addScaledVector(Y, HEAD_Y + 0.13);
      _v.set(-Math.sin(yaw) * Math.cos(p), Math.sin(p), -Math.cos(yaw) * Math.cos(p));
      L.position.addScaledVector(_v, 0.2);
    }
    L.target.position.copy(L.position).add(_v);
    L.target.updateMatrixWorld();
  }

  /**
   * Draw distance: the far plane sits at this.drawDist, which is CFG.DRAW_DIST while the frame rate keeps
   * up. While the smoothed frame rate is under CFG.DRAW_FPS it shrinks (CFG.DRAW_ADAPT of itself per second)
   * towards CFG.DRAW_DIST_MIN; once it is 10% over, it grows back five times slower. The gap between the two
   * keeps it from hunting. Fog in the sky's colour runs from CFG.FOG_START of the distance to just short of
   * it, so what the far plane clips has already faded out (CFG.AUTO_FOG; off = no fog at all).
   */
  adaptDraw() {
    const now = performance.now(), ft = now - this.lastFrame; this.lastFrame = now;
    const max = CFG.DRAW_DIST, min = Math.min(CFG.DRAW_DIST_MIN, max);
    if (ft > 0 && ft < 250) {                     // not the first frame, nor the return to a hidden tab
      this.frameMs = this.frameMs ? this.frameMs + (ft - this.frameMs) * 0.05 : ft;   // about the last 20 frames
      const fps = 1000 / this.frameMs, s = ft / 1000;
      if (fps < CFG.DRAW_FPS) this.drawDist *= Math.exp(-CFG.DRAW_ADAPT * s);
      else if (fps > CFG.DRAW_FPS * 1.1) this.drawDist *= Math.exp(CFG.DRAW_ADAPT * 0.2 * s);
    }
    this.drawDist = Math.min(max, Math.max(min, this.drawDist));
    const d = this.drawDist, cam = this.camera;
    if (Math.abs(cam.far - d) > 0.01) { cam.far = d; cam.updateProjectionMatrix(); }
    this.scene.fog = CFG.AUTO_FOG ? this.fog : null;
    this.fog.far = d * 0.98; this.fog.near = Math.min(this.fog.far, d * CFG.FOG_START);
  }

  poseSaw(pm, a) {
    const sw = a.saw;                 // [planted point (3), bar direction (3), feed direction (3), stuck, cutting, bar length]
    pm.saw.visible = !!sw;
    if (!sw) return;
    // saw frame: X along the bar, Z = feed direction (the cutting edge leads), Y = normal of the cut
    _w.set(sw[3], sw[4], sw[5]); _bz.set(sw[6], sw[7], sw[8]); _by.crossVectors(_bz, _w).normalize();
    pm.saw.quaternion.setFromRotationMatrix(_m.makeBasis(_w, _by, _bz));
    pm.saw.position.set(sw[0], sw[1], sw[2]);
    pm.bar.material.color.setHex(sw[9] ? 0xff3030 : sw[10] ? 0xfff0a0 : 0xbbbbbb);
    const len = sw[11] || CFG.BAR_LEN;
    pm.bar.scale.x = len; pm.eng.position.x = -len / 2 - 0.1;
  }

  poseLanyard(pm, a) {
    const cl = a.m === MODE.CLIMB && a.cl, s = cl ? this.world.segs.get(cl[0]) : null, piece = s ? this.pieces.get(s.piece) : null;
    pm.lanyard.visible = !!piece;
    if (!piece) return;
    const fr = this.flexNow && this.flexNow.at(s.id, cl[1]);
    const pts = lanyardLoop(s, cl[1], cl[2], CFG.STANDOFF).map((q) => { const b = frameApply(fr, q); return new THREE.Vector3(b[0], b[1], b[2]).applyQuaternion(piece.group.quaternion).add(piece.group.position); });
    pm.lanyard.geometry.dispose();
    pm.lanyard.geometry = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts, false, 'catmullrom', 0.3), 20, 0.012, 5);
  }

  // the chippers' winches: a rope from the drum over the hopper to each piece it is pulling in
  poseWinch(aux) {
    const cv = this.chipperView, wn = [];
    if (aux && Array.isArray(aux.chip)) aux.chip.forEach((c, k) => { if (c && c.wn) for (const g of c.wn) wn.push([k, g]); });
    this.winchRopes = this.winchRopes || [];
    while (this.winchRopes.length < wn.length) {
      const m = new THREE.Mesh(new THREE.BufferGeometry(), this.ropeMat); m.frustumCulled = false; this.scene.add(m); this.winchRopes.push(m);
    }
    this.winchRopes.forEach((m, i) => {
      const k = wn[i] && wn[i][0], g = wn[i] && wn[i][1], P = g && cv.whole(k) ? this.nodeWorld({ seg: g[0], p: [g[1], g[2], g[3]] }, new THREE.Vector3()) : null;
      m.visible = !!P; if (!P) return;
      m.geometry.dispose();
      m.geometry = new THREE.TubeGeometry(new THREE.LineCurve3(cv.toWorld(SHAPE.WINCH, new THREE.Vector3(), k), P), 1, 0.012, 5);
    });
  }

  // wood held on the ground: a short rope from the hands to the point grabbed
  poseGrab(pm, a) {
    const g = a.gr, W = !g ? null : g[0] < 0 ? this.chipperView.toWorld([g[1], g[2], g[3]], new THREE.Vector3(), -1 - g[0]) : this.nodeWorld({ seg: g[0], p: [g[1], g[2], g[3]] }, new THREE.Vector3());
    pm.grab.visible = !!W;
    if (!W) return;
    const H = pm.group.position.clone().addScaledVector(Y, CFG.GRAB_HEIGHT);
    pm.grab.geometry.dispose();
    pm.grab.geometry = new THREE.TubeGeometry(new THREE.LineCurve3(H, W), 1, 0.012, 5);
  }

  nodeWorld(n, out) {
    if (n.chip) return this.chipperView.whole(n.k) ? this.chipperView.toWorld(SHAPE.INFEED, out, n.k || 0) : null;
    const s = this.world.segs.get(n.seg), piece = s && this.pieces.get(s.piece);
    if (!piece) return null;
    const b = frameApply(this.flexNow && this.flexNow.at(s.id, Math.min(1, Math.max(0, segParam(s, n.p)))), n.p);
    return out.set(b[0], b[1], b[2]).applyQuaternion(piece.group.quaternion).add(piece.group.position);
  }

  // The rigging line as a real tube: anchor -> block -> device -> tail, sagging where it is slack.
  updateRope(aux) {
    const r = this.world.rope, st = r.state || 0;
    const A = new THREE.Vector3(), B = new THREE.Vector3(), D = new THREE.Vector3();
    const hasB = st >= 1 && this.nodeWorld(r.block, B), hasD = st >= 1 && this.nodeWorld(r.device, D), hasA = st >= 2 && this.nodeWorld(r.anchor, A);
    this.blockMesh.visible = !!hasB; this.deviceMesh.visible = !!hasD; this.knotMesh.visible = !!hasA;
    this.ropeMesh.visible = !!(hasB && hasD);
    if (!hasB || !hasD) return;
    this.blockMesh.position.copy(B); this.deviceMesh.position.copy(D); if (hasA) this.knotMesh.position.copy(A);
    const pts = [];
    const span = (p, q, sag, n, skipFirst) => {
      for (let i = skipFirst ? 1 : 0; i <= n; i++) {
        const t = i / n, v = new THREE.Vector3().lerpVectors(p, q, t); v.y = Math.max(groundY(this.world.terrain, v.x, v.z) + 0.03, v.y - sag * 4 * t * (1 - t));
        pts.push(v);
      }
    };
    const slack = aux && aux.rope ? Math.max(0, aux.rope.slack) : 0;
    if (hasA) span(A, B, Math.min(3, Math.sqrt(slack) * 0.6), 10, false); else pts.push(B.clone());
    span(B, D, 0, 4, true);
    const holder = aux && aux.rope && aux.rope.holder >= 0 ? this.players.get(aux.rope.holder) : null;
    if (holder) span(D, _w.copy(holder.group.position).addScaledVector(Y, 0.2), 0.15, 5, true);
    else span(D, _w.set(D.x + 0.5, groundY(this.world.terrain, D.x + 0.5, D.z + 0.3) + 0.04, D.z + 0.3), 0, 3, true);
    this.ropeMesh.geometry.dispose();
    this.ropeMesh.geometry = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts, false, 'catmullrom', 0.05), pts.length * 2, CFG.ROPE_RADIUS, 6);
  }
}
