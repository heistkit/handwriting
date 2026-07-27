/**
 * Tests for pairing bands of ink to rows of expected characters.
 *
 * This is the step where a small mistake becomes a large one. Bands are paired
 * to rows by position — band 0 is row 0 — so an extra band at the top does not
 * cost you that band, it costs you the *labels* on everything below it. A
 * capitals sheet photographed with one stray mark above the writing produced a
 * font in which A was compiled as N, B as O, and so on down the alphabet: not a
 * font with a flaw, a font in which every key types the wrong letter.
 *
 * The property being defended is that the number of bands is reconciled against
 * what the sheet asked for *before* anything is paired, and that a band holding
 * one mark is never treated as a row that should hold thirteen.
 *
 * None of this recognises a letter. It counts marks, which the sheet already
 * told us the number of.
 */

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass });
  console.log(`  ${pass ? 'ok  ' : 'FAIL'} ${name}${detail && !pass ? ` — ${detail}` : ''}`);
};

const W = 1300;
const H = 900;

/** Stamp a filled rectangle of ink. */
function box(bin, x0, y0, x1, y1) {
  for (let y = Math.max(0, y0); y < Math.min(H, y1); y++) {
    for (let x = Math.max(0, x0); x < Math.min(W, x1); x++) bin[y * W + x] = 1;
  }
}

/**
 * A row of `n` separated marks centred on `cy`.
 *
 * Blocks rather than letterforms: this file is testing which band a mark lands
 * in and how many marks a band holds, and a rectangle answers both exactly.
 */
function inkRow(bin, cy, n, { height = 70, gap = 30 } = {}) {
  const width = Math.floor((W - gap * (n + 1)) / n);
  for (let i = 0; i < n; i++) {
    const x0 = gap + i * (width + gap);
    box(bin, x0, cy - height / 2, x0 + width, cy + height / 2);
  }
}

const ALPHA = 'ABCDEFGHIJKLM'.split('');
const BETA = 'NOPQRSTUVWXYZ'.split('');

