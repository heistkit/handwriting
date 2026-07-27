/**
 * fontbuild.js — outlines and metrics into a real, installable font family.
 *
 * Three things happen here that are worth flagging up front.
 *
 * FOUR STYLES FROM ONE SAMPLE. Nobody is going to write the alphabet out four
 * times in different weights. So Bold is synthesised by pushing every outline
 * point along its own outward normal, and Italic by shearing about the middle
 * of the x-height band. Both are geometric operations on the writer's own
 * shapes, which is what keeps the family recognisably one hand. Without this,
 * markdown **bold** and *italic* fall back to the host app's fake-bold smear.
 *
 * VARIANTS, EVEN FROM A SINGLE SAMPLE. Real handwriting never repeats a letter
 * identically, and a font that does reads as stamped. If the writer supplied
 * two or three takes of a letter we use them; if they supplied one, we generate
 * siblings by nudging rotation, scale and baseline by amounts too small to look
 * deliberate but large enough to break the pattern.
 *
 * ROTATION VIA GSUB. Those variants are cycled by a `calt` feature built from a
 * chaining contextual substitution: a glyph preceded by a default becomes
 * variant 1, one preceded by variant 1 becomes variant 2, and one preceded by
 * variant 2 is left alone — which lands back at the default and closes a
 * three-cycle. Because the shaper rewrites the buffer as it walks forward, each
 * position sees what the previous position just became, so the cycle advances
 * on its own with no randomness and no per-glyph rules.
 */

import { UNITS_PER_EM, TARGET_X_HEIGHT, deriveSpaceWidth } from './metrics.js';
import { REQUIRED, DERIVED_GLYPHS, LIGATURES, BY_CHAR } from './charset.js';

/** opentype.js is a UMD bundle; the browser loads it via a script tag. */
function ot() {
  const lib = globalThis.opentype;
  if (!lib) throw new Error('opentype.js is not loaded');
  return lib;
}

// ---------------------------------------------------------------------------
// Contour transforms
// ---------------------------------------------------------------------------

const clone = (contours) =>
  contours.map((c) => ({ ...c, curves: c.curves.map((b) => b.map((p) => ({ x: p.x, y: p.y }))) }));

function mapPoints(contours, fn) {
  return contours.map((c) => ({ ...c, curves: c.curves.map((b) => b.map(fn)) }));
}

