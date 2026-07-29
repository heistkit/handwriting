/**
 * trace.js — bitmap ink to smooth cubic outlines.
 *
 * This is the step that decides whether the finished font looks like
 * handwriting or like a bad fax, so it is worth explaining the shape of it.
 *
 * A naive tracer walks the pixel boundary and emits that polygon directly. The
 * result is a staircase: every diagonal stroke becomes a flight of one-pixel
 * steps, and because the steps are *real* geometry, no amount of rendering
 * smoothness hides them. Simply blurring the polygon fixes the staircase but
 * destroys genuine corners — the point of a 'k', the junction of a 't'.
 *
 * So the order here is deliberate:
 *
 *   1. walk the crack boundary            exact, lossless, staircased
 *   2. find corners on the raw walk       before any smoothing can hide them
 *   3. smooth everything except corners   staircase goes, corners stay
 *   4. fit cubic Béziers to each run      Schneider's algorithm
 *
 * Finding corners first and pinning them is the whole trick. Steps 3–4 are then
 * free to be as aggressive as they like, because the features that must survive
 * have already been marked untouchable.
 *
 * Note what is deliberately *absent*: there is no Douglas–Peucker pass before
 * the curve fit. Simplifying first is the obvious move and it is wrong, because
 * Schneider's error metric only samples the input vertices it was given. Hand a
 * long straight edge to RDP and it returns just the two endpoints; the fitter
 * then reports a tiny error — it genuinely does pass through both — while the
 * curve bulges 20 px away in between, since nothing remains there to measure
 * against. The fitter performs its own adaptive subdivision and needs dense
 * input to judge it. `simplify` is still exported, but the pipeline feeds the
 * fitter every point.
 *
 * Output is cubic Béziers because opentype.js writes CFF outlines, which are
 * natively cubic. Nothing is ever converted to quadratics, so nothing is lost.
 */

// ---------------------------------------------------------------------------
// 1. Crack following
// ---------------------------------------------------------------------------

// Facing (dx,dy) in screen coordinates (y grows downward):
//   left turn  → ( dy, -dx)     facing south (0,1) → east  (1,0)
//   right turn → (-dy,  dx)     facing south (0,1) → west (-1,0)
const TURNS = [
  (d) => [d[1], -d[0]], // left
  (d) => [d[0], d[1]],  // straight
  (d) => [-d[1], d[0]], // right
  (d) => [-d[0], -d[1]], // back
];

/**
 * Extract closed boundary loops that run along pixel edges rather than through
 * pixel centres.
 *
 * Each ink cell contributes an edge wherever its neighbour is paper, oriented so
 * that ink is consistently on the right of the direction of travel. Outer
 * contours therefore come out clockwise in screen coordinates and holes come out
 * counter-clockwise, which is exactly the winding a non-zero fill rule needs —
 * the counters of 'o', 'e' and 'a' become holes for free, with no containment
 * test anywhere.
 *
 * At a lattice point where two ink cells meet only diagonally, four edges meet.
 * We always take the leftmost available turn, which keeps diagonally-touching
 * ink as one contour and matches the 8-connectivity used when the components
 * were labelled.
 */
