/**
 * Structural checks on index.html.
 *
 * Nothing was checking the markup, and it turned out to matter. The feedback
 * dialogue was missing one closing </div>, so the browser's error recovery
 * quietly re-parented everything after it — #legal, #leaving and #settings all
 * became children of a dialogue that is `hidden`. Opening Settings then set
 * `hidden = false` on an element whose parent was still `display: none`, so the
 * route changed, the button reported success, no error was raised anywhere, and
 * nothing appeared on screen.
 *
 * That class of bug is invisible to every other test in this repo, because every
 * other test runs against JavaScript modules and this one lives in a text file.
 * Two properties are worth pinning down:
 *
 *   1. Tags balance. An unclosed element does not fail loudly; it silently
 *      changes the shape of the tree.
 *   2. Every modal is a direct child of <body>. A modal is `position: fixed`
 *      with a backdrop, so nesting one inside another is never intentional —
 *      and it inherits the outer one's `hidden`.
 *
 * This is a tag-balance scanner, not an HTML parser. It does not need to be one:
 * it is checking that the document says what its author meant, which is exactly
 * the thing a forgiving parser hides.
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass });
  console.log(`  ${pass ? 'ok  ' : 'FAIL'} ${name}${detail && !pass ? ` — ${detail}` : ''}`);
};

/** Elements that never have a closing tag. */
const VOID = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr',
]);

/** Elements whose content is text, not markup — a `<` inside is not a tag. */
const RAW_TEXT = new Set(['script', 'style', 'textarea', 'title']);

/**
 * Walk the document, maintaining an element stack.
 *
 * @returns {{stack: string[], errors: string[], opens: Array<{tag,attrs,line,ancestors}>}}
 */
function scan(html) {
  const stack = [];
  const errors = [];
  const opens = [];

  // Comments can legally contain anything that looks like a tag, and this file
  // has several that quote markup. Blanked rather than deleted so the line
  // numbers in any failure message still point at the real line.
  const blanked = html.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' '));

  const tag = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g;
  let m;
  let skipTo = 0;

  while ((m = tag.exec(blanked)) !== null) {
    if (m.index < skipTo) continue;

    const [, slash, rawName, attrs, selfClose] = m;
    const name = rawName.toLowerCase();
    const line = blanked.slice(0, m.index).split('\n').length;

    if (slash) {
      if (!stack.length) {
        errors.push(`line ${line}: </${name}> with nothing open`);
      } else if (stack[stack.length - 1].name !== name) {
        errors.push(
          `line ${line}: </${name}> closes <${stack[stack.length - 1].name}> ` +
          `opened at line ${stack[stack.length - 1].line}`
        );
        // Recover the way a browser does, so one mistake does not cascade into
        // an error for every tag after it.
        const at = stack.map((s) => s.name).lastIndexOf(name);
        if (at >= 0) stack.length = at;
      } else {
        stack.pop();
      }
      continue;
    }

    if (VOID.has(name) || selfClose) continue;

    opens.push({ tag: name, attrs, line, ancestors: stack.slice() });
    stack.push({ name, line, attrs });

    // <script> and friends: everything up to the matching close is text.
    if (RAW_TEXT.has(name)) {
      const end = blanked.indexOf(`</${name}`, tag.lastIndex);
      if (end >= 0) {
        skipTo = end;
        stack.pop();
        opens.pop();
        tag.lastIndex = end + name.length + 3;
      }
    }
  }

  return { stack, errors, opens };
}

const classOf = (attrs) => (attrs.match(/\bclass\s*=\s*"([^"]*)"/) || [, ''])[1];
const idOf = (attrs) => (attrs.match(/\bid\s*=\s*"([^"]*)"/) || [, ''])[1];

/**
 * The checker, checked.
 *
 * A structural test that cannot fail is worse than no test, because it reads
 * like coverage. These are miniatures of the exact bug this file exists for, so
 * a scanner that stops noticing gets caught here rather than on the deploy.
 */