export function boundsOf(contours) {
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
 * Thicken outlines by displacing every point along the local outward normal.
 *
 * The winding convention does the hard part. Outer contours run
 * counter-clockwise in font space and holes run clockwise, so the single
 * expression `normal = (ty, −tx)` points away from the ink on an outer contour
 * *and* into the ink on a hole — meaning one formula both grows the letter and
 * shrinks its counters, which is exactly what emboldening means.
 *
 * Sharp corners can self-intersect slightly at larger weights. That is harmless
 * here: CFF fills by the non-zero winding rule, so overlapping ink of the same
 * direction simply stays filled rather than punching a hole.
 */
export function embolden(contours, amount) {
  if (!amount) return clone(contours);

  return contours.map((c) => {
    // The control polygon, visited once: p0, c1, c2 of each curve in turn. The
    // fourth point of each curve is the next curve's first, so including it
    // would double every on-curve point and halve its effective offset.
    const flat = [];
    for (const b of c.curves) flat.push(b[0], b[1], b[2]);
    const n = flat.length;
    if (n < 3) return { ...c, curves: c.curves.map((b) => b.map((p) => ({ ...p }))) };

    const moved = flat.map((p, i) => {
      // Widen the sampling window until a usable tangent appears; coincident
      // control points are common where a curve meets a corner.
      let tx = 0, ty = 0;
      for (let span = 1; span <= 3; span++) {
        const a = flat[(i - span + n) % n];
        const b = flat[(i + span) % n];
        tx = b.x - a.x;
        ty = b.y - a.y;
        if (Math.hypot(tx, ty) > 1e-6) break;
      }
      const len = Math.hypot(tx, ty);
      if (len < 1e-6) return { x: p.x, y: p.y };
      return { x: p.x + (ty / len) * amount, y: p.y + (-tx / len) * amount };
    });

    const curves = [];
    for (let i = 0; i < c.curves.length; i++) {
      curves.push([
        moved[i * 3],
        moved[i * 3 + 1],
        moved[i * 3 + 2],
        moved[((i + 1) * 3) % n],
      ]);
    }
    return { ...c, curves };
  });
}

/**
 * Shear for italic.
 *
 * The pivot is the middle of the x-height band rather than the baseline. Pivot
 * at the baseline and a tall letter's advance has to grow by its full height
 * times the tangent, so 'l' ends up dramatically wider than its neighbours and
 * the line's rhythm breaks. Pivoting mid-band lets the top lean right while the
 * bottom leans left by the same amount, leaving the horizontal centre — and
 * therefore the advance width — where it was.
 */
export function slant(contours, angleDeg, pivotY = TARGET_X_HEIGHT / 2) {
  const t = Math.tan((angleDeg * Math.PI) / 180);
  if (!t) return clone(contours);
  return mapPoints(contours, (p) => ({ x: p.x + (p.y - pivotY) * t, y: p.y }));
}

/** Rotate / scale / translate about a point, used to generate letter variants. */
export function jitter(contours, { rotateDeg = 0, scale = 1, dx = 0, dy = 0 }, centre) {
  const a = (rotateDeg * Math.PI) / 180;
  const cos = Math.cos(a), sin = Math.sin(a);
  return mapPoints(contours, (p) => {
    const px = (p.x - centre.x) * scale;
    const py = (p.y - centre.y) * scale;
    return {
      x: centre.x + px * cos - py * sin + dx,
      y: centre.y + px * sin + py * cos + dy,
    };
  });
}

const translate = (contours, dx, dy = 0) =>
  mapPoints(contours, (p) => ({ x: p.x + dx, y: p.y + dy }));

/** Mirror horizontally within the glyph's own ink width. */
function mirror(contours) {
  const b = boundsOf(contours);
  if (!b) return clone(contours);
  // Reversing x reverses winding too, so contour direction must be flipped back
  // or every outer contour would start punching holes in its neighbours.
  return contours.map((c) => ({
    ...c,
    curves: c.curves
      .map((bez) => bez.map((p) => ({ x: b.x1 - (p.x - b.x0), y: p.y })).reverse())
      .reverse(),
  }));
}

const scaleX = (contours, factor) => mapPoints(contours, (p) => ({ x: p.x * factor, y: p.y }));

// ---------------------------------------------------------------------------
// Glyph definitions
// ---------------------------------------------------------------------------

/*
 * How different a variant is from its parent.
 *
 * Deliberately small: the eye should register texture, never a wobble. Exported
 * because the landing-page demo shows the same variation on the visitor's own
 * letter, and a demo carrying its own copy of these numbers would drift out of
 * step with the font it is describing the moment either changed.
 */
export const VARIANT_ROTATION = 1.1;
export const VARIANT_SCALE = 0.014;
export const VARIANT_SHIFT = 0.016;

/** Re-exported so callers outside the build do not have to reach into metrics. */
export const TARGET_X_HEIGHT_UNITS = TARGET_X_HEIGHT;

/**
 * Assemble every glyph the font will contain, including derived characters and
 * variants, keyed by PostScript name.
 */
export function buildGlyphDefs(glyphs, spacing, opts = {}) {
  const {
    variantCount = 3,
    variantRotation = VARIANT_ROTATION,
    variantScale = VARIANT_SCALE,
    variantShift = VARIANT_SHIFT,
  } = opts;

  const defs = new Map();
  const byChar = new Map();

  // Multiple takes of the same character arrive as separate entries.
  for (const g of glyphs) {
    if (!byChar.has(g.ch)) byChar.set(g.ch, []);
    byChar.get(g.ch).push(g);
  }

  for (const entry of REQUIRED) {
    const takes = byChar.get(entry.ch);
    if (!takes || !takes.length) continue;

    const base = takes[0];
    defs.set(entry.name, {
      name: entry.name,
      ch: entry.ch,
      unicode: entry.unicode,
      contours: base.contours,
      lsb: base.lsb,
      rsb: base.rsb,
      inkWidth: base.inkWidth,
      advanceWidth: base.advanceWidth,
      variants: [],
    });

    // Extra takes become genuine variants; anything still missing is generated.
    const def = defs.get(entry.name);
    for (let v = 1; v < variantCount; v++) {
      const take = takes[v];
      let contours, advanceWidth, lsb;

      if (take) {
        contours = take.contours;
        advanceWidth = take.advanceWidth;
        lsb = take.lsb;
      } else {
        const b = boundsOf(base.contours);
        if (!b) continue;
        const centre = { x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2 };
        // Alternate the sign so variant 1 and variant 2 lean opposite ways;
        // two nudges in the same direction would read as a drift, not texture.
        const sign = v % 2 === 0 ? 1 : -1;
        contours = jitter(
          base.contours,
          {
            rotateDeg: variantRotation * sign,
            scale: 1 + variantScale * sign * 0.6,
            dy: TARGET_X_HEIGHT * variantShift * sign * 0.5,
          },
          centre
        );
        advanceWidth = base.advanceWidth;
        lsb = base.lsb;
      }

      const name = `${entry.name}.alt${v}`;
      def.variants.push(name);
      defs.set(name, {
        name,
        ch: null,
        unicode: null,
        contours,
        lsb,
        rsb: base.rsb,
        inkWidth: base.inkWidth,
        advanceWidth,
        variants: [],
        variantOf: entry.name,
      });
    }
  }

  // Joined pairs, if the writer filled in the optional sheet. These carry no
  // unicode of their own — they are reachable only by typing their letters and
  // letting the `liga` feature swap them in.
  for (const lig of LIGATURES) {
    const takes = byChar.get(lig.seq);
    if (!takes || !takes.length) continue;
    const base = takes[0];
    defs.set(lig.name, {
      name: lig.name,
      ch: lig.seq,
      unicode: null,
      contours: base.contours,
      lsb: base.lsb,
      rsb: base.rsb,
      inkWidth: base.inkWidth,
      advanceWidth: base.advanceWidth,
      variants: [],
      isLigature: true,
      components: lig.components,
    });
  }

  // Derived characters, built from whatever the writer already gave us.
  for (const entry of DERIVED_GLYPHS) {
    const src = defs.get(entry.derive.from);
    if (!src) continue;

    let contours = clone(src.contours);
    let advanceWidth = src.advanceWidth;

    switch (entry.derive.op) {
      case 'copy':
        break;
      case 'mirror':
        contours = mirror(contours);
        break;
      case 'stretch':
        contours = scaleX(contours, entry.derive.factor);
        advanceWidth = src.lsb + src.inkWidth * entry.derive.factor + src.rsb;
        break;
      case 'repeat': {
        const gap = src.advanceWidth * (entry.derive.gap ?? 0.6);
        const all = [];
        for (let i = 0; i < entry.derive.count; i++) {
          all.push(...translate(clone(src.contours), i * gap));
        }
        contours = all;
        advanceWidth = src.lsb + gap * (entry.derive.count - 1) + src.inkWidth + src.rsb;
        break;
      }
      default:
        break;
    }

    defs.set(entry.name, {
      name: entry.name,
      ch: entry.ch,
      unicode: entry.unicode,
      contours,
      lsb: src.lsb,
      rsb: src.rsb,
      inkWidth: boundsOf(contours) ? boundsOf(contours).x1 - boundsOf(contours).x0 : src.inkWidth,
      advanceWidth,
      variants: [],
    });
  }

  return defs;
}

// ---------------------------------------------------------------------------
// opentype.js assembly
// ---------------------------------------------------------------------------

/** Convert traced contours into an opentype.js Path. */
function toPath(contours, offsetX = 0) {
  const { Path } = ot();
  const path = new Path();
  for (const c of contours) {
    if (!c.curves.length) continue;
    const start = c.curves[0][0];
    path.moveTo(round(start.x + offsetX), round(start.y));
    for (const b of c.curves) {
      path.curveTo(
        round(b[1].x + offsetX), round(b[1].y),
        round(b[2].x + offsetX), round(b[2].y),
        round(b[3].x + offsetX), round(b[3].y)
      );
    }
    path.close();
  }
  return path;
}

/**
 * Outline coordinates, rounded to whole font units.
 *
 * CFF charstrings hold integers, so a fractional coordinate is rounded during
 * encoding no matter what — but opentype.js derives usWinAscent and usWinDescent
 * from the path BEFORE that rounding happens. A glyph reaching 889.6 was
 * therefore written into the file at 890 and declared at 889, and a font whose
 * declared height sits one unit inside its own ink clips a terminal in some
 * Windows applications and nowhere else. It was 0.1-unit precision here, which
 * on a 1000-unit em is a tenth of nothing and bought exactly this.
 *
 * Rounding first makes the two agree by construction.
 */
const round = (n) => Math.round(n);

function notdefGlyph(advance) {
  const { Glyph, Path } = ot();
  const p = new Path();
  const w = advance * 0.72, h = TARGET_X_HEIGHT * 1.3, x = advance * 0.14, t = 40;
  // A hollow box, drawn as an outer rectangle plus a reversed inner one.
  p.moveTo(x, 0); p.lineTo(x + w, 0); p.lineTo(x + w, h); p.lineTo(x, h); p.close();
  p.moveTo(x + t, t); p.lineTo(x + t, h - t); p.lineTo(x + w - t, h - t); p.lineTo(x + w - t, t); p.close();
  return new Glyph({ name: '.notdef', unicode: 0, advanceWidth: Math.round(advance), path: p });
}

/**
 * Build one style of the family.
 *
 * @param {Map} defs      glyph definitions from buildGlyphDefs
 * @param {object} style  { name, boldAmount, slantDeg, weightClass, fsSelection, italicAngle }
 */
export function buildStyle(defs, style, opts = {}) {
  const { Font, Glyph } = ot();
  const {
    familyName = 'My Handwriting',
    spaceWidth = 320,
    designer = 'Written by hand',
  } = opts;

  const order = [];
  const glyphList = [];

  // The real vertical extremes, accumulated from the outlines actually written
  // rather than measured separately afterwards. See the note where they are
  // used: measuring anything other than these exact paths is how the declared
  // metrics came to sit two units inside the ink they are supposed to contain.
  let yMax = 0;
  let yMin = 0;
  const cover = (b) => {
    if (!b) return;
    if (b.y1 > yMax) yMax = b.y1;
    if (b.y0 < yMin) yMin = b.y0;
  };

  // Index 0 must be .notdef; index 1 is space by long-standing convention.
  const notdef = notdefGlyph(spaceWidth * 1.4);
  glyphList.push(notdef);
  order.push('.notdef');
  {
    const bb = notdef.path.getBoundingBox();
    cover({ x0: bb.x1, y0: bb.y1, x1: bb.x2, y1: bb.y2 });
  }

  glyphList.push(
    new Glyph({ name: 'space', unicode: 32, advanceWidth: Math.round(spaceWidth), path: new (ot().Path)() })
  );
  order.push('space');

  // Base glyphs first, then variants, so indices stay stable and readable.
  const bases = [...defs.values()].filter((d) => !d.variantOf);
  const variants = [...defs.values()].filter((d) => d.variantOf);

  for (const def of [...bases, ...variants]) {
    let contours = def.contours;
    if (style.boldAmount) contours = embolden(contours, style.boldAmount);
    if (style.slantDeg) contours = slant(contours, style.slantDeg);

    const b = boundsOf(contours);
    if (!b) continue;
    cover(b);

    // Emboldening grows the ink on both sides; re-anchoring here keeps the
    // bearings meaningful instead of letting the extra weight eat into them.
    const inkWidth = b.x1 - b.x0;
    const offsetX = def.lsb - b.x0;
    const advanceWidth = Math.max(1, Math.round(def.lsb + inkWidth + def.rsb));

    glyphList.push(
      new Glyph({
        name: def.name,
        unicode: def.unicode ?? undefined,
        advanceWidth,
        path: toPath(contours, offsetX),
      })
    );
    order.push(def.name);
  }

  // Vertical metrics from the real extremes, padded, so nothing ever clips.
  //
  // The extremes are now accumulated in the loop above, from the same contours
  // that became the paths. They used to be measured here in a separate pass
  // over `def.contours` — the outlines BEFORE this style's embolden and slant —
  // and that pass skipped .notdef, which is not in `defs` at all. So the number
  // describing the ink was taken from something other than the ink: on a real
  // export, usWinAscent came out 815 against a true extreme of 817, and
  // usWinDescent 216 against −218. Two units, which is exactly the kind of
  // margin that clips a terminal in some Windows applications and nowhere else,
  // so it survives every test that renders the font somewhere reasonable.
  //
  // Emboldening is the reason it is not merely tidier to measure late: it grows
  // the ink outward on every side, so the Bold styles genuinely reach further
  // than the outlines the old pass was looking at.
  //
  // Math.ceil rather than round on both, so the padded value can only ever land
  // outside the ink it is padding.
  const ascender = Math.max(Math.ceil(yMax * 1.06), Math.round(TARGET_X_HEIGHT * 1.5));
  const descender = Math.min(Math.floor(yMin * 1.06), -Math.round(TARGET_X_HEIGHT * 0.4));

  const postScriptName = `${familyName.replace(/[^A-Za-z0-9]/g, '')}-${style.name.replace(/\s/g, '')}`;

  const font = new Font({
    familyName,
    styleName: style.name,
    fullName: `${familyName} ${style.name}`,
    postScriptName,
    designer,
    unitsPerEm: UNITS_PER_EM,
    ascender,
    descender,
    weightClass: style.weightClass,
    fsSelection: style.fsSelection,
    glyphs: glyphList,
  });

  const index = new Map(order.map((n, i) => [n, i]));
  return { font, index, order, style };
}

// ---------------------------------------------------------------------------
// calt — rotating letter variants
// ---------------------------------------------------------------------------

/**
 * Build the GSUB table that cycles variants.
 *
 * Lookup 0 maps every default glyph to its first variant; lookup 1 maps every
 * default to its second. Lookup 2 is the chaining rule that decides which
 * applies, based purely on what the *previous* glyph has already become:
 *
 *   preceded by a default  → variant 1
 *   preceded by variant 1  → variant 2
 *   preceded by variant 2  → left alone, i.e. back to the default
 *
 * Three states, one step each, and the buffer's own left-to-right rewriting
 * supplies the state machine. The two chaining subtables have disjoint
 * backtrack sets, so their order is irrelevant.
 *
 * Coverage tables require ascending glyph ids, which is why everything is
 * sorted on the way out — an unsorted coverage silently matches the wrong
 * glyphs rather than failing loudly.
 */
export function buildGsub(defs, index) {
  const lookups = [];
  const features = [];

  // --- liga ----------------------------------------------------------------
  // Emitted first so it occupies the lowest lookup indices. Application order
  // follows the lookup list, not the feature list, so putting ligatures first
  // is what guarantees 't'+'h' has already become 't_h' before variant
  // rotation gets a chance to swap either letter for an alternate.
  const ligature = buildLigatureLookup(defs, index);
  if (ligature) {
    lookups.push(ligature);
    features.push({
      tag: 'liga',
      feature: { featureParams: 0, lookupListIndexes: [lookups.length - 1] },
    });
  }

  const calt = buildCaltLookups(defs, index, lookups.length);
  if (calt) {
    lookups.push(...calt.lookups);
    features.push({
      tag: 'calt',
      feature: { featureParams: 0, lookupListIndexes: [calt.chainIndex] },
    });
  }

  if (!lookups.length) return null;

  const langSys = {
    reserved: 0,
    reqFeatureIndex: 0xffff,
    featureIndexes: features.map((_, i) => i),
  };

  return {
    version: 1,
    scripts: [
      { tag: 'DFLT', script: { defaultLangSys: langSys, langSysRecords: [] } },
      { tag: 'latn', script: { defaultLangSys: langSys, langSysRecords: [] } },
    ],
    features,
    lookups,
  };
}

/**
 * LigatureSubst (lookup type 4).
 *
 * Ligatures are grouped by their first glyph: coverage lists each distinct
 * first letter, and the ligature set at the same position holds every joined
 * pair starting with it. Only the *second* component onward is stored, since
 * the first is already implied by coverage — the count written is one greater
 * than the stored list to account for it.
 */
function buildLigatureLookup(defs, index) {
  const ligs = [...defs.values()].filter((d) => d.isLigature && d.components?.length >= 2);
  if (!ligs.length) return null;

  const byFirst = new Map();
  for (const lig of ligs) {
    const ligGlyph = index.get(lig.name);
    const parts = lig.components.map((c) => index.get(BY_CHAR.get(c)?.name));
    if (ligGlyph == null || parts.some((p) => p == null)) continue;

    const first = parts[0];
    if (!byFirst.has(first)) byFirst.set(first, []);
    byFirst.get(first).push({ ligGlyph, components: parts.slice(1) });
  }
  if (!byFirst.size) return null;

  const firsts = [...byFirst.keys()].sort((a, b) => a - b);
  return {
    lookupType: 4,
    lookupFlag: 0,
    subtables: [
      {
        substFormat: 1,
        coverage: { format: 1, glyphs: firsts },
        // Longer sequences must be listed before shorter ones so a three-letter
        // ligature is never pre-empted by a two-letter prefix of itself.
        ligatureSets: firsts.map((f) =>
          byFirst.get(f).sort((a, b) => b.components.length - a.components.length)
        ),
      },
    ],
  };
}

/** The three lookups that rotate letter variants; see the note above. */
function buildCaltLookups(defs, index, baseIndex) {
  const withVariants = [...defs.values()].filter((d) => d.variants.length > 0);
  if (!withVariants.length) return null;

  const defaults = [];
  const alt1 = [];
  const alt2 = [];

  for (const def of withVariants) {
    const base = index.get(def.name);
    const v1 = index.get(def.variants[0]);
    const v2 = index.get(def.variants[1]);
    if (base == null || v1 == null) continue;
    defaults.push(base);
    alt1.push(v1);
    alt2.push(v2 ?? v1); // fall back to variant 1 if only one exists
  }
  if (!defaults.length) return null;

  // Sort default ids ascending, carrying their substitutes along, so coverage
  // index i still corresponds to substitute i.
  const paired = defaults
    .map((g, i) => ({ g, a1: alt1[i], a2: alt2[i] }))
    .sort((p, q) => p.g - q.g);

  const covDefaults = paired.map((p) => p.g);
  const subsTo1 = paired.map((p) => p.a1);
  const subsTo2 = paired.map((p) => p.a2);

  const sortedAlt1 = [...new Set(subsTo1)].sort((a, b) => a - b);
  const sortedAlt2 = [...new Set(subsTo2)].sort((a, b) => a - b);

  const coverage = (glyphs) => ({ format: 1, glyphs });

  // Positions within the shared lookup list. The chaining subtables reference
  // the two substitution lookups by absolute index, so they have to be offset
  // by however many lookups (the ligature one, typically) already exist.
  const toAlt1Index = baseIndex;
  const toAlt2Index = baseIndex + 1;
  const chainIndex = baseIndex + 2;

  const lookups = [
    // default → variant 1
    {
      lookupType: 1,
      lookupFlag: 0,
      subtables: [{ substFormat: 2, coverage: coverage(covDefaults), substitute: subsTo1 }],
    },
    // default → variant 2
    {
      lookupType: 1,
      lookupFlag: 0,
      subtables: [{ substFormat: 2, coverage: coverage(covDefaults), substitute: subsTo2 }],
    },
    // the chaining rule that picks between them
    {
      lookupType: 6,
      lookupFlag: 0,
      subtables: [
        {
          substFormat: 3,
          backtrackCoverage: [coverage(covDefaults)],
          inputCoverage: [coverage(covDefaults)],
          lookaheadCoverage: [],
          lookupRecords: [{ sequenceIndex: 0, lookupListIndex: toAlt1Index }],
        },
        {
          substFormat: 3,
          backtrackCoverage: [coverage(sortedAlt1)],
          inputCoverage: [coverage(covDefaults)],
          lookaheadCoverage: [],
          lookupRecords: [{ sequenceIndex: 0, lookupListIndex: toAlt2Index }],
        },
      ],
    },
  ];

  // Only the chaining lookup is exposed to the feature; the two substitution
  // lookups are reachable solely through it.
  return { lookups, chainIndex, altGlyphs: { alt1: sortedAlt1, alt2: sortedAlt2 } };
}

// ---------------------------------------------------------------------------
// The family
// ---------------------------------------------------------------------------

export const STYLES = [
  { name: 'Regular', boldAmount: 0, slantDeg: 0, weightClass: 400, fsSelection: 0x40, italic: false },
  { name: 'Bold', boldAmount: 1, slantDeg: 0, weightClass: 700, fsSelection: 0x20, italic: false },
  { name: 'Italic', boldAmount: 0, slantDeg: 1, weightClass: 400, fsSelection: 0x01, italic: true },
  { name: 'Bold Italic', boldAmount: 1, slantDeg: 1, weightClass: 700, fsSelection: 0x21, italic: true },
];

/**
 * Build all four styles.
 *
 * @param {Array}  glyphs   normalised glyphs from metrics.buildMetrics
 * @param {object} spacing
 * @param {Array}  kerning
 */
export function buildFamily(glyphs, spacing, kerning, opts = {}) {
  const {
    familyName = 'My Handwriting',
    boldStrength = 0.020,
    italicAngle = 11,
    variantCount = 3,
    styles = STYLES,
  } = opts;

  const defs = buildGlyphDefs(glyphs, spacing, { ...opts, variantCount });
  const spaceWidth = deriveSpaceWidth(glyphs, spacing);

  const built = [];
  for (const style of styles) {
    const resolved = {
      ...style,
      boldAmount: style.boldAmount * boldStrength * UNITS_PER_EM,
      slantDeg: style.slantDeg * italicAngle,
    };
    const { font, index, order } = buildStyle(defs, resolved, {
      familyName,
      spaceWidth,
      ...opts,
    });

    const gsub = buildGsub(defs, index);
    if (gsub) font.tables.gsub = gsub;

    built.push({
      style: style.name,
      italic: style.italic,
      italicAngle: style.italic ? -italicAngle : 0,
      weightClass: style.weightClass,
      font,
      index,
      order,
      // Kerning is emitted separately: opentype.js cannot write GPOS, so it is
      // spliced into the finished binary. See gpos.js.
      kerning: kerning
        .map((k) => ({
          left: index.get(nameFor(k.left)),
          right: index.get(nameFor(k.right)),
          value: k.value,
        }))
        .filter((k) => k.left != null && k.right != null),
      defs,
    });
  }

  return { styles: built, defs, spaceWidth };
}

function nameFor(glyph) {
  return BY_CHAR.get(glyph.ch)?.name ?? glyph.ch;
}
