/**
 * app.js — the shell.
 *
 * Holds all the mutable state for the conversion and decides what is on screen.
 * Everything it calls is pure: the pipeline takes data and returns data, so the
 * only place a bug can hide in this file is in *when* something is called, not
 * in what it computes.
 *
 * One performance decision shapes the whole refine screen. Compiling all four
 * styles takes a few hundred milliseconds, which is far too slow to sit behind
 * a dragged slider. So while tuning, only the style currently on screen is
 * built; the other three are compiled once, at export. The user never waits for
 * a weight they are not looking at.
 */

import {
  capturePage, mergeCaptures, compile, serialise, packageFamily,
  registerPreviewFont, clearPreviewFonts, analyse, cssSnippet, slugify,
  traceGlyph, ALL_SHEETS, sheetById,
} from './pipeline.js';
import { STYLES } from './fontbuild.js';
import { glyphToCanvas } from './segment.js';
import { scoreLabel } from './health.js';
import { PREVIEW_SAMPLES, REQUIRED, LIGATURE_SHEET } from './charset.js';
import { download } from './export.js';
import { FALLBACK_LESSONS, FALLBACK_INSTALL, FALLBACK_FAQ } from './content.js';
import { DOCUMENTS, documentById, LEGAL_VERSION, LEGAL_UPDATED } from './legal.js';
import { limiter, describeWait } from './ratelimit.js';
import { bindCycle as bindThemeCycle, bindChoice as bindThemeChoice } from './theme.js';
import {
  bindToggle as bindLite,
  bindCheckbox as bindLiteCheckbox,
  apply as applyLite,
  chosen as liteChosen,
} from './lite.js';
import { bindToggle as bindTextSize } from './textsize.js';
import { observe as observeReveal, showAll as revealAll } from './reveal.js';
import { enhance as enhanceFolds } from './fold.js';
import { token as paletteToken, onPaletteChange } from './paint.js';
import { classify as classifyFile, sniff as sniffFile, explain as explainFile } from './filetype.js';
import { salvage as salvageImage } from './salvage.js';
import { init as initFlourish, bindToggle as bindFlourish } from './flourish.js';
import { loop as loopSpecimen } from './specimen.js';
import { mount as mountStepshow } from './stepshow.js';
import { mount as mountEggs } from './eggs.js';
import { mount as mountSliders } from './slider.js';
import { mount as mountMascot } from './mascot.js';
import { read as readRoute, write as pushRoute, base as routeBase, overlayPath } from './routes.js';
import { describe as describeScreen } from './meta.js';
import { run as runBrowserGate } from './browsergate.js';
import { init as initPointer } from './pointer.js';
import { once as celebrateOnce } from './celebrate.js';
import { panel as congratsPanel, shown as congratsChars, FAMILY as CONGRATS_FAMILY } from './congrats.js';
import * as session from './session.js';
import { mount as mountWelcome } from './welcome.js';
import { record as recordTiming, estimate as estimateTiming } from './timings.js';
import { intercept as interceptExternal, describe as describeUrl } from './leaving.js';
import { profile, createEstimator, describeEta, slowDeviceNote } from './eta.js';
import { buildIndex, search as searchDocs, terms as searchTerms, highlight } from './docsearch.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/**
 * Number a freshly built list so its rows unfold one after another rather than
 * all at once. Read by the `--fold-i` delay in styles.css.
 *
 * Capped, because past a dozen the stagger stops reading as sequence and starts
 * reading as lag — a 120-glyph review grid would otherwise take four seconds to
 * finish arriving, and the last row would be waiting on nothing but arithmetic.
 */
function stagger(container, cap = 11) {
  if (!container) return;
  let i = 0;
  for (const el of container.children) {
    el.style.setProperty('--fold-i', String(Math.min(i, cap)));
    i += 1;
  }
}

/** Internal family name for live preview, kept stable while the user renames. */
const PREVIEW_FAMILY = 'HandwriteLivePreview';

const STEPS = [
  { id: 'start', label: 'Start' },
  { id: 'write', label: 'Write' },
  { id: 'capture', label: 'Photograph' },
  { id: 'review', label: 'Review' },
  { id: 'refine', label: 'Refine' },
  { id: 'export', label: 'Download' },
];

const state = {
  step: 'start',
  captures: new Map(),
  glyphs: [],
  naturalSlant: 0,
  family: null,
  serialised: null,
  health: null,
  previewStyle: 'Regular',
  previewSize: 40,
  os: detectOS(),
  settings: {
    familyName: 'My Handwriting',
    spacingFactor: 0.3,
    boldStrength: 0.02,
    strokeWeight: 0,
    italicAngle: 11,
    variantCount: 3,
    straighten: false,
    kerning: true,
  },
  /** Optional modules, loaded lazily; the app degrades gracefully without them. */
  modules: { template: null, draw: null, tutorial: null },
};

// ---------------------------------------------------------------------------
// Keeping the work
// ---------------------------------------------------------------------------

/**
 * Write the session, at most once every couple of seconds.
 *
 * Debounced rather than immediate because the things that change the work
 * arrive in bursts — a capture lands 112 glyphs at once, and dragging the
 * spacing slider fires on every pixel. Compressing 300 KB per pixel of slider
 * travel is exactly the sort of thing that makes an app feel heavy.
 *
 * Trailing edge only. There is nothing to be gained by writing the first change
 * of a burst; what matters is that the last one is on disk.
 */
let saveTimer = null;
const SAVE_AFTER = 2000;
/** Lite mode saves the cheap version. See session.js's `lean`. */
const leanSave = () => document.documentElement.dataset.lite === 'on';

function saveSession() {
  if (!session.enabled() || !state.glyphs.length) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    session.save(session.snapshot(state, { lean: leanSave(), at: Date.now() }));
  }, leanSave() ? SAVE_AFTER * 3 : SAVE_AFTER);
}

/**
 * Put a saved session back on the state object.
 *
 * The photographs are not in the record — see session.js — so the captures come
 * back with their counts and their warnings but no `page`, and the review
 * screen's before-and-after overlay has nothing to draw. That is why `page` is
 * explicitly null here rather than absent: the renderer checks for it, and a
 * missing key and a null both mean "no overlay" only if somebody remembered.
 */
function restoreSession(record) {
  state.step = record.step ?? 'start';
  state.naturalSlant = record.naturalSlant ?? 0;
  state.settings = { ...state.settings, ...record.settings };
  state.glyphs = record.glyphs;
  state.captures = new Map(
    (record.sheets ?? []).map((s) => [s.id, {
      glyphs: record.glyphs.filter((g) => g.sheetId === s.id),
      issues: s.issues ?? [],
      stats: s.stats ?? { total: 0, found: 0 },
      slant: s.slant ?? 0,
      angle: s.angle ?? 0,
      page: null,
    }]),
  );
  // Both are derived from the glyphs in about a second, and both are megabytes.
  // Leaving them null is what sends the reader to Refine rather than Download,
  // which is correct: the font they had is gone and the work that makes it is
  // not.
  state.family = null;
  state.serialised = null;
  state.health = null;
}

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------

function reachable(stepId) {
  if (stepId === 'start' || stepId === 'write' || stepId === 'capture') return true;
  if (stepId === 'review') return state.captures.size > 0;
  return state.glyphs.length > 0 && !!state.family;
}

/**
 * Put a step on screen. Deliberately does not touch history — restoring an
 * address and navigating to one need the same DOM work but opposite history
 * behaviour, and a single function doing both is how a router ends up pushing
 * an entry for the entry it is currently restoring.
 */
function applyStep(stepId) {
  state.step = stepId;
  $$('.step').forEach((s) => s.classList.toggle('is-active', s.dataset.step === stepId));
  renderSteps();

  // Until this moment the step was `display: none`, so everything inside it
  // measured as zero and could not be staggered or judged on-screen. Now that
  // it has a position, measure it again.
  const step = $(`.step[data-step="${stepId}"]`);
  if (step) observeReveal(step);

  // Where you are is part of where you were.
  saveSession();

  // The milestones, marked where every route arrives — the router lands here on
  // a reload and Back comes through it too, which is exactly why celebrateOnce
  // is the thing called rather than a plain burst.
  //
  // After the paint, not during it: the burst is positioned from a bounding box,
  // and the screen it is bursting from was display:none one line ago. Measured
  // then, every fleck starts at 0,0 in the corner of the page.
  if (step && (stepId === 'review' || stepId === 'export')) {
    requestAnimationFrame(() => {
      if (stepId === 'export') {
        celebrateOnce('font-exists', step.querySelector('.download-card') ?? step, 'large');
      } else {
        celebrateOnce('characters-read', step.querySelector('.step-head') ?? step, 'small');
      }
    });
  }
}

/**
 * Move to a screen.
 *
 * Export is special, and has to be: it is the only screen whose content does
 * not exist until something expensive has run. The Download chip in the header
 * walked straight onto it with state.serialised still null, and the screen
 * renders regardless — "Your font is ready", zero characters, no download rows,
 * and a button that failed when pressed. The [data-goto] buttons were gated and
 * the chips were not, so the gate was in the wrong place. It is here now, where
 * every route arrives.
 */
/**
 * Move the address, and say what the screen now is.
 *
 * One wrapper rather than a describeScreen() beside each of the nine calls
 * below, for the same reason closeOverlay exists: three paths that dismissed the
 * same dialogue held three opinions about the address, and the fix was to give
 * them one function rather than to correct all three. The title, the meta
 * description and the canonical are facts of the same kind as the address —
 * they all name the screen — so they are written where the address is written,
 * and a tenth call site added later gets them without anybody remembering to.
 */
function writeRoute(opts = {}) {
  pushRoute(opts);
  describeScreen(opts);
}

function goto(stepId) {
  if (stepId === 'export' && !state.serialised?.length) {
    prepareExport().then((ok) => { if (ok) goto('export'); });
    return;
  }
  if (!reachable(stepId)) return;
  // An overlay left open here would leave the address naming a step while the
  // screen shows a document — the two must not be able to disagree.
  closeRoutedOverlays();
  applyStep(stepId);
  window.scrollTo({ top: 0, behavior: 'instant' });
  writeRoute({ step: stepId });
}

/**
 * Where to land when an address names a step this session cannot show.
 *
 * Not simply "the last step that passes reachable()": Write and Photograph pass
 * unconditionally, so that would drop a cold visitor who opened /refine onto an
 * empty Photograph screen — technically reachable, and useless. This returns the
 * furthest step that has actual work behind it, which on a cold load is the
 * start.
 */
function furthestReachable() {
  if (state.family && state.glyphs.length) return 'refine';
  if (state.captures.size) return 'review';
  return 'start';
}

/**
 * How far along, stated once.
 *
 * This was six chips you could press. Three things were wrong with that. It is
 * a navigation control, and one that redirects out of a half-finished sheet is
 * a way to lose work — which is the same reason the sheets are being autosaved
 * rather than defended by a warning. It needed its own horizontal scroller
 * below 860px, plus a scrollIntoView on every step change to stop the current
 * chip drifting off the end of it. And it stopped fitting at all once the
 * optional sheets became steps of their own.
 *
 * A bar says the position without offering to change it. Forward is the button
 * at the bottom of the screen you are on; back is the browser's Back, which
 * works properly because every screen has an address.
 *
 * The percentage is of *completed* steps, so the first screen reads as empty
 * rather than as one-sixth done — arriving is not progress. The last one reads
 * as full.
 */
function renderSteps() {
  const bar = $('#progress');
  const fill = $('#progress-fill');
  const count = $('#progress-count');
  if (!bar || !fill) return;

  const index = Math.max(0, STEPS.findIndex((s) => s.id === state.step));
  const current = STEPS[index];
  const done = index / (STEPS.length - 1);

  fill.style.inlineSize = `${(done * 100).toFixed(1)}%`;
  if (count) count.textContent = `${index + 1}/${STEPS.length}`;
  // The label carries the whole state, because the bar is one element to a
  // screen reader and "38 percent" is not what somebody needs to hear.
  bar.setAttribute('aria-label', `Step ${index + 1} of ${STEPS.length}: ${current?.label ?? ''}`);
  bar.dataset.step = state.step;
}

// ---------------------------------------------------------------------------
// Busy overlay and toasts
// ---------------------------------------------------------------------------

/**
 * Render the stage label as individual characters so the wave can run across
 * it, with the plain string alongside for assistive tech.
 *
 * Splitting text into spans is a well-known way to make a screen reader spell
 * a word out one letter at a time. The spans are hidden from the accessibility
 * tree and the whole string exposed once, which keeps the live region
 * announcing "Reading image" rather than "R, e, a, d…".
 */
function setStage(text) {
  const el = $('#busy-stage');
  if (el.dataset.text === text) return; // don't restart the wave on every tick
  el.dataset.text = text;

  const wave = document.createElement('span');
  wave.className = 'shimmer';
  wave.setAttribute('aria-hidden', 'true');
  [...text].forEach((ch, i) => {
    const s = document.createElement('span');
    s.className = 'shimmer__ch';
    s.style.setProperty('--i', i);
    // A collapsed space would break the rhythm of the wave.
    s.textContent = ch === ' ' ? ' ' : ch;
    wave.append(s);
  });

  const plain = document.createElement('span');
  plain.className = 'sr-only';
  plain.textContent = text;

  el.replaceChildren(wave, plain);
}

const estimator = createEstimator();

/**
 * The operation currently running, and when it started — so it can be timed and
 * so the right history bucket can be read while it is still too early to
 * measure.
 */
let busyRun = null;

/**
 * @param {boolean} on
 * @param {string} stage
 * @param {number} pct
 * @param {'capture'|'preview'|'family'|null} [op] which history bucket this is
 */
/** Whether the build overlay is up. Read by applyInert alongside the stack. */
let busyOpen = false;
/** What had focus before the overlay took it. */
let busyReturnFocus = null;
/**
 * What to run if the reader presses Stop, or null when the operation on screen
 * has no way to be stopped.
 *
 * The button is shown only while this is set, and it is set only by the one
 * caller that threads an abort signal all the way down. Compiling and
 * packaging do not, so they offer nothing — a Stop that does not stop is the
 * interface claiming something the code has not checked, which is the single
 * thing this app is not allowed to do.
 */
let busyCancel = null;

function offerCancel(fn) {
  busyCancel = fn ?? null;
  const btn = $('#busy-cancel');
  btn.hidden = !busyCancel;
  btn.textContent = 'Stop';
  btn.removeAttribute('aria-disabled');
}

/**
 * The full-screen overlay shown while a font is being built.
 *
 * It is painted over everything at z-index 80 and it stops the pointer — but
 * it never stopped the keyboard. Tab walked through the topbar, the whole
 * active step and the footer, all of them invisible under an 88%-opaque blur,
 * with the focus ring painted underneath. Enter then fired whatever was
 * reached, including "Start over", whose handler reloads the page and throws
 * the build away. So the overlay now feeds applyInert() like a dialogue does.
 */

/**
 * A persistent, levelled statement.
 *
 * The counterpart to toast(). A toast is for something that just happened and
 * then stops being true; a finding is for something that stays true until the
 * state behind it changes. Both exist because they answer different questions,
 * and neither should be doing the other's job.
 *
 * Every caller derives its text from a value the app computed. Nothing here
 * infers anything about the photograph: the working image is downscaled before
 * anything measures it, and capturePage returns no ink ratio or source
 * resolution, so there is no honest sentence to be written about focus or
 * lighting and none is written.
 *
 * @param {{level?: 'error'|'warn'|'info', title: string, detail?: string, chars?: string[]}} n
 */
function finding({ level = 'info', title, detail = '', chars = [] }) {
  const li = document.createElement('li');
  li.className = `finding is-${level}`;
  const icon = level === 'info' ? 'info' : 'alert';
  li.innerHTML =
    `<svg viewBox="0 0 24 24" aria-hidden="true"><use href="#i-${icon}"/></svg><div><b></b><p></p></div>`;
  $('b', li).textContent = title;
  const p = $('p', li);
  if (detail) p.textContent = detail;
  else p.remove();

  if (chars.length) {
    const box = document.createElement('div');
    box.className = 'chars';
    // The cap is a layout decision, so it has to be visible: several callers put
    // the full count in the title — health.js builds "${missingLetters.length}
    // letters missing" and hands over every one of them — and a title that says
    // 26 above a row of 14 chips is the interface contradicting itself in one
    // element. The overflow is stated rather than swallowed.
    const SHOWN = 14;
    for (const ch of chars.slice(0, SHOWN)) {
      const s = document.createElement('span');
      s.textContent = ch;
      box.append(s);
    }
    if (chars.length > SHOWN) {
      const more = document.createElement('span');
      more.className = 'chars__more';
      more.textContent = `+${chars.length - SHOWN} more`;
      box.append(more);
    }
    $('div', li).append(box);
  }
  return li;
}

