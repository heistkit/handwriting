/**
 * pipeline.js — the keystone.
 *
 * Every other module in this app is a pure function over data: give
 * `sauvolaBinarize` a grayscale buffer and it returns a mask, give `vectorize`
 * a mask and it returns curves. None of them know about each other, which is
 * what made them individually testable. This file is the only place that knows
 * the order, and it is deliberately the only stateful thing in the whole
 * conversion.
 *
 * The flow, once:
 *
 *   photo ─► preprocess ─► segment ─► extract ─► vectorize ─► metrics
 *                                                               │
 *   .zip ◄── export ◄── sfnt+GPOS ◄── fontbuild ◄───────────────┘
 *
 * Two things are worth knowing about the shape of this.
 *
 * First, capture and compilation are separated. `capturePage()` runs the
 * expensive image work once per photograph and hands back plain glyph data;
 * `compile()` turns accumulated glyphs into fonts and can be re-run instantly
 * whenever a slider moves. Without that split, every nudge of the spacing
 * control would re-binarise a 12-megapixel image.
 *
 * Second, nothing here touches the DOM, so the whole module can run inside a
 * Web Worker unchanged.
 */

import { preprocess, labelComponents, paintYield } from './imageproc.js';
import { segmentSheet, extractGlyph, identifySheet } from './segment.js';
import { vectorize } from './trace.js';
import { buildMetrics, deriveSpaceWidth, TARGET_X_HEIGHT, metricsFromNormalised } from './metrics.js';
import { buildFamily, STYLES } from './fontbuild.js';
import { buildGposKerning, buildGroupMap } from './gpos.js';
import { finalise } from './sfnt.js';
import { bundleFamily, toWOFF, cssSnippet, slugify } from './export.js';
import { analyse } from './health.js';
import { SHEETS, LIGATURE_SHEET } from './charset.js';

/** Every sheet the app can ask for, keyed by id. */
export const ALL_SHEETS = [...SHEETS, LIGATURE_SHEET];
export const sheetById = (id) => ALL_SHEETS.find((s) => s.id === id);

// ---------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------

/**
 * Turn one photographed sheet into traced glyphs.
 *
 * Vectorising is the slow part — a few milliseconds per character, times a
 * hundred and twenty — so progress is reported per glyph rather than per stage.
 * A bar that sits still for eight seconds and then jumps to done reads as a
 * hang, however fast it actually is.
 *
 * @param {File|Blob|string} source
 * @param {string} sheetId
 * @param {{onProgress?: (stage: string, pct: number) => void, dropBlue?: boolean,
 *          signal?: AbortSignal}} opts
 */
