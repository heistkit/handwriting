/**
 * imageproc.js — turning a photograph into clean binary ink.
 *
 * The hard case is not a flatbed scan; it is a phone photo taken at a desk,
 * where one corner of the page is in shadow and the other is blown out by a
 * lamp. A single global threshold destroys such an image: the bright half goes
 * all-white and the dark half goes all-black.
 *
 * So we threshold *locally* using Sauvola's method, which decides each pixel
 * against the mean and standard deviation of its own neighbourhood. Computed
 * naively that is O(w · h · window²) and hopeless in a browser; computed with
 * summed-area tables it is O(w · h) regardless of window size, which is what
 * makes it practical here.
 *
 * Everything in this module is plain typed-array maths. No OpenCV, no WASM,
 * nothing to download.
 */

/**
 * Longest edge we ever work at.
 *
 * Set high deliberately. Every pixel of source resolution is extra evidence
 * about where a stroke's edge really lies, and the tracer's sub-pixel accuracy
 * is bounded by it. A 12 MP phone photo takes a few seconds to run through the
 * whole pipeline at this size, which is a trade worth making exactly once, at
 * the moment the font is built.
 */
export const MAX_WORKING_DIM = 4200;

/**
 * The largest skew estimateSkew will report, in radians.
 *
 * Kept beside the cap above because the two interact: the page is straightened
 * after it is loaded, and a rotation grows the buffer. Change the `maxDeg`
 * default in estimateSkew and this has to move with it.
 */
const MAX_SKEW_RAD = (8 * Math.PI) / 180;

/** Downscaled edge used for the cheap analysis passes (skew estimation). */
const ANALYSIS_DIM = 1200;

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

/**
 * Decode a File/Blob/URL into an ImageData, downscaled so the longest edge is
 * at most `maxDim`. Uses createImageBitmap where available because it decodes
 * off the main thread.
 *
 * @returns {Promise<ImageData>}
 */
export async function loadImageData(source, maxDim = MAX_WORKING_DIM) {
  const bitmap = await decode(source);
  const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));

  const canvas = makeCanvas(w, h);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  // Browsers use a decent box filter for downscaling when smoothing is on and
  // quality is high; that matters because aliased downscaling adds fake edges
  // which the tracer would faithfully reproduce as bumps in the outline.
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, w, h);
  if (bitmap.close) bitmap.close();
  return ctx.getImageData(0, 0, w, h);
}

