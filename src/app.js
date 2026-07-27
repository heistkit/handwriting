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
  ALL_SHEETS, sheetById,
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

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/** Internal family name for live preview, kept stable while the user renames. */
const PREVIEW_FAMILY = 'InkwellLivePreview';

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

function goto(stepId) {
  if (!reachable(stepId)) return;
  state.step = stepId;
  $$('.step').forEach((s) => s.classList.toggle('is-active', s.dataset.step === stepId));
  renderSteps();
  window.scrollTo({ top: 0, behavior: 'instant' });
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

function busy(on, stage = '', pct = 0) {
  const el = $('#busy');
  el.hidden = !on;
  if (on) {
    $('#busy-stage').textContent = stage;
    $('#busy-bar').style.width = `${Math.round(pct * 100)}%`;
  }
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
    busy(true, 'Reading image', 0.02);
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

async function openDrawPad(ch) {
  const mod = await loadModule('draw', './draw.js');
  const body = $('#draw-body');
  $('#draw-title').textContent = `Draw “${ch}”`;
  body.replaceChildren();

  if (!mod?.createDrawPad) {
    const p = document.createElement('p');
    p.className = 'muted';
    p.textContent =
      'The drawing pad is not available in this build. You can re-photograph the sheet instead.';
    body.append(p);
  } else {
    mod.createDrawPad(body, {
      ch,
      onCommit: (glyph) => {
        // A redrawn glyph replaces any captured one and joins its own row, so
        // it is solved against its own baseline rather than a scanned row's.
        state.glyphs = state.glyphs.filter((g) => g.ch !== ch);
        state.glyphs.push({ ...glyph, ch, row: 9000, col: 0, contours: glyph.contours });
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
  }
}

function applyPreviewFont() {
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
  busy(true, 'Building all four styles', 0.15);
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

async function downloadZip() {
  const name = state.settings.familyName || 'My Handwriting';
  busy(true, 'Packaging your font', 0.4);
  try {
    const zip = await packageFamily(name, state.serialised, {
      variantCount: state.settings.variantCount,
    });
    download(zip, `${slugify(name)}.zip`, 'application/zip');
    toast('Downloaded. Open the zip and install the four .otf files.');
  } catch (err) {
    console.error(err);
    toast(`Could not package the font: ${err.message}`, true);
  } finally {
    busy(false);
  }
}

// ---------------------------------------------------------------------------
// Guide
// ---------------------------------------------------------------------------

async function openGuide() {
  const mod = await loadModule('tutorial', './tutorial.js');
  const lessons = mod?.LESSONS ?? FALLBACK_LESSONS;
  const body = $('#guide-body');
  body.replaceChildren(
    ...lessons.map((lesson) => {
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
  openModal('#guide');
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

function openFeedback() {
  $('#fb-diagnostics').textContent = buildDiagnostics();
  openModal('#feedback');
  $('#fb-text').focus();
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
      return d;
    })
  );
}

/**
 * Legal documents get real hash URLs so they can be linked to directly.
 *
 * App stores, payment processors and some jurisdictions expect a privacy policy
 * to live at a stable, shareable address. A modal with no URL cannot be cited,
 * so the hash is the routing even though this is a single page.
 */
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
        history.replaceState(null, '', `#${d.id}`);
        renderLegal(d.id);
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

  for (const section of doc.sections) {
    const sec = document.createElement('section');
    sec.className = 'legal-section';
    const h = document.createElement('h3');
    h.textContent = section.heading;
    sec.append(h);
    for (const para of section.body) {
      const p = document.createElement('p');
      p.textContent = para;
      sec.append(p);
    }
    body.append(sec);
  }

  const meta = document.createElement('p');
  meta.className = 'legal-meta';
  meta.textContent = `Version ${LEGAL_VERSION} — last updated ${LEGAL_UPDATED}. This document describes what the code in this repository actually does; you can verify it by reading the source or by watching your browser's network tab, which stays empty.`;
  body.append(meta);
}

function openLegal(id) {
  renderLegal(id);
  openModal('#legal');
}

const LEGAL_IDS = DOCUMENTS.map((d) => d.id);

function handleHash() {
  const id = location.hash.replace('#', '');
  if (LEGAL_IDS.includes(id)) openLegal(id);
}

function openModal(sel) {
  const el = $(sel);
  el.hidden = false;
  el.querySelector('.btn-icon')?.focus();
}
function closeModal(sel) {
  $(sel).hidden = true;
}

/** Load an optional module once, tolerating its absence. */
async function loadModule(key, path) {
  if (state.modules[key] !== null) return state.modules[key];
  try {
    state.modules[key] = await import(path);
  } catch {
    state.modules[key] = undefined;
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
  renderSteps();
  renderSheets();
  renderCaptureList();
  renderSamples();
  renderFAQ();
  bindControls();

  bindToggle($('#theme-toggle'));

  $('#brand-home').addEventListener('click', () => goto('start'));

  $$('[data-legal]').forEach((a) =>
    a.addEventListener('click', (e) => {
      e.preventDefault();
      history.replaceState(null, '', `#${a.dataset.legal}`);
      openLegal(a.dataset.legal);
    })
  );
  $('#close-legal').addEventListener('click', () => {
    closeModal('#legal');
    if (LEGAL_IDS.includes(location.hash.replace('#', ''))) {
      history.replaceState(null, '', location.pathname);
    }
  });
  window.addEventListener('hashchange', handleHash);
  handleHash();

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
    busy(true, 'Building your font', 0.3);
    try {
      await runCompile(true);
      goto('refine');
    } finally {
      busy(false);
    }
  });

  $('#open-guide').addEventListener('click', openGuide);
  $('#start-guide').addEventListener('click', openGuide);
  $('#close-guide').addEventListener('click', () => closeModal('#guide'));
  $('#close-draw').addEventListener('click', () => closeModal('#draw-modal'));
  $('#dl-zip').addEventListener('click', downloadZip);
  $('#start-over').addEventListener('click', () => location.reload());

  $('#open-feedback').addEventListener('click', openFeedback);
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

  $('#copy-css').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText($('#css-snippet').textContent);
      toast('CSS copied.');
    } catch {
      toast('Could not copy — select the text instead.', true);
    }
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
    if (e.key === 'Escape') {
      closeModal('#guide');
      closeModal('#draw-modal');
      closeModal('#legal');
      closeModal('#feedback');
    }
  });

  $$('.sheet-modal').forEach((m) =>
    m.addEventListener('click', (e) => {
      if (e.target === m) m.hidden = true;
    })
  );
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
