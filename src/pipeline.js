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

import { preprocess, labelComponents } from './imageproc.js';
import { segmentSheet, extractGlyph } from './segment.js';
import { vectorize } from './trace.js';
import { buildMetrics, deriveSpaceWidth, TARGET_X_HEIGHT } from './metrics.js';
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
 * @param {{onProgress?: (stage: string, pct: number) => void, dropBlue?: boolean}} opts
 */
export async function capturePage(source, sheetId, opts = {}) {
  const { onProgress = () => {}, dropBlue = false, trace = {} } = opts;
  const sheet = sheetById(sheetId);
  if (!sheet) throw new Error(`Unknown sheet: ${sheetId}`);

  const image = await preprocess(source, {
    dropBlue,
    onProgress: (stage, pct) => onProgress(stage, pct * 0.45),
  });

  onProgress('Finding your characters', 0.5);
  const segmentation = segmentSheet(image.bin, image.w, image.h, sheet.rows);

  // Labelling is repeated here rather than threaded out of segmentSheet because
  // extraction needs to know which component each pixel belongs to, so that a
  // neighbour's descender looping into this glyph's box is not traced into it.
  const { labels } = labelComponents(image.bin, image.w, image.h);

  const cells = segmentation.rows.flatMap((r) => r.cells).filter((c) => !c.missing);
  const glyphs = [];

  for (let i = 0; i < cells.length; i++) {
    const cell = cells[i];
    const extracted = extractGlyph(image.bin, labels, image.w, image.h, cell);
    if (!extracted) continue;

    const { contours } = vectorize(extracted.bitmap, extracted.w, extracted.h, trace);
    if (!contours.length) continue;

    glyphs.push({ ...extracted, contours, row: cell.row, col: cell.col, sheetId });

    if (i % 4 === 0 || i === cells.length - 1) {
      onProgress('Tracing outlines', 0.5 + 0.5 * ((i + 1) / cells.length));
    }
    // Let the event loop breathe so a progress bar can actually paint. Costs a
    // few milliseconds in total and is the difference between a UI that updates
    // and one that appears frozen.
    if (i % 12 === 0) await Promise.resolve();
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
export function compile(glyphs, settings = {}) {
  const {
    familyName = 'My Handwriting',
    spacingFactor = 0.3,
    boldStrength = 0.02,
    italicAngle = 11,
    variantCount = 3,
    straighten = false,
    naturalSlant = 0,
    kerning = true,
    // The tuner passes a single style so a dragged slider only rebuilds the
    // weight actually on screen; export passes all four.
    styles = STYLES,
  } = settings;

  const prepared = straighten && naturalSlant
    ? glyphs.map((g) => ({ ...g, contours: unslantContours(g.contours, naturalSlant, g) }))
    : glyphs;

  const metrics = buildMetrics(prepared, { spacingFactor, kerning });

  // Italic is always a *further* lean than the writing already has, so someone
  // whose hand slopes 14° forward does not get an "italic" identical to their
  // regular. When the writing has been straightened there is nothing to add to.
  const effectiveItalic = straighten
    ? italicAngle
    : Math.max(italicAngle * 0.55, italicAngle - Math.max(0, naturalSlant) * 0.5);

  const family = buildFamily(metrics.glyphs, metrics.spacing, metrics.kerning, {
    familyName,
    boldStrength,
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
      kernCount: s.kerning.length,
    };
  });
}

/** Build the downloadable zip for a compiled family. */
export async function packageFamily(familyName, serialised, extra = {}, onProgress) {
  return bundleFamily(familyName, serialised, {
    glyphCount: serialised[0]?.glyphCount,
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