export function traceContours(bin, w, h) {
  /** @type {Map<number, Array<{to:number, dir:number[]}>>} */
  const outgoing = new Map();
  const key = (x, y) => y * (w + 1) + x;

  const addEdge = (x0, y0, x1, y1) => {
    const k = key(x0, y0);
    const list = outgoing.get(k);
    const edge = { to: key(x1, y1), dir: [x1 - x0, y1 - y0], x: x1, y: y1, used: false };
    if (list) list.push(edge);
    else outgoing.set(k, [edge]);
  };

  const ink = (x, y) => (x < 0 || y < 0 || x >= w || y >= h ? 0 : bin[y * w + x]);

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!bin[y * w + x]) continue;
      if (!ink(x, y - 1)) addEdge(x, y, x + 1, y);         // top    → east
      if (!ink(x + 1, y)) addEdge(x + 1, y, x + 1, y + 1); // right  → south
      if (!ink(x, y + 1)) addEdge(x + 1, y + 1, x, y + 1); // bottom → west
      if (!ink(x - 1, y)) addEdge(x, y + 1, x, y);         // left   → north
    }
  }

  const contours = [];
  for (const [startKey, edges] of outgoing) {
    for (const first of edges) {
      if (first.used) continue;

      const points = [];
      let edge = first;
      let atKey = startKey;
      let guard = 0;
      const limit = w * h * 4 + 16;

      while (edge && !edge.used && guard++ < limit) {
        edge.used = true;
        points.push({ x: edge.x, y: edge.y });
        atKey = edge.to;

        const candidates = outgoing.get(atKey);
        if (!candidates) break;

        // Prefer left, then straight, then right, then reverse.
        let next = null;
        for (const turn of TURNS) {
          const want = turn(edge.dir);
          next = candidates.find(
            (c) => !c.used && c.dir[0] === want[0] && c.dir[1] === want[1]
          );
          if (next) break;
        }
        if (!next) break;
        edge = next;
        if (edge === first) break;
      }

      if (points.length >= 4) contours.push(points);
    }
  }

  return contours;
}

/**
 * Read a coverage field at a crack-boundary coordinate.
 *
 * Two grids meet here and they are offset by half a pixel. Coverage is stored
 * per pixel, so cov[j * w + i] describes the square from (i, j) to (i+1, j+1)
 * and is best thought of as sitting at its centre, (i + 0.5, j + 0.5). The
 * contour walk works in crack coordinates, where a point is a pixel *corner*.
 * Subtracting the half pixel is what puts a corner into the coverage grid's
 * frame; without it every refinement below would be biased by half a pixel in
 * both axes, which is the whole quantity being recovered.
 *
 * Outside the buffer the answer is 0. Paper, not a clamp to the nearest edge —
 * clamping would extend the last row of ink outward forever and pull the
 * refinement of any glyph touching its own bounding box off the edge with it.
 */
function sampleCoverage(cov, w, h, x, y) {
  const u = x - 0.5;
  const v = y - 0.5;
  const i0 = Math.floor(u);
  const j0 = Math.floor(v);
  const fu = u - i0;
  const fv = v - j0;
  const at = (i, j) => (i < 0 || j < 0 || i >= w || j >= h ? 0 : cov[j * w + i]);
  return (
    (at(i0, j0) * (1 - fu) + at(i0 + 1, j0) * fu) * (1 - fv) +
    (at(i0, j0 + 1) * (1 - fu) + at(i0 + 1, j0 + 1) * fu) * fv
  );
}

/**
 * Move each boundary vertex onto the half-coverage crossing.
 *
 * The staircase this file spends most of its length undoing is, on the drawing
 * pad, partly self-inflicted. draw.js stamps strokes into a float coverage
 * buffer with a one-pixel linear ramp at the edge, precisely so that a threshold
 * at 0.5 lands between pixels rather than on a boundary. Then it thresholds, and
 * the walk above follows the cracks of the resulting binary mask — so the edge
 * is re-quantised to whole pixels and the sub-pixel information the ramp existed
 * to carry is gone before anything downstream can use it.
 *
 * This puts it back. Topology still comes from the binary walk, which is the
 * right division of labour: connectivity is a discrete question and answering it
 * from a threshold is exact, while position is a continuous one and answering it
 * from a threshold is a rounding. So the contour count, the winding and the hole
 * containment are all decided before this runs and are not touched by it.
 *
 * The search is along the local normal because that is the only direction in
 * which the edge is actually moving. Walking the gradient would be more general
 * and worse: on a stroke two pixels wide the gradients of the two edges overlap,
 * and a vertex would be pulled toward whichever one happened to be steeper.
 *
 * The nearest crossing wins, not the first. On a thin stroke the far edge is
 * often inside the search window too, and taking the first one found would
 * collapse the stroke onto one side of itself.
 *
 * @param {Array<{x: number, y: number}>} points  one closed loop, crack coords
 * @param {Float32Array|Array<number>} cov
 * @param {number} w  coverage width, same crop as the bitmap that was walked
 * @param {number} h
 * @param {object} [opts]
 * @returns {Array<{x: number, y: number}>} a new array, same length and order
 */
