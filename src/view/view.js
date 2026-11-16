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
import { segAxis, segLen, lanyardLoop } from '../model/world.js';
import { bundleBasis, layout, CUT } from '../model/fibres.js';
import { Flex, frameApply } from '../model/flex.js';
import { CFG, MODE, INJ } from '../config.js';

const SIDES = 7;
const PLAYER_COLORS = [0xe8a23a, 0x3a9be8, 0xd94f6a, 0x62c462, 0xb07be0, 0xe0d24a];
const Y = new THREE.Vector3(0, 1, 0);
const _v = new THREE.Vector3(), _w = new THREE.Vector3(), _m = new THREE.Matrix4(), _c = new THREE.Color();
const _q2 = new THREE.Quaternion(), _mD = new THREE.Matrix4();
const _bx = new THREE.Vector3(), _by = new THREE.Vector3(), _bz = new THREE.Vector3(), _s = new THREE.Vector3(), _q = new THREE.Quaternion();
const NEUTRAL = [0.86, 0.69, 0.33], RED = [0.92, 0.08, 0.06], BLUE = [0.08, 0.25, 0.98], GREEN = [0.1, 0.85, 0.2], DEAD = [0.3, 0.22, 0.14];

export class View {
  constructor(canvas, world) {
    this.world = world;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(1);
    this.renderer.shadowMap.enabled = true;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x9fc4e0);
    this.scene.fog = new THREE.Fog(0x9fc4e0, 40, 140);
    this.camera = new THREE.PerspectiveCamera(72, 1, 0.05, 300);
    this.camera.position.set(6, 3, 9); this.camera.lookAt(0, 4, 0);

