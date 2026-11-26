// The other trees in the yards while they are dormant (model/stands.js): every machine grows each one's skeleton
// from its numbers and draws its bark and foliage from bundles made just for drawing, exactly as the wood will be
// once it comes to life. All dormant trees are one bark mesh and one foliage mesh (two draw calls); they never
// move or bend. A tree that comes to life leaves these meshes and is drawn as an ordinary piece (view.js).

import * as THREE from 'three';
import { makeBundle } from '../model/fibres.js';
import { standSegs } from '../model/stands.js';
import { woodInto } from './wood.js';

export class StandsView {
  constructor(scene, world, leafMat) {
    this.world = world;
    this.cache = new Map();       // stand index -> {pos, col, lpos} (cleared with a new set of stands)
    // its own bark, always opaque: a dormant tree has no fibres to show when the menu fades the bark out
    this.bark = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true, side: THREE.DoubleSide }));
    this.leaves = new THREE.Mesh(new THREE.BufferGeometry(), leafMat);
    this.bark.castShadow = this.leaves.castShadow = true; this.bark.receiveShadow = true;
    scene.add(this.bark, this.leaves);
  }

  onEvent(ev) {
    if (ev.t === 'stands' || ev.t === 'prune' || ev.t === 'reset' || ev.t === 'load') { this.cache.clear(); this.rebuild(); }
    else if (ev.t === 'tree' && ev.stand !== undefined) this.rebuild();
  }

  rebuild() {
    const st = this.world.stands, pos = [], col = [], lpos = [];
    if (st) st.list.forEach((s, i) => {
      if (s.piece) return;
      let g = this.cache.get(i);
      if (!g) {
        let n = 0;
        const segs = standSegs(st, s, () => ++n);
        for (const sg of segs) sg.f = makeBundle(sg.N);
        const w = woodInto(segs);
        this.cache.set(i, g = { pos: w.pos, col: w.col, lpos: w.lpos });
      }
      for (const v of g.pos) pos.push(v);
      for (const v of g.col) col.push(v);
      for (const v of g.lpos) lpos.push(v);
    });
    const set = (mesh, arr, colors) => {
      mesh.geometry.dispose();
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(arr, 3));
      if (colors) geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
      geo.computeVertexNormals(); geo.computeBoundingSphere();
      mesh.geometry = geo;
    };
    set(this.bark, pos, col); set(this.leaves, lpos, null);
  }
}