function findingList(items) {
  const ul = document.createElement('ul');
  ul.className = 'findings';
  ul.append(...items.map(finding));
  stagger(ul);
  return ul;
}

function busy(on, stage = '', pct = 0, op = null) {
  const el = $('#busy');
  // Both focus moves below have to be gated on the *transition*, not on `on`.
  // Progress calls busy(true, …) many times a run, and repeating them had two
  // consequences: the second tick captured #busy itself as the element to
  // return focus to (activeElement is #busy by then, not <body>), so the return
  // went to a hidden element and landed on <body> anyway — and now that there
  // is a Stop button in the panel, a repeat would drag focus straight back off
  // it between one label and the next, leaving a control that can be reached
  // and never pressed.
  const opening = on && !busyOpen;
  el.hidden = !on;

  busyOpen = on;
  if (opening && document.activeElement && document.activeElement !== document.body) {
    busyReturnFocus = document.activeElement;
  }
  applyInert();
  if (opening) {
    // Inert on an ancestor blurs whatever had focus and drops it on <body>, so
    // it is parked somewhere deliberate. #busy is not in INERT_WHILE_OPEN, so
    // #busy-stage keeps announcing progress from its own live region — and when
    // the running operation can be stopped, focus goes to the control that
    // stops it rather than to the panel, so it does not have to be hunted for.
    (busyCancel ? $('#busy-cancel') : el).focus?.();
  } else if (!on && busyReturnFocus?.isConnected) {
    busyReturnFocus.focus?.();
    busyReturnFocus = null;
  }

  if (!on) {
    offerCancel(null);
    // Timed here rather than at each call site, because this is the one place
    // that knows the operation really finished. A build that threw goes through
    // runCompile's catch and reaches busy(false) too, so completion is recorded
    // only when the last progress seen was a real one.
    if (busyRun && busyRun.op && busyRun.reached >= 0.9) {
      recordTiming(busyRun.op, performance.now() - busyRun.startedAt);
    }
    busyRun = null;
    estimator.reset();
    $('#busy-eta').textContent = '';
    return;
  }

  if (!busyRun) busyRun = { op, startedAt: performance.now(), reached: pct };
  else if (op) busyRun.op = op;
  busyRun.reached = Math.max(busyRun.reached, pct);

  setStage(stage);
  $('#busy-bar').style.width = `${Math.round(pct * 100)}%`;

  const { remainingMs, confident } = estimator.update(pct);
  $('#busy-eta').textContent = confident
    ? describeEta(remainingMs)
    // Until there is enough signal to measure — an estimate drawn from the
    // first 2% of a job is a guess wearing a number — fall back to what this
    // device took last time, and say so. A remembered figure and a measured one
    // must not look alike: the reader is entitled to know which they are
    // reading, because only one of them is tracking the run in front of them.
    : rememberedEta(busyRun, pct);
}

/**
 * @returns {string} empty when there is no usable history
 */
function rememberedEta(run, pct) {
  if (!run?.op) return '';
  const past = estimateTiming(run.op);
  if (!past) return '';

  const elapsed = performance.now() - run.startedAt;
  const left = past.ms * (1 - Math.min(pct, 0.95)) - elapsed;
  // Past the remembered duration the memory has nothing left to say, and
  // counting down past zero would be worse than saying nothing.
  if (left < 1500) return '';
  return `${describeEta(left)} — going by your last ${past.samples} runs`;
}

function toast(message, bad = false) {
  const el = document.createElement('div');
  el.className = `toast${bad ? ' is-bad' : ''}`;
  el.innerHTML = `<svg viewBox="0 0 24 24"><use href="#i-${bad ? 'alert' : 'check'}"/></svg><span></span>`;
  $('span', el).textContent = message;
  $('#toasts').append(el);
  setTimeout(() => el.remove(), 4200);
}

/**
 * Gate on the per-device limit before starting an expensive operation.
 *
 * Only genuinely heavy, user-initiated work is counted: reading a photograph,
 * and compiling the full four-style family. Preview recompiles are pointedly
 * *not* counted — the tuner debounces at 170 ms, so a few seconds of dragging a
 * slider would burn through a 60/minute budget and the limit would fire during
 * completely ordinary use. Counting only the heavy operations keeps the ceiling
 * unreachable by hand, which is the whole point of where it was set.
 */
function allowHeavyOp() {
  const status = limiter().take();
  if (!status.allowed) {
    toast(
      `That is ${limiter().limit} builds in a minute — give it ${describeWait(status.retryAfterMs)}.`,
      true
    );
  }
  return status.allowed;
}

// ---------------------------------------------------------------------------
// Write step
// ---------------------------------------------------------------------------

/** One sheet, as paper. */
function paperFor(sheet) {
  const paper = document.createElement('div');
  paper.className = 'paper';

  const head = document.createElement('div');
  head.className = 'paper-head';
  const h = document.createElement('h3');
  h.textContent = sheet.title;
  const count = document.createElement('span');
  count.className = 'paper-count';
  const n = sheet.rows.flat().length;
  count.textContent = `${n} character${n === 1 ? '' : 's'}`;
  head.append(h, count);

  const hint = document.createElement('p');
  hint.className = 'paper-hint';
  hint.textContent = sheet.hint;

  paper.append(head);
  if (sheet.optional) {
    const badge = document.createElement('span');
    badge.className = 'paper-badge';
    badge.textContent = 'Optional';
    paper.append(badge);
  }
  paper.append(hint);

  for (const row of sheet.rows) {
    const r = document.createElement('div');
    r.className = 'paper-row';
    for (const ch of row) {
      const cell = document.createElement('span');
      cell.className = 'paper-cell';
      cell.textContent = ch;
      r.append(cell);
    }
    paper.append(r);
  }
  return paper;
}

/**
 * The alphabet first, everything else folded away.
 *
 * This screen used to open with all four sheets laid out — 112 characters, four
 * headings, a wall — directly underneath a sentence saying the first sheet on
 * its own is a font. The page said "about thirty characters" and then showed a
 * hundred and twelve, and the sentence loses that argument every time.
 *
 * So the essential sheet is the screen, and the rest are folded away — one fold
 * each, not one fold for all of them. The tiers are already in charset.js,
 * decided where the character set is decided; nothing here is a second opinion
 * about which sheet matters, it only lays out the answer that is recorded.
 *
 * One fold each, and this is the part worth stating. A single "add the other
 * 98 characters" control is a single decision about ninety-eight characters,
 * which is the same wall with a lid on it — you either take all of it or none
 * of it, and most people faced with that take none. Four separate controls are
 * four small decisions, and somebody who wants capitals and nothing else can
 * have exactly that. The sheets were always independent; the interface was the
 * only thing bundling them.
 *
 * The copy does not promise you can return to *this* font later, because you
 * cannot: nothing about a session is stored — that is the whole privacy design
 * — so coming back means starting a new one. It says "another time", which is
 * true, rather than "come back and add them", which would not be.
 */
function renderSheets() {
  const stack = $('#sheet-stack');
  const essential = ALL_SHEETS.filter((s) => s.tier === 'essential');
  const rest = ALL_SHEETS.filter((s) => s.tier !== 'essential');

  const children = essential.map(paperFor);

  if (rest.length) {
    const note = document.createElement('p');
    note.className = 'paper-more__intro';
    note.textContent =
      'The letters above already make a font you can install and type with. Each of these '
      + 'widens what it covers, and they are independent — take any one of them, in any '
      + 'order, or none. Anything you skip falls back to your system font.';
    children.push(note);

    for (const sheet of rest) {
      const fold = document.createElement('details');
      fold.className = 'paper-more';

      const summary = document.createElement('summary');
      const label = document.createElement('span');
      label.className = 'paper-more__label';
      label.textContent = sheet.title;
      const n = sheet.rows.flat().length;
      const count = document.createElement('span');
      count.className = 'paper-count';
      count.textContent = `${n} character${n === 1 ? '' : 's'}`;
      summary.append(label, count);

      // The one-line reason to bother, from charset.js, so the reader can
      // decide without opening it. `blurb` exists for exactly this and was
      // going unused on this screen.
      const why = document.createElement('p');
      why.className = 'paper-more__why';
      why.textContent = sheet.blurb ?? '';

      fold.append(summary, why, paperFor(sheet));
      children.push(fold);
    }
  }

  stack.replaceChildren(...children);
  // Built after init() ran, so the fold enhancement has to be applied here —
  // the same reason renderFAQ does it.
  enhanceFolds(stack);

  const tips = [
    'Use a dark pen — a fine-liner or gel pen around 0.5 mm. Pencil is too faint.',
    'Lined paper is fine. The printed rules are found and removed before your characters are read, so the pad already on your desk will do.',
    'Write at your natural size and speed. Deliberately neat handwriting makes a worse font.',
    'Leave a clear gap between characters. Touching letters is the one thing that cannot be fixed automatically.',
    'Keep rows well separated so tails and loops do not collide.',
    'Skip anything you will never type. Missing characters fall back to a plain substitute.',
  ];
  $('#write-tips').replaceChildren(
    ...tips.map((t) => {
      const li = document.createElement('li');
      li.textContent = t;
      return li;
    })
  );
}

// ---------------------------------------------------------------------------
// Capture step
// ---------------------------------------------------------------------------

/**
 * Whether this device has a camera worth handing a capture request to.
 *
 * There is no feature test for "has a rear camera", so this is a judgement about
 * which way to be wrong.
 *
 * The first attempt also required `any-pointer: fine` to be absent, reasoning
 * that a device with a precise pointer has a mouse and therefore a webcam rather
 * than a camera. That excludes every phone with a stylus: an S Pen reports as a
 * fine pointer, so a Galaxy with the pen docked would have been told it has no
 * camera — which is the exact device the request came from. The test was removed
 * rather than tuned, because the theory behind it was wrong and not merely
 * mis-parameterised.
 *
 * What is left is touch points and a media device API. That does include a
 * touchscreen laptop, where `capture` will reach for a webcam pointing at the
 * ceiling. The asymmetry is the whole argument: on that machine the reader sees
 * one extra button and ignores it, while the alternative hides the feature from
 * every phone that has a pen. An unhelpful button costs a glance; a missing one
 * costs the entire flow the feature exists to shorten.
 *
 * Read once. It cannot change during a session, and the capture list re-renders
 * on every photograph.
 */
let cameraLikely = null;
function hasCamera() {
  if (cameraLikely !== null) return cameraLikely;
  try {
    cameraLikely = (navigator.maxTouchPoints ?? 0) > 0 && Boolean(navigator.mediaDevices);
  } catch {
    cameraLikely = false;
  }
  return cameraLikely;
}

function renderCaptureList() {
  const list = $('#capture-list');
  list.replaceChildren(
    ...ALL_SHEETS.map((sheet) => {
      const capture = state.captures.get(sheet.id);
      const row = document.createElement('div');
      row.className = 'drop';
      row.dataset.sheet = sheet.id;
      row.dataset.tier = sheet.tier || 'extra';
      if (capture) row.classList.add('is-done');
      if (sheet.optional) row.classList.add('is-optional');
      if (sheet.tier === 'essential') row.classList.add('is-essential');

      const thumb = document.createElement('div');
      thumb.className = 'drop-thumb';
      thumb.innerHTML = capture
        ? '<svg viewBox="0 0 24 24"><use href="#i-check"/></svg>'
        : '<svg viewBox="0 0 24 24"><use href="#i-camera"/></svg>';

      const body = document.createElement('div');
      body.className = 'drop-body';
      const h = document.createElement('h3');
      h.textContent = sheet.title;
      // The tier, said once, where the decision is made. This screen used to
      // show four identical rows, which reads as four things that must all be
      // done before anything works — and that is the ask people decline.
      if (sheet.tier === 'essential') {
        const tag = document.createElement('span');
        tag.className = 'drop-tier';
        tag.textContent = 'Start here';
        h.append(' ', tag);
      } else if (sheet.optional) {
        const tag = document.createElement('span');
        tag.className = 'drop-tier is-quiet';
        tag.textContent = 'Optional';
        h.append(' ', tag);
      }

      const p = document.createElement('p');
      p.textContent = capture
        ? `${capture.stats.found} of ${capture.stats.total} characters found`
        // The blurb says what this sheet buys; the instruction is the same on
        // every row and does not need saying five times.
        : (sheet.blurb ? `${sheet.blurb} Drop a photo here, or choose a file.`
                       : 'Drop a photo here, or choose a file.');
      body.append(h, p);

      const actions = document.createElement('div');
      actions.className = 'drop-actions';

      /*
       * A file input, and optionally a second one wired to the camera.
       *
       * `capture="environment"` is the whole of it. On a phone it tells the
       * browser to hand the request straight to the camera app with the rear
       * lens, which is what somebody standing over a sheet of paper wants — the
       * alternative is Choose photo, then the gallery, then finding the shot they
       * took ten seconds ago. getUserMedia would be the other way to do this and
       * is worse: a permission prompt, a live preview to build, a shutter button,
       * and a still frame that is lower resolution than the camera app's own
       * capture. This asks the camera app to do its job and take the photograph.
       *
       * It is a second button rather than an attribute on the first, because
       * `capture` does not mean "prefer the camera", it means "do not offer the
       * gallery". Setting it on the only input would take away the ability to use
       * a photo already taken, or one moved over from a scanner.
       */
      const makeInput = (fromCamera) => {
        const el = document.createElement('input');
        el.type = 'file';
        el.accept = 'image/*';
        if (fromCamera) el.setAttribute('capture', 'environment');
        el.setAttribute(
          'aria-label',
          fromCamera
            ? `Take a photograph of the ${sheet.title} sheet`
            : `Photograph of the ${sheet.title} sheet`
        );
        el.hidden = true;
        el.addEventListener('change', () => {
          if (el.files?.[0]) handleFile(el.files[0], sheet.id);
        });
        return el;
      };

      // Hidden because the button beside it is the real control, but it still
      // needs a name: a file input with none announces as "file, button" with
      // no clue which of the five sheets it belongs to, and browsers surface
      // these in their own file-picker chrome regardless of this attribute.
      const input = makeInput(false);

      const pick = document.createElement('button');
      pick.type = 'button';
      pick.className = capture ? 'btn' : 'btn btn-primary';
      pick.classList.add('drop-pick');
      pick.textContent = capture ? 'Replace' : 'Choose photo';
      pick.addEventListener('click', () => input.click());
      actions.append(pick, input);

      // Only where there is a camera to hand the request to. On a desktop the
      // attribute is ignored, so the button would open the same file picker as
      // the one beside it — two controls that look different and do the same
      // thing, which is worse than not offering it. Asked of the device rather
      // than of the pointer, because a touchscreen laptop reports coarse while
      // being touched and still has no rear camera worth using.
      if (hasCamera()) {
        const shoot = makeInput(true);
        const snap = document.createElement('button');
        snap.type = 'button';
        snap.className = 'btn drop-snap';
        snap.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><use href="#i-camera"/></svg>';
        const label = document.createElement('span');
        label.textContent = capture ? 'Retake' : 'Take photo';
        snap.append(label);
        snap.addEventListener('click', () => shoot.click());
        actions.append(snap, shoot);
      }

      if (capture) {
        const del = document.createElement('button');
        del.type = 'button';
        del.className = 'xdel';

        const label = document.createElement('span');
        label.className = 'xdel__label';
        label.textContent = 'Remove';

        // The accessible name is assembled from real text inside the element
        // rather than from an aria-label, so it is complete at every moment and
        // cannot disagree with what is on screen. This span is a sibling of the
        // collapsing one, never a child, so no clip can reach it.
        const which = document.createElement('span');
        which.className = 'sr-only';
        which.textContent = ` the ${sheet.title} photograph`;

        const icon = document.createElement('span');
        icon.className = 'xdel__icon';
        icon.setAttribute('aria-hidden', 'true');
        icon.innerHTML = '<svg viewBox="0 0 24 24"><use href="#i-trash"/></svg>';

        del.append(label, which, icon);

        del.addEventListener('click', () => {
          state.captures.delete(sheet.id);
          // The panel celebrated a sheet that is no longer there.
          $('#congrats')?.replaceChildren();
          refreshCaptureState();

          // This button destroys itself: refreshCaptureState re-renders the
          // list with replaceChildren, so the element holding focus is gone and
          // focus falls to <body> — a keyboard user is silently returned to the
          // top of the document. Hand it to the control that took this one's
          // place in the same row, which always exists because the list maps
          // over every sheet unconditionally.
          $(`#capture-list .drop[data-sheet="${sheet.id}"] .drop-pick`)?.focus();

          // Removal was silent. Now that the row has been rebuilt underneath
          // them, this is the only thing that reaches a screen reader.
          toast(`Removed the ${sheet.title} photograph.`);
        });

        actions.append(del);
      }

      row.addEventListener('dragover', (e) => {
        e.preventDefault();
        row.classList.add('is-over');
      });
      row.addEventListener('dragleave', () => row.classList.remove('is-over'));
      row.addEventListener('drop', (e) => {
        e.preventDefault();
        row.classList.remove('is-over');
        const file = e.dataTransfer?.files?.[0];
        if (file) handleFile(file, sheet.id);
      });

      row.append(thumb, body, actions);

      // Two things may be said here and no others, both counted from what this
      // sheet's own capture returned.
      if (capture) {
        const notes = [];

        // Cells the segmenter located but the tracer could not turn into an
        // outline. capturePage filters on the same predicate segment.js counts
        // as stats.found, then skips any cell that produced no contours — so
        // this difference is exactly the characters that made it onto the page
        // and off the font. It is reported nowhere else in the app.
        const untraced = capture.stats.found - capture.glyphs.length;
        if (untraced > 0) {
          notes.push({
            level: 'warn',
            title: `${untraced} character${untraced === 1 ? '' : 's'} could not be traced`,
            detail:
              'They were found on the page but produced no usable outline, which usually means a very light stroke. Draw them by hand on the Review screen, or photograph this sheet again.',
          });
        }

        // segment.js wrote these sentences against counts it made, so they are
        // passed through rather than reworded — the wording cannot then drift
        // away from the check that produced it.
        for (const issue of capture.issues) {
          if (issue.level !== 'warn') continue;
          notes.push({
            level: 'warn',
            title:
              issue.code === 'row-count'
                ? 'The rows found do not match this sheet'
                : issue.code === 'cell-count'
                  ? 'A row does not match this sheet'
                  : 'Check this sheet',
            detail: issue.message,
          });
        }

        if (notes.length) row.append(findingList(notes));
      }
      return row;
    })
  );
}