    this.scene.add(new THREE.HemisphereLight(0xdfeeff, 0x4a5a3a, 1.2));
    const sun = new THREE.DirectionalLight(0xfff2d8, 2.0);
    sun.position.set(14, 26, 10); sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);
    Object.assign(sun.shadow.camera, { left: -18, right: 18, top: 18, bottom: -18, near: 1, far: 70 });
    this.scene.add(sun);

    const ground = new THREE.Mesh(new THREE.CircleGeometry(150, 48).rotateX(-Math.PI / 2),
      new THREE.MeshLambertMaterial({ color: 0x5d8a48 }));
    ground.receiveShadow = true; this.scene.add(ground);

    this.barkMat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true, transparent: true, side: THREE.DoubleSide });
    this.leafMat = new THREE.MeshLambertMaterial({ color: 0x3f7d3a, flatShading: true, transparent: true });
    this.fibreMat = new THREE.MeshBasicMaterial({ color: 0xffffff });   // unlit: the colour IS the information
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
    for (const p of this.pieces.values()) { p.bark.visible = bo > 0.01; p.leaves.visible = CFG.LEAF_OPACITY > 0.01; p.fibres.visible = CFG.SHOW_FIBRES; }
    this.lastAuxTick = -1; this.painted = false;
  }

  // ---- model -> meshes ----
  onEvent(ev, info) {
    switch (ev.t) {
      case 'load':
        for (const id of [...this.pieces.keys()]) this.dropPiece(id);
        for (const id of this.world.pieces.keys()) this.buildPiece(id);
        break;
      case 'tree': this.buildPiece(ev.piece); break;
      case 'split': {
        if (!info.moved) break;
        const old = this.pieces.get(info.oldPiece), fr = this.flexNow && this.flexNow.frame(ev.seg);
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
      case 'cut': case 'divide': { const s = this.world.segs.get(ev.seg); if (s) this.buildPiece(s.piece); break; }
      case 'rmpiece': this.dropPiece(ev.piece); break;
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
    const pos = [], col = [], lpos = [];
    const barkSeg = [], leafSeg = [];           // [seg id, first vertex, vertex count] so bending can move each segment's part
    const ico = new THREE.IcosahedronGeometry(1, 0).attributes.position;
    for (const s of segs) {
      const start = pos.length / 3;
      const ax = segAxis(s), { u, v } = bundleBasis(ax), L = segLen(s), f = s.f, Ly = layout(f.N);
      // Bark panels. Each is owned by the outermost fibre behind it and covers only what is left of that fibre.
      const sides = Math.max(SIDES, Math.min(20, f.N + 3));
      // how far the bundle's (blocky) outline reaches in direction ang, in radii: the bark sits just outside it
      const reach = (ang) => {
        const c = Math.cos(ang), sn = Math.sin(ang), pad = Ly.cs / 2 * (Math.abs(c) + Math.abs(sn));
        let m = 0; for (let i = 0; i < f.n; i++) { const d = Ly.X[i] * c + Ly.Y[i] * sn; if (d > m) m = d; }
        return (m + pad) * 1.03;
      };
      const reachAt = []; for (let k = 0; k <= sides; k++) reachAt.push(reach(k / sides * Math.PI * 2));
      const at = (k, z) => {
        const ang = k / sides * Math.PI * 2;
        const r = (s.r0 + (s.r1 - s.r0) * Math.min(1, Math.max(0, z / L))) * reachAt[k], cx = Math.cos(ang) * r, sy = Math.sin(ang) * r;
        return [s.a[0] + ax[0] * z + u[0] * cx + v[0] * sy, s.a[1] + ax[1] * z + u[1] * cx + v[1] * sy, s.a[2] + ax[2] * z + u[2] * cx + v[2] * sy];
      };
      for (let k = 0; k < sides; k++) {
        const a0 = k / sides * Math.PI * 2, a1 = (k + 1) / sides * Math.PI * 2, am = (a0 + a1) / 2, cm = Math.cos(am), sm = Math.sin(am);
        let own = 0, best = -Infinity;
        for (let i = 0; i < f.n; i++) { const d = Ly.X[i] * cm + Ly.Y[i] * sm; if (d > best) { best = d; own = i; } }
        const lo = f.lo ? f.lo[own] : 0, hi = f.hi ? f.hi[own] : L;
        const spans = f.state[own] === CUT ? [[lo, f.zmin[own] - 0.008], [f.zmax[own] + 0.008, hi]] : [[lo, hi]];
        for (const [z0, z1] of spans) {
          if (z1 - z0 < 0.004) continue;
          const p00 = at(k, z0), p10 = at(k + 1, z0), p01 = at(k, z1), p11 = at(k + 1, z1);
          pos.push(...p00, ...p10, ...p11, ...p00, ...p11, ...p01);
        }
      }
      const shade = 0.85 + ((s.id * 37) % 10) / 60;
      for (let i = start; i < pos.length / 3; i++) col.push(0.42 * shade, 0.31 * shade, 0.22 * shade);
      barkSeg.push(s.id, start, pos.length / 3 - start);
      if (s.leaf > 0) {
        const r = 0.3 + s.leaf * 0.18;
        leafSeg.push(s.id, lpos.length / 3, ico.count);
        for (let i = 0; i < ico.count; i++) lpos.push(s.b[0] + ico.getX(i) * r, s.b[1] + ico.getY(i) * r * 0.8, s.b[2] + ico.getZ(i) * r);
      }
    }
    const set = (mesh, arr, colors) => {
      mesh.geometry.dispose();
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(arr, 3));
      if (colors) g.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
      g.computeVertexNormals(); g.computeBoundingSphere();
      mesh.geometry = g;
    };
    set(p.bark, pos, col); set(p.leaves, lpos, null);
    p.barkBase = Float32Array.from(pos); p.leafBase = Float32Array.from(lpos); p.barkSeg = barkSeg; p.leafSeg = leafSeg; p.bent = false;
    this.buildFibres(p, segs);
    p.bark.visible = CFG.BARK_OPACITY > 0.01; p.leaves.visible = CFG.LEAF_OPACITY > 0.01;
    this.lastAuxTick = -1; this.painted = false;
    return p;
  }

  // One box per fibre (two where the saw has parted it). Instances are grouped by segment.
  buildFibres(p, segs) {
    if (p.fibres) { p.group.remove(p.fibres); p.fibres.dispose(); }
    let cap = 0; for (const s of segs) cap += s.f.n + s.f.ncut;
    const mesh = new THREE.InstancedMesh(this.fibreGeo, this.fibreMat, Math.max(1, cap));
    mesh.frustumCulled = false;
    const info = [];              // per instance: [seg, fibre index]
    let k = 0;
    for (const s of segs) {
      const f = s.f, Ly = layout(f.N), L = segLen(s), ax = segAxis(s), { u, v } = bundleBasis(ax);
      // box Y runs along the grain. (v, axis, u) is right-handed; (u, axis, v) is a mirror and is NOT a rotation.
      _bx.set(v[0], v[1], v[2]); _by.set(ax[0], ax[1], ax[2]); _bz.set(u[0], u[1], u[2]);
      _m.makeBasis(_bx, _by, _bz); _q.setFromRotationMatrix(_m);
      const part = (i, z0, z1) => {
        if (z1 - z0 < 0.004) return;
        const zm = (z0 + z1) / 2, R = s.r0 + (s.r1 - s.r0) * Math.min(1, Math.max(0, zm / L)), h = 2 * R / f.N * 0.82;
        const x = Ly.X[i] * R, y = Ly.Y[i] * R;
        _v.set(s.a[0] + ax[0] * zm + u[0] * x + v[0] * y, s.a[1] + ax[1] * zm + u[1] * x + v[1] * y, s.a[2] + ax[2] * zm + u[2] * x + v[2] * y);
        // fibres converge with the stem's taper, exactly as the physics has them (base at X*r0, tip at X*r1)
        const k2 = (s.r1 - s.r0) / L, ox = Ly.X[i] * k2, oy = Ly.Y[i] * k2;
        _w.set(ax[0] + u[0] * ox + v[0] * oy, ax[1] + u[1] * ox + v[1] * oy, ax[2] + u[2] * ox + v[2] * oy);
        const stretch = _w.length(); _w.multiplyScalar(1 / stretch);
        _q2.setFromUnitVectors(_by, _w).multiply(_q);
        mesh.setMatrixAt(k, _m.compose(_v, _q2, _s.set(h, (z1 - z0) * stretch, h)));
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
    p.fibres = mesh; p.info = info; p.fibBase = Float32Array.from(mesh.instanceMatrix.array.subarray(0, k * 16));
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
            const sig = (aux.fs[o + 1] + aux.fs[o + 2] * Ly.X[i] * R + aux.fs[o + 3] * Ly.Y[i] * R) * 1e4;
            t = sig >= 0 ? sig / CFG.MOR : sig / CFG.COMP;
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

  /** Move a piece's bark, leaves and fibres to where its bent wood is. flex = a Flex, or null for unbent. */
  bendPiece(p, flex) {
    let any = false;
    const move = (base, seg, attr) => {
      const out = attr.array;
      for (let n = 0; n < seg.length; n += 3) {
        const fr = flex && flex.frame(seg[n]), i0 = seg[n + 1] * 3, i1 = i0 + seg[n + 2] * 3;
        if (!fr) { for (let i = i0; i < i1; i++) out[i] = base[i]; continue; }
        any = true;
        _q.set(fr.q[0], fr.q[1], fr.q[2], fr.q[3]);
        for (let i = i0; i < i1; i += 3) {
          _v.set(base[i], base[i + 1], base[i + 2]).applyQuaternion(_q);
          out[i] = _v.x + fr.t[0]; out[i + 1] = _v.y + fr.t[1]; out[i + 2] = _v.z + fr.t[2];
        }
      }
      attr.needsUpdate = true;
    };
    const bp = p.bark.geometry.getAttribute('position'), lp = p.leaves.geometry.getAttribute('position');
    if (bp) move(p.barkBase, p.barkSeg, bp);
    if (lp) move(p.leafBase, p.leafSeg, lp);
    const info = p.info, arr = p.fibres.instanceMatrix.array, base = p.fibBase;
    let last = null, fr = null;
    for (let k = 0; k < p.fibres.count; k++) {
      const s = info[k * 2];
      if (s !== last) { last = s; fr = flex && flex.frame(s.id); if (fr) { any = true; _mD.compose(_v.set(fr.t[0], fr.t[1], fr.t[2]), _q.set(fr.q[0], fr.q[1], fr.q[2], fr.q[3]), _s.set(1, 1, 1)); } }
      if (fr) { _m.fromArray(base, k * 16).premultiply(_mD).toArray(arr, k * 16); } else for (let i = k * 16; i < k * 16 + 16; i++) arr[i] = base[i];
    }
    p.fibres.instanceMatrix.needsUpdate = true;
    p.bent = any;
  }

  playerMesh(id) {
    let p = this.players.get(id);
    if (p) return p;
    const color = PLAYER_COLORS[(id - 1) % PLAYER_COLORS.length];
    const group = new THREE.Group();
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.26, 1.1, 2, 7), new THREE.MeshLambertMaterial({ color, flatShading: true }));
    const helmet = new THREE.Mesh(new THREE.SphereGeometry(0.2, 7, 5), new THREE.MeshLambertMaterial({ color: 0xf4f4f4, flatShading: true }));
    helmet.position.y = 0.78;
    body.castShadow = true;
    group.add(body, helmet);
    const saw = new THREE.Group();
    const eng = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.13, 0.1), new THREE.MeshLambertMaterial({ color: 0xe05a1a, flatShading: true }));
    // the planted point is the middle of the bar's leading edge; the powerhead hangs off the -X end
    const bar = new THREE.Mesh(new THREE.BoxGeometry(CFG.BAR_LEN, 0.012, 0.07), new THREE.MeshLambertMaterial({ color: 0xbbbbbb }));
    bar.position.z = -0.035; eng.position.set(-CFG.BAR_LEN / 2 - 0.1, 0, -0.06); saw.add(eng, bar); saw.visible = false;
    const lanyard = new THREE.Mesh(new THREE.BufferGeometry(), this.lanyardMat);
    lanyard.frustumCulled = false; lanyard.visible = false;
    this.scene.add(group, saw, lanyard);
    p = { group, saw, bar, lanyard };
    this.players.set(id, p);
    return p;
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
      this.flex.update(Math.min(dt, 0.05), (s) => { const o = at.get(s.id); return o === undefined ? null : [aux.fs[o + 2] * 1e4, aux.fs[o + 3] * 1e4]; });
      flex = this.flex;
    }
    this.flexNow = flex;
    for (const p of this.pieces.values()) this.bendPiece(p, flex);
    if (aux && CFG.SHOW_FIBRES && aux.tick !== this.lastAuxTick && (CFG.STRESS_COLORS || !this.painted)) { this.lastAuxTick = aux.tick; this.painted = true; this.paintFibres(aux); }
    const seen = new Set();
    let mePos = null;
    if (aux) for (const a of aux.pl) {
      seen.add(a.id);
      const pm = this.playerMesh(a.id), pose = src.pose(60000 + a.id);
      if (pose) pm.group.position.set(pose.p.x, pose.p.y, pose.p.z);
      pm.group.rotation.y = a.yaw;
      pm.group.rotation.z = a.inj === INJ.DOWN ? Math.PI / 2 : 0;
      pm.group.visible = a.id !== me;                 // first person: you do not see your own body
      if (a.id === me) mePos = pm.group.position;
      this.poseSaw(pm, a);
      this.poseLanyard(pm, a);
    }
    for (const [id, pm] of [...this.players]) if (!seen.has(id)) { this.scene.remove(pm.group, pm.saw, pm.lanyard); this.players.delete(id); }
    this.updateRope(aux);

    if (mePos) {                                      // first person
      this.camera.position.copy(mePos).addScaledVector(Y, CFG.EYE);
      this.camera.quaternion.setFromEuler(new THREE.Euler(inp.pitch, inp.yaw, 0, 'YXZ'));
    }
    this.renderer.render(this.scene, this.camera);
  }

  poseSaw(pm, a) {
    const sw = a.saw;                 // [planted point (3), bar direction (3), feed direction (3), stuck, cutting]
    pm.saw.visible = !!sw;
    if (!sw) return;
    // saw frame: X along the bar, Z = feed direction (the cutting edge leads), Y = normal of the cut
    _w.set(sw[3], sw[4], sw[5]); _bz.set(sw[6], sw[7], sw[8]); _by.crossVectors(_bz, _w).normalize();
    pm.saw.quaternion.setFromRotationMatrix(_m.makeBasis(_w, _by, _bz));
    pm.saw.position.set(sw[0], sw[1], sw[2]);
    pm.bar.material.color.setHex(sw[9] ? 0xff3030 : sw[10] ? 0xfff0a0 : 0xbbbbbb);
  }

  poseLanyard(pm, a) {
    const cl = a.m === MODE.CLIMB && a.cl, s = cl ? this.world.segs.get(cl[0]) : null, piece = s ? this.pieces.get(s.piece) : null;
    pm.lanyard.visible = !!piece;
    if (!piece) return;
    const fr = this.flexNow && this.flexNow.frame(s.id);
    const pts = lanyardLoop(s, cl[1], cl[2], CFG.STANDOFF).map((q) => { const b = frameApply(fr, q); return new THREE.Vector3(b[0], b[1], b[2]).applyQuaternion(piece.group.quaternion).add(piece.group.position); });
    pm.lanyard.geometry.dispose();
    pm.lanyard.geometry = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts, false, 'catmullrom', 0.3), 20, 0.012, 5);
  }

  nodeWorld(n, out) {
    const s = this.world.segs.get(n.seg), piece = s && this.pieces.get(s.piece);
    if (!piece) return null;
    const b = frameApply(this.flexNow && this.flexNow.frame(s.id), n.p);
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
        const t = i / n, v = new THREE.Vector3().lerpVectors(p, q, t); v.y = Math.max(0.03, v.y - sag * 4 * t * (1 - t));
        pts.push(v);
      }
    };
    const slack = aux && aux.rope ? Math.max(0, aux.rope.slack) : 0;
    if (hasA) span(A, B, Math.min(3, Math.sqrt(slack) * 0.6), 10, false); else pts.push(B.clone());
    span(B, D, 0, 4, true);
    const holder = aux && aux.rope && aux.rope.holder >= 0 ? this.players.get(aux.rope.holder) : null;
    if (holder) span(D, _w.copy(holder.group.position).addScaledVector(Y, 0.2), 0.15, 5, true);
    else span(D, _w.set(D.x + 0.5, 0.04, D.z + 0.3), 0, 3, true);
    this.ropeMesh.geometry.dispose();
    this.ropeMesh.geometry = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts, false, 'catmullrom', 0.05), pts.length * 2, CFG.ROPE_RADIUS, 6);
  }
}
