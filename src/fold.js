/**
 * fold.js — <details> that open and close like paper instead of snapping.
 *
 * Why this is not CSS
 * -------------------
 * A <details> element hides its own content when closed, and there is no
 * height to transition from — `auto` is not an animatable value, and the
 * browser removes the subtree from rendering entirely. The CSS-only answers
 * all have a catch: `grid-template-rows: 0fr → 1fr` needs a wrapper and still
 * fights `content-visibility`, and `interpolate-size` with `::details-content`
 * is the right answer but not yet everywhere this app runs.
 *
 * So the toggle is intercepted, the height is measured, and the Web Animations
 * API does the rest. Roughly twenty lines, and it works the same everywhere.
 *
 * What it will not do
 * -------------------
 * It never leaves content unreachable. Every failure path — the setting off,
 * reduced motion, no `animate()`, an exception mid-flight — ends with the
 * native <details> behaviour intact and `open` correct. The animation is a
 * layer on top of a control that already works; it is never load-bearing.
 *
 * Wrapping is done here rather than in the markup so that any <details>
 * anywhere in the app gets this for free, including ones built at runtime.
 */

const DURATION = 380;
const EASE = 'cubic-bezier(.22, .68, .36, 1)';

const prefersReduced = () =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/** The two ways a visitor can ask for this to stop. */
const suppressed = () => {
  const root = document.documentElement;
  return root.dataset.lite === 'on' || root.dataset.fold === 'off' || prefersReduced();
};

const canAnimate = () => typeof Element !== 'undefined' && typeof Element.prototype.animate === 'function';

/**
 * Move everything after the <summary> into one element, so there is a single
 * box to give a height to.
 */
function bodyOf(details, summary) {
  const existing = details.querySelector(':scope > .fold-body');
  if (existing) return existing;

  const body = document.createElement('div');
  body.className = 'fold-body';
  const rest = [...details.childNodes].filter((n) => n !== summary);
  if (!rest.length) return null;
  body.append(...rest);
  details.append(body);
  return body;
}

function wire(details) {
  const summary = details.querySelector(':scope > summary');
  if (!summary) return;
  const body = bodyOf(details, summary);
  if (!body) return;

  details.dataset.fold = 'ready';
  let running = null;

  const settle = () => {
    body.style.height = '';
    body.style.overflow = '';
    body.style.opacity = '';
    running = null;
  };

  summary.addEventListener('click', (event) => {
    // Let a link or button inside the summary do its own job.
    if (event.target.closest('a, button:not(summary)')) return;
    if (suppressed() || !canAnimate()) return; // native behaviour, unchanged

    event.preventDefault();
    running?.cancel();

    const opening = !details.open;
    // Measured with the element open in both directions: closing has to know
    // the height it is leaving, and it is still open at that moment.
    if (opening) details.open = true;
    const height = body.scrollHeight;

    body.style.overflow = 'hidden';
    // The perspective is written into the transform rather than onto an
    // ancestor, because these live inside a dozen containers that know nothing
    // about this and should not have to.
    // 18 degrees was enough to read as tipping rather than opening once several
    // of these were on screen at once. Halved.
    const shut = { height: '0px', opacity: 0, transform: 'perspective(900px) rotateX(-9deg)' };
    const full = { height: `${height}px`, opacity: 1, transform: 'perspective(900px) rotateX(0deg)' };

    let anim;
    try {
      anim = body.animate(opening ? [shut, full] : [full, shut], {
        duration: DURATION,
        easing: EASE,
      });
    } catch {
      // No animation, but the state must still change.
      details.open = opening;
      settle();
      return;
    }
    running = anim;

    // `finished`, not the 'finish' event. The event is dispatched from the
    // rendering loop's "update animations and send events" step, so a tab that
    // stops painting — backgrounded, or an ancestor hidden mid-flight — never
    // receives it, and the panel would be left stuck open with `overflow:
    // hidden` and no way back. The promise settles regardless.
    anim.finished.then(
      () => {
        // A second click already superseded this one; it owns `open` now.
        if (running !== anim) return;
        if (!opening) details.open = false;
        settle();
      },
      () => {
        // Cancelled. Only the inline styles need unwinding — `open` belongs to
        // whichever click cancelled this.
        if (running === anim) running = null;
        body.style.height = '';
        body.style.overflow = '';
        body.style.opacity = '';
      }
    );
  });
}

/**
 * @param {ParentNode} [root] limit to a subtree, for content built at runtime
 */
export function enhance(root = document) {
  for (const d of root.querySelectorAll('details:not([data-fold])')) {
    try {
      wire(d);
    } catch {
      /* one bad element must not stop the rest */
    }
  }
}
