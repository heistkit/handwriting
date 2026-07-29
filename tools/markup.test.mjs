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

    // <script> and friends: everything up to the matching close is text, so the
    // parser skips over it rather than reading `a < b` as a tag. The element is
    // popped off the stack because it has been consumed whole — but it stays in
    // `opens`, which is the record of what this document contains. Dropping it
    // from there too made every later check about scripts pass by finding
    // nothing to check, which is the failure mode a test file exists to avoid.
    if (RAW_TEXT.has(name)) {
      const end = blanked.indexOf(`</${name}`, tag.lastIndex);
      if (end >= 0) {
        skipTo = end;
        stack.pop();
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

  // --- nothing that would need 'unsafe-inline' ------------------------------
  {
    // The content-security policy says `script-src 'self'`, and the whole value
    // of that is `connect-src 'none'` beside it: an injected script cannot post
    // a photograph of someone's handwriting anywhere. Adding one inline
    // <script> back to this file does not break the page — it breaks silently,
    // by not running, and the fix a hurried reader reaches for is
    // 'unsafe-inline', which quietly returns the policy to decoration.
    //
    // So the rule is checked here rather than trusted: every script in this
    // document is external, and every one is same-origin.
    //
    // The structured-data block is the one exception, and it is not really an
    // exception: `type="application/ld+json"` is a *data block*. The parser
    // works out the type first and stops there for anything that is not
    // JavaScript, so the inline-script check in the policy is never reached and
    // there is nothing to execute if it were. It is JSON that happens to live
    // inside a script element, and it has to be inline — a crawler will not
    // follow a src to find it.
    const DATA_BLOCK = /\btype\s*=\s*"application\/ld\+json"/;
    const scripts = opens.filter((o) => o.tag === 'script');
    const executable = scripts.filter((o) => !DATA_BLOCK.test(o.attrs));
    const inline = executable.filter((o) => !/\bsrc\s*=/.test(o.attrs));
    check('no inline <script> survives in index.html', inline.length === 0,
      inline.map((o) => `line ${o.line}`).join(', '));

    // And the exception stays an exception: a data block that grew a src, or a
    // second one, is worth noticing rather than waving through.
    const data = scripts.filter((o) => DATA_BLOCK.test(o.attrs));
    check('the structured-data block is present, once', data.length === 1,
      `${data.length} found`);
    check('and carries its JSON inline rather than by src',
      data.every((o) => !/\bsrc\s*=/.test(o.attrs)));

    const srcOf = (attrs) => (attrs.match(/\bsrc\s*=\s*"([^"]*)"/) || [, ''])[1];
    const remote = scripts.map((o) => srcOf(o.attrs)).filter((s) => /^(https?:)?\/\//.test(s));
    check('every script is loaded from this origin', remote.length === 0, remote.join(', '));

    // The theme is applied before first paint, which only a *blocking* classic
    // script does. `defer` and `type="module"` both run after the parse, which
    // is exactly the flash preflight.js exists to prevent — and either would
    // pass the check above while quietly undoing the reason for the file.
    const preflight = scripts.find((o) => /preflight\.js/.test(srcOf(o.attrs)));
    check('the pre-paint script is still present', !!preflight);
    check('and still blocking, so it runs before first paint',
      preflight && !/\bdefer\b|\basync\b|type\s*=\s*"module"/.test(preflight.attrs),
      preflight?.attrs);
  }

  // --- the policy itself ----------------------------------------------------
  {
    const vercel = JSON.parse(await readFile(join(here, '..', 'vercel.json'), 'utf8'));
    const all = vercel.headers.find((h) => h.source === '/(.*)');
    const csp = all?.headers.find((h) => h.key === 'Content-Security-Policy')?.value ?? '';

    check('a content-security policy is served', !!csp);
    // Start from deny and enumerate. 'self' as the default would mean the next
    // directive nobody thought of silently permits same-origin loads.
    check("it starts from default-src 'none'", /default-src 'none'/.test(csp), csp);
    // The one that turns the README's headline into something a visitor can
    // check in their own devtools.
    check("it forbids every outbound connection", /connect-src 'none'/.test(csp), csp);
    check("scripts are same-origin only, with no 'unsafe-inline'",
      /script-src 'self'/.test(csp) && !/script-src[^;]*unsafe-inline/.test(csp), csp);
    check('and no unsafe-eval anywhere', !/unsafe-eval/.test(csp), csp);
    check('the page cannot be framed', /frame-ancestors 'none'/.test(csp), csp);
    check('and cannot have its base URL rewritten', /base-uri 'none'/.test(csp), csp);

    // The dev server serves this same string, read out of this same file, so
    // a policy that breaks the app breaks it in development too. Assert the
    // path it reads is still the path that exists.
    const serve = await readFile(join(here, 'serve.mjs'), 'utf8');
    check('the dev server serves the deployed policy rather than its own',
      /vercel\.json/.test(serve) && /content-security-policy/i.test(serve));
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
