/**
 * segment.js — finding the characters, in order.
 *
 * This module exists because of one design decision: the app tells the user
 * exactly what to write, in exactly what order. That single constraint removes
 * handwriting *recognition* from the problem entirely. We never have to decide
 * whether a shape is an 'a' or an 'o'; we only have to find the ink and read it
 * left to right, top to bottom, then zip it against a sequence we already know.
 *
 * Knowing the expected count per row is also what makes the pipeline
 * self-correcting. If a row should hold 13 characters and we found 15, two
 * fragments failed to merge — so merge the closest pair twice. If we found 12,
 * two characters are touching — so split the widest at its narrowest waist.
 * Both repairs are driven by a number we know for certain, which is why they
 * can run automatically instead of asking the user.
 */

import { labelComponents } from './imageproc.js';
import { BY_CHAR } from './charset.js';

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

const width = (b) => b.x1 - b.x0;
const height = (b) => b.y1 - b.y0;

/** Overlap of two intervals as a fraction of the shorter one. 0 → disjoint. */
function overlapRatio(a0, a1, b0, b1) {
  const lo = Math.max(a0, b0);
  const hi = Math.min(a1, b1);
  const shorter = Math.min(a1 - a0, b1 - b0);
  if (shorter <= 0) return 0;
  return Math.max(0, hi - lo) / shorter;
}

function unionBox(a, b) {
  return {
    x0: Math.min(a.x0, b.x0),
    y0: Math.min(a.y0, b.y0),
    x1: Math.max(a.x1, b.x1),
    y1: Math.max(a.y1, b.y1),
    area: a.area + b.area,
    parts: [...(a.parts || [a]), ...(b.parts || [b])],
  };
}

// ---------------------------------------------------------------------------
// Line detection
// ---------------------------------------------------------------------------

/**
 * Find horizontal bands of writing via the ink projection profile.
 *
 * Smoothing the profile before thresholding matters more than it looks: raw
 * profiles of handwriting are spiky, and an unsmoothed threshold shatters one
 * row into several bands wherever a gap happens to fall between words.
 */
export function findLines(bin, w, h, { minBandFraction = 0.012 } = {}) {
  const profile = new Float64Array(h);
  for (let y = 0; y < h; y++) {
    let n = 0;
    const row = y * w;
    for (let x = 0; x < w; x++) n += bin[row + x];
    profile[y] = n;
  }

  // Smooth over roughly one stroke-height so intra-row gaps close up.
  const win = Math.max(3, Math.round(h / 200) | 1);
  const smooth = boxSmooth(profile, win);

  let peak = 0;
  for (let y = 0; y < h; y++) if (smooth[y] > peak) peak = smooth[y];
  if (peak === 0) return [];
  const cut = Math.max(0.5, peak * 0.04);

  const bands = [];
  let start = -1;
  for (let y = 0; y < h; y++) {
    const on = smooth[y] > cut;
    if (on && start < 0) start = y;
    if (!on && start >= 0) {
      bands.push({ y0: start, y1: y });
      start = -1;
    }
  }
  if (start >= 0) bands.push({ y0: start, y1: h });

  // Drop hairline bands that are almost certainly smudges rather than writing.
  const minH = Math.max(4, h * minBandFraction);
  return bands.filter((b) => b.y1 - b.y0 >= minH);
}

