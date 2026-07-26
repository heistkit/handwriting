/**
 * Numerical checks on the drawing pad's bitmap extraction.
 *
 * The interactive parts need a DOM, but the part that actually matters for the
 * font — turning stroke geometry into a tight, correctly-shaped glyph bitmap —
 * is pure, so it is checked here directly. A synthetic stroke path with known
 * bounds makes "are the page bounds tight" an exact question.
 */

import { rasterizeGlyph } from '../src/draw.js';

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass, detail });
  const mark = pass ? 'PASS' : 'FAIL';
  console.log(`  [${mark}] ${name}${detail ? ` — ${detail}` : ''}`);
}

/** A straight stroke of constant radius from (x0,y0) to (x1,y1). */
function lineStroke(x0, y0, x1, y1, r, samples = 40) {
  const points = [];
  for (let i = 0; i <= samples; i++) {
    const t = i / samples;
    points.push({ x: x0 + (x1 - x0) * t, y: y0 + (y1 - y0) * t, r });
  }
  return { points };
}

export function run() {
  console.log('\ndraw.js');

  const W = 300, H = 360;

  // -- 1. bitmap is exactly w*h and page bounds are tight -------------------
  {
    const r = 4;
    const x0 = 80, y0 = 100, x1 = 200, y1 = 260;
    const glyph = rasterizeGlyph([lineStroke(x0, y0, x1, y1, r)], { width: W, height: H, ch: 'x' });

    check('non-empty stroke produces a glyph', glyph != null);
    check('bitmap length equals w*h', glyph.bitmap.length === glyph.w * glyph.h,
      `${glyph.bitmap.length} vs ${glyph.w * glyph.h}`);
    check('carries the character through', glyph.ch === 'x', `ch=${glyph.ch}`);
    check('pad is 2', glyph.pad === 2, `pad=${glyph.pad}`);

    // The ink of a radius-r stroke reaches r beyond its centre line, so tight
    // bounds should sit within a pixel of (x0-r .. x1+r).
    const near = (a, b, tol) => Math.abs(a - b) <= tol;
    check('page.x0 hugs the ink', near(glyph.page.x0, x0 - r, 2), `x0=${glyph.page.x0}`);
    check('page.y0 hugs the ink', near(glyph.page.y0, y0 - r, 2), `y0=${glyph.page.y0}`);
    check('page.x1 hugs the ink', near(glyph.page.x1, x1 + r + 1, 2), `x1=${glyph.page.x1}`);
    check('page.y1 hugs the ink', near(glyph.page.y1, y1 + r + 1, 2), `y1=${glyph.page.y1}`);

    // The cropped bitmap is the ink box plus a 2px border on every side.
    const inkW = glyph.page.x1 - glyph.page.x0;
    const inkH = glyph.page.y1 - glyph.page.y0;
    check('w is ink width plus 2*pad', glyph.w === inkW + 4, `w=${glyph.w}, ink=${inkW}`);
    check('h is ink height plus 2*pad', glyph.h === inkH + 4, `h=${glyph.h}, ink=${inkH}`);

    // The pad border must be blank, and there must be ink inside it.
    let borderClean = true;
    for (let x = 0; x < glyph.w; x++) {
      if (glyph.bitmap[x] || glyph.bitmap[(glyph.h - 1) * glyph.w + x]) borderClean = false;
    }
    check('top and bottom pad rows are empty', borderClean);
    const inkCount = glyph.bitmap.reduce((n, v) => n + v, 0);
    check('bitmap actually contains ink', inkCount > 0, `${inkCount} px`);
  }

  // -- 2. an empty page yields null, not a zero-size bitmap -----------------
  {
    const glyph = rasterizeGlyph([], { width: W, height: H, ch: 'a' });
    check('no strokes returns null', glyph === null);
  }

  // -- 3. two separate strokes share one bounding box -----------------------
  {
    // A cross: the bounds must span both strokes, not just the last one.
    const a = lineStroke(60, 60, 240, 240, 3);
    const b = lineStroke(240, 60, 60, 240, 3);
    const glyph = rasterizeGlyph([a, b], { width: W, height: H, ch: 't' });
    check('cross spans both strokes horizontally', glyph.page.x0 <= 58 && glyph.page.x1 >= 242,
      `x0=${glyph.page.x0}, x1=${glyph.page.x1}`);
    check('cross spans both strokes vertically', glyph.page.y0 <= 58 && glyph.page.y1 >= 242,
      `y0=${glyph.page.y0}, y1=${glyph.page.y1}`);
    check('cross bitmap length still w*h', glyph.bitmap.length === glyph.w * glyph.h);
  }

  return results;
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}`) {
  run();
}
