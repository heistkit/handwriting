/**
 * specimen.js — replays the hero specimen after it has been still for a while.
 *
 * The drawing is pure CSS and runs itself once on load; this only re-triggers
 * it. That division matters: with this module absent, blocked, or erroring, the
 * sheet still draws itself once and then stays drawn, which is the state the
 * picture is about. Nothing here is load-bearing.
 *
 * Why not do the loop in CSS
 * --------------------------
 * `animation-delay` applies to the first iteration only, so an infinite
 * iteration count would run the cycles back to back with no pause — a hero that
 * never stops moving, which is the thing worth avoiding. Expressing the idle as
 * dead keyframe time instead would mean rewriting every one of the twenty-odd
 * animations as a percentage of one long shared duration, and their timings
 * would stop being readable as "the letters start at 0.95s".
 *
 * What it will not do
 * -------------------
 * Replay off screen, or in a background tab. An animation nobody is looking at
 * is pure battery, and this is decoration. It also re-checks the two motion
 * switches on every tick rather than only at startup, so turning them on mid-
 * session stops the loop rather than waiting for a reload.
 */

/** How long the full draw takes, from the sheet arriving to the last node. */
const RUN_MS = 5400;

/** Still, and readable, before it starts again. Long on purpose. */
const IDLE_MS = 9000;

/** The fade before a replay. Redrawing over a finished sheet would misread. */
const ERASE_MS = 620;

const prefersReduced = () =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

const suppressed = () => {
  const root = document.documentElement;
  return root.dataset.lite === 'on' || root.dataset.decor === 'off' || prefersReduced();
};

/**
 * @param {HTMLElement} el the `.spec` figure
 * @returns {() => void} stop
 */
export function loop(el) {
  if (!el) return () => {};

  let timer = null;
  let eraseTimer = null;
  let onScreen = true;
  let observer = null;

  const replay = () => {
    // Fade what is there before drawing over it. Without this the second pass
    // starts writing letters on top of letters that are already finished.
    el.classList.add('spec--erasing');
    eraseTimer = setTimeout(() => {
      el.classList.remove('spec--erasing');
      el.classList.remove('spec--play');
      // Reading a layout property between the two flushes the style change, so
      // the browser sees a removal and an addition rather than no change at
      // all — which is what actually restarts the animations.
      void el.offsetWidth;
      el.classList.add('spec--play');
    }, ERASE_MS);
  };

  const tick = () => {
    if (!suppressed() && onScreen && document.visibilityState === 'visible') replay();
    schedule();
  };

  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(tick, RUN_MS + IDLE_MS);
  }

  if (typeof IntersectionObserver === 'function') {
    observer = new IntersectionObserver(
      (entries) => { for (const e of entries) onScreen = e.isIntersecting; },
      { threshold: 0.25 }
    );
    observer.observe(el);
  }

  schedule();

  const stop = () => {
    clearTimeout(timer);
    clearTimeout(eraseTimer);
    observer?.disconnect();
    el.classList.remove('spec--erasing');
  };

  // Let something else ask for a redraw — a double-click on the sheet, or the
  // keyboard egg. It restarts the idle clock, so an on-demand replay does not
  // leave the automatic one about to fire a second later.
  stop.replay = () => {
    if (suppressed()) return;
    replay();
    schedule();
  };

  return stop;
}