function boxSmooth(arr, win) {
  const out = new Float64Array(arr.length);
  const r = win >> 1;
  let acc = 0;
  for (let i = 0; i < Math.min(r, arr.length); i++) acc += arr[i];
  for (let i = 0; i < arr.length; i++) {
    const add = i + r;
    const drop = i - r - 1;
    if (add < arr.length) acc += arr[add];
    if (drop >= 0) acc -= arr[drop];
    const lo = Math.max(0, i - r), hi = Math.min(arr.length - 1, i + r);
    out[i] = acc / (hi - lo + 1);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Grouping components into characters
// ---------------------------------------------------------------------------

/**
 * Merge components that belong to one character.
 *
 * The rule is deliberately two-sided: merge when the pieces sit mostly *above
 * and below* each other, not side by side. A dot over an i, the two bars of an
 * equals sign, and the head of an exclamation mark all overlap heavily
 * horizontally while barely overlapping vertically. Two neighbouring letters
 * that happen to touch show the opposite signature — slight horizontal overlap,
 * heavy vertical overlap — so this rule leaves them alone.
 */
function mergeStacked(boxes, { hOverlap = 0.45, vOverlap = 0.35 } = {}) {
  let items = boxes.map((b) => ({ ...b, parts: [b] }));
  let changed = true;
  while (changed) {
    changed = false;
    outer: for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        const a = items[i], b = items[j];
        const hx = overlapRatio(a.x0, a.x1, b.x0, b.x1);
        const vy = overlapRatio(a.y0, a.y1, b.y0, b.y1);
        if (hx >= hOverlap && vy <= vOverlap) {
          items[i] = unionBox(a, b);
          items.splice(j, 1);
          changed = true;
          break outer;
        }
      }
    }
  }
  return items.sort((a, b) => a.x0 - b.x0);
}

/**
 * Force the group count to match what we know the row should contain.
 *
 * Too many groups → repeatedly fuse the closest neighbouring pair. Horizontal
 * gap is the right metric because the leftover fragments of one character are
 * always nearer to each other than two deliberately separated characters are.
 */
function reconcileCount(groups, expected, { onNote = () => {} } = {}) {
  const items = [...groups];

  while (items.length > expected && items.length > 1) {
    let bestIdx = 0, bestGap = Infinity;
    for (let i = 0; i + 1 < items.length; i++) {
      const gap = items[i + 1].x0 - items[i].x1;
      if (gap < bestGap) { bestGap = gap; bestIdx = i; }
    }
    items[bestIdx] = unionBox(items[bestIdx], items[bestIdx + 1]);
    items.splice(bestIdx + 1, 1);
    onNote('merged', bestGap);
  }

  return items;
}

/**
 * Split a group at its narrowest vertical waist.
 *
 * Used when a row came up short, meaning two characters are touching. We look
 * for the column with the least ink inside the middle 60% of the group — the
 * edges are excluded because the thinnest column of any glyph is usually its
 * own first or last column, which would produce a useless sliver.
 */
function splitAtWaist(group, bin, w, labels) {
  const gw = width(group);
  if (gw < 8) return null;

  const cols = new Float64Array(gw);
  const ids = new Set(group.parts.map((p) => p.id));
  for (let y = group.y0; y < group.y1; y++) {
    for (let x = group.x0; x < group.x1; x++) {
      const i = y * w + x;
      if (bin[i] && ids.has(labels[i])) cols[x - group.x0]++;
    }
  }

  const lo = Math.floor(gw * 0.2), hi = Math.ceil(gw * 0.8);
  let cut = -1, best = Infinity;
  for (let x = lo; x < hi; x++) {
    if (cols[x] < best) { best = cols[x]; cut = x; }
  }
  if (cut < 0) return null;

  const at = group.x0 + cut;
  const left = { x0: group.x0, y0: group.y0, x1: at, y1: group.y1, area: 0, parts: [] };
  const right = { x0: at, y0: group.y0, x1: group.x1, y1: group.y1, area: 0, parts: [] };
  // Reassign the constituent components to whichever side holds their centre.
  for (const p of group.parts) {
    const target = (p.x0 + p.x1) / 2 < at ? left : right;
    target.parts.push(p);
    target.area += p.area;
  }
  if (!left.parts.length || !right.parts.length) return null;
  return [left, right];
}

// ---------------------------------------------------------------------------
// Input bound
// ---------------------------------------------------------------------------

