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
  solveAllRows,
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

export async function run() {
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

  // -- 8. A pixel is not a fixed unit --------------------------------------
  //
  // Every sheet is a separate photograph at whatever distance the writer held
  // the camera, and the drawing pad measures in its own backing pixels, which
  // are neither. Nothing rectifies them to a common size. So an x-height
  // borrowed from one source and applied to another scales a glyph by the ratio
  // of two unrelated framings — silently, because a scale factor cannot be
  // wrong in a way that throws.
  {
    const { solveAllRows } = await import('../src/metrics.js');

    // Three photographed rows: baseline 1000/1300/1600, x-height 130px.
    const page = [];
    let row = 0;
    for (const base of [1000, 1300, 1600]) {
      for (const ch of ['a', 'c', 'e', 'o', 'x']) {
        page.push({ ch, row, sheetId: 'everyday', page: { x0: 0, y0: base - 130, x1: 60, y1: base } });
      }
      for (const ch of ['b', 'd', 'h', 'k', 'l']) {
        page.push({ ch, row, sheetId: 'everyday', page: { x0: 0, y0: base - 240, x1: 60, y1: base } });
      }
      row++;
    }

    // One character redrawn on the pad. W=440, H=506, SCALE=3, so the pad's
    // rules sit at yAsc 81, yX 228, yBase 374, yDesc 466 in CSS pixels.
    const S = 3;
    const drawn = {
      ch: 'f', row: 9000, sheetId: 'redraw',
      page: { x0: 100, y0: 243, x1: 300, y1: 1398 },
    };
    const guides = {
      baseline: 374 * S,
      xHeight: (374 - 228) * S,
      ascHeight: (374 - 81) * S,
      descDepth: (466 - 374) * S,
    };

    const spanOf = (solved, glyph) => {
      const m = solved.get(glyph.row);
      return {
        scale: m.scale,
        top: (m.baseline - glyph.page.y0) * m.scale,
        bottom: (m.baseline - glyph.page.y1) * m.scale,
      };
    };

    // 'f' is ZONES.full: alone in a row it pins neither a baseline nor an
    // x-height, so every inference below it has nothing to work from.
    const without = spanOf(solveAllRows([...page, drawn]), drawn);
    const withGuides = spanOf(solveAllRows([...page, { ...drawn, guides }]), drawn);

    check('a redrawn character is scaled by its own pad, not by a photograph',
      Math.abs(withGuides.scale - 500 / guides.xHeight) < 0.01,
      `scale=${withGuides.scale.toFixed(3)}, expected ${(500 / guides.xHeight).toFixed(3)}`);

    // The number that matters: on a 1000-unit em this used to reach 4327,
    // which fontbuild then took as the family's ascender for all four styles.
    check('and therefore fits the em rather than overflowing it',
      withGuides.top < 1100, `top=${Math.round(withGuides.top)} units`);
    check('and the unguided path is what it was rescued from',
      without.top > 3000, `top=${Math.round(without.top)} units`);

    // The same mismatch across two photographs. A row of maths signs is all
    // ZONES.mid, so it can never solve its own x-height, and the symbols sheet
    // is routinely shot at a different distance from the letters sheet.
    {
      const letters = [];
      for (const ch of ['a', 'c', 'e', 'o', 'x']) {
        letters.push({ ch, row: 0, sheetId: 'everyday', page: { x0: 0, y0: 870, x1: 60, y1: 1000 } });
      }
      // Symbols shot closer: same hand, 190px x-height. Row 1 has letters to
      // measure from, row 2 is pure `mid` and must borrow.
      const symbols = [];
      for (const ch of ['a', 'c', 'e', 'o', 'x']) {
        symbols.push({ ch, row: 1, sheetId: 'symbols', page: { x0: 0, y0: 810, x1: 90, y1: 1000 } });
      }
      for (const ch of ['+', '=', '<', '>', '×']) {
        symbols.push({ ch, row: 2, sheetId: 'symbols', page: { x0: 0, y0: 900, x1: 90, y1: 1000 } });
      }
      const solved = solveAllRows([...letters, ...symbols]);
      check('a maths row borrows its x-height from its own sheet',
        Math.abs(solved.get(2).xHeight - 190) < 1,
        `xHeight=${solved.get(2).xHeight}, wanted 190 (its own sheet) not 130`);
    }
  }

  // -- A row with no ascender and no descender ------------------------------
  //
  // Raised as a suspected cause of blank lowercase tiles: the baseline is
  // recovered from unruled paper by constraining ascenders and descenders
  // across a row, so a row of `a c e m n o` has neither and might be
  // under-determined rather than merely noisy.
  //
  // It is not, and the reason is worth writing down so nobody has to work it
  // out twice. Baseline comes from the BOTTOMS of x-zone and ascender-zone
  // glyphs, and x-height from the TOPS of x-zone and descender-zone glyphs — an
  // all-x row supplies both lists in full. What it cannot supply is the
  // ascender and descender extents, and those have somewhere to fall back to.
  //
  // So this pins behaviour that is already correct, which is the honest outcome
  // of the investigation rather than a fix for a bug that was not there.
  {
    const box = (ch, y0, y1) => ({ ch, page: { x0: 0, y0, x1: 40, y1 } });
    // Every one of these is ZONES.x: no stem rises, no tail drops.
    const row = ['a', 'c', 'e', 'm', 'n', 'o', 'r', 's', 'u', 'v', 'w', 'x', 'z']
      .map((ch, i) => box(ch, 200 + (i % 3) - 1, 300 + (i % 2)));

    const m = solveRowMetrics(row);
    check('an all-x-height row still pins its baseline',
      m.baseline != null && Math.abs(m.baseline - 300) <= 1, `baseline=${m.baseline}`);
    check('and still measures its own x-height',
      m.xHeight > 0 && Math.abs(m.xHeight - 100) <= 2, `xHeight=${m.xHeight}`);
    check('it reports having sampled nothing for the ascender',
      m.samples.ascender === 0, `${m.samples.ascender}`);
    check('and nothing for the descender', m.samples.descender === 0,
      `${m.samples.descender}`);

    // The part that would actually produce a blank tile: a NaN or a null
    // reaching normalizeGlyph, which scales every outline by it.
    const solved = solveAllRows(row.map((g) => ({ ...g, row: 0, sheetId: 'everyday' })));
    const only = solved.get(0);
    check('and the solved row carries a finite scale',
      Number.isFinite(only.scale) && only.scale > 0, `scale=${only.scale}`);
    check('and a finite baseline', Number.isFinite(only.baseline), `${only.baseline}`);
    check('so nothing downstream is asked to divide by nothing',
      Number.isFinite(only.xHeight) && only.xHeight > 0, `${only.xHeight}`);
  }

  // -- A row of one character ------------------------------------------------
  {
    // The redraw pad produces exactly this, and a median of one is that one.
    const solved = solveAllRows([
      { ch: 'o', row: 0, sheetId: 'everyday', page: { x0: 0, y0: 200, x1: 40, y1: 300 } },
    ]);
    const m = solved.get(0);
    check('a single-character row does not produce NaN',
      Number.isFinite(m.scale) && Number.isFinite(m.baseline) && m.xHeight > 0,
      JSON.stringify({ scale: m.scale, baseline: m.baseline, xHeight: m.xHeight }));
  }

  return results;
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}`) run();