export function refineToCoverage(points, cov, w, h, opts = {}) {
  const {
    // A little over one pixel each way. The ramp is one pixel wide, so a
    // crossing further out than this is a different edge, not this one.
    search = 1.25,
    step = 0.125,
    level = 0.5,
    // Vertices to leave exactly where the walk put them — see below.
    corners = null,
  } = opts;

  const n = points.length;
  const out = new Array(n);

  for (let i = 0; i < n; i++) {
    const p = points[i];

    // Corners are not refined, and this is not a special case bolted on: a
    // bilinear interpolant cannot represent a corner at all. At the tip of a
    // right angle the four surrounding pixels are one ink and three paper, so
    // the interpolated coverage there is 0.25 — below the level — and the search
    // dutifully finds its crossing somewhere inside the corner and rounds it
    // off. Measured on a pixel-aligned square: corners displaced 0.29 px inward,
    // and the fitter, seeing a kink where it used to see a clean right angle,
    // went from four curves to sixteen.
    //
    // A corner's position needs no refining anyway. It is a lattice point where
    // two axis-aligned boundary runs meet, which the binary walk locates exactly;
    // there is no sub-pixel information there to recover. detectCorners has
    // already run on the raw walk, so this costs a set lookup.
    if (corners && corners.has(i)) { out[i] = { x: p.x, y: p.y }; continue; }

    // Two neighbours out, not one. A crack boundary is made of unit steps, so an
    // edge at a shallow angle is long axis-aligned runs broken by single-pixel
    // jogs, and at a jog the immediate neighbours straddle it and give a
    // 45-degree normal on an edge that is not at 45 degrees. Two averages the
    // jog into the run: 0.056 px against 0.050 px on a square rotated 20
    // degrees. Beyond two it stops moving at all.
    const reach = Math.max(1, Math.min(2, Math.floor((n - 1) / 2)));
    const a = points[(i - reach + n * reach) % n];
    const b = points[(i + reach) % n];

    let tx = b.x - a.x;
    let ty = b.y - a.y;
    const len = Math.hypot(tx, ty);
    if (!len) { out[i] = { x: p.x, y: p.y }; continue; }
    tx /= len;
    ty /= len;

    // The walk keeps ink on the right of the direction of travel, so paper is
    // on the left, and (ty, -tx) is a left turn in screen coordinates. Getting
    // this backwards would not fail loudly — it would find the same crossing
    // from the other side and shift every point by the ramp width, eroding or
    // dilating the whole glyph by about a pixel.
    const nx = ty;
    const ny = -tx;

    let bestS = null;
    let prevS = -search;
    let prev = sampleCoverage(cov, w, h, p.x + nx * prevS, p.y + ny * prevS);

    for (let s = -search + step; s <= search + 1e-9; s += step) {
      const c = sampleCoverage(cov, w, h, p.x + nx * s, p.y + ny * s);
      // Falling through the level: inside behind us, paper ahead.
      if (prev >= level && c < level) {
        const span = prev - c;
        const hit = span > 1e-9 ? prevS + ((prev - level) / span) * step : prevS;
        if (bestS === null || Math.abs(hit) < Math.abs(bestS)) bestS = hit;
      }
      prevS = s;
      prev = c;
    }

    // No crossing in range means this vertex is not on a ramp the coverage
    // agrees about — a single-pixel speck, or a spot where two strokes cross and
    // the field is saturated on both sides. Leaving it where the walk put it is
    // the conservative answer and matches the no-coverage path exactly.
    out[i] = bestS === null
      ? { x: p.x, y: p.y }
      : { x: p.x + nx * bestS, y: p.y + ny * bestS };
  }

  return out;
}