/**
 * How many separate ink components this sheet could honestly produce.
 *
 * A clean photograph of a sheet cannot contain more components than the sum of
 * its characters' declared `parts`. Summed over the sheets charset.js defines:
 * Capitals 26, Lowercase 28 (i and j carry a dot), Numbers & punctuation 44
 * (colon, semicolon, exclam, question and quotedbl carry 2, percent carries 3),
 * Symbols & math 29 (equal, plusminus, lessequal and greaterequal carry 2,
 * divide carries 3), Joined pairs 18. The busiest is 44.
 */
function expectedParts(expectedRows) {
  let n = 0;
  for (const row of expectedRows) {
    for (const ch of row) n += BY_CHAR.get(ch)?.parts ?? 1;
  }
  return n;
}

/**
 * How far past that a photograph may go before the page is refused.
 *
 * This multiplier is a policy choice and it is unmeasured. No sample
 * photographs ship with this repo and nothing in it records how many stray
 * marks a real one leaves, so where "grainy but usable" ends is not a number
 * this codebase knows. despeckle is no help: its floor is `absolute = 6`
 * pixels and its threshold is `Math.max(absolute, median * relative)`, so on a
 * page whose components are mostly specks the median-relative arm collapses
 * onto that floor and paper texture survives it.
 *
 * The cost being bounded is not a guess. mergeStacked restarts its scan at
 * i = 0 after every merge; it makes at most n − 1 merges and each pass examines
 * at most m(m − 1)/2 pairs, so total pair tests ≤ Σ_{m=2..n} m(m−1)/2 ≈ n³/6:
 *
 *     n =   528   = 12 × the busiest sheet's 44      ≈ 2.5e7 pair tests
 *     n = 1,760   = 40 ×                             ≈ 9.1e8
 *     n = 5,000   paper texture through despeckle    ≈ 2.1e10   ← the wedged tab
 *
 * How long one pair test costs on a given device is unmeasured; the ratios
 * between those rows are arithmetic. 12 was chosen to land on the first row.
 * The bound is on the page total, which bounds every band, because mergeStacked
 * only ever sees one band's share of it.
 *
 * The right way to retune this is not to guess again: stats.components is
 * already reported for every capture and carried out through capturePage, so
 * the number a real photograph produces is observable the moment anyone looks.
 */
const MAX_COMPONENT_FACTOR = 12;

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Segment a photographed sheet against the sequence the user was asked to write.
 *
 * @param {Uint8Array} bin        binary ink mask
 * @param {number} w
 * @param {number} h
 * @param {string[][]} expectedRows  rows of characters, as printed on the sheet
 * @returns {{rows: Array, issues: Array, stats: object}}
 */
const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/**
 * Make the number of ink bands match the number of rows the sheet expects.
 *
 * This is the most consequential step in the file, because bands are paired to
 * rows by *position*: band 0 is row 0, band 1 is row 1. Get the count wrong at
 * the top and every character after it is written into the font under the wrong
 * name. One stray mark above the writing — a crease, a shadow across the top of
 * the page, a note in the margin, the printed sheet's own header caught in
 * frame — became band 0, so the first written row paired with the *second* row
 * of expected characters and an entire alphabet shifted down by thirteen. The
 * capital A was compiled as N. Every letter typed the wrong letter.
 *
 * The app noticed, too: it raised "expected 2 rows but found 3" as a warning,
 * and then built the font anyway. A warning is the right response to a font
 * that is slightly wrong. It is the wrong response to one where every character
 * is mislabelled, which is not a lesser font but a different and useless one.
 *
 * Two things fix it, and neither needs to recognise a letter.
 *
 * A row of writing holds about as many marks as it has characters. A spurious
 * band holds one or two. That is a wide enough gap to separate them on count
 * alone, and the expected count is already known — it is what the sheet asked
 * the writer for. So: drop bands too sparse to be a row, provided that leaves
 * enough behind.
 *
 * If bands are still too many after that, the remaining cause is the opposite
 * one — a single row split in two by the smoother, usually where a row of
 * capitals has no descenders to bridge the gap. Those two bands are vertically
 * adjacent with almost nothing between them, so fusing the closest neighbours
 * until the count matches repairs it.
 *
 * Both are recorded in `issues` at info level. They are corrections, and a
 * correction the reader cannot see is indistinguishable from a guess.
 *
 * @param {Array<{y0,y1}>} bands
 * @param {Array<{cy:number}>} boxes  every component found on the page
 * @param {Array<Array<string>>} expectedRows
 * @param {Array} issues              appended to
 * @returns {Array<{y0,y1}>} exactly min(bands, expectedRows.length) bands
 */
