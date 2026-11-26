// Sticker art (D105): proof-of-concept vector drawings, one SVG per kind and tier, each with a white die-cut
// border like a real vinyl sticker. Used as an <img> in the HUD and the sticker dialog, and as a texture on
// helmets (avatar.js). Words for each sticker are here too.

import * as THREE from 'three';

const TREE = ['#9a6532', '#e8c23a', '#3fae4a'];          // brown, yellow, green
const METAL = [                                          // bronze, silver, gold: [light, mid, dark]
  ['#f0b27a', '#b8733a', '#6e3d17'],
  ['#ffffff', '#c3c9d2', '#6f7782'],
  ['#fff3a8', '#f2c230', '#9a6a08'],
];
// the die-cut edge: the drawing again, fattened in white under itself
const cut = (body, w = 9) => `<g stroke="#fff" stroke-width="${w}" stroke-linejoin="round" fill="#fff">${body}</g><g>${body}</g>`;
const wrap = (inner) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="256" height="256">${inner}</svg>`;

function tree(t) {
  const c = TREE[t], dark = ['#6b431d', '#b88f1c', '#257a30'][t];
  const crown = `<circle cx="50" cy="40" r="25" fill="${c}"/><circle cx="31" cy="51" r="17" fill="${c}"/><circle cx="69" cy="51" r="17" fill="${c}"/>`;
  const trunk = '<path d="M44 60 L42 88 L58 88 L56 60 Z" fill="#5a3a1c"/>';
  return wrap(cut(trunk + crown) +
    `<path d="M50 62 L50 74 M50 66 L42 59 M50 68 L58 60" stroke="#5a3a1c" stroke-width="4" stroke-linecap="round" fill="none"/>` +
    `<circle cx="40" cy="33" r="6" fill="#fff" opacity=".25"/><path d="M28 60 Q50 72 72 60" stroke="${dark}" stroke-width="3" fill="none" opacity=".5"/>`);
}

function chip(t) {
  const [hi, mid, lo] = METAL[t], id = `m${t}`;
  const medal = `<circle cx="50" cy="50" r="42" fill="url(#${id})" stroke="${lo}" stroke-width="3"/>`;
  // a little chipper: hopper on the left, drum box, chute curving up and over to the right, one wheel
  const machine = `<g fill="${lo}" stroke="${lo}" stroke-linejoin="round">
    <path d="M18 44 L34 50 L34 62 L18 66 Z"/>
    <rect x="33" y="44" width="26" height="22" rx="3"/>
    <path d="M50 44 L52 28 Q54 20 64 20 L76 22 L74 29 L64 28 Q60 28 59 32 L58 44 Z"/>
    <rect x="58" y="58" width="22" height="5" rx="2"/>
    <circle cx="46" cy="70" r="8" fill="${hi}" stroke-width="4"/></g>`;
  const chips = `<g fill="${lo}"><rect x="78" y="25" width="5" height="3" transform="rotate(25 80 26)"/><rect x="82" y="32" width="4" height="3" transform="rotate(-20 84 33)"/><rect x="76" y="35" width="4" height="2.5"/></g>`;
  return wrap(`<defs><linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${hi}"/><stop offset=".55" stop-color="${mid}"/><stop offset="1" stop-color="${lo}"/></linearGradient></defs>` +
    cut(medal, 8) + `<circle cx="50" cy="50" r="34" fill="none" stroke="${hi}" stroke-width="2" opacity=".7"/>` + machine + chips);
}

function bin() {
  const burst = [];
  for (let i = 0; i < 24; i++) { const a = i / 24 * Math.PI * 2, r = i % 2 ? 36 : 46; burst.push(`${(50 + Math.cos(a) * r).toFixed(1)},${(50 + Math.sin(a) * r).toFixed(1)}`); }
  return wrap(cut(`<polygon points="${burst.join(' ')}" fill="#2f7fe0"/>`) +
    '<circle cx="50" cy="50" r="31" fill="#1c5fb5"/>' +
    '<text x="50" y="59" text-anchor="middle" font-family="system-ui, Arial, sans-serif" font-weight="900" font-size="27" fill="#fff" letter-spacing="-1">100%</text>');
}

