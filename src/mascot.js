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

  // Reading a rect per move would force layout on every pointer event. They are
  // taken once, refreshed when the page moves under them, and that is enough
  // for something whose whole job is to be approximately looking at you.
  let boxes = [];
  const measure = () => {
    boxes = stages.map((stage) => ({ stage, r: stage.getBoundingClientRect() }));
  };

  const onMove = (event) => {
    if (suppressed()) { for (const s of stages) centre(s); return; }
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

  measure();
  addEventListener('pointermove', onMove, { passive: true });
  addEventListener('pointerleave', onLeave);
  addEventListener('blur', onLeave);
  addEventListener('scroll', measure, { passive: true });
  addEventListener('resize', measure);

  return () => {
    removeEventListener('pointermove', onMove);
    removeEventListener('pointerleave', onLeave);
    removeEventListener('blur', onLeave);
    removeEventListener('scroll', measure);
    removeEventListener('resize', measure);
    for (const s of stages) centre(s);
  };
}