function reconcileBands(bands, boxes, expectedRows, issues) {
  if (bands.length <= expectedRows.length) return bands;

  const countIn = (band) =>
    boxes.reduce((n, b) => n + (b.cy >= band.y0 && b.cy < band.y1 ? 1 : 0), 0);

  let items = bands.map((b) => ({ ...b, n: countIn(b) }));
  const want = expectedRows.length;

  // The sparsest row the sheet asks for. Sparsest, not average: the symbols
  // sheet ends on a short row, and a threshold taken from the long rows would
  // throw that one away.
  const sparsest = Math.min(...expectedRows.map((r) => r.length));

  // -- 1. Fuse halves of a row that the smoother split ----------------------
  //
  // Order matters: fusing comes first, because a split row is two SPARSE bands
  // and step 2 would otherwise discard one of the halves.
  //
  // Two guards, and both are load-bearing. The gap has to be small beside a
  // band's own height — real rows are separated by much more than that — and
  // at least one of the pair has to be too sparse to be a row on its own.
  // Without the second guard this fused two full rows of thirteen into one, and
  // then mergeStacked, whose whole job is to join things that sit above and
  // below each other, dutifully joined every letter to the one beneath it: the
  // A cell held an A stacked on an N, the B cell a B on an O, all the way
  // across. Two real rows are never one row, however close together they sit.
  let fused = 0;
  while (items.length > want) {
    const h = median(items.map((b) => b.y1 - b.y0)) ?? 0;
    let at = -1;
    let best = Infinity;
    for (let i = 0; i + 1 < items.length; i++) {
      const a = items[i], b = items[i + 1];
      if (a.n >= sparsest - 1 && b.n >= sparsest - 1) continue;
      const gap = b.y0 - a.y1;
      if (gap < best) { best = gap; at = i; }
    }
    if (at < 0 || best > h * 0.45) break;
    items.splice(at, 2, { y0: items[at].y0, y1: items[at + 1].y1, n: items[at].n + items[at + 1].n });
    fused++;
  }
  if (fused) {
    issues.push({
      level: 'info',
      code: 'merged-band',
      message: `Two bands of writing sat close enough to be one row, and were read as one.`,
    });
  }

  // -- 2. Keep the bands that look most like rows ---------------------------
  //
  // By count, not by position. A row of writing holds about as many marks as it
  // has characters and a crease or a margin note holds one or two, so the count
  // separates them without anything having to recognise a letter — and the
  // expected count is already known, because it is what the sheet asked for.
  //
  // Taking the first `want` bands instead, which is what happened before any of
  // this existed, is what renamed an entire alphabet: one stray mark above the
  // writing became row 0, so the first written row paired with the second row
  // of expected characters and A was compiled as N.
  if (items.length > want) {
    const dropped = items.length - want;
    const keep = new Set(
      [...items].sort((a, b) => b.n - a.n).slice(0, want)
    );
    items = items.filter((b) => keep.has(b));
    issues.push({
      level: 'info',
      code: 'stray-band',
      message:
        `Ignored ${dropped} band${dropped === 1 ? '' : 's'} of stray marks around the writing. ` +
        'If a whole row is missing on the next screen, photograph the sheet again with nothing ' +
        'but the paper in frame.',
    });
  }

  return items;
}

