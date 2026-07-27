/**
 * End-to-end font binary checks.
 *
 * The strongest verification available without installing the font: build it,
 * then hand the bytes straight back to opentype.js's *parser* and confirm every
 * structure survives the round trip. The parser is completely independent of
 * the writing path — and for GPOS it is the only implementation involved at
 * all, since those bytes are written by hand in gpos.js — so agreement between
 * the two is real evidence rather than a tautology.
 */

import { createRequire } from 'node:module';
import { buildFamily, buildGsub, buildGlyphDefs, embolden, slant, boundsOf } from '../src/fontbuild.js';
import { buildGposKerning, buildGroupMap } from '../src/gpos.js';
import { finalise, readTables } from '../src/sfnt.js';
import { UNITS_PER_EM, TARGET_X_HEIGHT } from '../src/metrics.js';

const require = createRequire(import.meta.url);
globalThis.opentype = require('../vendor/opentype.js');

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`  [${pass ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}`);
}

// ---------------------------------------------------------------------------
// Synthetic glyphs
// ---------------------------------------------------------------------------

/** A rectangle as four cubic segments, wound counter-clockwise (y-up). */
function boxContour(x0, y0, x1, y1) {
  const pts = [
    [x0, y0], [x1, y0], [x1, y1], [x0, y1],
  ].map(([x, y]) => ({ x, y }));

  const curves = [];
  for (let i = 0; i < 4; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % 4];
    curves.push([
      { ...a },
      { x: a.x + (b.x - a.x) / 3, y: a.y + (b.y - a.y) / 3 },
      { x: a.x + (2 * (b.x - a.x)) / 3, y: a.y + (2 * (b.y - a.y)) / 3 },
      { ...b },
    ]);
  }
  return { closed: true, outer: true, curves };
}

function makeGlyph(ch, { width = 400, height = TARGET_X_HEIGHT, lsb = 60, rsb = 60 } = {}) {
  const contours = [boxContour(0, 0, width, height)];
  const ys = [], left = [], right = [];
  for (let i = 0; i <= 40; i++) {
    ys.push((i / 40) * height);
    left.push(0);
    right.push(width);
  }
  return {
    ch, row: 0, col: 0, contours,
    ink: { x0: 0, y0: 0, x1: width, y1: height },
    inkWidth: width,
    lsb, rsb,
    advanceWidth: lsb + width + rsb,
    profiles: { ys, left, right },
  };
}

const LETTERS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'.split('');