async function decode(source) {
  if (typeof source === 'string') {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.src = source;
    await img.decode();
    return img;
  }
  if (typeof createImageBitmap === 'function') return createImageBitmap(source);
  const url = URL.createObjectURL(source);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function makeCanvas(w, h) {
  if (typeof OffscreenCanvas === 'function') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

// ---------------------------------------------------------------------------
// Grayscale
// ---------------------------------------------------------------------------

/**
 * Luma conversion, with one deliberate deviation: pixels that are strongly
 * saturated *and* blue-ish are pushed toward white.
 *
 * Reason — the printable template sheet prints its guide boxes in light blue.
 * Treating blue as paper makes the guides vanish at this stage rather than
 * having to be subtracted later, which is exactly how physical "non-photo blue"
 * drafting pencils have always worked.
 */
export function toGrayscale(imageData, { dropBlue = false } = {}) {
  const { data, width: w, height: h } = imageData;
  const gray = new Uint8ClampedArray(w * h);
  for (let i = 0, p = 0; p < gray.length; i += 4, p++) {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    let v = (r * 77 + g * 150 + b * 29) >> 8; // 0.299 / 0.587 / 0.114 in fixed point
    if (dropBlue) {
      const maxc = Math.max(r, g, b);
      const minc = Math.min(r, g, b);
      const sat = maxc === 0 ? 0 : (maxc - minc) / maxc;
      // Blue dominant, reasonably saturated, and not dark: that is a guide line.
      if (b === maxc && sat > 0.22 && b > 90 && b - r > 25) v = 255;
    }
    gray[p] = v;
  }
  return { gray, w, h };
}

// ---------------------------------------------------------------------------
// Summed-area tables
// ---------------------------------------------------------------------------

/**
 * Build integral images of the values and their squares, so that the sum and
 * sum-of-squares over any axis-aligned rectangle is four array lookups.
 *
 * Both are Float64Array: at 3000×3000 the squared sum reaches ~5.8e11, far
 * past the 2^53 exact-integer limit for nothing, but well past Float32's
 * 24-bit mantissa, which would visibly quantise the variance term.
 */
export function integralImages(gray, w, h) {
  const sw = w + 1;
  const sum = new Float64Array(sw * (h + 1));
  const sumSq = new Float64Array(sw * (h + 1));
  for (let y = 0; y < h; y++) {
    let rowSum = 0;
    let rowSumSq = 0;
    const above = y * sw;
    const cur = (y + 1) * sw;
    for (let x = 0; x < w; x++) {
      const v = gray[y * w + x];
      rowSum += v;
      rowSumSq += v * v;
      sum[cur + x + 1] = sum[above + x + 1] + rowSum;
      sumSq[cur + x + 1] = sumSq[above + x + 1] + rowSumSq;
    }
  }
  return { sum, sumSq, sw };
}

/** Rectangle sum from a summed-area table; x0,y0 inclusive, x1,y1 exclusive. */
function rectSum(table, sw, x0, y0, x1, y1) {
  return (
    table[y1 * sw + x1] - table[y0 * sw + x1] - table[y1 * sw + x0] + table[y0 * sw + x0]
  );
}

// ---------------------------------------------------------------------------
// Thresholding
// ---------------------------------------------------------------------------

/**
 * Otsu's global threshold. We do not use it as the primary method, but it is a
 * good estimate of overall ink darkness and we feed it to Sauvola as a floor so
 * that genuinely blank regions cannot generate noise.
 */
export function otsuThreshold(gray) {
  const hist = new Float64Array(256);
  for (let i = 0; i < gray.length; i++) hist[gray[i]]++;
  const total = gray.length;

  let sumAll = 0;
  for (let t = 0; t < 256; t++) sumAll += t * hist[t];

  let sumB = 0, wB = 0, best = 0, bestVar = -1;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sumAll - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > bestVar) {
      bestVar = between;
      best = t;
    }
  }
  return best;
}

/**
 * Sauvola local thresholding.
 *
 *   T(x,y) = m(x,y) · [ 1 + k · ( s(x,y)/R − 1 ) ]
 *
 * where m and s are the local mean and standard deviation over a window, R is
 * the dynamic range of s (128 for 8-bit), and k controls how aggressively we
 * pull the threshold below the local mean.
 *
 * The behaviour that matters: in a flat region (blank paper) s → 0, so
 * T → m·(1−k), i.e. comfortably *below* the paper brightness, and no ink is
 * hallucinated. Near a stroke, s is large, T rises toward m, and the stroke is
 * captured. This is precisely the property a global threshold lacks.
 *
 * @returns {Uint8Array} 1 where there is ink, 0 where there is paper
 */
export function sauvolaBinarize(gray, w, h, opts = {}) {
  const {
    // ~1/16 of the short edge: comfortably larger than a stroke, smaller than
    // the illumination gradient we are trying to cancel.
    window = Math.max(15, Math.round(Math.min(w, h) / 16) | 1),
    k = 0.28,
    R = 128,
    // Guard against noise in near-uniform areas: require a minimum contrast
    // below the local mean before calling a pixel ink.
    minContrast = 8,
  } = opts;

  const { sum, sumSq, sw } = integralImages(gray, w, h);
  const bin = new Uint8Array(w * h);
  const r = window >> 1;
  const globalOtsu = otsuThreshold(gray);
  // Nothing brighter than this can be ink, whatever the local statistics say.
  const ceiling = Math.min(250, globalOtsu + 55);

  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - r);
    const y1 = Math.min(h, y + r + 1);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r);
      const x1 = Math.min(w, x + r + 1);
      const area = (x1 - x0) * (y1 - y0);

      const s1 = rectSum(sum, sw, x0, y0, x1, y1);
      const s2 = rectSum(sumSq, sw, x0, y0, x1, y1);
      const mean = s1 / area;
      const variance = Math.max(0, s2 / area - mean * mean);
      const std = Math.sqrt(variance);

      const t = mean * (1 + k * (std / R - 1));
      const v = gray[y * w + x];
      bin[y * w + x] = v < Math.min(t, mean - minContrast) && v < ceiling ? 1 : 0;
    }
  }
  return bin;
}

// ---------------------------------------------------------------------------
// Connected components
// ---------------------------------------------------------------------------