function skull() {
  const head = '<path d="M50 16 C30 16 20 30 20 46 C20 57 26 63 32 66 L32 78 L68 78 L68 66 C74 63 80 57 80 46 C80 30 70 16 50 16 Z" fill="#f4f1e6"/>';
  return wrap(cut('<circle cx="50" cy="50" r="44" fill="#1d1d1d"/>', 8) + '<circle cx="50" cy="50" r="40" fill="none" stroke="#c4302b" stroke-width="5"/>' + head +
    '<ellipse cx="38" cy="47" rx="8" ry="9" fill="#1d1d1d"/><ellipse cx="62" cy="47" rx="8" ry="9" fill="#1d1d1d"/>' +
    '<path d="M50 56 L45 64 L55 64 Z" fill="#1d1d1d"/>' +
    '<path d="M38 70 V78 M44 70 V78 M50 70 V78 M56 70 V78 M62 70 V78" stroke="#1d1d1d" stroke-width="2.5"/>');
}

function salad() {
  // a tube salad (the green tubes off the chipper's rack), tipped over, leaves out of the top
  const tube = '<g transform="rotate(-30 50 52)"><rect x="34" y="30" width="32" height="56" rx="7" fill="#3fae3a"/>' +
    '<rect x="34" y="50" width="32" height="18" fill="#f5f2e4"/><ellipse cx="50" cy="31" rx="16" ry="5" fill="#2c8a2a"/></g>';
  const leaves = '<path d="M30 30 Q24 14 36 10 Q38 20 42 24 Z" fill="#7cd35a"/><path d="M38 24 Q40 6 52 8 Q48 18 48 26 Z" fill="#59c13c"/><path d="M46 28 Q58 14 66 22 Q56 26 52 32 Z" fill="#9be36f"/>';
  return wrap(cut(tube + leaves) +
    '<g transform="rotate(-30 50 52)"><text x="50" y="63" text-anchor="middle" font-family="system-ui, Arial, sans-serif" font-weight="800" font-size="9" fill="#2c8a2a">SALAD</text>' +
    '<rect x="37" y="34" width="5" height="44" rx="2" fill="#fff" opacity=".3"/></g>');
}

const ART = { tree, chip, bin, skull, salad };

/** The SVG text of sticker kind k at tier t. */
export function stickerSVG(k, t = 0) { return (ART[k] || bin)(t); }
/** A data: URL of it, for an <img>. */
export function stickerURL(k, t = 0) { return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(stickerSVG(k, t)); }

/** Name and the line the dialog shows. */
export function stickerInfo(k, t = 0) {
  switch (k) {
    case 'tree': return {
      name: ['Brown tree', 'Yellow tree', 'Green tree'][t],
      desc: ['The crew has cut 60% of the job tree down. Keep going this job and the sticker turns yellow at 90% and green at 99%.',
        'The crew has cut 90% of the job tree down. Green at 99%.', 'The crew has cut 99% of the job tree down.'][t],
    };
    case 'chip': return {
      name: ['Bronze chipper', 'Silver chipper', 'Gold chipper'][t],
      desc: ['The crew has chipped 60% of the job tree. Keep going this job: silver at 90%, gold at 99%.',
        'The crew has chipped 90% of the job tree. Gold at 99%.', 'The crew has chipped 99% of the job tree.'][t],
    };
    case 'bin': return { name: '100%', desc: '99% of the job tree went through the chipper and into the bins.' };
    case 'skull': return { name: 'Skull', desc: 'Someone on the crew went down this job.' };
    case 'salad': return { name: 'Salad', desc: 'The crew ate three tube salads this job.' };
  }
  return { name: k, desc: '' };
}
export const tierWord = (k, t) => (k === 'tree' ? ['brown', 'yellow', 'green'][t] : k === 'chip' ? ['bronze', 'silver', 'gold'][t] : '');

// ---- textures: drawn once per sticker, shared by every helmet ----
const tex = new Map();
/** The sticker as a texture (filled in when the SVG has been drawn). shadow: its silhouette in black. */
export function stickerTexture(k, t = 0, shadow = false) {
  const key = `${k}|${t}|${shadow ? 1 : 0}`;
  let x = tex.get(key);
  if (x) return x;
  const cv = document.createElement('canvas'); cv.width = cv.height = 256;
  x = new THREE.CanvasTexture(cv); x.colorSpace = THREE.SRGBColorSpace; x.anisotropy = 4;
  tex.set(key, x);
  const img = new Image();
  img.onload = () => {
    const g = cv.getContext('2d');
    g.drawImage(img, 0, 0, 256, 256);
    if (shadow) { g.globalCompositeOperation = 'source-in'; g.fillStyle = '#000'; g.fillRect(0, 0, 256, 256); }
    x.needsUpdate = true;
  };
  img.src = stickerURL(k, t);
  return x;
}
