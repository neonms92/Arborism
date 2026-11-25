// World seeds: one readable word drives every procedural part of a new world
// (the tree, the ground, the yards and their trees). Pure, no DOM: the host
// turns the word into the numeric seeds the generators already take.
//
// A random seed is eight letters of alternating consonants and vowels. Letter
// pairs (ph, ch, th, sh, wh) count as one consonant. A rough word filter rerolls
// any seed that spells something rude; it checks a normalised spelling, so
// "ph" counts as an "f", "ck" and "c" as a "k", and so on.

const VOWELS = ['a', 'e', 'i', 'o', 'u'];
const CONSONANTS = ['b', 'c', 'd', 'f', 'g', 'h', 'j', 'k', 'l', 'm', 'n', 'p', 'r', 's', 't', 'v', 'w', 'y', 'z',
  'ph', 'ch', 'th', 'sh', 'wh'];
export const SEED_LEN = 8;

// Rude words, in the normalised spelling of norm() below. Matched anywhere in the seed.
// Rough on purpose: a false hit only costs a reroll.
const BAD = ['fuk', 'fak', 'shit', 'shat', 'kunt', 'kant', 'dik', 'kok', 'fag', 'nig', 'niga', 'nigr', 'nega', 'tit',
  'kum', 'jis', 'pus', 'pusi', 'slut', 'hor', 'wor', 'bitsh', 'bish', 'rap', 'anal', 'anus', 'arse',
  'pis', 'penis', 'pene', 'vagi', 'vaj', 'dild', 'homo', 'dike', 'kik', 'spik', 'wetbak', 'jap', 'gok', 'nasi',
  'hitl', 'sek', 'seks', 'tard', 'wank', 'twat', 'pak', 'kuk', 'bum', 'poo'];

/** The spelling the filter checks: lower case, letter pairs and look-alike letters folded together. */
export function norm(s) {
  return String(s).toLowerCase().replace(/[^a-z]/g, '')
    .replace(/ph/g, 'f').replace(/th/g, '0').replace(/ck/g, 'k').replace(/ch/g, 'tsh').replace(/wh/g, 'w')
    .replace(/[cq]/g, 'k').replace(/x/g, 'ks').replace(/z/g, 's').replace(/y/g, 'i')
    .replace(/(.)\1+/g, '$1');      // doubled letters count once ("puss" = "pus"); th is its own sound (0)
}

/** True when the word contains none of the filtered words. */
export function isClean(s) {
  const n = norm(s);
  return !BAD.some((w) => n.includes(w));
}

/** A random clean seed: SEED_LEN letters, consonants and vowels taking turns. rnd() is 0..1. */
export function randomSeed(rnd = Math.random) {
  for (;;) {
    let s = '', cons = rnd() < 0.5;
    while (s.length < SEED_LEN) {
      let pool = cons ? CONSONANTS : VOWELS;
      if (SEED_LEN - s.length < 2) pool = pool.filter((p) => p.length === 1);   // a pair would run past the end
      s += pool[Math.floor(rnd() * pool.length)];
      cons = !cons;
    }
    if (isClean(s)) return s;
  }
}

/** 32-bit FNV-1a of a string, salted. */
function hash(s, salt) {
  let h = 0x811c9dc5 ^ salt;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13;
  return h >>> 0;
}

/**
 * The numeric seeds a seed word stands for: {tree, terrain, yard}, each 1..1e6, or null for an empty word
 * (then the TREE_SEED / TERRAIN_SEED / YARD_SEED settings are used as they are). Case and surrounding
 * spaces do not matter.
 */
export function seedNumbers(word) {
  const s = String(word || '').trim().toLowerCase();
  if (!s) return null;
  return { tree: 1 + hash(s, 1) % 1e6, terrain: 1 + hash(s, 2) % 1e6, yard: 1 + hash(s, 3) % 1e6 };
}
