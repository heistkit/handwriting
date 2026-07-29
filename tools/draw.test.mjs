/**
 * Numerical checks on the drawing pad's bitmap extraction.
 *
 * The interactive parts need a DOM, but the part that actually matters for the
 * font — turning stroke geometry into a tight, correctly-shaped glyph bitmap —
 * is pure, so it is checked here directly. A synthetic stroke path with known
 * bounds makes "are the page bounds tight" an exact question.
 */

import { rasterizeGlyph } from '../src/draw.js';
import { vectorize } from '../src/trace.js';

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

  // -- 4. a fractional raster size must not lose the ink --------------------
  {
    // The pad sizes its canvas from mount.clientWidth, which is a fractional
    // CSS pixel far more often than not — 354.390625 is a real measurement off
    // the landing page. Multiplied by SCALE it reached rasterizeGlyph as a
    // fractional width, and every `cov[y * width + x]` became a fractional
    // typed-array index: writes silently discarded, reads silently undefined.
    // Only rows where y * the fraction landed on a whole number survived, so
    // the ink came back as a scatter of specks, or on a thin stroke as nothing
    // at all — which is how the landing demo's Trace it button came to be a
    // button that did nothing, with no error anywhere.
    const stroke = lineStroke(120, 120, 260, 300, 5);
    const whole = rasterizeGlyph([stroke], { width: 400, height: 460, ch: 'a' });
    const frac = rasterizeGlyph([stroke], { width: 400.390625, height: 460.7, ch: 'a' });

    check('a fractional raster still produces a glyph', frac != null);
    const inkWhole = whole.bitmap.reduce((n, v) => n + v, 0);
    const inkFrac = frac ? frac.bitmap.reduce((n, v) => n + v, 0) : 0;
    // Flooring the grid can only change which pixels exist at the far edge, and
    // this stroke is nowhere near it, so the two must agree exactly.
    check('and the same amount of ink as a whole one', inkFrac === inkWhole,
      `${inkFrac} vs ${inkWhole}`);
    check('and the same bounds', frac && whole.page.x0 === frac.page.x0 && whole.page.y1 === frac.page.y1,
      `${JSON.stringify(frac?.page)} vs ${JSON.stringify(whole.page)}`);
    check('and a bitmap whose length is still w*h',
      frac != null && frac.bitmap.length === frac.w * frac.h);
  }

  // -- The coverage field survives the crop, and is worth carrying ------------
  //
  // Everything above this point is about the mask. This is about the field the
  // mask was thresholded from: stampStroke builds a one-pixel linear ramp at
  // every edge so that a 0.5 threshold lands between pixels, and until now that
  // ramp was discarded one line later. These check it comes out of the crop
  // intact and that trace.js can actually do something with it.
  //
  // The measurement matters more than it looks, because every other test of the
  // refinement uses supersampled area coverage — a mathematically ideal field.
  // stampStroke's ramp is an approximation of one. This is the only check that
  // the approximation is good enough to be worth reading.
  {
    // A straight stroke at 22 degrees. Off-axis on purpose: an axis-aligned or
    // 45-degree stroke is the one case where the crack walk is already close to
    // exact, and would flatter the result.
    const W = 200, H = 120, R = 5.5;
    const angle = (22 * Math.PI) / 180;
    const points = [];
    for (let t = 0; t <= 150; t += 1.5) {
      points.push({ x: 25 + t * Math.cos(angle), y: 30 + t * Math.sin(angle), r: R });
    }
    const g = rasterizeGlyph([{ points }], { width: W, height: H, ch: '/' });

    check('the pad returns a coverage field beside the mask',
      g != null && g.coverage instanceof Float32Array && g.coverage.length === g.w * g.h,
      g ? `${g.coverage?.length} values for ${g.w}x${g.h}` : 'no glyph');

    // The ramp is the whole point. If the crop had been taken over the ink
    // bounding box instead of the padded window, every value outside the mask
    // would be a hard zero and there would be nothing to interpolate against.
    const partial = g ? [...g.coverage].filter((v) => v > 0.02 && v < 0.98).length : 0;
    check('and the field carries partial coverage, not just ones and zeroes',
      partial > g.w, `${partial} partial values across ${g.w}x${g.h}`);

    const outside = [];
    for (let y = 0; y < g.h; y++) {
      for (let x = 0; x < g.w; x++) {
        if (!g.bitmap[y * g.w + x] && g.coverage[y * g.w + x] > 0.02) outside.push(1);
      }
    }
    check('including outside the mask, which is where the outer half of the ramp lives',
      outside.length > 20, `${outside.length} lit pixels beyond the threshold`);

    // Distance from the stroke's centre line to its edge is exactly the brush
    // radius, so the true outline is known without needing the rasteriser to be.
    // End caps are excluded: they are discs, not described by this.
    const nx = -Math.sin(angle), ny = Math.cos(angle);
    const dist = (px, py) => {
      const X = px - g.pad + g.page.x0;
      const Y = py - g.pad + g.page.y0;
      const along = (X - 25) * Math.cos(angle) + (Y - 30) * Math.sin(angle);
      if (along < 20 || along > 130) return 0;
      return Math.abs(Math.abs((X - 25) * nx + (Y - 30) * ny) - R);
    };

    const plain = errorOf(vectorize(g.bitmap, g.w, g.h).contours, dist);
    const refined = errorOf(
      vectorize(g.bitmap, g.w, g.h, { coverage: g.coverage }).contours, dist
    );
    check(
      'and tracing with it puts the pad stroke closer to where it was drawn',
      refined.mean < plain.mean,
      `mean ${plain.mean.toFixed(4)} → ${refined.mean.toFixed(4)} px ` +
      `(${(plain.mean / refined.mean).toFixed(1)}x), max ${plain.max.toFixed(3)} → ${refined.max.toFixed(3)}`
    );
  }

  return results;
}

/** Mean and max distance from a fitted outline to a known truth. */
function errorOf(contours, dist) {
  let max = 0, sum = 0, n = 0;
  for (const c of contours) {
    for (const b of c.curves) {
      for (let i = 0; i < 24; i++) {
        const t = i / 24;
        const m = 1 - t;
        const x = m * m * m * b[0].x + 3 * m * m * t * b[1].x + 3 * m * t * t * b[2].x + t * t * t * b[3].x;
        const y = m * m * m * b[0].y + 3 * m * m * t * b[1].y + 3 * m * t * t * b[2].y + t * t * t * b[3].y;
        const d = Math.abs(dist(x, y));
        if (d > max) max = d;
        sum += d;
        n++;
      }
    }
  }
  return { max, mean: n ? sum / n : Infinity, n };
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}`) {
  run();
}
