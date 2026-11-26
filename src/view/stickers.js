// Sticker art (D105): proof-of-concept vector drawings, one SVG per kind and tier, each with a white die-cut
// border like a real vinyl sticker. Used as an <img> in the HUD and the sticker dialog, and as a texture on
// helmets (avatar.js). Words for each sticker are here too.

import * as THREE from 'three';
import { CFG } from '../config.js';

const share = () => `${Math.round(CFG.STICKER_SHARE * 100)}%`;

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

function bin(t = 0) {
  const [hi, mid, lo] = t ? ['#fff3a8', '#f2c230', '#b8860b'] : ['#5aa0f0', '#2f7fe0', '#1c5fb5'];
  const burst = [];
  for (let i = 0; i < 24; i++) { const a = i / 24 * Math.PI * 2, r = i % 2 ? 36 : 46; burst.push(`${(50 + Math.cos(a) * r).toFixed(1)},${(50 + Math.sin(a) * r).toFixed(1)}`); }
  return wrap(cut(`<polygon points="${burst.join(' ')}" fill="${mid}"/>`) +
    `<circle cx="50" cy="50" r="31" fill="${lo}"/><circle cx="50" cy="50" r="31" fill="none" stroke="${hi}" stroke-width="2" opacity=".7"/>` +
    `<text x="50" y="59" text-anchor="middle" font-family="system-ui, Arial, sans-serif" font-weight="900" font-size="27" fill="${t ? '#4a2e00' : '#fff'}" letter-spacing="-1">100%</text>`);
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

// broken things: the ghost of the thing, pale and floating, with a wispy tail and a little smiling face (D107, D108, D112)
const GHOST = {
  house: '<path d="M24 50 L50 26 L76 50 Z"/><rect x="30" y="48" width="40" height="22"/>',
  shed: '<path d="M26 44 L74 36 L74 42 L26 50 Z"/><rect x="30" y="45" width="40" height="25"/>',
  fence: '<path d="M26 70 V40 L31 33 L36 40 V70 Z M41 70 V37 L46 30 L51 37 V70 Z M56 70 V37 L61 30 L66 37 V70 Z"/><rect x="22" y="44" width="52" height="6"/><rect x="22" y="58" width="52" height="6"/>',
  wrongtree: '<circle cx="50" cy="36" r="15"/><circle cx="37" cy="44" r="11"/><circle cx="63" cy="44" r="11"/><rect x="34" y="44" width="32" height="26"/>',
  power: '<path d="M60 14 L22 54 L45 54 L35 80 L80 37 L57 37 L67 14 Z"/>',
  wreck: '<path d="M20 46 L34 51 L34 63 L20 66 Z"/><rect x="33" y="45" width="26" height="25" rx="3"/><path d="M50 45 L52 31 Q54 24 63 24 L73 26 L71 32 L63 31 Q60 31 59 35 L58 45 Z"/>',
};
const FACE = { power: -13 };   // the face higher up, where the thing is widest
function ghost(kind) {
  const fy = FACE[kind] || 0;
  const tail = '<path d="M30 68 C30 80 42 76 46 84 C50 92 62 86 62 94 C70 86 58 80 64 74 C68 70 70 69 70 66 Z"/>';
  return wrap(cut('<circle cx="50" cy="50" r="44" fill="#3a3f72"/>', 8) +
    '<circle cx="24" cy="26" r="1.6" fill="#fff" opacity=".7"/><circle cx="78" cy="22" r="1.2" fill="#fff" opacity=".6"/><circle cx="82" cy="70" r="1.4" fill="#fff" opacity=".5"/>' +
    `<g fill="#eef4ff" opacity=".9" stroke="#c8d6ff" stroke-width="1.5" stroke-linejoin="round">${GHOST[kind]}${tail}</g>` +
    '<path d="M36 74 Q30 82 38 88 M66 70 Q76 76 70 86" stroke="#c8d6ff" stroke-width="2" fill="none" stroke-linecap="round" opacity=".8"/>' +
    `<g transform="translate(0 ${fy})"><ellipse cx="43" cy="58" rx="3.2" ry="4.2" fill="#2a2d55"/><ellipse cx="57" cy="58" rx="3.2" ry="4.2" fill="#2a2d55"/><path d="M45 63.5 Q50 68.5 55 63.5" stroke="#2a2d55" stroke-width="2" fill="none" stroke-linecap="round"/><ellipse cx="38.5" cy="64" rx="2.6" ry="1.5" fill="#ff9fb8" opacity=".7"/><ellipse cx="61.5" cy="64" rx="2.6" ry="1.5" fill="#ff9fb8" opacity=".7"/></g>`);
}
// rigging: a block hanging from the stem, the rope down to a sawn-off log, a dashed kerf
function rigcut() {
  return wrap(cut('<circle cx="50" cy="50" r="44" fill="#2f8f6a"/>', 8) +
    '<rect x="16" y="14" width="14" height="74" rx="3" fill="#8a5a2e"/>' +
    '<path d="M30 22 H44" stroke="#ccc" stroke-width="4"/><circle cx="50" cy="24" r="8" fill="#d8d8d8" stroke="#555" stroke-width="2.5"/><circle cx="50" cy="24" r="2.5" fill="#555"/>' +
    '<path d="M58 24 V54 M42 24 V82" stroke="#ff9a1f" stroke-width="3.5"/>' +
    '<rect x="44" y="52" width="38" height="12" rx="5" fill="#a06a36" transform="rotate(-12 63 58)"/><ellipse cx="44" cy="62" rx="3" ry="6" fill="#e6c08a" transform="rotate(-12 63 58)"/>' +
    '<path d="M30 60 L44 60" stroke="#fff" stroke-width="2.5" stroke-dasharray="3 2"/>');
}
// a heavy log set down softly on the rope: the log on the ground, the rope up out of view, a feather
function lower() {
  return wrap(cut('<circle cx="50" cy="50" r="44" fill="#3a7fb5"/>', 8) +
    '<defs><clipPath id="lowc"><circle cx="50" cy="50" r="44"/></clipPath></defs><path clip-path="url(#lowc)" d="M4 74 Q50 68 96 74 L96 100 L4 100 Z" fill="#5c8a3a"/>' +
    '<path d="M62 12 V58" stroke="#ff9a1f" stroke-width="3.5"/>' +
    '<rect x="22" y="56" width="58" height="16" rx="7" fill="#9a6532"/><ellipse cx="22" cy="64" rx="4" ry="8" fill="#e6c08a"/><path d="M30 60 H70 M34 67 H74" stroke="#6b431d" stroke-width="1.5"/>' +
    '<path d="M28 34 C34 20 46 16 50 18 C46 26 38 34 28 34 Z" fill="#fff"/><path d="M28 34 L48 19" stroke="#bbb" stroke-width="1.2"/>' +
    '<text x="50" y="49" text-anchor="middle" font-family="system-ui, Arial, sans-serif" font-weight="900" font-size="12" fill="#fff">600 kg</text>');
}
// the wood you are lanyarded to going down: a stem piece with an orange loop on it, tipping off a sawn stump
function perch(bg, word) {
  return wrap(cut(`<circle cx="50" cy="50" r="44" fill="${bg}"/>`, 8) +
    '<rect x="40" y="62" width="18" height="26" fill="#8a5a2e"/><ellipse cx="49" cy="62" rx="9" ry="3" fill="#e6c08a"/>' +
    '<g transform="rotate(28 52 56)"><rect x="42" y="12" width="18" height="42" rx="3" fill="#a06a36"/><ellipse cx="51" cy="35" rx="14" ry="5" fill="none" stroke="#ff9a1f" stroke-width="3.5"/></g>' +
    '<path d="M70 20 q6 4 4 10 M76 34 q6 3 5 9" stroke="#fff" stroke-width="2.5" fill="none" stroke-linecap="round"/>' +
    `<rect x="12" y="70" width="76" height="18" rx="5" fill="#fff" stroke="#222" stroke-width="2.5" transform="rotate(-5 50 79)"/>` +
    `<text x="50" y="84" text-anchor="middle" font-family="system-ui, Arial, sans-serif" font-weight="900" font-size="${word.length > 10 ? 10 : 12.5}" fill="#222" transform="rotate(-5 50 79)">${word}</text>`);
}
// a lanyard: an orange rope loop round a bit of trunk, cut through with sparks at the cut, and a word on a banner
function lanyard(word, bg) {
  return wrap(cut(`<circle cx="50" cy="50" r="44" fill="${bg}"/>`, 8) +
    '<rect x="42" y="12" width="16" height="64" rx="4" fill="#8a5a2e"/><path d="M45 14 V74 M53 14 V74" stroke="#6b431d" stroke-width="1.5"/>' +
    '<path d="M60 40 C80 40 86 50 80 56 M66 60 C50 64 26 62 20 54 C14 46 26 38 40 38" fill="none" stroke="#ff9a1f" stroke-width="6" stroke-linecap="round"/>' +
    '<path d="M80 56 l4 3 M80 56 l5 -1 M66 60 l-3 4 M66 60 l-4 -2" stroke="#ff9a1f" stroke-width="2.5" stroke-linecap="round"/>' +
    '<g fill="#ffe14a"><path d="M73 55 l3 -7 l1 6 l6 -3 l-4 6 z"/></g>' +
    `<rect x="14" y="66" width="72" height="20" rx="5" fill="#fff" stroke="#222" stroke-width="2.5" transform="rotate(-6 50 76)"/>` +
    `<text x="50" y="82" text-anchor="middle" font-family="system-ui, Arial, sans-serif" font-weight="900" font-size="15" fill="#222" transform="rotate(-6 50 76)">${word}</text>`);
}

// bankrupt: an empty wallet, open, a moth flying out
function broke() {
  return wrap(cut('<circle cx="50" cy="50" r="44" fill="#c4302b"/>', 8) +
    '<rect x="22" y="44" width="56" height="34" rx="6" fill="#6b431d"/><path d="M22 50 Q50 36 78 50" fill="#8a5a2e"/><rect x="60" y="56" width="18" height="12" rx="3" fill="#8a5a2e"/><circle cx="66" cy="62" r="2.5" fill="#e6c08a"/>' +
    '<g fill="#e8dcc0" stroke="#8a7a5a" stroke-width="1"><path d="M50 32 C42 20 34 22 38 30 C34 34 42 38 50 32 Z"/><path d="M50 32 C58 20 66 22 62 30 C66 34 58 38 50 32 Z"/></g><path d="M50 26 V36" stroke="#5a4a30" stroke-width="2"/>' +
    '<path d="M42 40 q4 -3 8 0 M50 40 q4 -3 8 0" stroke="#fff" stroke-width="1.5" fill="none" opacity=".7"/>' +
    '<text x="50" y="91" text-anchor="middle" font-family="system-ui, Arial, sans-serif" font-weight="900" font-size="11" fill="#fff">$0</text>');
}

const ART = { tree, chip, bin, skull, salad, wrongtree: () => ghost('wrongtree'), broke, house: () => ghost('house'), shed: () => ghost('shed'), fence: () => ghost('fence'), wreck: () => ghost('wreck'), power: () => ghost('power'),
  cutself: () => lanyard('OOPS!', '#f2c230'), cutother: () => lanyard('SORRY!', '#8e5bd0'), rigcut, lower,
  perch: () => perch('#e0663a', 'GOING DOWN!'), perchother: () => perch('#8e5bd0', 'LOOK OUT!') };

/** The SVG text of sticker kind k at tier t. */
export function stickerSVG(k, t = 0) { return (ART[k] || bin)(t); }
/** A data: URL of it, for an <img>. */
export function stickerURL(k, t = 0) { return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(stickerSVG(k, t)); }

/** Name and the line the dialog shows. */
export function stickerInfo(k, t = 0) {
  switch (k) {
    case 'tree': return {
      name: ['Brown tree', 'Yellow tree', 'Green tree'][t],
      desc: [`60% of the job tree is chopped into pieces the chipper can take, and you did at least ${share()} of the sawing. It turns yellow at 90% and green at 99% this job.`,
        `90% of the job tree is chopped into pieces the chipper can take, and you did at least ${share()} of the sawing. Green at 99%.`,
        `99% of the job tree is chopped into pieces the chipper can take, and you did at least ${share()} of the sawing.`][t],
    };
    case 'chip': return {
      name: ['Bronze chipper', 'Silver chipper', 'Gold chipper'][t],
      desc: [`The crew has chipped 60% of the job tree, and you fed at least ${share()} of it. Silver at 90%, gold at 99% this job.`,
        `The crew has chipped 90% of the job tree, and you fed at least ${share()} of it. Gold at 99%.`,
        `The crew has chipped 99% of the job tree, and you fed at least ${share()} of it.`][t],
    };
    case 'wrongtree': return { name: 'Sorry, Tree!', desc: 'You sawed down a neighbour\'s tree. Wrong tree!' };
    case 'broke': return { name: 'Bankrupt', desc: 'The job\'s cash went below zero.' };
    case 'bin': return { name: t ? 'Gold 100%' : '100%', desc: `99% of the job tree went through the chipper and into the bins, and you put at least ${share()} of those chips there.` + (t ? ' And the job still had money left.' : '') };
    case 'house': return { name: 'Sorry, House!', desc: 'Wood you sent, or a chipper running away from you, broke part of a house this job.' };
    case 'shed': return { name: 'Sorry, Shed!', desc: 'Wood you sent, or a chipper running away from you, broke a shed this job.' };
    case 'fence': return { name: 'Sorry, Fence!', desc: 'Wood you sent, or a chipper running away from you, broke a fence this job.' };
    case 'power': return { name: 'Sorry, Electricity!', desc: 'You sawed through a power line, or your wood brought one down, this job.' };
    case 'wreck': return { name: 'Sorry, Chipper!', desc: 'Wood you sent wrecked a chipper this job.' };
    case 'rigcut': return { name: 'Rigged', desc: 'On your spurs, you sawed free wood that was tied to the rigging rope.' };
    case 'lower': return { name: 'Soft landing', desc: `On the rope, you let a piece of ${CFG.STICKER_LOWER_KG} kg or more down onto the ground, and nothing broke for ${CFG.STICKER_LOWER_T} seconds after.` };
    case 'perch': return { name: 'Going down!', desc: 'You sawed free the wood you were lanyarded to.' };
    case 'perchother': return { name: 'Look out!', desc: 'You sawed free wood someone else was lanyarded to. Only the first time ever counts.' };
    case 'cutself': return { name: 'Oops!', desc: 'You sawed through your own lanyard this job.' };
    case 'cutother': return { name: 'Sorry!', desc: 'You sawed through someone else\'s lanyard. Only the first time ever counts.' };
    case 'skull': return { name: 'Skull', desc: 'You went down this job.' };
    case 'salad': return { name: 'Salad', desc: `You ate ${CFG.STICKER_SALADS} tube salads this job.` };
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