/** Signed area; positive means clockwise in screen coordinates (y down). */
export function signedArea(points) {
  let a = 0;
  for (let i = 0, n = points.length; i < n; i++) {
    const p = points[i];
    const q = points[(i + 1) % n];
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}

// ---------------------------------------------------------------------------
// 2. Corner detection
// ---------------------------------------------------------------------------

/**
 * Mark vertices that must stay sharp, using the k-cosine measure: compare the
 * chord arriving from k points back with the chord leaving k points ahead, and
 * call it a corner when they disagree by more than `angleDeg`.
 *
 * Looking k points away rather than at immediate neighbours is what makes this
 * survive the staircase. Every single step of a diagonal run is a 90° turn at
 * one-pixel scale; only at a wider baseline does a real corner distinguish
 * itself from quantisation noise.
 *
 * Candidates are then non-max suppressed, because a true corner produces a
 * cluster of high responses and we want one pinned vertex, not six.
 */
export function detectCorners(points, { angleDeg = 40, k = null } = {}) {
  const n = points.length;
  if (n < 8) return new Set();

  // Window scales with the size of the shape: a 40 px comma and a 400 px 'W'
  // need different baselines to separate signal from staircase.
  const bbox = boundsOf(points);
  const diag = Math.hypot(bbox.x1 - bbox.x0, bbox.y1 - bbox.y0);
  const win = k ?? Math.max(3, Math.min(28, Math.round(diag * 0.05)));

  const threshold = Math.cos((angleDeg * Math.PI) / 180);
  const response = new Float64Array(n);

  for (let i = 0; i < n; i++) {
    const a = points[(i - win + n * 2) % n];
    const b = points[i];
    const c = points[(i + win) % n];
    const v1x = b.x - a.x, v1y = b.y - a.y;
    const v2x = c.x - b.x, v2y = c.y - b.y;
    const l1 = Math.hypot(v1x, v1y), l2 = Math.hypot(v2x, v2y);
    if (l1 < 1e-6 || l2 < 1e-6) continue;
    const cos = (v1x * v2x + v1y * v2y) / (l1 * l2);
    // 1 = straight ahead, -1 = doubled back. Lower cosine = sharper corner.
    response[i] = cos < threshold ? 1 - cos : 0;
  }

  const corners = new Set();
  const suppress = Math.max(2, Math.round(win * 0.8));
  for (let i = 0; i < n; i++) {
    if (response[i] <= 0) continue;
    let best = true;
    for (let d = -suppress; d <= suppress; d++) {
      if (d === 0) continue;
      const j = (i + d + n * 2) % n;
      if (response[j] > response[i]) { best = false; break; }
    }
    if (best) corners.add(i);
  }
  return corners;
}

function boundsOf(points) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of points) {
    if (p.x < x0) x0 = p.x;
    if (p.y < y0) y0 = p.y;
    if (p.x > x1) x1 = p.x;
    if (p.y > y1) y1 = p.y;
  }
  return { x0, y0, x1, y1 };
}

// ---------------------------------------------------------------------------
// 3. Smoothing
// ---------------------------------------------------------------------------

/**
 * Gaussian smoothing along the contour that stops at pinned corners.
 *
 * The window never reaches across a corner, so a sharp vertex keeps its two
 * straight approaches instead of being rounded off from both sides. Corners
 * themselves are copied through untouched.
 */
export function smoothContour(points, corners, { sigma = 1.4 } = {}) {
  const n = points.length;
  const radius = Math.max(1, Math.ceil(sigma * 2.5));
  const weights = [];
  for (let d = -radius; d <= radius; d++) {
    weights.push(Math.exp((-d * d) / (2 * sigma * sigma)));
  }

  const isCorner = (i) => corners.has(((i % n) + n) % n);
  const out = new Array(n);

  for (let i = 0; i < n; i++) {
    if (isCorner(i)) { out[i] = { ...points[i] }; continue; }

    let sx = 0, sy = 0, sw = 0;
    for (let d = -radius; d <= radius; d++) {
      // Walk outward from i and stop the moment a corner is crossed.
      let blocked = false;
      const step = d === 0 ? 0 : d > 0 ? 1 : -1;
      for (let t = step; t !== d + step && step !== 0; t += step) {
        if (isCorner(i + t)) { blocked = true; break; }
      }
      if (blocked) continue;

      const p = points[((i + d) % n + n) % n];
      const wgt = weights[d + radius];
      sx += p.x * wgt;
      sy += p.y * wgt;
      sw += wgt;
    }
    out[i] = sw > 0 ? { x: sx / sw, y: sy / sw } : { ...points[i] };
  }
  return out;
}

