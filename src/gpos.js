/**
 * gpos.js — a GPOS kerning table, written by hand.
 *
 * opentype.js can read GPOS but not write it, so this builds the bytes
 * directly. The interesting decision is the subtable format.
 *
 * The obvious choice is PairPos format 1, an explicit list of glyph pairs. It
 * breaks here, because of variants: once `calt` has swapped an 'A' for
 * 'A.alt2', a kern pair recorded against plain 'A' no longer matches anything.
 * Every pair would have to be written out for all nine combinations of three
 * variants on each side, and the table would grow ninefold — straight toward
 * the 64 KB ceiling that 16-bit offsets impose.
 *
 * Format 2 kerns *classes* rather than glyphs, so all three variants of 'A'
 * join one class and the ninefold blow-up disappears. The cost is that the
 * table is a dense matrix of every left class against every right class, but at
 * two bytes a cell that is roughly 13 KB for a full alphabet, and it means
 * kerning keeps working no matter which variant the shaper picks.
 */

import { Writer } from './sfnt.js';

const VALUE_FORMAT_X_ADVANCE = 0x0004;

/**
 * ClassDef format 1: a class number for every glyph in one contiguous run.
 *
 * Format 2 (ranges) would be smaller if classes happened to be contiguous, but
 * base glyphs and their variants sit in separate blocks of the glyph order, so
 * ranges would fragment badly. A flat array over the whole font is both simpler
 * and, at two bytes per glyph, smaller in practice.
 */
function writeClassDef(classByGlyph, glyphCount) {
  const w = new Writer(glyphCount * 2 + 8);
  w.u16(1); // classFormat
  w.u16(0); // startGlyphID
  w.u16(glyphCount);
  for (let g = 0; g < glyphCount; g++) w.u16(classByGlyph.get(g) ?? 0);
  return w.bytes();
}

/** Coverage format 1: an ascending list of glyph ids. */
function writeCoverage(glyphs) {
  const sorted = [...new Set(glyphs)].sort((a, b) => a - b);
  const w = new Writer(sorted.length * 2 + 4);
  w.u16(1);
  w.u16(sorted.length);
  for (const g of sorted) w.u16(g);
  return w.bytes();
}

/**
 * Build the whole GPOS table.
 *
 * @param {Array<{left:number,right:number,value:number}>} pairs  glyph indices
 * @param {object} opts
 * @param {number} opts.glyphCount
 * @param {Map<number,string>} opts.groupOf  glyph index → class key, so that a
 *        glyph and all of its variants share one key and therefore one class
 * @returns {Uint8Array|null}
 */
