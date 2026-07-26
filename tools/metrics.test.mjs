/**
 * Checks on the spacing engine.
 *
 * Two claims are worth testing directly, because they are the ones that decide
 * whether typed text looks evenly spaced:
 *
 *   - a baseline can be recovered from unruled paper using zone knowledge alone
 *   - flat, round and diagonal letters receive *different* bearings, ordered
 *     flat > round > diagonal, so that the perceived gap comes out equal
 *
 * Synthetic profiles are used rather than real scans so the expected answers
 * can be derived analytically. For a circle of radius R the mean inset of the
 * left profile is R(1 − π/4) ≈ 0.215R; for a triangle it is W/4. Those are the
 * numbers the assertions below are built on.
 */

import {
  solveRowMetrics,
  computeSpacing,
  computeKerning,
  deriveSpaceWidth,
  TARGET_X_HEIGHT,
} from '../src/metrics.js';

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`  [${pass ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}`);
}

const XH = TARGET_X_HEIGHT; // 500

/** Build a glyph whose left/right profiles follow analytic shapes. */
function glyph(ch, { width, shape, yFrom = 0, yTo = XH }) {
  const ys = [];
  const left = [];
  const right = [];
  const steps = 100;
  for (let i = 0; i <= steps; i++) {
    const y = yFrom + (i / steps) * (yTo - yFrom);
    const [l, r] = shape(y, width);
    ys.push(y);
    left.push(l);
    right.push(r);
  }
  return {
    ch,
    row: 0,
    col: 0,
    contours: [],
    inkWidth: width,
    ink: { x0: 0, y0: 0, x1: width, y1: XH },
    profiles: { ys, left, right },
  };
}

// Flat sides: ink touches both edges at every height. An 'H' or 'n'.
const flat = (y, w) => [0, w];

// Round: a circle inscribed in the box. An 'o'.
const round = (y, w) => {
  const R = w / 2;
  const cy = XH / 2;
  const dy = Math.min(R, Math.abs(y - cy) * (R / (XH / 2)));
  const dx = Math.sqrt(Math.max(0, R * R - dy * dy));
  return [R - dx, R + dx];
};

// Diagonal, apex at top: an 'A'. Left edge runs from centre down to 0.
const triangleUp = (y, w) => {
  const t = y / XH;
  return [(w / 2) * t, w - (w / 2) * t];
};

// Diagonal, apex at bottom: a 'V'.
const triangleDown = (y, w) => {
  const t = 1 - y / XH;
  return [(w / 2) * t, w - (w / 2) * t];
};

