// The sky: a sun and a moon crossing it, the moon's phases, stars, and the
// light they give. Drawing only (DESIGN.md 1.1). The host keeps the clock
// (sim.days, sent in aux as sky: [days, s per day]); a client runs its own
// copy between packets and eases it onto the host's. With no aux (the lobby
// behind the main menu) the view keeps its own clock.
//
// Time: days counts from the first midnight. Its fraction is the time of day:
// 0 midnight, 0.25 sunrise, 0.5 noon, 0.75 sunset. The sun rises in the east
// (+x), crosses the sky leaning to the south (+z) and sets in the west; the
// moon is always opposite it, so it rises at sunset and sets at sunrise.
//
// Phases: the moon changes phase each noon and goes round CFG.MOON_DAYS of
// them from full to new and back. lit = the fraction of its face in sunlight
// (1 full, 0 new). Moonlight and the night sky's glow scale with lit, so a
// full moon lights the yard and a new moon leaves it to the headlamps.
//
// Background and fog share one colour (view.js adaptDraw): the fog has to be
// the sky's colour or fogged ground shows a seam against it.

import * as THREE from 'three';
import { CFG } from '../config.js';

const TILT = 0.45;                        // rad the sun's path leans south of overhead
const AXIS = new THREE.Vector3(0, Math.sin(TILT), -Math.cos(TILT)).normalize();   // the sky turns about this (towards the pole)
const DAY = new THREE.Color(0x9fc4e0), DUSK = new THREE.Color(0xe39a72), NIGHT = new THREE.Color(0x070b16), MOONLIT = new THREE.Color(0x1d2a46);
const HEMI_DAY = new THREE.Color(0xdfeeff), HEMI_NIGHT = new THREE.Color(0x8ea4d8), GROUND_DAY = new THREE.Color(0x4a5a3a), GROUND_NIGHT = new THREE.Color(0x1a1f24);
const SUN_HIGH = new THREE.Color(0xfff2d8), SUN_LOW = new THREE.Color(0xffa25e), MOON_COL = new THREE.Color(0xb4c8ff);
const _c = new THREE.Color();
const EAST = new THREE.Vector3(1, 0, 0), UP_S = new THREE.Vector3(0, Math.cos(TILT), Math.sin(TILT));   // sunrise, and noon

export const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

/** Phase of the moon on the night around `days`: { k: index 0..n-1 (0 = full), lit: fraction of its face lit }. */
export function moonPhase(days, n = CFG.MOON_DAYS) {
  n = Math.max(1, Math.round(n));
  const k = ((Math.floor(days + 0.5) % n) + n) % n;      // changes at noon, never during a night
  return { k, age: k / n, lit: (1 + Math.cos(2 * Math.PI * k / n)) / 2 };
}

/** Unit direction to the sun at `days` (out = THREE.Vector3). */
export function sunDir(days, out) {
  const a = 2 * Math.PI * (days - 0.25);                 // 0 at sunrise, pi/2 at noon
  return out.copy(EAST).multiplyScalar(Math.cos(a)).addScaledVector(UP_S, Math.sin(a));
}

export class Sky {
  constructor(scene, hemi, key) {
    this.scene = scene; this.hemi = hemi; this.key = key;
    this.days = CFG.DAY_START; this.synced = false;
    this.sun = new THREE.Vector3(); this.moon = new THREE.Vector3();
    this.sunUp = 1; this.lamps = 0; this.phase = moonPhase(this.days);

    const disc = (tex, size) => {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(size, size), new THREE.MeshBasicMaterial({ map: tex, transparent: true, fog: false, depthWrite: false }));
      m.frustumCulled = false; scene.add(m); return m;
    };
    this.sunMesh = disc(glowTexture(), 1);
    this.moonCanvas = document.createElement('canvas'); this.moonCanvas.width = this.moonCanvas.height = 128;
    this.moonTex = new THREE.CanvasTexture(this.moonCanvas); this.moonTex.colorSpace = THREE.SRGBColorSpace;
    this.moonMesh = disc(this.moonTex, 1);
    this.drawnPhase = -1;