export async function capturePage(source, sheetId, opts = {}) {
  const { onProgress = () => {}, dropBlue = false, trace = {}, signal = null } = opts;
  const sheet = sheetById(sheetId);
  if (!sheet) throw new Error(`Unknown sheet: ${sheetId}`);

  const image = await preprocess(source, {
    dropBlue,
    signal,
    onProgress: (stage, pct) => onProgress(stage, pct * 0.45),
  });

  onProgress('Finding your characters', 0.5);
  // The seventh blind label. segmentSheet and the labelling under it are two
  // more full-image passes with no await between them, so without this the
  // reader is still looking at "Measuring your slant" while the characters are
  // being found, and at "Finding your characters" while they are being traced.
  await paintYield();
  signal?.throwIfAborted();
  const segmentation = segmentSheet(image.bin, image.w, image.h, sheet.rows);

  // Is this the sheet we were asked for?
  //
  // Segmentation pairs bands to rows from the top and never asks. Put the
  // capitals photograph in the everyday slot and it does exactly as designed:
  // 'A' is written into the font as 'a', 'B' as 'b', straight down. Every
  // character is found. The review grid shows a tidy grid of capitals under
  // lowercase labels, and the only way to notice is to recognise the letters —
  // which is the one thing this app never does.
  //
  // Refused rather than warned about. A warning is right when the font will be
  // slightly wrong; this one is wrong in every character it contains, and going
  // on to build it wastes the reader's time and then hands them something they
  // have to work out for themselves.
  {
    const asked = identifySheet(segmentation.stats, [sheet]);
    if (!asked || asked.score < 0.75) {
      const looksLike = identifySheet(segmentation.stats, ALL_SHEETS.filter((s) => s.id !== sheetId));
      if (looksLike && looksLike.score >= 0.75) {
        return {
          sheetId,
          glyphs: [],
          issues: [{
            level: 'fatal',
            code: 'wrong-sheet',
            message:
              `This looks like the “${looksLike.title}” sheet rather than “${sheet.title}”. ` +
              'Nothing has been read from it — reading it here would have written every ' +
              `character under the wrong name. Drop it on the “${looksLike.title}” row instead.`,
            suggest: looksLike.id,
          }],
          stats: segmentation.stats,
          slant: image.slant,
          angle: image.angle,
          page: { w: image.w, h: image.h, bin: image.bin },
        };
      }
    }
  }

  // Labelling is repeated here rather than threaded out of segmentSheet because
  // extraction needs to know which component each pixel belongs to, so that a
  // neighbour's descender looping into this glyph's box is not traced into it.
  const { labels } = labelComponents(image.bin, image.w, image.h);

  const cells = segmentation.rows.flatMap((r) => r.cells).filter((c) => !c.missing);
  const glyphs = [];

  for (let i = 0; i < cells.length; i++) {
    // At the top of the body, not the bottom. Both `continue`s below skip
    // everything after them, so on a page where most cells produce no ink and
    // no contours the loop ran start to finish without yielding once — the
    // exact page on which the overlay most needed to move.
    //
    // The abort check goes immediately after the yield, and nowhere else: the
    // click that sets the flag can only have run during that yield, so a check
    // anywhere else in this loop would be dead code.
    if (i % 12 === 0) {
      await paintYield();
      signal?.throwIfAborted();
    }

    const cell = cells[i];
    const extracted = extractGlyph(image.bin, labels, image.w, image.h, cell);
    if (!extracted) continue;

    const { contours } = vectorize(extracted.bitmap, extracted.w, extracted.h, trace);
    if (!contours.length) continue;

    glyphs.push({ ...extracted, contours, row: cell.row, col: cell.col, sheetId });

    if (i % 4 === 0 || i === cells.length - 1) {
      onProgress('Tracing outlines', 0.5 + 0.5 * ((i + 1) / cells.length));
    }
  }

  onProgress('Done', 1);

  return {
    sheetId,
    glyphs,
    issues: segmentation.issues,
    stats: segmentation.stats,
    slant: image.slant,
    angle: image.angle,
    // Kept for the review screen's before/after overlay.
    page: { w: image.w, h: image.h, bin: image.bin },
  };
}

/**
 * Merge captures from several sheets into one glyph set.
 *
 * Rows are renumbered across sheets so the metrics stage — which solves a
 * baseline per row — never confuses row 2 of the capitals sheet with row 2 of
 * the symbols sheet. They were written at different moments, possibly at
 * different sizes, and must be solved separately.
 */
export function mergeCaptures(captures) {
  const glyphs = [];
  let rowOffset = 0;

  for (const capture of captures) {
    let maxRow = -1;
    for (const g of capture.glyphs) {
      glyphs.push({ ...g, row: g.row + rowOffset });
      if (g.row > maxRow) maxRow = g.row;
    }
    rowOffset += maxRow + 1;
  }

  return glyphs;
}

// ---------------------------------------------------------------------------
// Compile
// ---------------------------------------------------------------------------

/**
 * Turn captured glyphs into four finished font binaries.
 *
 * Fast enough to re-run on every slider change, which is what makes the live
 * tuner possible: the expensive image work already happened during capture, and
 * everything from here is arithmetic on a few thousand curve points.
 *
 * @param {Array} glyphs      merged output of capturePage
 * @param {object} settings   { familyName, spacingFactor, boldStrength, italicAngle,
 *                              variantCount, straighten, kerning }
 */