/**
 * The first bytes of a file, for filetype.sniff.
 *
 * Never throws: this runs on the failure path, and an error here would replace
 * a useful message with a worse one.
 */
async function sniffHead(file) {
  try {
    return sniffFile(await file.slice(0, 16).arrayBuffer());
  } catch {
    return null;
  }
}

/**
 * @param {boolean} [retried] true when this is the salvaged image being run
 *   through a second time, which stops a rescue attempting its own rescue.
 */
async function handleFile(file, sheetId, retried = false) {
  // A blocklist, not an allowlist. `file.type` is a label the operating system
  // guesses from the extension rather than a fact about the bytes, so the old
  // `startsWith('image/')` test refused a real JPEG that happened to have no
  // extension and waved a zip renamed to .png straight through. Anything that
  // is not obviously the wrong kind of thing gets in, and the decoder decides.
  const verdict = classifyFile(file);
  if (!verdict.ok) {
    toast(verdict.message, true);
    return;
  }
  if (!allowHeavyOp()) return;

  // One controller per photograph, and the offer is made before the overlay
  // goes up: busy() decides where focus lands from whether a Stop exists, so it
  // has to exist by the time the panel appears. A button that arrives a tick
  // later is a button that is not there when the reader first looks for it.
  const controller = new AbortController();
  offerCancel(() => controller.abort());

  try {
    busy(true, 'Reading image', 0.02, 'capture');
    const capture = await capturePage(file, sheetId, {
      signal: controller.signal,
      onProgress: (stage, pct) => busy(true, stage, pct),
    });
    state.captures.set(sheetId, capture);

    const fatal = capture.issues.find((i) => i.level === 'fatal');
    if (fatal) {
      state.captures.delete(sheetId);
      toast(fatal.message, true);
    } else {
      const warn = capture.issues.find((i) => i.level === 'warn');
      if (warn) toast(warn.message, true);
      else toast(`Found ${capture.stats.found} characters.`);
    }
    refreshCaptureState();
    // After the list, so the panel lands under a row that already reads as done.
    // Not awaited on the fatal path: there is nothing to celebrate and the
    // capture was thrown away.
    if (!fatal) await showCongrats(sheetId);
  } catch (err) {
    // Stopping is not failing, and there is nothing to repair. The only write
    // to state.captures on this path is the `set` above, which is downstream of
    // the await that just threw — so the sheet is exactly as it was, including
    // an earlier photograph of it if there was one, and no half-written capture
    // exists to clean up. Saying so is the point: the reader pressed Stop on a
    // panel that had been counting characters and is owed a plain statement
    // that none of them were kept. No re-render, because nothing changed.
    if (err?.name === 'AbortError') {
      toast('Stopped. Nothing from that photo was kept.');
      return;
    }
    console.error(err);
    // Before giving up: a great many files a browser cannot decode still have
    // an ordinary JPEG inside them — camera raw carries a full-size preview, a
    // scanned PDF page is a JPEG with a wrapper, HEIC often has a JPEG
    // thumbnail. src/salvage.js scans the bytes for one. It is expensive and
    // only ever runs here, after the cheap path has already failed, so nothing
    // pays for it unless the alternative was refusing the file outright.
    if (!retried) {
      const rescued = await salvageImage(file);
      if (rescued) {
        toast('That format could not be read directly, so the image inside it was used instead.');
        return handleFile(rescued, sheetId, true);
      }
    }

    // The exception stays in the console, where a property path is useful to
    // someone who can act on it. What reaches the reader is read from the
    // file's own first bytes, so it names what the file actually is instead of
    // guessing — this used to blame HEIC for every failure, including the ones
    // that had nothing to do with HEIC.
    toast(explainFile(await sniffHead(file)), true);
  } finally {
    busy(false);
  }
}

/**
 * Compile just enough of the font to set one line of text in it.
 *
 * Regular only, and under its own family name. Sharing the tuner's family would
 * mean this compile clearing four registered styles and replacing them with one,
 * so a reader who had reached the Refine screen, gone back, and added a sheet
 * would find the live preview showing Regular no matter which style was selected.
 * Two families cost one extra compile of arithmetic over a few thousand curve
 * points, which is the same work the tuner does on every slider drag.
 *
 * Never rate-limited and never fatal: this is decoration on the capture screen,
 * and a font that will not compile yet is a normal state on the first sheet, not
 * an error worth a message.
 */
async function congratsFace() {
  if (!state.glyphs.length) return false;
  try {
    const family = compile(state.glyphs, {
      ...state.settings,
      naturalSlant: state.naturalSlant,
      styles: STYLES.filter((s) => s.name === 'Regular'),
    });
    const built = serialise(family);
    clearPreviewFonts(CONGRATS_FAMILY);
    await Promise.all(
      built.map((s) => registerPreviewFont(s.otf, CONGRATS_FAMILY, {
        italic: s.italic,
        weightClass: s.weightClass,
      }))
    );
    return true;
  } catch (err) {
    // The panel simply does not appear. Nothing downstream depends on it.
    console.error(err);
    return false;
  }
}

/**
 * Show what this sheet just added, in the font it just contributed to.
 *
 * The characters are filtered against what actually traced rather than taken from
 * the sheet definition, because a character the capture missed is not in the font
 * — and rendering it here would fall back to the system font on the one screen
 * whose entire job is to show somebody their own handwriting.
 */
async function showCongrats(sheetId) {
  const slot = $('#congrats');
  if (!slot) return;
  const sheet = ALL_SHEETS.find((s) => s.id === sheetId);
  // Re-read rather than trusted: a fatal issue deletes the capture again.
  if (!sheet || !state.captures.has(sheetId)) return;

  buildGlyphSet();
  const chars = (await congratsFace()) ? congratsChars(sheet, state.glyphs) : [];
  if (!chars.length) { slot.replaceChildren(); return; }

  // "All set" means every sheet that is actually asked for. The ligature sheet is
  // optional by design, so requiring it would leave most people permanently one
  // sheet short of a finish they were never asked to reach.
  const required = ALL_SHEETS.filter((s) => !s.optional);
  const complete = required.every((s) => state.captures.has(s.id));

  const built = congratsPanel({
    sheet, chars, complete, total: sheet.rows.flat().length,
  });
  slot.replaceChildren(built);

  // Once per sheet. Replacing a photograph is not new work, and a burst every
  // time somebody retakes a blurry shot is a burst that stops meaning anything.
  celebrateOnce(complete ? 'all-set' : `sheet:${sheetId}`, built, complete ? 'large' : 'small');
}

function refreshCaptureState() {
  renderCaptureList();
  $('#to-review').disabled = state.captures.size === 0;
  renderSteps();
}

// ---------------------------------------------------------------------------
// Review step
// ---------------------------------------------------------------------------

/**
 * Throw away the export build, because its inputs have changed.
 *
 * goto('export') treats a non-empty state.serialised as proof that the export
 * screen is current: it skips prepareExport, skips renderExport, and shows
 * whatever was rendered last time. That is the right optimisation as long as
 * exactly one rule holds — nothing may change a compile() input without saying
 * so here.
 *
 * scheduleRecompile already reasons this out for settings. state.glyphs is the
 * other input, and it had no such guard, so: capture sheets, build, press
 * Download, go back to Review, redraw a character, then press the Download step
 * chip. The chip is enabled, serialised is non-empty, and the export screen
 * comes up still describing the previous build — the old character count, and
 * download buttons still closed over the old ArrayBuffers. The font that
 * arrives is the one from before the repair, and the repair is visible on the
 * Review screen the whole time.
 */
function invalidateBuild() {
  state.serialised = null;
}

function buildGlyphSet() {
  const captures = [...state.captures.values()];
  state.glyphs = mergeCaptures(captures);
  invalidateBuild();
  const slants = captures.map((c) => c.slant).filter(Number.isFinite);
  state.naturalSlant = slants.length
    ? slants.sort((a, b) => a - b)[slants.length >> 1]
    : 0;
  saveSession();
}

/**
 * Draw the review grid from whatever is currently in `state.glyphs`.
 *
 * It used to call buildGlyphSet() first, which re-derives the whole set from
 * the photographs — so redrawing a character and pressing Save re-rendered the
 * grid from the scans and threw the repair away. The toast said "Updated a",
 * the cell went back to the scanned shape, and a character that had been
 * missing stayed missing. That is the advertised purpose of this screen.
 *
 * The rebuild belongs to *entering* review from capture, which is the only
 * point at which the photographs are the source of truth, so it now lives at
 * that call site.
 */
function renderReview() {
  const found = new Map(state.glyphs.map((g) => [g.ch, g]));
  const expected = [
    ...REQUIRED.map((e) => e.ch),
    ...(state.captures.has(LIGATURE_SHEET.id) ? LIGATURE_SHEET.rows.flat() : []),
  ];
  const missing = expected.filter((ch) => !found.has(ch));

  const bar = $('#review-bar');
  bar.replaceChildren();
  bar.append(
    stat(String(found.size), 'characters captured'),
    stat(String(missing.length), 'missing', missing.length > 6 ? 'is-bad' : missing.length ? 'is-warn' : ''),
    stat(`${Math.round(Math.abs(state.naturalSlant))}°`, state.naturalSlant >= 0 ? 'forward slant' : 'backward slant')
  );

  const grid = $('#glyph-grid');
  // Hoisted out of the map: this was resolved once per character, ~120 times,
  // and each glyph then kept the ink colour of whatever palette it happened to
  // be rasterised under. Flipping the theme from the header left #e4e9ef ink on
  // a #fbfcfd cell — 1.19:1 — and the whole grid read as blank.
  const ink = paletteToken('--text', { light: '#1c2128', dark: '#e4e9ef' });
  grid.replaceChildren(
    ...expected.map((ch) => {
      const glyph = found.get(ch);
      const cell = document.createElement('button');
      cell.type = 'button';
      cell.className = 'glyph';
      cell.dataset.ch = ch;
      cell.title = glyph ? `${ch} — click to redraw` : `${ch} — missing, click to draw`;

      const label = document.createElement('span');
      label.className = 'label';
      label.textContent = ch;
      cell.append(label);

      if (glyph) {
        const canvas = glyphToCanvas(glyph, { size: 96, ink });
        cell.append(canvas);
      } else {
        cell.classList.add('is-missing');
      }

      cell.addEventListener('click', () => openDrawPad(ch));
      return cell;
    })
  );
  stagger(grid);
}

function stat(value, label, cls = '') {
  const el = document.createElement('div');
  el.className = `stat ${cls}`.trim();
  const b = document.createElement('b');
  b.textContent = value;
  const s = document.createElement('span');
  s.textContent = label;
  el.append(b, s);
  return el;
}

/**
 * The repair pad currently on screen, so it can be torn down.
 *
 * createDrawPad registers a keydown listener on `document` to catch Ctrl+Z,
 * removed only by destroy(). Clearing the modal with replaceChildren() takes
 * the canvases away and leaves the listener — so every character repaired added
 * another one, each holding its whole pad closure alive, and each swallowing
 * undo in the feedback box and the preview from then on.
 */
let repairPad = null;

async function openDrawPad(ch) {
  const mod = await loadModule('draw', './draw.js');
  const body = $('#draw-body');
  $('#draw-title').textContent = `Draw “${ch}”`;
  repairPad?.destroy?.();
  repairPad = null;
  body.replaceChildren();

  if (!mod?.createDrawPad) {
    const p = document.createElement('p');
    p.className = 'muted';
    p.textContent =
      'The drawing pad did not load. Check your connection and try again, or re-photograph the sheet instead.';
    body.append(p);
  } else {
    repairPad = mod.createDrawPad(body, {
      ch,
      onCommit: (glyph) => {
        // The pad returns ink, not outlines. This used to read
        // `contours: glyph.contours`, a key the pad has never returned, so every
        // redrawn character went into state carrying `undefined` and broke the
        // next build at normalizeGlyph. Traced here, at the same tolerances the
        // scan path uses, so a repaired letter is no different in kind.
        const contours = traceGlyph(glyph);
        if (!contours) {
          toast('That came out as too little ink to trace. Try a heavier stroke.', true);
          return;
        }

        // A redrawn glyph replaces any captured one and joins its own row, so
        // it is solved against its own baseline rather than a scanned row's.
        state.glyphs = state.glyphs.filter((g) => g.ch !== ch);
        // Its own row, so it is solved against the pad's own rules rather than
        // a scanned row's — and a row per character, not one shared row 9000
        // for all of them, because two characters redrawn at different moments
        // are two separate pieces of paper as far as the solver is concerned.
        // Coverage is dropped here, on purpose, the moment it has been used.
        // It is a Float32Array four times the size of the bitmap beside it, it
        // exists only so traceGlyph can place the boundary between pixels, and
        // that has just happened. Keeping it would put it into state.glyphs and
        // therefore into every autosave snapshot — session.js strips `bitmap`
        // by name and passes everything else through JSON.stringify, so a
        // hundred-odd of these would be serialised as decimal text on a timer.
        const { coverage, ...ink } = glyph;
        state.glyphs.push({ ...ink, ch, row: `drawn:${ch}`, col: 0, contours });
        invalidateBuild();
        saveSession();
        closeModal('#draw-modal');
        renderReview();
        toast(`Updated “${ch}”.`);
      },
    });
  }
  openModal('#draw-modal');
}

// ---------------------------------------------------------------------------
// Refine step
// ---------------------------------------------------------------------------