export async function run() {
  console.log('\nfontbuild.js + gpos.js + sfnt.js');

  const glyphs = LETTERS.map((ch, i) =>
    makeGlyph(ch, { width: 340 + (i % 7) * 20, lsb: 50 + (i % 3) * 10 })
  );
  const spacing = { target: 150, ascender: TARGET_X_HEIGHT * 1.5, descender: -TARGET_X_HEIGHT * 0.4 };
  const kerning = [
    { left: glyphs[0], right: glyphs[1], value: -42 },  // a / b
    { left: glyphs[2], right: glyphs[3], value: 31 },   // c / d
    { left: glyphs[26], right: glyphs[27], value: -75 },// A / B
  ];

  // -- 1. Geometry transforms ----------------------------------------------
  {
    const c = [boxContour(0, 0, 200, 400)];
    const before = boundsOf(c);
    const after = boundsOf(embolden(c, 20));
    check(
      'embolden grows the outline outward',
      after.x0 < before.x0 - 5 && after.x1 > before.x1 + 5 &&
      after.y0 < before.y0 - 5 && after.y1 > before.y1 + 5,
      `${before.x1 - before.x0} wide → ${(after.x1 - after.x0).toFixed(1)}`
    );

    const sheared = boundsOf(slant(c, 11, TARGET_X_HEIGHT / 2));
    // Pivoting mid-band means the top goes right and the bottom goes left, so
    // the horizontal centre should barely move.
    const centreBefore = (before.x0 + before.x1) / 2;
    const centreAfter = (sheared.x0 + sheared.x1) / 2;
    check(
      'slant keeps the horizontal centre put',
      Math.abs(centreAfter - centreBefore) < 12,
      `centre ${centreBefore.toFixed(1)} → ${centreAfter.toFixed(1)}`
    );
  }

  // -- 2. Family assembly ---------------------------------------------------
  const family = buildFamily(glyphs, spacing, kerning, { familyName: 'Test Hand' });
  check('four styles built', family.styles.length === 4, family.styles.map((s) => s.style).join(', '));

  const regular = family.styles[0];
  const bold = family.styles[1];

  check(
    'variants generated for every letter',
    [...family.defs.values()].filter((d) => d.variantOf).length === LETTERS.length * 2,
    `${[...family.defs.values()].filter((d) => d.variantOf).length} variant glyphs`
  );

  // -- 3. Serialise, inject GPOS, re-parse ----------------------------------
  let parsed;
  {
    const groupOf = buildGroupMap(family.defs, regular.index);
    const gpos = buildGposKerning(regular.kerning, {
      glyphCount: regular.order.length,
      groupOf,
    });
    check('GPOS bytes produced', !!gpos && gpos.length > 20, `${gpos ? gpos.length : 0} bytes`);

    const raw = regular.font.toArrayBuffer();
    const finished = finalise(raw, { gpos, bold: false, italic: false, italicAngle: 0 });

    const { tables } = readTables(finished);
    check('GPOS present in the table directory', tables.has('GPOS'));
    check('GSUB present in the table directory', tables.has('GSUB'));
    check('CFF outlines (not glyf)', tables.has('CFF '), [...tables.keys()].sort().join(' '));

    try {
      parsed = globalThis.opentype.parse(finished);
      check('font re-parses cleanly', true);
    } catch (err) {
      check('font re-parses cleanly', false, err.message);
    }
  }

  if (!parsed) return results;

  // -- 4. Structure survived ------------------------------------------------
  {
    check(
      'glyph count preserved',
      parsed.glyphs.length === regular.order.length,
      `${parsed.glyphs.length} of ${regular.order.length}`
    );
    check('unitsPerEm preserved', parsed.unitsPerEm === UNITS_PER_EM, `${parsed.unitsPerEm}`);

    const gi = parsed.charToGlyphIndex('a');
    check('cmap maps "a" correctly', gi === regular.index.get('a'), `index ${gi} vs ${regular.index.get('a')}`);

    const glyphA = parsed.glyphs.get(gi);
    const expectedAdvance = Math.round(glyphs[0].lsb + glyphs[0].inkWidth + glyphs[0].rsb);
    check(
      'advance width preserved',
      Math.abs(glyphA.advanceWidth - expectedAdvance) <= 1,
      `${glyphA.advanceWidth} vs ${expectedAdvance}`
    );
    check(
      'outline survived (glyph has a path)',
      glyphA.path.commands.length >= 5,
      `${glyphA.path.commands.length} commands`
    );
    check('space glyph exists', parsed.charToGlyphIndex(' ') === regular.index.get('space'));
  }

  // -- 5. GSUB round trip ---------------------------------------------------
  {
    const gsub = parsed.tables.gsub;
    check('GSUB parsed back', !!gsub && !!gsub.lookups, gsub ? `${gsub.lookups.length} lookups` : 'missing');
    if (gsub) {
      const calt = gsub.features?.find((f) => f.tag === 'calt');
      check('calt feature present', !!calt);
      check(
        'chaining lookup is type 6 format 3',
        gsub.lookups[2]?.lookupType === 6 && gsub.lookups[2]?.subtables?.[0]?.substFormat === 3,
        `type ${gsub.lookups[2]?.lookupType}, format ${gsub.lookups[2]?.subtables?.[0]?.substFormat}`
      );
      check(
        'two chaining subtables (default→alt1, alt1→alt2)',
        gsub.lookups[2]?.subtables?.length === 2,
        `${gsub.lookups[2]?.subtables?.length} subtables`
      );
      // The single-substitution lookups must map each default onto a real
      // variant, or the cycle would substitute glyphs that do not exist.
      const sub0 = gsub.lookups[0]?.subtables?.[0];
      const maxIndex = regular.order.length - 1;
      const inRange = sub0?.substitute?.every((s) => s > 0 && s <= maxIndex);
      check('variant substitutions point at real glyphs', !!inRange);
    }
  }

  // -- 6. GPOS round trip ---------------------------------------------------
  {
    const gpos = parsed.tables.gpos;
    check('GPOS parsed back', !!gpos && !!gpos.lookups, gpos ? `${gpos.lookups.length} lookups` : 'missing');

    const aIdx = parsed.charToGlyphIndex('a');
    const bIdx = parsed.charToGlyphIndex('b');
    const cIdx = parsed.charToGlyphIndex('c');
    const dIdx = parsed.charToGlyphIndex('d');
    const kernLookups = parsed.position.getKerningTables('latn', 'dflt');
    const ab = parsed.position.getKerningValue(kernLookups, aIdx, bIdx);
    const cd = parsed.position.getKerningValue(kernLookups, cIdx, dIdx);

    check('kern a/b round-tripped', ab === -42, `got ${ab}, expected -42`);
    check('kern c/d round-tripped', cd === 31, `got ${cd}, expected 31`);

    // The point of class-based kerning: a variant inherits its parent's value.
    const altB = regular.index.get('b.alt1');
    const abAlt = parsed.position.getKerningValue(kernLookups, aIdx, altB);
    check(
      'variants inherit their parent kerning',
      abAlt === -42,
      `a / b.alt1 = ${abAlt}, expected -42`
    );

    const unrelated = parsed.position.getKerningValue(kernLookups, aIdx, dIdx);
    check('unkerned pairs stay at zero', !unrelated, `a / d = ${unrelated}`);
  }

  // -- 7. Style flags -------------------------------------------------------
  {
    const rawBold = bold.font.toArrayBuffer();
    const finishedBold = finalise(rawBold, { bold: true, italic: false, italicAngle: 0 });
    const p = globalThis.opentype.parse(finishedBold);
    check('bold declares weight 700', p.tables.os2.usWeightClass === 700, `${p.tables.os2.usWeightClass}`);
    check('bold sets head.macStyle bit 0', (p.tables.head.macStyle & 0x01) === 1, `macStyle ${p.tables.head.macStyle}`);
    check(
      'bold is visibly heavier than regular',
      p.glyphs.get(p.charToGlyphIndex('a')).advanceWidth >
        parsed.glyphs.get(parsed.charToGlyphIndex('a')).advanceWidth,
      `${p.glyphs.get(p.charToGlyphIndex('a')).advanceWidth} vs ${parsed.glyphs.get(parsed.charToGlyphIndex('a')).advanceWidth}`
    );

    const italic = family.styles[2];
    const finishedItalic = finalise(italic.font.toArrayBuffer(), {
      bold: false, italic: true, italicAngle: -11,
    });
    const pi = globalThis.opentype.parse(finishedItalic);
    check('italic sets head.macStyle bit 1', (pi.tables.head.macStyle & 0x02) === 2, `macStyle ${pi.tables.head.macStyle}`);
    check('italic declares its angle in post', pi.tables.post.italicAngle === -11, `${pi.tables.post.italicAngle}`);
    check('italic fsSelection bit 0 set', (pi.tables.os2.fsSelection & 0x01) === 1, `fsSelection ${pi.tables.os2.fsSelection}`);
  }

  // -- embolden thickens, whichever way the contour was wound ---------------
  {
    // The bug this pins: embolden assumed outer contours run counter-clockwise
    // in font space. They do not — the tracer walks the boundary with y
    // downward and normalizeGlyph flips y, which reverses winding — so every
    // offset pointed inward and the function eroded. The Bold style of every
    // font this app exported was THINNER than its Regular.
    //
    // Direction is now taken from the largest contour, so the test runs the
    // same square both ways round and demands growth from both.
    const { embolden, boundsOf } = await import('../src/fontbuild.js');

    const square = (ccw) => {
      const pts = [
        { x: 100, y: 100 }, { x: 300, y: 100 }, { x: 300, y: 400 }, { x: 100, y: 400 },
      ];
      const order = ccw ? pts : [...pts].reverse();
      const curves = order.map((p, i) => {
        const q = order[(i + 1) % order.length];
        return [
          { ...p },
          { x: p.x + (q.x - p.x) / 3, y: p.y + (q.y - p.y) / 3 },
          { x: p.x + (2 * (q.x - p.x)) / 3, y: p.y + (2 * (q.y - p.y)) / 3 },
          { ...q },
        ];
      });
      return [{ curves }];
    };

    for (const ccw of [true, false]) {
      const before = boundsOf(square(ccw));
      const after = boundsOf(embolden(square(ccw), 20));
      const grewX = (after.x1 - after.x0) - (before.x1 - before.x0);
      const grewY = (after.y1 - after.y0) - (before.y1 - before.y0);
      check(`embolden grows a ${ccw ? 'counter-clockwise' : 'clockwise'} contour`,
        grewX > 0 && grewY > 0, `width ${grewX.toFixed(1)}, height ${grewY.toFixed(1)}`);
    }

    // And a negative amount still thins, so the sign keeps its meaning.
    const thinned = boundsOf(embolden(square(false), -10));
    const plain = boundsOf(square(false));
    check('a negative amount still thins',
      (thinned.x1 - thinned.x0) < (plain.x1 - plain.x0),
      `${(thinned.x1 - thinned.x0).toFixed(1)} vs ${(plain.x1 - plain.x0).toFixed(1)}`);
  }

  return results;
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}`) run();
