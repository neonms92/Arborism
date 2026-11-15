// Three.js view. Builds meshes from the world model, poses them from a
// transform source (the sim on the host, the interpolator on clients).
// No game rules in here. See docs/DESIGN.md 1.1.

import * as THREE from 'three';
import { segAxis, segLen, lerp3, segRadius } from '../model/world.js';
import { sectionBasis } from '../model/section.js';
import { TOOL, MODE, INJ } from '../config.js';

const SIDES = 7;
const PLAYER_COLORS = [0xe8a23a, 0x3a9be8, 0xd94f6a, 0x62c462, 0xb07be0, 0xe0d24a];
const Y = new THREE.Vector3(0, 1, 0);
const _v = new THREE.Vector3(), _w = new THREE.Vector3(), _q = new THREE.Quaternion();

export class View {
  constructor(canvas, world) {
    this.world = world;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(1);
    this.renderer.shadowMap.enabled = true;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x9fc4e0);
    this.scene.fog = new THREE.Fog(0x9fc4e0, 40, 140);
    this.camera = new THREE.PerspectiveCamera(60, 1, 0.1, 300);
    this.camDist = 3.6;

    this.scene.add(new THREE.HemisphereLight(0xdfeeff, 0x4a5a3a, 1.1));
    const sun = new THREE.DirectionalLight(0xfff2d8, 2.2);
    sun.position.set(14, 26, 10); sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);
    Object.assign(sun.shadow.camera, { left: -18, right: 18, top: 18, bottom: -18, near: 1, far: 70 });
    this.scene.add(sun);

    const ground = new THREE.Mesh(new THREE.CircleGeometry(150, 48).rotateX(-Math.PI / 2),
      new THREE.MeshLambertMaterial({ color: 0x5d8a48 }));
    ground.receiveShadow = true; this.scene.add(ground);

    this.barkMat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
    this.leafMat = new THREE.MeshLambertMaterial({ color: 0x3f7d3a, flatShading: true });
    this.kerfMat = new THREE.MeshBasicMaterial({ color: 0x1a1208, side: THREE.DoubleSide });
    this.pieces = new Map();      // piece id -> {group, bark, leaves, ranges}
    this.kerfs = new Map();       // section id -> Mesh
    this.players = new Map();     // player id -> {group, saw}
    this.overlay = false;
    this.util = new Map();

    // rope
    this.ropeLine = new THREE.Line(new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(new Float32Array(64 * 3), 3)),
      new THREE.LineBasicMaterial({ color: 0xf2e9d0 }));
    this.ropeLine.frustumCulled = false; this.scene.add(this.ropeLine);
    this.blockMesh = new THREE.Mesh(new THREE.OctahedronGeometry(0.12), new THREE.MeshLambertMaterial({ color: 0xf0c020, flatShading: true }));
    this.deviceMesh = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.35, 6), new THREE.MeshLambertMaterial({ color: 0xc03030, flatShading: true }));
    this.knotMesh = new THREE.Mesh(new THREE.OctahedronGeometry(0.08), new THREE.MeshLambertMaterial({ color: 0xf2e9d0, flatShading: true }));
    this.scene.add(this.blockMesh, this.deviceMesh, this.knotMesh);

    world.on((ev, info) => this.onEvent(ev, info));
    window.addEventListener('resize', () => this.resize()); this.resize();
  }

  resize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h; this.camera.updateProjectionMatrix();
  }

  // ---- model -> meshes ----
  onEvent(ev, info) {
    switch (ev.t) {
      case 'load':
        for (const id of [...this.pieces.keys()]) this.dropPiece(id);
        for (const id of this.world.pieces.keys()) this.buildPiece(id);
        for (const sec of this.world.sections.values()) this.buildKerfs(sec);
        break;
      case 'tree': this.buildPiece(ev.piece); break;
      case 'split': {
        if (!info.moved) break;
        const old = this.pieces.get(info.oldPiece);
        this.buildPiece(info.oldPiece);
        const np = this.buildPiece(ev.newPiece);
        if (old) { np.group.position.copy(old.group.position); np.group.quaternion.copy(old.group.quaternion); }
        for (const sec of this.world.sections.values()) if (this.kerfs.has(sec.id)) this.buildKerfs(sec);
        break;
      }
      case 'rmpiece': this.dropPiece(ev.piece); break;
      case 'kerf': { const sec = this.world.sections.get(ev.sec); if (sec) this.buildKerfs(sec); break; }
    }
  }

  dropPiece(id) {
    const p = this.pieces.get(id); if (!p) return;
    this.scene.remove(p.group);
    p.bark.geometry.dispose(); p.leaves.geometry.dispose();
    this.pieces.delete(id);
    for (const [sid, m] of [...this.kerfs]) if (!this.world.sections.has(sid)) { m.geometry.dispose(); this.kerfs.delete(sid); }
  }

  buildPiece(id) {
    let p = this.pieces.get(id);
    if (!p) {
      const group = new THREE.Group();
      const bark = new THREE.Mesh(new THREE.BufferGeometry(), this.barkMat);
      const leaves = new THREE.Mesh(new THREE.BufferGeometry(), this.leafMat);
      bark.castShadow = leaves.castShadow = true; bark.receiveShadow = true;
      group.add(bark, leaves); this.scene.add(group);
      p = { group, bark, leaves, ranges: new Map() };
      this.pieces.set(id, p);
    }
    const segs = this.world.segsOf(id);
    const pos = [], col = [], lpos = [];
    p.ranges.clear();
    const ico = new THREE.IcosahedronGeometry(1, 0).attributes.position;
    for (const s of segs) {
      const start = pos.length / 3;
      const ax = segAxis(s), { u, v } = sectionBasis(ax);
      const ring = (c, r) => {
        const out = [];
        for (let i = 0; i < SIDES; i++) {
          const a = i / SIDES * Math.PI * 2, cx = Math.cos(a) * r, sy = Math.sin(a) * r;
          out.push([c[0] + u[0] * cx + v[0] * sy, c[1] + u[1] * cx + v[1] * sy, c[2] + u[2] * cx + v[2] * sy]);
        }
        return out;
      };
      const ra = ring(s.a, s.r0), rb = ring(s.b, s.r1);
      for (let i = 0; i < SIDES; i++) {
        const j = (i + 1) % SIDES;
        pos.push(...ra[i], ...ra[j], ...rb[j], ...ra[i], ...rb[j], ...rb[i]);
        pos.push(...s.a, ...ra[j], ...ra[i], ...s.b, ...rb[i], ...rb[j]);     // caps
      }
      p.ranges.set(s.id, [start, pos.length / 3 - start]);
      const shade = 0.85 + ((s.id * 37) % 10) / 60;
      for (let i = start; i < pos.length / 3; i++) col.push(0.42 * shade, 0.31 * shade, 0.22 * shade);
      if (s.leaf > 0) {
        const r = 0.35 + s.leaf * 0.3;
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
    if (this.overlay) this.paintUtil();
    return p;
  }

  /** Dark fan in each kerf plane, slightly proud of the bark so it reads as a cut line. */
  buildKerfs(sec) {
    const s = this.world.segs.get(sec.seg); if (!s) return;
    const piece = this.pieces.get(s.piece); if (!piece) return;
    let mesh = this.kerfs.get(sec.id);
    if (!mesh) { mesh = new THREE.Mesh(new THREE.BufferGeometry(), this.kerfMat); this.kerfs.set(sec.id, mesh); }
    if (mesh.parent !== piece.group) piece.group.add(mesh);
    const ax = segAxis(s), { u, v } = sectionBasis(ax), C = lerp3(s.a, s.b, sec.at), R = sec.R * 1.04, pos = [];
    const P = (x, y, z) => [C[0] + u[0] * x + v[0] * y + ax[0] * z, C[1] + u[1] * x + v[1] * y + ax[1] * z, C[2] + u[2] * x + v[2] * y + ax[2] * z];
    for (const k of sec.kerfs) {
      if (!k || k.depth <= 0) continue;
      const ex = Math.cos(k.phi), ey = Math.sin(k.phi), tt = Math.tan(k.tilt);
      const beta = Math.acos(Math.max(-1, Math.min(1, (R - k.depth) / R)));
      const pt = (ang) => {
        const x = Math.cos(ang) * R, y = Math.sin(ang) * R;
        return P(x, y, k.z0 + (R - (x * ex + y * ey)) * tt);
      };
      const n = 10, mid = [];
      const m0 = pt(k.phi - beta), m1 = pt(k.phi + beta);
      mid.push((m0[0] + m1[0]) / 2, (m0[1] + m1[1]) / 2, (m0[2] + m1[2]) / 2);
      for (let i = 0; i < n; i++) {
        pos.push(...mid, ...pt(k.phi - beta + 2 * beta * i / n), ...pt(k.phi - beta + 2 * beta * (i + 1) / n));
      }
    }
    mesh.geometry.dispose();
    mesh.geometry = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  }

  setOverlay(on) { this.overlay = on; this.paintUtil(); }
  /** Stress overlay: green -> yellow -> red by utilisation. */
  paintUtil() {
    for (const [id, p] of this.pieces) {
      const attr = p.bark.geometry.getAttribute('color'); if (!attr) continue;
      for (const [sid, [start, count]] of p.ranges) {
        let r, g, b;
        const u = this.util.get(sid);
        if (this.overlay && u !== undefined) {
          const x = Math.min(1, u);
          r = Math.min(1, x * 2); g = Math.min(1, 2 - x * 2) * 0.85; b = 0.1;
        } else { const sh = 0.85 + ((sid * 37) % 10) / 60; r = 0.42 * sh; g = 0.31 * sh; b = 0.22 * sh; }
        for (let i = start; i < start + count; i++) attr.setXYZ(i, r, g, b);
      }
      attr.needsUpdate = true;
    }
  }

  playerMesh(id) {
    let p = this.players.get(id);
    if (p) return p;
    const color = PLAYER_COLORS[(id - 1) % PLAYER_COLORS.length];
    const group = new THREE.Group();
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.26, 1.1, 2, 7), new THREE.MeshLambertMaterial({ color, flatShading: true }));
    const helmet = new THREE.Mesh(new THREE.SphereGeometry(0.2, 7, 5), new THREE.MeshLambertMaterial({ color: 0xf4f4f4, flatShading: true }));
    helmet.position.y = 0.78;
    const belt = new THREE.Mesh(new THREE.TorusGeometry(0.29, 0.05, 4, 8).rotateX(Math.PI / 2), new THREE.MeshLambertMaterial({ color: 0x333333 }));
    belt.position.y = 0.05;
    body.castShadow = true;
    group.add(body, helmet, belt);
    const saw = new THREE.Group();
    const eng = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.22, 0.2), new THREE.MeshLambertMaterial({ color: 0xe05a1a, flatShading: true }));
    const bar = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.012, 0.09), new THREE.MeshLambertMaterial({ color: 0xbbbbbb }));
    eng.position.x = -0.5; saw.add(eng, bar); saw.visible = false;
    this.scene.add(group, saw);
    p = { group, saw, bar, belt, body };
    this.players.set(id, p);
    return p;
  }

  /**
   * src.pose(id) -> {p, q} | null.  aux = latest aux packet (or null).
   * me = local player id. inp = local InputState (for the camera).
   */
  update(dt, src, aux, me, inp) {
    for (const [id, p] of this.pieces) {
      const pose = src.pose(id);
      if (pose) { p.group.position.set(pose.p.x, pose.p.y, pose.p.z); p.group.quaternion.set(pose.q.x, pose.q.y, pose.q.z, pose.q.w); }
    }
    const seen = new Set();
    let mePos = null, precise = false;
    if (aux) for (const a of aux.pl) {
      seen.add(a.id);
      const pm = this.playerMesh(a.id), pose = src.pose(60000 + a.id);
      if (pose) pm.group.position.set(pose.p.x, pose.p.y, pose.p.z);
      pm.group.rotation.y = a.id === me ? inp.yaw : a.yaw;
      pm.group.rotation.z = a.inj === INJ.DOWN ? Math.PI / 2 : 0;
      pm.belt.material.color.setHex(a.lan ? 0xffe020 : 0x333333);
      if (a.id === me) { mePos = pm.group.position; precise = !!a.saw; }
      this.poseSaw(pm, a);
    }
    for (const [id, pm] of [...this.players]) if (!seen.has(id)) { this.scene.remove(pm.group, pm.saw); this.players.delete(id); }
    this.updateRope(aux);

    // camera: third person over the shoulder; closer in precision mode
    if (mePos) {
      const want = precise ? 2.1 : 3.6;
      this.camDist += (want - this.camDist) * Math.min(1, dt * 8);
      const cp = Math.cos(inp.pitch);
      const fwd = _v.set(-Math.sin(inp.yaw) * cp, Math.sin(inp.pitch), -Math.cos(inp.yaw) * cp);
      const right = _w.set(Math.cos(inp.yaw), 0, -Math.sin(inp.yaw));
      this.camera.position.copy(mePos).addScaledVector(Y, 0.75).addScaledVector(fwd, -this.camDist).addScaledVector(right, 0.55);
      if (this.camera.position.y < 0.15) this.camera.position.y = 0.15;
      this.camera.quaternion.setFromEuler(new THREE.Euler(inp.pitch, inp.yaw, 0, 'YXZ'));
      inp.o = [this.camera.position.x, this.camera.position.y, this.camera.position.z];
      inp.d = [fwd.x, fwd.y, fwd.z];
    }
    this.renderer.render(this.scene, this.camera);
  }

  poseSaw(pm, a) {
    const sw = a.saw, s = sw ? this.world.segs.get(sw[0]) : null, piece = s ? this.pieces.get(s.piece) : null;
    pm.saw.visible = !!piece;
    if (!piece) return;
    const [, at, z0, phi, tilt, depth, stuck] = sw;
    const ax = segAxis(s), { u, v } = sectionBasis(ax), C = lerp3(s.a, s.b, at), R = segRadius(s, at);
    const e = [Math.cos(phi) * u[0] + Math.sin(phi) * v[0], Math.cos(phi) * u[1] + Math.sin(phi) * v[1], Math.cos(phi) * u[2] + Math.sin(phi) * v[2]];
    const tan = [ax[1] * e[2] - ax[2] * e[1], ax[2] * e[0] - ax[0] * e[2], ax[0] * e[1] - ax[1] * e[0]];   // bar length direction
    const x = Math.max(0, depth);                       // inward distance of the bar's cutting edge
    const tt = Math.tan(tilt), off = R - x + 0.045;     // bar centre sits half a bar-width behind the edge
    const loc = new THREE.Vector3(
      C[0] + e[0] * off + ax[0] * (z0 + (x - 0.045) * tt), C[1] + e[1] * off + ax[1] * (z0 + (x - 0.045) * tt), C[2] + e[2] * off + ax[2] * (z0 + (x - 0.045) * tt));
    // bar frame: X along the bar (tan), Z = feed direction in the cut plane, Y = plane normal
    const feed = new THREE.Vector3(-e[0] + ax[0] * tt, -e[1] + ax[1] * tt, -e[2] + ax[2] * tt).normalize();
    const X = new THREE.Vector3(tan[0], tan[1], tan[2]), Yv = new THREE.Vector3().crossVectors(feed, X).normalize();
    const m = new THREE.Matrix4().makeBasis(X, Yv, feed);
    pm.saw.quaternion.setFromRotationMatrix(m).premultiply(piece.group.quaternion);
    pm.saw.position.copy(loc).applyQuaternion(piece.group.quaternion).add(piece.group.position);
    pm.bar.material.color.setHex(stuck ? 0xff3030 : 0xbbbbbb);
  }

  nodeWorld(n, out) {
    const s = this.world.segs.get(n.seg), piece = s && this.pieces.get(s.piece);
    if (!piece) return null;
    return out.set(n.p[0], n.p[1], n.p[2]).applyQuaternion(piece.group.quaternion).add(piece.group.position);
  }

  updateRope(aux) {
    const r = this.world.rope, st = r.state || 0;
    const A = new THREE.Vector3(), B = new THREE.Vector3(), D = new THREE.Vector3();
    const hasB = st >= 1 && this.nodeWorld(r.block, B), hasD = st >= 1 && this.nodeWorld(r.device, D), hasA = st >= 2 && this.nodeWorld(r.anchor, A);
    this.blockMesh.visible = !!hasB; this.deviceMesh.visible = !!hasD; this.knotMesh.visible = !!hasA;
    this.ropeLine.visible = !!(hasB && hasD);
    if (!hasB || !hasD) return;
    this.blockMesh.position.copy(B); this.deviceMesh.position.copy(D); if (hasA) this.knotMesh.position.copy(A);
    const pts = [];
    const span = (p, q, sag, n) => {
      for (let i = 0; i <= n; i++) {
        const t = i / n; _v.lerpVectors(p, q, t); _v.y -= sag * 4 * t * (1 - t);
        pts.push(_v.x, Math.max(0.03, _v.y), _v.z);
      }
    };
    const slack = aux && aux.rope ? Math.max(0, aux.rope.slack) : 0;
    if (hasA) span(A, B, Math.min(3, Math.sqrt(slack) * 0.6), 12); else pts.push(B.x, B.y, B.z);
    span(B, D, 0, 2);
    const holder = aux && aux.rope && aux.rope.holder >= 0 ? this.players.get(aux.rope.holder) : null;
    if (holder) span(D, _w.copy(holder.group.position).addScaledVector(Y, 0.2), 0.15, 6);
    else { _w.copy(D); _w.y = 0.05; _w.x += 0.4; span(D, _w, 0, 2); }
    const attr = this.ropeLine.geometry.getAttribute('position');
    const n = Math.min(64, pts.length / 3);
    for (let i = 0; i < n * 3; i++) attr.array[i] = pts[i];
    attr.needsUpdate = true; this.ropeLine.geometry.setDrawRange(0, n);
  }
}
