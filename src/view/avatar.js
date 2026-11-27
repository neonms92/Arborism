// A player's body as drawn: in the game (view.js), on the start screen and in the sticker dialog (stage.js).
// Drawn round the physics capsule (P_HALF + P_RADIUS = 0.88 m from its centre to each end): a short tube torso
// in the shirt colour, a round head, the white helmet with its headlamp, and a face of two flat eyes. A name
// tag on the chest, the name again across the back of the helmet, and the player's stickers on the helmet.
// The group's origin is the capsule's centre; the player faces -z.
// G.O.E., the groundbot (sim/goe.js), is built of gray boxes instead, with a box head under the same hard hat
// and two square yellow eyes that never blink.

import * as THREE from 'three';
import { CFG } from '../config.js';
import { stickerTexture } from './stickers.js';

export const HEAD_R = 0.19, HEAD_Y = 0.56;   // m: the head on the player capsule (centre above the body centre)
export const HELMET_R = 0.205, HELMET_Y = HEAD_Y + 0.025, HELMET_PHI = 1.3;   // the helmet: a cap of a sphere, HELMET_PHI rad down from the top
export const PLAYER_COLORS = [0xe8a23a, 0x3a9be8, 0xd94f6a, 0x62c462, 0xb07be0, 0xe0d24a];   // shirts for players who picked none
const _v = new THREE.Vector3();

let helmetGeo = null, probe = null;
const ray = new THREE.Raycaster();

