/**
 * Numerical checks on the vectoriser.
 *
 * These use analytically-defined shapes so that "how far is the fitted outline
 * from the truth" is an exact question rather than an eyeball judgement. A ring
 * checks winding and hole handling; a square checks that corners survive; a
 * diagonal checks that the pixel staircase is actually removed rather than
 * faithfully reproduced.
 */

import {
  vectorize, traceContours, signedArea, detectCorners, refineToCoverage,
} from '../src/trace.js';

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

/**
 * The same shape as both a coverage field and the binary mask taken from it.
 *
 * Coverage is true area coverage, by supersampling, which is what an ideal
 * rasteriser produces and what draw.js approximates with its one-pixel ramp.
 * The mask is thresholded from that field rather than sampled independently, so
 * the two describe the same edge — exactly as rasterizeGlyph produces them, and
 * so that any difference measured downstream is the refinement rather than two
 * rasterisers disagreeing.
 */
function fields(w, h, inside, sub = 8) {
  const cov = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let n = 0;
      for (let sy = 0; sy < sub; sy++) {
        for (let sx = 0; sx < sub; sx++) {
          if (inside(x + (sx + 0.5) / sub, y + (sy + 0.5) / sub)) n++;
        }
      }
      cov[y * w + x] = n / (sub * sub);
    }
  }
  const bin = new Uint8Array(w * h);
  for (let i = 0; i < cov.length; i++) bin[i] = cov[i] >= 0.5 ? 1 : 0;
  return { bin, cov };
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

  // -- 5. Sub-pixel refinement from a coverage field ------------------------
  //
  // The drawing pad already computes coverage — stampStroke lays a one-pixel
  // linear ramp at every stroke edge precisely so a 0.5 threshold lands between
  // pixels — and then throws it away by thresholding to a binary mask before
  // anything here sees it. Part of the staircase this file works to undo was
  // therefore self-inflicted. These check that putting it back is worth doing,
  // and the honest answer turned out to be "only together with a tighter fit".
  {
    const shapes = [
      {
        name: 'diagonal bar',
        W: 180, H: 180,
        inside: (x, y) => Math.abs(y - x) <= 11,
        dist: (x, y) => (x < 25 || x > 155 ? 0 : Math.abs(Math.abs(y - x) - 11) / Math.SQRT2),
        gain: 4,
      },
      {
        name: 'disc',
        W: 160, H: 160,
        inside: (x, y) => Math.hypot(x - 80, y - 80) <= 65,
        dist: (x, y) => Math.hypot(x - 80, y - 80) - 65,
        gain: 2,
      },
      {
        name: 'ring',
        W: 200, H: 200,
        inside: (x, y) => {
          const d = Math.hypot(x - 100, y - 100);
          return d <= 80 && d >= 42;
        },
        dist: (x, y) => {
          const d = Math.hypot(x - 100, y - 100);
          return Math.min(Math.abs(d - 80), Math.abs(d - 42));
        },
        gain: 2,
      },
      {
        // A fine-liner at a modest capture resolution. The case where the
        // staircase is the largest fraction of the stroke.
        name: 'hairline bar',
        W: 120, H: 120,
        inside: (x, y) => Math.abs(y - x) <= 1.1,
        dist: (x, y) => (x < 20 || x > 100 ? 0 : Math.abs(Math.abs(y - x) - 1.1) / Math.SQRT2),
        gain: 4,
      },
    ];

    for (const s of shapes) {
      const { bin, cov } = fields(s.W, s.H, s.inside);
      const before = errorStats(samplePoints(vectorize(bin, s.W, s.H).contours), s.dist);
      const after = errorStats(
        samplePoints(vectorize(bin, s.W, s.H, { coverage: cov }).contours), s.dist
      );
      check(
        `${s.name}: coverage improves the fitted outline at least ${s.gain}x`,
        after.mean * s.gain <= before.mean,
        `mean ${before.mean.toFixed(4)} → ${after.mean.toFixed(4)} px ` +
        `(${(before.mean / after.mean).toFixed(1)}x), max ${before.max.toFixed(3)} → ${after.max.toFixed(3)}`
      );
    }
  }

  // -- 6. Where the accuracy actually comes from -----------------------------
  //
  // Measured on the raw boundary, before smoothing and before fitting, because
  // that is the only place the refinement acts. The fitted-outline numbers above
  // are this gain minus whatever the later stages give back.
  {
    const W = 200, H = 200, A = (20 * Math.PI) / 180, S = 55;
    const uv = (x, y) => {
      const dx = x - 100, dy = y - 100;
      return [dx * Math.cos(A) + dy * Math.sin(A), -dx * Math.sin(A) + dy * Math.cos(A)];
    };
    // A square rotated off both axes, so its edges are neither the case where
    // the crack walk is exact nor the 45-degree case where every boundary step
    // is a jog and a naive normal happens to be right.
    const { bin, cov } = fields(W, H, (x, y) => {
      const [u, v] = uv(x, y);
      return Math.abs(u) <= S && Math.abs(v) <= S;
    });
    const sdf = (x, y) => {
      const [u, v] = uv(x, y);
      const qx = Math.abs(u) - S, qy = Math.abs(v) - S;
      return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0);
    };

    const raw = traceContours(bin, W, H)[0];
    const refined = refineToCoverage(raw, cov, W, H);
    const rawErr = errorStats(raw, sdf);
    const refErr = errorStats(refined, sdf);

    check(
      'the boundary itself lands four times closer to the true edge',
      refErr.mean * 4 <= rawErr.mean,
      `mean ${rawErr.mean.toFixed(4)} → ${refErr.mean.toFixed(4)} px ` +
      `(${(rawErr.mean / refErr.mean).toFixed(1)}x), max ${rawErr.max.toFixed(3)} → ${refErr.max.toFixed(3)}`
    );
    check(
      'and no vertex is thrown further than the ramp is wide',
      refined.every((p, i) => Math.hypot(p.x - raw[i].x, p.y - raw[i].y) <= 1.3),
      `worst move ${Math.max(...refined.map((p, i) =>
        Math.hypot(p.x - raw[i].x, p.y - raw[i].y))).toFixed(3)} px`
    );
    check('and the point count and order are untouched',
      refined.length === raw.length, `${raw.length} → ${refined.length}`);
  }

  // -- 7. Corners are not refined, and that is load-bearing ------------------
  //
  // A bilinear interpolant cannot represent a corner. At the tip of a right
  // angle three of the four surrounding pixels are paper, so the interpolated
  // coverage reads 0.25 — under the level — and an unguarded search finds its
  // crossing somewhere inside the corner. Before the guard this rounded every
  // corner of a pixel-aligned square inward by 0.29 px and took the fit from
  // four curves to sixteen.
  {
    const W = 160, H = 160;
    const { bin, cov } = fields(W, H, (x, y) => x >= 30 && x <= 130 && y >= 30 && y <= 130);
    const truth = [[30, 30], [130, 30], [130, 130], [30, 130]];

    const measure = (opts) => {
      const { contours } = vectorize(bin, W, H, opts);
      const onCurve = [];
      for (const c of contours) for (const b of c.curves) onCurve.push(b[0], b[3]);
      return {
        worst: Math.max(...truth.map(([tx, ty]) =>
          Math.min(...onCurve.map((p) => Math.hypot(p.x - tx, p.y - ty))))),
        curves: contours.reduce((n, c) => n + c.curves.length, 0),
      };
    };

    const plain = measure({});
    const refined = measure({ coverage: cov });
    check(
      'a square is fitted identically with coverage and without',
      refined.worst <= plain.worst + 1e-9 && refined.curves === plain.curves,
      `${plain.curves} curves / ${plain.worst.toFixed(3)} px → ` +
      `${refined.curves} curves / ${refined.worst.toFixed(3)} px`
    );
  }

  // -- 8. Winding convention -------------------------------------------------
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
