/**
 * theme.js — light/dark preference.
 *
 * Three states, not two. The visitor can pick light, pick dark, or pick
 * nothing — and "nothing" is the default, meaning the operating system decides
 * and keeps deciding. A toggle that silently pins the theme on first render
 * would break the case where someone's machine switches at sunset.
 *
 * The switch itself only ever writes 'light' or 'dark'. Clearing site data
 * returns the visitor to following the system, which is also what the privacy
 * page tells them.
 *
 * Applying the class is done in two places on purpose:
 *
 *   - a tiny inline script in <head>, which runs before first paint so the
 *     page never flashes the wrong theme
 *   - this module, which owns everything afterwards
 *
 * The inline copy is deliberately duplicated rather than imported: a module
 * import is deferred, and deferred is exactly what causes the flash.
 */

const KEY = 'handwrite.theme';

/** Background colours matching --bg in each palette, for the browser chrome. */
const CHROME = { light: '#fcfcfd', dark: '#14161a' };

function safeRead() {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : null;
  } catch {
    return null;
  }
}

function safeWrite(value) {
  try {
    if (value) localStorage.setItem(KEY, value);
    else localStorage.removeItem(KEY);
  } catch {
    /* private mode — the choice simply lasts for this tab */
  }
}

const systemQuery = () =>
  typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: light)') : null;

/** What the visitor explicitly chose, or null if they are following the system. */
export const chosen = () => safeRead();

/** What is actually on screen right now. */
export function resolved() {
  const pick = safeRead();
  if (pick) return pick;
  return systemQuery()?.matches ? 'light' : 'dark';
}

/**
 * @param {'light'|'dark'|null} theme  null hands control back to the system
 */
export function apply(theme) {
  const root = document.documentElement;
  if (theme === 'light' || theme === 'dark') root.dataset.theme = theme;
  else delete root.dataset.theme;

  safeWrite(theme);

  // Keep the browser's own chrome (address bar, notch) in step with the page.
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', CHROME[resolved()]);
}

/**
 * Bind the toggle. `checked` means dark, matching the control's own imagery —
 * the moon slides in when it is on.
 *
 * @param {HTMLInputElement} checkbox
 */
export function bindToggle(checkbox) {
  if (!checkbox) return;

  const sync = () => {
    checkbox.checked = resolved() === 'dark';
  };
  sync();
  apply(chosen()); // normalises the meta colour on first load

  checkbox.addEventListener('change', () => {
    apply(checkbox.checked ? 'dark' : 'light');
  });

  // While no explicit choice has been made, keep following the system. Without
  // this, a machine that switches at sunset would leave the toggle showing the
  // wrong state until the next reload.
  const q = systemQuery();
  q?.addEventListener?.('change', () => {
    if (!chosen()) sync();
  });

  return { sync };
}

/**
 * Bind the three-way control: System, Light, Dark.
 *
 * The switch this replaces could express two of the three states the module has
 * always had. Off meant light — it wrote 'light' — while the label beside it
 * said Off followed the system, so the one state you could not get back to was
 * the default, and the sentence describing it was false. `apply(null)` was
 * exported and reachable from nothing.
 *
 * Buttons rather than radios: this is the same segmented control the Refine step
 * uses for Regular/Bold/Italic, and a reader who has met it there already knows
 * what it does. The group is labelled by the text above it, and the current
 * choice is announced through aria-pressed rather than through the class that
 * paints it.
 *
 * @param {HTMLElement} group  the .seg container
 * @returns {{sync(): void}|undefined}
 */
export function bindChoice(group) {
  if (!group) return;

  const buttons = [...group.querySelectorAll('[data-theme-choice]')];
  if (!buttons.length) return;

  const sync = () => {
    const current = chosen() ?? 'system';
    for (const b of buttons) {
      const on = b.dataset.themeChoice === current;
      b.classList.toggle('is-on', on);
      b.setAttribute('aria-pressed', String(on));
    }
  };

  for (const b of buttons) {
    b.addEventListener('click', () => {
      const pick = b.dataset.themeChoice;
      apply(pick === 'system' ? null : pick);
      sync();
      // The header switch reads the resolved theme, which System can change
      // without this control knowing which way it went.
      group.dispatchEvent(new CustomEvent('themechange', { bubbles: true }));
    });
  }

  sync();

  // While System is selected, a machine that switches at sunset has to be
  // followed. Nothing about this control changes — it still says System — but
  // the page around it does, and the header switch has to be told.
  systemQuery()?.addEventListener?.('change', () => {
    if (!chosen()) {
      apply(null);
      group.dispatchEvent(new CustomEvent('themechange', { bubbles: true }));
    }
  });

  return { sync };
}

/** Forget the choice and follow the system again. */
export function clear() {
  apply(null);
}
