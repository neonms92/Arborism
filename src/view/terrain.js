// Draws the ground (model/terrain.js): one mesh over the same grid and the
// same two triangles per cell as the heightfield collider, so what is drawn
// is what things stand on. Grass on gentle ground, bare earth on steep
// slopes and ledge faces. Flat ground (world.terrain null) is a plain disc.

import * as THREE from 'three';

const GRASS = [0.36, 0.54, 0.28], GRASS2 = [0.42, 0.58, 0.3], EARTH = [0.45, 0.36, 0.25];
const STEEP0 = 0.45, STEEP1 = 0.75;         // rad: grass gives way to earth between these slopes

export class TerrainView {
  constructor(scene, world) {
    this.scene = scene; this.world = world;
    this.mat = new THREE.MeshLambertMaterial({ vertexColors: true });
    this.flatMat = new THREE.MeshLambertMaterial({ color: 0x5d8a48 });
    this.mesh = null;
    this.build();
  }

  onEvent(ev) { if (ev.t === 'terrain' || ev.t === 'load') this.build(); }

  build() {
    if (this.mesh) { this.scene.remove(this.mesh); this.mesh.geometry.dispose(); }
    const t = this.world.terrain;
    this.mesh = t ? new THREE.Mesh(gridGeo(t), this.mat) : new THREE.Mesh(new THREE.CircleGeometry(150, 48).rotateX(-Math.PI / 2), this.flatMat);
    this.mesh.receiveShadow = true;
    this.scene.add(this.mesh);
  }
}

function gridGeo(t) {
  const n = t.n, c = t.cell, h0 = -t.half, N = n + 1;
  const pos = new Float32Array(N * N * 3), col = new Float32Array(N * N * 3), idx = new Uint32Array(n * n * 6);
  for (let i = 0; i <= n; i++) for (let j = 0; j <= n; j++) {
    const k = (i * N + j) * 3, x = h0 + j * c, z = h0 + i * c;
    pos[k] = x; pos[k + 1] = t.at(i, j); pos[k + 2] = z;
    // steepness from the neighbouring heights (central differences)
    const dx = (t.at(i, j + 1) - t.at(i, j - 1)) / (2 * c), dz = (t.at(i + 1, j) - t.at(i - 1, j)) / (2 * c);
    const s = Math.atan(Math.hypot(dx, dz)), e = Math.min(1, Math.max(0, (s - STEEP0) / (STEEP1 - STEEP0)));
    const v = (Math.imul(i * 7919 + 13, j * 104729 + 7) >>> 0) / 4294967296, g = v * 0.6;   // a little speckle in the grass
    for (let a = 0; a < 3; a++) col[k + a] = (GRASS[a] + (GRASS2[a] - GRASS[a]) * g) * (1 - e) + EARTH[a] * e;
  }
  let w = 0;
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    const a = i * N + j, b = a + 1, d = a + N, e = d + 1;      // a (x0,z0), b (x1,z0), d (x0,z1), e (x1,z1)
    // the collider's split: (a, b, d) and (e, d, b), wound counter-clockwise seen from above
    idx[w++] = a; idx[w++] = d; idx[w++] = b;
    idx[w++] = e; idx[w++] = b; idx[w++] = d;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  g.computeVertexNormals();
  g.computeBoundingSphere();
  return g;
}
