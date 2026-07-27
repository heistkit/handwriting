/**
 * charset.js — the character inventory.
 *
 * Every glyph the font can contain is declared here exactly once. Two kinds:
 *
 *   required  the user physically writes it (on paper, or on the canvas pad)
 *   derived   we synthesise it from a required glyph, so the user writes less
 *
 * Each entry also declares `zone`, which tells the metrics stage what vertical
 * extent to expect. That is what lets us recover a baseline from a photograph
 * of blank paper with no ruled lines on it: an 'x' sits between baseline and
 * x-height, a 'k' rises to the ascender, a 'p' drops below. Solving those
 * constraints together across ~110 glyphs pins the baseline far more reliably
 * than looking at any single letter.
 *
 * `parts` is the number of disconnected ink components the glyph normally has
 * ("i" is two: stem and dot). Segmentation merges components that overlap
 * horizontally, and uses `parts` to sanity-check the result.
 */

/** Vertical zones, expressed as fractions of the em once metrics are solved. */
export const ZONES = {
  x: 'x', // baseline → x-height          a c e m n o r s u v w x z
  asc: 'asc', // baseline → ascender          b d f h k l t + all caps + digits
  desc: 'desc', // descender → x-height         g p q y
  full: 'full', // descender → ascender         j Q ( ) [ ] { } / etc.
  base: 'base', // sits on the baseline, short  . , _
  mid: 'mid', // centred on the math axis     + − = × ÷ ± < > ~ arrows
  high: 'high', // hangs from the ascender      ' " ° ^ etc.
};

/**
 * Build a charset entry.
 * @param {string} ch     the character itself
 * @param {string} name   PostScript glyph name (CFF requires these)
 * @param {string} zone   one of ZONES
 * @param {object} [opts] { parts, group, derive }
 */
function g(ch, name, zone, opts = {}) {
  return {
    ch,
    name,
    zone,
    unicode: ch.codePointAt(0),
    parts: opts.parts ?? 1,
    group: opts.group ?? 'misc',
    derive: opts.derive ?? null,
  };
}

const UPPER = [
  ['A', 'A'], ['B', 'B'], ['C', 'C'], ['D', 'D'], ['E', 'E'], ['F', 'F'],
  ['G', 'G'], ['H', 'H'], ['I', 'I'], ['J', 'J'], ['K', 'K'], ['L', 'L'],
  ['M', 'M'], ['N', 'N'], ['O', 'O'], ['P', 'P'], ['Q', 'Q'], ['R', 'R'],
  ['S', 'S'], ['T', 'T'], ['U', 'U'], ['V', 'V'], ['W', 'W'], ['X', 'X'],
  ['Y', 'Y'], ['Z', 'Z'],
].map(([ch, name]) =>
  // Q's tail drops below the baseline in most hands; treat it as full-height.
  g(ch, name, ch === 'Q' ? ZONES.full : ZONES.asc, { group: 'upper' })
);

// Lowercase letters carry the most spacing information, so their zones matter most.
const LOWER_ZONES = {
  a: ZONES.x, b: ZONES.asc, c: ZONES.x, d: ZONES.asc, e: ZONES.x,
  f: ZONES.full, g: ZONES.desc, h: ZONES.asc, i: ZONES.asc, j: ZONES.full,
  k: ZONES.asc, l: ZONES.asc, m: ZONES.x, n: ZONES.x, o: ZONES.x,
  p: ZONES.desc, q: ZONES.desc, r: ZONES.x, s: ZONES.x, t: ZONES.asc,
  u: ZONES.x, v: ZONES.x, w: ZONES.x, x: ZONES.x, y: ZONES.desc, z: ZONES.x,
};

const LOWER = Object.keys(LOWER_ZONES).map((ch) =>
  g(ch, ch, LOWER_ZONES[ch], {
    group: 'lower',
    // i and j are written with a separate dot; f and t are usually crossed
    // without lifting, so they stay single-component.
    parts: ch === 'i' || ch === 'j' ? 2 : 1,
  })
);

const DIGIT_NAMES = [
  'zero', 'one', 'two', 'three', 'four',
  'five', 'six', 'seven', 'eight', 'nine',
];

const DIGITS = DIGIT_NAMES.map((name, i) =>
  g(String(i), name, ZONES.asc, { group: 'digit' })
);