let recompileTimer = null;

/**
 * Queue a preview rebuild — and throw away the export build while doing it.
 *
 * runCompile(true) compiles only the style on screen and deliberately leaves
 * state.serialised alone; `if (!previewOnly) state.serialised = built;` is its
 * one writer. Every caller of this function has just changed a setting that
 * compile() reads, so whatever sits in state.serialised was built from settings
 * the reader has since moved away from. Leaving it there let goto('export')
 * take its `!state.serialised?.length` branch as satisfied and skip
 * prepareExport entirely — so the export screen kept its previous render and
 * bundleNow zipped the previous fonts.
 *
 * Nulling here rather than at each control means a control added later cannot
 * forget: anything that schedules a preview has, by definition, invalidated the
 * export.
 */
function scheduleRecompile() {
  state.serialised = null;
  clearTimeout(recompileTimer);
  recompileTimer = setTimeout(() => runCompile(true), 170);
}

/**
 * Build the font and hand it to the browser for live preview.
 *
 * @param {boolean} previewOnly compile just the visible style, for slider drags
 */
/**
 * @returns {Promise<boolean>} whether a font actually came out of it.
 *
 * The return value matters because prepareExport used to navigate to the
 * export screen regardless. A failed build left that screen fully formed and
 * hollow — "Your font is ready", zero characters, no download rows, and a
 * Download button that threw a raw TypeError when pressed.
 */
/**
 * Wait for one painted frame — but never for one that is not coming.
 *
 * requestAnimationFrame is the accurate signal here: it resolves after the
 * browser has had its chance to render, which is the whole point of the pause
 * before a synchronous compile takes the main thread for several seconds.
 *
 * It is also a signal that stops arriving entirely when the tab is hidden. Not
 * throttled — stopped. And "press Build, then switch tabs while it works" is
 * not an edge case, it is what a reasonable person does with a job that takes
 * half a minute. The frame was requested, the tab went to the background, the
 * callback was never called, and the build sat on this line without having
 * started: the overlay up, the progress bar still, and nothing under way. The
 * reader comes back to a spinner that has been lying to them the whole time.
 *
 * imageproc.js already reasons this out for the capture pass and uses a timer
 * for exactly this reason. This is the same hazard on the compile path, so it
 * gets the same answer: take whichever comes first. In a visible tab that is
 * the frame, and nothing changes; in a hidden one the timer falls through and
 * the work simply runs unobserved, which is what the reader wanted.
 */
function nextPaint(timeout = 120) {
  return new Promise((resolve) => {
    let settled = false;
    const done = () => { if (!settled) { settled = true; resolve(); } };
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => setTimeout(done, 0));
    }
    setTimeout(done, timeout);
  });
}

async function runCompile(previewOnly = false) {
  if (!state.glyphs.length) return false;
  // Preview recompiles are exempt — see allowHeavyOp for why.
  if (!previewOnly && !allowHeavyOp()) return false;

  topload(true);
  // Only before the first build. On later recompiles the preview already shows
  // the user's own hand, and replacing it with a placeholder every time a
  // slider moves would be a downgrade — the top bar covers those.
  if (!state.family) $('#preview-skeleton').hidden = false;

  // Hand the browser a frame before starting. compile() is synchronous and
  // holds the main thread, so without this neither the bar nor the placeholder
  // would paint until after the work they exist to cover had finished.
  await nextPaint();

  try {
    const styles = previewOnly
      ? STYLES.filter((s) => s.name === state.previewStyle)
      : STYLES;

    const family = compile(state.glyphs, {
      ...state.settings,
      naturalSlant: state.naturalSlant,
      styles,
    });
    state.family = family;

    const built = serialise(family);
    if (!previewOnly) state.serialised = built;

    clearPreviewFonts(PREVIEW_FAMILY);
    await Promise.all(
      built.map((s) =>
        registerPreviewFont(s.otf, PREVIEW_FAMILY, {
          italic: s.italic,
          weightClass: s.weightClass,
        })
      )
    );
    applyPreviewFont();

    state.health = analyse(state.glyphs, family.metrics.glyphs, family.metrics.rows, {
      slant: state.naturalSlant,
      // Which sheets were actually photographed. Without this the report cannot
      // tell a character someone chose not to write from one the capture failed
      // to read, and calls both a missing letter.
      sheets: [...state.captures.keys()],
    });
    renderHealth();
    return true;
  } catch (err) {
    console.error(err);
    toast('Could not build the font from these characters. Try redrawing any that look wrong on the Review screen.', true);
    return false;
  } finally {
    topload(false);
  }
}

function applyPreviewFont() {
  // The font exists now, so the placeholder has done its job.
  $('#preview-skeleton').hidden = true;
  const el = $('#preview-text');
  const bold = state.previewStyle.includes('Bold');
  const italic = state.previewStyle.includes('Italic');
  el.style.fontFamily = `'${PREVIEW_FAMILY}', cursive`;
  el.style.fontWeight = bold ? 700 : 400;
  el.style.fontStyle = italic ? 'italic' : 'normal';
  el.style.fontSize = `${state.previewSize}px`;
  // The font just changed, so what it is missing may have changed with it —
  // adding a sheet and rebuilding is exactly the case this has to notice.
  renderMissingNotice();
}

/**
 * Say which of the characters on screen the font does not have.
 *
 * A font built from the everyday sheet alone has no capitals and no digits, and
 * typing "Hello 2026" into the preview renders half of it in the reader's
 * system font — correctly, and with nothing anywhere saying so. The effect from
 * the other side of the screen is that the font looks broken on exactly the
 * screen where somebody is deciding whether it worked.
 *
 * Mild on purpose. This is not a warning about a mistake: a missing character
 * is a sheet not yet written, the substitute is the system font, and both of
 * those are fine. So it states the fact, names the characters, and says what
 * happens — no icon, no colour, no tone. --warn is for things that went wrong,
 * and nothing here has.
 *
 * Whitespace is excluded because a space is not a glyph anybody writes on a
 * sheet — it is derived from the width of the lowercase letters — and listing
 * it as missing would be both wrong and impossible to act on.
 */
function renderMissingNotice() {
  const el = $('#preview-missing');
  if (!el) return;

  const have = new Set(state.glyphs.map((g) => g.ch));
  if (!have.size) { el.hidden = true; return; }

  const text = $('#preview-text')?.textContent ?? '';
  // A Set, so "aaa" reports one missing character rather than three, and in
  // first-seen order, which is the order the reader's eye met them in.
  const missing = [...new Set([...text])].filter((ch) => !/\s/.test(ch) && !have.has(ch));

  if (!missing.length) { el.hidden = true; return; }

  const shown = missing.slice(0, 12);
  const rest = missing.length - shown.length;
  const list = shown.join(' ') + (rest ? ` and ${rest} more` : '');
  el.textContent = missing.length === 1
    ? `Your font does not have ${list} yet, so it is showing in your system font.`
    : `Your font does not have these yet, so they are showing in your system font: ${list}`;
  el.hidden = false;
}

function renderHealth() {
  const card = $('#health-card');
  card.replaceChildren();
  if (!state.health) return;

  const { score, findings } = state.health;
  const label = scoreLabel(score);

  const h = document.createElement('h3');
  h.textContent = 'Font health';
  card.append(h);

  const wrap = document.createElement('div');
  wrap.className = `score ${label.tone === 'good' ? '' : label.tone === 'ok' ? 'is-ok' : 'is-bad'}`;
  const circ = 2 * Math.PI * 22;
  wrap.innerHTML = `
    <div class="score-ring">
      <svg viewBox="0 0 52 52">
        <circle class="track" cx="26" cy="26" r="22" fill="none"/>
        <circle class="fill" cx="26" cy="26" r="22" fill="none"
                stroke-linecap="round"
                stroke-dasharray="${circ}"
                stroke-dashoffset="${circ * (1 - score / 100)}"/>
      </svg>
      <b>${score}</b>
    </div>
    <div class="score-text"><b></b><span></span></div>`;
  $('.score-text b', wrap).textContent = label.label;
  // `expected` is what the photographed sheets could have yielded, `possible`
  // the whole inventory. Saying "32 of 32" to someone who shot one sheet is
  // true and reads as complete, which it is; the second phrasing exists so it
  // does not also read as "there is nothing else to write".
  {
    const { captured, expected, possible } = state.health;
    $('.score-text span', wrap).textContent = expected >= (possible ?? expected)
      ? `${captured} of ${expected} characters`
      : `${captured} characters so far, of ${possible}`;
  }
  card.append(wrap);

  if (!findings.length) {
    const p = document.createElement('p');
    p.className = 'muted';
    p.textContent = 'Nothing to flag. This one came out clean.';
    card.append(p);
    return;
  }

  card.append(
    findingList(
      findings.map((f) => ({
        level: f.level,
        title: f.title,
        detail: f.detail,
        chars: f.chars ?? [],
      }))
    )
  );
}

function renderSamples() {
  const el = $('#preview-samples');
  el.replaceChildren(
    ...PREVIEW_SAMPLES.map((text) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip';
      b.textContent = text.length > 42 ? `${text.slice(0, 40)}…` : text;
      b.addEventListener('click', () => {
        $('#preview-text').textContent = text;
        renderMissingNotice();
      });
      return b;
    })
  );
}

// ---------------------------------------------------------------------------
// Export step
// ---------------------------------------------------------------------------

/** @returns {Promise<boolean>} whether the export screen is worth showing. */
async function prepareExport() {
  busy(true, 'Building all four styles', 0.15, 'family');
  try {
    const ok = await runCompile(false);
    // The failure has already been reported by runCompile. Landing on a screen
    // that says "Your font is ready" over nothing would contradict it.
    if (!ok) return false;
    busy(true, 'Packaging', 0.7);
    renderExport();
    // navigator.share() needs the click's transient activation, which a
    // multi-second zip build can outlive. Warmed only where a share button
    // will actually appear — elsewhere it is wasted work on the slowest
    // devices. Not awaited, and a failure here is silent: both the share and
    // the download path rebuild and report their own errors.
    if (canShareFont()) bundleNow().catch(() => {});
    return true;
  } finally {
    busy(false);
  }
}

function renderExport() {
  const name = state.settings.familyName || 'My Handwriting';
  const built = state.serialised ?? [];

  $('#export-sub').textContent =
    `${name} — four styles, ${built[0]?.charCount ?? 0} characters, built entirely on this device.`;
  $('#download-title').textContent = `${name}.zip`;

  $('#dl-individual').replaceChildren(
    ...built.map((s) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'dl-item';
      const strong = document.createElement('b');
      strong.textContent = s.style;
      const size = document.createElement('span');
      size.textContent = `${Math.round(s.otf.byteLength / 1024)} KB`;
      b.append(strong, size);
      b.addEventListener('click', () => {
        download(s.otf, `${slugify(name)}-${slugify(s.style)}.otf`, 'font/otf');
        toast(`${s.style} downloaded.`);
      });
      return b;
    })
  );
  stagger($('#dl-individual'));

  // Written from what was actually built, so the folder beside it cannot claim
  // a number of files the zip does not contain.
  const sep = $('#dl-separate-count');
  if (sep) {
    sep.textContent = built.length
      ? `${built.length} style${built.length === 1 ? '' : 's'}, as separate files.`
      : 'The styles, as separate files.';
  }

  const summary = $('#font-summary');
  summary.replaceChildren();
  const h = document.createElement('h3');
  h.textContent = 'Summary';
  const dl = document.createElement('dl');
  const rows = [
    ['Characters', String(built[0]?.charCount ?? 0)],
    ['Kerning pairs', String(built[0]?.kernCount ?? 0)],
    ['Variants per letter', String(state.settings.variantCount)],
    ['Natural slant', `${Math.round(state.naturalSlant)}°`],
    ['Health', String(state.health?.score ?? '—')],
  ];
  for (const [k, v] of rows) {
    const dt = document.createElement('dt');
    dt.textContent = k;
    const dd = document.createElement('dd');
    dd.textContent = v;
    dl.append(dt, dd);
  }
  summary.append(h, dl);

  $('#css-snippet').textContent = cssSnippet(name, built);
  renderInstall();
}

function renderInstall() {
  const install = state.modules.tutorial?.INSTALL ?? FALLBACK_INSTALL;
  const tabs = $('#os-tabs');
  tabs.replaceChildren(
    ...install.map((entry) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = entry.label;
      if (entry.os === state.os) b.classList.add('is-on');
      b.addEventListener('click', () => {
        state.os = entry.os;
        renderInstall();
      });
      return b;
    })
  );

  const entry = install.find((e) => e.os === state.os) ?? install[0];
  $('#install-steps').replaceChildren(
    ...entry.steps.map((s) => {
      const li = document.createElement('li');
      li.textContent = s;
      return li;
    })
  );
}

let dlResetTimer = null;

/**
 * Drive the download button's own progress ring.
 *
 * The ring is filled from real packaging progress rather than a timer, so it
 * physically cannot reach the checkmark before the zip exists. That is the
 * whole reason it replaces the generic overlay here: on the one screen where
 * the user is waiting for a specific artefact, the wait should be attached to
 * the thing producing it.
 */
function dlState(next, fill = null) {
  const btn = $('#dl-zip');
  const label = $('#dl-zip-label');
  if (fill !== null) {
    btn.style.setProperty('--dl-fill', `${Math.round(fill * 100)}%`);
    // The parcel's flaps fold shut on the same number, so the box cannot close
    // before the archive it depicts actually exists. 210deg is fully open.
    $('.parcel')?.style.setProperty('--dl-flap', `${(1 - Math.min(1, Math.max(0, fill))) * 210}deg`);
  }
  if (!next) return;

  btn.dataset.state = next;
  btn.disabled = next === 'working';
  label.textContent =
    next === 'working' ? 'Packaging…' : next === 'done' ? 'Downloaded' : 'Download';
}

/**
 * The one place a font bundle is built.
 *
 * Keyed on all three inputs that change what the zip contains:
 *
 *   serialised    a fresh array per full compile, so object identity is a
 *                 reliable build token
 *   familyName    changes with NO recompile, so it cannot be inferred from
 *                 `serialised`. There is a concrete path where this matters:
 *                 prepareExport calls runCompile, which returns early while
 *                 the rate limiter is holding it off — rename, come back to
 *                 Export while limited, and `serialised` keeps its identity
 *                 while the screen shows the new name. Without this key the
 *                 share would hand over a zip named after the old font.
 *   variantCount  reaches the bundled README through packageFamily
 *
 * The cached value is the PROMISE, not the zip, and the cache is populated
 * before this function returns — so a pre-warm and a click in the same tick
 * join one build instead of racing into two. A rejected build is evicted, or
 * every retry for the rest of the session would replay the same rejection.
 *
 * Progress is fanned out to whoever is listening rather than bound to the
 * first caller's callback. Caching the promise alone would mean the download
 * ring jumping straight from 0 to 100 on any build the pre-warm had already
 * started — which is precisely the common case.
 */
let bundleCache = null;

function bundleNow(onProgress) {
  const serialised = state.serialised;
  if (!serialised?.length) return Promise.reject(new Error('The font is not built yet.'));

  const familyName = state.settings.familyName || 'My Handwriting';
  const variantCount = state.settings.variantCount;

  const hit =
    bundleCache &&
    bundleCache.serialised === serialised &&
    bundleCache.familyName === familyName &&
    bundleCache.variantCount === variantCount
      ? bundleCache
      : null;

  if (hit) {
    if (onProgress) {
      // Already finished: the zip exists, so reporting it complete is true.
      if (hit.settled) onProgress(1);
      else hit.listeners.add(onProgress);
    }
    return hit.promise;
  }

  const entry = {
    serialised, familyName, variantCount,
    listeners: new Set(), settled: false, promise: null,
  };
  if (onProgress) entry.listeners.add(onProgress);

  entry.promise = packageFamily(
    familyName,
    serialised,
    { variantCount },
    (pct) => { for (const fn of entry.listeners) fn(pct); }
  ).then(
    (zip) => { entry.settled = true; entry.listeners.clear(); return zip; },
    (err) => {
      entry.listeners.clear();
      if (bundleCache === entry) bundleCache = null;
      throw err;
    }
  );

  bundleCache = entry;
  return entry.promise;
}

