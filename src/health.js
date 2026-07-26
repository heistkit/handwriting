/**
 * health.js — telling the user what is wrong before they find out themselves.
 *
 * The failure mode this exists to prevent: someone converts their handwriting,
 * installs it, types a paragraph, and only then notices that their 'l' and
 * their 'I' are indistinguishable, or that one letter came out twice the size
 * of its neighbours because a smudge got fused onto it. By then the sheet is in
 * the recycling and the whole thing has to be redone.
 *
 * Everything here is checkable before export, and every finding names the
 * specific characters involved so the fix is one click rather than a hunt. The
 * checks are ordered by how badly each problem shows up in real text, not by
 * how easy it was to detect.
 */

import { BY_CHAR, REQUIRED, ZONES } from './charset.js';

const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

// ---------------------------------------------------------------------------
// Shape signatures
// ---------------------------------------------------------------------------

/**
 * Reduce a glyph to a small normalised grid of ink coverage.
 *
 * Scaling each glyph to the same box before comparing is the point: it means
 * the comparison asks "is this the same *shape*", not "is this the same size",
 * so a big 'O' and a small 'o' still register as similar — which is exactly the
 * confusion worth warning about.
 */
function signature(glyph, n = 14) {
  const sig = new Float64Array(n * n);
  const { bitmap, w, h } = glyph;

  // Tight bounds, so surrounding padding cannot shift the signature.
  let x0 = w, y0 = h, x1 = 0, y1 = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!bitmap[y * w + x]) continue;
      if (x < x0) x0 = x;
      if (y < y0) y0 = y;
      if (x + 1 > x1) x1 = x + 1;
      if (y + 1 > y1) y1 = y + 1;
    }
  }
  const bw = x1 - x0, bh = y1 - y0;
  if (bw <= 0 || bh <= 0) return sig;

  const counts = new Float64Array(n * n);
  for (let y = y0; y < y1; y++) {
    const gy = Math.min(n - 1, Math.floor(((y - y0) / bh) * n));
    for (let x = x0; x < x1; x++) {
      const gx = Math.min(n - 1, Math.floor(((x - x0) / bw) * n));
      counts[gy * n + gx]++;
      if (bitmap[y * w + x]) sig[gy * n + gx]++;
    }
  }
  for (let i = 0; i < sig.length; i++) if (counts[i]) sig[i] /= counts[i];
  return sig;
}

/** 1 = identical, 0 = nothing in common. */
function similarity(a, b) {
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff += Math.abs(a[i] - b[i]);
  return 1 - diff / a.length;
}

/**
 * Average stroke thickness, from the ratio of area to outline length.
 *
 * A stroke of width t and length L has area ≈ tL and a boundary ≈ 2L pixels
 * long, so 2·area/perimeter recovers t without needing a distance transform.
 */
function strokeWidth(glyph) {
  const { bitmap, w, h } = glyph;
  let area = 0, perimeter = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!bitmap[y * w + x]) continue;
      area++;
      const edge =
        x === 0 || y === 0 || x === w - 1 || y === h - 1 ||
        !bitmap[y * w + x - 1] || !bitmap[y * w + x + 1] ||
        !bitmap[(y - 1) * w + x] || !bitmap[(y + 1) * w + x];
      if (edge) perimeter++;
    }
  }
  return perimeter > 0 ? (2 * area) / perimeter : 0;
}

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

const finding = (level, code, title, detail, extra = {}) => ({
  level, code, title, detail, chars: extra.chars ?? [], ...extra,
});

/**
 * Inspect a completed capture.
 *
 * @param {Array} extracted   glyphs carrying `bitmap`, `w`, `h`, `ch`
 * @param {Array} normalized  glyphs in font units, carrying `ink`, `advanceWidth`
 * @param {Map}   rows        per-row metrics from metrics.solveAllRows
 * @param {object} opts       { slant, requiredOnly }
 */