export function run() {
  console.log('\nmetrics.js');

  // -- 1. Baseline recovery from zone knowledge -----------------------------
  {
    // Truth: baseline 300, x-height 100, ascender 180 tall, descender 60 deep.
    const box = (ch, y0, y1) => ({ ch, page: { x0: 0, y0, x1: 40, y1 } });
    const row = [
      box('a', 200, 300), box('n', 200, 300), box('e', 202, 299),
      box('b', 120, 300), box('l', 118, 301),
      box('p', 200, 360), box('y', 201, 359),
    ];
    const m = solveRowMetrics(row);
    check('baseline recovered', Math.abs(m.baseline - 300) <= 1, `got ${m.baseline}`);
    check('x-height recovered', Math.abs(m.xHeight - 100) <= 2, `got ${m.xHeight}`);
    check('ascender recovered', Math.abs(m.ascHeight - 181) <= 3, `got ${m.ascHeight}`);
    check('descender recovered', Math.abs(m.descDepth - 59.5) <= 3, `got ${m.descDepth}`);
  }

  // -- 2. A stray mark must not move the baseline ---------------------------
  {
    const box = (ch, y0, y1) => ({ ch, page: { x0: 0, y0, x1: 40, y1 } });
    const row = [
      box('a', 200, 300), box('n', 200, 300), box('e', 200, 300),
      box('c', 201, 299), box('m', 200, 301),
      box('o', 200, 420), // a smudge fused onto the 'o', dragging its box down
    ];
    const m = solveRowMetrics(row);
    check(
      'median resists one bad glyph',
      Math.abs(m.baseline - 300) <= 1,
      `baseline ${m.baseline}`
    );
  }

  // -- 3. Bearings differ by shape ------------------------------------------
  {
    const W = 500;
    const glyphs = [
      glyph('H', { width: W, shape: flat }),
      glyph('o', { width: W, shape: round }),
      glyph('A', { width: W, shape: triangleUp }),
    ];
    const spacing = computeSpacing(glyphs, { spacingFactor: 0.3 });
    const [H, o, A] = glyphs;

    check(
      'flat letter gets the full target bearing',
      Math.abs(H.lsb - spacing.target) < 1,
      `lsb ${H.lsb.toFixed(1)} vs target ${spacing.target.toFixed(1)}`
    );
    check(
      'round letter is tighter than flat',
      o.lsb < H.lsb - 20,
      `o ${o.lsb.toFixed(1)} < H ${H.lsb.toFixed(1)}`
    );
    check(
      'diagonal letter is tighter than round',
      A.lsb < o.lsb - 20,
      `A ${A.lsb.toFixed(1)} < o ${o.lsb.toFixed(1)}`
    );
    // Analytic: circle inset = R(1−π/4) = 250·0.2146 ≈ 53.6
    check(
      'round inset matches the analytic value',
      Math.abs(o.perceived.left - 53.6) < 4,
      `measured ${o.perceived.left.toFixed(1)}, expected ~53.6`
    );
    // Analytic: triangle inset = W/4 = 125
    check(
      'diagonal inset matches the analytic value',
      Math.abs(A.perceived.left - 125) < 6,
      `measured ${A.perceived.left.toFixed(1)}, expected ~125`
    );
    check(
      'perceived gaps end up equal',
      Math.abs((H.lsb + H.perceived.left) - (o.lsb + o.perceived.left)) < 1 &&
        Math.abs((H.lsb + H.perceived.left) - (A.lsb + A.perceived.left)) < 1,
      'all three equal the target'
    );
  }

  // -- 4. Perfectly complementary shapes need no kerning --------------------
  {
    // 'A' and 'V' are the textbook kerning pair, yet as idealised triangles
    // they need none: perceptual bearings have already pulled both in by the
    // exact amount their slopes give away, so the gap between them is constant
    // at every height. Good spacing removes most of the demand for kerning,
    // and this asserts that rather than papering over it.
    const W = 460;
    const glyphs = [
      glyph('a', { width: W, shape: flat }),
      glyph('c', { width: W, shape: flat }),
      glyph('e', { width: W, shape: flat }),
      glyph('m', { width: W, shape: flat }),
      glyph('n', { width: W, shape: flat }),
      glyph('u', { width: W, shape: flat }),
      glyph('A', { width: W, shape: triangleUp }),
      glyph('V', { width: W, shape: triangleDown }),
    ];
    const spacing = computeSpacing(glyphs, { spacingFactor: 0.3 });
    const pairs = computeKerning(glyphs, spacing, {});
    const find = (l, r) => pairs.find((p) => p.left.ch === l && p.right.ch === r)?.value ?? 0;

    check('AV needs no kerning once spaced perceptually', Math.abs(find('A', 'V')) < 15, `A/V = ${find('A', 'V')}`);
    check('flat pairs need no kerning', Math.abs(find('n', 'n')) < 15, `n/n = ${find('n', 'n')}`);
  }

  // -- 5. Shapes that genuinely interlock do get kerned ---------------------
  {
    const W = 460;
    // Ink only in the bottom 15%: the foot of an 'L'. Its stem is narrow above.
    const Lshape = (y, w) => (y <= XH * 0.15 ? [0, w] : [0, w * 0.25]);
    // Bar across the top, narrow stem below: a 'T'.
    const Tshape = (y, w) => (y >= XH * 0.85 ? [0, w] : [w * 0.4, w * 0.6]);
    // Arm across the top, stem at the left: an 'r'.
    const rShape = (y, w) => (y >= XH * 0.8 ? [0, w] : [0, w * 0.25]);

    const glyphs = [
      glyph('a', { width: W, shape: flat }),
      glyph('c', { width: W, shape: flat }),
      glyph('e', { width: W, shape: flat }),
      glyph('m', { width: W, shape: flat }),
      glyph('n', { width: W, shape: flat }),
      glyph('u', { width: W, shape: flat }),
      glyph('r', { width: W, shape: rShape }),
      glyph('L', { width: W, shape: Lshape }),
      glyph('T', { width: W, shape: Tshape }),
      glyph('.', { width: 80, shape: flat, yFrom: 0, yTo: XH * 0.18 }),
    ];
    const spacing = computeSpacing(glyphs, { spacingFactor: 0.3 });
    const pairs = computeKerning(glyphs, spacing, {});
    const find = (l, r) => pairs.find((p) => p.left.ch === l && p.right.ch === r)?.value ?? 0;

    // L's foot and T's stem collide near the baseline: push them apart.
    check('L followed by T is opened up', find('L', 'T') > 40, `L/T = ${find('L', 'T')}`);
    // r's arm overhangs nothing and a period sits low: pull them together.
    check('r followed by period is tightened', find('r', '.') < -40, `r/. = ${find('r', '.')}`);
    check('flat pairs still untouched', Math.abs(find('n', 'a')) < 15, `n/a = ${find('n', 'a')}`);
  }

  // -- 6. The gap arithmetic itself ----------------------------------------
  {
    // For two flat-sided glyphs the closest approach must be exactly the sum of
    // the facing bearings. If the bearing terms are ever dropped or
    // double-counted, this is the check that notices.
    const W = 400;
    const g = [glyph('n', { width: W, shape: flat }), glyph('a', { width: W, shape: flat })];
    const spacing = computeSpacing(g, { spacingFactor: 0.3 });
    const [n, a] = g;
    const expected = n.rsb + a.lsb;
    check(
      'flat-pair gap equals the sum of facing bearings',
      Math.abs(expected - 2 * spacing.target) < 1,
      `${expected.toFixed(1)} vs ${(2 * spacing.target).toFixed(1)}`
    );
  }

  // -- 7. Space width tracks the writer's own rhythm ------------------------
  {
    const tight = [glyph('o', { width: 300, shape: round }), glyph('e', { width: 300, shape: round })];
    const wide = [glyph('o', { width: 700, shape: round }), glyph('e', { width: 700, shape: round })];
    const s1 = computeSpacing(tight, {});
    const s2 = computeSpacing(wide, {});
    const w1 = deriveSpaceWidth(tight, s1);
    const w2 = deriveSpaceWidth(wide, s2);
    check('space scales with letter width', w2 > w1 * 1.5, `${w1} vs ${w2}`);
  }

  return results;
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}`) run();