export class Avatar {
  /** bot: G.O.E.'s boxes and eyes. */
  constructor(bot = false) {
    const group = this.group = new THREE.Group();
    this.bot = bot;
    const shirt = this.shirt = new THREE.MeshLambertMaterial({ color: 0xe8a23a, flatShading: true });
    let body, head;
    if (bot) {
      // boxes: legs from the feet (-0.86) up, a torso to the shoulders, arms at its sides, a neck and a box head
      // small enough for its corners to stay under the hard hat
      body = new THREE.Group();
      const box = (w, h, d, x, y, z, m = shirt) => { const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m); b.position.set(x, y, z); b.castShadow = true; body.add(b); return b; };
      const dark = new THREE.MeshLambertMaterial({ color: 0x5d6064, flatShading: true });
      box(0.17, 0.56, 0.2, 0.11, -0.58, 0, dark); box(0.17, 0.56, 0.2, -0.11, -0.58, 0, dark);
      box(0.48, 0.62, 0.3, 0, -0.0, 0);
      box(0.12, 0.56, 0.14, 0.31, 0.02, 0, dark); box(0.12, 0.56, 0.14, -0.31, 0.02, 0, dark);
      box(0.1, 0.1, 0.1, 0, 0.35, 0, dark);
      head = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.26, 0.26), new THREE.MeshLambertMaterial({ color: 0xa4a7aa, flatShading: true }));
      head.position.y = HEAD_Y - 0.03;
    } else {
      body = new THREE.Mesh(new THREE.CapsuleGeometry(0.26, 0.7, 2, 9), shirt);
      body.position.y = -0.25;                        // feet at -0.86, shoulders at 0.36
      head = new THREE.Mesh(new THREE.SphereGeometry(HEAD_R, 12, 9), new THREE.MeshLambertMaterial({ color: 0xe9c29a, flatShading: true }));
      head.position.y = HEAD_Y;
    }
    const helmetMat = new THREE.MeshLambertMaterial({ color: 0xf4f4f4, flatShading: true });
    const helmet = this.helmet = new THREE.Mesh(helmetGeo || (helmetGeo = new THREE.SphereGeometry(HELMET_R, 10, 5, 0, 2 * Math.PI, 0, HELMET_PHI)), helmetMat);
    helmet.position.y = HELMET_Y;
    const brim = new THREE.Mesh(new THREE.CylinderGeometry(0.235, 0.235, 0.012, 12), helmetMat);
    brim.position.y = HELMET_Y + HELMET_R * Math.cos(HELMET_PHI) + 0.004;
    body.castShadow = head.castShadow = helmet.castShadow = true;
    this.lampMat = new THREE.MeshBasicMaterial({ color: 0x555555 });
    const lampBox = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.06, 0.05), this.lampMat);
    lampBox.position.set(0, HEAD_Y + 0.13, -0.175);
    group.add(body, head, helmet, brim, lampBox);
    // eyes: one drawing of the viewer's-left eye; the other eye shows it mirrored (its UVs flipped)
    const eyeCv = this.eyeCv = document.createElement('canvas'); eyeCv.width = eyeCv.height = 64;
    const eyeTex = this.eyeTex = new THREE.CanvasTexture(eyeCv); eyeTex.colorSpace = THREE.SRGBColorSpace;
    const eyeMat = new THREE.MeshLambertMaterial({ map: eyeTex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 });
    const eyeGeo = new THREE.PlaneGeometry(0.085, 0.085), eyeGeoM = eyeGeo.clone(), uv = eyeGeoM.attributes.uv;
    for (let i = 0; i < uv.count; i++) uv.setX(i, 1 - uv.getX(i));
    if (bot) {                                      // square, yellow, lit from inside: they do not change
      const m = new THREE.MeshBasicMaterial({ color: 0xffd21a });
      for (const x of [0.06, -0.06]) {
        const eye = new THREE.Mesh(new THREE.PlaneGeometry(0.06, 0.06), m);
        eye.position.set(x, HEAD_Y - 0.01, -0.133); eye.rotation.y = Math.PI;
        group.add(eye);
      }
    }
    for (const side of bot ? [] : [1, -1]) {                   // +x is the viewer's left when the player faces you (-z is their front)
      const az = 0.36 * side, el = 0.1, d = new THREE.Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el));
      const eye = new THREE.Mesh(side > 0 ? eyeGeo : eyeGeoM, eyeMat);
      eye.position.set(0, HEAD_Y, 0).addScaledVector(d, HEAD_R + 0.004);
      eye.lookAt(_v.set(0, HEAD_Y, 0).addScaledVector(d, 2));   // the group is still at the origin here
      group.add(eye);
    }
    // name tag on the chest (a strip of the torso's own tube) and the name across the back of the helmet
    const tagCv = this.tagCv = document.createElement('canvas'); tagCv.width = 256; tagCv.height = 80;
    const tagTex = this.tagTex = new THREE.CanvasTexture(tagCv); tagTex.colorSpace = THREE.SRGBColorSpace; tagTex.anisotropy = 4;
    // over the left breast pocket: upper chest, off to the wearer's left (-x; they face -z)
    const tagW = 0.15, tagAt = Math.PI + 0.5, tagMat = new THREE.MeshLambertMaterial({ map: tagTex, polygonOffset: true, polygonOffsetFactor: -2 });
    const tag = bot ? new THREE.Mesh(new THREE.PlaneGeometry(tagW, 0.047), tagMat)
      : new THREE.Mesh(new THREE.CylinderGeometry(0.263, 0.263, 0.047, 4, 1, true, tagAt - tagW / 0.263 / 2, tagW / 0.263), tagMat);
    tag.position.y = 0.02 + 1.25 * 0.047;            // raised 1.25 tag heights (owner)
    if (bot) { tag.position.set(-0.12, 0.16, -0.152); tag.rotation.y = Math.PI; }   // flat on the box chest, the wearer's left
    const backCv = this.backCv = document.createElement('canvas'); backCv.width = 256; backCv.height = 64;
    const backTex = this.backTex = new THREE.CanvasTexture(backCv); backTex.colorSpace = THREE.SRGBColorSpace; backTex.anisotropy = 4;
    const back = new THREE.Mesh(new THREE.SphereGeometry(0.207, 10, 3, Math.PI / 2 - 0.75, 1.5, 0.72, 0.5),
      new THREE.MeshLambertMaterial({ map: backTex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 }));
    back.position.y = HELMET_Y;
    group.add(tag, back);
    this.stickers = new THREE.Group(); group.add(this.stickers);
    this.eyeState = ''; this.blinkT = 1 + Math.random() * CFG.BLINK_GAP; this.lookKey = ''; this.stKey = '';
  }

  /** Shirt colour and name, redrawn only when they change. */
  setLook(name, c) {
    const key = name + '|' + c;
    if (key === this.lookKey) return false;
    this.lookKey = key;
    this.shirt.color.setHex(c);
    const fit = (g, text, max, wMax) => { let f = max; do { g.font = `700 ${f}px system-ui, sans-serif`; f -= 2; } while (f > 10 && g.measureText(text).width > wMax); };
    let g = this.tagCv.getContext('2d');
    g.fillStyle = '#f7f7f2'; g.fillRect(0, 0, 256, 80);
    g.fillStyle = '#c33'; g.fillRect(0, 0, 256, 14);                    // "HELLO my name is" stripe
    g.fillStyle = '#1b1b1b'; g.textAlign = 'center'; g.textBaseline = 'middle';
    fit(g, name, 44, 236); g.fillText(name, 128, 48);
    this.tagTex.needsUpdate = true;
    g = this.backCv.getContext('2d'); g.clearRect(0, 0, 256, 64);
    g.fillStyle = '#222'; g.textAlign = 'center'; g.textBaseline = 'middle';
    fit(g, name, 40, 240); g.fillText(name, 128, 34);
    this.backTex.needsUpdate = true;
    return true;
  }

  /** The eyes: 'open', 'blink', 'wince', 'worry' or 'x'. tick(dt) says whether a blink is due. */
  blinking(dt) {
    this.blinkT -= dt;
    if (this.blinkT < -0.13) this.blinkT = CFG.BLINK_GAP * (0.4 + 1.2 * Math.random());
    return this.blinkT < 0;
  }
  blinkNow() { this.blinkT = 0; }
  setEyes(st) {
    if (this.bot || st === this.eyeState) return;
    this.eyeState = st;
    const g = this.eyeCv.getContext('2d');
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
    this.eyeTex.needsUpdate = true;
  }

  /** The stickers on the helmet: [[kind, tier, a, e, r], ...] (model/stickers.js), rebuilt only when they change. */
  setStickers(list) {
    const key = JSON.stringify(list || []);
    if (key === this.stKey) return;
    this.stKey = key;
    for (const m of this.stickers.children) m.geometry.dispose();
    this.stickers.clear();
    (list || []).forEach((s, i) => this.stickers.add(stickerMesh(s[0], s[1], s[2], s[3], s[4], i)));
  }
}

