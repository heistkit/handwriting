/**
 * template.js — the printable writing sheet.
 *
 * The primary flow asks people to copy characters onto blank paper. This is the
 * alternative for anyone who would rather write inside guide boxes: a sheet they
 * print, fill in, and photograph.
 *
 * The one thing that must be right is the colour. Guides print in light blue,
 * never grey, because toGrayscale({ dropBlue: true }) in imageproc.js pushes
 * saturated blue to white before thresholding. Blue guides therefore vanish
 * during binarisation, exactly like non-photo blue pencil in traditional
 * drafting; grey ones would survive and be traced into the letters as stray
 * contours. Everything printed inside a writing box — the box, the two rules,
 * and the small target character — is drawn in that blue for the same reason.
 *
 * There are deliberately no registration marks or corner fiducials. The app
 * already knows which character it asked for and in what order, so nothing reads
 * the boxes as landmarks; they are a writing aid for the human alone.
 */

// The blue that survives on paper but drops out under dropBlue. Kept as a
// module constant rather than a CSS token because it must be an exact,
// print-stable value: the tokens in styles.css are tuned for a screen and shift
// with the light/dark theme, whereas this has to clear the blue-drop threshold
// in imageproc every time, on paper, regardless of theme.
const GUIDE = '#9fc5e8';
const GUIDE_SOFT = '#c4dcf0'; // the pale corner character; still firmly blue

// Ink for the human-only instruction block. Near-black, never pure black, and
// set apart from the grid so it does not read as another row of glyphs.
const INK = '#1b1d20';

/** 13 cells to a row, matching the on-screen sheets in charset.js. */
const COLS = 13;

/**
 * @param {object} opts
 * @param {'a4'|'letter'} [opts.paper='a4']
 * @param {Array<{id,title,hint,rows:string[][],optional?:boolean}>} opts.sheets
 * @returns {HTMLElement} a print-ready DOM subtree
 */
export function renderTemplate({ paper = 'a4', sheets = [] } = {}) {
  const root = document.createElement('div');
  root.className = 'ivt-root';
  root.dataset.paper = paper === 'letter' ? 'letter' : 'a4';

  // The print CSS is not part of this subtree — it cannot be, see adoptRules.
  // It is carried on the root so printTemplate can install it at the moment it
  // is needed and take it away again afterwards.
  root.dataset.css = styleCss(root.dataset.paper);
  root.append(instructionPage());

  sheets.forEach((sheet, i) => root.append(sheetPage(sheet, i === 0)));

  return root;
}

/** Opens the browser print dialog for a rendered sheet. */
export function printTemplate(element) {
  if (!element) return;
  const root = element.classList?.contains('ivt-root')
    ? element
    : element.querySelector?.('.ivt-root') ?? element;

  // If the caller never mounted it, attach it just long enough to print. The
  // @media print rules below hide everything else on the page, so whatever the
  // app is showing does not bleed onto the sheet.
  const wasAttached = root.isConnected;
  if (!wasAttached) document.body.append(root);
  // Installed for the duration of the print and removed in cleanup below. It is
  // a document-wide sheet — it has to be, to hide the app behind the paper — so
  // leaving it adopted would keep the app hidden from its own print dialog the
  // next time anything else printed.
  const dropRules = adoptRules(root.dataset.css || '');
  document.body.classList.add('ivt-printing');

  // Two independent "printing has finished" signals, because afterprint is not
  // fired reliably by every engine. Both only fire once the dialog is gone, so
  // neither can tear the sheet down mid-print — which a timer-based fallback
  // could, in any browser where print() does not block.
  const mql = window.matchMedia?.('print');
  let done = false;
  const cleanup = () => {
    if (done) return;
    done = true;
    document.body.classList.remove('ivt-printing');
    dropRules();
    if (!wasAttached) root.remove();
    window.removeEventListener('afterprint', cleanup);
    mql?.removeEventListener?.('change', onMediaChange);
  };
  const onMediaChange = (e) => { if (!e.matches) cleanup(); };

  window.addEventListener('afterprint', cleanup);
  mql?.addEventListener?.('change', onMediaChange);
  window.print();
}

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

