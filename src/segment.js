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

  if (bands.length !== expectedRows.length) {
    issues.push({
      level: bands.length === 0 ? 'fatal' : 'warn',
      code: 'row-count',
      message:
        `Expected ${expectedRows.length} row${expectedRows.length === 1 ? '' : 's'} of writing ` +
        `but found ${bands.length}. Check that every row was written and that rows are ` +
        `clearly separated.`,
      expected: expectedRows.length,
      found: bands.length,
    });
  }

  // Assign every component to the band its centre falls in; components that
  // fall outside all bands (a stray mark in the margin) attach to the nearest.
  const perBand = bands.map(() => []);
  for (const b of boxes) {
    let idx = bands.findIndex((band) => b.cy >= band.y0 && b.cy < band.y1);
    if (idx < 0) {
      let bestD = Infinity;
      bands.forEach((band, i) => {
        const d = b.cy < band.y0 ? band.y0 - b.cy : b.cy - band.y1;
        if (d < bestD) { bestD = d; idx = i; }
      });
    }
    if (idx >= 0) perBand[idx].push(b);
  }

  const rows = [];
  const pairCount = Math.min(bands.length, expectedRows.length);

  for (let r = 0; r < pairCount; r++) {
    const expected = expectedRows[r];
    let groups = mergeStacked(perBand[r]);

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
        missing: !g,
      });
    }

    rows.push({ index: r, band: bands[r], cells });
  }

  // Rows we never saw at all still need placeholders so the review grid can
  // show them as blanks rather than silently dropping characters.
  for (let r = pairCount; r < expectedRows.length; r++) {
    rows.push({
      index: r,
      band: null,
      cells: expectedRows[r].map((ch, i) => ({
        ch, row: r, col: i, box: null, parts: 0, missing: true,
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
    },
  };
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
 * A one-pixel transparent border is always added so the contour tracer can walk
 * fully around the shape without special-casing the image edge.
 */
export function extractGlyph(bin, labels, w, h, cell, { pad = 2 } = {}) {
  if (!cell.box) return null;
  const { x0, y0, x1, y1 } = cell.box;
  const gw = x1 - x0 + pad * 2;
  const gh = y1 - y0 + pad * 2;
  const out = new Uint8Array(gw * gh);

  // Collect the label ids that make up this cell by sampling its own box.
  const ids = new Set();
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const l = labels[y * w + x];
      if (l) ids.add(l);
    }
  }

  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = y * w + x;
      if (bin[i] && ids.has(labels[i])) {
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