export async function run() {
  console.log('\nsegment.js');

  const { segmentSheet } = await import('../src/segment.js');

  /** Which characters actually got ink, in order. */
  const labelled = (seg) =>
    seg.rows.flatMap((r) => r.cells.filter((c) => !c.missing).map((c) => c.ch));

  // --- the clean case ------------------------------------------------------
  {
    const bin = new Uint8Array(W * H);
    inkRow(bin, 250, 13);
    inkRow(bin, 550, 13);
    const seg = segmentSheet(bin, W, H, [ALPHA, BETA]);
    check('two written rows produce two rows', seg.rows.length === 2);
    check('and every cell is filled', seg.stats.found === 26, `${seg.stats.found}`);
    check('and the first row is labelled A..M',
      labelled(seg).slice(0, 13).join('') === 'ABCDEFGHIJKLM', labelled(seg).join(''));
  }

  // --- the bug: one stray mark above the writing ---------------------------
  {
    // Exactly the photograph that produced the shifted alphabet: a single short
    // stroke near the top of the page — a crease, a shadow, a margin note —
    // then the two real rows.
    const bin = new Uint8Array(W * H);
    box(bin, 60, 60, 260, 78);        // the stray mark
    inkRow(bin, 300, 13);
    inkRow(bin, 620, 13);

    const seg = segmentSheet(bin, W, H, [ALPHA, BETA]);

    check('a stray mark does not become a row', seg.rows.length === 2, `${seg.rows.length}`);
    // The heart of it. Before the fix this read 'NOPQRSTUVWXYZ' — the first
    // written row wearing the second row's labels.
    check('the first written row is still labelled A..M',
      labelled(seg).slice(0, 13).join('') === 'ABCDEFGHIJKLM',
      labelled(seg).slice(0, 13).join(''));
    check('and the second is still labelled N..Z',
      labelled(seg).slice(13, 26).join('') === 'NOPQRSTUVWXYZ',
      labelled(seg).slice(13, 26).join(''));
    check('and all 26 characters survive', seg.stats.found === 26, `${seg.stats.found}`);
    check('and the correction is reported rather than made silently',
      seg.issues.some((i) => i.code === 'stray-band'),
      seg.issues.map((i) => i.code).join(', '));
  }

  // --- a stray mark below the writing, and one of each ----------------------
  {
    const bin = new Uint8Array(W * H);
    inkRow(bin, 250, 13);
    inkRow(bin, 550, 13);
    box(bin, 60, 820, 300, 840);
    const seg = segmentSheet(bin, W, H, [ALPHA, BETA]);
    check('a stray mark below the writing is ignored too',
      labelled(seg).join('') === 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', labelled(seg).join(''));
  }
  {
    const bin = new Uint8Array(W * H);
    box(bin, 40, 40, 200, 56);
    inkRow(bin, 300, 13);
    inkRow(bin, 600, 13);
    box(bin, 40, 850, 240, 866);
    const seg = segmentSheet(bin, W, H, [ALPHA, BETA]);
    check('a stray mark at each end is ignored',
      labelled(seg).join('') === 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', labelled(seg).join(''));
  }

  // --- what must NOT be thrown away ----------------------------------------
  {
    // A sheet whose last row is genuinely short. The symbols sheet ends on one
    // of these, and a threshold taken from the long rows would discard it.
    const bin = new Uint8Array(W * H);
    inkRow(bin, 250, 13);
    inkRow(bin, 550, 4, { gap: 120 });
    const short = ['+', '-', '=', '/'];
    const seg = segmentSheet(bin, W, H, [ALPHA, short]);
    check('a genuinely short row is kept', seg.rows.length === 2, `${seg.rows.length}`);
    check('and is labelled with its own characters',
      labelled(seg).slice(13).join('') === '+-=/', labelled(seg).slice(13).join(''));
  }

  // --- a row split in two by the smoother ----------------------------------
  {
    // Two bands very close together where one row was expected: capitals with
    // no descenders can break like this. Fusing beats discarding.
    const bin = new Uint8Array(W * H);
    inkRow(bin, 300, 13, { height: 40 });
    inkRow(bin, 360, 13, { height: 40 });
    const seg = segmentSheet(bin, W, H, [ALPHA]);
    check('two adjacent bands for one row are read as one row',
      seg.rows.length === 1, `${seg.rows.length}`);
  }

  // --- a mark far from every row is not adopted into one -------------------
  {
    // Before, a component outside every band attached to the nearest one
    // regardless of distance, pushing that row's count over and forcing two
    // real characters to be fused to make room.
    const bin = new Uint8Array(W * H);
    inkRow(bin, 300, 13);
    inkRow(bin, 600, 13);
    box(bin, 1100, 30, 1180, 46);   // a page number, far above row 1
    const seg = segmentSheet(bin, W, H, [ALPHA, BETA]);
    check('a distant mark does not displace a real character',
      labelled(seg).join('') === 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', labelled(seg).join(''));
  }

  // --- a neighbour's ink stays out of this character's bitmap --------------
  {
    // extractGlyph promises to copy only ink belonging to this character's own
    // components, so that a 'p' whose tail curls right, under the baseline and
    // into the next character's box, does not get traced into that character as
    // a floating blob. The filter that did it collected its ids by scanning the
    // cell's own rectangle — which by construction picks up the neighbour's
    // label too — so it rejected nothing, and the promise was decorative.
    const { extractGlyph } = await import('../src/segment.js');
    const { labelComponents } = await import('../src/imageproc.js');

    const bin = new Uint8Array(W * H);
    // The character being cut out: a plain block.
    box(bin, 400, 200, 500, 300);
    // A neighbour's tail, unconnected, reaching into the same rectangle.
    box(bin, 460, 310, 540, 322);

    const { labels, boxes } = labelComponents(bin, W, H);
    const mine = boxes.find((b) => b.x0 === 400 && b.y0 === 200);
    const tail = boxes.find((b) => b.y0 === 310);
    check('the fixture really is two separate components',
      Boolean(mine && tail && mine.id !== tail.id),
      JSON.stringify(boxes.map((b) => [b.x0, b.y0])));

    // A cell whose box is deliberately generous — as a descender's cell is —
    // so that the neighbour's tail falls inside it.
    const cell = {
      ch: 'q', row: 0, col: 0, missing: false,
      box: { x0: 395, y0: 195, x1: 545, y1: 330 },
      parts: 1,
      partIds: [mine.id],
    };

    const g = extractGlyph(bin, labels, W, H, cell);
    const ink = g.bitmap.reduce((n, v) => n + v, 0);
    check('only the character\'s own ink is copied', ink === 100 * 100, `${ink} px`);

    // And the fallback still copies everything, so a caller that does not track
    // ids gets a glyph rather than a blank.
    const noIds = extractGlyph(bin, labels, W, H, { ...cell, partIds: [] });
    const inkAll = noIds.bitmap.reduce((n, v) => n + v, 0);
    check('a cell with no ids still yields a glyph', inkAll > 100 * 100, `${inkAll} px`);
  }

  return results;
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}`) {
  run();
}