/**
 * Two-pass connected-component labelling with union-find, 8-connectivity.
 *
 * 8-connectivity rather than 4 is important for handwriting: a thin diagonal
 * stroke drawn quickly is often only corner-connected, and 4-connectivity would
 * shatter it into a staircase of separate fragments.
 *
 * @returns {{labels: Int32Array, boxes: Array, count: number}}
 *          boxes are {id, x0, y0, x1, y1, area, cx, cy} with x1/y1 exclusive
 */
export function labelComponents(bin, w, h) {
  const labels = new Int32Array(w * h);
  // Upper bound on provisional labels; handwriting never approaches this.
  const parent = new Int32Array(Math.ceil((w * h) / 2) + 2);
  let next = 1;

  const find = (a) => {
    let root = a;
    while (parent[root] !== root) root = parent[root];
    // Path compression, iterative to avoid deep recursion on big images.
    while (parent[a] !== root) {
      const up = parent[a];
      parent[a] = root;
      a = up;
    }
    return root;
  };
  const union = (a, b) => {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
  };

  // Pass 1 — provisional labels, recording equivalences.
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!bin[i]) continue;

      let best = 0;
      // Neighbours already visited in raster order: W, NW, N, NE.
      for (const [dx, dy] of [[-1, 0], [-1, -1], [0, -1], [1, -1]]) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const nl = labels[ny * w + nx];
        if (!nl) continue;
        if (!best) best = nl;
        else union(best, nl);
      }

      if (!best) {
        best = next++;
        parent[best] = best;
      }
      labels[i] = best;
    }
  }

  // Pass 2 — flatten to consecutive ids and accumulate bounding boxes.
  const remap = new Int32Array(next);
  const boxes = [];
  for (let i = 0; i < labels.length; i++) {
    const l = labels[i];
    if (!l) continue;
    const root = find(l);
    let id = remap[root];
    if (!id) {
      id = boxes.length + 1;
      remap[root] = id;
      boxes.push({
        id, x0: w, y0: h, x1: 0, y1: 0, area: 0, sx: 0, sy: 0, cx: 0, cy: 0,
      });
    }
    labels[i] = id;
    const b = boxes[id - 1];
    const x = i % w, y = (i / w) | 0;
    if (x < b.x0) b.x0 = x;
    if (y < b.y0) b.y0 = y;
    if (x + 1 > b.x1) b.x1 = x + 1;
    if (y + 1 > b.y1) b.y1 = y + 1;
    b.area++;
    b.sx += x;
    b.sy += y;
  }
  for (const b of boxes) {
    b.cx = b.sx / b.area;
    b.cy = b.sy / b.area;
    delete b.sx;
    delete b.sy;
  }
  return { labels, boxes, count: boxes.length };
}

/**
 * Remove specks. `minArea` is expressed relative to the median component area
 * rather than in absolute pixels, so the same call works for a 2 MP phone photo
 * and a 600 dpi scan without retuning.
 */
export function despeckle(bin, w, h, { relative = 0.02, absolute = 6 } = {}) {
  const { labels, boxes } = labelComponents(bin, w, h);
  if (!boxes.length) return bin;

  const areas = boxes.map((b) => b.area).sort((a, b) => a - b);
  const median = areas[areas.length >> 1];
  const threshold = Math.max(absolute, median * relative);

  const keep = new Uint8Array(boxes.length + 1);
  for (const b of boxes) if (b.area >= threshold) keep[b.id] = 1;

  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = keep[labels[i]] ? 1 : 0;
  return out;
}

// ---------------------------------------------------------------------------
// Deskew
// ---------------------------------------------------------------------------

/**
 * Estimate page rotation by maximising the sharpness of the horizontal
 * projection profile.
 *
 * When rows of writing are level, projecting ink onto the vertical axis gives
 * tall peaks (the rows) separated by deep troughs (the gaps). Tilt the page and
 * the rows smear into each other, flattening the profile. So we rotate over a
 * range of candidate angles and keep whichever maximises the sum of squared
 * differences between adjacent profile entries — a cheap, robust sharpness
 * measure that needs no Hough transform.
 *
 * @returns {number} radians to rotate the image by to level it
 */
