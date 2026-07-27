/**
 * textsize.js — one lever for how large the whole interface is.
 *
 * The stylesheet drives every size from `--ui-scale` on the root, and the root
 * font-size from that, so raising it grows the type, the padding and the hit
 * targets together. Growing the text alone would give you large labels crammed
 * into unchanged buttons, which is worse than leaving it small.
 *
 * Two states, not three. Theme and lite mode both have an "unset" that follows
 * the system, because the system has an opinion about both — `prefers-color-
 * scheme` and `prefers-reduced-motion`. There is no equivalent signal for text
 * size that a page can read: the browser's own zoom and minimum-font-size
 * settings already apply on top of whatever this does, and are invisible to
 * script. Inventing a third state that follows nothing would be a lie.
 */

const KEY = 'handwrite.textsize';
const SIZES = ['normal', 'large'];

function safeRead() {
  try {
    const v = localStorage.getItem(KEY);
    return SIZES.includes(v) ? v : 'normal';
  } catch {
    return 'normal';
  }
}

function safeWrite(value) {
  try {
    if (value === 'large') localStorage.setItem(KEY, value);
    else localStorage.removeItem(KEY);
  } catch {
    /* private mode — the choice lasts for this tab */
  }
}

/** @returns {'normal'|'large'} */
export const current = () => safeRead();

export const isLarge = () => safeRead() === 'large';

/**
 * @param {'normal'|'large'} value
 * @returns {'normal'|'large'} what is now in effect
 */
export function apply(value) {
  const size = SIZES.includes(value) ? value : 'normal';
  const root = document.documentElement;

  if (size === 'large') root.dataset.textsize = 'large';
  else delete root.dataset.textsize;

  safeWrite(size);
  return size;
}

/**
 * Bind a checkbox. Checked means large.
 *
 * The control is a real `<input type="checkbox">` left in the accessibility
 * tree and in the tab order; the switch graphic is drawn from its state. Every
 * Uiverse switch pasted into this project hid its input with `display: none`,
 * which takes the control out of both.
 */
export function bindToggle(input) {
  if (!input) return;

  const sync = () => {
    input.checked = isLarge();
  };

  apply(current());
  sync();

  input.addEventListener('change', () => {
    apply(input.checked ? 'large' : 'normal');
    sync();
  });

  return { sync };
}