export function analyse(extracted, normalized, rows, opts = {}) {
  const findings = [];
  const captured = new Set(extracted.map((g) => g.ch));

  // -- Coverage -------------------------------------------------------------
  const missing = REQUIRED.filter((e) => !captured.has(e.ch));
  const missingLetters = missing.filter((e) => e.group === 'lower' || e.group === 'upper');

  if (missingLetters.length) {
    findings.push(
      finding(
        'error',
        'missing-letters',
        `${missingLetters.length} letter${missingLetters.length === 1 ? '' : 's'} missing`,
        'These will show as blank boxes wherever you type them. Draw them in, or re-photograph the sheet they were on.',
        { chars: missingLetters.map((e) => e.ch) }
      )
    );
  }
  const missingOther = missing.filter((e) => e.group !== 'lower' && e.group !== 'upper');
  if (missingOther.length) {
    findings.push(
      finding(
        'info',
        'missing-symbols',
        `${missingOther.length} symbol${missingOther.length === 1 ? '' : 's'} not captured`,
        'Fine to leave out if you never type them. Anything missing falls back to a plain substitute.',
        { chars: missingOther.map((e) => e.ch) }
      )
    );
  }

  // -- Glyphs that barely have any ink --------------------------------------
  const inkAreas = extracted.map((g) => {
    let n = 0;
    for (let i = 0; i < g.bitmap.length; i++) n += g.bitmap[i];
    return { ch: g.ch, area: n };
  });
  const medianArea = median(inkAreas.filter((a) => a.area > 0).map((a) => a.area)) ?? 1;
  const faint = inkAreas.filter((a) => a.area < medianArea * 0.06 && !isSmallByNature(a.ch));
  if (faint.length) {
    findings.push(
      finding(
        'warn',
        'faint',
        `${faint.length} character${faint.length === 1 ? '' : 's'} came out very faint`,
        'Usually a light pen stroke or a shadow across the page. Check these look right, and redraw any that do not.',
        { chars: faint.map((a) => a.ch) }
      )
    );
  }

  // -- Look-alikes ----------------------------------------------------------
  const comparable = extracted.filter(
    (g) => {
      const e = BY_CHAR.get(g.ch);
      return e && (e.group === 'lower' || e.group === 'upper' || e.group === 'digit');
    }
  );
  const sigs = new Map(comparable.map((g) => [g.ch, signature(g)]));
  const pairs = [];
  for (let i = 0; i < comparable.length; i++) {
    for (let j = i + 1; j < comparable.length; j++) {
      const a = comparable[i].ch, b = comparable[j].ch;
      // Case pairs like C/c and O/o are *meant* to look alike; only flag
      // characters that readers actually need to tell apart.
      if (a.toLowerCase() === b.toLowerCase()) continue;
      const s = similarity(sigs.get(a), sigs.get(b));
      if (s > 0.93) pairs.push({ a, b, s });
    }
  }
  pairs.sort((p, q) => q.s - p.s);
  if (pairs.length) {
    const top = pairs.slice(0, 4);
    findings.push(
      finding(
        'warn',
        'lookalike',
        `${pairs.length} pair${pairs.length === 1 ? '' : 's'} of characters are nearly identical`,
        'Readers will not be able to tell these apart. Consider rewriting one of each pair more distinctly — a serif on the l, a slash through the 0.',
        {
          chars: [...new Set(top.flatMap((p) => [p.a, p.b]))],
          pairs: top.map((p) => ({ a: p.a, b: p.b, similarity: Math.round(p.s * 100) })),
        }
      )
    );
  }

  // -- Size outliers --------------------------------------------------------
  const byZone = new Map();
  for (const g of normalized) {
    const zone = BY_CHAR.get(g.ch)?.zone;
    if (!zone) continue;
    if (!byZone.has(zone)) byZone.set(zone, []);
    byZone.get(zone).push(g);
  }
  const oversized = [];
  for (const [zone, list] of byZone) {
    if (list.length < 4) continue;
    if (zone === ZONES.full || zone === ZONES.mid) continue; // legitimately varied
    const heights = list.map((g) => g.ink.y1 - g.ink.y0);
    const mid = median(heights);
    list.forEach((g, i) => {
      const ratio = heights[i] / mid;
      if (ratio > 1.5 || ratio < 0.6) oversized.push({ ch: g.ch, ratio });
    });
  }
  if (oversized.length) {
    findings.push(
      finding(
        'warn',
        'size-outlier',
        `${oversized.length} character${oversized.length === 1 ? '' : 's'} out of proportion`,
        'These are noticeably larger or smaller than the rest of your letters, which makes typed text look uneven. Often caused by a stray mark merging into the letter.',
        { chars: oversized.map((o) => o.ch) }
      )
    );
  }

  // -- Stroke weight --------------------------------------------------------
  const widths = extracted
    .filter((g) => !isSmallByNature(g.ch))
    .map((g) => ({ ch: g.ch, t: strokeWidth(g) }))
    .filter((x) => x.t > 0);
  const medianWidth = median(widths.map((x) => x.t));
  if (medianWidth) {
    const odd = widths.filter((x) => x.t > medianWidth * 1.8 || x.t < medianWidth * 0.5);
    if (odd.length > 2) {
      findings.push(
        finding(
          'info',
          'stroke-weight',
          'Pen weight varies across the sheet',
          'Some characters are noticeably heavier or lighter than the rest. Writing the whole set with one pen in one sitting gives the most even result.',
          { chars: odd.slice(0, 8).map((o) => o.ch) }
        )
      );
    }
  }

  // -- Rows the solver was unsure about -------------------------------------
  const shaky = [...rows.entries()].filter(([, m]) => !m.confident);
  if (shaky.length) {
    findings.push(
      finding(
        'info',
        'row-confidence',
        `${shaky.length} row${shaky.length === 1 ? '' : 's'} had little to measure against`,
        'The baseline for these rows was estimated from the rest of the page. Usually fine, but check that nothing sits too high or too low in the preview.',
        { rows: shaky.map(([r]) => r + 1) }
      )
    );
  }

  // -- Slant ----------------------------------------------------------------
  if (typeof opts.slant === 'number' && Math.abs(opts.slant) > 4) {
    const dir = opts.slant > 0 ? 'forwards' : 'backwards';
    findings.push(
      finding(
        'info',
        'slant',
        `Your writing leans ${dir} by about ${Math.abs(Math.round(opts.slant))}°`,
        `That has been kept, because it is part of your hand. The Italic style leans further still so it stays distinct. You can straighten it in Refine if you would rather.`,
        { slant: opts.slant }
      )
    );
  }

  const score = computeScore(findings, captured.size);
  return { findings, score, captured: captured.size, expected: REQUIRED.length };
}