// ---------------------------------------------------------------------------
// 4. Simplification
// ---------------------------------------------------------------------------

/** Ramer–Douglas–Peucker on an open polyline, iterative to avoid deep stacks. */
export function simplify(points, epsilon) {
  const n = points.length;
  if (n < 3) return points.slice();

  const keep = new Uint8Array(n);
  keep[0] = keep[n - 1] = 1;
  const stack = [[0, n - 1]];

  while (stack.length) {
    const [lo, hi] = stack.pop();
    if (hi <= lo + 1) continue;

    const a = points[lo], b = points[hi];
    const dx = b.x - a.x, dy = b.y - a.y;
    const len = Math.hypot(dx, dy);

    let far = -1, best = epsilon;
    for (let i = lo + 1; i < hi; i++) {
      const p = points[i];
      const dist = len < 1e-9
        ? Math.hypot(p.x - a.x, p.y - a.y)
        : Math.abs(dy * p.x - dx * p.y + b.x * a.y - b.y * a.x) / len;
      if (dist > best) { best = dist; far = i; }
    }
    if (far > 0) {
      keep[far] = 1;
      stack.push([lo, far], [far, hi]);
    }
  }

  const out = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(points[i]);
  return out;
}

// ---------------------------------------------------------------------------
// 5. Cubic Bézier fitting (Schneider)
// ---------------------------------------------------------------------------

const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y });
const add = (a, b) => ({ x: a.x + b.x, y: a.y + b.y });
const mul = (a, s) => ({ x: a.x * s, y: a.y * s });
const dot = (a, b) => a.x * b.x + a.y * b.y;

function normalize(v) {
  const l = Math.hypot(v.x, v.y);
  return l < 1e-12 ? { x: 0, y: 0 } : { x: v.x / l, y: v.y / l };
}

function bezierAt(bez, t) {
  const mt = 1 - t;
  const a = mt * mt * mt, b = 3 * mt * mt * t, c = 3 * mt * t * t, d = t * t * t;
  return {
    x: a * bez[0].x + b * bez[1].x + c * bez[2].x + d * bez[3].x,
    y: a * bez[0].y + b * bez[1].y + c * bez[2].y + d * bez[3].y,
  };
}

/** Chord-length parameterisation — a good enough first guess for Newton. */
function chordLengths(points) {
  const u = [0];
  for (let i = 1; i < points.length; i++) {
    u.push(u[i - 1] + Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y));
  }
  const total = u[u.length - 1] || 1;
  return u.map((v) => v / total);
}

/**
 * Least-squares fit of a single cubic with fixed endpoints and fixed tangent
 * directions, solving only for the two control-point distances along those
 * tangents. Constraining direction rather than position is what guarantees the
 * curve leaves each endpoint smoothly into its neighbour.
 */