const PUNCT = [
  g('.', 'period', ZONES.base, { group: 'punct' }),
  g(',', 'comma', ZONES.base, { group: 'punct' }),
  g(':', 'colon', ZONES.x, { group: 'punct', parts: 2 }),
  g(';', 'semicolon', ZONES.desc, { group: 'punct', parts: 2 }),
  g('!', 'exclam', ZONES.asc, { group: 'punct', parts: 2 }),
  g('?', 'question', ZONES.asc, { group: 'punct', parts: 2 }),
  g("'", 'quotesingle', ZONES.high, { group: 'punct' }),
  g('"', 'quotedbl', ZONES.high, { group: 'punct', parts: 2 }),
  g('(', 'parenleft', ZONES.full, { group: 'punct' }),
  g(')', 'parenright', ZONES.full, { group: 'punct' }),
  g('[', 'bracketleft', ZONES.full, { group: 'punct' }),
  g(']', 'bracketright', ZONES.full, { group: 'punct' }),
  g('{', 'braceleft', ZONES.full, { group: 'punct' }),
  g('}', 'braceright', ZONES.full, { group: 'punct' }),
  g('-', 'hyphen', ZONES.mid, { group: 'punct' }),
  g('_', 'underscore', ZONES.base, { group: 'punct' }),
  g('/', 'slash', ZONES.full, { group: 'punct' }),
  g('\\', 'backslash', ZONES.full, { group: 'punct' }),
  g('|', 'bar', ZONES.full, { group: 'punct' }),
  g('*', 'asterisk', ZONES.high, { group: 'punct' }),
  g('&', 'ampersand', ZONES.asc, { group: 'punct' }),
  g('#', 'numbersign', ZONES.asc, { group: 'symbol' }),
  g('%', 'percent', ZONES.asc, { group: 'symbol', parts: 3 }),
  g('@', 'at', ZONES.desc, { group: 'symbol' }),
  g('$', 'dollar', ZONES.full, { group: 'symbol' }),
  g('^', 'asciicircum', ZONES.high, { group: 'symbol' }),
  g('~', 'asciitilde', ZONES.mid, { group: 'symbol' }),
];

const CURRENCY = [
  g('€', 'Euro', ZONES.asc, { group: 'symbol' }),
  g('£', 'sterling', ZONES.asc, { group: 'symbol' }),
  g('¥', 'yen', ZONES.asc, { group: 'symbol' }),
  g('¢', 'cent', ZONES.asc, { group: 'symbol' }),
];

const MARKS = [
  g('©', 'copyright', ZONES.asc, { group: 'symbol' }),
  g('®', 'registered', ZONES.asc, { group: 'symbol' }),
  g('°', 'degree', ZONES.high, { group: 'symbol' }),
];

const MATH = [
  g('+', 'plus', ZONES.mid, { group: 'math', parts: 1 }),
  g('=', 'equal', ZONES.mid, { group: 'math', parts: 2 }),
  g('<', 'less', ZONES.mid, { group: 'math' }),
  g('>', 'greater', ZONES.mid, { group: 'math' }),
  g('×', 'multiply', ZONES.mid, { group: 'math' }),
  g('÷', 'divide', ZONES.mid, { group: 'math', parts: 3 }),
  g('±', 'plusminus', ZONES.mid, { group: 'math', parts: 2 }),
  g('≠', 'notequal', ZONES.mid, { group: 'math' }),
  g('≤', 'lessequal', ZONES.mid, { group: 'math', parts: 2 }),
  g('≥', 'greaterequal', ZONES.mid, { group: 'math', parts: 2 }),
  g('∞', 'infinity', ZONES.mid, { group: 'math' }),
  g('√', 'radical', ZONES.full, { group: 'math' }),
];

const ARROWS = [
  g('→', 'arrowright', ZONES.mid, { group: 'arrow' }),
  g('←', 'arrowleft', ZONES.mid, { group: 'arrow' }),
  g('↑', 'arrowup', ZONES.mid, { group: 'arrow' }),
  g('↓', 'arrowdown', ZONES.mid, { group: 'arrow' }),
];

/**
 * Glyphs we generate rather than ask for. Each names a source glyph and a
 * transform applied in font units. Keeping these out of the writing sheet is
 * the difference between ~110 characters to write and ~125.
 */
const DERIVED = [
  g('’', 'quoteright', ZONES.high, {
    group: 'derived', derive: { from: 'quotesingle', op: 'copy' },
  }),
  g('‘', 'quoteleft', ZONES.high, {
    group: 'derived', derive: { from: 'quotesingle', op: 'mirror' },
  }),
  g('”', 'quotedblright', ZONES.high, {
    group: 'derived', derive: { from: 'quotedbl', op: 'copy' },
  }),
  g('“', 'quotedblleft', ZONES.high, {
    group: 'derived', derive: { from: 'quotedbl', op: 'mirror' },
  }),
  g('…', 'ellipsis', ZONES.base, {
    group: 'derived', derive: { from: 'period', op: 'repeat', count: 3, gap: 0.55 },
  }),
  g('–', 'endash', ZONES.mid, {
    group: 'derived', derive: { from: 'hyphen', op: 'stretch', factor: 1.7 },
  }),
  g('—', 'emdash', ZONES.mid, {
    group: 'derived', derive: { from: 'hyphen', op: 'stretch', factor: 2.6 },
  }),
  g('−', 'minus', ZONES.mid, {
    group: 'derived', derive: { from: 'hyphen', op: 'stretch', factor: 1.25 },
  }),
];

