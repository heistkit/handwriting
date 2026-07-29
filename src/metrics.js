/**
 * metrics.js — the spacing engine.
 *
 * Everything that makes handwritten fonts *feel* wrong lives here, not in the
 * outlines. People convert their handwriting, install it, type a sentence, and
 * it reads as a ransom note: letters colliding in one place and drifting apart
 * in another, the baseline wobbling, some letters floating. The outlines were
 * fine. The metrics were guessed.
 *
 * Three problems, solved in order:
 *
 * 1. WHERE IS THE BASELINE?
 *    There is no ruled line on blank paper. But we know what each character is,
 *    so we know which ones *should* sit on the baseline ('a','n','H'), which
 *    should hang below it ('g','p','y'), and which should rise above the
 *    x-height ('b','k','l'). Each row of writing therefore gives an
 *    over-determined system, and taking medians over it recovers the baseline
 *    far more reliably than any single letter could.
 *
 * 2. HOW BIG IS EACH LETTER?
 *    Handwriting drifts in size down a page. Solving the baseline and x-height
 *    per *row* and rescaling each row to a common x-height removes that drift,
 *    so a letter written large on line four does not tower over the rest.
 *
 * 3. HOW MUCH SPACE AROUND EACH LETTER?
 *    A fixed margin is what produces the ransom-note effect: 'o' and 'H' need
 *    visibly different amounts of air to look equally spaced, because the round
 *    sides of 'o' already supply some. So we measure the ink profile of every
 *    glyph and set bearings so the *perceived* gap is constant. Kerning then
 *    cleans up the pairs whose shapes interlock, which no per-glyph value can
 *    fix on its own.
 */

import { ZONES, BY_CHAR } from './charset.js';

/** Design grid. 1000 is the CFF convention and keeps rounding error invisible. */
export const UNITS_PER_EM = 1000;

/**
 * Where we place the x-height on that grid. Text is perceived at its x-height,
 * not its cap height, so normalising here is what makes the finished font
 * appear the "right" size next to system fonts at the same point size.
 */
export const TARGET_X_HEIGHT = 500;

/** Fallback proportions, used only for rows too sparse to measure. */
const TYPICAL = {
  xOverAsc: 0.54, // x-height ÷ ascender height
  descOverX: 0.46, // descender depth ÷ x-height
};

const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

// ---------------------------------------------------------------------------
// 1. Baseline and scale, per row
// ---------------------------------------------------------------------------

/**
 * Recover baseline, x-height, ascender and descender for one row of writing.
 *
 * Medians rather than means throughout: a single letter written oddly, or a
 * stray speck that survived despeckling, would drag a mean but cannot move a
 * median. With 13 characters per row there is plenty of redundancy to exploit.
 *
 * All values are in page pixels, y increasing downward.
 */