export function estimateSkew(bin, w, h, { maxDeg = 8, coarse = 1, fine = 0.1 } = {}) {
  const score = (deg) => {
    const rad = (deg * Math.PI) / 180;
    const tan = Math.tan(rad);
    const profile = new Float64Array(h + Math.ceil(Math.abs(tan) * w) + 2);
    const offset = tan < 0 ? Math.ceil(Math.abs(tan) * w) : 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (!bin[y * w + x]) continue;
        // Shear rather than true rotation: for angles this small the difference
        // is below one pixel and shearing is far cheaper.
        const yy = y + offset - Math.round(tan * x);
        if (yy >= 0 && yy < profile.length) profile[yy]++;
      }
    }
    let s = 0;
    for (let i = 1; i < profile.length; i++) {
      const d = profile[i] - profile[i - 1];
      s += d * d;
    }
    return s;
  };

  let best = 0, bestScore = -Infinity;
  for (let deg = -maxDeg; deg <= maxDeg; deg += coarse) {
    const s = score(deg);
    if (s > bestScore) { bestScore = s; best = deg; }
  }
  for (let deg = best - coarse; deg <= best + coarse; deg += fine) {
    const s = score(deg);
    if (s > bestScore) { bestScore = s; best = deg; }
  }
  return (best * Math.PI) / 180;
}

/**
 * Estimate the writer's natural forward slant.
 *
 * The same sharpness argument as deskew, turned ninety degrees. Vertical
 * strokes — the stems of b, d, h, k, l and every capital — dominate handwriting,
 * and when they stand truly upright, projecting ink onto the *horizontal* axis
 * concentrates it into narrow spikes. Lean the page and each stem smears across
 * many columns, flattening the profile. The shear that maximises spikiness is
 * therefore the one that undoes the writer's slant.
 *
 * Knowing this is worth more than it first appears. It lets the Italic style be
 * built as a *further* lean rather than a fixed 11°, so someone whose hand
 * already slopes forward gets an italic that is genuinely more slanted instead
 * of one that looks identical to their regular.
 *
 * @returns {number} degrees; positive means the writing leans forward (to the right)
 */
export function estimateSlant(bin, w, h, { maxDeg = 32, coarse = 2, fine = 0.25 } = {}) {
  const score = (deg) => {
    const t = Math.tan((deg * Math.PI) / 180);
    const pad = Math.ceil(Math.abs(t) * h) + 2;
    const profile = new Float64Array(w + pad * 2);
    for (let y = 0; y < h; y++) {
      const shift = Math.round(t * y) + pad;
      const row = y * w;
      for (let x = 0; x < w; x++) {
        if (!bin[row + x]) continue;
        const xx = x + shift;
        if (xx >= 0 && xx < profile.length) profile[xx]++;
      }
    }
    let s = 0;
    for (let i = 1; i < profile.length; i++) {
      const d = profile[i] - profile[i - 1];
      s += d * d;
    }
    return s;
  };

  let best = 0, bestScore = -Infinity;
  for (let deg = -maxDeg; deg <= maxDeg; deg += coarse) {
    const s = score(deg);
    if (s > bestScore) { bestScore = s; best = deg; }
  }
  for (let deg = best - coarse; deg <= best + coarse; deg += fine) {
    const s = score(deg);
    if (s > bestScore) { bestScore = s; best = deg; }
  }
  // A positive shear straightens forward-leaning writing, so the writer's own
  // slant is the negation of the correction.
  return -best;
}

/**
 * Rotate a grayscale buffer with bilinear sampling.
 *
 * We deliberately deskew the *grayscale* image and binarize afterwards, never
 * the other way round: rotating a binary image can only resample with nearest
 * neighbour, which serrates every stroke edge, and the vectoriser would then
 * faithfully trace those serrations into the final outline.
 */
export function rotateGray(gray, w, h, angle, fill = 255) {
  if (Math.abs(angle) < 1e-4) return { gray, w, h };
  const cos = Math.cos(angle), sin = Math.sin(angle);
  const nw = Math.ceil(Math.abs(w * cos) + Math.abs(h * sin));
  const nh = Math.ceil(Math.abs(w * sin) + Math.abs(h * cos));
  const out = new Uint8ClampedArray(nw * nh).fill(fill);

  const cx = w / 2, cy = h / 2;
  const ncx = nw / 2, ncy = nh / 2;

  for (let y = 0; y < nh; y++) {
    for (let x = 0; x < nw; x++) {
      // Inverse map: where in the source does this destination pixel come from?
      const dx = x - ncx, dy = y - ncy;
      const sx = cos * dx + sin * dy + cx;
      const sy = -sin * dx + cos * dy + cy;
      if (sx < 0 || sy < 0 || sx >= w - 1 || sy >= h - 1) continue;

      const x0 = sx | 0, y0 = sy | 0;
      const fx = sx - x0, fy = sy - y0;
      const i = y0 * w + x0;
      const a = gray[i], b = gray[i + 1];
      const c = gray[i + w], d = gray[i + w + 1];
      out[y * nw + x] =
        a * (1 - fx) * (1 - fy) + b * fx * (1 - fy) + c * (1 - fx) * fy + d * fx * fy;
    }
  }
  return { gray: out, w: nw, h: nh };
}