export function buildGposKerning(pairs, { glyphCount, groupOf }) {
  if (!pairs || !pairs.length) return null;

  const keyOf = (g) => groupOf.get(g) ?? `#${g}`;

  // Assign class numbers. Class 0 is reserved for "everything else", which is
  // what an unlisted glyph falls into.
  const leftClass = new Map(); // key → class number
  const rightClass = new Map();
  for (const p of pairs) {
    const lk = keyOf(p.left);
    const rk = keyOf(p.right);
    if (!leftClass.has(lk)) leftClass.set(lk, leftClass.size + 1);
    if (!rightClass.has(rk)) rightClass.set(rk, rightClass.size + 1);
  }

  const class1Count = leftClass.size + 1;
  const class2Count = rightClass.size + 1;

  // Every glyph sharing a group key gets that group's class, which is what
  // extends kerning to variants for free.
  const class1ByGlyph = new Map();
  const class2ByGlyph = new Map();
  for (let g = 0; g < glyphCount; g++) {
    const k = keyOf(g);
    if (leftClass.has(k)) class1ByGlyph.set(g, leftClass.get(k));
    if (rightClass.has(k)) class2ByGlyph.set(g, rightClass.get(k));
  }

  // Dense value matrix.
  const matrix = new Int16Array(class1Count * class2Count);
  for (const p of pairs) {
    const c1 = leftClass.get(keyOf(p.left));
    const c2 = rightClass.get(keyOf(p.right));
    if (!c1 || !c2) continue;
    matrix[c1 * class2Count + c2] = Math.max(-32768, Math.min(32767, Math.round(p.value)));
  }

  // Coverage must list every glyph that can begin a pair — variants included,
  // otherwise the lookup is never even entered for a substituted glyph.
  const covered = [];
  for (const [g, c] of class1ByGlyph) if (c) covered.push(g);
  const coverage = writeCoverage(covered);
  const classDef1 = writeClassDef(class1ByGlyph, glyphCount);
  const classDef2 = writeClassDef(class2ByGlyph, glyphCount);

  // --- PairPos format 2 -----------------------------------------------------
  const matrixBytes = class1Count * class2Count * 2;
  const pairPosHeader = 16;
  const covOffset = pairPosHeader + matrixBytes;
  const cd1Offset = covOffset + coverage.length;
  const cd2Offset = cd1Offset + classDef1.length;
  const pairPosLength = cd2Offset + classDef2.length;

  if (pairPosLength > 0xffff) {
    // 16-bit offsets cannot address past this. Rather than emit a corrupt
    // table, drop kerning; the perceptual side bearings still carry the font.
    return null;
  }

  const pp = new Writer(pairPosLength);
  pp.u16(2);                         // posFormat
  pp.u16(covOffset);
  pp.u16(VALUE_FORMAT_X_ADVANCE);    // valueFormat1 — adjust the left glyph
  pp.u16(0);                         // valueFormat2 — nothing on the right
  pp.u16(cd1Offset);
  pp.u16(cd2Offset);
  pp.u16(class1Count);
  pp.u16(class2Count);
  for (let i = 0; i < matrix.length; i++) pp.i16(matrix[i]);
  const ppBytes = new Uint8Array(pairPosLength);
  ppBytes.set(pp.bytes(), 0);
  ppBytes.set(coverage, covOffset);
  ppBytes.set(classDef1, cd1Offset);
  ppBytes.set(classDef2, cd2Offset);

  // --- Lookup ---------------------------------------------------------------
  const lookup = new Writer(8 + ppBytes.length);
  lookup.u16(2); // lookupType: pair adjustment
  lookup.u16(0); // lookupFlag
  lookup.u16(1); // subTableCount
  lookup.u16(8); // subtable offset, from the start of this Lookup
  const lookupBytes = concat([lookup.bytes(), ppBytes]);

  // --- LookupList -----------------------------------------------------------
  const lookupList = new Writer(4);
  lookupList.u16(1); // lookupCount
  lookupList.u16(4); // offset to lookup 0
  const lookupListBytes = concat([lookupList.bytes(), lookupBytes]);

  // --- FeatureList ----------------------------------------------------------
  const featureList = new Writer(16);
  featureList.u16(1);      // featureCount
  featureList.tag('kern');
  featureList.u16(8);      // offset to the Feature table
  featureList.u16(0);      // featureParams
  featureList.u16(1);      // lookupIndexCount
  featureList.u16(0);      // lookupListIndices[0]
  const featureListBytes = featureList.bytes();

  // --- ScriptList -----------------------------------------------------------
  // DFLT covers everything; latn is listed as well because some older shapers
  // will not fall back to DFLT when the run is tagged Latin.
  const scripts = ['DFLT', 'latn'];
  const scriptListHeader = 2 + scripts.length * 6;
  const scriptTableSize = 12;
  const sl = new Writer(scriptListHeader + scripts.length * scriptTableSize);
  sl.u16(scripts.length);
  scripts.forEach((tag, i) => {
    sl.tag(tag);
    sl.u16(scriptListHeader + i * scriptTableSize);
  });
  for (let i = 0; i < scripts.length; i++) {
    sl.u16(4);       // defaultLangSys offset, from this Script table
    sl.u16(0);       // langSysCount
    sl.u16(0);       // lookupOrder
    sl.u16(0xffff);  // requiredFeatureIndex — none
    sl.u16(1);       // featureIndexCount
    sl.u16(0);       // featureIndices[0]
  }
  const scriptListBytes = sl.bytes();

  // --- GPOS header ----------------------------------------------------------
  const headerSize = 10;
  const scriptOffset = headerSize;
  const featureOffset = scriptOffset + scriptListBytes.length;
  const lookupOffset = featureOffset + featureListBytes.length;

  const header = new Writer(headerSize);
  header.u16(1); // majorVersion
  header.u16(0); // minorVersion
  header.u16(scriptOffset);
  header.u16(featureOffset);
  header.u16(lookupOffset);

  return concat([header.bytes(), scriptListBytes, featureListBytes, lookupListBytes]);
}

function concat(chunks) {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
}

/**
 * Map every glyph index to the class key it should kern as.
 *
 * A variant kerns exactly as its parent does, which is the whole reason the
 * class-based format was chosen.
 */
export function buildGroupMap(defs, index) {
  const groupOf = new Map();
  for (const def of defs.values()) {
    const i = index.get(def.name);
    if (i == null) continue;
    groupOf.set(i, def.variantOf ?? def.name);
  }
  return groupOf;
}