export function segmentSheet(bin, w, h, expectedRows) {
  const { labels, boxes } = labelComponents(bin, w, h);
  const bands = findLines(bin, w, h);
  const issues = [];

  if (!boxes.length) {
    return {
      rows: [],
      issues: [{ level: 'fatal', code: 'no-ink', message: 'No writing found on this page.' }],
      stats: { components: 0, bands: 0 },
    };
  }

  // The other end of the same question, and the only bound on the work below.
  // Nothing upstream limits how many components a photograph can produce, and
  // mergeStacked restarts at i = 0 after every merge, so its cost grows with
  // the cube of that count. A page too crowded to segment is refused here — at
  // the same level, in the same shape and by the same early return as a page
  // with no ink on it — rather than being allowed to wedge the tab.
  //
  // Named expectedPartCount, not parts: `parts` already means something else
  // throughout this file — the array of constituent component boxes carried by
  // unionBox and read as `g.parts.length` a hundred lines below.
  const expectedPartCount = expectedParts(expectedRows);
  if (boxes.length > expectedPartCount * MAX_COMPONENT_FACTOR) {
    return {
      rows: [],
      issues: [{
        level: 'fatal',
        code: 'too-many-marks',
        message:
          `This page has ${boxes.length} separate marks on it, and this sheet accounts for ` +
          `${expectedPartCount}. There is too much on it to sort into characters. Photograph ` +
          `the sheet again on plain paper in even light, with nothing else in the frame.`,
      }],
      stats: { components: boxes.length, bands: bands.length },
    };
  }

  // Bands are paired to rows by position — band 0 is row 0 — so the number of
  // bands has to be right before anything else can be. See reconcileBands.
  const chosen = reconcileBands(bands, boxes, expectedRows, issues);

  if (chosen.length !== expectedRows.length) {
    issues.push({
      level: chosen.length === 0 ? 'fatal' : 'warn',
      code: 'row-count',
      message:
        `Expected ${expectedRows.length} row${expectedRows.length === 1 ? '' : 's'} of writing ` +
        `but found ${chosen.length}. Check that every row was written and that rows are ` +
        `clearly separated.`,
      expected: expectedRows.length,
      found: chosen.length,
    });
  }

  // Assign every component to the band its centre falls in; components that
  // fall outside all bands (a stray mark in the margin) attach to the nearest,
  // but only if they are close enough to plausibly belong to it.
  const perBand = chosen.map(() => []);
  const bandHeight = median(chosen.map((b) => b.y1 - b.y0)) ?? h;
  const reachable = bandHeight * 0.6;
  for (const b of boxes) {
    let idx = chosen.findIndex((band) => b.cy >= band.y0 && b.cy < band.y1);
    if (idx < 0) {
      let bestD = Infinity;
      chosen.forEach((band, i) => {
        const d = b.cy < band.y0 ? band.y0 - b.cy : b.cy - band.y1;
        if (d < bestD) { bestD = d; idx = i; }
      });
      // A mark further from every row than half a row's height is not part of
      // a row. It is a crease, a margin note, a page number or a shadow, and
      // adopting it into the nearest row would push that row's component count
      // over and force reconcileCount to fuse two real characters together.
      if (bestD > reachable) idx = -1;
    }
    if (idx >= 0) perBand[idx].push(b);
  }

  const rows = [];
  const pairCount = Math.min(chosen.length, expectedRows.length);

  // What the page actually looks like, before any of it is bent to fit what
  // was asked for. Everything below splits and fuses groups toward
  // `expected.length`, so by the end the counts describe the sheet we hoped
  // for rather than the one in front of us. Recorded here, once, so the caller
  // can ask whether this photograph is of a different sheet entirely.
  const observedPerRow = [];

  for (let r = 0; r < pairCount; r++) {
    const expected = expectedRows[r];
    let groups = mergeStacked(perBand[r]);
    observedPerRow.push(groups.length);

    // Short row: try splitting touching characters before giving up.
    let guard = 0;
    while (groups.length < expected.length && guard++ < expected.length) {
      const widest = groups
        .map((g, i) => ({ g, i }))
        .sort((a, b) => width(b.g) - width(a.g))[0];
      if (!widest) break;
      const split = splitAtWaist(widest.g, bin, w, labels);
      if (!split) break;
      groups.splice(widest.i, 1, ...split);
      groups.sort((a, b) => a.x0 - b.x0);
    }

    if (groups.length > expected.length) {
      groups = reconcileCount(groups, expected.length);
    }

    if (groups.length !== expected.length) {
      issues.push({
        level: 'warn',
        code: 'cell-count',
        row: r,
        message:
          `Row ${r + 1} should have ${expected.length} characters but ${groups.length} were ` +
          `found. You can fix this by hand on the next screen.`,
        expected: expected.length,
        found: groups.length,
      });
    }

    const cells = [];
    for (let i = 0; i < expected.length; i++) {
      const g = groups[i];
      cells.push({
        ch: expected[i],
        row: r,
        col: i,
        box: g ? { x0: g.x0, y0: g.y0, x1: g.x1, y1: g.y1 } : null,
        parts: g ? g.parts.length : 0,
        // The component ids this character is actually made of. extractGlyph
        // needs them to keep a neighbour's ink out, and cannot work them out
        // for itself — see the note there.
        partIds: g ? g.parts.map((p) => p.id).filter((id) => id != null) : [],
        missing: !g,
      });
    }

    rows.push({ index: r, band: chosen[r], cells });
  }

  // Rows we never saw at all still need placeholders so the review grid can
  // show them as blanks rather than silently dropping characters.
  for (let r = pairCount; r < expectedRows.length; r++) {
    rows.push({
      index: r,
      band: null,
      cells: expectedRows[r].map((ch, i) => ({
        ch, row: r, col: i, box: null, parts: 0, partIds: [], missing: true,
      })),
    });
  }

  return {
    rows,
    issues,
    stats: {
      components: boxes.length,
      bands: bands.length,
      found: rows.reduce((n, r) => n + r.cells.filter((c) => !c.missing).length, 0),
      total: expectedRows.reduce((n, r) => n + r.length, 0),
      // The shape of the page as found, not as hoped for. See `identifySheet`.
      observedPerRow,
      observedBands: chosen.length,
    },
  };
}