/**
 * Trace a glyph that arrived from the drawing pad rather than from a scan.
 *
 * The pad returns the same shape `extractGlyph` does — an ink bitmap and its
 * page bounds — and deliberately no outlines, because rasterising is its job
 * and vectorising is this file's. The redraw path in the review grid was
 * pushing the pad's output straight into `state.glyphs` with
 * `contours: glyph.contours`, which is a key the pad has never returned. Every
 * redrawn character therefore reached `normalizeGlyph`, which opens with
 * `extracted.contours.map(...)`, carrying `undefined` — so repairing a single
 * character broke the build for the whole font.
 *
 * It lives here, beside the scan path's own call, so the two cannot drift: a
 * redrawn 'a' has to be traced at exactly the tolerances a photographed one is,
 * or it would carry a different fidelity into the same font.
 *
 * @param {{bitmap: Uint8Array, w: number, h: number}} glyph
 * @param {object} [trace] same options object capturePage takes
 * @returns {Array|null} contours, or null if there was too little ink to trace
 */
export function traceGlyph(glyph, trace = {}) {
  if (!glyph?.bitmap) return null;
  // The pad also hands over the coverage field its mask was thresholded from,
  // which lets the tracer place the boundary between pixels instead of on one.
  // A scanned glyph has no such field and takes the path it always did. Set
  // explicitly rather than spread so that a caller passing `coverage: undefined`
  // does not silently turn it off.
  const opts = { ...trace };
  if (opts.coverage == null && glyph.coverage) opts.coverage = glyph.coverage;
  const { contours } = vectorize(glyph.bitmap, glyph.w, glyph.h, opts);
  return contours.length ? contours : null;
}

export function compile(glyphs, settings = {}) {
  const {
    familyName = 'My Handwriting',
    spacingFactor = 0.3,
    boldStrength = 0.02,
    strokeWeight = 0,
    italicAngle = 11,
    variantCount = 3,
    straighten = false,
    naturalSlant = 0,
    kerning = true,
    // The tuner passes a single style so a dragged slider only rebuilds the
    // weight actually on screen; export passes all four.
    styles = STYLES,
    // Set when the glyphs came out of a font file rather than a photograph.
    // They are already in font units with the baseline at zero, so the baseline
    // solver has nothing to solve and would be reading `page` coordinates that
    // do not exist. Explicit rather than sniffed off the glyphs, because "were
    // these normalised" is a fact about where they came from and the caller is
    // the only one who knows it.
    normalised = false,
    // Keep the spacing an imported font arrived with instead of re-deriving it.
    // Whoever made that font may have tuned its bearings by eye, and this app's
    // spacing engine is good but it is not better than that.
    keepOriginalSpacing = false,
  } = settings;

  const prepared = straighten && naturalSlant
    ? glyphs.map((g) => ({ ...g, contours: unslantContours(g.contours, naturalSlant, g) }))
    : glyphs;

  const metrics = normalised
    ? metricsFromNormalised(prepared, { spacingFactor, kerning, keepOriginalSpacing })
    : buildMetrics(prepared, { spacingFactor, kerning });

  // Italic is always a *further* lean than the writing already has, so someone
  // whose hand slopes 14° forward does not get an "italic" identical to their
  // regular. When the writing has been straightened there is nothing to add to.
  const effectiveItalic = straighten
    ? italicAngle
    : Math.max(italicAngle * 0.55, italicAngle - Math.max(0, naturalSlant) * 0.5);

  const family = buildFamily(metrics.glyphs, metrics.spacing, metrics.kerning, {
    familyName,
    boldStrength,
    strokeWeight,
    italicAngle: effectiveItalic,
    variantCount,
    styles,
  });

  return { ...family, metrics, effectiveItalic };
}

/**
 * Remove the writer's natural lean.
 *
 * Shears about the middle of the x-height band for the same reason
 * `fontbuild.slant` does — pivoting at the baseline would swing every tall
 * letter sideways and wreck the horizontal rhythm the metrics stage just
 * established.
 */
function unslantContours(contours, slantDeg, glyph) {
  const t = Math.tan((-slantDeg * Math.PI) / 180);
  if (!t) return contours;
  // Working in bitmap space here, where y grows downward, so the pivot is
  // measured down from the top of the glyph rather than up from the baseline.
  const pivot = glyph.h ? glyph.h * 0.62 : 0;
  return contours.map((c) => ({
    ...c,
    curves: c.curves.map((b) =>
      b.map((p) => ({ x: p.x + (p.y - pivot) * t, y: p.y }))
    ),
  }));
}

// ---------------------------------------------------------------------------
// Serialise
// ---------------------------------------------------------------------------

