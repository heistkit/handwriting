/**
 * mascot.js — the ink drop looks at the pointer.
 *
 * Two properties reach CSS: `--look-x` and `--look-y`, each clamped to -1..1,
 * where 0,0 is the drop looking straight ahead. Everything visual is done in
 * the stylesheet from those two numbers; this file only measures.
 *
 * It only ever tracks the card in view. The other three are off screen, and
 * moving eyes nobody can see is work for nothing.
 *
 * Fine pointers only. On a touchscreen there is no cursor to follow, and
 * reacting to taps would mean the drop lurches whenever you scroll past it —
 * which is worse than it simply looking ahead.
 *
 * Reduced motion, lite mode and the decoration switch each stop it, and when
 * they do the eyes return to centre rather than freezing wherever they were.
 */

/** How far outside the card the pointer still counts, in card widths. */
const REACH = 1.6;

const prefersReduced = () =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

const suppressed = () => {
  const root = document.documentElement;
  return root.dataset.lite === 'on' || root.dataset.decor === 'off' || prefersReduced();
};

const canHover = () =>
  typeof matchMedia === 'function' && matchMedia('(hover: hover) and (pointer: fine)').matches;

const clamp = (n) => Math.max(-1, Math.min(1, n));

/**
 * @param {ParentNode} [root]
 * @returns {() => void} teardown
 */
export function mount(root = document) {
  const stages = [...root.querySelectorAll('.mascot__stage')];
  if (!stages.length || !canHover()) return () => {};

  const centre = (stage) => {
    stage.style.removeProperty('--look-x');
    stage.style.removeProperty('--look-y');
  };

  // Reading a rect per move would force layout on every pointer event, so they
  // are taken once and marked stale when something moves them, which is enough
  // for a thing whose whole job is to be approximately looking at you.
  //
  // Marked rather than re-read at the moment they move, because most of what
  // moves a card is scrolling, and scrolling arrives in bursts of dozens of
  // events. Setting a flag is free, and the one measurement that matters is the
  // one taken on the next pointer move, by which time the burst is over. A
  // reader who scrolls past this section without ever pointing at it pays
  // nothing at all.
  let boxes = [];
  let stale = true;
  const measure = () => {
    boxes = stages.map((stage) => ({ stage, r: stage.getBoundingClientRect() }));
    stale = false;
  };
  const invalidate = () => { stale = true; };

  const onMove = (event) => {
    if (suppressed()) { for (const s of stages) centre(s); return; }
    if (stale) measure();
    for (const { stage, r } of boxes) {
      if (!r.width) continue;
      // Only the card actually on screen. `.is-current` is set by stepshow.js.
      const card = stage.closest('.stepcard');
      if (card && !card.classList.contains('is-current')) { centre(stage); continue; }

      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      stage.style.setProperty('--look-x', clamp((event.clientX - cx) / (r.width * REACH)).toFixed(3));
      stage.style.setProperty('--look-y', clamp((event.clientY - cy) / (r.height * REACH)).toFixed(3));
    }
  };

  const onLeave = () => { for (const s of stages) centre(s); };

  addEventListener('pointermove', onMove, { passive: true });
  addEventListener('pointerleave', onLeave);
  addEventListener('blur', onLeave);
  /*
   * Capture, and this is the whole of it.
   *
   * A scroll event fired at an element does not bubble — only the one fired at
   * the document does. The step deck is its own scroll container: the cards
   * move sideways inside a track while the window itself never moves. So a
   * plain listener on the window heard nothing when the reader swiped the deck,
   * the cached rects went stale on the first swipe and stayed stale, and the
   * eyes carried on aiming at the place a card had been rather than at where it
   * is now.
   *
   * Capturing gets every scroller in the document, this one included, without
   * this module needing to know which elements happen to scroll — which matters
   * because the deck is not the mascot's business and should not have to be
   * named here. Hearing about scrollers that have nothing to do with a mascot
   * costs one assignment, since all that happens is a flag being set.
   */
  addEventListener('scroll', invalidate, { capture: true, passive: true });
  addEventListener('resize', invalidate);

  return () => {
    removeEventListener('pointermove', onMove);
    removeEventListener('pointerleave', onLeave);
    removeEventListener('blur', onLeave);
    // The capture flag is part of what identifies a listener; drop it here and
    // the scroll listener above outlives the teardown that was meant to remove
    // it.
    removeEventListener('scroll', invalidate, { capture: true });
    removeEventListener('resize', invalidate);
    for (const s of stages) centre(s);
  };
}