/**
 * Whether Web Share can actually take a zip here — not whether this looks like
 * a phone. An earlier attempt called itself mobile-only, which is not true:
 * desktop Chrome reports canShare({files}) as well.
 *
 * The probe carries the real MIME type, because canShare answers on the type
 * rather than on the bytes.
 */
function canShareFont() {
  if (typeof navigator.share !== 'function') return false;
  if (typeof navigator.canShare !== 'function') return false;
  if (typeof File !== 'function') return false;
  try {
    const probe = new File([new Uint8Array(0)], 'probe.zip', { type: 'application/zip' });
    return navigator.canShare({ files: [probe] });
  } catch {
    return false;
  }
}

let shareResetTimer = null;

async function shareFont() {
  const btn = $('#share-font');
  const label = $('#share-font-label');
  const live = $('#share-font-live');
  clearTimeout(shareResetTimer);

  const idle = () => {
    btn.dataset.state = 'idle';
    btn.disabled = false;
    label.textContent = 'Share';
    live.textContent = '';
  };
  const settle = (next, announce) => {
    btn.dataset.state = next;
    btn.disabled = false;
    label.textContent = next === 'done' ? 'Shared' : 'Share';
    live.textContent = announce;
    shareResetTimer = setTimeout(idle, 4000);
  };

  btn.dataset.state = 'working';
  btn.disabled = true;
  label.textContent = 'Preparing...';
  live.textContent = 'Preparing the font to share.';

  // Read the name after the build, from the same place bundleNow keys on, so
  // the file name and the zip contents cannot disagree.
  let file;
  const familyName = state.settings.familyName || 'My Handwriting';
  try {
    const zip = await bundleNow();
    file = new File([zip], `${slugify(familyName)}.zip`, { type: 'application/zip' });
  } catch (err) {
    console.error(err);
    settle('failed', 'Could not prepare the font to share.');
    toast('Could not package the font for download.', true);
    return;
  }

  try {
    await navigator.share({
      files: [file],
      title: `${familyName} - a font from my handwriting`,
      text: `${familyName}, made from my own handwriting.`,
    });
    settle('done', `${familyName} shared.`);
  } catch (err) {
    // Dismissing the share sheet is a choice, not a failure: no error, and no
    // download nobody asked for.
    if (err?.name === 'AbortError') { idle(); return; }
    // Anything else still owes them the font. Most often this is
    // NotAllowedError, because a cold zip build can outlast the click's
    // transient activation.
    console.error(err);
    download(file, file.name, 'application/zip');
    settle('failed', 'Sharing was refused, so the font was downloaded instead.');
    toast('Sharing was not allowed, so the font downloaded instead.');
  }
}

/**
 * The address of this app, or null when there isn't one.
 *
 * Deliberately not a hardcoded domain. This repo has no canonical URL, no
 * og:url and no production hostname; the one https link in index.html points
 * at the source. Inventing an address would be inventing a fact.
 *
 * base() covers the subdirectory deploy routes.js already reasons about — it
 * is derived from import.meta.url and returns '/' or '/repo' with no trailing
 * slash.
 */
function appLink() {
  if (location.protocol !== 'http:' && location.protocol !== 'https:') return null;
  const b = routeBase();
  return location.origin + (b === '/' ? '/' : `${b}/`);
}

let appLinkResetTimer = null;

async function copyAppLink() {
  const btn = $('#copy-applink');
  const result = $('#copy-applink-result');
  const field = $('#copy-applink-url');
  const live = $('#copy-applink-live');
  const link = appLink();
  if (!link) return;

  clearTimeout(appLinkResetTimer);

  let ok = false;
  try {
    // navigator.clipboard is undefined outright on an insecure origin, not
    // merely refused. The optional call turns that into the same failure path
    // as a denied permission instead of a TypeError.
    if (!navigator.clipboard?.writeText) throw new Error('no clipboard');
    await navigator.clipboard.writeText(link);
    ok = true;
  } catch {
    ok = false;
  }

  btn.dataset.state = ok ? 'done' : 'failed';
  result.textContent = ok ? 'Copied' : 'Could not copy';

  if (ok) {
    field.hidden = true;
  } else {
    // Put the link where it can be copied by hand, and select it. Telling
    // someone to select the text is useless when no text is on screen.
    field.value = link;
    field.hidden = false;
    field.select();
  }

  // The label swap is decoration as far as a screen reader is concerned; this
  // is the announcement, and it reports what happened rather than what was
  // clicked.
  live.textContent = ok
    ? 'Link to this app copied to the clipboard.'
    : 'Could not copy. The link is on screen and selected — press Control C, or Command C on a Mac.';

  appLinkResetTimer = setTimeout(() => {
    btn.dataset.state = 'idle';
    result.textContent = 'Copied';
    live.textContent = '';
    // The field stays on screen after a failure. Hiding the only copy of the
    // link a few seconds later would take the fallback away again.
  }, 2600);
}

async function downloadZip() {
  const name = state.settings.familyName || 'My Handwriting';
  // Above dlState('working'), deliberately: that call sets btn.disabled = true,
  // so returning after it would leave Download permanently dead. Without this
  // a failed build produced "Cannot read properties of null (reading '0')" in
  // a red toast, which tells the reader nothing they can act on.
  if (!state.serialised?.length) {
    // "Not finished yet" was untrue when no build had been started and none was
    // going to be. Do the work the press was asking for.
    const ok = await prepareExport();
    if (!ok) return;
  }
  clearTimeout(dlResetTimer);
  dlState('working', 0);
  try {
    // Same builder as the share button, so the two cannot deliver different
    // bytes for the same font, and pressing both does not build it twice.
    const zip = await bundleNow((pct) => dlState(null, pct));
    download(zip, `${slugify(name)}.zip`, 'application/zip');
    dlState('done', 1);
    toast('Downloaded. Open the zip and install the four .otf files.');

    // Return to idle so a second download is obviously available. Long enough
    // that the checkmark is read as confirmation, not a flicker.
    dlResetTimer = setTimeout(() => dlState('idle', 0), 4000);
  } catch (err) {
    console.error(err);
    // Failure must not leave a checkmark on screen.
    dlState('idle', 0);
    toast('Could not package the font for download.', true);
  }
}

// ---------------------------------------------------------------------------
// Guide
// ---------------------------------------------------------------------------

/** Built once per session, on first open. */
let docIndex = null;
let docLessons = null;

async function loadDocs() {
  if (docIndex) return;
  const mod = await loadModule('tutorial', './tutorial.js');
  docLessons = mod?.LESSONS ?? FALLBACK_LESSONS;
  docIndex = buildIndex({
    LESSONS: docLessons,
    FAQ: mod?.FAQ ?? FALLBACK_FAQ,
    INSTALL: mod?.INSTALL ?? FALLBACK_INSTALL,
  });
}

/** Closing note offering a way out when the docs do not have the answer. */
function guideFooter(query = '') {
  const foot = document.createElement('div');
  foot.className = 'guide-foot';

  const p = document.createElement('p');
  p.textContent = query
    ? 'Not what you were after?'
    : 'Something here unclear, or missing entirely?';

  const btn = document.createElement('button');
  btn.className = 'btn';
  btn.type = 'button';
  btn.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><use href="#i-info"/></svg>';
  btn.append(Object.assign(document.createElement('span'), { textContent: 'Send feedback' }));
  btn.addEventListener('click', () => feedbackFromGuide(query));

  foot.append(p, btn);
  return foot;
}

/**
 * Bring one lesson into view and put focus on it.
 *
 * 'instant' rather than 'smooth', which is how the step rail already does it:
 * with no animation there is nothing for prefers-reduced-motion,
 * :root[data-lite='on'] or :root[data-decor='off'] to suppress, so it is
 * correct under all three without a second branch.
 *
 * getElementById rather than a selector, so a lesson id never has to be escaped
 * for CSS on its way into a query.
 */
function showLesson(id) {
  const sec = document.getElementById(`lesson-${id}`);
  if (!sec) return;
  sec.scrollIntoView({ block: 'start', behavior: 'instant' });
  // preventScroll because the line above already chose the position; letting
  // focus scroll as well would fight it.
  sec.focus({ preventScroll: true });
}

/** The whole guide, as shown when the search box is empty. */
function renderLessons() {
  const body = $('#guide-body');
  body.replaceChildren(
    ...docLessons.map((lesson) => {
      const sec = document.createElement('section');
      sec.className = 'lesson';
      // A real element id so the lesson can be scrolled to and focused, and a
      // prefix so an authored id as ordinary as `what` cannot collide with
      // something else on the page that happens to use the same word.
      sec.id = `lesson-${lesson.id}`;
      // Focusable, so arriving from /guide/pen lands the caret on the lesson
      // rather than leaving it on the dialogue and the reader's eye elsewhere.
      sec.tabIndex = -1;

      const h = document.createElement('h3');
      h.textContent = lesson.title;

      // A real href, because this is the only way a reader obtains the address:
      // the bar says /guide until something writes the longer form, and the
      // context menu's copy-link works on an href and nothing else. The click is
      // intercepted — the guide is already open, and navigating would reload the
      // entire app to show a dialogue that is on screen. Same-origin, so
      // leaving.js does not treat it as an external link.
      const link = document.createElement('a');
      link.className = 'lesson-link';
      link.href = overlayPath('guide', lesson.id);
      link.setAttribute('aria-label', `Link to this section: ${lesson.title}`);
      link.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><use href="#i-link"/></svg>';
      link.addEventListener('click', (e) => {
        e.preventDefault();
        writeRoute({ overlay: 'guide', section: lesson.id });
        showLesson(lesson.id);
      });
      h.append(link);

      sec.append(h);
      for (const para of lesson.body) {
        const p = document.createElement('p');
        p.textContent = para;
        sec.append(p);
      }
      if (lesson.tips?.length) {
        const ul = document.createElement('ul');
        ul.className = 'tips';
        for (const tip of lesson.tips) {
          const li = document.createElement('li');
          li.textContent = tip;
          ul.append(li);
        }
        sec.append(ul);
      }
      return sec;
    })
  );
  stagger($('#guide-body'));
  $('#guide-body').append(guideFooter());
  $('#doc-count').textContent = '';
}

function renderResults(query) {
  const body = $('#guide-body');
  const count = $('#doc-count');
  const hits = searchDocs(docIndex, query);
  const ts = searchTerms(query);

  if (!hits.length) {
    count.textContent = '';
    const empty = document.createElement('div');
    empty.className = 'doc-empty';
    const strong = document.createElement('strong');
    strong.textContent = `Nothing matches “${query.trim()}”`;
    const p = document.createElement('p');
    p.textContent = 'Try a single word — “lighting”, “pen”, “windows”, “spacing”.';

    const ask = document.createElement('button');
    ask.className = 'btn';
    ask.type = 'button';
    ask.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><use href="#i-info"/></svg>';
    ask.append(Object.assign(document.createElement('span'), { textContent: 'Ask about this' }));
    ask.addEventListener('click', () => feedbackFromGuide(query));

    empty.append(strong, p, ask);
    body.replaceChildren(empty);
    return;
  }

  count.textContent = `${hits.length} result${hits.length === 1 ? '' : 's'} for “${query.trim()}”`;

  body.replaceChildren(
    ...hits.map((hit) => {
      const sec = document.createElement('article');
      sec.className = 'doc-result';

      const kind = document.createElement('span');
      kind.className = 'doc-kind';
      kind.textContent = hit.kindLabel;

      const h = document.createElement('h3');
      h.append(highlight(hit.title, ts));

      const p = document.createElement('p');
      p.append(highlight(hit.snippet, ts));

      sec.append(kind, h, p);
      return sec;
    })
  );
  stagger(body);
  body.append(guideFooter(query));
}

function runDocSearch() {
  const input = $('#guide-search');
  const q = input.value;
  $('#doc-clear').hidden = !q;
  if (!q.trim()) renderLessons();
  else renderResults(q);
}

/**
 * @param {object} [opts]
 * @param {boolean} [opts.route] write the address; false when restoring one
 * @param {string|null} [opts.section] lesson id, from `/guide/<id>`
 * @returns {string|null} the lesson actually shown, or null for the top of the
 *   guide. applyRoute corrects the address from this, so a section naming no
 *   lesson never survives in the address bar.
 */
async function openGuide({ route = true, section = null } = {}) {
  await loadDocs();
  const input = $('#guide-search');
  input.value = '';
  runDocSearch();
  openModal('#guide');

  // Checked against the list that actually loaded, not against a copy of the
  // ids kept here. tutorial.js and content.js do not name every lesson the
  // same, and content.js is what ships when tutorial.js fails to arrive — so a
  // hard-coded list would claim lessons that are not on the screen.
  const landed = section && docLessons.some((l) => l.id === section) ? section : null;
  if (route) writeRoute({ overlay: 'guide', section: landed });

  // The search box is the reason someone opened this themselves; give it the
  // caret. Someone who followed /guide/pen came for the lesson, so that gets it
  // instead — otherwise the address puts them at a heading and the keyboard
  // puts them somewhere else.
  if (landed) showLesson(landed);
  else input.focus();

  return landed;
}

// ---------------------------------------------------------------------------
// Feedback
// ---------------------------------------------------------------------------

const REPO = 'heistkit/handwriting';

/**
 * Recent errors, kept in memory only.
 *
 * Without these a bug report says "it didn't work", which is unactionable. With
 * them it usually says exactly which stage threw. They are shown to the user
 * before anything is sent.
 */
const errorLog = [];
function recordError(what) {
  errorLog.push(String(what).slice(0, 240));
  if (errorLog.length > 6) errorLog.shift();
}
/**
 * Say once, per session, that something broke.
 *
 * These two listeners existed and only wrote to an array that nothing read
 * unless the user happened to open the feedback panel. So a failure part-way
 * through a build was invisible: the interface simply stopped, with no
 * statement that anything had gone wrong at all.
 *
 * Once per session, because a single fault often fires the handler repeatedly
 * and six identical bars would be worse than none. The message says the two
 * things that are true and useful — something stopped, and nothing left the
 * device — and offers the panel where the detail already lives.
 */
let toldAboutError = false;
function announceError() {
  if (toldAboutError) return;
  toldAboutError = true;
  toast('Something stopped part-way through. Nothing was sent anywhere. If it keeps happening, Send feedback has the details.', true);
}

window.addEventListener('error', (e) => { recordError(e.message); announceError(); });
window.addEventListener('unhandledrejection', (e) => {
  recordError(e.reason?.message ?? e.reason);
  announceError();
});

/**
 * Assemble the diagnostic block.
 *
 * Deliberately contains no image data, no glyph outlines and no font bytes. It
 * does contain more than counts and settings: the browser's user-agent string,
 * two capability booleans, the current step and sheet ids, and up to six recent
 * error messages — which is why the dialogue lists those rather than claiming
 * "only the numbers". The user can read every line of it before deciding to
 * send, which is the only way a feedback button belongs in an app that promises
 * nothing leaves the device.
 */
function buildDiagnostics() {
  const s = state.settings;
  const lines = [
    `step             ${state.step}`,
    `sheets captured  ${[...state.captures.keys()].join(', ') || 'none'}`,
    `characters       ${state.glyphs.length}`,
    `health score     ${state.health?.score ?? '—'}`,
    `flagged          ${state.health?.findings?.map((f) => f.code).join(', ') || 'none'}`,
    `natural slant    ${Math.round(state.naturalSlant)}°`,
    '',
    `spacing          ${s.spacingFactor}`,
    `bold             ${s.boldStrength}`,
    `italic           ${s.italicAngle}°`,
    `variants         ${s.variantCount}`,
    `straighten       ${s.straighten}`,
    `kerning          ${s.kerning}`,
    '',
    `browser          ${navigator.userAgent}`,
    `viewport         ${innerWidth}×${innerHeight} @${devicePixelRatio}x`,
    `capabilities     CompressionStream=${typeof CompressionStream === 'function'}, OffscreenCanvas=${typeof OffscreenCanvas === 'function'}`,
  ];
  if (errorLog.length) lines.push('', 'recent errors', ...errorLog.map((e) => `  ${e}`));
  return lines.join('\n');
}

/**
 * The last text we put in the box ourselves.
 *
 * This is what separates "a draft the user is writing" from "a leftover we
 * generated". Without it, seeding the box once means every later visit opens
 * showing a search the user made ten minutes ago — while unconditionally
 * clearing it would throw away half-written reports.
 */