function generateBezier(points, u, tan1, tan2) {
  const first = points[0];
  const last = points[points.length - 1];
  const n = points.length;

  let c00 = 0, c01 = 0, c11 = 0, x0 = 0, x1 = 0;

  for (let i = 0; i < n; i++) {
    const t = u[i], mt = 1 - t;
    const b0 = mt * mt * mt;
    const b1 = 3 * mt * mt * t;
    const b2 = 3 * mt * t * t;
    const b3 = t * t * t;

    const a1 = mul(tan1, b1);
    const a2 = mul(tan2, b2);

    c00 += dot(a1, a1);
    c01 += dot(a1, a2);
    c11 += dot(a2, a2);

    const tmp = sub(points[i], add(mul(first, b0 + b1), mul(last, b2 + b3)));
    x0 += dot(a1, tmp);
    x1 += dot(a2, tmp);
  }

  const det = c00 * c11 - c01 * c01;
  let alpha1, alpha2;
  if (Math.abs(det) < 1e-12) {
    // Degenerate system: fall back to the classic one-third heuristic.
    const d = Math.hypot(last.x - first.x, last.y - first.y) / 3;
    alpha1 = alpha2 = d;
  } else {
    alpha1 = (x0 * c11 - x1 * c01) / det;
    alpha2 = (c00 * x1 - c01 * x0) / det;
  }

  const segLen = Math.hypot(last.x - first.x, last.y - first.y);
  const epsilon = 1e-6 * segLen;
  if (alpha1 < epsilon || alpha2 < epsilon) {
    const d = segLen / 3;
    alpha1 = alpha2 = d;
  }

  return [first, add(first, mul(tan1, alpha1)), add(last, mul(tan2, alpha2)), last];
}

function maxError(points, bez, u) {
  let max = 0, index = Math.floor(points.length / 2);
  for (let i = 1; i < points.length - 1; i++) {
    const p = bezierAt(bez, u[i]);
    const d = (p.x - points[i].x) ** 2 + (p.y - points[i].y) ** 2;
    if (d > max) { max = d; index = i; }
  }
  return { error: Math.sqrt(max), index };
}

/** One Newton–Raphson step per point, pulling parameters onto the curve. */
function reparameterize(points, bez, u) {
  return u.map((t, i) => {
    const p = points[i];
    const d = bezierAt(bez, t);
    const mt = 1 - t;

    const d1 = {
      x: 3 * mt * mt * (bez[1].x - bez[0].x) + 6 * mt * t * (bez[2].x - bez[1].x) + 3 * t * t * (bez[3].x - bez[2].x),
      y: 3 * mt * mt * (bez[1].y - bez[0].y) + 6 * mt * t * (bez[2].y - bez[1].y) + 3 * t * t * (bez[3].y - bez[2].y),
    };
    const d2 = {
      x: 6 * mt * (bez[2].x - 2 * bez[1].x + bez[0].x) + 6 * t * (bez[3].x - 2 * bez[2].x + bez[1].x),
      y: 6 * mt * (bez[2].y - 2 * bez[1].y + bez[0].y) + 6 * t * (bez[3].y - 2 * bez[2].y + bez[1].y),
    };

    const diff = sub(d, p);
    const denom = dot(d1, d1) + dot(diff, d2);
    if (Math.abs(denom) < 1e-12) return t;
    const next = t - dot(diff, d1) / denom;
    return Math.min(1, Math.max(0, next));
  });
}

/**
 * Recursively fit cubics to a polyline, splitting where the error is worst.
 *
 * Splitting at the point of maximum error rather than at the midpoint is what
 * keeps the curve count low: one extra segment placed exactly where the shape
 * actually changes beats several placed arbitrarily.
 */