export function solveRowMetrics(glyphsInRow) {
  const zoneOf = (gl) => BY_CHAR.get(gl.ch)?.zone ?? ZONES.x;

  // A glyph that already knows where its own rules are does not need solving.
  //
  // Everything below triangulates a baseline from the *zones* of a row of
  // characters, which needs a row to triangulate from. The drawing pad produces
  // one character at a time, against rules it drew itself at known positions —
  // so it reports them, and the answer is read rather than inferred. See the
  // note beside `glyph.guides` in draw.js for what the inference did instead.
  const stated = glyphsInRow.find((gl) => gl.guides && gl.guides.xHeight > 0);
  if (stated) {
    const { baseline, xHeight, ascHeight, descDepth } = stated.guides;
    return {
      baseline,
      xLine: baseline - xHeight,
      ascLine: baseline - ascHeight,
      descLine: baseline + descDepth,
      xHeight,
      ascHeight: ascHeight > 0 ? ascHeight : null,
      descDepth: descDepth > 0 ? descDepth : null,
      // Stated, not sampled. `confident` below is about how many characters
      // agreed on a baseline; a declared one needs no agreement, so it is
      // reported as fully confident rather than as zero samples.
      samples: { baseline: Infinity, xHeight: Infinity, ascender: Infinity, descender: Infinity },
    };
  }

  const bottomsOnBaseline = [];
  const topsAtXHeight = [];
  const topsAtAscender = [];
  const bottomsAtDescender = [];

  for (const gl of glyphsInRow) {
    const z = zoneOf(gl);
    const { y0, y1 } = gl.page;
    if (z === ZONES.x || z === ZONES.asc) bottomsOnBaseline.push(y1);
    if (z === ZONES.x || z === ZONES.desc) topsAtXHeight.push(y0);
    if (z === ZONES.asc || z === ZONES.full) topsAtAscender.push(y0);
    if (z === ZONES.desc || z === ZONES.full) bottomsAtDescender.push(y1);
  }

  const baseline = median(bottomsOnBaseline);
  const xLine = median(topsAtXHeight);
  const ascLine = median(topsAtAscender);
  const descLine = median(bottomsAtDescender);

  return {
    baseline,
    xLine,
    ascLine,
    descLine,
    xHeight: baseline != null && xLine != null ? baseline - xLine : null,
    ascHeight: baseline != null && ascLine != null ? baseline - ascLine : null,
    descDepth: baseline != null && descLine != null ? descLine - baseline : null,
    samples: {
      baseline: bottomsOnBaseline.length,
      xHeight: topsAtXHeight.length,
      ascender: topsAtAscender.length,
      descender: bottomsAtDescender.length,
    },
  };
}

/**
 * Solve every row, then fill gaps.
 *
 * The symbols row is the awkward case: it may contain no letter that touches
 * the baseline at all, so its own geometry cannot pin one. Such a row inherits
 * the scale of the rest of the sheet and places its baseline using the typical
 * proportions, which is far better than letting it float.
 */
