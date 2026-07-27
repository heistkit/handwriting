/**
 * eggs.js — the things nobody asked for.
 *
 * Rules these follow, because an easter egg that breaks something is just a
 * bug with a nicer story:
 *
 *   Nothing here carries meaning. Every one is decoration on top of an
 *   interface that works identically without it, and none of them changes the
 *   font that gets built, the settings, or anything stored.
 *
 *   They honour the same switches as everything else. Reduced motion, lite
 *   mode and the decoration switch each turn all of this off, because someone
 *   who has asked for less movement did not mean "except for the fun bits".
 *
 *   The keyboard one never fires while you are typing. A listener on the
 *   document that reacts to letters will, sooner or later, eat a keystroke
 *   someone meant for a text field — so it checks what has focus first, and
 *   it ignores anything with a modifier held.
 *
 *   Nothing is announced. These are visual jokes; a screen reader being told
 *   "the mascot wobbled" is noise, so every element they touch is either
 *   already aria-hidden or left alone.
 */

const WORD = 'ink';

const prefersReduced = () =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

const suppressed = () => {
  const root = document.documentElement;
  return root.dataset.lite === 'on' || root.dataset.decor === 'off' || prefersReduced();
};

/** Whether a keystroke belongs to something the visitor is typing into. */
function typingInto(target) {
  if (!target) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

/**
 * Add a class, take it off again when its animation ends.
 *
 * Uses a timer rather than the animationend event on purpose: the event does
 * not fire in a tab that has stopped painting, which would leave the class on
 * forever and the egg would never fire a second time.
 */
function flash(el, cls, ms) {
  if (!el) return;
  el.classList.remove(cls);
  void el.offsetWidth;
  el.classList.add(cls);
  setTimeout(() => el.classList.remove(cls), ms);
}

/**
 * @param {{ specimen?: { replay?: () => void } }} [hooks]
 * @returns {() => void} teardown
 */
export function mount({ specimen } = {}) {
  const cleanups = [];

  // ── 1. Poke the mascot ────────────────────────────────────────────────
  // It squashes, springs back, and jumps to a new shape. The blob's own morph
  // is on an eleven-second loop, so without the shape kick a poke would often
  // land at a moment when nothing visibly changed.
  for (const stage of document.querySelectorAll('.mascot__stage')) {
    const poke = () => {
      if (suppressed()) return;
      flash(stage, 'is-poked', 700);
    };
    stage.addEventListener('pointerdown', poke);
    cleanups.push(() => stage.removeEventListener('pointerdown', poke));
  }

  // ── 2. Double-click the specimen to redraw it now ──────────────────────
  // The sheet redraws itself every so often anyway. This is for anyone who
  // watched half of it and wanted the rest.
  const spec = document.querySelector('.spec__sheet');
  if (spec && specimen?.replay) {
    const again = () => specimen.replay();
    spec.addEventListener('dblclick', again);
    cleanups.push(() => spec.removeEventListener('dblclick', again));
  }

  // ── 3. Type the word ──────────────────────────────────────────────────
  // Every ink drop on the page hops, and the sheet rewrites itself.
  let typed = '';
  const onKey = (event) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (typingInto(event.target)) return;
    if (event.key.length !== 1) return;

    typed = (typed + event.key.toLowerCase()).slice(-WORD.length);
    if (typed !== WORD) return;
    typed = '';
    if (suppressed()) return;

    for (const stage of document.querySelectorAll('.mascot__stage')) {
      flash(stage, 'is-delighted', 1100);
    }
    specimen?.replay?.();
  };
  document.addEventListener('keydown', onKey);
  cleanups.push(() => document.removeEventListener('keydown', onKey));

  return () => { for (const off of cleanups) off(); };
}
