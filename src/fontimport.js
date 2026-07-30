/**
 * fontimport.js — enter the pipeline at the vector stage.
 *
 * Somebody who already made a handwriting font — on Calligraphr, or by hand in a
 * font editor — has one style and no way to get the other three. They have the
 * hard part: outlines of their own letters, already spaced. What they lack is
 * Bold, Italic, Bold Italic, kerning and the rotating variants, and all four of
 * those this app generates geometrically from a single sample.
 *
 * So the font is read rather than the paper. It skips the entire image pipeline —
 * threshold, deskew, segment, trace — which is the part that can misread, and
 * lands directly on the metrics stage with exact curves.
 *
 * Why this is not just a call to buildMetrics
 * -------------------------------------------
 * `metrics.normalizeGlyph` takes bitmap-space contours plus the glyph's position
 * on the page and a per-row solved `{scale, baseline}`. It exists to recover a
 * baseline from a photograph of unruled paper, which is the app's cleverest
 * trick and completely useless here: a font already has its baseline at y = 0,
 * exactly, by definition. There is no page, no row and no scale to solve.
 *
 * So this is the parallel normaliser. It produces the same glyph shape
 * `computeSpacing` consumes and hands over directly, skipping `solveAllRows`
 * entirely. The one piece it cannot reuse is the ink profile, because
 * `buildProfiles` scans a raster and there is no raster — hence
 * `metrics.profilesFromContours`, which was written for this.
 *
 * What it deliberately does not do
 * --------------------------------
 * Re-derive the side bearings. An imported font already has them, possibly
 * hand-tuned by whoever made it, and this app's spacing engine is good but it is
 * not better than a person who has looked at their own letters. They are carried
 * across as they were, and re-deriving is something a caller has to ask for.
 */

import { UNITS_PER_EM, TARGET_X_HEIGHT, profilesFromContours } from './metrics.js';

/** opentype.js is a UMD bundle; the browser loads it via a script tag. */
function lib() {
  const found = globalThis.opentype;
  if (!found) throw new Error('opentype.js is not loaded');
  return found;
}

/* -------------------------------------------------------------------------- */
/* Licensing                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The OS/2 embedding-permission bits, as the specification defines them.
 *
 * Read rather than guessed at, and shown to the reader rather than acted on
 * silently. This is not a rights-management system and could not be one — the
 * whole app runs on the reader's own machine and any check here is advice they
 * are free to ignore. What it can honestly do is surface what the font's own
 * maker recorded in it, so that "am I allowed to do this" is answered by the
 * file rather than by a checkbox asking the reader to promise.
 *
 * Bit 1 set alone means the vendor forbids embedding outright. Bits 2 and 3 are
 * the permissive middle — preview-and-print, and editable — and both allow what
 * this app does. Bit 9 forbids subsetting and bit 10 restricts to bitmaps; both
 * are constraints on embedding rather than on deriving, and neither is a refusal.
 */
const FS_TYPE = {
  RESTRICTED: 0x0002,
  PREVIEW_PRINT: 0x0004,
  EDITABLE: 0x0008,
  NO_SUBSET: 0x0100,
  BITMAP_ONLY: 0x0200,
};

/**
 * What the font says about itself and what may be done with it.
 *
 * @returns {{restricted: boolean, fsType: number, family: string|null,
 *            designer: string|null, description: string|null, url: string|null,
 *            noSubset: boolean, bitmapOnly: boolean}}
 */