function selfCheck() {
  const missingClose = `<body>
    <div class="sheet-modal" id="a">
      <div class="sheet-modal-panel">x</div>
    <div class="sheet-modal" id="b"><p>y</p></div>
  </body>`;
  const a = scan(missingClose);
  check('the scanner sees a modal swallowed by an unclosed one',
    a.opens
      .filter((o) => classOf(o.attrs).includes('sheet-modal') && idOf(o.attrs) === 'b')
      .every((o) => o.ancestors.some((s) => classOf(s.attrs || '').includes('sheet-modal'))));

  const unclosed = scan('<body><div><section>x</section></body>');
  check('the scanner sees a tag left open',
    unclosed.errors.length > 0 || unclosed.stack.length > 0);

  const crossed = scan('<div><span>x</div></span>');
  check('the scanner sees crossed tags', crossed.errors.length > 0);

  // And it must not cry wolf on things that are fine.
  const clean = scan('<body><div class="a"><img src="x"><br/><p>t</p></div></body>');
  check('the scanner accepts void and self-closing tags',
    clean.errors.length === 0 && clean.stack.length === 0,
    JSON.stringify(clean.errors));

  const scripted = scan('<body><script>if (a < b && c > d) {}</script><div>x</div></body>');
  check('the scanner does not read script contents as markup',
    scripted.errors.length === 0 && scripted.stack.length === 0,
    JSON.stringify(scripted.errors));

  const commented = scan('<body><!-- <div> unclosed in a comment --><p>x</p></body>');
  check('the scanner ignores markup inside comments',
    commented.errors.length === 0 && commented.stack.length === 0,
    JSON.stringify(commented.errors));
}

export async function run() {
  console.log('\nindex.html');

  selfCheck();

  const here = dirname(fileURLToPath(import.meta.url));
  const html = await readFile(join(here, '..', 'index.html'), 'utf8');
  const { stack, errors, opens } = scan(html);

  // --- tags balance ---------------------------------------------------------
  check('every tag is closed by the tag it opened', errors.length === 0, errors.join('; '));
  check('nothing is left open at the end of the document', stack.length === 0,
    stack.map((s) => `<${s.name}> from line ${s.line}`).join(', '));

  // --- modals are siblings, never nested ------------------------------------
  {
    const modals = opens.filter((o) => classOf(o.attrs).split(/\s+/).includes('sheet-modal'));
    check('the modals are still in the document', modals.length >= 4, `${modals.length} found`);

    const parentOf = (o) => o.ancestors[o.ancestors.length - 1];
    const nested = modals.filter((o) => parentOf(o)?.name !== 'body');
    check('every modal is a direct child of <body>', nested.length === 0,
      nested.map((o) => `#${idOf(o.attrs) || '?'} at line ${o.line} is inside <${parentOf(o)?.name}> from line ${parentOf(o)?.line}`).join(', '));

    // The exact shape of the bug that prompted this file: one modal swallowing
    // another, so the inner one inherits `hidden` from a parent nobody is
    // looking at. Named separately because this is the message a reader needs.
    const isModal = (s) => classOf(s.attrs || '').split(/\s+/).includes('sheet-modal');
    const swallowed = modals.filter((o) => o.ancestors.some(isModal));
    check('no modal is nested inside another modal', swallowed.length === 0,
      swallowed.map((o) => `#${idOf(o.attrs) || '?'} inside #${idOf(o.ancestors.find(isModal).attrs) || '?'}`).join(', '));
  }

  // --- every id is unique ---------------------------------------------------
  {
    // getElementById returns the first match, so a duplicate id means a handler
    // silently wires itself to the wrong element.
    const seen = new Map();
    const dupes = [];
    for (const o of opens) {
      const id = idOf(o.attrs);
      if (!id) continue;
      if (seen.has(id)) dupes.push(`#${id} (lines ${seen.get(id)} and ${o.line})`);
      else seen.set(id, o.line);
    }
    check('no id appears twice', dupes.length === 0, dupes.join(', '));
  }

  // --- labelled dialogues ---------------------------------------------------
  {
    // A dialogue whose aria-labelledby points at nothing is announced with no
    // name at all, which is worse than having no attribute.
    const ids = new Set(opens.map((o) => idOf(o.attrs)).filter(Boolean));
    const broken = [];
    for (const o of opens) {
      for (const attr of ['aria-labelledby', 'aria-describedby', 'aria-controls']) {
        const v = (o.attrs.match(new RegExp(`\\b${attr}\\s*=\\s*"([^"]*)"`)) || [, ''])[1];
        for (const ref of v.split(/\s+/).filter(Boolean)) {
          if (!ids.has(ref)) broken.push(`line ${o.line}: ${attr}="${ref}"`);
        }
      }
    }
    check('every aria reference points at an element that exists', broken.length === 0,
      broken.join(', '));
  }

  return results;
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}`) {
  run();
}
