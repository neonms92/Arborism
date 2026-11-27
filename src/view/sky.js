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
// Clouds: the host drifts one number, cover (0 clear .. 1 overcast; sim
// stepClouds), and sends it with the clock. Cover dims the sun and moon by up
// to CFG.CLOUD_DIM and softens their shadows, greys the sky, hides the stars,
// moon and sun, and thickens one layer of drifting cloud overhead (a noise
// pattern on a plane above the eye, fading out towards the draw distance).
//
// Tree line: the yard sits in a clearing in a wooded valley. A ring round the
// eye, just inside the far plane (so it hides the sun, moon and stars as they
// set), carries a silhouette of crowns as tall as CFG.FOREST_HEIGHT seen from
// CFG.FOREST_DIST, with a hazier, taller ridge of hillside wood behind. Its
// colour is the sky's, darkened by CFG.FOREST_DARK, so it follows day, dusk,
// cloud and night (never brighter than the sky behind it). The lower
// CFG.FOREST_MIST of it fades back into the sky's colour, which is also the
// fog's, so the fogged ground runs into it with no seam. Climbing higher
// lowers it, as it would.
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
const GREY_DAY = new THREE.Color(0xa3aab2), GREY_NIGHT = new THREE.Color(0x0b0d11);
const _c = new THREE.Color(), _g = new THREE.Color();
const EAST = new THREE.Vector3(1, 0, 0), UP_S = new THREE.Vector3(0, Math.cos(TILT), Math.sin(TILT));   // sunrise, and noon