export function fitCubic(points, tan1, tan2, tolerance, depth = 0) {
  if (points.length === 2) {
    const d = Math.hypot(points[1].x - points[0].x, points[1].y - points[0].y) / 3;
    return [[points[0], add(points[0], mul(tan1, d)), add(points[1], mul(tan2, d)), points[1]]];
  }

  let u = chordLengths(points);
  let bez = generateBezier(points, u, tan1, tan2);
  let { error, index } = maxError(points, bez, u);

  if (error < tolerance) return [bez];

  // Close enough to be worth refining rather than splitting.
  if (error < tolerance * tolerance && depth < 24) {
    for (let i = 0; i < 12; i++) {
      u = reparameterize(points, bez, u);
      bez = generateBezier(points, u, tan1, tan2);
      const next = maxError(points, bez, u);
      if (next.error < tolerance) return [bez];
      if (next.error >= error) break;
      error = next.error;
      index = next.index;
    }
  }

  if (depth > 28 || index <= 0 || index >= points.length - 1) return [bez];

  // Centre tangent from the neighbours of the split point, so the two halves
  // meet smoothly rather than kinking.
  const centre = normalize(sub(points[index - 1], points[index + 1]));
  const left = fitCubic(points.slice(0, index + 1), tan1, centre, tolerance, depth + 1);
  const right = fitCubic(
    points.slice(index),
    { x: -centre.x, y: -centre.y },
    tan2,
    tolerance,
    depth + 1
  );
  return [...left, ...right];
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

/**
 * Full pipeline for a single binary bitmap.
 *
 * @param {Uint8Array} bin
 * @param {number} w
 * @param {number} h
 * @param {object} opts
 * @returns {{contours: Array<{closed: true, curves: Array}>, bounds: object}}
 */
export function vectorize(bin, w, h, opts = {}) {
  const {
    // All tolerances are in source pixels and scale with glyph size below.
    smoothing = 1.35,
    cornerAngle = 40,
    minAreaFraction = 0.004,
    // Cap on points fed to the fitter per run. Uniform decimation, never RDP —
    // see the note at the top of this file. Set generously: outline fidelity is
    // worth far more than a second of processing or a few KB of font file.
    maxRunPoints = 2400,
    // Optional per-pixel ink coverage, same crop and dimensions as `bin`. When
    // present the boundary is refined onto the half-coverage crossing; when
    // absent nothing below behaves differently from before it existed.
    coverage = null,
    // Maximum outline deviation, as a fraction of the glyph's bounding diagonal.
    // At 0.0035 a 200 px glyph is fitted to within 1 px, which lands around
    // 3 units on a 1000-unit em — below the threshold of visibility at any
    // realistic text size.
    //
    // Halved when coverage is available, and the two changes are one change.
    // This tolerance is loose on purpose: on a quantised boundary the fitter has
    // a staircase in front of it, and a tighter bound makes it track the steps
    // rather than the edge they approximate — trading a smooth outline that is
    // slightly wrong for a wobbly one that is slightly right. Refinement removes
    // the staircase, and only then does asking for more precision get any.
    //
    // Measured on the analytic figures, mean deviation against the true shape,
    // refining alone versus refining and tightening together:
    //
    //   diagonal      0.115 → 0.018 → 0.015
    //   ring          0.220 → 0.164 → 0.063
    //   disc          0.126 → 0.145 → 0.046     ← worse alone, 2.7x better together
    //   2.2 px bar    0.093 → 0.119 → 0.004     ← worse alone, 26x better together
    //
    // Two of the five got worse from refinement on its own. That is the whole
    // argument for coupling them: the boundary was more accurate in both cases
    // — 0.318 px to 0.050 px before smoothing — and the fitter was throwing the
    // gain away because it had been told not to look that closely.
    fitTolerance = coverage ? 0.0015 : 0.0035,
  } = opts;

  const raw = traceContours(bin, w, h);
  if (!raw.length) return { contours: [], bounds: null };

  // Largest contour sets the scale for noise rejection and fitting tolerance.
  const areas = raw.map((c) => Math.abs(signedArea(c)));
  const biggest = Math.max(...areas);
  const diag = Math.hypot(w, h);
  const tolerance = Math.max(0.2, diag * fitTolerance);

  const contours = [];

  raw.forEach((points, i) => {
    // Drop specks and pinholes: a hole smaller than this is a scanning artefact,
    // not a counter the writer intended.
    if (areas[i] < biggest * minAreaFraction) return;

    // Corners are read off the raw walk, before refinement moves anything. That
    // ordering is the one this file's header calls out: a corner is a turn of
    // more than `cornerAngle` between neighbouring boundary steps, and on the
    // raw walk those steps are axis-aligned unit moves, so the angle is exact.
    // Refinement shifts every vertex by up to a pixel along its own normal,
    // which is enough to soften a right angle below the threshold and lose it.
    const corners = detectCorners(points, { angleDeg: cornerAngle });

    const placed = coverage
      ? refineToCoverage(points, coverage, w, h, { corners })
      : points;

    // Smoothing is deliberately NOT reduced on the refined path, which was the
    // first thing tried and the wrong thing. The reasoning was that the Gaussian
    // exists to undo the staircase, so with no staircase it can only be doing
    // harm. Measurement disagreed: at sigma 0.45 the disc came out at 0.092
    // against 0.046 at the existing 1.35, and the ring at 0.098 against 0.063.
    // The coverage field carries its own noise — most of all where a stroke
    // crosses itself and the search below finds no crossing to move to — and the
    // Gaussian is still the thing that absorbs it.
    const smoothed = smoothContour(placed, corners, { sigma: smoothing });

    // Split the closed loop into corner-to-corner runs. With no corners at all
    // (an 'o', say) the whole loop is one run, closed back on itself.
    const cornerList = [...corners].sort((a, b) => a - b);
    const runs = [];
    if (cornerList.length === 0) {
      runs.push([...smoothed, smoothed[0]]);
    } else {
      for (let c = 0; c < cornerList.length; c++) {
        const from = cornerList[c];
        const to = cornerList[(c + 1) % cornerList.length];
        const run = [];
        let idx = from;
        const n = smoothed.length;
        let guard = 0;
        while (guard++ <= n) {
          run.push(smoothed[idx]);
          if (idx === to && run.length > 1) break;
          idx = (idx + 1) % n;
        }
        if (run.length >= 2) runs.push(run);
      }
    }

    const curves = [];
    for (const run of runs) {
      const dense = decimate(dedupe(run), maxRunPoints);
      if (dense.length < 2) continue;
      const tan1 = normalize(sub(dense[1], dense[0]));
      const tan2 = normalize(sub(dense[dense.length - 2], dense[dense.length - 1]));
      curves.push(...fitCubic(dense, tan1, tan2, tolerance));
    }

    if (curves.length) {
      contours.push({
        closed: true,
        curves,
        // Screen-space clockwise means an outer contour; see traceContours.
        outer: signedArea(points) > 0,
      });
    }
  });

  return { contours, bounds: contourBounds(contours) };
}

/**
 * Uniform subsampling to bound fitting cost on very large glyphs.
 *
 * Uniform rather than feature-based on purpose: it thins the samples evenly
 * along the run, so error remains measurable everywhere. A feature-based
 * reduction would strip the straight sections bare and blind the fitter exactly
 * where it needs to check itself.
 */
function decimate(points, max) {
  if (points.length <= max) return points;
  const step = points.length / max;
  const out = [];
  for (let i = 0; i < max; i++) out.push(points[Math.floor(i * step)]);
  const last = points[points.length - 1];
  if (out[out.length - 1] !== last) out.push(last);
  return out;
}

function dedupe(points) {
  const out = [points[0]];
  for (let i = 1; i < points.length; i++) {
    const p = points[i], q = out[out.length - 1];
    if (Math.abs(p.x - q.x) > 1e-9 || Math.abs(p.y - q.y) > 1e-9) out.push(p);
  }
  return out;
}

function contourBounds(contours) {
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
  return Number.isFinite(x0) ? { x0, y0, x1, y1 } : null;
}

/**
 * Convert traced contours into an SVG path string, applying an affine map.
 * Used for on-screen preview; the font compiler consumes `contours` directly.
 */
export function contoursToSVGPath(contours, transform = (p) => p) {
  const parts = [];
  for (const c of contours) {
    if (!c.curves.length) continue;
    const start = transform(c.curves[0][0]);
    parts.push(`M${fmt(start.x)} ${fmt(start.y)}`);
    for (const bez of c.curves) {
      const c1 = transform(bez[1]), c2 = transform(bez[2]), to = transform(bez[3]);
      parts.push(
        `C${fmt(c1.x)} ${fmt(c1.y)} ${fmt(c2.x)} ${fmt(c2.y)} ${fmt(to.x)} ${fmt(to.y)}`
      );
    }
    parts.push('Z');
  }
  return parts.join('');
}

const fmt = (n) => (Math.round(n * 100) / 100).toString();
