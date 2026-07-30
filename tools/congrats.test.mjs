/**
 * Checks on the per-sheet congratulations panels.
 *
 * `panel()` builds DOM and cannot run here, so it is verified in the browser.
 * What this file defends is the one thing that can drift silently: which
 * characters a panel is allowed to show.
 *
 * The rule is that a panel shows only characters the FONT contains, never the
 * characters the sheet asked for. Those two sets differ exactly when a capture
 * missed something — and that is the case where showing the sheet's list would
 * render the missing ones in the reader's system font, on the one screen whose
 * whole purpose is to show them their own handwriting.
 */

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass });
  console.log(`  ${pass ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};

export async function run() {
  console.log('\ncongrats.js');

  const { shown } = await import('../src/congrats.js');
  const { SHEETS, LIGATURE_SHEET } = await import('../src/charset.js');

  const everyday = SHEETS[0];
  const all = everyday.rows.flat();

  {
    const glyphs = all.map((ch) => ({ ch }));
    check('a complete capture shows every character on the sheet',
      shown(everyday, glyphs).join('') === all.join(''), `${shown(everyday, glyphs).length}`);
  }

  {
    // Four characters failed to trace. They are not in the font, so they must not
    // reach the specimen.
    const missing = new Set([all[0], all[5], all[11], all[all.length - 1]]);
    const glyphs = all.filter((ch) => !missing.has(ch)).map((ch) => ({ ch }));
    const out = shown(everyday, glyphs);
    check('characters that did not trace are left out',
      out.length === all.length - missing.size && !out.some((ch) => missing.has(ch)),
      `${out.length} of ${all.length}`);
  }

  {
    // Glyphs from other sheets are in state.glyphs too. A panel must not borrow
    // them: the capitals panel showing lowercase would misreport what the sheet
    // just contributed.
    const others = SHEETS[1].rows.flat().map((ch) => ({ ch }));
    const out = shown(everyday, others);
    check('a panel never shows another sheet’s characters', out.length === 0, `${out.length}`);
  }

  {
    const glyphs = [...all].reverse().map((ch) => ({ ch }));
    check('characters come back in sheet order, not glyph order',
      shown(everyday, glyphs).join('') === all.join(''), shown(everyday, glyphs).slice(0, 6).join(''));
  }

  {
    check('nothing captured means nothing to show', shown(everyday, []).length === 0);
    // Ligature rows hold sequences rather than single characters, and the pairs
    // are keyed by the whole sequence in state.glyphs.
    const pairs = LIGATURE_SHEET.rows.flat().slice(0, 3);
    check('the ligature sheet matches on whole sequences',
      shown(LIGATURE_SHEET, pairs.map((ch) => ({ ch }))).join(',') === pairs.join(','),
      pairs.join(','));
  }

  return results;
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}`) run();