export function solveAllRows(glyphs, { targetXHeight = TARGET_X_HEIGHT } = {}) {
  const byRow = new Map();
  for (const gl of glyphs) {
    if (!byRow.has(gl.row)) byRow.set(gl.row, []);
    byRow.get(gl.row).push(gl);
  }

  const raw = new Map();
  for (const [row, list] of byRow) raw.set(row, solveRowMetrics(list));

  // Global fallbacks from the rows that did resolve.
  //
  // Kept per source, because a pixel is not a fixed unit here. Every sheet is a
  // separate photograph taken at whatever distance the writer happened to hold
  // the camera, and nothing rectifies them to a common size — so an x-height of
  // 130 px on the letters sheet and 190 px on the symbols sheet can be the same
  // handwriting. Borrowing across them scales one sheet by the ratio of two
  // framings.
  //
  // The symbols sheet is the one this bites: its rows are almost entirely
  // ZONES.mid, so none of them can pin an x-height from their own geometry and
  // every one of them reaches for a fallback. Shoot that sheet closer than the
  // letters and every maths sign and arrow came out proportionally oversize,
  // with nothing to show for it — health.js skips `mid` in its size check
  // precisely because those glyphs have no expected height.
  //
  // So: prefer a global from the same sheet, then any global, then the row's
  // own ink. The last is crude but it is at least measured in the row's own
  // units, which is the property that matters.
  const sourceOf = (list) => list[0]?.sheetId ?? null;
  const bySource = new Map();
  for (const [row, m] of raw) {
    if (!(m.xHeight > 0)) continue;
    const src = sourceOf(byRow.get(row));
    if (!bySource.has(src)) bySource.set(src, []);
    bySource.get(src).push(m.xHeight);
  }
  const sourceX = new Map([...bySource].map(([src, xs]) => [src, median(xs)]));

  const solvedX = [...raw.values()].map((m) => m.xHeight).filter((v) => v > 0);
  const solvedAsc = [...raw.values()].map((m) => m.ascHeight).filter((v) => v > 0);
  const globalX = median(solvedX);
  const globalAsc = median(solvedAsc);

  const out = new Map();
  for (const [row, m] of raw) {
    const list = byRow.get(row);
    let { baseline, xHeight } = m;

    // Recover x-height from ascender height when the row has no short letters.
    if (!(xHeight > 0)) {
      const ownSource = sourceX.get(sourceOf(list));
      if (m.ascHeight > 0) xHeight = m.ascHeight * TYPICAL.xOverAsc;
      else if (ownSource > 0) xHeight = ownSource;
      else if (globalX > 0) xHeight = globalX;
      else xHeight = median(list.map((g) => g.page.y1 - g.page.y0)) * 0.6;
    }

    // With no baseline anchor, put it under the row's ink by a typical descent.
    if (baseline == null) {
      const bottoms = list.map((g) => g.page.y1);
      const lowest = median(bottoms);
      baseline = lowest - xHeight * TYPICAL.descOverX * 0.5;
    }

    const scale = targetXHeight / xHeight;

    out.set(row, {
      ...m,
      baseline,
      xHeight,
      scale,
      // Confidence tracks the *baseline* only. An x-height measurement needs
      // short letters, which a row of digits or symbols simply does not
      // contain — yet those rows still solve fine, because scale falls back to
      // the page median. Demanding x-height samples here flagged almost every
      // non-letter row and trained users to ignore the warning entirely.
      confident: m.samples.baseline >= 3,
      ascHeight: m.ascHeight > 0 ? m.ascHeight : (globalAsc ?? xHeight / TYPICAL.xOverAsc),
      descDepth: m.descDepth > 0 ? m.descDepth : xHeight * TYPICAL.descOverX,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// 2. Normalisation into font units
// ---------------------------------------------------------------------------

/**
 * Map an extracted glyph's outlines from page pixels into font units.
 *
 * Font space is y-up with the baseline at zero, so a descender naturally lands
 * at a negative y and needs no special handling anywhere downstream. The x
 * origin is placed at the glyph's leftmost ink; side bearings are applied later
 * as an explicit offset rather than being baked into the outline, which keeps
 * respacing a font a metrics-only operation.
 */
export function normalizeGlyph(extracted, rowMetric) {
  const { pad, page } = extracted;
  const { scale, baseline } = rowMetric;

  // Local bitmap coords → page coords → font units.
  const toFont = (p) => ({
    x: (p.x - pad) * scale,
    y: (baseline - (page.y0 - pad + p.y)) * scale,
  });

  const contours = extracted.contours.map((c) => ({
    ...c,
    curves: c.curves.map((bez) => bez.map(toFont)),
  }));

  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const c of contours) {
    for (const bez of c.curves) {
      for (const p of bez) {
        if (p.x < x0) x0 = p.x;
        if (p.y < y0) y0 = p.y;
        if (p.x > x1) x1 = p.x;
        if (p.y > y1) y1 = p.y;
      }
    }
  }
  if (!Number.isFinite(x0)) return null;

  // Shift so ink starts at x = 0.
  const shift = -x0;
  for (const c of contours) {
    for (const bez of c.curves) {
      for (const p of bez) p.x += shift;
    }
  }

  return {
    ch: extracted.ch,
    row: extracted.row,
    col: extracted.col,
    contours,
    ink: { x0: 0, y0, x1: x1 - x0, y1 },
    inkWidth: x1 - x0,
    profiles: buildProfiles(extracted, rowMetric, shift),
  };
}

/**
 * Per-scanline leftmost and rightmost ink, in font units.
 *
 * Sampled from the source bitmap rather than the fitted outline: the bitmap is
 * ground truth, and scanning it is both simpler and more accurate than
 * intersecting Béziers with a horizontal line.
 */
function buildProfiles(extracted, rowMetric, shift) {
  const { bitmap, w, h, pad, page } = extracted;
  const { scale, baseline } = rowMetric;

  const ys = [];
  const left = [];
  const right = [];

  for (let ly = 0; ly < h; ly++) {
    let lo = -1, hi = -1;
    const base = ly * w;
    for (let lx = 0; lx < w; lx++) {
      if (bitmap[base + lx]) {
        if (lo < 0) lo = lx;
        hi = lx;
      }
    }
    if (lo < 0) continue;
    ys.push((baseline - (page.y0 - pad + ly)) * scale);
    left.push((lo - pad) * scale + shift);
    right.push((hi + 1 - pad) * scale + shift);
  }

  return { ys, left, right };
}

/**
 * The same profile, measured off outlines instead of off a raster.
 *
 * A glyph that arrived as a font rather than as a photograph has no bitmap and
 * never had one: opentype.js hands over curves, and there is nothing behind
 * them to scan. buildProfiles is not adaptable to that — every line of it
 * indexes `bitmap` — so the measurement is done again here, from the only
 * representation an imported glyph has.
 *
 * It lives beside buildProfiles deliberately. These two must agree: computeSpacing
 * cannot tell them apart, and a font whose bearings were set from one and whose
 * kerning was calibrated against the other would be wrong in a way that shows up
 * only as "the spacing feels off" — the hardest kind of defect to trace back.
 *
 * Rasterising the outline instead would have been fewer lines, and it is worth
 * saying why it was not done. Two reasons, and the second is the real one.
 * A canvas would drag a DOM dependency into the one module that has none, which
 * is what currently lets the metrics stage be tested in plain Node. And it would
 * put a raster round-trip back into the path — sampling the shape onto a pixel
 * grid and then measuring the grid — when the exact curves are already in hand.
 * The bitmap is ground truth for a photograph because a photograph is pixels.
 * For a font it is a downgrade performed on purpose.
 *
 * Accuracy runs the other way from what the code above assumes. buildProfiles
 * quantises to whole source pixels and widens the span by one to reach the far
 * edge of the last inked pixel; the crossings computed here land on the true
 * edge with no quantisation at all.
 *
 * Preconditions, both of which normalizeGlyph's imported counterpart must have
 * established already: contours are in font units, the baseline is y = 0, and
 * the ink has been shifted so its leftmost point is x = 0. perceivedMargin reads
 * `left[i]` as a margin rather than as a coordinate, so a contour set that still
 * carries its original x origin produces bearings that are wrong by that origin.
 *
 * @param {Array<{curves: Array<Array<{x: number, y: number}>>}>} contours
 * @param {object} [opts]
 * @param {number} [opts.step]     spacing between scanlines, in font units
 * @param {number} [opts.flatness] longest polyline segment a curve is cut into
 * @returns {{ys: number[], left: number[], right: number[]}}
 */
export function profilesFromContours(contours, opts = {}) {
  const {
    // Eight units against a 500-unit x-height is about sixty scanlines through
    // the body of a letter, which is the density buildProfiles gets from an
    // ordinary photograph. It also stays comfortably inside the 14-unit
    // tolerance onGrid uses when it resamples these onto the kerning grid — at
    // a coarser step than that, pairs would start being silently dropped.
    step = 8,
    flatness = 4,
  } = opts;

  const edges = [];
  let yMin = Infinity;
  let yMax = -Infinity;

  const addEdge = (a, b) => {
    if (a.y < yMin) yMin = a.y;
    if (a.y > yMax) yMax = a.y;
    if (b.y < yMin) yMin = b.y;
    if (b.y > yMax) yMax = b.y;
    // A horizontal edge crosses no scanline. Keeping it would contribute a
    // division by zero below rather than a crossing.
    if (a.y === b.y) return;
    edges.push(a.y < b.y ? { x0: a.x, y0: a.y, x1: b.x, y1: b.y }
                         : { x0: b.x, y0: b.y, x1: a.x, y1: a.y });
  };

  for (const contour of contours ?? []) {
    let first = null;
    let last = null;
    for (const bez of contour.curves ?? []) {
      if (bez.length < 4) continue;
      const points = flattenCubic(bez, flatness);
      if (!first) first = points[0];
      for (let i = 1; i < points.length; i++) addEdge(points[i - 1], points[i]);
      last = points[points.length - 1];
    }
    // Close it explicitly. The tracer's contours already return to their start —
    // traceContours appends the first point to the run — but an outline parsed
    // out of a font file need not: there, closing is an instruction at the end
    // of the path rather than a repeated point. An unclosed loop is missing one
    // edge, and a scanline crossing the gap sees an odd number of crossings, so
    // the span runs off to whatever lies beyond it.
    if (first && last && (first.x !== last.x || first.y !== last.y)) addEdge(last, first);
  }

  const ys = [];
  const left = [];
  const right = [];
  if (!edges.length) return { ys, left, right };

  // Descending, because that is the order buildProfiles produces — it walks a
  // bitmap top-down, which is increasing y on the page and decreasing y in font
  // units. onGrid searches rather than seeks, so nothing breaks either way, but
  // two profiles that disagree about their own direction are a trap for whoever
  // reads this next.
  const first = Math.floor(yMax / step) * step;
  for (let y = first; y >= yMin; y -= step) {
    let lo = Infinity;
    let hi = -Infinity;
    for (const e of edges) {
      // Half-open, so a vertex shared by two edges is counted once. Closing both
      // ends would double it and, on a scanline grazing the apex of an 'A', turn
      // one crossing into two — which is harmless for a min/max but not for
      // anyone who later wants a fill rule out of this.
      if (y < e.y0 || y >= e.y1) continue;
      const x = e.x0 + ((y - e.y0) / (e.y1 - e.y0)) * (e.x1 - e.x0);
      if (x < lo) lo = x;
      if (x > hi) hi = x;
    }
    if (lo > hi) continue;
    ys.push(y);
    left.push(lo);
    right.push(hi);
  }

  return { ys, left, right };
}

/**
 * Cut one cubic into a polyline no coarser than `flatness` font units.
 *
 * The segment count comes from the control polygon, which is an upper bound on
 * the curve's own length — so a nearly straight curve gets few segments and a
 * tight bend gets many, without measuring arc length properly. Overestimating
 * costs a handful of points on a shape that is about to be reduced to two
 * numbers per scanline.
 */
function flattenCubic([p0, c1, c2, p3], flatness) {
  const hull =
    Math.hypot(c1.x - p0.x, c1.y - p0.y) +
    Math.hypot(c2.x - c1.x, c2.y - c1.y) +
    Math.hypot(p3.x - c2.x, p3.y - c2.y);
  const n = Math.max(2, Math.min(64, Math.ceil(hull / Math.max(0.5, flatness))));

  const out = [p0];
  for (let i = 1; i <= n; i++) {
    const t = i / n;
    const m = 1 - t;
    const a = m * m * m;
    const b = 3 * m * m * t;
    const c = 3 * m * t * t;
    const d = t * t * t;
    out.push({
      x: a * p0.x + b * c1.x + c * c2.x + d * p3.x,
      y: a * p0.y + b * c1.y + c * c2.y + d * p3.y,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// 3. Side bearings
// ---------------------------------------------------------------------------

/**
 * Weight a scanline by how much it matters to perceived spacing.
 *
 * Full weight through the x-height band, where neighbouring letters actually
 * confront each other, tapering above and below. Without this taper the tail of
 * a 'y' — which almost never sits next to anything — would push its neighbours
 * apart as forcefully as the body of an 'n'.
 */
function bandWeight(y, xHeight, ascender, descender) {
  if (y >= 0 && y <= xHeight) return 1;
  if (y > xHeight) {
    const t = (y - xHeight) / Math.max(1, ascender - xHeight);
    return Math.max(0.25, 1 - 0.75 * Math.min(1, t));
  }
  const t = -y / Math.max(1, -descender);
  return Math.max(0.2, 1 - 0.8 * Math.min(1, t));
}

/**
 * Compute the *perceived* margin on one side of a glyph.
 *
 * Two ideas do the work. First, a weighted average over scanlines rather than
 * the extreme: the leftmost point of an 'o' touches its bounding box, but the
 * eye sees the average curve, and spacing by the extreme is exactly why naive
 * fonts set round letters too loose.
 *
 * Second, depth clamping. The gap under the arm of a 'T' or inside a 'L' runs
 * almost the full width of the glyph; unclamped, it would dominate the average
 * and jam 'T' hard against its neighbours. Limiting how far in we look models
 * what the eye does — it registers the near edge, not the recess behind it.
 */
function perceivedMargin(profile, side, geom) {
  const { ys, left, right } = profile;
  const { xHeight, ascender, descender, inkWidth } = geom;
  const maxDepth = xHeight * 0.42;

  let acc = 0, wsum = 0;
  for (let i = 0; i < ys.length; i++) {
    const y = ys[i];
    const margin = side === 'left' ? left[i] : inkWidth - right[i];
    const clamped = Math.min(margin, maxDepth);
    const w = bandWeight(y, xHeight, ascender, descender);
    acc += clamped * w;
    wsum += w;
  }
  return wsum > 0 ? acc / wsum : 0;
}

/**
 * Assign advance widths and left side bearings to every glyph.
 *
 * The rule is one line: give each glyph whatever bearing makes its *perceived*
 * margin equal to the target. A flat-sided 'H' contributes nothing of its own
 * and receives the full target; a round 'o' already supplies some and receives
 * less; a diagonal 'A' less still at the top. That single substitution — from
 * "same bearing for everyone" to "same perceived gap for everyone" — is most of
 * the difference between amateur and professional spacing.
 */
export function computeSpacing(glyphs, opts = {}) {
  const {
    // Target perceived gap between adjacent letters, as a fraction of x-height.
    // 0.30 is comfortable for handwriting, which reads better a little looser
    // than a text face.
    spacingFactor = 0.30,
    xHeight = TARGET_X_HEIGHT,
    minBearing = -0.08 * TARGET_X_HEIGHT,
  } = opts;

  const target = xHeight * spacingFactor;
  const ascender = Math.max(...glyphs.map((g) => g.ink.y1), xHeight * 1.4);
  const descender = Math.min(...glyphs.map((g) => g.ink.y0), -xHeight * 0.3);

  for (const g of glyphs) {
    const geom = { xHeight, ascender, descender, inkWidth: g.inkWidth };
    const leftPerceived = perceivedMargin(g.profiles, 'left', geom);
    const rightPerceived = perceivedMargin(g.profiles, 'right', geom);

    const lsb = Math.max(minBearing, target - leftPerceived);
    const rsb = Math.max(minBearing, target - rightPerceived);

    g.lsb = lsb;
    g.rsb = rsb;
    g.advanceWidth = Math.max(1, lsb + g.inkWidth + rsb);
    g.perceived = { left: leftPerceived, right: rightPerceived };
  }

  return { target, ascender, descender };
}

// ---------------------------------------------------------------------------
// 4. Kerning
// ---------------------------------------------------------------------------

/**
 * Resample a glyph's profile onto a shared y grid so two glyphs can be compared
 * scanline for scanline. Entries where the glyph has no ink are left as NaN and
 * skipped, so an 'A' and a comma only interact over the small band where they
 * actually overlap vertically.
 */
function onGrid(glyph, grid, side, offset = 0) {
  const { ys, left, right } = glyph.profiles;
  const out = new Float64Array(grid.length).fill(NaN);
  if (!ys.length) return out;

  // Profiles run top-to-bottom in y-down order, so descending in font units.
  for (let gi = 0; gi < grid.length; gi++) {
    const target = grid[gi];
    // Nearest scanline; profiles are dense so this is accurate enough.
    let best = -1, bestD = Infinity;
    for (let i = 0; i < ys.length; i++) {
      const d = Math.abs(ys[i] - target);
      if (d < bestD) { bestD = d; best = i; }
    }
    // Reject when the nearest scanline is not actually near.
    if (best < 0 || bestD > 14) continue;
    out[gi] = (side === 'left' ? left[best] : right[best]) + offset;
  }
  return out;
}

/**
 * Generate kerning pairs.
 *
 * Side bearings equalise each glyph's *average* margin, which is the right
 * global answer but blind to shape interlock. 'A' and 'V' both lean away at the
 * height where they meet, so their closest approach is far wider than their
 * averages suggest; 'r' followed by '.' is the reverse. Kerning is precisely
 * the residual those averages cannot express.
 *
 * The reference gap is the median closest approach across all measured pairs,
 * so the table calibrates itself to the hand being processed rather than to a
 * constant that suits one person's writing and not another's.
 */
export function computeKerning(glyphs, spacing, opts = {}) {
  const {
    strength = 0.7,
    // Ignore adjustments below this; they bloat the table and are invisible.
    minAbs = 0.014 * UNITS_PER_EM,
    maxAbs = 0.22 * UNITS_PER_EM,
    step = 12,
  } = opts;

  const { ascender, descender } = spacing;
  const grid = [];
  for (let y = descender; y <= ascender; y += step) grid.push(y);

  // Precompute each glyph on the shared grid once: O(n) instead of O(n²).
  const rightOf = new Map();
  const leftOf = new Map();
  for (const g of glyphs) {
    rightOf.set(g, onGrid(g, grid, 'right'));
    leftOf.set(g, onGrid(g, grid, 'left'));
  }

  const measured = [];
  for (const L of glyphs) {
    const lp = rightOf.get(L);
    const advance = L.advanceWidth;
    for (const R of glyphs) {
      const rp = leftOf.get(R);
      let min = Infinity;
      let overlap = 0;
      for (let i = 0; i < grid.length; i++) {
        const a = lp[i], b = rp[i];
        if (Number.isNaN(a) || Number.isNaN(b)) continue;
        // Absolute positions when the pair is set: L's ink begins at its own
        // left bearing, and R's origin sits one advance further right. Both
        // profiles are stored relative to their own ink, so L's bearing has to
        // be subtracted back off — omitting it biases every pair sharing a left
        // glyph by a constant, which survives the median and corrupts the
        // whole table.
        const gap = advance + R.lsb + b - L.lsb - a;
        if (gap < min) min = gap;
        overlap++;
      }
      // Too little vertical overlap to judge; leave the pair alone.
      if (overlap < 3 || !Number.isFinite(min)) continue;
      measured.push({ L, R, min });
    }
  }

  if (!measured.length) return [];

  // Calibrate against lowercase pairs where possible. They are the bulk of real
  // text, and a median over *all* pairs is easily skewed by a charset heavy in
  // symbols and capitals — which would then drag every ordinary word off.
  const isLower = (g) => g.ch >= 'a' && g.ch <= 'z';
  const lowerPairs = measured.filter((m) => isLower(m.L) && isLower(m.R));
  const reference = median((lowerPairs.length >= 24 ? lowerPairs : measured).map((m) => m.min));
  const pairs = [];
  for (const m of measured) {
    const adjust = (reference - m.min) * strength;
    if (Math.abs(adjust) < minAbs) continue;
    pairs.push({
      left: m.L,
      right: m.R,
      value: Math.round(Math.max(-maxAbs, Math.min(maxAbs, adjust))),
    });
  }

  return pairs;
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

/**
 * Full metrics pass: solve rows, normalise, space, kern.
 *
 * @param {Array} extracted  glyphs carrying `contours`, `bitmap`, `page`, `row`
 * @returns {{glyphs: Array, spacing: object, kerning: Array, rows: Map}}
 */
export function buildMetrics(extracted, opts = {}) {
  const rows = solveAllRows(extracted, opts);

  const glyphs = [];
  for (const ex of extracted) {
    const rm = rows.get(ex.row);
    if (!rm) continue;
    const g = normalizeGlyph(ex, rm);
    if (g) glyphs.push(g);
  }

  const spacing = computeSpacing(glyphs, opts);
  const kerning = opts.kerning === false ? [] : computeKerning(glyphs, spacing, opts);

  return { glyphs, spacing, kerning, rows };
}

/**
 * Width of the space character.
 *
 * Derived from the writer's own letters rather than fixed: someone who writes
 * tightly should get a proportionally tight word gap. The median advance of the
 * narrow round lowercase letters is a good proxy for that rhythm.
 */
export function deriveSpaceWidth(glyphs, spacing) {
  const refs = ['o', 'e', 'a', 'c', 'n'];
  const widths = glyphs.filter((g) => refs.includes(g.ch)).map((g) => g.advanceWidth);
  const base = median(widths) ?? TARGET_X_HEIGHT * 0.9;
  return Math.round(base * 0.62);
}