/** Nearest-neighbour box downscale, used only for the cheap analysis passes. */
export function downscaleGray(gray, w, h, maxDim) {
  const scale = Math.min(1, maxDim / Math.max(w, h));
  if (scale >= 1) return { gray, w, h, scale: 1 };
  const nw = Math.max(1, Math.round(w * scale));
  const nh = Math.max(1, Math.round(h * scale));
  const out = new Uint8ClampedArray(nw * nh);
  const fx = w / nw, fy = h / nh;
  for (let y = 0; y < nh; y++) {
    const sy0 = (y * fy) | 0;
    const sy1 = Math.min(h, Math.max(sy0 + 1, ((y + 1) * fy) | 0));
    for (let x = 0; x < nw; x++) {
      const sx0 = (x * fx) | 0;
      const sx1 = Math.min(w, Math.max(sx0 + 1, ((x + 1) * fx) | 0));
      let acc = 0, n = 0;
      for (let yy = sy0; yy < sy1; yy++) {
        for (let xx = sx0; xx < sx1; xx++) { acc += gray[yy * w + xx]; n++; }
      }
      out[y * nw + x] = acc / n;
    }
  }
  return { gray: out, w: nw, h: nh, scale };
}

// ---------------------------------------------------------------------------
// Yielding
// ---------------------------------------------------------------------------

/**
 * Hand control back to the browser for long enough that it can paint.
 *
 * `await Promise.resolve()` cannot do this and never could: it queues a
 * *microtask*, and the entire microtask queue is drained before the event loop
 * reaches its rendering step, so the continuation runs with nothing painted in
 * between. A timer callback is a *task*, and the browser is free to render
 * between tasks. export.js already yields exactly this way between WOFF
 * conversions — "Yield so the fill actually paints between conversions" — so
 * this is the house idiom, kept in the module whose passes are the ones long
 * enough to need it.
 *
 * setTimeout rather than requestAnimationFrame, for two reasons that both bite
 * here: rAF does not exist in a Web Worker, which pipeline.js is written to be
 * movable into unchanged, and rAF does not fire at all in a background tab — a
 * capture started and then switched away from would stop dead rather than
 * finish.
 *
 * Cost: HTML clamps a 0 ms timer to 4 ms once the nesting level passes five,
 * and these are nested, so budget 4 ms per site. One capture reaches twelve
 * sites — seven in preprocess, one before segmentSheet, four in the trace loop
 * on the busiest sheet — so about 48 ms of added latency. That figure is
 * arithmetic off the spec clamp, not a measurement; nothing here has been timed
 * on a device.
 */
export const paintYield = () => new Promise((resolve) => setTimeout(resolve, 0));

// ---------------------------------------------------------------------------
// The whole pipeline
// ---------------------------------------------------------------------------

/**
 * Photograph → clean, level binary ink.
 *
 * Order is load → grayscale → cheap deskew estimate on a downscale → rotate the
 * full-resolution grayscale → Sauvola → despeckle. Estimating skew on a small
 * copy costs almost nothing and keeps the expensive passes to one each.
 *
 * @param {File|Blob|string} source
 * @param {{dropBlue?: boolean, onProgress?: (stage: string, pct: number) => void,
 *          signal?: AbortSignal}} opts
 */
