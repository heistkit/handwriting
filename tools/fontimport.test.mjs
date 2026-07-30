/**
 * Checks on reading an existing font into the pipeline.
 *
 * The fixtures are built with opentype.js rather than by photographing anything,
 * so the geometry going in is exact and every assertion has an analytic answer.
 * A round trip through the image pipeline would test the image pipeline.
 *
 * Three things have to hold for an imported font to behave like a captured one:
 * the quadratic-to-cubic conversion has to be exact rather than fitted, the scale
 * has to come from the x-height rather than the em, and the spacing the font
 * already had has to survive computeSpacing overwriting it.
 */

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass });
  console.log(`  ${pass ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};

export async function run() {
  console.log('\nfontimport.js');

  const mod = await import('../vendor/opentype.js');
  const opentype = mod.default ?? mod;
  globalThis.opentype = opentype;

  const { contoursFromPath, scaleFor, normaliseImported, readFont, licence, preserveBearings } =
    await import('../src/fontimport.js');
  const { TARGET_X_HEIGHT, computeSpacing } = await import('../src/metrics.js');

  // -- quadratics convert exactly, not approximately ------------------------
  {
    const path = new opentype.Path();
    path.moveTo(0, 0);
    path.quadraticCurveTo(100, 200, 200, 0);
    path.close();

    const [contour] = contoursFromPath(path, 1);
    const bez = contour.curves[0];
    const quad = (t) => {
      const m = 1 - t;
      return {
        x: m * m * 0 + 2 * m * t * 100 + t * t * 200,
        y: m * m * 0 + 2 * m * t * 200 + t * t * 0,
      };
    };
    const cubic = (t) => {
      const m = 1 - t;
      return {
        x: m * m * m * bez[0].x + 3 * m * m * t * bez[1].x + 3 * m * t * t * bez[2].x + t * t * t * bez[3].x,
        y: m * m * m * bez[0].y + 3 * m * m * t * bez[1].y + 3 * m * t * t * bez[2].y + t * t * t * bez[3].y,
      };
    };
    let worst = 0;
    for (let i = 0; i <= 20; i++) {
      const t = i / 20;
      const a = quad(t), b = cubic(t);
      worst = Math.max(worst, Math.hypot(a.x - b.x, a.y - b.y));
    }
    check('a quadratic becomes the identical cubic, not a fit',
      worst < 1e-9, `worst deviation ${worst.toExponential(2)} units`);
  }

  // -- a path that never returns to its start is closed anyway --------------
  {
    // `Z` is an instruction, not a repeated point. An unclosed run leaks the
    // fill and every scanline crossing the gap reads a span that is not there.
    const path = new opentype.Path();
    path.moveTo(0, 0);
    path.lineTo(100, 0);
    path.lineTo(100, 100);
    path.close();
    const [c] = contoursFromPath(path, 1);
    const last = c.curves[c.curves.length - 1][3];
    check('an open run is closed back to where it started',
      Math.hypot(last.x - 0, last.y - 0) < 1e-9, `ends at ${last.x},${last.y}`);
  }

  /** A font whose letters are rectangles of exactly known size. */
  const makeFont = ({ upm = 1000, xHeight = 500, fsType = 0 } = {}) => {
    const rect = (name, unicode, w, h, advance, lsb = 40) => {
      const path = new opentype.Path();
      path.moveTo(lsb, 0);
      path.lineTo(lsb + w, 0);
      path.lineTo(lsb + w, h);
      path.lineTo(lsb, h);
      path.close();
      return new opentype.Glyph({ name, unicode, advanceWidth: advance, path });
    };
    // Sized against the x-height, not in absolute units. Two fixtures whose
    // letters are "300 units wide" in a 1000-unit and a 2048-unit em are not the
    // same letter at different scales, they are a wide letter and a narrow one —
    // and asking whether they import to the same size is then meaningless.
    const u = xHeight / 500;
    const glyphs = [
      new opentype.Glyph({ name: '.notdef', unicode: 0, advanceWidth: upm / 2, path: new opentype.Path() }),
      rect('x', 'x'.codePointAt(0), 300 * u, xHeight, 380 * u, 40 * u),
      rect('o', 'o'.codePointAt(0), 320 * u, xHeight, 400 * u, 40 * u),
      rect('l', 'l'.codePointAt(0), 90 * u, xHeight * 1.5, 170 * u, 40 * u),
    ];
    const font = new opentype.Font({
      familyName: 'ImportFixture', styleName: 'Regular',
      unitsPerEm: upm, ascender: Math.round(upm * 0.8), descender: -Math.round(upm * 0.2),
      glyphs,
    });
    if (fsType) font.tables.os2.fsType = fsType;
    return font;
  };

  // -- the scale comes from the x-height, not the em ------------------------
  {
    // Two fonts with the same x-height in different coordinate grids must import
    // to the same size. Normalising the em instead would scale them differently
    // and both would be wrong against TARGET_X_HEIGHT.
    const a = opentype.parse(makeFont({ upm: 1000, xHeight: 500 }).toArrayBuffer());
    const b = opentype.parse(makeFont({ upm: 2048, xHeight: 1024 }).toArrayBuffer());
    const ga = normaliseImported('x', a.charToGlyph('x'), scaleFor(a));
    const gb = normaliseImported('x', b.charToGlyph('x'), scaleFor(b));

    check('a 1000-unit font lands on the target x-height',
      Math.abs(ga.ink.y1 - TARGET_X_HEIGHT) < 2, `${ga.ink.y1.toFixed(1)} vs ${TARGET_X_HEIGHT}`);
    check('and a 2048-unit font lands in the same place',
      Math.abs(gb.ink.y1 - TARGET_X_HEIGHT) < 2, `${gb.ink.y1.toFixed(1)}`);
    check('so the same letter is the same size from either',
      Math.abs(ga.inkWidth - gb.inkWidth) < 2,
      `${ga.inkWidth.toFixed(1)} vs ${gb.inkWidth.toFixed(1)}`);

    // A font with an unusually small x-height for its em must NOT be scaled as
    // if it were ordinary — this is the case the em ratio gets wrong.
    const c = opentype.parse(makeFont({ upm: 1000, xHeight: 250 }).toArrayBuffer());
    const gc = normaliseImported('x', c.charToGlyph('x'), scaleFor(c));
    check('an unusually small x-height is scaled up to match, not left short',
      Math.abs(gc.ink.y1 - TARGET_X_HEIGHT) < 2, `${gc.ink.y1.toFixed(1)}`);
  }

  // -- the ink is placed the way the metrics stage requires -----------------
  {
    const font = opentype.parse(makeFont().toArrayBuffer());
    const g = normaliseImported('o', font.charToGlyph('o'), scaleFor(font));
    check('ink starts at x = 0, as normalizeGlyph leaves it',
      Math.abs(g.ink.x0) < 1e-9, `${g.ink.x0}`);
    check('the baseline is still y = 0', Math.abs(g.ink.y0) < 1e-9, `${g.ink.y0}`);
    check('and a profile was measured off the outlines',
      g.profiles.ys.length > 20 && g.profiles.left.every((v) => Math.abs(v) < 0.01),
      `${g.profiles.ys.length} scanlines, widest left edge ${Math.max(...g.profiles.left).toExponential(1)} units`);
  }

  // -- the font's own spacing survives --------------------------------------
  {
    const font = opentype.parse(makeFont().toArrayBuffer());
    const { glyphs, found, missing } = readFont(font.toArrayBuffer(), { chars: ['x', 'o', 'l', 'Q'] });
    check('every character the font has is read', found.join('') === 'xol', found.join(''));
    check('and one it does not have is reported, not invented',
      missing.join('') === 'Q', missing.join(''));

    const before = glyphs.map((g) => g.original.advanceWidth);
    computeSpacing(glyphs, {});
    const rederived = glyphs.map((g) => g.advanceWidth);
    check('computeSpacing does overwrite the advances',
      rederived.some((w, i) => Math.abs(w - before[i]) > 1), 'otherwise the next check proves nothing');

    preserveBearings(glyphs);
    const after = glyphs.map((g) => g.advanceWidth);
    check('and preserveBearings puts the font’s own spacing back',
      after.every((w, i) => Math.abs(w - before[i]) < 1e-6),
      after.map((w) => w.toFixed(1)).join(' '));
  }

  // -- what the file says about its own licence -----------------------------
  {
    const plain = opentype.parse(makeFont().toArrayBuffer());
    check('an installable font is not flagged as restricted', licence(plain).restricted === false,
      `fsType ${licence(plain).fsType}`);

    const locked = opentype.parse(makeFont({ fsType: 0x0002 }).toArrayBuffer());
    const l = licence(locked);
    check('a font whose vendor forbids embedding is flagged', l.restricted === true, `fsType ${l.fsType}`);
    check('and the family name is read for showing to the reader',
      l.family === 'ImportFixture', String(l.family));

    const noSub = opentype.parse(makeFont({ fsType: 0x0100 }).toArrayBuffer());
    check('no-subsetting is noted but is not a refusal',
      licence(noSub).noSubset === true && licence(noSub).restricted === false);
  }

  return results;
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}`) run();