/**
 * Which sheet does this page look like?
 *
 * Nothing here reads a letter. Every sheet has a distinct silhouette — how many
 * rows, and how many characters in each — and that is enough to tell them
 * apart: the everyday sheet is 13, 13, 6; the capitals are 13, 13; the symbols
 * are 13, 7, 3. A photograph that produced two rows of thirteen is not the
 * everyday sheet however much we would like it to be.
 *
 * This exists because the failure it catches is silent and total. Drop the
 * capitals photograph into the everyday slot and segmentation pairs bands to
 * rows from the top exactly as designed: 'A' is written into the font as 'a',
 * 'B' as 'b', all the way down. Every character is found, the count reads 26 of
 * 32, and the review grid shows a tidy grid of capitals sitting under lowercase
 * labels. The only clue is that the reader has to recognise the letters
 * themselves — which is the one thing the app never does.
 *
 * @param {{observedPerRow: number[], observedBands: number}} stats
 * @param {Array<{id: string, title: string, rows: string[][]}>} sheets
 * @returns {{id: string, title: string, score: number}|null} best match, or null
 */
export function identifySheet(stats, sheets) {
  const observed = stats?.observedPerRow;
  if (!Array.isArray(observed) || !observed.length) return null;

  // Rows are found top-down and a sheet's rows are written top-down, so the
  // comparison is positional. A row is "agreed" when the counts are within
  // one — a joined pair or a split character moves a count by one routinely,
  // and demanding exactness would make this fire on good photographs.
  const scoreOf = (sheet) => {
    const want = sheet.rows.map((r) => r.length);
    if (want.length !== stats.observedBands) return 0;
    let agreed = 0;
    for (let i = 0; i < want.length; i++) {
      if (Math.abs((observed[i] ?? 0) - want[i]) <= 1) agreed++;
    }
    return agreed / want.length;
  };

  let best = null;
  for (const sheet of sheets) {
    const score = scoreOf(sheet);
    if (score > 0 && (!best || score > best.score)) {
      best = { id: sheet.id, title: sheet.title, score };
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

/**
 * Cut one character out of the page as its own small bitmap.
 *
 * Only ink belonging to this character's own components is copied. That matters
 * when a neighbour's descender loops into this bounding box — without the label
 * filter, a 'y' tail from the previous character would be traced into this
 * glyph's outline as a floating blob.
 *
 * The ids come from the cell, and that is the whole point. They used to be
 * gathered here, by scanning the cell's own rectangle for whatever labels it
 * contained — which collects, by construction, the label of every inked pixel
 * inside it, including the neighbour's. `labels` is non-zero wherever `bin` is
 * set, so `bin[i] && ids.has(labels[i])` reduced to `bin[i]` and the filter
 * rejected nothing at all. Every word above this line described a defence that
 * was not there.
 *
 * The real ids were always available: segmentSheet knows which components it
 * merged into each character, because merging them is what it did. It now says
 * so, in `cell.partIds`.
 *
 * A one-pixel transparent border is always added so the contour tracer can walk
 * fully around the shape without special-casing the image edge.
 */
export function extractGlyph(bin, labels, w, h, cell, { pad = 2 } = {}) {
  if (!cell.box) return null;
  const { x0, y0, x1, y1 } = cell.box;
  const gw = x1 - x0 + pad * 2;
  const gh = y1 - y0 + pad * 2;
  const out = new Uint8Array(gw * gh);

  // No ids means an older caller, or a cell built by some path that does not
  // track them. Copy everything, as before — a glyph with a neighbour's tail in
  // it is a poor glyph, but an empty one is not a glyph at all.
  const ids = cell.partIds?.length ? new Set(cell.partIds) : null;

  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = y * w + x;
      if (bin[i] && (!ids || ids.has(labels[i]))) {
        out[(y - y0 + pad) * gw + (x - x0 + pad)] = 1;
      }
    }
  }

  return {
    ch: cell.ch,
    bitmap: out,
    w: gw,
    h: gh,
    pad,
    // Position on the page, needed later to work out where the baseline sits.
    page: { x0, y0, x1, y1 },
  };
}

/** Extract every non-missing cell of a segmentation result. */
export function extractAll(bin, w, h, segmentation) {
  const { labels } = labelComponents(bin, w, h);
  const glyphs = [];
  for (const row of segmentation.rows) {
    for (const cell of row.cells) {
      const gl = extractGlyph(bin, labels, w, h, cell);
      if (gl) glyphs.push({ ...gl, row: cell.row, col: cell.col });
    }
  }
  return glyphs;
}

/** Render an extracted glyph bitmap to a canvas for the review grid. */
export function glyphToCanvas(glyph, { size = 96, ink = '#1a1c1b', margin = 0.12 } = {}) {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');

  const inner = size * (1 - margin * 2);
  const scale = Math.min(inner / glyph.w, inner / glyph.h);
  const ox = (size - glyph.w * scale) / 2;
  const oy = (size - glyph.h * scale) / 2;

  ctx.fillStyle = ink;
  for (let y = 0; y < glyph.h; y++) {
    for (let x = 0; x < glyph.w; x++) {
      if (glyph.bitmap[y * glyph.w + x]) {
        ctx.fillRect(ox + x * scale, oy + y * scale, Math.ceil(scale), Math.ceil(scale));
      }
    }
  }
  return canvas;
}