function instructionPage() {
  const page = document.createElement('section');
  page.className = 'ivt-page ivt-intro';

  const h = document.createElement('h1');
  h.className = 'ivt-h1';
  h.textContent = 'Handwriting sheet';
  page.append(h);

  const lead = document.createElement('p');
  lead.className = 'ivt-lead';
  lead.textContent =
    'Write one character inside each box, then photograph the finished pages. ' +
    'The blue boxes disappear when the photo is processed, so only your ink is read.';
  page.append(lead);

  const ul = document.createElement('ul');
  ul.className = 'ivt-rules';
  for (const rule of [
    'Use a dark fine-liner or gel pen, not a pencil. Graphite photographs too faint and catches the light.',
    'Write at your natural size and speed. Careful block capitals make a stiffer, less personal font.',
    'Keep every stroke inside its box, and do not let neighbouring characters touch — that is the one thing the app cannot fix.',
    'Rest each letter on the dotted baseline and size it to the dashed mid-line.',
    'Photograph the page flat in even, indirect light with the camera parallel to the paper.',
  ]) {
    const li = document.createElement('li');
    li.textContent = rule;
    ul.append(li);
  }
  page.append(ul);

  return page;
}

function sheetPage(sheet, isFirstSheet) {
  const page = document.createElement('section');
  page.className = 'ivt-page';

  const head = document.createElement('div');
  head.className = 'ivt-sheet-head';

  const title = document.createElement('h2');
  title.className = 'ivt-h2';
  title.textContent = sheet.title ?? '';
  head.append(title);

  if (sheet.optional) {
    const badge = document.createElement('span');
    badge.className = 'ivt-badge';
    badge.textContent = 'Optional — only if your writing joins up';
    head.append(badge);
  }
  page.append(head);

  if (sheet.hint) {
    const hint = document.createElement('p');
    hint.className = 'ivt-hint';
    hint.textContent = sheet.hint;
    page.append(hint);
  }

  const grid = document.createElement('div');
  grid.className = 'ivt-grid';
  for (const row of sheet.rows ?? []) {
    const rowEl = document.createElement('div');
    rowEl.className = 'ivt-row';
    for (const ch of row) rowEl.append(cell(ch));
    grid.append(rowEl);
  }
  page.append(grid);

  return page;
}

function cell(ch) {
  const el = document.createElement('div');
  el.className = 'ivt-cell';

  // The target sits small and pale in a corner. Printed at full size in the box
  // it would be photographed and traced along with the handwriting.
  const target = document.createElement('span');
  target.className = 'ivt-target';
  target.textContent = ch;

  const box = document.createElement('div');
  box.className = 'ivt-box';
  // Two guide rules improve how consistently people size letters, which feeds
  // straight back into the font. Dashed for the x-height, dotted for the base.
  const xline = document.createElement('span');
  xline.className = 'ivt-xline';
  const baseline = document.createElement('span');
  baseline.className = 'ivt-baseline';
  box.append(xline, baseline);

  el.append(target, box);
  return el;
}

// ---------------------------------------------------------------------------
// Scoped print stylesheet
// ---------------------------------------------------------------------------

/**
 * All layout is inlined so the module carries its own print behaviour and does
 * not depend on the app's stylesheet being present. print-color-adjust: exact
 * is essential — without it browsers strip the blue guides as "background" and
 * the sheet prints blank boxes with no rules at all.
 *
 * The rules go in through CSSOM rather than through textContent, and that is
 * not a stylistic choice. The content-security policy carries
 * `style-src-elem 'self'`, and under it Chrome refuses a <style> element with
 * text in it — `style-src-elem <- inline` — refusing it the way CSP refuses
 * things: the element is appended, its textContent is intact, and not one of
 * its rules applies. The staging area then sits in the page flow instead of
 * being parked off-screen and the sheet prints blank, with nothing thrown and
 * nothing on screen to say so. The first anyone would know is the paper.
 *
 * A hash cannot help, because the text interpolates the paper size. insertRule
 * can, because CSP governs the *content of the element* and not the object
 * model — a sheet built rule by rule was never parsed from markup, so there is
 * nothing for the directive to refuse.
 *
 * Cell size is driven by the narrower usable width so 13 always fit a row on
 * both papers without reflowing; the wider paper simply gains a larger margin.
 */
/**
 * Move a style element's rules from a pending string into its own sheet.
 *
 * `styleElement` parks the CSS on a data attribute rather than in the element's
 * text, so nothing is ever parsed from markup. Here it is split into top-level
 * rules and inserted one at a time.
 *
 * The split is a brace counter rather than a regular expression because two of
 * these rules are `@media` blocks with their own braces inside, and insertRule
 * takes one complete rule at a time — a naive split on `}` would hand it the
 * first half of a media query. Comments are stripped first: insertRule parses a
 * single rule and a leading comment is not one.
 *
 * If anything goes wrong the text is written the old way as a fallback. That
 * path is refused under this app's own policy, but this module is a
 * self-contained printable sheet and is worth keeping usable somewhere with no
 * policy at all.
 */
