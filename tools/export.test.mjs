/**
 * Tests for the text the export step generates.
 *
 * One property matters more than the rest: a font name with an apostrophe in it
 * must not silently break the stylesheet. `Jo's Handwriting` emitted
 * `font-family: 'Jo's Handwriting';`, which tokenises as the string 'Jo', two
 * idents and an unterminated quote — the declaration is dropped, an @font-face
 * with no font-family descriptor is ignored entirely, and the user gets a
 * stylesheet that does nothing with no message saying why. Possessives and
 * Irish and French names hit it on the first try.
 *
 * This is not a security property. Nobody but the person at the keyboard can
 * set that name, and the output is a file they download. It is an ordinary
 * correctness property that happened to be found by looking for the other kind.
 */

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass });
  console.log(`  ${pass ? 'ok  ' : 'FAIL'} ${name}${detail && !pass ? ` — ${detail}` : ''}`);
};

const STYLES = [{ style: 'Regular' }, { style: 'Bold' }];

/** Every `font-family` declaration in the generated snippet. */
const families = (css) =>
  css.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('font-family:'));

/**
 * Does every single-quoted string in this CSS close before its line ends?
 *
 * Counting unescaped quotes is the whole test: an odd number on a line is
 * precisely the failure being guarded against.
 */
function quotesBalance(line) {
  let count = 0;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '\\') { i++; continue; }   // skip whatever is escaped
    if (line[i] === "'") count++;
  }
  return count % 2 === 0;
}

export async function run() {
  const { cssSnippet, readmeText, slugify } = await import('../src/export.js');

  // --- the name that broke it ----------------------------------------------
  {
    const css = cssSnippet("Jo's Handwriting", STYLES);
    const lines = families(css);
    check('a name with an apostrophe still produces font-family rules', lines.length >= 2,
      String(lines.length));
    check('and every one of them closes its quote', lines.every(quotesBalance),
      JSON.stringify(lines));
    check('the apostrophe survives, escaped rather than stripped',
      lines[0].includes("Jo\\'s Handwriting"), lines[0]);
  }

  // --- the other characters that can end a CSS string -----------------------
  {
    const backslash = 'A' + String.fromCharCode(92) + 'B';
    for (const [label, name] of [
      ['a double quote', 'Say "hi"'],
      ['a backslash', backslash],
      ['both at once', `it's "quite" ${backslash} odd`],
    ]) {
      const lines = families(cssSnippet(name, STYLES));
      check(`${label} leaves the strings balanced`, lines.every(quotesBalance), JSON.stringify(lines));
    }
  }

  // --- the ordinary case is untouched --------------------------------------
  {
    const lines = families(cssSnippet('My Handwriting', STYLES));
    check('a plain name is emitted verbatim, with no escapes',
      lines[0] === "font-family: 'My Handwriting';", lines[0]);
  }

  // --- the README shows the name as typed ----------------------------------
  {
    // Deliberately NOT escaped: nothing parses this file, and a reader looking
    // for their font in a menu needs to see the name they gave it.
    const txt = readmeText("Jo's Handwriting", STYLES, {});
    check('the README keeps the apostrophe unescaped', txt.includes("Jo's Handwriting"));
  }

  // --- filenames cannot escape the archive ----------------------------------
  {
    // Every separator — dot, slash, backslash — collapses to a dash, and the
    // leading run is then trimmed, so the result cannot begin with anything a
    // zip reader would follow out of the archive.
    check('separators are collapsed, so no entry name can traverse',
      slugify('../../etc/passwd') === 'etc-passwd', slugify('../../etc/passwd'));
    check('a Windows path is flattened the same way',
      slugify(`..${String.fromCharCode(92)}..${String.fromCharCode(92)}system32`) === 'system32',
      slugify(`..${String.fromCharCode(92)}..${String.fromCharCode(92)}system32`));
    check('a name with nothing usable in it still yields a filename',
      slugify('///') === 'Handwriting', slugify('///'));
  }

  return results;
}
