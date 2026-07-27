/**
 * slider.js — keeps every range input's fill in step with its value.
 *
 * Why this exists at all
 * ----------------------
 * The filled track used to be done entirely in CSS, by two different tricks in
 * two different engines: WebKit got a zero-width thumb casting a 240px
 * one-sided box-shadow, clipped by `overflow: hidden` on the input; Firefox got
 * `::-moz-range-progress`, which does it natively.
 *
 * That worked, and cost two things. The `overflow: hidden` clips *any* shadow
 * on the thumb, so a visible thumb with a halo around it was impossible — which
 * is why the control had no grab handle at all, only a fill boundary. And the
 * two engines needed separate code that could drift apart.
 *
 * Painting the fill as a background gradient sized from a custom property
 * removes both problems: one declaration for every engine, no clipping, and a
 * real thumb. The cost is this file — a value has to reach CSS somehow.
 *
 * It is not load-bearing. With this module absent the track renders at whatever
 * `--fill` defaults to and the slider still works perfectly: dragging it still
 * moves the thumb and still changes the setting, because that is the browser's
 * job and not ours. Only the coloured portion would stop tracking.
 */

/** @param {HTMLInputElement} input */
function paint(input) {
  const min = Number(input.min === '' ? 0 : input.min);
  const max = Number(input.max === '' ? 100 : input.max);
  const value = Number(input.value);
  // A zero-width range is a legitimate thing to build (a single-option
  // control), and dividing by it would put NaN into the gradient, which drops
  // the whole background and leaves no track at all.
  const span = max - min;
  const pct = span > 0 ? ((value - min) / span) * 100 : 0;
  input.style.setProperty('--fill', `${Math.max(0, Math.min(100, pct))}%`);
}

/**
 * @param {ParentNode} [root] limit to a subtree
 * @returns {() => void} teardown
 */
export function mount(root = document) {
  const bound = [];
  for (const input of root.querySelectorAll('input[type=range]')) {
    const onInput = () => paint(input);
    paint(input);
    // `input` rather than `change`: the fill has to follow the thumb while it
    // is being dragged, not catch up when it is released.
    input.addEventListener('input', onInput);
    bound.push(() => input.removeEventListener('input', onInput));
  }
  return () => { for (const off of bound) off(); };
}

/** Repaint one control after something else has set its value. */
export { paint as refresh };
