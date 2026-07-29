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
  // '.band > .wrap > *' used to be here, and matched nothing at all: the
  // landing markup is .step > .wrap > .band, so the wrap is the band's
  // ancestor, not its child. Every band on the front page — the demo, the four
  // steps, the four detail articles, the questions — arrived with no animation
  // whatever while the selector sat there looking like it covered them.
  '.band-head > *',
  '.hero > *',
  '.feature-grid li',
  '.how-list li',
  '.detail-grid article',
  '.faq-item',
  '.cta > *',
  '.demo-mount',
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

/**
 * How long a whole group may take to finish arriving, in milliseconds.
 *
 * The stagger used to be a flat 65ms per element with the index capped at six,
 * which is two different behaviours wearing one name: a row of four cards got a
 * sequence, and a list of nine got a sequence of seven followed by three
 * arriving together. The cap was there to stop a long list taking forever, which
 * is the right worry and the wrong fix — bounding the *window* rather than the
 * index keeps short groups exactly as they were (four cards still step 65ms
 * apart) while a long one compresses instead of giving up partway through.
 */
const GROUP_WINDOW = 420;
const STEP_MAX = 65;

/**
 * Families that arrive as a whole group the moment any one of them is reached,
 * rather than each waiting to be scrolled to individually.
 *
 * The questions are a stack of pages, and a stack does not settle one sheet at
 * a time as your eye passes each one — it settles. Reaching the top of the list
 * is the event; the rest following a beat behind is the consequence, and the
 * delays that were already there are what make it read that way.
 *
 * Deliberately a short list rather than the default. Most of what is revealed on
 * this page is genuinely independent — a claim card, a heading, a paragraph —
 * and revealing a hundred glyph tiles because the first one came into view
 * would spend the effect on the twelve of them anyone actually watches.
 */
const BATCHED = ['.faq-item'];

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

  // Cut into groups first, so each one's size is known before its step is
  // chosen. The single pass this replaces could not do that: it had to commit
  // to a delay for the first element without knowing how many were behind it,
  // which is why the old cap existed.
  const groups = [];

  // A family that arrives together is grouped by the list it is in, not by how
  // far apart its rows are.
  //
  // Distance was tried and is wrong here for a reason that is not obvious: the
  // first question is open on load, so it is 182px tall where the other eight
  // are 76px, and the step from its top to the next one cleared the 220px
  // threshold. The list split into a group of one and a group of eight, and the
  // row that triggers the cascade was the one row not in it. Anything that
  // changes a row's height — a longer question, a wider window, larger text —
  // could do the same again, silently, to a different row.
  //
  // Two rows in the same <ul> are the same list whatever their heights say.
  const byParent = new Map();
  const loose = [];
  for (const el of sorted) {
    if (!isBatched(el)) { loose.push(el); continue; }
    const parent = el.parentElement;
    if (!byParent.has(parent)) byParent.set(parent, []);
    byParent.get(parent).push(el);
  }
  groups.push(...byParent.values());

  let current = null;
  let previous = null;
  for (const el of loose) {
    if (current === null || (previous !== null && el.__revealTop - previous > GROUP_GAP)) {
      current = [];
      groups.push(current);
    }
    current.push(el);
    previous = el.__revealTop;
  }

  for (const group of groups) {
    // Registered only when the group is one that arrives together. A group of
    // one has nobody to arrive with, and an unbatched family reveals element by
    // element — in both cases keeping the array here would be a reference held
    // for the life of the page to something nothing will ever look up.
    const together = group.length > 1 && isBatched(group[0]);
    const id = nextGroupId;
    if (together) {
      batches.set(id, group);
      nextGroupId += 1;
    }

    const step = group.length > 1
      ? Math.min(STEP_MAX, GROUP_WINDOW / (group.length - 1))
      : STEP_MAX;

    group.forEach((el, index) => {
      el.__revealGroup = together ? id : null;
      el.style.setProperty('--reveal-i', String(index));
      el.style.setProperty('--reveal-step', `${step.toFixed(1)}ms`);
    });
  }
}

/**
 * Show an element — and, if it belongs to a group that arrives together, the
 * rest of that group with it.
 *
 * Shared by both paths deliberately. An element already on screen when
 * observe() runs never reaches the observer, so without this the top question
 * would appear on load and the eight below it would each still be waiting to be
 * scrolled to individually, which is the behaviour this is here to replace.
 */
function arrive(el, io_) {
  const mates = batches.get(el.__revealGroup);
  for (const member of mates ?? [el]) {
    member.dataset.reveal = 'in';
    io_?.unobserve(member);
  }
  if (mates) batches.delete(el.__revealGroup);
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

/**
 * Group id → its members, for the families in BATCHED.
 *
 * Ids come from a counter that never restarts, because observe() is called
 * again on every step change and a per-call index would let a new group claim
 * the id of one still being watched — which would reveal the wrong list.
 * Entries are deleted as soon as their group has arrived, so this holds only
 * what is still pending.
 */
const batches = new Map();
let nextGroupId = 0;

const isBatched = (el) => BATCHED.some((sel) => el.matches(sel));

function observer() {
  if (io) return io;
  io = new IntersectionObserver(
    (entries, self) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        // Reaching one member of a group that arrives together is what starts
        // the whole group. Their `--reveal-i` delays are already set, so what
        // follows is a sequence rather than nine things at once — and unlike
        // waiting for each to be scrolled to, it is the same sequence however
        // fast the reader is moving.
        arrive(entry.target, self);
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
    if (onScreen) arrive(el, io);
    else observer().observe(el);
  }

  return io;
}

/** Show everything at once and stop hiding anything new — for the lite switch. */
export function showAll() {
  document.documentElement.classList.remove('reveal-ready');
  for (const el of document.querySelectorAll('[data-reveal]')) el.dataset.reveal = 'in';
}