export async function preprocess(source, opts = {}) {
  const { dropBlue = false, onProgress = () => {}, signal = null } = opts;

  /**
   * Announce a stage, let it be seen, then decide whether to go on.
   *
   * Of the eight labels this function reports, the first ('Reading image') is
   * followed by `await loadImageData`, which is a genuine task boundary, and
   * the last ('Ready') has nothing after it. The six in between are each
   * followed by a synchronous full-image pass with no await anywhere inside it,
   * so the label naming a pass was only ever painted once that pass had
   * finished — which is to say, while the next one was already running. Six
   * labels, not one of them on screen at the moment it was true.
   *
   * The abort check sits here rather than inside the passes because a pass
   * cannot be interrupted from outside: the click that sets the flag can only
   * run during the yield on the line above, so immediately after that yield is
   * the only place the flag can have changed. Stopping therefore takes effect
   * at the next stage boundary, and the widest of those gaps is one stage —
   * for estimateSlant's defaults (maxDeg 32, coarse 2, fine 0.25) that is
   * 33 coarse scores plus 17 fine ones, fifty complete passes over the
   * full-resolution mask, and it is the stage announced at 96%.
   */
  const stage = async (label, pct) => {
    onProgress(label, pct);
    await paintYield();
    signal?.throwIfAborted();
  };

  await stage('Reading image', 0.05);
  // Reserve the rotation's headroom up front.
  //
  // loadImageData clamps the longest edge to MAX_WORKING_DIM, and then
  // rotateGray below expands it again — a rotation by θ turns a w×h box into
  // one (cos θ + sin θ) larger on each axis. At the 8° estimateSkew searches to
  // that is about 13%, so every buffer downstream of the straightening step was
  // sized past the cap the constant exists to set. Loading slightly smaller
  // makes the post-rotate buffer the thing that actually honours it, which is
  // what the constant was always meant to bound.
  const rotationHeadroom = Math.cos(MAX_SKEW_RAD) + Math.sin(MAX_SKEW_RAD);
  const imageData = await loadImageData(source, Math.floor(MAX_WORKING_DIM / rotationHeadroom));

  await stage('Converting to grayscale', 0.2);
  let { gray, w, h } = toGrayscale(imageData, { dropBlue });

  // Four passes behind one label: a downscale, a Sauvola binarize, a despeckle
  // (which is itself a full labelComponents) and estimateSkew's 17 coarse plus
  // 20 or 21 fine scores over the 1200px analysis copy. Twenty or twenty-one
  // because 0.1 does not sum exactly in binary: for 6 of the 17 possible coarse
  // winners the accumulated step overshoots `best + coarse` and the last score
  // is skipped. Nothing depends on which, but the count is not a round number
  // and should not be written as one.
  await stage('Measuring page angle', 0.35);
  const small = downscaleGray(gray, w, h, ANALYSIS_DIM);
  const smallBin = sauvolaBinarize(small.gray, small.w, small.h);
  const angle = estimateSkew(despeckle(smallBin, small.w, small.h), small.w, small.h);

  if (Math.abs(angle) > 1e-4) {
    await stage('Straightening page', 0.5);
    ({ gray, w, h } = rotateGray(gray, w, h, angle));
  }

  await stage('Separating ink from paper', 0.7);
  let bin = sauvolaBinarize(gray, w, h);

  await stage('Removing speckles', 0.9);
  bin = despeckle(bin, w, h);

  // The bar reaches 96% here and then does the most work it has done all run:
  // estimateSlant scores 33 coarse angles and 17 fine ones, fifty complete
  // passes over the full-resolution mask. Announcing that honestly is the whole
  // reason the yield has to come before it rather than after.
  await stage('Measuring your slant', 0.96);
  const slant = estimateSlant(bin, w, h);

  // Not a stage(): nothing follows it inside this function, and capturePage
  // overwrites the label on its next line, so a yield here would only add a
  // task between two labels the reader never sees separately.
  onProgress('Ready', 1);
  return { bin, gray, w, h, angle, slant, inkRatio: countInk(bin) / (w * h) };
}

function countInk(bin) {
  let n = 0;
  for (let i = 0; i < bin.length; i++) n += bin[i];
  return n;
}

/** Render a binary mask to an ImageData for on-screen review. */
export function binToImageData(bin, w, h, { ink = [24, 26, 27], paper = [250, 249, 246] } = {}) {
  const out = new ImageData(w, h);
  const d = out.data;
  for (let i = 0, p = 0; i < bin.length; i++, p += 4) {
    const c = bin[i] ? ink : paper;
    d[p] = c[0]; d[p + 1] = c[1]; d[p + 2] = c[2]; d[p + 3] = 255;
  }
  return out;
}
