/**
 * meta.js — the title, the description and the canonical, per screen.
 *
 * Every screen has an address (routes.js) and, until this file existed, one
 * title between them. That is wrong in three separate places at once: the
 * browser tab says "turn your handwriting into a real font" while the reader is
 * looking at the privacy policy, the history menu offers eleven identical
 * entries, and a search engine that renders the page finds five documents whose
 * titles claim to be the same document.
 *
 * The canonical is the part that actually matters to a search engine. Every
 * address here is answered with the same index.html — that is what the rewrite
 * in vercel.json does — so to anything that fetches without rendering, `/terms`
 * and `/guide` and `/` are one page served three times. The step addresses are
 * dealt with at the header level, where `X-Robots-Tag: noindex` reaches a
 * crawler that never runs a line of this. What is left is the four documents
 * that are worth indexing, and this tells each of them which URL it is.
 *
 * Relative, not absolute
 * ----------------------
 * The href is built from routes.js's own base, so a copy served from
 * `example.com/fonts/` says `/fonts/guide` and a copy served from the root says
 * `/guide`. A hard-coded absolute canonical would tell every crawler that a
 * self-hosted copy is really handwritingfont.vercel.app, which is the same
 * reason index.html has no og:url. Relative canonicals are resolved against the
 * document, which is exactly the behaviour wanted here.
 *
 * What is deliberately not touched
 * --------------------------------
 * og:title and og:description stay as authored. They are read by link
 * scrapers — Slack, Discord, iMessage — and a scraper takes the bytes off the
 * wire without running any of this, so rewriting them at runtime would change
 * nothing for the only consumer they have while adding a second place for the
 * page's name to live.
 *
 * A guide lesson is a section, not a page. `/guide/pen` therefore takes the
 * guide's own canonical: the lesson has an address so it can be linked, and it
 * has no separate content to be indexed apart from the document it is in.
 */

import { overlayPath, stepPath } from './routes.js';

/**
 * The authored title and description, captured before anything overwrites them.
 *
 * Read off the document rather than restated here, so the landing page keeps
 * exactly one copy of its own name. Two copies drift, and the way that shows up
 * is a tab that says one thing on arrival and another after pressing Back.
 */
const AUTHORED_TITLE = document.title;
const AUTHORED_DESCRIPTION =
  document.querySelector('meta[name="description"]')?.content ?? '';

const SUFFIX = 'Handwrite';

/**
 * Screen id → what the tab should say, and where relevant what the page is
 * about.
 *
 * A description is only given to the four screens that are worth arriving at
 * cold. The steps are positions in a piece of work rather than documents — they
 * carry `noindex`, and describing them separately would be writing copy for a
 * reader who cannot exist — so they take the authored description and only
 * correct the title, which a person with six tabs open does have a use for.
 */
const SCREENS = {
  write: { title: 'Copy the sheet' },
  capture: { title: 'Photograph your sheets' },
  review: { title: 'Check the characters' },
  refine: { title: 'Try it out' },
  export: { title: 'Your font is ready' },

  guide: {
    title: 'How it works',
    description:
      'Choosing a pen, writing the way you actually write, keeping characters from touching, photographing the sheet, and where bold and italic come from.',
  },
  privacy: {
    title: 'Privacy',
    description:
      'What Handwrite stores, which is seven values in your browser’s local storage. No cookies, no analytics, no upload, no account.',
  },
  terms: {
    title: 'Terms',
    description: 'The terms of use for Handwrite, including the two rate limits and what you own.',
  },
  // `licenses`, not `licences` — the overlay id in routes.js is spelt the
  // American way and its path is spelt the British way, and this map is keyed by
  // the id. Keying it by the path instead is a one-letter mistake that produces
  // no error: the lookup misses, and the licences dialogue quietly keeps the
  // landing page's title.
  licenses: {
    title: 'Licences',
    description:
      'The third-party code Handwrite is built on: opentype.js under MIT, and the Geist typeface under the SIL Open Font License.',
  },
  settings: { title: 'Settings' },
  feedback: { title: 'Send feedback' },
};

/** The one canonical <link>, made on first use and reused after. */
function canonicalLink() {
  let el = document.querySelector('link[rel="canonical"]');
  if (!el) {
    el = document.createElement('link');
    el.rel = 'canonical';
    document.head.appendChild(el);
  }
  return el;
}

function descriptionTag() {
  return document.querySelector('meta[name="description"]');
}

/**
 * Say what screen this is.
 *
 * Called from applyRoute with what the router actually landed on, not with what
 * was asked for — an address naming a step nobody can reach lands somewhere
 * else, and the title has to describe the screen in front of the reader rather
 * than the one they typed.
 *
 * @param {object} at
 * @param {string|null} [at.step]     step id, when no dialogue is open
 * @param {string|null} [at.overlay]  overlay id, when one is
 */
export function describe({ step = null, overlay = null } = {}) {
  const id = overlay ?? step ?? 'start';
  const screen = SCREENS[id];

  document.title = screen ? `${screen.title} — ${SUFFIX}` : AUTHORED_TITLE;

  const meta = descriptionTag();
  if (meta) meta.content = screen?.description ?? AUTHORED_DESCRIPTION;

  // The section is deliberately dropped: /guide/pen is the guide, read from a
  // particular paragraph. Steps self-canonicalise — harmless beside the noindex
  // they already carry, and it means no address here points at a different one.
  canonicalLink().href = overlay ? overlayPath(overlay) : stepPath(step ?? 'start');
}