export function licence(font) {
  const names = font?.names ?? {};
  // opentype.js exposes name-table strings keyed by language. English if it is
  // there, otherwise whatever the font actually carries — a font with only a
  // Korean or German name record still has a licence worth showing.
  const first = (record) => {
    if (!record) return null;
    const value = record.en ?? Object.values(record)[0] ?? null;
    return typeof value === 'string' && value.trim() ? value.trim() : null;
  };

  const fsType = font?.tables?.os2?.fsType ?? 0;
  return {
    fsType,
    // Bit 1 alone is the vendor saying no. Checked as an exact-zero test on the
    // permissive bits as well, because a font that sets Restricted *and* one of
    // the permissive bits is contradicting itself, and the refusal is the half
    // to believe.
    restricted: Boolean(fsType & FS_TYPE.RESTRICTED),
    noSubset: Boolean(fsType & FS_TYPE.NO_SUBSET),
    bitmapOnly: Boolean(fsType & FS_TYPE.BITMAP_ONLY),
    family: first(names.fontFamily) ?? first(names.preferredFamily),
    designer: first(names.designer),
    // Name IDs 13 and 14. These are where a foundry writes the terms, and they
    // are the two fields worth putting in front of somebody before they build a
    // derivative of a file they may not have made.
    description: first(names.license) ?? first(names.licence),
    url: first(names.licenseURL) ?? first(names.licenceURL),
  };
}

/* -------------------------------------------------------------------------- */
/* Outlines                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * A quadratic segment as a cubic, exactly.
 *
 * TrueType outlines are quadratic and CFF — what this app writes — is cubic, and
 * the conversion is not an approximation: every quadratic is a cubic whose two
 * control points sit two thirds of the way from each end toward the quadratic's
 * single control point. Nothing is lost and nothing needs fitting.
 *
 * The implied on-curve points TrueType uses between consecutive off-curve points
 * are not handled here because they are already gone: opentype.js resolves them
 * when it builds the path, so what arrives is an explicit Q per segment.
 */
const quadToCubic = (p0, c, p1) => [
  p0,
  { x: p0.x + (2 / 3) * (c.x - p0.x), y: p0.y + (2 / 3) * (c.y - p0.y) },
  { x: p1.x + (2 / 3) * (c.x - p1.x), y: p1.y + (2 / 3) * (c.y - p1.y) },
  p1,
];

/** Twice the signed area of a closed run of on-curve points. */
function twiceArea(curves) {
  let a = 0;
  const pts = curves.map((b) => b[0]);
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % pts.length];
    a += p.x * q.y - q.x * p.y;
  }
  return a;
}

/**
 * Turn one opentype.js path into this app's contour shape, in font units.
 *
 * @param {object} path      glyph.path from opentype.js
 * @param {number} scale     font units to this app's em
 * @returns {Array<{closed: true, curves: Array, outer: boolean}>}
 */
export function contoursFromPath(path, scale = 1) {
  const contours = [];
  let curves = [];
  let cursor = null;
  let start = null;
  const at = (x, y) => ({ x: x * scale, y: y * scale });

  const close = () => {
    if (curves.length) {
      // A path that ends away from where it started is closed with a straight
      // segment, which is what `Z` means. Fonts rely on this; leaving the gap
      // would leak the fill and break every scanline crossing the opening.
      if (cursor && start && (cursor.x !== start.x || cursor.y !== start.y)) {
        curves.push(line(cursor, start));
      }
      contours.push({ closed: true, curves, outer: twiceArea(curves) > 0 });
    }
    curves = [];
  };

  const line = (a, b) => [
    a,
    { x: a.x + (b.x - a.x) / 3, y: a.y + (b.y - a.y) / 3 },
    { x: a.x + (2 * (b.x - a.x)) / 3, y: a.y + (2 * (b.y - a.y)) / 3 },
    b,
  ];

  for (const cmd of path?.commands ?? []) {
    if (cmd.type === 'M') {
      close();
      cursor = at(cmd.x, cmd.y);
      start = cursor;
    } else if (cmd.type === 'L') {
      const to = at(cmd.x, cmd.y);
      if (cursor) curves.push(line(cursor, to));
      cursor = to;
    } else if (cmd.type === 'C') {
      const to = at(cmd.x, cmd.y);
      if (cursor) curves.push([cursor, at(cmd.x1, cmd.y1), at(cmd.x2, cmd.y2), to]);
      cursor = to;
    } else if (cmd.type === 'Q') {
      const to = at(cmd.x, cmd.y);
      if (cursor) curves.push(quadToCubic(cursor, at(cmd.x1, cmd.y1), to));
      cursor = to;
    } else if (cmd.type === 'Z') {
      close();
      cursor = start;
    }
  }
  close();
  return contours;
}

