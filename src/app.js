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
import { bindToggle } from './theme.js';
import {
  bindToggle as bindLite,
  bindCheckbox as bindLiteCheckbox,
  apply as applyLite,
  chosen as liteChosen,
} from './lite.js';
import { bindToggle as bindTextSize } from './textsize.js';
import { observe as observeReveal, showAll as revealAll } from './reveal.js';
import { enhance as enhanceFolds } from './fold.js';
import { init as initFlourish, bindToggle as bindFlourish } from './flourish.js';
import { read as readRoute, write as writeRoute } from './routes.js';
import { run as runBrowserGate } from './browsergate.js';
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
    italicAngle: 11,
    variantCount: 3,
    straighten: false,
    kerning: true,
  },
  /** Optional modules, loaded lazily; the app degrades gracefully without them. */
  modules: { template: null, draw: null, tutorial: null },
};

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
}

function goto(stepId) {
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

function renderSteps() {
  const nav = $('#steps');
  const currentIndex = STEPS.findIndex((s) => s.id === state.step);
  nav.replaceChildren(
    ...STEPS.map((s, i) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'step-chip';
      const done = i < currentIndex && reachable(s.id);
      if (done) btn.classList.add('is-done');
      if (s.id === state.step) btn.setAttribute('aria-current', 'step');
      btn.disabled = !reachable(s.id);

      const dot = document.createElement('span');
      dot.className = 'dot';
      dot.innerHTML = done
        ? '<svg viewBox="0 0 24 24"><use href="#i-check"/></svg>'
        : String(i + 1);

      const label = document.createElement('span');
      label.textContent = s.label;

      btn.append(dot, label);
      btn.addEventListener('click', () => goto(s.id));
      return btn;
    })
  );
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
function busy(on, stage = '', pct = 0, op = null) {
  const el = $('#busy');
  el.hidden = !on;

  if (!on) {
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

function renderSheets() {
  const stack = $('#sheet-stack');
  stack.replaceChildren(
    ...ALL_SHEETS.map((sheet) => {
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
    })
  );

  const tips = [
    'Use a dark pen — a fine-liner or gel pen around 0.5 mm. Pencil is too faint.',
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

function renderCaptureList() {
  const list = $('#capture-list');
  list.replaceChildren(
    ...ALL_SHEETS.map((sheet) => {
      const capture = state.captures.get(sheet.id);
      const row = document.createElement('div');
      row.className = 'drop';
      if (capture) row.classList.add('is-done');
      if (sheet.optional) row.classList.add('is-optional');

      const thumb = document.createElement('div');
      thumb.className = 'drop-thumb';
      thumb.innerHTML = capture
        ? '<svg viewBox="0 0 24 24"><use href="#i-check"/></svg>'
        : '<svg viewBox="0 0 24 24"><use href="#i-camera"/></svg>';

      const body = document.createElement('div');
      body.className = 'drop-body';
      const h = document.createElement('h3');
      h.textContent = sheet.title + (sheet.optional ? ' (optional)' : '');
      const p = document.createElement('p');
      p.textContent = capture
        ? `${capture.stats.found} of ${capture.stats.total} characters found`
        : 'Drop a photo here, or choose a file.';
      body.append(h, p);

      const actions = document.createElement('div');
      actions.className = 'drop-actions';

      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'image/*';
      // Hidden because the button beside it is the real control, but it still
      // needs a name: a file input with none announces as "file, button" with
      // no clue which of the five sheets it belongs to, and browsers surface
      // these in their own file-picker chrome regardless of this attribute.
      input.setAttribute('aria-label', `Photograph of the ${sheet.title} sheet`);
      input.hidden = true;
      input.addEventListener('change', () => {
        if (input.files?.[0]) handleFile(input.files[0], sheet.id);
      });

      const pick = document.createElement('button');
      pick.type = 'button';
      pick.className = capture ? 'btn' : 'btn btn-primary';
      pick.textContent = capture ? 'Replace' : 'Choose photo';
      pick.addEventListener('click', () => input.click());
      actions.append(pick, input);

      if (capture) {
        const clear = document.createElement('button');
        clear.type = 'button';
        clear.className = 'btn btn-ghost';
        clear.textContent = 'Remove';
        clear.addEventListener('click', () => {
          state.captures.delete(sheet.id);
          refreshCaptureState();
        });
        actions.append(clear);
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
      return row;
    })
  );
}

async function handleFile(file, sheetId) {
  if (!file.type.startsWith('image/')) {
    toast('That does not look like an image.', true);
    return;
  }
  if (!allowHeavyOp()) return;
  try {
    busy(true, 'Reading image', 0.02, 'capture');
    const capture = await capturePage(file, sheetId, {
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
  } catch (err) {
    console.error(err);
    toast(`Could not read that photo: ${err.message}`, true);
  } finally {
    busy(false);
  }
}

function refreshCaptureState() {
  renderCaptureList();
  $('#to-review').disabled = state.captures.size === 0;
  renderSteps();
}

// ---------------------------------------------------------------------------
// Review step
// ---------------------------------------------------------------------------

function buildGlyphSet() {
  const captures = [...state.captures.values()];
  state.glyphs = mergeCaptures(captures);
  const slants = captures.map((c) => c.slant).filter(Number.isFinite);
  state.naturalSlant = slants.length
    ? slants.sort((a, b) => a - b)[slants.length >> 1]
    : 0;
}

function renderReview() {
  buildGlyphSet();

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
        const canvas = glyphToCanvas(glyph, { size: 96, ink: getComputedStyle(document.body).color });
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
      'The drawing pad is not available in this build. You can re-photograph the sheet instead.';
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
        state.glyphs.push({ ...glyph, ch, row: 9000, col: 0, contours });
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

function scheduleRecompile() {
  clearTimeout(recompileTimer);
  recompileTimer = setTimeout(() => runCompile(true), 170);
}

/**
 * Build the font and hand it to the browser for live preview.
 *
 * @param {boolean} previewOnly compile just the visible style, for slider drags
 */
async function runCompile(previewOnly = false) {
  if (!state.glyphs.length) return;
  // Preview recompiles are exempt — see allowHeavyOp for why.
  if (!previewOnly && !allowHeavyOp()) return;

  topload(true);
  // Only before the first build. On later recompiles the preview already shows
  // the user's own hand, and replacing it with a placeholder every time a
  // slider moves would be a downgrade — the top bar covers those.
  if (!state.family) $('#preview-skeleton').hidden = false;

  // Hand the browser a frame before starting. compile() is synchronous and
  // holds the main thread, so without this neither the bar nor the placeholder
  // would paint until after the work they exist to cover had finished.
  await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));

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
    });
    renderHealth();
  } catch (err) {
    console.error(err);
    toast(`Could not build the font: ${err.message}`, true);
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
  $('.score-text span', wrap).textContent =
    `${state.health.captured} of ${state.health.expected} characters`;
  card.append(wrap);

  if (!findings.length) {
    const p = document.createElement('p');
    p.className = 'muted';
    p.textContent = 'Nothing to flag. This one came out clean.';
    card.append(p);
    return;
  }

  const list = document.createElement('ul');
  list.className = 'findings';
  for (const f of findings) {
    const li = document.createElement('li');
    li.className = `finding is-${f.level}`;
    const icon = f.level === 'error' ? 'alert' : f.level === 'warn' ? 'alert' : 'info';
    li.innerHTML = `<svg viewBox="0 0 24 24"><use href="#i-${icon}"/></svg><div><b></b><p></p></div>`;
    $('b', li).textContent = f.title;
    $('p', li).textContent = f.detail;
    if (f.chars?.length) {
      const chars = document.createElement('div');
      chars.className = 'chars';
      for (const ch of f.chars.slice(0, 14)) {
        const s = document.createElement('span');
        s.textContent = ch;
        chars.append(s);
      }
      $('div', li).append(chars);
    }
    list.append(li);
  }
  stagger(list);
  card.append(list);
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
      });
      return b;
    })
  );
}

