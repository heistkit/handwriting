/**
 * Tests for the resolution finding.
 *
 * The property worth defending is that the number is *derived*, not invented.
 * metrics.js already solves each row's x-height in source pixels and scales it
 * to TARGET_X_HEIGHT, so `scale` is units-per-pixel and the finding reports
 * arithmetic the pipeline had already done. If someone later changes
 * TARGET_X_HEIGHT, the reported figure must move with it rather than drift.
 *
 * The second property is that it says nothing when it does not know. A row that
 * failed to solve carries no x-height, and reporting a resolution derived from
 * fallback proportions would be asserting a measurement that was never taken.
 */

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass });
  console.log(`  ${pass ? 'ok  ' : 'FAIL'} ${name}${detail && !pass ? ` — ${detail}` : ''}`);
};

/** A rows Map as metrics.buildMetrics returns it. */
const rowsOf = (...pairs) => new Map(pairs.map((r, i) => [i, r]));

/** Everything analyse() needs beyond rows, with nothing wrong in it. */
function healthyInput(REQUIRED) {
  const extracted = REQUIRED.map((e, i) => ({
    ch: e.ch, row: 0, w: 40, h: 60,
    page: { x0: 0, y0: 0, x1: 40, y1: 60 },
    bitmap: new Uint8Array(40 * 60).fill(1),
  }));
  const normalized = extracted.map((g) => ({
    ch: g.ch, advance: 600, lsb: 40, rsb: 40,
    // metrics.js gives every normalised glyph an ink box in em units; the
    // zone-consistency check reads it, so a fixture without one crashes.
    ink: { x0: 0, y0: 0, x1: 520, y1: 500 },
    contours: [{ curves: [[{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 2 }, { x: 3, y: 3 }]] }],
  }));
  return { extracted, normalized };
}

export async function run() {
  const { analyse } = await import('../src/health.js');
  const { REQUIRED } = await import('../src/charset.js');
  const { TARGET_X_HEIGHT } = await import('../src/metrics.js');

  const { extracted, normalized } = healthyInput(REQUIRED);
  const resFinding = (rows) =>
    analyse(extracted, normalized, rows).findings.find((f) => f.code === 'low-resolution');

  // --- a good photograph says nothing --------------------------------------
  {
    // 250px of x-height is 2 units per pixel.
    const rows = rowsOf({ xHeight: 250, scale: TARGET_X_HEIGHT / 250 });
    check('a well-filled frame produces no resolution finding', !resFinding(rows));
  }

  // --- a marginal one warns quietly ----------------------------------------
  {
    // 25px of x-height is 20 units per pixel.
    const f = resFinding(rowsOf({ xHeight: 25, scale: TARGET_X_HEIGHT / 25 }));
    check('a small x-height is reported', Boolean(f));
    check('and the pixel height is the measured one', /25 pixels/.test(f?.title || ''), f?.title);
    check('and the units come from the pipeline, not a constant',
      /20 units/.test(f?.detail || ''), f?.detail);
  }

  // --- what it must not say -------------------------------------------------
  {
    const f = resFinding(rowsOf({ xHeight: 20, scale: TARGET_X_HEIGHT / 20 }));
    // A font is Bezier outlines; a rasteriser draws them crisply at any size.
    // Telling someone their font will be blurry would be false.
    check('it never claims the font will be blurry', !/blur/i.test(f?.detail || ''), f?.detail);
    check('it says what actually degrades', /corner|lump/i.test(f?.detail || ''), f?.detail);
  }

  // --- it stays quiet when it does not know --------------------------------
  {
    check('no rows at all means no claim', !resFinding(new Map()));
    check('a row that never solved means no claim',
      !resFinding(rowsOf({ xHeight: 0, scale: 0 })));
    check('a missing rows argument does not throw',
      !resFinding(undefined) && !resFinding(null));
  }

  // --- the median, not the worst row ---------------------------------------
  {
    // One bad row among three good ones must not condemn the whole sheet.
    const rows = rowsOf(
      { xHeight: 200, scale: TARGET_X_HEIGHT / 200 },
      { xHeight: 210, scale: TARGET_X_HEIGHT / 210 },
      { xHeight: 18, scale: TARGET_X_HEIGHT / 18 }
    );
    check('one poor row does not condemn a good sheet', !resFinding(rows));
  }

  return results;
}