// Sun, moon, stars and tree line are backdrop: blended like transparent things, but sorted with the opaque ones
// (transparent false, so by renderOrder, before anything else) with no depth test, so the whole scene draws over
// them however near the far plane it stands. (Marked transparent, they would come after the scene and cover
// houses further out than they sit.) Custom blending, because three turns plain alpha blending off on opaques.
const BACKDROP = { transparent: false, depthTest: false, depthWrite: false, blending: THREE.CustomBlending,
  blendSrc: THREE.SrcAlphaFactor, blendDst: THREE.OneMinusSrcAlphaFactor, blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneMinusSrcAlphaFactor };

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
    this.sunUp = 1; this.lamps = 0; this.dark = 0; this.phase = moonPhase(this.days);

    const disc = (tex, size) => {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(size, size), new THREE.MeshBasicMaterial({ map: tex, fog: false, ...BACKDROP }));
      m.frustumCulled = false; m.renderOrder = -3; scene.add(m); return m;
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
    this.starMat = new THREE.PointsMaterial({ size: 2, sizeAttenuation: false, vertexColors: true, fog: false, ...BACKDROP });
    this.stars = new THREE.Points(g, this.starMat); this.stars.frustumCulled = false; this.stars.renderOrder = -3; scene.add(this.stars);   // drawn first: furthest, behind the tree line

    this.cloud = CFG.CLOUDS >= 0 ? CFG.CLOUDS : 0.25; this.drift = new THREE.Vector2(Math.random() * 1000, Math.random() * 1000);
    this.cloudMat = cloudMaterial();
    this.clouds = new THREE.Mesh(new THREE.PlaneGeometry(2, 2).rotateX(Math.PI / 2), this.cloudMat);   // faces down
    this.clouds.frustumCulled = false; this.clouds.renderOrder = -1; scene.add(this.clouds);

    this.forestMat = forestMaterial();
    this.forest = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 2, 256, 1, true), this.forestMat);   // y on the unit ring = tan(elevation)
    this.forest.frustumCulled = false; this.forest.renderOrder = -2; scene.add(this.forest);
  }

  /** Advance the clock and set every light and colour. cam: the camera (its far plane is the draw distance). */
  update(dt, aux, cam) {
    const len = aux && aux.sky ? aux.sky[1] : CFG.DAY_LENGTH;
    if (len > 0) this.days += dt / len;
    if (aux && aux.sky) {                                  // ease onto the host's clock; jump if it is far off (a skip)
      const d = aux.sky[0] - this.days;
      if (!this.synced || Math.abs(d) > 0.005) this.days = aux.sky[0]; else this.days += d * Math.min(1, dt * 2);
      this.synced = true;
      if (aux.sky[2] !== undefined) this.cloud += (aux.sky[2] - this.cloud) * Math.min(1, dt * 2);
    } else if (CFG.CLOUDS >= 0) this.cloud = CFG.CLOUDS;
    const c = Math.min(1, Math.max(0, this.cloud)), clear = 1 - CFG.CLOUD_DIM * c;
    const days = this.days;
    sunDir(days, this.sun); this.moon.copy(this.sun).negate();
    this.phase = moonPhase(days);
    const lit = this.phase.lit, s = this.sun.y, m = this.moon.y;

    // how much of each is above the horizon, softly
    const day = smooth(-0.12, 0.2, s), sunUp = smooth(-0.03, 0.1, s), moonUp = smooth(-0.03, 0.1, m);
    const dusk = Math.exp(-(((s + 0.02) / 0.11) ** 2)) * (1 - 0.6 * c);    // the warm band around sunrise and sunset
    this.sunUp = sunUp;

    // sky (and fog) colour
    _c.copy(NIGHT).lerp(MOONLIT, lit * moonUp * clear);
    _g.copy(GREY_NIGHT).lerp(GREY_DAY, day);
    this.color = (this.color || new THREE.Color()).copy(_c).lerp(DAY, day).lerp(_g, 0.8 * c).lerp(DUSK, 0.55 * dusk);

    // ambient: the sky's own glow
    const night = CFG.NIGHT_AMBIENT + CFG.MOON_AMBIENT * lit * moonUp * clear;
    this.hemi.intensity = night + (1.2 * (1 - 0.3 * c) - night) * day;   // an overcast sky still glows, less
    this.hemi.color.copy(HEMI_NIGHT).lerp(HEMI_DAY, day);
    this.hemi.groundColor.copy(GROUND_NIGHT).lerp(GROUND_DAY, day);

    // the one shadow-casting light is the sun by day and the moon by night
    const sunI = CFG.SUN_LIGHT * sunUp * clear, moonI = CFG.MOON_LIGHT * lit * moonUp * clear;
    const k = this.key, useSun = sunI >= moonI;
    k.intensity = useSun ? sunI : moonI;
    if (useSun) k.color.copy(SUN_LOW).lerp(SUN_HIGH, smooth(0, 0.35, s)); else k.color.copy(MOON_COL);
    k.position.copy(useSun ? this.sun : this.moon).multiplyScalar(35);
    k.shadow.intensity = 1 - 0.75 * c;                    // light through cloud casts faint shadows

    // headlamps: on as the sun goes down
    this.dark = 1 - smooth(0.0, 0.12, s);               // 0 by day, 1 at night: work lights come on with it
    this.lamps = CFG.HEADLAMPS ? this.dark : 0;

    // discs and stars sit just inside the far plane, centred on the eye; the fog does not touch them
    const R = cam.far * 0.9;
    this.sunMesh.position.copy(cam.position).addScaledVector(this.sun, R);
    this.sunMesh.lookAt(cam.position); this.sunMesh.scale.setScalar(R * 0.12);
    this.sunMesh.material.color.copy(SUN_LOW).lerp(_c.setRGB(1, 1, 1), smooth(0, 0.3, s));
    this.sunMesh.material.opacity = 1 - 0.95 * c;
    this.sunMesh.visible = s > -0.1;

    if (this.phase.k !== this.drawnPhase || this.drawnN !== CFG.MOON_DAYS) { drawMoon(this.moonCanvas, this.phase.age); this.moonTex.needsUpdate = true; this.drawnPhase = this.phase.k; this.drawnN = CFG.MOON_DAYS; }
    this.moonMesh.position.copy(cam.position).addScaledVector(this.moon, R * 0.98);
    this.moonMesh.lookAt(cam.position); this.moonMesh.scale.setScalar(R * 0.07);
    this.moonMesh.material.opacity = (0.35 + 0.65 * (1 - day)) * (1 - 0.95 * c);   // pale in daylight, as it is; gone behind cloud
    this.moonMesh.visible = m > -0.1;

    this.stars.position.copy(cam.position); this.stars.scale.setScalar(R);
    this.stars.quaternion.setFromAxisAngle(AXIS, -2 * Math.PI * days);
    this.starMat.opacity = CFG.STARS * (1 - day) ** 2 * (1 - 0.6 * lit * moonUp) * (1 - c) ** 2;   // a bright moon washes out the faint ones
    this.stars.visible = this.starMat.opacity > 0.01;

    // the cloud layer: above the eye, as wide as the view, drifting with the wind
    const H = Math.min(80, cam.far * 0.4), u = this.cloudMat.uniforms;
    this.drift.x += CFG.CLOUD_WIND * dt; this.drift.y += CFG.CLOUD_WIND * 0.35 * dt;
    this.clouds.position.set(cam.position.x, cam.position.y + H, cam.position.z); this.clouds.scale.set(R, 1, R);
    u.uCover.value = c; u.uDrift.value.copy(this.drift); u.uR.value = R;
    // lit side: the sky's light on them (warm at dusk, faint at night), the shade a darker grey of the sky
    const glow = Math.max(day, 0.06 * lit * moonUp * clear + 0.03);
    u.uLit.value.copy(k.color).multiplyScalar(0.35 + 0.65 * smooth(0, 0.3, s)).lerp(_c.setRGB(1, 1, 1), 0.5).multiplyScalar(glow * (1 - 0.3 * c)).lerp(DUSK, 0.8 * dusk);
    u.uShade.value.copy(this.color).multiplyScalar(0.6 + 0.2 * (1 - c)).lerp(_g, 0.3);
    this.clouds.visible = c > 0.01;

    // the tree line, drawn after the sun and moon so they set behind it
    const D = Math.max(1, CFG.FOREST_DIST), f = this.forestMat.uniforms, Rf = R * 0.85;
    this.forest.visible = CFG.FOREST_HEIGHT > 0;
    this.forest.position.copy(cam.position); this.forest.scale.setScalar(Rf);
    f.uH.value = CFG.FOREST_HEIGHT / D; f.uBase.value = -cam.position.y / D;   // the ground is about y = 0
    f.uN.value = Math.max(8, Math.round(2 * Math.PI * D / 7));                  // a crown every 7 m or so
    f.uDark.value = Math.min(1, Math.max(0, CFG.FOREST_DARK)); f.uMist.value = Math.max(0.001, CFG.FOREST_MIST);
    f.uSky.value.copy(this.color); f.uDay.value = day * (1 - 0.7 * c);
  }
}

