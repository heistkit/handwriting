/**
 * The whole pipeline, on a synthetic page, with no browser.
 *
 * Every other suite here checks one function. That leaves the seams untested,
 * and the seams are where this app actually breaks: a fractional width crossing
 * from the pad into the raster, a bitmap whose bounds convention shifts by one
 * between the segmenter and the metrics solver, a contour direction that only
 * matters once it reaches the CFF writer. None of those show up in a unit test
 * because each function is individually correct.
 *
 * So this builds a page of ink the way a photograph would arrive after
 * binarisation, and runs it the whole way down:
 *
 *     page bitmap → segmentSheet → extractGlyph → vectorize
 *                 → buildMetrics → compile → serialise
 *                 → parse the bytes back with opentype.js
 *
 * The last step is the one that makes this worth running. A font file that
 * assembles without throwing is not a font file that works; the proof is that
 * an independent parser reads it back and finds the characters where the cmap
 * says they are. opentype.js is already vendored for writing, and reading with
 * it is a genuinely separate code path from writing with it.
 *
 * preprocess() is the one stage skipped, because it needs a canvas. It is also
 * the stage whose output shape is simplest to state — a Uint8Array of 0 and 1,
 * ink set — so the page is constructed in that form directly.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass });
  console.log(`  ${pass ? 'ok  ' : 'FAIL'} ${name}${detail && !pass ? ` — ${detail}` : ''}`);
};

// ---------------------------------------------------------------------------
// A page of ink
// ---------------------------------------------------------------------------

/**
 * Letterforms as stroke paths in a unit box, y down, baseline at y = 1.
 *
 * Deliberately crude: this is not testing that the shapes are pretty, it is
 * testing that shapes with the right *proportions* survive the trip. What has
 * to be right is the vertical structure — an x-height letter, an ascender, a
 * descender and a capital in the same row — because that is what the baseline
 * solver reads, and getting it wrong is how a row ends up unsolved.
 */
const STROKES = {
  //          x-height body only
  o: [[[0.5, 0.5], [0.85, 0.72], [0.5, 1.0], [0.15, 0.72], [0.5, 0.5]]],
  c: [[[0.85, 0.6], [0.4, 0.5], [0.15, 0.75], [0.4, 1.0], [0.85, 0.92]]],
  //          ascender
  l: [[[0.5, 0.05], [0.5, 1.0]]],
  h: [[[0.25, 0.05], [0.25, 1.0]], [[0.25, 0.62], [0.6, 0.5], [0.78, 0.72], [0.78, 1.0]]],
  //          descender
  p: [[[0.25, 0.5], [0.25, 1.45]], [[0.25, 0.6], [0.6, 0.5], [0.82, 0.75], [0.5, 1.0], [0.25, 0.92]]],
  y: [[[0.18, 0.5], [0.5, 1.0]], [[0.86, 0.5], [0.3, 1.45]]],
  //          capital
  A: [[[0.1, 1.0], [0.5, 0.08], [0.9, 1.0]], [[0.24, 0.72], [0.76, 0.72]]],
  T: [[[0.1, 0.08], [0.9, 0.08]], [[0.5, 0.08], [0.5, 1.0]]],
};

/** Stamp a filled disc of radius r into a binary page. */
function disc(bin, w, h, cx, cy, r) {
  const r2 = r * r;
  for (let y = Math.max(0, Math.floor(cy - r)); y <= Math.min(h - 1, Math.ceil(cy + r)); y++) {
    for (let x = Math.max(0, Math.floor(cx - r)); x <= Math.min(w - 1, Math.ceil(cx + r)); x++) {
      const dx = x - cx, dy = y - cy;
      if (dx * dx + dy * dy <= r2) bin[y * w + x] = 1;
    }
  }
}

