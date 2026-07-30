/**
 * Tests for the page-cleanup passes, and for one failure in particular.
 *
 * The app asks for blank paper. People write on the lined pad that is already on
 * the desk, and until `removeRules` existed the result was not a slightly worse
 * font — it was a page on which segmentation locked onto the printed rules
 * instead of the rows of writing, bundled the letters into whichever band they
 * touched, and returned a full grid of confident nonsense. Every character
 * found, every one of them wrong.
 *
 * So the property under test is not "rules get removed". It is that a ruled page
 * and the same page unruled segment to the *same answer*, and that a page with
 * no rules on it is not touched at all.
 */

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass });
  console.log(`  ${pass ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};

const W = 1300;
const H = 900;

function box(bin, x0, y0, x1, y1) {
  for (let y = Math.max(0, Math.round(y0)); y < Math.min(H, Math.round(y1)); y++) {
    for (let x = Math.max(0, Math.round(x0)); x < Math.min(W, Math.round(x1)); x++) {
      bin[y * W + x] = 1;
    }
  }
}

/** A row of `n` separated marks centred on `cy`, as in segment.test.mjs. */
function inkRow(bin, cy, n, { height = 70, gap = 30 } = {}) {
  const width = Math.floor((W - gap * (n + 1)) / n);
  for (let i = 0; i < n; i++) {
    const x0 = gap + i * (width + gap);
    box(bin, x0, cy - height / 2, x0 + width, cy + height / 2);
  }
}

/** Printed rules across the page, plus the margin rule down the left edge. */
function rule(bin, { spacing = 100, thickness = 2, margin = true } = {}) {
  for (let y = spacing; y < H; y += spacing) box(bin, 0, y, W, y + thickness);
  if (margin) box(bin, 10, 0, 10 + thickness, H);
}

const countInk = (bin) => { let n = 0; for (const v of bin) n += v; return n; };

const ALPHA = 'ABCDEFGHIJKLM'.split('');
const BETA = 'NOPQRSTUVWXYZ'.split('');

export async function run() {
  console.log('\nimageproc.js');

  const { removeRules } = await import('../src/imageproc.js');
  const { segmentSheet } = await import('../src/segment.js');

  const labelled = (seg) =>
    seg.rows.flatMap((r) => r.cells.filter((c) => !c.missing).map((c) => c.ch)).join('');

  // -- the writing survives, the rules do not -------------------------------
  {
    const clean = new Uint8Array(W * H);
    inkRow(clean, 250, 13);
    inkRow(clean, 550, 13);

    const ruled = new Uint8Array(clean);
    rule(ruled);

    const out = removeRules(ruled, W, H);

    check('a ruled page is recognised as ruled', out.rules > 0, `${out.rules} long thin runs`);
    check('and the writing is left intact',
      countInk(out.bin) >= countInk(clean) * 0.999,
      `${countInk(out.bin)} of ${countInk(clean)} original ink pixels`);
    check('and essentially nothing but the rules is taken',
      countInk(out.bin) <= countInk(clean) * 1.02,
      `${countInk(out.bin) - countInk(clean)} pixels above the unruled page`);
  }

  // -- a rule behind a stroke does not cut the stroke ------------------------
  //
  // The reason the test is a conjunction of length and thickness rather than
  // either alone. At the crossing the rule and the ink are the same pixels, so
  // no threshold can separate them; what separates them is that the crossing is
  // thick.
  {
    const bin = new Uint8Array(W * H);
    box(bin, 400, 100, 408, 800);   // a stem, 8 px wide, 700 tall
    rule(bin, { spacing: 100, thickness: 2, margin: false });

    const out = removeRules(bin, W, H);
    let gaps = 0;
    for (let y = 100; y < 800; y++) if (!out.bin[y * W + 404]) gaps++;

    check('a stem crossed by rules comes out unbroken', gaps === 0, `${gaps} missing rows`);

    let strayRuleInk = 0;
    for (let y = 100; y <= 700; y += 100) {
      for (let x = 0; x < 300; x++) if (out.bin[y * W + x]) strayRuleInk++;
    }
    check('and the rules either side of it are gone', strayRuleInk === 0, `${strayRuleInk} left`);
  }

  // -- an unruled page is not touched ---------------------------------------
  {
    const bin = new Uint8Array(W * H);
    inkRow(bin, 250, 13);
    inkRow(bin, 550, 13);
    const before = countInk(bin);
    const out = removeRules(bin, W, H);
    check('a page with no rules loses nothing',
      out.removed === 0 && out.rules === 0 && countInk(out.bin) === before,
      `removed ${out.removed}, rules ${out.rules}`);
    check('and the same buffer is handed back rather than a copy',
      out.bin === bin, 'no allocation on the common path');
  }

  // -- a long stroke that is not a rule -------------------------------------
  //
  // An underline is long and thin and will be removed. That is intended: it is
  // not a character either. What must not happen is a *character* qualifying, so
  // this checks the widest thing on a real sheet — a 13-cell row — stays.
  {
    const bin = new Uint8Array(W * H);
    inkRow(bin, 250, 13, { height: 8 });   // thin enough to be rule-like
    const before = countInk(bin);
    const out = removeRules(bin, W, H);
    check('a row of thin marks is not mistaken for a rule',
      countInk(out.bin) === before, `${before - countInk(out.bin)} pixels lost`);
  }

  // -- the whole point: segmentation recovers -------------------------------
  //
  // Geometry taken from the photograph that reported this: a page of narrow
  // rules with the writing sitting on them, and 32 characters distributed across
  // five notebook lines rather than the three rows of thirteen the sheet asks
  // for. The line distribution turns out not to matter — reconcileBands fuses
  // five bands back into three correctly — so the unruled case below passes and
  // is kept precisely to show that the rules, not the layout, are the cause.
  {
    const LOWER = 'abcdefghijklmnopqrstuvwxyz'.split('');
    const EVERYDAY = ['.', ',', "'", '-', '?', '!'];
    const SHEET = [LOWER.slice(0, 13), [...LOWER.slice(13), ...EVERYDAY.slice(0, 0)], EVERYDAY];
    // The sheet as charset.js chunks it: 13 / 13 / 6.
    const all = [...LOWER, ...EVERYDAY];
    SHEET.length = 0;
    for (let i = 0; i < all.length; i += 13) SHEET.push(all.slice(i, i + 13));
    const want = all.join('');

    // Five lines, as written.
    const LINES = [7, 6, 7, 6, 6];
    const page = ({ rules = 0, thickness = 5 } = {}) => {
      const bin = new Uint8Array(W * H);
      let y = 120;
      for (const n of LINES) {
        const pitch = 95;
        for (let i = 0; i < n; i++) box(bin, 70 + i * pitch, y - 28, 70 + i * pitch + 44, y + 28);
        y += 150;
      }
      if (rules) {
        for (let ry = 60; ry < H; ry += 75) box(bin, 0, ry, W, ry + thickness);
        box(bin, 36, 0, 36 + thickness, H);
      }
      return bin;
    };

    const unruled = segmentSheet(page({ rules: 0 }), W, H, SHEET);
    check('five written lines against three sheet rows is not itself a problem',
      labelled(unruled) === want, `"${labelled(unruled)}"`);

    // Every rule weight a photograph plausibly binarises to. The pass measures
    // the thickness off the page rather than assuming it, which is the only
    // reason the heavy end of this range works — a fixed fraction tuned for a
    // hairline removed nothing at all from an 8 px rule.
    for (const thickness of [2, 3, 5, 8, 12, 16]) {
      const raw = page({ rules: 1, thickness });
      const before = segmentSheet(raw, W, H, SHEET);
      const cleaned = removeRules(raw, W, H);
      const after = segmentSheet(cleaned.bin, W, H, SHEET);

      check(`${thickness} px rules break segmentation, and the pass repairs it`,
        labelled(before) !== want && labelled(after) === want,
        `before ${before.stats.found}/32, after ${after.stats.found}/32`);
    }
  }

  return results;
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}`) run();
