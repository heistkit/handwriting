/**
 * Numerical checks on the vectoriser.
 *
 * These use analytically-defined shapes so that "how far is the fitted outline
 * from the truth" is an exact question rather than an eyeball judgement. A ring
 * checks winding and hole handling; a square checks that corners survive; a
 * diagonal checks that the pixel staircase is actually removed rather than
 * faithfully reproduced.
 */

import { vectorize, traceContours, signedArea, detectCorners } from '../src/trace.js';

// ---------------------------------------------------------------------------
// Rasterisers
// ---------------------------------------------------------------------------

function raster(w, h, inside) {
  const bin = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      // Sample at pixel centre.
      if (inside(x + 0.5, y + 0.5)) bin[y * w + x] = 1;
    }
  }
  return bin;
}

const ring = (cx, cy, R, r) => (x, y) => {
  const d = Math.hypot(x - cx, y - cy);
  return d <= R && d >= r;
};

const disc = (cx, cy, R) => (x, y) => Math.hypot(x - cx, y - cy) <= R;

const rect = (x0, y0, x1, y1) => (x, y) => x >= x0 && x <= x1 && y >= y0 && y <= y1;

const diagonal = (thickness) => (x, y) => Math.abs(y - x) <= thickness / 2;

// ---------------------------------------------------------------------------
// Sampling fitted curves
// ---------------------------------------------------------------------------

function bezierAt(b, t) {
  const mt = 1 - t;
  const a = mt * mt * mt, c1 = 3 * mt * mt * t, c2 = 3 * mt * t * t, d = t * t * t;
  return {
    x: a * b[0].x + c1 * b[1].x + c2 * b[2].x + d * b[3].x,
    y: a * b[0].y + c1 * b[1].y + c2 * b[2].y + d * b[3].y,
  };
}

function samplePoints(contours, per = 24) {
  const pts = [];
  for (const c of contours) {
    for (const bez of c.curves) {
      for (let i = 0; i < per; i++) pts.push(bezierAt(bez, i / per));
    }
  }
  return pts;
}

function errorStats(points, distanceToTruth) {
  let max = 0, sum = 0;
  for (const p of points) {
    const d = Math.abs(distanceToTruth(p.x, p.y));
    if (d > max) max = d;
    sum += d;
  }
  return { max, mean: sum / (points.length || 1), n: points.length };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass, detail });
  const mark = pass ? 'PASS' : 'FAIL';
  console.log(`  [${mark}] ${name}${detail ? ` — ${detail}` : ''}`);
}

export function run() {
  console.log('\ntrace.js');

  // -- 1. Ring: two contours, opposite winding, low radial error ------------
  {
    const W = 200, H = 200, R = 80, r = 42;
    const bin = raster(W, H, ring(100, 100, R, r));
    const { contours } = vectorize(bin, W, H);

    check('ring produces exactly 2 contours', contours.length === 2, `got ${contours.length}`);

    const outers = contours.filter((c) => c.outer).length;
    check('ring has 1 outer and 1 hole', outers === 1, `${outers} outer of ${contours.length}`);

    // The traced boundary sits on the pixel edge, roughly half a pixel outside
    // the analytic radius, so we compare against the nearer of the two radii.
    const dist = (x, y) => {
      const d = Math.hypot(x - 100, y - 100);
      return Math.min(Math.abs(d - R), Math.abs(d - r));
    };
    const stats = errorStats(samplePoints(contours), dist);
    check(
      'ring outline within 1.5 px of true radius',
      stats.max < 1.5,
      `max ${stats.max.toFixed(2)} px, mean ${stats.mean.toFixed(3)} px`
    );

    const curveCount = contours.reduce((n, c) => n + c.curves.length, 0);
    check('ring uses a sane number of curves', curveCount <= 24, `${curveCount} curves`);
  }

  // -- 2. Disc: staircase must be gone --------------------------------------
  {
    const W = 160, H = 160, R = 65;
    const bin = raster(W, H, disc(80, 80, R));
    const { contours } = vectorize(bin, W, H);
    const dist = (x, y) => Math.hypot(x - 80, y - 80) - R;
    const stats = errorStats(samplePoints(contours), dist);
    check('disc is a single contour', contours.length === 1, `got ${contours.length}`);
    check(
      'disc outline within 1.2 px',
      stats.max < 1.2,
      `max ${stats.max.toFixed(2)} px, mean ${stats.mean.toFixed(3)} px`
    );
  }

  // -- 3. Square: corners must survive smoothing ----------------------------
  {
    const W = 160, H = 160;
    const bin = raster(W, H, rect(30, 30, 129, 129));
    const raw = traceContours(bin, W, H);
    const corners = detectCorners(raw[0]);
    check('square finds 4 corners', corners.size === 4, `found ${corners.size}`);

    const { contours } = vectorize(bin, W, H);
    // Every true corner should appear as an on-curve point of some segment.
    const onCurve = [];
    for (const c of contours) for (const b of c.curves) onCurve.push(b[0], b[3]);
    const truth = [[30, 30], [130, 30], [130, 130], [30, 130]];
    const nearest = truth.map(([tx, ty]) =>
      Math.min(...onCurve.map((p) => Math.hypot(p.x - tx, p.y - ty)))
    );
    const worst = Math.max(...nearest);
    check(
      'square corners preserved within 1.5 px',
      worst < 1.5,
      `worst corner off by ${worst.toFixed(2)} px`
    );
  }

  // -- 4. Diagonal bar: the staircase test ----------------------------------
  {
    const W = 180, H = 180, T = 22;
    const bin = raster(W, H, diagonal(T));
    const { contours } = vectorize(bin, W, H);
    // Perpendicular distance from the bar's centre line y=x is |y-x|/√2, so the
    // two long edges sit at (T/2)/√2. End caps are excluded because the
    // analytic form does not describe them.
    const dist = (x, y) => {
      if (x < 25 || x > 155) return 0;
      return Math.abs(Math.abs(y - x) - T / 2) / Math.SQRT2;
    };
    const stats = errorStats(samplePoints(contours), dist);
    check(
      'diagonal edges are straight, not staircased',
      stats.max < 2.0,
      `max ${stats.max.toFixed(2)} px, mean ${stats.mean.toFixed(3)} px`
    );

    const curveCount = contours.reduce((n, c) => n + c.curves.length, 0);
    check(
      'diagonal does not explode into many curves',
      curveCount <= 16,
      `${curveCount} curves`
    );
  }

  // -- 5. Winding convention -------------------------------------------------
  {
    const bin = raster(60, 60, disc(30, 30, 20));
    const raw = traceContours(bin, 60, 60);
    check(
      'outer contour is clockwise in screen space',
      signedArea(raw[0]) > 0,
      `signed area ${signedArea(raw[0]).toFixed(1)}`
    );
  }

  return results;
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}`) {
  run();
}