let lastAutofill = null;

/**
 * @param {string|null} [prefill] seed text, or null to leave the box alone
 * @param {object} [opts]
 * @param {boolean} [opts.route] write `/feedback`; false when the router is
 *   restoring that address and must not push a second entry for it
 */
function openFeedback(prefill = null, { route = true } = {}) {
  // Guard the seam anyway: this is one stray `addEventListener('click',
  // openFeedback)` away from writing "[object PointerEvent]" into the box.
  if (typeof prefill !== 'string') prefill = null;

  $('#fb-diagnostics').textContent = buildDiagnostics();
  const text = $('#fb-text');
  const ours = text.value === '' || text.value === lastAutofill;

  if (prefill !== null && ours) {
    text.value = prefill;
    lastAutofill = prefill;
  } else if (prefill === null && ours && lastAutofill !== null) {
    text.value = '';
    lastAutofill = null;
  }
  // Anything the user actually typed survives either branch.

  openModal('#feedback');
  if (route) writeRoute({ overlay: 'feedback' });
  text.focus();
  // Caret at the end, so a prefill reads as a starting point rather than
  // something to clear before typing.
  text.setSelectionRange(text.value.length, text.value.length);
}

/**
 * Open feedback from inside the guide.
 *
 * A search that returns nothing is the most useful signal a help page can
 * produce — it is a user telling you, in their own words, what the docs do not
 * cover. Seeding the report with the failed query captures that wording before
 * they rephrase it into something the docs already answer.
 */
function feedbackFromGuide(failedQuery = '') {
  closeModal('#guide');
  // No detour through the step: openFeedback moves the address straight from
  // /guide to /feedback, so Back from the report is the guide the reader came
  // from. The draft survives that — closeModal only hides the dialogue, and
  // openFeedback leaves the box alone once it holds anything the reader typed.
  openFeedback(
    failedQuery.trim()
      ? `I searched the guide for "${failedQuery.trim()}" and did not find an answer.\n\nWhat I was trying to do:\n`
      : ''
  );
}

function feedbackReport() {
  const written = $('#fb-text').value.trim() || '(no description given)';
  return `${written}\n\n---\n\n<details><summary>Diagnostics</summary>\n\n\`\`\`\n${buildDiagnostics()}\n\`\`\`\n\n</details>`;
}

// ---------------------------------------------------------------------------
// Landing page and legal documents
// ---------------------------------------------------------------------------

async function renderFAQ() {
  const mod = await loadModule('tutorial', './tutorial.js');
  const faq = mod?.FAQ ?? FALLBACK_FAQ;
  $('#faq-list').replaceChildren(
    ...faq.map((item, i) => {
      const d = document.createElement('details');
      d.className = 'faq-item';
      if (i === 0) d.open = true;
      const s = document.createElement('summary');
      s.textContent = item.q;
      const p = document.createElement('p');
      p.textContent = item.a;
      d.append(s, p);
      d.style.setProperty('--fold-i', String(Math.min(i, 8)));
      return d;
    })
  );
  // Built after init() ran, so they were never wired.
  enhanceFolds($('#faq-list'));
  observeReveal($('#faq-list'));
}

/**
 * Legal documents get real hash URLs so they can be linked to directly.
 *
 * App stores, payment processors and some jurisdictions expect a privacy policy
 * to live at a stable, shareable address. A modal with no URL cannot be cited,
 * so the hash is the routing even though this is a single page.
 */
/**
 * One control that opens or closes every article at once.
 *
 * This is not a convenience. Find-in-page reaches inside a closed <details> in
 * some browsers and not in others, so a reader hunting for a particular clause
 * cannot rely on Ctrl-F finding it while the articles are folded. This is how
 * they guarantee the whole document is on the page before they search it — and
 * it is why the folding is allowed to exist on a legal document at all.
 */
function expandAllControl(body) {
  const bar = document.createElement('div');
  bar.className = 'legal-tools';

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'btn btn-ghost';
  const label = document.createElement('span');
  label.textContent = 'Show every clause';
  btn.append(label);
  btn.setAttribute('aria-expanded', 'false');

  btn.addEventListener('click', () => {
    const all = [...body.querySelectorAll('details.legal-section')];
    // Recomputed each press rather than tracked, so that opening a few
    // articles by hand and then pressing this does the obvious thing.
    const opening = all.some((d) => !d.open);
    // Set directly, which bypasses fold.js: twenty-two panels animating at
    // once is a mess, and this press is about getting to the text.
    for (const d of all) d.open = opening;
    label.textContent = opening ? 'Collapse every article' : 'Show every clause';
    btn.setAttribute('aria-expanded', String(opening));
  });

  const hint = document.createElement('span');
  hint.className = 'legal-tools__hint';
  hint.textContent = 'Nothing is hidden — folding only affects what is on screen.';

  bar.append(btn, hint);
  return bar;
}

/**
 * Which of the three legal documents the shared `#legal` sheet is showing.
 *
 * The sheet is one element and its DOM id is `legal`, which is not an address —
 * only `privacy`, `terms` and `licenses` are. Anything that has to name the
 * sheet to the router therefore has to ask what is in it, and the tabs rewrite
 * that under the reader without the element changing at all.
 */
let legalShowing = DOCUMENTS[0].id;

function renderLegal(id) {
  const doc = documentById(id) ?? DOCUMENTS[0];
  // Recorded after the fallback, never from the argument: `documentById` is what
  // decides whether a name off the address bar is a document, and an id that is
  // not one has to leave this naming the document actually rendered.
  legalShowing = doc.id;
  $('#legal-title').textContent = doc.title;

  $('#legal-tabs').replaceChildren(
    ...DOCUMENTS.map((d) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = d.title;
      if (d.id === doc.id) b.classList.add('is-on');
      b.addEventListener('click', () => {
        renderLegal(d.id);
        writeRoute({ overlay: d.id, replace: true });
      });
      return b;
    })
  );

  const body = $('#legal-body');
  body.replaceChildren();

  const summary = document.createElement('p');
  summary.className = 'legal-summary';
  summary.textContent = doc.summary;
  body.append(summary);

  // The Terms run to 22 articles and 111 clauses, which as one column of prose
  // is a wall nobody reads. Folding it gives the articles back as a contents
  // list you can scan.
  //
  // Privacy and Licences are deliberately left open. A privacy page whose
  // disclosures are collapsed by default is worse than one that is long — the
  // whole point of it is that the answer is in front of you, not one click
  // away.
  //
  // The test is numbering, not length. A first attempt used a section count,
  // and Privacy has fifteen sections, so it folded too — the exact outcome the
  // paragraph above rules out. Numbered clauses are what make a document a
  // reference you navigate rather than prose you read, and that is the property
  // worth folding. It still decides itself: number the Licences page one day
  // and it folds, with no list of document names to keep in step.
  const numbered = doc.sections.filter((s) => s.body.some((p) => /^\d+\.\d+\s/.test(p)));
  const foldSections = numbered.length > 6;
  if (foldSections) body.append(expandAllControl(body));

  for (const [index, section] of doc.sections.entries()) {
    const sec = document.createElement(foldSections ? 'details' : 'section');
    sec.className = 'legal-section';
    // A stable handle on each section, so a link elsewhere can name the part
    // of the document it is actually about. Derived from the heading rather
    // than authored: legal.js is a list of headings and paragraphs and has no
    // ids, and adding a parallel set of them would be two things to keep in
    // step for the sake of one link.
    sec.dataset.section = slug(section.heading);
    // The first article is left open so the document does not open as a
    // stack of closed boxes with no visible prose at all.
    if (foldSections && index === 0) sec.open = true;

    // A <summary> is not a heading, and losing the h3s would flatten a
    // 22-article document to a single level in the outline. Nesting the
    // heading inside the summary keeps both.
    const h = document.createElement('h3');
    h.textContent = section.heading;
    if (foldSections) {
      const sum = document.createElement('summary');
      sum.append(h);
      sec.append(sum);
    } else {
      sec.append(h);
    }
    for (const para of section.body) {
      const p = document.createElement('p');
      // A numbered clause gets its number pulled out into its own column, so
      // the prose aligns down the left edge and "11.2" can be found by eye
      // rather than by reading. Anything unnumbered renders as a plain
      // paragraph — the Privacy and Licences documents are not numbered.
      const clause = /^(\d+\.\d+)\s+([\s\S]+)$/.exec(para);
      if (clause) {
        p.className = 'clause';
        const n = document.createElement('b');
        n.textContent = clause[1];
        const t = document.createElement('span');
        t.textContent = clause[2];
        p.append(n, t);
      } else {
        p.textContent = para;
      }
      sec.append(p);
    }
    body.append(sec);
  }

  if (foldSections) enhanceFolds(body);

  const meta = document.createElement('p');
  meta.className = 'legal-meta';
  meta.textContent = `Version ${LEGAL_VERSION} — last updated ${LEGAL_UPDATED}. This document describes what the code in this repository actually does; you can verify it by reading the source or by watching your browser's network tab, which stays empty.`;
  body.append(meta);
}

/** A heading, as something a link can name. */
const slug = (heading) =>
  heading.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/**
 * Open a legal document, optionally at one section of it.
 *
 * The section argument exists because of one link. Settings said "Everything
 * that gets stored", and clicking it opened fifteen sections of privacy policy
 * at the top — with "What is stored on your device" ninth down the page. The
 * document loaded every time; the thing the reader asked for did not, which
 * from the other side of the screen is indistinguishable from it being broken.
 *
 * Named by heading rather than by index, so re-ordering the policy cannot
 * silently repoint the link at whatever is ninth now. A name that matches
 * nothing scrolls nowhere and leaves the document at the top, which is exactly
 * where it used to start.
 */
function openLegal(id, section = null) {
  renderLegal(id);
  openModal('#legal');
  writeRoute({ overlay: id });
  if (section) revealLegalSection(section);
}

function revealLegalSection(name) {
  const sec = $(`#legal-body [data-section="${CSS.escape(name)}"]`);
  if (!sec) return;
  // Folded documents open the named section; unfolded ones have nothing to
  // open.
  if (sec.tagName === 'DETAILS') sec.open = true;

  // No requestAnimationFrame around this, deliberately. The obvious shape is to
  // wait a frame so `open` has been laid out before scrolling — but rAF does not
  // fire at all in a hidden tab, so anything behind one is a step that silently
  // never happens, which is how the build once came to hang forever. It is also
  // unnecessary: scrollIntoView forces layout itself, so it reads the height the
  // section has now rather than the one it had a moment ago.
  //
  // Smooth only where motion is wanted. A smooth scroll is an animation, and
  // the two switches that turn animation off in this app mean it — while
  // `behavior: 'auto'` jumps, which is both what a reader who asked for less
  // motion should get and the only version that happens at all in a tab the
  // compositor has stopped painting.
  const still = document.documentElement.dataset.lite === 'on'
    || document.documentElement.dataset.decor === 'off'
    || (typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches);
  sec.scrollIntoView({ block: 'start', behavior: still ? 'auto' : 'smooth' });

  // Marked as well as scrolled to. On a fifteen-section document a jump is
  // ambiguous about which of the headings now on screen was the one asked for.
  sec.classList.add('is-targeted');
  setTimeout(() => sec.classList.remove('is-targeted'), 2200);
}

const LEGAL_IDS = DOCUMENTS.map((d) => d.id);

/**
 * Modal open/close, with the page behind made inert.
 *
 * Every dialogue already carried `aria-modal="true"`, which tells assistive
 * technology that the rest of the page is unavailable — and does nothing at all
 * about Tab. Seventeen controls behind each open dialogue were still reachable
 * by keyboard, so tabbing out of the Settings panel walked into the page under
 * it, invisibly, with the overlay still covering everything.
 *
 * `inert` is the honest fix rather than a keydown handler that cycles focus
 * between the first and last elements: it removes the subtree from the tab
 * order *and* the accessibility tree, so the two agree, and it needs no
 * knowledge of which descendants happen to be focusable today.
 *
 * Focus is returned to whatever opened the dialogue. Without that, closing one
 * drops focus onto <body> and the next Tab starts again from the top of the
 * page — which for a keyboard user means losing their place every time they
 * look something up.
 */
const INERT_WHILE_OPEN = ['.topbar', 'main', '.footer', '.skip'];

/**
 * Which dialogues are open, innermost last.
 *
 * A stack rather than a boolean because they nest: the Privacy link inside
 * Settings opens the legal sheet on top of it. With only "is anything open?"
 * to go on, the outer dialogue stayed tabbable underneath the inner one — two
 * dialogues in the tab order at once, which is the same defect as the page
 * being reachable, one level in.
 */
const modalStack = [];

/** Whatever had focus before the outermost dialogue opened. */
let returnFocusTo = null;

/**
 * Inert everything except the innermost open dialogue.
 *
 * `inert` rather than a keydown handler that cycles focus between the first and
 * last focusable child: it takes the subtree out of the tab order *and* the
 * accessibility tree, so the two agree, and it needs no knowledge of which
 * descendants happen to be focusable today. Every dialogue already claimed
 * `aria-modal="true"`, which says the rest of the page is unavailable and does
 * nothing whatsoever about Tab.
 */
function applyInert() {
  const top = modalStack[modalStack.length - 1] ?? null;

  // Two independent reasons the page can be unavailable, combined additively.
  // Gating one on the absence of the other inverts it: with a dialogue open,
  // busy(true) would then *remove* inert and re-expose the page behind it.
  const shut = Boolean(top) || busyOpen;

  // Without this the reader can wheel the page behind an open dialogue and
  // watch the whole app slide about underneath it, with two scrollbars on
  // screen at once.
  document.documentElement.classList.toggle('modal-open', shut);

  for (const sel of INERT_WHILE_OPEN) {
    const el = $(sel);
    if (!el) continue;
    el.toggleAttribute('inert', shut);
  }
  for (const m of $$('.sheet-modal')) {
    m.toggleAttribute('inert', m !== top);

    // Paint order has to follow the stack, and it did not.
    //
    // Every dialogue sits at the same z-index, so which one covered which was
    // decided by document order — and `#settings` is written after `#legal`.
    // The "What's stored?" link inside Settings therefore opened the privacy
    // document *underneath* the panel it was clicked from, and the line above
    // dutifully marked Settings inert because it was no longer the innermost
    // dialogue. What the reader got was the Settings panel still on screen and
    // no longer responding to anything: the erase button dead, the autosave
    // switch dead, and the document they asked for invisible behind it. Three
    // separate bug reports, all of them this.
    //
    // Driven off the stack rather than a fixed pair of values so that the
    // arrangement cannot go stale: whatever is innermost paints highest, for any
    // dialogue nested in any other. Two per level leaves room for a backdrop.
    const depth = modalStack.indexOf(m);
    if (depth < 0) m.style.removeProperty('z-index');
    else m.style.zIndex = String(60 + depth * 2);
  }
}

/** The innermost open dialogue, or null. */
const topModal = () => modalStack[modalStack.length - 1] ?? null;

/**
 * The DOM ids of the dialogues that own an address.
 *
 * Not derivable from ROUTED_OVERLAYS below: that list is route ids, and the
 * three legal documents share one `#legal` element between them. Kept as one
 * constant because this set is consulted from three places — closing them all,
 * finding the innermost one that owns an address, and deciding whether a
 * dismissal has to move the address — and the failure mode of three literals is
 * a dialogue added to two of them, which closes without its address following
 * it. Escape and a backdrop click used to consult it directly as well; they go
 * through closeOverlay now, for reasons written there.
 */
const ROUTED_MODAL_IDS = ['guide', 'legal', 'settings', 'feedback'];

/** The innermost open dialogue that owns an address, or null. */
const topRoutedModal = () =>
  [...modalStack].reverse().find((m) => ROUTED_MODAL_IDS.includes(m.id)) ?? null;

/**
 * The address id of an open dialogue.
 *
 * Every dialogue but one answers with its own DOM id, because for those the two
 * vocabularies happen to coincide. The legal sheet is where they part: three
 * documents share one `#legal` element, and `legal` names no address, so handing
 * it to writeRoute finds no path and returns without writing anything. That
 * failure is silent — the dialogue closes and the address simply stays where it
 * was, pointing at the document that is no longer on screen. Nothing routed
 * opens on top of the legal sheet today, so this is a seam being held rather
 * than a fault being repaired; it is held because the seam is one line wide and
 * the day it tears there will be nothing on screen to say why.
 */