/**
 * Produce the finished binary for each style.
 *
 * opentype.js writes everything except kerning, so each style is serialised,
 * then handed to `finalise()` which splices in the hand-built GPOS table and
 * sets the header bits that make the four files behave as one family.
 */
export function serialise(family) {
  return family.styles.map((s) => {
    const groupOf = buildGroupMap(family.defs, s.index);
    const gpos = buildGposKerning(s.kerning, {
      glyphCount: s.order.length,
      groupOf,
    });

    const raw = s.font.toArrayBuffer();
    const otf = finalise(raw, {
      gpos,
      bold: s.weightClass >= 700,
      italic: s.italic,
      italicAngle: s.italicAngle,
    });

    return {
      style: s.style,
      italic: s.italic,
      weightClass: s.weightClass,
      otf,
      glyphCount: s.order.length,
      // What a reader means by "characters": the ones they can type. `order`
      // also holds .notdef, space, and two alternates for every letter, so it
      // came to about three times this — and the export screen, the details
      // table and the README all called that number "Characters". A font of 112
      // characters was described as having 346 of them.
      charCount: s.order.filter((n) => !n.includes('.alt') && n !== '.notdef').length,
      kernCount: s.kerning.length,
    };
  });
}

/** Build the downloadable zip for a compiled family. */
export async function packageFamily(familyName, serialised, extra = {}, onProgress) {
  return bundleFamily(familyName, serialised, {
    glyphCount: serialised[0]?.charCount,
    kernCount: serialised[0]?.kernCount,
    ...extra,
  }, onProgress);
}

// ---------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------

/**
 * Register a compiled style with the browser so it can be used in live HTML.
 *
 * The font is handed over as an in-memory `FontFace` rather than a blob URL:
 * there is no file, no object URL to leak, and no navigation-visible artefact —
 * it exists only for as long as this page is open, which suits an app whose
 * promise is that nothing leaves the device.
 *
 * @returns {Promise<string>} the family name to use in CSS
 */
export async function registerPreviewFont(otf, familyName, { italic, weightClass }) {
  const face = new FontFace(familyName, otf, {
    style: italic ? 'italic' : 'normal',
    weight: String(weightClass),
    display: 'block',
  });
  await face.load();
  document.fonts.add(face);
  return familyName;
}

/** Drop previously registered faces so re-compiles do not pile up. */
export function clearPreviewFonts(familyName) {
  const doomed = [];
  document.fonts.forEach((f) => {
    if (f.family === familyName) doomed.push(f);
  });
  for (const f of doomed) document.fonts.delete(f);
}

// ---------------------------------------------------------------------------
// One-shot convenience
// ---------------------------------------------------------------------------

/**
 * Capture, compile, check and package in a single call.
 *
 * Used by the tests and by the "just make it" path. The interactive app calls
 * the stages separately so it can show the review and tuning screens between
 * them.
 */
export async function runAll(sources, settings = {}, opts = {}) {
  const { onProgress = () => {} } = opts;
  const captures = [];

  for (let i = 0; i < sources.length; i++) {
    const { source, sheetId } = sources[i];
    captures.push(
      await capturePage(source, sheetId, {
        ...opts,
        onProgress: (stage, pct) =>
          onProgress(stage, (i + pct) / (sources.length + 1)),
      })
    );
  }

  onProgress('Building your font', sources.length / (sources.length + 1));

  const glyphs = mergeCaptures(captures);
  const naturalSlant = median(captures.map((c) => c.slant).filter(Number.isFinite)) ?? 0;
  const family = compile(glyphs, { ...settings, naturalSlant });
  const serialised = serialise(family);

  const health = analyse(glyphs, family.metrics.glyphs, family.metrics.rows, {
    slant: naturalSlant,
    sheets: captures.map((c) => c.sheetId),
  });

  const zip = await packageFamily(settings.familyName ?? 'My Handwriting', serialised, {
    variantCount: settings.variantCount ?? 3,
  });

  onProgress('Done', 1);
  return { captures, glyphs, family, serialised, health, zip, naturalSlant };
}

function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export { analyse, toWOFF, cssSnippet, slugify, deriveSpaceWidth, TARGET_X_HEIGHT };
