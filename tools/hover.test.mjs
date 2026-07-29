/**
 * Every hover rule is scoped to a device that can hover.
 *
 * iOS Safari applies `:hover` on tap and leaves it applied until something else
 * takes focus. That is not a bug to work around so much as the only thing it
 * can do — the platform has no hover — but it means a rule written for a mouse
 * latches on a finger and stays latched while the reader scrolls away from it.
 *
 * The worse half of the same problem is a control that only *appears* on hover.
 * `opacity: 0` does not remove an element from hit testing, so a button revealed
 * by hover is, on a touch device, an invisible button that is fully tappable.
 * The redraw control on every glyph tile was exactly this: a transparent strip
 * across the bottom edge of each tile on the screen most used from a phone.
 *
 * The fix is a `data-pointer` attribute on <html> — guessed before first paint
 * in preflight.js, corrected from real pointer events in pointer.js — and every
 * hover rule scoped to it with `:where()`, which contributes no specificity and
 * so cannot reorder the cascade against the rules around it.
 *
 * This is the check that it stayed done. A stylesheet this size gets a new
 * `:hover` added without anyone thinking about phones, and the symptom on a
 * phone is not a broken page: it is a page that feels slightly haunted.
 *
 * Deliberately a scanner and not a CSS parser. It tracks nesting depth and
 * whether the enclosing at-rules include a hover query, which is all the two
 * properties here need, and a parser would be a dependency bought to make a
 * regex look official.
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass });
  console.log(`  ${pass ? 'ok  ' : 'FAIL'} ${name}${detail && !pass ? ` — ${detail}` : ''}`);
};

/** The scope that says "this device hovers". */
const SCOPED = /:where\(html\[data-pointer="fine"\]\)/;

/** An @media that has already established the same thing. */
const HOVER_QUERY = /\(\s*hover\s*:\s*hover\s*\)/;

/**
 * Rules that mention :hover but change nothing a finger could get stuck in.
 *
 * `cursor` is the clearest case: it styles a pointer that a touch device does
 * not have, so the rule is unreachable there rather than wrong. Scoping these
 * would be noise in the file and would suggest to the next reader that the
 * scope is a formality.
 */
const HARMLESS = /^\s*(cursor\s*:[^;]*;\s*)*$/;

/**
 * Walk the stylesheet, yielding every selector with the at-rules open above it.
 *
 * @returns {Array<{selector: string, body: string, at: string[], line: number}>}
 */
function rules(css) {
  const found = [];
  const at = [];        // the @media/@supports preludes currently open
  let buf = '';         // text since the last brace: a selector or a prelude
  let start = 0;        // index in `css` where `buf` began

  const lineAt = (i) => css.slice(0, i).split('\n').length;

  for (let i = 0; i < css.length; i += 1) {
    const c = css[i];

    // Comments and strings can both contain braces.
    if (c === '/' && css[i + 1] === '*') {
      const end = css.indexOf('*/', i + 2);
      i = end < 0 ? css.length : end + 1;
      continue;
    }
    if (c === '"' || c === "'") {
      const end = css.indexOf(c, i + 1);
      buf += css.slice(i, end < 0 ? css.length : end + 1);
      i = end < 0 ? css.length : end;
      continue;
    }

    if (c === '{') {
      const prelude = buf.trim();
      if (prelude.startsWith('@')) {
        at.push(prelude);
      } else {
        // Find the matching close so the body can be inspected. Nested at-rules
        // never appear inside a plain selector block in this file, so counting
        // braces from here is enough.
        let depth = 1;
        let j = i + 1;
        for (; j < css.length && depth; j += 1) {
          if (css[j] === '{') depth += 1;
          else if (css[j] === '}') depth -= 1;
        }
        found.push({
          selector: prelude,
          body: css.slice(i + 1, j - 1),
          at: at.slice(),
          line: lineAt(start),
        });
        i = j - 1;
      }
      buf = '';
      start = i + 1;
      continue;
    }

    if (c === '}') {
      if (at.length) at.pop();
      buf = '';
      start = i + 1;
      continue;
    }

    if (!buf) start = i;
    buf += c;
  }

  return found;
}

