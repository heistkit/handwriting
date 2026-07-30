/**
 * congrats.js — one panel per sheet, set in the reader's own handwriting.
 *
 * The drop-off on the capture screen is not where anything is hard. It is after
 * a step comes back readable: a row of characters has been written by hand,
 * photographed, and read correctly, and the screen replies by enabling a button.
 * Nothing says the work paid off, and the natural reading of nothing is that it
 * did not.
 *
 * So each sheet gets its own panel, and the panel's whole argument is a single
 * line of the characters that sheet just added, rendered in the font built from
 * them. Not a description of progress — the thing itself, in their hand, on the
 * screen, ten seconds after they photographed it. That is the only claim this app
 * makes, and this is the first moment it can be demonstrated rather than asserted.
 *
 * Fresh per step, and the last one is different
 * ---------------------------------------------
 * One panel per step — fourteen of them — each naming what it added and what
 * that unlocked. When the last required step lands the panel becomes "You are
 * all set" instead, which is the one moment there is nothing left to ask for.
 * Fourteen small acknowledgements beat four large ones for the same reason
 * fourteen short steps beat four long sheets: the encouragement arrives while
 * there is still something left to do.
 *
 * Only what was actually read
 * ---------------------------
 * The characters shown are filtered against the glyphs that came out of the
 * capture, never taken from the sheet definition. A sheet where four characters
 * failed to trace must not present them in a font that does not contain them —
 * they would silently fall back to the system font, and the one screen whose job
 * is to show the reader their own handwriting would be showing them Arial.
 *
 * Nothing here is load-bearing. With this module absent the capture flow works
 * exactly as it did; the toast still reports what was found.
 */

/** The font family the panels render in. Registered by the caller. */
export const FAMILY = 'HandwriteCongrats';

/**
 * What each sheet buys, in the order the sheets are offered.
 *
 * Keyed by sheet id rather than positionally, so re-ordering charset.js cannot
 * quietly attach the capitals copy to the symbols sheet. A sheet with no entry
 * gets a panel built from its own title, which is the right fallback for the
 * optional ligature sheet and for anything added later.
 */
const COPY = {
  'lower-1': {
    title: 'Half the alphabet, in your hand',
    line: 'Thirteen letters down. The next thirteen finish a font you can install.',
  },
  'lower-2': {
    title: 'That is a working font',
    line: 'The whole lowercase alphabet. Add the six marks below and it sets ordinary English.',
  },
  marks: {
    title: 'Now it writes sentences',
    line: 'A full stop, a comma and four more. This is the point where it stops being letters and starts being writing.',
  },
  'caps-1': {
    title: 'Capitals, A to M',
    line: 'Sentences can start properly now.',
  },
  'caps-2': {
    title: 'Every capital you have',
    line: 'Names look like names, and headings look deliberate.',
  },
  digits: {
    title: 'Numbers, in your handwriting',
    line: 'Dates, prices, page numbers — anything counted.',
  },
  'punct-pairs': {
    title: 'Brackets and quotes',
    line: 'Asides, quotations and code all set properly from here.',
  },
  'punct-lines': {
    title: 'Slashes and lines',
    line: 'Dates, paths, and the underscore.',
  },
  symbols: {
    title: 'The row above the numbers',
    line: 'Hashes, percentages and addresses, which most handwriting fonts never cover.',
  },
  currency: {
    title: 'Money, in your hand',
    line: 'Four currencies that almost no handwriting font includes.',
  },
  'legal-marks': {
    title: 'Copyright and degree',
    line: 'Three marks that are surprisingly hard to fake convincingly.',
  },
  'maths-1': {
    title: 'The common operators',
    line: 'Plus, minus, equals and comparison, all in your writing.',
  },
  'maths-2': {
    title: 'The rest of the maths',
    line: 'Enough to set an equation without falling back to another font halfway.',
  },
  arrows: {
    title: 'Four directions',
    line: 'Arrows, which is the last of the characters this app asks for.',
  },
  ligatures: {
    title: 'Your joined pairs',
    line: 'Written as one stroke, and substituted as one shape when you type them.',
  },
};

/** The last panel. Not a sheet — the state of having finished. */
const FINALE = {
  title: 'You are all set',
  line: 'Every sheet is in. Build the font whenever you are ready — nothing is missing.',
};

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

/**
 * Build the panel for one sheet.
 *
 * @param {object} opts
 * @param {{id: string, title: string}} opts.sheet
 * @param {string[]} opts.chars   characters this sheet added AND the font has
 * @param {boolean} opts.complete true when this was the last sheet outstanding
 * @param {number} [opts.total]   how many the sheet asked for, for the count line
 * @returns {HTMLElement}
 */
export function panel({ sheet, chars, complete, total = 0 }) {
  const words = complete ? FINALE : (COPY[sheet.id] ?? {
    title: sheet.title,
    line: 'Those characters are in the font now.',
  });

  const box = el('section', 'congrats');
  box.dataset.sheet = sheet.id;

  // role="status" on the words only. The specimen underneath is the same
  // characters again, and a live region that read the whole panel would announce
  // the alphabet one letter at a time every time a sheet was photographed.
  const said = el('div', 'congrats__said');
  said.setAttribute('role', 'status');
  said.append(el('h3', 'congrats__title', words.title));
  said.append(el('p', 'congrats__line', words.line));
  box.append(said);

  if (chars.length) {
    const specimen = el('p', 'congrats__specimen', chars.join(' '));
    // The one place in the app that names this family. Falls back to cursive
    // rather than to the UI font, so that a face which somehow failed to register
    // still reads as handwriting rather than as the interface.
    specimen.style.fontFamily = `'${FAMILY}', cursive`;
    specimen.setAttribute('aria-hidden', 'true');
    box.append(specimen);

    const count = el('p', 'congrats__count');
    count.textContent = total && total > chars.length
      ? `${chars.length} of ${total} characters, in your handwriting.`
      : `${chars.length} character${chars.length === 1 ? '' : 's'}, in your handwriting.`;
    box.append(count);
  }

  return box;
}

/**
 * Which of a sheet's characters the font can actually show.
 *
 * @param {object} sheet          from charset.js
 * @param {Array<{ch: string, sheetId?: string}>} glyphs  state.glyphs
 */
export function shown(sheet, glyphs) {
  const have = new Set(glyphs.map((g) => g.ch));
  // Sheet order, not glyph order: the reader wrote them in a sequence and seeing
  // them back in it is part of recognising them as theirs.
  return sheet.rows.flat().filter((ch) => have.has(ch));
}
