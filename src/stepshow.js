/**
 * stepshow.js — the four-step deck on the landing page.
 *
 * The deck is a scroll-snap track, which is the whole design decision. It means
 * the thing works completely with no script: every card is in the DOM, in
 * order, and you can swipe it on a phone, drag it on a trackpad, or Tab into
 * the track and use the arrow keys, because a scroll container is focusable
 * and the browser already knows how to scroll one. This module adds the
 * buttons and the dots on top of that, and if it never runs, nothing is lost
 * except the buttons — which are in the markup as `hidden` for exactly that
 * reason.
 *
 * What it deliberately does not do
 * --------------------------------
 * Advance by itself. A carousel that moves while you are reading it is taking
 * the page away from you, and this one carries instructions — the reader is
 * mid-sentence by definition. Everything here is driven by a press or a swipe.
 *
 * Position is read from scrollLeft rather than tracked in a variable, so a
 * swipe, a keyboard scroll, a button and a dot all agree without any of them
 * knowing about each other.
 */

const prefersReduced = () =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Smooth unless the reader has asked for less, in which case instant. */
const behaviour = () => (prefersReduced() ? 'instant' : 'smooth');

/**
 * @param {HTMLElement} root the `.stepshow`
 * @returns {() => void} teardown
 */
export function mount(root) {
  if (!root) return () => {};

  const track = root.querySelector('.stepshow__track');
  const cards = [...root.querySelectorAll('.stepcard')];
  const dots = [...root.querySelectorAll('[data-step-dot]')];
  const prev = root.querySelector('[data-step-nav="prev"]');
  const next = root.querySelector('[data-step-nav="next"]');
  if (!track || cards.length < 2) return () => {};

  // The controls are hidden in the markup and revealed here, so a reader with
  // no script never sees buttons that cannot do anything.
  root.querySelector('.stepshow__nav')?.removeAttribute('hidden');

  const current = () => {
    // Nearest card centre to the track's centre. Robust against a partial
    // swipe, an odd gap, and the last card never reaching the left edge.
    const mid = track.scrollLeft + track.clientWidth / 2;
    let best = 0;
    let bestGap = Infinity;
    cards.forEach((card, i) => {
      const centre = card.offsetLeft + card.offsetWidth / 2;
      const gap = Math.abs(centre - mid);
      if (gap < bestGap) { bestGap = gap; best = i; }
    });
    return best;
  };

  const goTo = (index) => {
    const card = cards[Math.max(0, Math.min(cards.length - 1, index))];
    if (!card) return;
    track.scrollTo({
      left: card.offsetLeft - (track.clientWidth - card.offsetWidth) / 2,
      behavior: behaviour(),
    });
  };

  const sync = () => {
    const i = current();
    cards.forEach((card, n) => card.classList.toggle('is-current', n === i));
    dots.forEach((dot, n) => {
      dot.setAttribute('aria-current', n === i ? 'step' : 'false');
      dot.tabIndex = n === i ? 0 : -1;
    });
    // Disabled rather than wrapping. Wrapping a four-item list of *ordered
    // instructions* means step 4 leads back to step 1, which is a lie about the
    // process the cards describe.
    if (prev) prev.disabled = i === 0;
    if (next) next.disabled = i === cards.length - 1;
  };

  let frame = null;
  const onScroll = () => {
    if (frame !== null) return;
    frame = requestAnimationFrame(() => { frame = null; sync(); });
  };

  const onKey = (event) => {
    const i = current();
    if (event.key === 'ArrowRight') { goTo(i + 1); event.preventDefault(); }
    else if (event.key === 'ArrowLeft') { goTo(i - 1); event.preventDefault(); }
    else if (event.key === 'Home') { goTo(0); event.preventDefault(); }
    else if (event.key === 'End') { goTo(cards.length - 1); event.preventDefault(); }
  };

  track.addEventListener('scroll', onScroll, { passive: true });
  track.addEventListener('keydown', onKey);
  prev?.addEventListener('click', () => goTo(current() - 1));
  next?.addEventListener('click', () => goTo(current() + 1));
  dots.forEach((dot, n) => dot.addEventListener('click', () => goTo(n)));

  sync();

  return () => {
    track.removeEventListener('scroll', onScroll);
    track.removeEventListener('keydown', onKey);
    if (frame !== null) cancelAnimationFrame(frame);
  };
}
