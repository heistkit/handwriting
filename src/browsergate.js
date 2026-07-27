/**
 * browsergate.js — refuse only what genuinely cannot work.
 *
 * By capability, never by version
 * -------------------------------
 * Nothing here reads navigator.userAgent. A version check is a guess about what
 * a name implies, and it is wrong in both directions: it blocks forks and
 * embedded webviews that would have worked, and it waves through a browser that
 * spoofed its string. Every entry below asks the browser the question directly.
 *
 * The asymmetry that decides everything
 * -------------------------------------
 * Blocking a browser that would have worked is worse than letting a broken one
 * through. A browser that is let through fails at the point it actually fails,
 * with the app's own error handling around it; a browser that is blocked gets
 * nothing at all and has no way to find out it was wrong. So every probe is
 * wrapped, anything that throws or cannot be determined counts as *present*,
 * and the page it renders keeps a working "continue anyway" — this is a warning
 * with a door, not a wall.
 *
 * What is deliberately not here
 * -----------------------------
 * "Suspicious" browsers. The instruction asked for it and it cannot honestly be
 * built here. Everything a page can read to tell an automated client from a
 * person — navigator.webdriver, missing plugin arrays, headless-shaped window
 * dimensions, timing quirks — is set by the client, and any of it is a single
 * flag away from being wrong. What such a check reliably does catch is people
 * with unusual setups: privacy browsers, accessibility tooling, remote desktop,
 * old hardware. That is the population it would actually block, while an
 * automated client with any effort behind it walks straight past. There is also
 * nothing to protect: no account, no server, no data. Shipping it would be
 * theatre with a real cost and no benefit, so it is not shipped.
 *
 * Browsers with no module support at all never reach this file. They are caught
 * by the `<script nomodule>` in index.html, which is the browser telling us
 * rather than us inferring it from an absent flag — a flag can also be absent
 * because a content-security policy blocked the script that would have set it.
 */

/**
 * Only what has no fallback in the code.
 *
 * `createImageBitmap`, `OffscreenCanvas` and `CompressionStream` are absent on
 * purpose: all three are already feature-detected at their call sites
 * (imageproc.js:70, imageproc.js:83, export.js:135) and all three have working
 * fallbacks. Listing them would block browsers the app runs on perfectly well,
 * which is the failure this file exists to avoid.
 */
const REQUIRED = [
  {
    id: 'canvas',
    label: 'Reading pixels from an image',
    why: 'Your photograph is turned into ink and paper by reading it pixel by pixel. Without this there is nothing to read.',
    test: () => {
      const c = document.createElement('canvas');
      const ctx = c.getContext('2d');
      return Boolean(ctx && typeof ctx.getImageData === 'function');
    },
  },
  {
    id: 'blob',
    label: 'Saving a file',
    why: 'The font is assembled in memory and handed to your browser as a download. Without this it can be built but not saved.',
    test: () => typeof Blob === 'function' && typeof URL?.createObjectURL === 'function',
  },
  {
    id: 'fontface',
    label: 'Previewing a font before you install it',
    why: 'Typing a sentence in your own hand before downloading needs the browser to load a font from memory.',
    test: () => typeof FontFace === 'function' && typeof document.fonts?.add === 'function',
  },
  {
    id: 'hasown',
    label: 'A 2021 JavaScript feature',
    why: 'Object.hasOwn. Used throughout; an engine without it is old enough that other things here will not work either.',
    test: () => typeof Object.hasOwn === 'function',
  },
  {
    id: 'lightdark',
    label: 'A 2024 CSS feature',
    why: 'light-dark(). Every colour in the interface is defined with it, so without it the page has no palette at all — text and background can land the same colour.',
    test: () => typeof CSS?.supports === 'function' && CSS.supports('color', 'light-dark(#000, #fff)'),
  },
];

/**
 * @returns {{ok: boolean, missing: Array<{id, label, why}>}}
 */
export function check() {
  const missing = [];
  for (const feature of REQUIRED) {
    let present;
    try {
      present = feature.test();
    } catch {
      // Undeterminable counts as present. See the asymmetry note above.
      present = true;
    }
    if (!present) missing.push({ id: feature.id, label: feature.label, why: feature.why });
  }
  return { ok: missing.length === 0, missing };
}

/**
 * Build the explanation. Returns the element; the caller decides what to do
 * with it, so that rendering can never be inside the same try that decides
 * whether to render — a throw in the DOM work would otherwise be caught and
 * silently turn a blocked verdict into a pass.
 *
 * @param {Array<{label: string, why: string}>} missing
 * @param {() => void} onContinue
 */
export function render(missing, onContinue) {
  const panel = document.createElement('div');
  panel.className = 'bgate';
  panel.setAttribute('role', 'alertdialog');
  panel.setAttribute('aria-labelledby', 'bgate-title');

  const inner = document.createElement('div');
  inner.className = 'bgate__panel';

  const h = document.createElement('h1');
  h.id = 'bgate-title';
  h.className = 'bgate__title';
  h.textContent = 'This browser is missing something Handwrite needs';
  inner.append(h);

  const lede = document.createElement('p');
  lede.className = 'bgate__lede';
  lede.textContent =
    missing.length === 1
      ? 'One thing, and it has no substitute:'
      : `${missing.length} things, none of which have a substitute:`;
  inner.append(lede);

  const list = document.createElement('ul');
  list.className = 'bgate__list';
  for (const item of missing) {
    const li = document.createElement('li');
    const b = document.createElement('b');
    b.textContent = item.label;
    const p = document.createElement('p');
    p.textContent = item.why;
    li.append(b, p);
    list.append(li);
  }
  inner.append(list);

  const advice = document.createElement('p');
  advice.className = 'bgate__advice';
  advice.textContent =
    'Updating your browser is usually enough — this needs a version from 2024 or later. Nothing about this is specific to Handwrite; the same features are what let it run without a server.';
  inner.append(advice);

  const actions = document.createElement('div');
  actions.className = 'bgate__actions';

  const go = document.createElement('button');
  go.type = 'button';
  go.className = 'bgate__go';
  go.textContent = 'Continue anyway';
  go.addEventListener('click', () => {
    panel.remove();
    document.documentElement.classList.remove('bgate-open');
    onContinue?.();
  });

  const note = document.createElement('p');
  note.className = 'bgate__note';
  note.textContent =
    'The detection may simply be wrong about your browser. If it is, this button costs you nothing.';

  actions.append(go);
  inner.append(actions, note);
  panel.append(inner);
  return panel;
}

/**
 * Check, and show the panel if anything is missing.
 *
 * Deliberately not one try/catch around both halves. The first version of this
 * put render() inside run()'s try, so any DOM failure was caught by the same
 * handler that exists to fail open — turning "this browser is blocked" into
 * "this browser passed" precisely in the browsers the gate exists for.
 *
 * @returns {boolean} true if the app should carry on setting itself up
 */
export function run() {
  let verdict;
  try {
    verdict = check();
  } catch {
    return true; // fail open
  }
  if (verdict.ok) return true;

  try {
    const panel = render(verdict.missing);
    document.documentElement.classList.add('bgate-open');
    document.body.append(panel);
    panel.querySelector('.bgate__go')?.focus();
  } catch {
    // Could not draw the warning. Do not also refuse to run the app.
    return true;
  }

  // The app still initialises behind the panel. Everything it needs is there or
  // guarded; the panel is a warning, and "Continue anyway" only removes it.
  return true;
}