/** The checker, checked — a scanner that finds nothing reads exactly like a pass. */
function selfCheck() {
  const sample = `
    .a:hover { color: red; }
    @media (hover: hover) { .b:hover { color: red; } }
    :where(html[data-pointer="fine"]) .c:hover { color: red; }
    .d:hover { cursor: pointer; }
    /* .e:hover { color: red; } */
    .f::after { content: ":hover"; }
  `;
  const found = rules(sample);
  const offenders = found.filter(
    (r) => r.selector.includes(':hover')
      && !SCOPED.test(r.selector)
      && !r.at.some((a) => HOVER_QUERY.test(a))
      && !HARMLESS.test(r.body)
  );
  check('the scanner finds an ungated hover rule',
    offenders.length === 1 && offenders[0].selector.startsWith('.a'),
    offenders.map((o) => o.selector).join(' | '));
  check('the scanner accepts a rule inside @media (hover: hover)',
    !offenders.some((o) => o.selector.startsWith('.b')));
  check('the scanner accepts a :where()-scoped rule',
    !offenders.some((o) => o.selector.startsWith('.c')));
  check('the scanner ignores a cursor-only rule',
    !offenders.some((o) => o.selector.startsWith('.d')));
  check('the scanner ignores hover inside a comment',
    !offenders.some((o) => o.selector.includes('.e')));
  check('the scanner does not read a string as a selector',
    !offenders.some((o) => o.selector.startsWith('.f')));
}

export async function run() {
  console.log('\nstyles.css — hover');

  selfCheck();

  const here = dirname(fileURLToPath(import.meta.url));
  const css = await readFile(join(here, '..', 'styles.css'), 'utf8');
  const all = rules(css);

  check('the stylesheet parsed into rules', all.length > 500, `${all.length} rules`);

  const hovers = all.filter((r) => /:hover\b/.test(r.selector));
  check('and it still contains hover rules to check', hovers.length > 20,
    `${hovers.length} found`);

  const ungated = hovers.filter(
    (r) => !SCOPED.test(r.selector)
      && !r.at.some((a) => HOVER_QUERY.test(a))
      && !HARMLESS.test(r.body)
  );
  check('every hover rule is either inside @media (hover: hover) or scoped to a fine pointer',
    ungated.length === 0,
    ungated.map((r) => `line ${r.line}: ${r.selector.replace(/\s+/g, ' ').slice(0, 80)}`).join('\n      '));

  // --- the control that started this ----------------------------------------
  {
    // A reveal-on-hover control has to be inert while it is invisible, or it is
    // an invisible tap target. This is the property, not the rule: whichever way
    // the block is written, transparent and clickable must not co-occur.
    const redraw = all.filter((r) => /\.redraw\b/.test(r.selector));
    check('the redraw control still has rules', redraw.length > 0);

    const opacity = (body) => body.match(/(?:^|[;{\s])opacity\s*:\s*([\d.]+)/)?.[1];
    const events = (body) => body.match(/pointer-events\s*:\s*(\w+)/)?.[1];
    const bad = redraw.filter((r) => opacity(r.body) === '0' && events(r.body) === 'auto');
    check('and none of them is transparent and clickable at once', bad.length === 0,
      bad.map((r) => `line ${r.line}: ${r.selector}`).join(', '));

    const hidden = redraw.find((r) => opacity(r.body) === '0');
    check('the rule that hides it also takes it out of hit testing',
      !hidden || events(hidden.body) === 'none',
      hidden && `line ${hidden.line}: ${hidden.selector}`);

    // Scoping a reveal to pointer type strands the keyboard on any device the
    // guess calls coarse, so there has to be a focus route to it as well.
    check('and it is revealed by focus, on any device',
      redraw.some((r) => /:focus-visible|:focus-within/.test(r.selector)));
  }

  return results;
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}`) {
  run();
}
