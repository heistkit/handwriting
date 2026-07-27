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

const KEY = 'handwrite.lite';

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

/**
 * The last explicit choice made in this tab.
 *
 * Storage is the durable record of a choice, and the only one that survives a
 * reload — but when it cannot be written, `chosen()` answered null forever, and
 * null means "following the system". So a reader who had explicitly turned lite
 * mode off would have that choice thrown away the moment their system's
 * reduced-motion setting changed, because the listener below only defers to the
 * system when nothing was chosen.
 */
let chosenThisTab = null;

/** What the visitor explicitly chose, or null if they are following the system. */
export const chosen = () => safeRead() ?? chosenThisTab;

/**
 * Whether lite is actually in effect right now.
 *
 * The attribute the page is wearing comes first, and storage second, because
 * storage is not always writable and this question has to be answerable
 * anyway. In Chrome with "block all cookies", in Safari private browsing, or
 * in a sandboxed iframe, `safeWrite` swallows the failure and `safeRead` keeps
 * returning null — so an answer taken from storage alone reported "off" no
 * matter what had just been applied.
 *
 * That made the switch a one-way door. Press it: `isOn()` is false, so
 * `apply('on')` runs, the page really does strip its ornament — and then the
 * control re-reads storage, still finds nothing, and labels itself "off". Press
 * it again to undo, and because `isOn()` is *still* false it evaluates to
 * `apply('on')` a second time. Lite mode goes on and can never come off, while
 * the button insists it was never on.
 *
 * `apply()` is what sets the attribute, and it sets it for the reduced-motion
 * case too, so reading it here also covers someone who chose nothing and whose
 * system asked for less motion. flourish.js already works this way, which is
 * why its switches survive the same environment.
 */
export function isOn() {
  const worn = document?.documentElement?.dataset?.lite;
  if (worn === 'on' || worn === 'off') return worn === 'on';
  const pick = safeRead();
  if (pick) return pick === 'on';
  return Boolean(motionQuery()?.matches);
}

/**
 * @param {'on'|'off'|null} value  null hands control back to the system
 */
export function apply(value) {
  const root = document.documentElement;
  chosenThisTab = value === 'on' || value === 'off' ? value : null;
  if (value === 'on' || value === 'off') root.dataset.lite = value;
  else delete root.dataset.lite;

  safeWrite(value);

  // The attribute must reflect what is *in effect*, not what was chosen, or
  // the CSS would miss the reduced-motion case where nothing was chosen.
  if (!value && isOn()) root.dataset.lite = 'on';
  return isOn();
}

/**
 * Bind a checkbox instead of a button — the Settings row.
 *
 * Kept separate from bindToggle rather than sniffing the element's type,
 * because the two controls differ in more than markup: a button reports state
 * through `aria-pressed` and its own label, a checkbox through `checked`.
 * Guessing which one you were handed is how a control ends up announcing
 * nothing.
 */
export function bindCheckbox(input) {
  if (!input) return;

  const sync = () => {
    input.checked = isOn();
  };

  apply(chosen());
  sync();

  input.addEventListener('change', () => {
    apply(input.checked ? 'on' : 'off');
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