/** Stamp a polyline as a run of discs — a pen, essentially. */
function stroke(bin, w, h, pts, r) {
  for (let i = 1; i < pts.length; i++) {
    const [ax, ay] = pts[i - 1], [bx, by] = pts[i];
    const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / (r * 0.4)));
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      disc(bin, w, h, ax + (bx - ax) * t, ay + (by - ay) * t, r);
    }
  }
}

/**
 * Draw `rows` of characters onto a page, laid out the way the printable sheet
 * lays them out: even columns, generous gaps, one row band per row.
 *
 * @returns {{bin: Uint8Array, w: number, h: number}}
 */
function drawPage(rows, { w = 1400, h = 1800, pen = 5 } = {}) {
  const bin = new Uint8Array(w * h);
  const top = 200;
  const rowH = (h - 400) / rows.length;
  const em = Math.min(rowH * 0.44, 130);

  rows.forEach((row, ri) => {
    const baseline = top + rowH * ri + rowH * 0.6;
    const colW = w / (row.length + 1);
    row.forEach((ch, ci) => {
      const paths = STROKES[ch];
      if (!paths) return;
      const originX = colW * (ci + 1) - em * 0.5;
      // y = 1 in the unit box is the baseline.
      const originY = baseline - em;
      for (const p of paths) {
        stroke(bin, w, h, p.map(([ux, uy]) => [originX + ux * em, originY + uy * em]), pen);
      }
    });
  });

  return { bin, w, h };
}

// ---------------------------------------------------------------------------

