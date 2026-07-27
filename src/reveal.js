/**
 * reveal.js — things arrive as you scroll to them.
 *
 * Three decisions worth stating, because each one is a way this pattern
 * usually goes wrong.
 *
 * It is opt-in from script, not from the stylesheet. The hidden state is
 * applied by adding a class to the root here, so a browser that never runs
 * this module — script blocked, module error, an old engine that trips on the
 * syntax — shows every element normally instead of a blank page. A stylesheet
 * that starts everything at `opacity: 0` and waits for JavaScript to rescue it
 * has made content availability depend on script, which is a bad trade for an
 * effect.
 *
 * It fires once. Re-animating on every pass makes a page feel like it is
 * fighting the scroll, and it punishes the one thing a reader does most, which
 * is scroll back to re-read something. Once an element has arrived it stays.
 *
 * It respects the two switches that exist for exactly this. Under lite mode or
 * `prefers-reduced-motion` nothing is hidden in the first place — the module
 * returns before touching anything, rather than hiding elements and then
 * animating them instantly, which would still flash.
 */

/** Selectors that get the treatment. Broad on purpose: "basically everything". */
const TARGETS = [
  '.band > .wrap > *',
  '.hero > *',
  '.step-head',
  '.card',
  '.paper',
  '.drop',
  '.review-bar',
  '.glyph',
  '.download-card',
  '.dl-item',
  '.code-wrap',
  '.finding',
  '.doc-result',
  '.lesson',
  '.setting',
  '.step-actions',
  // Not decoration: each of these carries a padlock that shuts as it arrives,
  // and the animation is driven off this element's own reveal state.
  '.privacy',
  '.footer-inner > *',
];

/** Elements this far apart are treated as one group for the stagger. */
const GROUP_GAP = 220;

const prefersReduced = () =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

const liteOn = () => document.documentElement.dataset.lite === 'on';

/**
 * Assign each element a stagger index from its position, so a row of four
 * cards comes in one after another rather than all at once, while a lone
 * heading further down the page starts from zero again.
 *
 * Done by geometry rather than by DOM order because the two disagree: a
 * sidebar's cards are siblings of the main column in the markup but sit in a
 * different visual group on screen, and the eye follows the screen.
 */
function stagger(elements) {
  const sorted = [...elements].sort((a, b) => a.__revealTop - b.__revealTop);
  let index = 0;
  let previous = null;

  for (const el of sorted) {
    if (previous !== null && el.__revealTop - previous > GROUP_GAP) index = 0;
    el.style.setProperty('--reveal-i', String(Math.min(index, 6)));
    previous = el.__revealTop;
    index += 1;
  }
}

/**
 * One observer for the whole page, not one per call.
 *
 * observe() is called again every time a step becomes active or a list
 * re-renders, and building a fresh IntersectionObserver each time would leave
 * the previous ones alive and still watching — the page would end up with a
 * dozen observers all firing on the same elements.
 */
let io = null;

function observer() {
  if (io) return io;
  io = new IntersectionObserver(
    (entries, self) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entry.target.dataset.reveal = 'in';
        self.unobserve(entry.target);
      }
    },
    // A little bottom inset so an element starts moving slightly before its top
    // edge clears the fold, and has finished by the time it is properly in
    // view. Waiting for the exact edge means the reader watches it animate.
    { rootMargin: '0px 0px -8% 0px', threshold: 0.01 }
  );
  return io;
}

/**
 * @param {ParentNode} [root] limit to a subtree — used when a step becomes
 *   active, so its content animates in rather than appearing already finished.
 *
 *   Not called after a list re-renders, which is why `.lesson`, `.doc-result`,
 *   `.dl-item` and `.finding` are in TARGETS but never actually animate: they
 *   are built after observe() has run, so they are never tagged, and an
 *   untagged element is simply visible. Harmless, and worth knowing before
 *   someone wonders why the download list arrives without the others.
 */
export function observe(root = document) {
  if (typeof IntersectionObserver !== 'function') return null;
  if (prefersReduced() || liteOn()) return null;

  document.documentElement.classList.add('reveal-ready');

  const pending = [];
  for (const sel of TARGETS) {
    for (const el of root.querySelectorAll(sel)) {
      // Already arrived — leave it alone. Anything still pending is measured
      // again, because an element inside a step that was display:none had no
      // position at all the first time round.
      if (el.dataset.reveal === 'in') continue;
      el.dataset.reveal = '';
      el.__revealTop = el.getBoundingClientRect().top + window.scrollY;
      pending.push(el);
    }
  }
  if (!pending.length) return io;

  stagger(pending);

  for (const el of pending) {
    // Anything already on screen is shown immediately. Animating what is
    // already visible is the classic version of this bug: the page loads, and
    // then its own content fades in underneath the reader's cursor.
    const r = el.getBoundingClientRect();
    const onScreen = r.height > 0 && r.top < innerHeight && r.bottom > 0;
    if (onScreen) el.dataset.reveal = 'in';
    else observer().observe(el);
  }

  return io;
}

/** Show everything at once and stop hiding anything new — for the lite switch. */
export function showAll() {
  document.documentElement.classList.remove('reveal-ready');
  for (const el of document.querySelectorAll('[data-reveal]')) el.dataset.reveal = 'in';
}