const routeIdOf = (el) => (el.id === 'legal' ? legalShowing : el.id);

function openModal(sel) {
  const el = $(sel);
  if (!el || !el.hidden) return;
  // Only the outermost open records the opener. An inner dialogue that recorded
  // it would send focus, on close, to a control inside a dialogue that is still
  // covered by nothing — but the outer one is what the reader came from.
  if (!modalStack.length) returnFocusTo = document.activeElement;
  el.hidden = false;
  modalStack.push(el);
  applyInert();
  // A document-shaped dialogue has nothing focusable in its prose, so focus
  // landing on the close button leaves PageDown scrolling the page behind
  // instead of the document. The body is made focusable for exactly this.
  (el.querySelector('.modal-body[tabindex]') ?? el.querySelector('.btn-icon'))?.focus();
}

function closeModal(sel) {
  const el = $(sel);
  if (!el || el.hidden) return;
  el.hidden = true;

  // The repair pad holds a document-level keydown listener; hiding the dialogue
  // is not what releases it.
  if (sel === '#draw-modal') {
    repairPad?.destroy?.();
    repairPad = null;
  }

  const at = modalStack.indexOf(el);
  if (at >= 0) modalStack.splice(at, 1);
  applyInert();

  if (modalStack.length) {
    // Back to the dialogue underneath, not to the page.
    const under = modalStack[modalStack.length - 1];
    (under.querySelector('.modal-body[tabindex]') ?? under.querySelector('.btn-icon'))?.focus();
    return;
  }

  // isConnected guards the case where the opener sat inside something since
  // re-rendered — focusing a detached node silently does nothing, and leaves
  // focus on <body> so the next Tab restarts from the top of the page.
  if (returnFocusTo?.isConnected) returnFocusTo.focus();
  returnFocusTo = null;
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

/**
 * Overlays that own an address, by route id.
 *
 * The redraw canvas still does not, and should not: it is a scratch surface
 * bound to one glyph selected on the Review screen, and an address that reopened
 * it would name a pad for a glyph that does not exist on a cold load.
 *
 * Feedback used to be excluded on the same grounds — that it holds unsaved
 * input. That reasoning does not survive reading the code it describes.
 * closeModal hides the dialogue and never touches its fields, and openFeedback
 * treats `#fb-text` as the reader's the moment it holds anything other than
 * what we put there (`const ours = text.value === '' || text.value === lastAutofill;`),
 * so closing and reopening restores the draft rather than replacing it. What
 * the exclusion actually bought was one dialogue where Back does nothing while
 * Back closes every other one, and no way to link to it at all.
 */
const ROUTED_OVERLAYS = ['guide', 'settings', 'feedback', ...LEGAL_IDS];

function closeRoutedOverlays() {
  // Through closeModal, never by writing `.hidden`. Hiding a dialogue behind
  // the stack's back leaves its entry on the stack, so applyInert() is never
  // re-run and `main` keeps the `inert` attribute — which removes pointer
  // input as well as focus. The page goes dead with nothing on screen to
  // explain it, and no route out from inside the app, because closeModal
  // early-returns on an already-hidden element so the entry can never drain.
  for (const id of ROUTED_MODAL_IDS) closeModal(`#${id}`);
}

/**
 * Put the screen where the address says. Never pushes history — the address is
 * already correct, except where it names something unreachable, in which case
 * it is *replaced* so Back does not bounce off the rejected entry forever.
 */
async function applyRoute() {
  const { step, overlay, section, fromHash } = readRoute();

  closeRoutedOverlays();

  if (overlay && ROUTED_OVERLAYS.includes(overlay)) {
    // What the dialogue could actually show, which is null everywhere except a
    // guide address whose section names a lesson that loaded.
    let landed = null;
    if (overlay === 'guide') landed = await openGuide({ route: false, section });
    else if (overlay === 'settings') openModal('#settings');
    else if (overlay === 'feedback') openFeedback(null, { route: false });
    else {
      renderLegal(overlay);
      openModal('#legal');
    }
    // Upgrade a shared #privacy link to /privacy in place, and drop a section
    // that names no lesson: /guide/nonsense is the guide, at the top, reading
    // /guide. Replaced rather than pushed, for the same reason the step branch
    // below replaces — a pushed correction makes Back return to the address
    // that was just rejected and bounce forward again.
    if (fromHash || landed !== section) writeRoute({ overlay, section: landed, replace: true });
    describeScreen({ overlay });
    return;
  }

  // Compared against `step`, not against a defaulted copy of it: `/nonsense`
  // reads as step null, and defaulting first made `landed !== wanted` false, so
  // the Start screen rendered under an address that names nothing.
  const wanted = step ?? 'start';
  const named = step !== null;
  // Nothing about a session is stored, so /refine on a cold load has no font to
  // show. Landing on the furthest screen that does work is honest; rendering an
  // empty Refine and letting the reader wonder what broke is not.
  // Export is gated twice, and reachable() can only answer the first half: it
  // knows a font was compiled at some point, not that the compiled font matches
  // the settings on screen. goto() asks the same second question and can fix a
  // 'no' by building; this path cannot, because it also runs during init and on
  // every popstate, where a multi-second four-style build is not something the
  // reader asked for. So it lands on the furthest honest screen and rewrites the
  // address to match — the same treatment every other unreachable step gets two
  // lines below.
  const canLand = wanted === 'export'
    ? reachable(wanted) && !!state.serialised?.length
    : reachable(wanted);
  const landed = canLand ? wanted : furthestReachable();
  applyStep(landed);
  if (landed !== wanted || !named || fromHash) writeRoute({ step: landed, replace: true });
  // Told what was landed on, not what was asked for. An address naming a step
  // nobody can reach cold lands somewhere else, and a tab that names the screen
  // the reader typed rather than the one in front of them is a worse lie than
  // no title at all.
  describeScreen({ step: landed });
}

/**
 * Close a dialogue and put the address back on whatever the reader is left
 * looking at.
 *
 * This was closeModal followed by an unconditional `writeRoute({ step })`, which
 * is right for the ordinary case and wrong for the only case where dialogues
 * nest. The Privacy link inside Settings opens the legal sheet on top of
 * Settings, so dismissing the legal sheet leaves Settings on screen — and the
 * address went to the step underneath it, `/write` or `/` or wherever the reader
 * had got to, naming a screen they are not looking at and saying nothing about
 * the panel still in front of them. Reload, bookmark or share that address and
 * it is taken literally: the panel is gone.
 *
 * The asymmetry is worth naming, because it is how this survived being read
 * several times. Escape and a backdrop click were written afterwards, with the
 * nesting already understood, and both ask what is left underneath before they
 * touch the address. The close buttons were written when nothing nested and were
 * never revisited, so three paths that dismiss the same dialogue held three
 * opinions about the address — and the one the mouse reaches first was the wrong
 * one. All three come through here now, which is also what stops a fourth
 * opinion growing the next time a dialogue is added.
 *
 * The remaining path is the router, and it agrees by construction: applyRoute
 * tears every routed dialogue down and rebuilds only what the address names, so
 * it cannot leave one on screen unaccounted for.
 */
function closeOverlay(sel) {
  const el = $(sel);
  // Whether the address has to move is a property of the dialogue being closed,
  // not of the stack. A backdrop click arrives here for every `.sheet-modal`,
  // including the redraw pad and the leaving interstitial, and those two own no
  // address to give back — writing one would drop a history entry for a
  // dialogue that deliberately has none.
  const owned = Boolean(el) && ROUTED_MODAL_IDS.includes(el.id);
  closeModal(sel);
  if (!owned) return;

  // Asked after closeModal, which is what drains the stack: before it, the
  // dialogue being closed is still the innermost one and this would hand back
  // the address that is on its way out.
  const beneath = topRoutedModal();
  // Peeling the legal sheet off Settings leaves Settings on screen, so the
  // address has to name Settings — not stay at /privacy, which a reload would
  // then take literally. Replaced rather than pushed: the reader has not gone
  // anywhere new, they have come back to the entry they were already on, and a
  // pushed copy of it makes Back a press that changes nothing.
  if (beneath) writeRoute({ overlay: routeIdOf(beneath), replace: true });
  else writeRoute({ step: state.step });
}

/**
 * The indeterminate top bar, reference-counted.
 *
 * Two overlapping operations must not have the first one to finish hide the
 * bar out from under the second, which is what a plain boolean would do.
 */
let loadDepth = 0;
function topload(on) {
  loadDepth = Math.max(0, loadDepth + (on ? 1 : -1));
  $('#topload').hidden = loadDepth === 0;
}

/** Load an optional module once, tolerating its absence. */
/**
 * Load an optional module once.
 *
 * The failure used to be cached alongside the success: a single dropped
 * request — one flaky moment on a train — marked the module `undefined` for the
 * rest of the session, and every later attempt returned that immediately
 * without ever trying again. The slot is now left untouched on failure, so the
 * next call is a real retry.
 *
 * The distinction between "this build does not have it" and "this request did
 * not arrive" is worth keeping, because only one of them is worth retrying and
 * the interface was telling everyone it was the first.
 */
async function loadModule(key, path) {
  if (state.modules[key] !== null && state.modules[key] !== undefined) return state.modules[key];
  topload(true);
  try {
    state.modules[key] = await import(path);
  } catch (err) {
    console.error(`Could not load ${path}`, err);
    recordError(`module ${key} failed to load`);
    // Deliberately left null rather than undefined: null is this map's "not
    // asked for yet", which is exactly what a failed attempt should leave
    // behind if the next press is to try again.
    state.modules[key] = null;
  } finally {
    topload(false);
  }
  return state.modules[key];
}

function detectOS() {
  const ua = navigator.userAgent;
  if (/iPhone|iPad|iPod/.test(ua)) return 'ios';
  if (/Android/.test(ua)) return 'android';
  if (/Mac OS X/.test(ua)) return 'macos';
  if (/Linux/.test(ua)) return 'linux';
  return 'windows';
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

function bindControls() {
  const bind = (sel, key, format, transform = Number) => {
    const input = $(sel);
    const out = $(`#out-${key}`);
    const sync = () => {
      state.settings[key === 'variants' ? 'variantCount' : mapKey(key)] = transform(input.value);
      if (out) out.textContent = format(input.value);
    };
    sync();
    input.addEventListener('input', () => {
      sync();
      scheduleRecompile();
    });
  };

  // Paint every track's fill from its value, and keep it painted while dragging.
  mountSliders();

  bind('#ctl-spacing', 'spacing', (v) => `${Math.round(v * 100)}%`);
  // Whole units of the 1000-unit em, because that is the number a reader can
  // relate to the preview beside it. Zero reads as "as written" rather than
  // "0 units", since the whole point of the default is that nothing was added.
  bind('#ctl-stroke', 'stroke', (v) =>
    Number(v) === 0 ? 'as written' : `+${(v * 1000).toFixed(0)} units`);
  bind('#ctl-bold', 'bold', (v) => `${(v * 1000).toFixed(0)} units`);
  bind('#ctl-italic', 'italic', (v) => `${v}°`);
  bind('#ctl-variants', 'variants', (v) => (v === '1' ? 'off' : `${v} per letter`));

  $('#ctl-straighten').addEventListener('change', (e) => {
    state.settings.straighten = e.target.checked;
    scheduleRecompile();
  });
  $('#ctl-kerning').addEventListener('change', (e) => {
    state.settings.kerning = e.target.checked;
    scheduleRecompile();
  });
  $('#family-name').addEventListener('input', (e) => {
    state.settings.familyName = e.target.value.trim() || 'My Handwriting';
    // No preview rebuild — the name is nowhere in the specimen — but the name IS
    // compiled into every style's name table, so the built font is stale all the
    // same. Without this line, renaming after a full build produced a zip, a CSS
    // snippet and a README all carrying the new name, wrapped around four .otf
    // files that still introduced themselves to the font menu by the old one.
    state.serialised = null;
  });

  $('#preview-size').addEventListener('input', (e) => {
    state.previewSize = Number(e.target.value);
    applyPreviewFont();
  });

  $$('.seg [data-style]').forEach((btn) => {
    btn.addEventListener('click', () => {
      $$('.seg [data-style]').forEach((b) => b.classList.toggle('is-on', b === btn));
      state.previewStyle = btn.dataset.style;
      applyPreviewFont();
      // The other styles may not be compiled yet during tuning.
      if (!state.serialised) scheduleRecompile();
    });
  });
}

function mapKey(key) {
  return {
    spacing: 'spacingFactor',
    bold: 'boldStrength',
    stroke: 'strokeWeight',
    italic: 'italicAngle',
  }[key] ?? key;
}

function init() {
  // First, and its result is deliberately ignored: the gate is a warning with a
  // door, so the app sets itself up behind it either way. Anything the missing
  // capability is needed for is guarded at its own call site.
  runBrowserGate();

  // Before anything renders. Every hover rule in the stylesheet is scoped to
  // the attribute this maintains, so a screen built before it is settled is a
  // screen where nothing responds to the mouse.
  initPointer();

  renderSteps();
  renderSheets();
  renderCaptureList();
  renderSamples();
  renderFAQ();
  bindControls();

  // Theme and lite each have two controls now — the quick one in the chrome and
  // the labelled one in Settings. They write to the same store, so each has to
  // re-read after the other moves; otherwise opening Settings shows a switch
  // that disagrees with the page it is sitting on.
  //
  // The Settings one is now three-way — System, Light, Dark — while the header
  // stays a two-way flip, so they do not mirror each other exactly. Flipping the
  // header from System picks a side, which the three-way control has to be told
  // about; picking System writes no side at all, and the header then has to
  // re-read what the operating system resolved to. Hence a listener each way
  // rather than one shared handler.
  const theme = bindThemeCycle($('#theme-cycle'));
  const themeSetting = bindThemeChoice($('#set-theme'));
  $('#theme-cycle').addEventListener('themechange', () => themeSetting?.sync());
  $('#set-theme').addEventListener('themechange', () => theme?.sync());

  const lite = bindLite($('#lite-toggle'));
  const liteSetting = bindLiteCheckbox($('#set-lite'));
  const afterLite = () => {
    liteSetting?.sync();
    lite?.sync();
    // Turning lite on mid-page must not leave elements stranded below the fold
    // with their reveal still pending, since the observer stops mattering the
    // moment the transition is cut to nothing.
    if (document.documentElement.dataset.lite === 'on') revealAll();
    else observeReveal();
  };
  $('#lite-toggle').addEventListener('click', afterLite);
  $('#set-lite').addEventListener('change', afterLite);

  bindTextSize($('#set-textsize'));

  /*
   * Autosave, and the control that undoes it.
   *
   * The size line is refreshed whenever Settings opens rather than kept live —
   * it is read from the database, and a figure that is a few seconds stale is
   * not worth a subscription to keep exact.
   */
  {
    const toggle = $('#set-autosave');
    const size = $('#set-forget-size');
    const forget = $('#set-forget');

    const describeSize = async () => {
      const bytes = await session.weigh();
      if (!bytes) { size.textContent = 'Nothing is being kept at the moment.'; return; }
      const kb = Math.max(1, Math.round(bytes / 1024));
      size.textContent = kb >= 1024
        ? `About ${(kb / 1024).toFixed(1)} MB is being kept on this device.`
        : `About ${kb} KB is being kept on this device.`;
    };

    toggle.checked = session.enabled();
    toggle.addEventListener('change', () => {
      session.setEnabled(toggle.checked);
      // Turning it off has to remove what is already there. Leaving the last
      // snapshot behind would mean the switch says "not keeping anything" while
      // the previous session sits in the database, which is the one thing
      // somebody flipping this switch is trying to prevent.
      if (!toggle.checked) session.forget().then(describeSize);
      else { saveSession(); describeSize(); }
    });

    forget.addEventListener('click', async () => {
      await session.forget();
      await describeSize();
      toast('Saved work forgotten.');
    });

    // Refreshed each time the panel is opened.
    $('#open-settings')?.addEventListener('click', describeSize);
    describeSize();
  }

  // The two decoration switches. Already applied pre-paint by the inline script
  // in <head>; this call only normalises the case where storage was unreadable
  // then and readable now, which costs nothing and keeps one source of truth.
  initFlourish();
  bindFlourish('fold', $('#set-fold'));
  bindFlourish('decor', $('#set-decor'));

  // The specimen draws itself once from CSS alone; this only replays it after
  // it has been still for a while, and only while it is on screen in a visible
  // tab. With this line removed the sheet still draws once and stays drawn.
  const specimen = loopSpecimen($('.spec'));

  // The deck already swipes and arrow-keys without this; it adds the buttons.
  mountStepshow($('#stepshow'));

  // Nothing here carries meaning, and the interface is identical without it.
  mountEggs({ specimen });

  // The ink drop watches the pointer. Fine pointers only, and only the card
  // actually on screen.
  mountMascot();

  // Every <details> in the document, plus anything rendered later — renderFAQ,
  // the guide and the health report each call this again for their own subtree.
  enhanceFolds();

  // Module level, once. renderReview has no teardown, so subscribing from
  // inside it would pile up a listener per visit to the screen.
  onPaletteChange(() => { if (state.step === 'review') renderReview(); });



  // Called straight out rather than from requestAnimationFrame. reveal.js reads
  // getBoundingClientRect, which forces layout itself, so there is nothing to
  // wait for — and rAF does not fire at all in a background tab, which would
  // leave a page opened in one with no reveal bound until it was looked at.
  observeReveal();

  // Benchmark once, after first paint, so it never delays the page appearing.
  // On a device that looks like it will struggle, lite mode is turned on for
  // them — but only if they have not already expressed a preference, and they
  // are told it happened rather than finding the interface quietly different.
  // `requestIdleCallback?.()` throws ReferenceError when the global is absent —
  // optional call syntax guards a null value, not an undeclared binding. It sat
  // above every line of routing, link and keyboard wiring in init(), so on
  // Safari 16.3 and earlier the page rendered and nothing worked.
  const idle = typeof requestIdleCallback === 'function'
    ? requestIdleCallback
    : (fn) => setTimeout(fn, 1200);
  idle(() => {
    const note = slowDeviceNote(profile());
    if (note && !liteChosen()) {
      applyLite('on');
      lite?.sync();
      liteSetting?.sync();
      toast(note, true);
    }
  }, { timeout: 2500 });

  $('#guide-search').addEventListener('input', runDocSearch);
  $('#guide-search').addEventListener('keydown', (e) => {
    // Esc clears a query first, and only closes the modal when already empty —
    // otherwise one keystroke throws away both the search and the page.
    if (e.key === 'Escape' && e.target.value) {
      e.stopPropagation();
      e.target.value = '';
      runDocSearch();
    }
  });
  $('#doc-clear').addEventListener('click', () => {
    const input = $('#guide-search');
    input.value = '';
    runDocSearch();
    input.focus();
  });

  $('#brand-home').addEventListener('click', () => goto('start'));

  $$('[data-legal]').forEach((a) =>
    a.addEventListener('click', (e) => {
      e.preventDefault();
      // No replaceState here. It was left over from the fragment design and
      // stamped `#privacy` onto the entry the reader came *from*, so Back read
      // the hash, re-opened the document, and overwrote that entry — the page
      // they started on stopped being reachable by Back at all.
      openLegal(a.dataset.legal, a.dataset.legalSection || null);
    })
  );
  $('#close-legal').addEventListener('click', () => closeOverlay('#legal'));

  // Back and Forward mean what they mean everywhere else.
  window.addEventListener('popstate', () => { applyRoute(); });
  window.addEventListener('hashchange', () => { applyRoute(); });

  /*
   * Pick up where they left off.
   *
   * applyRoute() runs first and unconditionally, so a visitor with nothing
   * saved — which is most of them, and all of them on a first visit — gets the
   * page they asked for with no delay waiting on a database. The restore then
   * arrives a moment later and re-routes only if there is genuinely something
   * to come back to.
   *
   * The address is respected rather than overridden. Somebody who followed a
   * link to /guide wanted the guide, and moving them to Review because a
   * database had a row in it would be the app deciding it knows better. Only a
   * bare arrival at the root is treated as "carry on".
   */
  applyRoute();

  session.load().then((record) => {
    if (!record) return;
    restoreSession(record);
    renderCaptureList();
    renderReview();
    const asked = readRoute();
    if (!asked.overlay && (asked.step === null || asked.step === 'start')) {
      const landing = reachable(record.step) ? record.step : furthestReachable();
      if (landing !== 'start') {
        goto(landing);
        toast(`Picked up where you left off — ${state.glyphs.length} characters.`);
      }
    }
  });

  const preview = $('#preview-text');
  preview.dataset.placeholder = 'Type something…';
  preview.textContent = PREVIEW_SAMPLES[0];
  // On every keystroke rather than on blur: the reader types a capital, sees it
  // come out in a different hand, and the line explaining why has to already be
  // there — after they have stopped and looked away is too late to be the
  // answer to the question they just asked.
  preview.addEventListener('input', renderMissingNotice);

  $$('[data-goto]').forEach((btn) =>
    btn.addEventListener('click', () => {
      const target = btn.dataset.goto;
      if (target === 'export') prepareExport().then((ok) => { if (ok) goto('export'); });
      else goto(target);
    })
  );

  $('#to-review').addEventListener('click', () => {
    // Coming from capture, the photographs are the source of truth. This is
    // the only place that is so — buildGlyphSet is destructive, and calling it
    // from the renderer discarded every redraw. Re-entering review this way
    // after adding another photograph still wipes earlier repairs, which is
    // inherent to rebuilding from the scans; returning by the step chip does
    // not, because that path calls neither.
    buildGlyphSet();
    renderReview();
    goto('review');
  });

  $('#to-refine').addEventListener('click', async () => {
    busy(true, 'Building your font', 0.3, 'preview');
    try {
      await runCompile(true);
      goto('refine');
    } finally {
      busy(false);
    }
  });

  // Every link that leaves names its destination first. See src/leaving.js.
  let leavingUrl = null;
  interceptExternal({
    onLeave: (url) => {
      leavingUrl = url;
      const d = describeUrl(url);
      $('#leaving-host').textContent = d.host;
      $('#leaving-rest').textContent = d.rest;
      // A plain http destination is worth flagging: the padlock is not
      // decoration, and showing a closed one over an unencrypted link would be
      // the single most misleading thing this dialogue could do.
      $('#leaving-scheme use').setAttribute('href', d.secure ? '#i-lock-plain' : '#i-unlock');
      $('#leaving-scheme').classList.toggle('is-insecure', !d.secure);
      openModal('#leaving');
      $('#leaving-go').focus();
    },
  });
  $('#leaving-cancel').addEventListener('click', () => closeModal('#leaving'));
  $('#close-leaving').addEventListener('click', () => closeModal('#leaving'));
  $('#leaving-go').addEventListener('click', () => {
    if (!leavingUrl) return;
    closeModal('#leaving');
    // noopener is the point: without it the opened page gets a handle on this
    // one through window.opener and can navigate it somewhere else.
    window.open(leavingUrl.href, '_blank', 'noopener,noreferrer');
  });

  // The landing demo pulls in three modules, so it is mounted the first time the
  // band comes into view rather than on load. A visitor who never scrolls to it
  // — or who arrives already past it, on a step route — pays nothing.
  let demoPad = null;
  const demoBand = $('#demo-mount');
  if (demoBand && typeof IntersectionObserver === 'function') {
    const demoIO = new IntersectionObserver(
      (entries, self) => {
        if (!entries.some((e) => e.isIntersecting)) return;
        self.disconnect();
        import('./demo.js')
          .then((m) => m.mountDemo(demoBand))
          // Held, not dropped. createDrawPad registers a document-level keydown
          // listener that swallows Ctrl+Z, and only destroy() removes it —
          // otherwise undo in the feedback box or the preview would be applied
          // to a canvas on a screen the reader is not looking at.
          .then((handle) => { demoPad = handle; })
          // The band keeps its fallback text. A demo that fails to load should
          // leave the page as it was, not leave a hole where it would have been.
          .catch(() => {});
      },
      { rootMargin: '200px 0px' }
    );
    demoIO.observe(demoBand);
  }

  // The greeting, and it opens itself only when nothing else has claimed the
  // screen: an arrival at /guide or /privacy or any step past the first is a
  // reader who knows where they were going, and a hello over the top of that is
  // an interruption rather than an introduction.
  //
  // Decided from the address, not from the modal stack. applyRoute is async —
  // it awaits openGuide, which awaits the tutorial module — so at this point in
  // init the stack is still empty even when the address plainly says /guide,
  // and the greeting opened on top of the guide. The address is known
  // synchronously and cannot race.
  mountWelcome({
    open: openModal,
    close: closeOverlay,
    onGuide: () => openGuide(),
    onStart: () => goto('write'),
    canGreet: () => {
      const here = readRoute();
      return !here.overlay && (here.step === 'start' || here.step === null);
    },
  });

  $('#open-guide').addEventListener('click', () => openGuide());
  $('#open-settings').addEventListener('click', () => {
    openModal('#settings');
    writeRoute({ overlay: 'settings' });
  });
  $('#close-settings').addEventListener('click', () => closeOverlay('#settings'));
  $('#start-guide').addEventListener('click', openGuide);
  $('#close-guide').addEventListener('click', () => closeOverlay('#guide'));
  $('#close-draw').addEventListener('click', () => closeModal('#draw-modal'));
  $('#dl-zip').addEventListener('click', downloadZip);

  // Only mounted when there is an address worth copying. Under file://, which
  // routes.js explicitly supports, there is none — so there is no button
  // rather than a button that copies "null/".
  if (appLink()) {
    $('#copy-applink').hidden = false;
    $('#copy-applink').addEventListener('click', copyAppLink);
  }

  if (canShareFont()) {
    $('#share-font').hidden = false;
    $('#share-font').addEventListener('click', shareFont);
  }
  $('#start-over').addEventListener('click', () => {
    // Nothing here is stored anywhere, so a reload is not a reset — it is a
    // deletion, and it was happening on one press with no warning at all. The
    // count is stated because "your work" is abstract and "118 characters" is
    // not.
    const n = state.glyphs.length;
    if (n) {
      const ok = confirm(
        `Start again and lose the ${n} character${n === 1 ? '' : 's'} you have captured?\n\n`
        + 'Nothing is saved anywhere — that is the point of this app — so there is no way to bring them back.'
      );
      if (!ok) return;
    }
    location.reload();
  });

  // Wrapped, not passed by reference: addEventListener hands the listener the
  // event, which would arrive as the prefill argument.
  $('#open-feedback').addEventListener('click', () => openFeedback());
  $('#close-feedback').addEventListener('click', () => closeOverlay('#feedback'));

  /**
   * Copy the report, then open an EMPTY issue form.
   *
   * The report used to ride in the query string of `issues/new?title=…&body=…`.
   * A query string is part of the request, so the whole report — settings,
   * error messages, user agent — was in GitHub's server logs the instant the
   * tab opened, whether or not the reader ever pressed Submit, and whether or
   * not they changed their mind on the way there. The dialogue said "Nothing is
   * sent automatically" and the privacy policy said "Nothing is transmitted
   * unless you post it yourself". Neither was true, and this is the only place
   * in the app where the central claim was false.
   *
   * The clipboard write is started and the window opened in the same
   * synchronous run of the handler, before any await. Both need the click's
   * transient activation and an await spends it — copy, await, then open is how
   * this turns into a blocked popup.
   *
   * 'noopener,noreferrer' matches the only other window.open in this file, the
   * one in the leaving.js interstitial. The URL now carries no user data at
   * all, which is why it is safe to open without that interstitial — but the
   * referrer is still a disclosure the app does not need to make.
   */
  $('#fb-github').addEventListener('click', async () => {
    let copying;
    try {
      copying = navigator.clipboard.writeText(feedbackReport());
    } catch {
      // No clipboard API at all, or a synchronous throw. Handled below, and
      // attached before the microtask checkpoint, so it is never unhandled.
      copying = Promise.reject(new Error('clipboard unavailable'));
    }
    window.open(`https://github.com/${REPO}/issues/new`, '_blank', 'noopener,noreferrer');
    try {
      await copying;
      toast('Report copied. Paste it into the issue and post it when you are ready.');
    } catch {
      toast('Could not copy — select what you wrote and the details beside it, and copy them by hand.', true);
    }
  });

  $('#fb-copy').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(feedbackReport());
      toast('Report copied.');
    } catch {
      toast('Could not copy — select the text instead.', true);
    }
  });

  /**
   * The copy button's state comes from the clipboard Promise, not from focus.
   *
   * Clipboard writes are refused more often than people expect — a page served
   * over plain HTTP, a denied permission, a browser that wants a fresher user
   * gesture. A button that reports success regardless is worse than one with
   * no feedback at all, because the user walks away believing they have the
   * text.
   */
  let copyResetTimer = null;
  $('#copy-css').addEventListener('click', async () => {
    const btn = $('#copy-css');
    const tip = $('#copy-css-tip');
    const live = $('#copy-css-live');
    clearTimeout(copyResetTimer);

    let ok = false;
    try {
      await navigator.clipboard.writeText($('#css-snippet').textContent);
      ok = true;
    } catch {
      ok = false;
    }

    btn.dataset.state = ok ? 'done' : 'failed';
    tip.textContent = ok ? 'Copied' : 'Could not copy';
    // The tooltip is decoration for a screen reader; this is the announcement.
    live.textContent = ok
      ? 'Stylesheet copied to clipboard.'
      : 'Could not copy. Select the text and copy it manually.';

    copyResetTimer = setTimeout(() => {
      btn.dataset.state = 'idle';
      tip.textContent = 'Copy to clipboard';
      live.textContent = '';
    }, 2200);
  });

  $('#print-template').addEventListener('click', async () => {
    const mod = await loadModule('template', './template.js');
    if (mod?.renderTemplate && mod?.printTemplate) {
      mod.printTemplate(mod.renderTemplate({ paper: 'a4', sheets: ALL_SHEETS }));
    } else {
      toast('The printable template is not available in this build.', true);
    }
  });

  $('#busy-cancel').addEventListener('click', () => {
    const stop = busyCancel;
    if (!stop) return;
    const btn = $('#busy-cancel');
    // Not `disabled`. Disabling the element that was just pressed removes it
    // from the accessibility tree and drops focus on <body> — for a keyboard
    // user, the same disappearance the overlay already caused once. Clearing
    // busyCancel is what makes a second press a no-op.
    busyCancel = null;
    btn.setAttribute('aria-disabled', 'true');
    // The pipeline only learns of this at its next yield: the next group of
    // twelve characters, or the end of the preprocess stage now running. "Stop"
    // would then be describing something that has not happened yet.
    btn.textContent = 'Stopping…';
    stop();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    // The overlay is above every dialogue and swallows the key whether or not
    // there is anything to stop. .busy is z-index 80 and .sheet-modal is 60, so
    // a dialogue open underneath is completely covered — backing out of
    // something the reader cannot see would be worse than doing nothing at all.
    // (applyInert leaves the topmost dialogue non-inert even while the overlay
    // is up, so it is the stacking order doing this work, not inert.)
    if (busyOpen) {
      if (busyCancel) $('#busy-cancel').click();
      return;
    }
    // One layer at a time. Dismissing the legal sheet that was opened *from*
    // Settings should not also throw Settings away — Escape means "back out of
    // this", not "close everything".
    const top = topModal();
    if (!top) return;
    // The address follows only if the thing just closed owned one, and only once
    // nothing routed is left underneath it. Both of those were decided here, in
    // a second copy of the reasoning, until the close buttons turned out to be
    // deciding them differently; closeOverlay owns the question now.
    closeOverlay(`#${top.id}`);
  });

  $$('.sheet-modal').forEach((m) =>
    m.addEventListener('click', (e) => {
      // Only a click on the backdrop itself, not one that bubbled from inside.
      if (e.target !== m) return;
      // The same dismissal as the button in the corner, address included — a
      // backdrop click is that intention expressed with less aim, and the two
      // have no business leaving the reader at different addresses.
      closeOverlay(`#${m.id}`);
    })
  );
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