/** Characters that are legitimately tiny, and so should not trip size checks. */
function isSmallByNature(ch) {
  return ['.', ',', "'", '"', ':', ';', '-', '`', '°', '_'].includes(ch);
}

/**
 * A single headline number.
 *
 * Weighted so that a missing letter — which produces a visible blank box in
 * every word containing it — costs far more than a symbol nobody will type.
 */
function computeScore(findings, capturedCount) {
  let score = 100;
  for (const f of findings) {
    if (f.level === 'error') score -= 12 + f.chars.length * 2;
    else if (f.level === 'warn') score -= 5 + Math.min(8, f.chars.length);
    else score -= 1;
  }
  const coverage = capturedCount / REQUIRED.length;
  score -= Math.round((1 - coverage) * 25);
  return Math.max(0, Math.min(100, Math.round(score)));
}

export const SCORE_LABELS = [
  { min: 92, label: 'Excellent', tone: 'good' },
  { min: 78, label: 'Good', tone: 'good' },
  { min: 60, label: 'Usable', tone: 'ok' },
  { min: 0, label: 'Needs work', tone: 'bad' },
];

export function scoreLabel(score) {
  return SCORE_LABELS.find((s) => score >= s.min) ?? SCORE_LABELS[SCORE_LABELS.length - 1];
}