    // stars: fixed points on the sky sphere, turning with it
    const n = 900, pos = new Float32Array(n * 3), col = new Float32Array(n * 3);
    let seed = 12345; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < n; i++) {
      const z = rnd() * 2 - 1, t = rnd() * Math.PI * 2, r = Math.sqrt(1 - z * z), b = 0.35 + 0.65 * rnd() ** 3;
      pos.set([r * Math.cos(t), z, r * Math.sin(t)], i * 3);
      const warm = rnd();
      col.set([b * (0.85 + 0.15 * warm), b * 0.9, b * (1 - 0.15 * warm)], i * 3);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    this.starMat = new THREE.PointsMaterial({ size: 2, sizeAttenuation: false, vertexColors: true, transparent: true, fog: false, depthWrite: false });
    this.stars = new THREE.Points(g, this.starMat); this.stars.frustumCulled = false; scene.add(this.stars);
  }

  /** Advance the clock and set every light and colour. cam: the camera (its far plane is the draw distance). */
  update(dt, aux, cam) {
    const len = aux && aux.sky ? aux.sky[1] : CFG.DAY_LENGTH;
    if (len > 0) this.days += dt / len;
    if (aux && aux.sky) {                                  // ease onto the host's clock; jump if it is far off (a skip)
      const d = aux.sky[0] - this.days;
      if (!this.synced || Math.abs(d) > 0.005) this.days = aux.sky[0]; else this.days += d * Math.min(1, dt * 2);
      this.synced = true;
    }
    const days = this.days;
    sunDir(days, this.sun); this.moon.copy(this.sun).negate();
    this.phase = moonPhase(days);
    const lit = this.phase.lit, s = this.sun.y, m = this.moon.y;

    // how much of each is above the horizon, softly
    const day = smooth(-0.12, 0.2, s), sunUp = smooth(-0.03, 0.1, s), moonUp = smooth(-0.03, 0.1, m);
    const dusk = Math.exp(-(((s + 0.02) / 0.11) ** 2));    // the warm band around sunrise and sunset
    this.sunUp = sunUp;

    // sky (and fog) colour
    _c.copy(NIGHT).lerp(MOONLIT, lit * moonUp);
    this.color = (this.color || new THREE.Color()).copy(_c).lerp(DAY, day).lerp(DUSK, 0.55 * dusk);

    // ambient: the sky's own glow
    const night = CFG.NIGHT_AMBIENT + CFG.MOON_AMBIENT * lit * moonUp;
    this.hemi.intensity = night + (1.2 - night) * day;
    this.hemi.color.copy(HEMI_NIGHT).lerp(HEMI_DAY, day);
    this.hemi.groundColor.copy(GROUND_NIGHT).lerp(GROUND_DAY, day);

    // the one shadow-casting light is the sun by day and the moon by night
    const sunI = CFG.SUN_LIGHT * sunUp, moonI = CFG.MOON_LIGHT * lit * moonUp;
    const k = this.key, useSun = sunI >= moonI;
    k.intensity = useSun ? sunI : moonI;
    if (useSun) k.color.copy(SUN_LOW).lerp(SUN_HIGH, smooth(0, 0.35, s)); else k.color.copy(MOON_COL);
    k.position.copy(useSun ? this.sun : this.moon).multiplyScalar(35);
    k.visible = true;

    // headlamps: on as the sun goes down
    this.lamps = CFG.HEADLAMPS ? 1 - smooth(0.0, 0.12, s) : 0;

    // discs and stars sit just inside the far plane, centred on the eye; the fog does not touch them
    const R = cam.far * 0.9;
    this.sunMesh.position.copy(cam.position).addScaledVector(this.sun, R);
    this.sunMesh.lookAt(cam.position); this.sunMesh.scale.setScalar(R * 0.12);
    this.sunMesh.material.color.copy(SUN_LOW).lerp(_c.setRGB(1, 1, 1), smooth(0, 0.3, s));
    this.sunMesh.visible = s > -0.1;

    if (this.phase.k !== this.drawnPhase || this.drawnN !== CFG.MOON_DAYS) { drawMoon(this.moonCanvas, this.phase.age); this.moonTex.needsUpdate = true; this.drawnPhase = this.phase.k; this.drawnN = CFG.MOON_DAYS; }
    this.moonMesh.position.copy(cam.position).addScaledVector(this.moon, R * 0.98);
    this.moonMesh.lookAt(cam.position); this.moonMesh.scale.setScalar(R * 0.07);
    this.moonMesh.material.opacity = 0.35 + 0.65 * (1 - day);   // pale in daylight, as it is
    this.moonMesh.visible = m > -0.1;

    this.stars.position.copy(cam.position); this.stars.scale.setScalar(R);
    this.stars.quaternion.setFromAxisAngle(AXIS, -2 * Math.PI * days);
    this.starMat.opacity = CFG.STARS * (1 - day) ** 2 * (1 - 0.6 * lit * moonUp);   // a bright moon washes out the faint ones
    this.stars.visible = this.starMat.opacity > 0.01;
  }
}

// the sun: a white core in a soft glow
function glowTexture() {
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const g = c.getContext('2d'), r = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  r.addColorStop(0, 'rgba(255,255,255,1)'); r.addColorStop(0.22, 'rgba(255,255,245,1)'); r.addColorStop(0.3, 'rgba(255,240,200,0.5)');
  r.addColorStop(0.6, 'rgba(255,225,170,0.12)'); r.addColorStop(1, 'rgba(255,220,160,0)');
  g.fillStyle = r; g.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}

// the moon at a phase: a sphere lit from an angle, with a soft terminator, a faint dark side and a few grey seas.
// age 0 = full, 0.5 = new; waxing (age > 0.5) is lit on the right.
const SEAS = [[-0.3, -0.25, 0.28], [0.15, -0.35, 0.2], [0.25, 0.1, 0.24], [-0.2, 0.3, 0.16], [0.05, 0.45, 0.1], [-0.45, 0.05, 0.13]];
function drawMoon(canvas, age) {
  const g = canvas.getContext('2d'), N = canvas.width, img = g.createImageData(N, N), d = img.data;
  const th = 2 * Math.PI * age, Lx = -Math.sin(th), Lz = Math.cos(th);   // light direction in the moon's frame (z towards the eye)
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const x = (i + 0.5) / N * 2 - 1, y = (j + 0.5) / N * 2 - 1, rr = x * x + y * y, o = (j * N + i) * 4;
    if (rr > 1) { d[o + 3] = 0; continue; }
    const z = Math.sqrt(1 - rr), dot = x * Lx + z * Lz;
    let sea = 0; for (const [sx, sy, sr] of SEAS) { const q = ((x - sx) ** 2 + (y - sy) ** 2) / (sr * sr); if (q < 1) sea = Math.max(sea, (1 - q) * 0.5); }
    const lit = smooth(-0.08, 0.12, dot), albedo = 1 - 0.35 * sea;
    const v = (0.07 + 0.93 * lit * (0.75 + 0.25 * z)) * albedo;
    d[o] = 255 * v * 0.97; d[o + 1] = 255 * v * 0.96; d[o + 2] = 255 * v * 0.9;
    d[o + 3] = 255 * Math.min(1, (1 - Math.sqrt(rr)) * N / 2.5);   // an anti-aliased rim
  }
  g.putImageData(img, 0, 0);
}
