/**
 * lite.js — a switch that strips the decoration.
 *
 * The interface carries a fair amount of ornament: rotating conic gradients,
 * blurred glows, backdrop filters, a three-ring loader, a per-letter wave. All
 * of it is cheap on a recent laptop and none of it is cheap on a six-year-old
 * phone doing image processing at the same time — which is exactly what this
 * app asks a phone to do.
 *
 * Scope is presentation only. It does not reduce tracing precision, variant
 * count or kerning. A setting called "lite" that quietly produced a worse font
 * would be a trap, because the user cannot see that difference until after
 * they have installed the thing.
 *
 * Three states, like the theme: on, off, or unset. Unset follows
 * prefers-reduced-motion, so someone who has already asked their system for
 * less motion does not have to ask again here.
 */

const KEY = 'inkwell.lite';

function safeRead() {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'on' || v === 'off' ? v : null;
  } catch {
    return null;
  }
}

function safeWrite(value) {
  try {
    if (value) localStorage.setItem(KEY, value);
    else localStorage.removeItem(KEY);
  } catch {
    /* private mode — the choice lasts for this tab */
  }
}

const motionQuery = () =>
  typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;

/** What the visitor explicitly chose, or null if they are following the system. */
export const chosen = () => safeRead();

/** Whether lite is actually in effect right now. */
export function isOn() {
  const pick = safeRead();
  if (pick) return pick === 'on';
  return Boolean(motionQuery()?.matches);
}

/**
 * @param {'on'|'off'|null} value  null hands control back to the system
 */
export function apply(value) {
  const root = document.documentElement;
  if (value === 'on' || value === 'off') root.dataset.lite = value;
  else delete root.dataset.lite;

  safeWrite(value);

  // The attribute must reflect what is *in effect*, not what was chosen, or
  // the CSS would miss the reduced-motion case where nothing was chosen.
  if (!value && isOn()) root.dataset.lite = 'on';
  return isOn();
}

export function bindToggle(button) {
  if (!button) return;

  const sync = () => {
    const on = isOn();
    button.setAttribute('aria-pressed', String(on));
    button.textContent = on ? 'Lite mode: on' : 'Lite mode';
  };

  apply(chosen());
  sync();

  button.addEventListener('click', () => {
    apply(isOn() ? 'off' : 'on');
    sync();
  });

  motionQuery()?.addEventListener?.('change', () => {
    if (!chosen()) {
      apply(null);
      sync();
    }
  });

  return { sync };
}
