/**
 * celebrate.js — the moments worth making a noise about.
 *
 * The drop-off in this app is not where anything is difficult. It is where
 * somebody has done real work — filled a sheet by hand, held a camera steady,
 * checked a hundred and twelve characters — and the screen replies by quietly
 * enabling the next button. Nothing has told them it went well, so the natural
 * reading is that it did not, and the tab closes.
 *
 * So the milestones are marked, out loud. Three of them, in the order they
 * happen: the sheet came back readable, the characters are yours, the font
 * exists. The third gets the largest one, because it is the one where somebody
 * has a thing they did not have before.
 *
 * Ink, not confetti
 * -----------------
 * The marks thrown are the app's own subject — flecks of ink off a pen, in the
 * accent colour, at the sizes and angles a nib actually throws. Coloured
 * confetti on a monochrome page would be the one saturated thing in the
 * product, and it would be saturated for a party rather than for a warning,
 * which is the opposite of what the palette reserves colour for.
 *
 * Cost
 * ----
 * Plain elements with two keyframes each, removed on `animationend` and again
 * on a timer in case that never fires — a background tab throttles animations
 * and can drop the event, and a burst that never cleans up is a burst that
 * accumulates every time you come back to the tab.
 *
 * Nothing here is load-bearing. Every function no-ops under reduced motion,
 * lite mode or the decoration switch, and the app is expected to say the same
 * thing in words regardless: a celebration nobody can see must not be the only
 * place the good news lives.
 */

/** How many flecks each size throws. */
const SIZES = { small: 14, large: 34 };

/** Longest a fleck can be in flight, for the cleanup fallback. */
const LIFETIME = 1400;

const prefersReduced = () =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

const suppressed = () => {
  const root = document.documentElement;
  return root.dataset.lite === 'on' || root.dataset.decor === 'off' || prefersReduced();
};

/**
 * Deterministic-ish spread without Math.random being the only thing deciding.
 *
 * A pure random spread clumps — three flecks on top of each other and a gap
 * where the eye expects one. Each fleck gets an evenly divided share of the
 * circle and is then jittered inside it, so the burst is always a burst and
 * never a stripe.
 */
function fleck(index, total) {
  const slice = (Math.PI * 2) / total;
  const angle = slice * index + (Math.random() - 0.5) * slice * 0.8;
  const distance = 40 + Math.random() * 90;
  return {
    x: Math.cos(angle) * distance,
    y: Math.sin(angle) * distance - 20, // biased upward: ink thrown, not dropped
    rotate: (Math.random() - 0.5) * 220,
    scale: 0.5 + Math.random() * 0.9,
    delay: Math.random() * 90,
  };
}

/**
 * Throw a burst of ink from the middle of an element.
 *
 * @param {Element|null} target  what to burst from; the burst is positioned
 *   over it and does not affect its layout
 * @param {'small'|'large'} [size]
 */
export function burst(target, size = 'small') {
  if (!target || suppressed()) return;
  if (typeof target.getBoundingClientRect !== 'function') return;

  const box = target.getBoundingClientRect();
  if (!box.width || !box.height) return;

  const layer = document.createElement('div');
  layer.className = 'burst';
  layer.setAttribute('aria-hidden', 'true');
  layer.style.left = `${box.left + box.width / 2}px`;
  layer.style.top = `${box.top + box.height / 2}px`;

  const total = SIZES[size] ?? SIZES.small;
  for (let i = 0; i < total; i += 1) {
    const bit = document.createElement('i');
    bit.className = 'burst__bit';
    const f = fleck(i, total);
    bit.style.setProperty('--x', `${f.x.toFixed(1)}px`);
    bit.style.setProperty('--y', `${f.y.toFixed(1)}px`);
    bit.style.setProperty('--r', `${f.rotate.toFixed(0)}deg`);
    bit.style.setProperty('--s', f.scale.toFixed(2));
    bit.style.animationDelay = `${f.delay.toFixed(0)}ms`;
    layer.append(bit);
  }

  document.body.append(layer);

  // Both, on purpose. animationend is the accurate one; the timer is the one
  // that still fires when the tab was hidden through the whole animation and
  // the event never came.
  let done = false;
  const clean = () => {
    if (done) return;
    done = true;
    layer.remove();
  };
  layer.addEventListener('animationend', (e) => {
    if (e.target === layer.lastElementChild) clean();
  });
  setTimeout(clean, LIFETIME + 200);
}

/**
 * Mark a milestone once and only once.
 *
 * Reaching the export screen is not a single event — the router lands there on
 * a reload, Back returns to it, and rebuilding after a settings change passes
 * through it again. Celebrating each of those would turn the moment somebody
 * finished into a thing that keeps happening at them.
 *
 * Per page load rather than stored: a second visit that gets all the way to a
 * finished font has earned it again, and there is nowhere to keep this that
 * would not mean adding an eighth value to the seven the privacy policy lists.
 */
const marked = new Set();

/**
 * @param {string} id      milestone name
 * @param {Element|null} target
 * @param {'small'|'large'} [size]
 * @returns {boolean} whether this was the first time
 */
export function once(id, target, size = 'small') {
  if (marked.has(id)) return false;
  marked.add(id);
  burst(target, size);
  return true;
}

/** For the tests, and for a reader wondering whether this holds state. */
export function reset() {
  marked.clear();
}