/* -------------------------------------------------------------------------- */
/* Normalising                                                                */
/* -------------------------------------------------------------------------- */

function boundsOf(contours) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const c of contours) {
    for (const b of c.curves) {
      for (const p of b) {
        if (p.x < x0) x0 = p.x;
        if (p.y < y0) y0 = p.y;
        if (p.x > x1) x1 = p.x;
        if (p.y > y1) y1 = p.y;
      }
    }
  }
  return Number.isFinite(x0) ? { x0, y0, x1, y1 } : null;
}

/**
 * How much to scale this font so its letters match the app's em.
 *
 * From the MEASURED height of a lowercase 'x', not from unitsPerEm. The two are
 * not the same question: unitsPerEm says how the coordinate grid is divided, and
 * fonts at 1000 and 2048 units can have wildly different x-heights within it.
 * The app's whole geometry — bearings, kerning, the bold offset, the italic
 * shear pivot — is expressed against TARGET_X_HEIGHT, so matching x-heights is
 * what makes an imported font behave like a captured one. Normalising the em
 * instead would import a font that is correctly scaled and looks wrong.
 *
 * Falls back to the em ratio when there is no 'x' to measure, which is the right
 * answer for a font that has no lowercase at all.
 */
export function scaleFor(font) {
  const upm = font?.unitsPerEm || UNITS_PER_EM;
  const x = font?.charToGlyph?.('x');
  const box = x?.getBoundingBox?.();
  const measured = box && Number.isFinite(box.y2) ? box.y2 - Math.max(0, box.y1) : 0;
  if (measured > upm * 0.05) return TARGET_X_HEIGHT / measured;
  return UNITS_PER_EM / upm;
}

/**
 * One imported glyph, shaped exactly as computeSpacing expects it.
 *
 * The invariants it has to establish are the ones normalizeGlyph establishes for
 * the photograph path: coordinates in this app's font units, baseline at y = 0,
 * and ink shifted so its leftmost point is x = 0. The first two come free — a
 * font is already expressed that way — and the third is a translation.
 *
 * @returns {object|null} null when the glyph has no outline, which is normal:
 *   `space` is a real glyph with a real advance and no ink at all.
 */
export function normaliseImported(ch, glyph, scale) {
  const contours = contoursFromPath(glyph?.path ?? glyph?.getPath?.(0, 0, 1), scale);
  const box = boundsOf(contours);
  if (!box) return null;

  // Each point is moved once, and the bookkeeping is not optional.
  //
  // contoursFromPath hands the end of one curve straight to the next as its
  // start — the same object, deliberately, because sharing it is what guarantees
  // the two stay joined no matter what happens to either. That makes a naive
  // walk over every point of every curve visit shared endpoints twice, and a
  // closing segment's endpoint three times, so the translation below was applied
  // two or three times to most of the outline. On a rectangle whose ink began at
  // x = 40 the left profile came back running from −40 to −10 instead of sitting
  // flat at 0, which computeSpacing would have read as a glyph with a large
  // negative bearing that varies down its own straight edge.
  const shift = -box.x0;
  const moved = new Set();
  for (const c of contours) {
    for (const b of c.curves) {
      for (const p of b) {
        if (moved.has(p)) continue;
        moved.add(p);
        p.x += shift;
      }
    }
  }

  const inkWidth = box.x1 - box.x0;
  const advanceWidth = (glyph.advanceWidth ?? 0) * scale;

  return {
    ch,
    // Kept so the shape matches a captured glyph exactly. Nothing downstream of
    // computeSpacing reads them — solveAllRows is what they were for, and this
    // path does not go through it — but a glyph that is the same shape as the
    // other kind is one fewer thing for the next reader to check.
    row: 0,
    col: 0,
    contours,
    ink: { x0: 0, y0: box.y0, x1: inkWidth, y1: box.y1 },
    inkWidth,
    profiles: profilesFromContours(contours),
    imported: true,
    // The bearings the font already had. `advanceWidth` is overwritten by
    // computeSpacing unless the caller restores these afterwards, which is what
    // `preserveBearings` below is for.
    original: {
      advanceWidth,
      lsb: shift === 0 ? box.x0 : box.x0,
      rsb: advanceWidth - box.x1,
    },
  };
}