// Clouds: fractal value noise on the layer's world x-z (drifting), cut at a level that falls as cover rises.
// Thick parts are shaded, thin edges lit; the layer fades out towards its rim so it meets the fogged horizon.
function cloudMaterial() {
  return new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, side: THREE.DoubleSide, fog: false,
    uniforms: { uCover: { value: 0 }, uDrift: { value: new THREE.Vector2() }, uR: { value: 100 }, uLit: { value: new THREE.Color(1, 1, 1) }, uShade: { value: new THREE.Color(0.6, 0.6, 0.6) } },
    vertexShader: `varying vec2 vW; varying vec2 vL;
      void main() { vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xz; vL = position.xz; gl_Position = projectionMatrix * viewMatrix * w; }`,
    fragmentShader: `uniform float uCover; uniform vec2 uDrift; uniform float uR; uniform vec3 uLit; uniform vec3 uShade;
      varying vec2 vW; varying vec2 vL;
      float h(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float n(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
        return mix(mix(h(i), h(i + vec2(1, 0)), f.x), mix(h(i + vec2(0, 1)), h(i + vec2(1, 1)), f.x), f.y); }
      float fbm(vec2 p) { float a = 0.5, s = 0.0; for (int k = 0; k < 5; k++) { s += a * n(p); p = p * 2.03 + 17.0; a *= 0.5; } return s; }
      void main() {
        vec2 p = (vW - uDrift) / 38.0;
        float v = fbm(p), cut = 0.62 - 0.34 * uCover;
        float d = smoothstep(cut, cut + 0.08, v);
        float rim = 1.0 - smoothstep(0.45, 1.0, length(vL));
        float a = d * rim * (0.8 + 0.18 * uCover);
        if (a < 0.003) discard;
        vec3 col = mix(uLit, uShade, smoothstep(cut + 0.04, cut + 0.25, v) * (0.35 + 0.5 * uCover));
        gl_FragColor = vec4(col, a);
        #include <colorspace_fragment>
      }`,
  });
}