/**
 * Install the sheet's CSS as a constructed stylesheet on the document.
 *
 * A <style> element cannot carry it. Under `style-src-elem 'self'` Chrome
 * refuses one with text in it, and refuses it thoroughly: the element is
 * appended, its textContent survives, no rule applies, and `style.sheet` is
 * null forever — so there is not even a sheet to reach through CSSOM and fill
 * in afterwards. Nothing throws. The staging area sits in the page flow instead
 * of parked off-screen and the paper comes out blank.
 *
 * A constructed CSSStyleSheet is the way through, because it is not markup:
 * nothing was parsed from a document, so the directive has nothing to refuse.
 * Measured against this app's own policy — no violation, rules apply.
 *
 * Adopted on the document rather than a shadow root because these rules must
 * reach outside the subtree: `body.ivt-printing > :not(.ivt-root)` is what
 * hides the app so only the sheet prints, and a scoped sheet cannot say that.
 * Everything else is namespaced under .ivt- so document scope costs nothing.
 *
 * @returns {() => void} removes the sheet again
 */
function adoptRules(css) {
  if (typeof CSSStyleSheet !== 'function') return () => {};
  let sheet;
  try {
    sheet = new CSSStyleSheet();
    sheet.replaceSync(css);
  } catch (err) {
    // No constructable stylesheets, or a rule this engine will not parse.
    // Printing falls back to the browser's own page setup, which still produces
    // a usable sheet — the guides are drawn as elements, not as CSS.
    console.error('template: could not install the print stylesheet', err);
    return () => {};
  }
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
  return () => {
    document.adoptedStyleSheets = document.adoptedStyleSheets.filter((s) => s !== sheet);
  };
}

function styleCss(paper) {
  const pageMargin = paper === 'letter' ? '15mm 17mm' : '14mm';
  return `
.ivt-root { --ivt-guide: ${GUIDE}; --ivt-guide-soft: ${GUIDE_SOFT}; --ivt-ink: ${INK}; }

@media screen {
  /* On screen this subtree is only ever a staging area for printing, so keep it
     out of the app's flow until printTemplate reveals it to the print engine. */
  .ivt-root { position: fixed; left: -100000px; top: 0; width: 210mm; }
}

@media print {
  @page { size: ${paper}; margin: ${pageMargin}; }

  html, body { margin: 0; background: #ffffff; }
  /* Hide whatever the app is showing so only the sheet reaches the paper. */
  body.ivt-printing > :not(.ivt-root) { display: none !important; }

  .ivt-root { position: static; left: auto; width: auto; }

  .ivt-root, .ivt-root * {
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
    box-sizing: border-box;
  }

  .ivt-page {
    break-after: page;
    font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
    color: var(--ivt-ink);
  }
  .ivt-page:last-child { break-after: auto; }

  .ivt-h1 { font-size: 15pt; margin: 0 0 6pt; }
  .ivt-lead { font-size: 9.5pt; line-height: 1.45; margin: 0 0 10pt; max-width: 150mm; }
  .ivt-rules { font-size: 9pt; line-height: 1.4; margin: 0; padding-left: 5mm; }
  .ivt-rules li { margin-bottom: 4pt; }
  .ivt-intro { padding-top: 4mm; }

  .ivt-sheet-head { display: flex; align-items: baseline; gap: 4mm; margin: 0 0 2pt; }
  .ivt-h2 { font-size: 13pt; margin: 0; }
  .ivt-badge {
    font-size: 8pt; letter-spacing: .02em;
    color: #2f6ca3; border: 0.4pt solid var(--ivt-guide); border-radius: 2mm;
    padding: 1pt 2mm;
  }
  .ivt-hint { font-size: 8.5pt; line-height: 1.35; margin: 0 0 4mm; max-width: 165mm; color: #3a3d42; }

  .ivt-grid { display: flex; flex-direction: column; gap: 2.4mm; }
  .ivt-row {
    display: grid;
    grid-template-columns: repeat(${COLS}, 1fr);
    gap: 2.4mm;
    /* Never split a row across a page boundary; break cleanly between rows. */
    break-inside: avoid;
  }

  .ivt-cell { position: relative; aspect-ratio: 1 / 1.18; }
  .ivt-target {
    position: absolute; top: 0.4mm; left: 1mm;
    font-size: 7pt; line-height: 1;
    color: var(--ivt-guide-soft);
  }
  .ivt-box {
    position: absolute; inset: 0;
    border: 0.5pt solid var(--ivt-guide);
    border-radius: 1mm;
  }
  /* Baseline at ~74% down, x-height rule half the writing height above it — the
     proportion the drawing pad also defaults to, so both capture flows agree. */
  .ivt-baseline {
    position: absolute; left: 0; right: 0; top: 74%;
    border-top: 0.5pt dotted var(--ivt-guide);
  }
  .ivt-xline {
    position: absolute; left: 0; right: 0; top: 48%;
    border-top: 0.5pt dashed var(--ivt-guide);
  }
}`;
}