export async function run() {
  console.log('\nend to end');

  // opentype.js is a UMD bundle the browser loads with a script tag; fontbuild
  // reads it off globalThis, so give it the same handle Node-side.
  const here = dirname(fileURLToPath(import.meta.url));
  const opentype = (await import('../vendor/opentype.js')).default;
  globalThis.opentype = opentype;

  const { segmentSheet, extractGlyph } = await import('../src/segment.js');
  const { labelComponents } = await import('../src/imageproc.js');
  const { vectorize } = await import('../src/trace.js');
  const { compile, serialise } = await import('../src/pipeline.js');
  const { analyse } = await import('../src/health.js');

  const rows = [
    ['o', 'c', 'l', 'h', 'p', 'y'],
    ['A', 'T', 'o', 'c', 'l', 'h'],
  ];
  const page = drawPage(rows);

  // --- segmentation finds the grid -----------------------------------------
  const seg = segmentSheet(page.bin, page.w, page.h, rows);
  check('the page splits into the rows that were drawn',
    seg.rows.length === rows.length, `${seg.rows.length} rows`);

  const expected = rows.flat().length;
  check('every character is accounted for',
    seg.stats.total === expected, `total=${seg.stats.total}, expected ${expected}`);
  check('and every one of them was found',
    seg.stats.found === expected, `found=${seg.stats.found} of ${expected}`);

  // --- extraction and tracing ----------------------------------------------
  const { labels } = labelComponents(page.bin, page.w, page.h);
  const cells = seg.rows.flatMap((r) => r.cells).filter((c) => !c.missing);
  const glyphs = [];
  for (const cell of cells) {
    const extracted = extractGlyph(page.bin, labels, page.w, page.h, cell);
    if (!extracted) continue;
    const { contours } = vectorize(extracted.bitmap, extracted.w, extracted.h);
    if (!contours.length) continue;
    glyphs.push({ ...extracted, contours, row: cell.row, col: cell.col, sheetId: 'synthetic' });
  }
  check('every found cell traced to at least one contour',
    glyphs.length === expected, `${glyphs.length} of ${expected}`);

  // The letters carry real vertical structure, and losing it is the failure
  // that produces a font whose letters sit at different heights.
  {
    // Row 0 only. page.y0/y1 are absolute page coordinates, so comparing a
    // letter in row 0 against one in row 1 compares where the rows are, not
    // how tall the letters are.
    const byChar = new Map(glyphs.filter((g) => g.row === 0).map((g) => [g.ch, g]));
    const o = byChar.get('o'), l = byChar.get('l'), p = byChar.get('p');
    check('an ascender is taller than an x-height letter',
      l && o && l.h > o.h * 1.4, `l.h=${l?.h}, o.h=${o?.h}`);
    check('a descender reaches below an x-height letter',
      p && o && p.page.y1 > o.page.y1, `p.y1=${p?.page.y1}, o.y1=${o?.page.y1}`);
  }

  // --- compile --------------------------------------------------------------
  const family = compile(glyphs, { familyName: 'Test Hand', variantCount: 3 });
  check('the family compiles to four styles', family.styles.length === 4,
    `${family.styles.length}`);

  const built = serialise(family);
  check('every style serialises to bytes',
    built.length === 4 && built.every((s) => s.otf && s.otf.byteLength > 1000),
    built.map((s) => `${s.style}:${s.otf?.byteLength}`).join(' '));

  // --- and the bytes are a font an independent parser accepts ---------------
  {
    const regular = built.find((s) => !s.italic && s.weightClass < 700);
    // finalise() may hand back either an ArrayBuffer or a view over one, and
    // opentype.parse wants a plain ArrayBuffer starting at byte zero.
    const bytes = regular.otf;
    const buffer = bytes instanceof ArrayBuffer
      ? bytes
      : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    const font = opentype.parse(buffer);

    check('the file parses back as a font', !!font && font.unitsPerEm === 1000,
      `unitsPerEm=${font?.unitsPerEm}`);
    check('it carries the family name it was given',
      font.names.fontFamily?.en === 'Test Hand', JSON.stringify(font.names.fontFamily));

    // The point of the round trip: the cmap really maps the characters that
    // were written, rather than the compiler having merely not thrown.
    const written = [...new Set(rows.flat())];
    const unmapped = written.filter((ch) => font.charToGlyphIndex(ch) === 0);
    check('every character written is reachable through the cmap',
      unmapped.length === 0, `unmapped: ${unmapped.join(' ')}`);

    // A mapped glyph with an empty outline is the silent version of a missing
    // one: it takes up space and draws nothing.
    const empty = written.filter((ch) => {
      const g = font.charToGlyph(ch);
      return !g || !g.path || g.path.commands.length === 0;
    });
    check('and every one of them has an outline', empty.length === 0,
      `empty: ${empty.join(' ')}`);

    // Advance widths have to be positive or typed text collapses on itself.
    const badAdvance = written.filter((ch) => !(font.charToGlyph(ch).advanceWidth > 0));
    check('and a positive advance width', badAdvance.length === 0,
      `zero advance: ${badAdvance.join(' ')}`);

    check('the variant substitution table is present', !!font.tables.gsub);
    check('the vertical metrics are the right way round',
      font.ascender > 0 && font.descender < 0, `${font.ascender} / ${font.descender}`);
  }

  // --- the health report survives a real build ------------------------------
  {
    // The same three arguments the app passes: what came off the page, what the
    // metrics stage made of it, and the solved rows. Fed from a real compile
    // rather than a fixture, which is the only way the zone and resolution
    // checks meet shapes they did not have hand-written for them.
    const { glyphs: normalized, rows: solvedRows } = family.metrics;
    const report = analyse(glyphs, normalized, solvedRows);

    check('the health report runs on a real build without throwing', !!report);
    check('and returns a score in range',
      typeof report.score === 'number' && report.score >= 0 && report.score <= 100,
      String(report?.score));
    // `captured` counts distinct characters; this page writes 'o', 'c', 'l' and
    // 'h' twice each to give the second row something to solve against.
    const distinct = new Set(rows.flat()).size;
    check('and counts the distinct characters that were built',
      report.captured === distinct, `${report.captured} vs ${distinct}`);
    // A clean synthetic page is not a photograph, so it should not be told it
    // was taken from too far away.
    check('and does not warn about resolution on a clean page',
      !report.findings.some((f) => f.code === 'low-resolution'),
      report.findings.map((f) => f.code).join(', '));
  }

  return results;
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}`) {
  run();
}