/** Everything the user actually writes, in a deliberate order (see SHEETS). */
export const REQUIRED = [
  ...UPPER, ...LOWER, ...DIGITS, ...PUNCT, ...CURRENCY, ...MARKS, ...MATH, ...ARROWS,
];

export const DERIVED_GLYPHS = DERIVED;

/**
 * Ligatures — letter pairs written joined, as one shape.
 *
 * Optional, and worth the extra sheet only for a joined-up hand. When someone
 * writes cursive, 'th' is not a 't' beside an 'h'; it is one continuous stroke,
 * and setting it from two separate letters is the single most obvious tell that
 * a handwriting font is fake. Capturing the joined form and substituting it
 * through OpenType's `liga` feature fixes that at the source.
 *
 * The selection is the most frequent English digraphs, plus the two classic
 * typographic ligatures (fi, fl) where the ascender of the f otherwise collides
 * with the dot of the i.
 */
const LIGATURE_SEQS = [
  'th', 'he', 'in', 'er', 'an', 're', 'on', 'ed',
  'st', 'll', 'oo', 'ee', 'ff', 'tt', 'ss', 'ch',
  'fi', 'fl',
];

/** Vertical zone of a joined pair: the union of what its letters occupy. */
function ligatureZone(seq) {
  const zones = [...seq].map((c) => LOWER_ZONES[c] ?? ZONES.x);
  const tall = zones.some((z) => z === ZONES.asc || z === ZONES.full);
  const low = zones.some((z) => z === ZONES.desc || z === ZONES.full);
  if (tall && low) return ZONES.full;
  if (tall) return ZONES.asc;
  if (low) return ZONES.desc;
  return ZONES.x;
}

export const LIGATURES = LIGATURE_SEQS.map((seq) => ({
  ch: seq,
  seq,
  // The conventional PostScript name for a ligature joins its parts with
  // underscores, so 'th' becomes 't_h'.
  name: seq.split('').join('_'),
  zone: ligatureZone(seq),
  unicode: null,
  parts: 1,
  group: 'ligature',
  derive: null,
  isLigature: true,
  components: seq.split(''),
}));

/** Required + derived. `.notdef` and `space` are added by the font compiler. */
export const ALL_GLYPHS = [...REQUIRED, ...DERIVED];

/** Fast lookups. Ligatures are keyed by their whole sequence, e.g. 'th'. */
export const BY_CHAR = new Map([...ALL_GLYPHS, ...LIGATURES].map((e) => [e.ch, e]));
export const BY_NAME = new Map([...ALL_GLYPHS, ...LIGATURES].map((e) => [e.name, e]));

/**
 * The writing sheets.
 *
 * This is the heart of the "write on blank paper" flow. Because the app
 * dictates the exact sequence, segmentation never has to *recognise* anything —
 * it only has to find the ink and read it in order. That removes the entire
 * class of OCR errors, and it is why no printed grid or registration mark is
 * needed.
 *
 * Rows are kept to 13 cells so they stay legible on A4 and Letter alike, and
 * each row mixes zones (a tall letter, a short letter, a descender) so the
 * baseline solver always has constraints to work with on every single line.
 */