// ---------------------------------------------------------------------------
// Export step
// ---------------------------------------------------------------------------

async function prepareExport() {
  busy(true, 'Building all four styles', 0.15, 'family');
  try {
    await runCompile(false);
    busy(true, 'Packaging', 0.7);
    renderExport();
  } finally {
    busy(false);
  }
}

function renderExport() {
  const name = state.settings.familyName || 'My Handwriting';
  const built = state.serialised ?? [];

  $('#export-sub').textContent =
    `${name} — four styles, ${built[0]?.glyphCount ?? 0} characters, built entirely on this device.`;
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

  const summary = $('#font-summary');
  summary.replaceChildren();
  const h = document.createElement('h3');
  h.textContent = 'Summary';
  const dl = document.createElement('dl');
  const rows = [
    ['Characters', String(built[0]?.glyphCount ?? 0)],
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
  if (fill !== null) btn.style.setProperty('--dl-fill', `${Math.round(fill * 100)}%`);
  if (!next) return;

  btn.dataset.state = next;
  btn.disabled = next === 'working';
  label.textContent =
    next === 'working' ? 'Packaging…' : next === 'done' ? 'Downloaded' : 'Download';
}

async function downloadZip() {
  const name = state.settings.familyName || 'My Handwriting';
  clearTimeout(dlResetTimer);
  dlState('working', 0);
  try {
    const zip = await packageFamily(
      name,
      state.serialised,
      { variantCount: state.settings.variantCount },
      (pct) => dlState(null, pct)
    );
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
    toast(`Could not package the font: ${err.message}`, true);
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

/** The whole guide, as shown when the search box is empty. */
function renderLessons() {
  const body = $('#guide-body');
  body.replaceChildren(
    ...docLessons.map((lesson) => {
      const sec = document.createElement('section');
      sec.className = 'lesson';
      const h = document.createElement('h3');
      h.textContent = lesson.title;
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

async function openGuide({ route = true } = {}) {
  await loadDocs();
  const input = $('#guide-search');
  input.value = '';
  runDocSearch();
  openModal('#guide');
  if (route) writeRoute({ overlay: 'guide' });
  // The search box is the reason someone opened this; give it the caret.
  input.focus();
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
window.addEventListener('error', (e) => recordError(e.message));
window.addEventListener('unhandledrejection', (e) => recordError(e.reason?.message ?? e.reason));

/**
 * Assemble the diagnostic block.
 *
 * Deliberately contains no image data, no glyph outlines and no font bytes —
 * only counts and settings. The user can read every line of it before deciding
 * to send, which is the only way a feedback button belongs in an app that
 * promises nothing leaves the device.
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
 */
function openFeedback(prefill = null) {
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
  // The guide owns an address and feedback does not, so the address has to come
  // back to the step. Without this the reader ends on their own step with
  // `/guide` in the bar, and a reload restores the guide and silently discards
  // the half-written report.
  writeRoute({ step: state.step });
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

function renderLegal(id) {
  const doc = documentById(id) ?? DOCUMENTS[0];
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
  // away. So the rule is a length threshold rather than a name, and it decides
  // itself as the documents change.
  const foldSections = doc.sections.length > 6;
  if (foldSections) body.append(expandAllControl(body));

  for (const [index, section] of doc.sections.entries()) {
    const sec = document.createElement(foldSections ? 'details' : 'section');
    sec.className = 'legal-section';
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

function openLegal(id) {
  renderLegal(id);
  openModal('#legal');
  writeRoute({ overlay: id });
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

  for (const sel of INERT_WHILE_OPEN) {
    const el = $(sel);
    if (!el) continue;
    el.toggleAttribute('inert', Boolean(top));
  }
  for (const m of $$('.sheet-modal')) {
    m.toggleAttribute('inert', m !== top);
  }
}

/** The innermost open dialogue, or null. */
const topModal = () => modalStack[modalStack.length - 1] ?? null;

/** The innermost open dialogue that owns an address, or null. */
const topRoutedModal = () =>
  [...modalStack].reverse().find((m) => ['guide', 'legal', 'settings'].includes(m.id)) ?? null;

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
  el.querySelector('.btn-icon')?.focus();
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
    modalStack[modalStack.length - 1].querySelector('.btn-icon')?.focus();
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
 * Overlays that own an address. Feedback and the redraw canvas deliberately do
 * not: both hold unsaved input, and a link that reopens one would either
 * restore an empty version of something the reader had already written, or
 * promise to restore a draft that was never stored.
 */
const ROUTED_OVERLAYS = ['guide', 'settings', ...LEGAL_IDS];

function closeRoutedOverlays() {
  // Through closeModal, never by writing `.hidden`. Hiding a dialogue behind
  // the stack's back leaves its entry on the stack, so applyInert() is never
  // re-run and `main` keeps the `inert` attribute — which removes pointer
  // input as well as focus. The page goes dead with nothing on screen to
  // explain it, and no route out from inside the app, because closeModal
  // early-returns on an already-hidden element so the entry can never drain.
  for (const sel of ['#guide', '#settings', '#legal']) closeModal(sel);
}

/**
 * Put the screen where the address says. Never pushes history — the address is
 * already correct, except where it names something unreachable, in which case
 * it is *replaced* so Back does not bounce off the rejected entry forever.
 */
async function applyRoute() {
  const { step, overlay, fromHash } = readRoute();

  closeRoutedOverlays();

  if (overlay && ROUTED_OVERLAYS.includes(overlay)) {
    if (overlay === 'guide') await openGuide({ route: false });
    else if (overlay === 'settings') openModal('#settings');
    else {
      renderLegal(overlay);
      openModal('#legal');
    }
    // Upgrade a shared #privacy link to /privacy in place.
    if (fromHash) writeRoute({ overlay, replace: true });
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
  const landed = reachable(wanted) ? wanted : furthestReachable();
  applyStep(landed);
  if (landed !== wanted || !named || fromHash) writeRoute({ step: landed, replace: true });
}

/** Closing an overlay returns the address to the step underneath it. */
function closeOverlay(sel) {
  closeModal(sel);
  writeRoute({ step: state.step });
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
async function loadModule(key, path) {
  if (state.modules[key] !== null) return state.modules[key];
  topload(true);
  try {
    state.modules[key] = await import(path);
  } catch {
    state.modules[key] = undefined;
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

  bind('#ctl-spacing', 'spacing', (v) => `${Math.round(v * 100)}%`);
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
    italic: 'italicAngle',
  }[key] ?? key;
}

function init() {
  // First, and its result is deliberately ignored: the gate is a warning with a
  // door, so the app sets itself up behind it either way. Anything the missing
  // capability is needed for is guarded at its own call site.
  runBrowserGate();

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
  const theme = bindToggle($('#theme-toggle'));
  const themeSetting = bindToggle($('#set-theme'));
  $('#theme-toggle').addEventListener('change', () => themeSetting?.sync());
  $('#set-theme').addEventListener('change', () => theme?.sync());

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

  // The two decoration switches. Already applied pre-paint by the inline script
  // in <head>; this call only normalises the case where storage was unreadable
  // then and readable now, which costs nothing and keeps one source of truth.
  initFlourish();
  bindFlourish('fold', $('#set-fold'));
  bindFlourish('decor', $('#set-decor'));

  // Every <details> in the document, plus anything rendered later — renderFAQ,
  // the guide and the health report each call this again for their own subtree.
  enhanceFolds();

  // The brand writes a line under itself, and rubs it out on the next press.
  // Bound before the navigation handler below so a press does both.
  const brand = $('#brand-home');
  brand.addEventListener('click', () => {
    brand.dataset.writing = brand.dataset.writing === 'on' ? 'off' : 'on';
  });

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
      openLegal(a.dataset.legal);
    })
  );
  $('#close-legal').addEventListener('click', () => closeOverlay('#legal'));

  // Back and Forward mean what they mean everywhere else.
  window.addEventListener('popstate', () => { applyRoute(); });
  window.addEventListener('hashchange', () => { applyRoute(); });
  applyRoute();

  const preview = $('#preview-text');
  preview.dataset.placeholder = 'Type something…';
  preview.textContent = PREVIEW_SAMPLES[0];

  $$('[data-goto]').forEach((btn) =>
    btn.addEventListener('click', () => {
      const target = btn.dataset.goto;
      if (target === 'export') prepareExport().then(() => goto('export'));
      else goto(target);
    })
  );

  $('#to-review').addEventListener('click', () => {
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
  $('#start-over').addEventListener('click', () => location.reload());

  // Wrapped, not passed by reference: addEventListener hands the listener the
  // event, which would arrive as the prefill argument.
  $('#open-feedback').addEventListener('click', () => openFeedback());
  $('#close-feedback').addEventListener('click', () => closeModal('#feedback'));

  $('#fb-github').addEventListener('click', () => {
    const title = encodeURIComponent(
      ($('#fb-text').value.trim().split('\n')[0] || 'Feedback').slice(0, 70)
    );
    const body = encodeURIComponent(feedbackReport());
    window.open(
      `https://github.com/${REPO}/issues/new?title=${title}&body=${body}`,
      '_blank',
      'noopener'
    );
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

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    // One layer at a time. Dismissing the legal sheet that was opened *from*
    // Settings should not also throw Settings away — Escape means "back out of
    // this", not "close everything".
    const top = topModal();
    if (!top) return;
    closeModal(`#${top.id}`);
    // The address follows only if the thing just closed owned one, and only
    // once nothing routed is left underneath it.
    if (!['guide', 'legal', 'settings'].includes(top.id)) return;
    const beneath = topRoutedModal();
    // Peeling the legal sheet off Settings leaves Settings on screen, so the
    // address has to name Settings — not stay at /privacy, which a reload would
    // then take literally.
    if (beneath) writeRoute({ overlay: beneath.id, replace: true });
    else writeRoute({ step: state.step });
  });

  $$('.sheet-modal').forEach((m) =>
    m.addEventListener('click', (e) => {
      // Only a click on the backdrop itself, not one that bubbled from inside.
      if (e.target !== m) return;
      closeModal(`#${m.id}`);
      if (['guide', 'legal', 'settings'].includes(m.id) && !topRoutedModal()) {
        writeRoute({ step: state.step });
      }
    })
  );
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