/** Unit direction from the helmet's centre for azimuth a, elevation e (helmet-local; a = 0 is the front, -z). */
export function stickerDir(a, e) { return new THREE.Vector3(Math.sin(a) * Math.cos(e), Math.sin(e), -Math.cos(a) * Math.cos(e)); }
/** The sticker's upright at d before its roll: toward the top of the helmet (at the very top, toward the front). */
export function northAt(d) {
  const n = new THREE.Vector3(0, 1, 0).addScaledVector(d, -d.y);
  return n.lengthSq() < 1e-6 ? new THREE.Vector3(0, 0, -1) : n.normalize();
}
/** The roll that turns northAt(d) to the tangent direction nearest `up`. */
export function rollFor(d, up) {
  const n = northAt(d), e = new THREE.Vector3().crossVectors(n, d);
  return Math.atan2(up.dot(e), up.dot(n));
}

/**
 * A sticker's mesh, helmet-local (in the avatar group): a patch of STICKER_SIZE pressed onto the faceted
 * helmet (each point found by a ray toward the helmet's centre), lifted a hair, the i-th a little higher so
 * later stickers lie over earlier ones. shadow: its black silhouette, for the dialog's preview.
 */
export function stickerMesh(k, t, a, e, r, i = 0, shadow = false) {
  const geo = stickerGeometry(a, e, r, shadow ? 0.006 : 0.0012 + Math.min(i, 40) * 0.0001);
  const mat = new THREE.MeshLambertMaterial({ map: stickerTexture(k, t, shadow), transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 });
  if (shadow) mat.opacity = 0.45;
  const m = new THREE.Mesh(geo, mat);
  m.renderOrder = shadow ? 100 : 2 + i;
  return m;
}

const N = 8;
export function stickerGeometry(a, e, r, lift) {
  if (!probe) { probe = new THREE.Mesh(helmetGeo || (helmetGeo = new THREE.SphereGeometry(HELMET_R, 10, 5, 0, 2 * Math.PI, 0, HELMET_PHI)), new THREE.MeshBasicMaterial()); probe.updateMatrixWorld(); }
  const d = stickerDir(a, e), n = northAt(d), east = new THREE.Vector3().crossVectors(n, d);
  const up = n.clone().multiplyScalar(Math.cos(r)).addScaledVector(east, Math.sin(r));
  const right = new THREE.Vector3().crossVectors(up, d);
  const S = CFG.STICKER_SIZE, pos = [], uvs = [], idx = [];
  const p = new THREE.Vector3(), dir = new THREE.Vector3(), o = new THREE.Vector3();
  for (let j = 0; j <= N; j++) for (let i = 0; i <= N; i++) {
    const u = i / N, v = j / N;
    p.copy(d).multiplyScalar(HELMET_R).addScaledVector(right, (u - 0.5) * S).addScaledVector(up, (v - 0.5) * S);
    dir.copy(p).normalize();
    o.copy(dir).multiplyScalar(0.5);
    ray.set(o, dir.clone().negate());
    const hit = ray.intersectObject(probe, false)[0];
    const q = hit ? hit.point : dir.clone().multiplyScalar(HELMET_R);   // off the bottom edge: on the helmet's sphere (over the brim)
    q.addScaledVector(dir, lift);
    pos.push(q.x, q.y + HELMET_Y, q.z); uvs.push(u, v);
  }
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const k = j * (N + 1) + i;
    idx.push(k, k + 1, k + N + 2, k, k + N + 2, k + N + 1);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.setIndex(idx); g.computeVertexNormals();
  return g;
}