function chunk(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

const ROW = 13;

/**
 * The marks that turn letters into prose.
 *
 * These ride on the first sheet rather than with the rest of the punctuation,
 * because a set of letters with no full stop is not a font anyone can write a
 * sentence in — and the first sheet has to stand on its own. Six marks is about
 * half a row; the cost is nothing and it is the difference between "letters"
 * and "usable".
 */
const EVERYDAY_PUNCT = ['.', ',', "'", '-', '?', '!'];
const isEveryday = (e) => EVERYDAY_PUNCT.includes(e.ch);

/**
 * The sheets, in the order they are offered — and that order is the point.
 *
 * This used to open with the capitals and present four sheets as one
 * undifferentiated wall of about 112 characters. That is a single ask, and it
 * is the ask people decline: nothing works until all of it is done, so the
 * whole thing is a commitment made before any of it has paid off.
 *
 * So the first sheet is now a font on its own. Lowercase carries the ascenders
 * and descenders the baseline solver reads, which makes it both the most useful
 * sheet and the one that measures best; with six marks of punctuation added it
 * sets ordinary English. Thirty-two characters, one photograph, and something
 * installable at the end of it.
 *
 * `tier` says how each sheet is offered, not whether the app will build without
 * it — the app has always built from whatever it was given. What was missing
 * was anyone saying so.
 *
 *   essential    one photograph, and you have a working font
 *   recommended  most people will want these before they use it in earnest
 *   extra        worth it only if you type them
 */
export const SHEETS = [
  {
    id: 'everyday',
    title: 'Everyday letters',
    tier: 'essential',
    blurb: 'One photograph of this sheet is a working font.',
    hint: 'Let tall letters (b d f h k l) and tails (g p q y) run their natural length — the app reads your baseline from them. The six marks at the end are what let you write a sentence.',
    rows: chunk([...LOWER.map((e) => e.ch), ...EVERYDAY_PUNCT], ROW),
  },
  {
    id: 'capitals',
    title: 'Capitals',
    tier: 'recommended',
    blurb: 'Sentences start with these.',
    hint: 'Write each capital letter once, keeping a clear gap between them.',
    rows: chunk(UPPER.map((e) => e.ch), ROW),
  },
  {
    id: 'numbers',
    title: 'Numbers and the rest of the punctuation',
    tier: 'recommended',
    blurb: 'Dates, prices, brackets, quotes.',
    hint: 'Small marks matter. Write the colon and semicolon at their true size, not enlarged.',
    rows: [
      ...chunk(DIGITS.map((e) => e.ch), ROW),
      ...chunk(PUNCT.filter((e) => !isEveryday(e)).map((e) => e.ch), ROW),
    ],
  },
  {
    id: 'symbols',
    title: 'Symbols and maths',
    tier: 'extra',
    blurb: 'Currency, arrows, operators.',
    hint: 'Skip any you will never type — anything left blank simply falls back to the font behind yours.',
    rows: [
      ...chunk([...CURRENCY, ...MARKS].map((e) => e.ch), ROW),
      ...chunk([...MATH, ...ARROWS].map((e) => e.ch), ROW),
    ],
  },
];

/**
 * The optional joined-pairs sheet.
 *
 * Kept separate from SHEETS so the app can offer it as a skippable extra —
 * there is no point asking someone who prints their letters to write eighteen
 * cursive pairs they would never produce naturally.
 */
export const LIGATURE_SHEET = {
  id: 'ligatures',
  title: 'Joined pairs',
  optional: true,
  tier: 'extra',
  blurb: 'Only for joined-up handwriting.',
  hint: 'Only worth doing if your writing joins up. Write each pair as one continuous stroke, exactly as you would mid-word.',
  rows: chunk(LIGATURES.map((l) => l.seq), 6),
};

/** The flat write-order, matching how sheets are read: sheet → row → cell. */
export const WRITE_ORDER = SHEETS.flatMap((s) => s.rows.flat());

/**
 * Which sheet a character is written on.
 *
 * The health report needs this to tell "you have not written this yet" apart
 * from "the capture could not read what you wrote". Both look identical in the
 * glyph list — the character is simply absent — and they call for opposite
 * responses: one is a choice, the other is a fault worth going back for.
 *
 * Built once. Ligature pairs are excluded deliberately: they are sequences, not
 * characters, and never appear in REQUIRED.
 */
const SHEET_OF = new Map(
  SHEETS.flatMap((s) => s.rows.flat().map((ch) => [ch, s.id]))
);

/** @returns {string|undefined} sheet id, or undefined for a derived glyph. */
export const sheetOf = (ch) => SHEET_OF.get(ch);

/** Sanity check: every required glyph appears on exactly one sheet. */
export function auditSheets() {
  const seen = new Map();
  for (const ch of WRITE_ORDER) seen.set(ch, (seen.get(ch) || 0) + 1);
  const missing = REQUIRED.filter((e) => !seen.has(e.ch)).map((e) => e.name);
  const duplicated = [...seen.entries()].filter(([, n]) => n > 1).map(([ch]) => ch);
  const unknown = [...seen.keys()].filter((ch) => !BY_CHAR.has(ch));
  return { missing, duplicated, unknown, ok: !missing.length && !duplicated.length && !unknown.length };
}

/**
 * Sample strings used by the live preview. Chosen to exercise the pairs that
 * expose bad spacing fastest: round-to-round (oo), diagonal-to-round (Av),
 * overhang-to-dot (r.), and ascender collisions (fl, ffi).
 */
export const PREVIEW_SAMPLES = [
  'The quick brown fox jumps over the lazy dog.',
  'Waltz, bad nymph, for quick jigs vex! 0123456789',
  'AVATAR To Wave off; r. f) y, {x} [1] — 100% @ €35',
  'Handwriting that actually feels handwritten.',
];

export const COUNTS = {
  required: REQUIRED.length,
  derived: DERIVED.length,
  total: ALL_GLYPHS.length + 2, // + .notdef + space
};