// The tree line on the unit ring round the eye (y = tan of elevation; uBase is the ground's foot of it, uH the
// trees' height, both over their distance). Front: a crown per cell round the ring (pointed firs and round
// broadleaves, overlapping), on a floor of lower wood. Back: a taller, smoother ridge, half as dark (further into
// the haze). Each is the sky darkened, with a touch of green by day, fading to the sky at its foot.
function forestMaterial() {
  return new THREE.ShaderMaterial({
    side: THREE.DoubleSide, fog: false, ...BACKDROP,
    uniforms: { uH: { value: 0.08 }, uBase: { value: 0 }, uN: { value: 270 }, uDark: { value: 0.5 }, uMist: { value: 0.4 }, uSky: { value: new THREE.Color() }, uDay: { value: 1 } },
    vertexShader: `varying vec3 vP;
      void main() { vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: `uniform float uH; uniform float uBase; uniform float uN; uniform float uDark; uniform float uMist; uniform vec3 uSky; uniform float uDay;
      varying vec3 vP;
      float h(float i) { return fract(sin(mod(i, uN) * 78.233 + 11.7) * 43758.5453); }
      void main() {
        float a = atan(vP.z, vP.x) + 3.14159265;            // 0 .. 2 pi round the ring
        float y = vP.y, x = a / 6.2831853 * uN;              // x: cells round the ring
        float top = 0.55;                                     // the wood under the crowns, as a fraction of uH
        for (int k = -1; k <= 1; k++) {
          float i = floor(x) + float(k), r = h(i), s = h(i + 101.0), dx = (x - i - 0.5 - 0.3 * (h(i + 57.0) - 0.5)) / (0.75 + 0.35 * s);
          if (abs(dx) < 1.0) {
            float shape = r > 0.45 ? 1.0 - abs(dx) : sqrt(1.0 - dx * dx);   // fir or broadleaf
            top = max(top, (0.7 + 0.5 * s) * (0.55 + 0.45 * shape));
          }
        }
        float ridge = 1.35 + 0.25 * sin(3.0 * a + 1.3) + 0.15 * sin(7.0 * a + 0.4) + 0.08 * sin(17.0 * a + 2.1) + 0.04 * sin(41.0 * a + 0.7);
        float q = (y - uBase) / uH;                           // height above the foot, in tree heights
        float w = fwidth(q) + 1e-5;
        float aF = smoothstep(-w, w, top - q), aB = smoothstep(-w, w, ridge - q);
        float mist = smoothstep(0.0, uMist, q);
        vec3 tint = vec3(0.12, 0.2, 0.11) * uDay;
        vec3 cF = mix(uSky, uSky * (1.0 - uDark) + tint * uDark * 0.25, mist);
        vec3 cB = mix(uSky, uSky * (1.0 - 0.5 * uDark) + tint * uDark * 0.12, mist);
        float A = aF + aB * (1.0 - aF);
        if (A < 0.003) discard;
        gl_FragColor = vec4((cF * aF + cB * aB * (1.0 - aF)) / A, A);
        #include <colorspace_fragment>
      }`,
  });
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