/**
 * Rebuild what an autosave did not store.
 *
 * session.js keeps the contours and the original bearings and nothing else,
 * because ink, inkWidth and profiles are all functions of the contours — sixty
 * scanlines times three arrays per glyph of data that can be recomputed in a
 * millisecond. Without this they are simply absent after a reload, and
 * computeSpacing reads `g.ink.y1` of undefined on the first glyph it touches.
 *
 * It has to agree with normaliseImported exactly. If the two ever drift, a font
 * built after a reload is spaced differently from the same font built before
 * one, which is the kind of difference nobody thinks to look for. They sit
 * beside each other for that reason, and a test compares their output.
 */
export function rehydrateImported(g) {
  if (!g?.contours?.length || g.profiles) return g;
  const box = boundsOf(g.contours);
  if (!box) return g;
  g.ink = { x0: 0, y0: box.y0, x1: box.x1 - box.x0, y1: box.y1 };
  g.inkWidth = box.x1 - box.x0;
  g.profiles = profilesFromContours(g.contours);
  g.imported = true;
  return g;
}

/**
 * Put back the spacing the font arrived with.
 *
 * computeSpacing overwrites lsb, rsb and advanceWidth on every glyph it is given,
 * which is right for a photograph — nothing has decided them yet — and wrong for
 * a font, where somebody already did. Call this after computeSpacing to keep the
 * original spacing while still getting the ascender and descender it measured.
 */
export function preserveBearings(glyphs) {
  for (const g of glyphs) {
    if (!g.original) continue;
    g.lsb = g.original.lsb;
    g.rsb = g.original.rsb;
    g.advanceWidth = g.original.advanceWidth;
  }
  return glyphs;
}

/* -------------------------------------------------------------------------- */
/* The whole read                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Read a font file into glyphs this pipeline can compile.
 *
 * @param {ArrayBuffer} buffer
 * @param {object} [opts]
 * @param {string[]} [opts.chars]  which characters to take; defaults to whatever
 *   the font has of the app's own charset
 * @returns {{glyphs: Array, licence: object, unitsPerEm: number, scale: number,
 *            found: string[], missing: string[]}}
 */
export function readFont(buffer, { chars = null } = {}) {
  const font = lib().parse(buffer);
  const scale = scaleFor(font);
  const wanted = chars ?? [];

  const glyphs = [];
  const found = [];
  const missing = [];

  for (const ch of wanted) {
    const glyph = font.charToGlyph(ch);
    // charToGlyph never returns null — it falls back to .notdef, whose name is
    // the only way to tell "this font has no such character" from "it has one".
    if (!glyph || glyph.name === '.notdef' || glyph.unicode !== ch.codePointAt(0)) {
      missing.push(ch);
      continue;
    }
    const g = normaliseImported(ch, glyph, scale);
    if (!g) { missing.push(ch); continue; }
    glyphs.push(g);
    found.push(ch);
  }

  return {
    glyphs,
    licence: licence(font),
    unitsPerEm: font.unitsPerEm,
    scale,
    found,
    missing,
  };
}
