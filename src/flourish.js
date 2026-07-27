/**
 * flourish.js — switches for the decoration that was added last, so it can be
 * taken away without an edit.
 *
 * Lite mode already exists and already strips everything. This is finer than
 * that, and it exists for a different reason: lite mode is about a slow device,
 * and these are about taste. Someone on a fast machine who finds the page too
 * busy should not have to turn off blurs and backdrop filters to stop the
 * accordions from unfolding.
 *
 *   fold   the open/close animation on every <details>, and the unfold
 *          entrances on cards, rows and dialogs
 *   decor  the ambient artwork: the specimen that writes itself, the trace
 *          under the brand, the padlock, the hover flourishes
 *
 * Both default to on and are stored as an explicit 'on'/'off' — there is no
 * third "follow the system" state here, because the system preference that
 * would drive it is prefers-reduced-motion, and that is already honoured
 * unconditionally by every animation in the sheet. A visitor who has asked for
 * reduced motion gets none of this regardless of what these say.
 *
 * The attribute is only written when the answer is 'off'. Absence means on,
 * which keeps the default working for anyone whose storage is unreadable and
 * keeps the CSS selectors negative — `:root:not([data-fold='off'])` — so a
 * missing module cannot switch the decoration off by accident.
 */

const SWITCHES = {
  fold: { key: 'handwrite.fold', attr: 'fold' },
  decor: { key: 'handwrite.decor', attr: 'decor' },
};

/** @param {'fold'|'decor'} name */
export function isOn(name) {
  const spec = SWITCHES[name];
  if (!spec) return true;
  try {
    return localStorage.getItem(spec.key) !== 'off';
  } catch {
    return true;
  }
}

/**
 * @param {'fold'|'decor'} name
 * @param {boolean} on
 */
export function apply(name, on) {
  const spec = SWITCHES[name];
  if (!spec) return;

  const root = document.documentElement;
  if (on) delete root.dataset[spec.attr];
  else root.dataset[spec.attr] = 'off';

  try {
    if (on) localStorage.removeItem(spec.key);
    else localStorage.setItem(spec.key, 'off');
  } catch {
    /* private mode — the choice lasts for this tab */
  }
}

/** Put the stored answers on the root. Also done inline in <head>, pre-paint. */
export function init() {
  for (const name of Object.keys(SWITCHES)) apply(name, isOn(name));
}

/**
 * @param {'fold'|'decor'} name
 * @param {HTMLInputElement} checkbox  checked means on
 */
export function bindToggle(name, checkbox) {
  if (!checkbox) return;
  checkbox.checked = isOn(name);
  checkbox.addEventListener('change', () => apply(name, checkbox.checked));
}

/** What is held, for the feedback report and the privacy page. */
export function summary() {
  return Object.keys(SWITCHES).map((name) => ({ name, on: isOn(name) }));
}
