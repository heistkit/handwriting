/**
 * demo.js — the landing page's one interactive thing.
 *
 * The page describes three claims: that the tracer turns ink into real curves,
 * that letters do not repeat, and that none of it leaves your device. All three
 * were prose. A visitor could read the whole page and never once see the
 * software do anything.
 *
 * So: draw a letter, and watch the *actual* tracer run on it. Not a video, not
 * a canned example, not a simulation — `vectorize()` from src/trace.js, the same
 * function the real pipeline calls, on the ink you just laid down. Every number
 * shown is counted from its output.
 *
 * This matters more than it sounds. The page's central claim is that the font
 * is *yours*, and a demo built from someone else's handwriting would quietly
 * contradict that on the way to proving it. There is nothing to fabricate here
 * because there is nothing this could show that the visitor did not make.
 *
 * Reuse, not reimplementation
 * ---------------------------
 *   draw.js       createDrawPad   the same pad the repair flow uses
 *   trace.js      vectorize, contoursToSVGPath
 *   fontbuild.js  jitter, boundsOf, and the real variant constants
 *
 * The variant numbers below are imported rather than retyped, so if the font
 * builder's idea of "subtly different" ever changes, the demo changes with it
 * instead of drifting into a lie.
 *
 * Cost
 * ----
 * Tracing one small glyph is far cheaper than the full-family compile, which is
 * why the demo can run inline while the real build gets a progress bar.
 *
 * The whole module — and, through its static import of fontbuild.js, the metrics
 * and charset tables with it — loads when the band comes within 200px of the
 * viewport, not on first interaction. Scrolling past is enough. That is still
 * nothing for a visitor who never reaches it, which is the case worth
 * protecting, but it is not the same claim.
 */

import { VARIANT_ROTATION, VARIANT_SCALE, VARIANT_SHIFT, TARGET_X_HEIGHT_UNITS, jitter } from './fontbuild.js';

/** How many variants the real font builds per character. Kept in step by hand
 *  with the default in app.js state.settings.variantCount. */
const VARIANTS = 3;

const svgNS = 'http://www.w3.org/2000/svg';

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

const svgEl = (tag, attrs = {}) => {
  const n = document.createElementNS(svgNS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
  return n;
};

/**
 * Render one set of contours into an <svg>, fitted to a square box.
 *
 * @param {Array} contours       from vectorize()
 * @param {{x0,y0,x1,y1}} bounds ink bounds in bitmap pixels
 * @param {object} [opts]
 * @param {boolean} [opts.nodes] draw the on-curve points
 */
function renderOutline(contours, bounds, { nodes = false, label = '' } = {}) {
  const svg = svgEl('svg', {
    class: 'demo-glyph',
    viewBox: '0 0 100 100',
    role: 'img',
    'aria-label': label || 'The letter you drew, traced into outlines',
  });

  const w = Math.max(1, bounds.x1 - bounds.x0);
  const h = Math.max(1, bounds.y1 - bounds.y0);
  // Fit inside a 100-unit box with a margin, preserving aspect — a glyph
  // stretched to fill would misrepresent the very thing being shown.
  const s = 78 / Math.max(w, h);
  const ox = 50 - ((bounds.x0 + bounds.x1) / 2) * s;
  const oy = 50 - ((bounds.y0 + bounds.y1) / 2) * s;
  const map = (p) => ({ x: p.x * s + ox, y: p.y * s + oy });

  const d = pathOf(contours, map);
  const fill = svgEl('path', { d, class: 'demo-glyph__fill' });
  svg.append(fill);

  if (nodes) {
    const outline = svgEl('path', { d, class: 'demo-glyph__stroke' });
    svg.append(outline);
    for (const c of contours) {
      for (const bez of c.curves) {
        const p = map(bez[3]);
        svg.append(svgEl('circle', { cx: p.x.toFixed(2), cy: p.y.toFixed(2), r: 1.15, class: 'demo-glyph__node' }));
      }
    }
  }

  return svg;
}

/** Local copy of contoursToSVGPath's job, so the transform can be a closure. */
function pathOf(contours, map) {
  const parts = [];
  for (const c of contours) {
    if (!c.curves.length) continue;
    const start = map(c.curves[0][0]);
    parts.push(`M${round(start.x)} ${round(start.y)}`);
    for (const bez of c.curves) {
      const c1 = map(bez[1]);
      const c2 = map(bez[2]);
      const to = map(bez[3]);
      parts.push(`C${round(c1.x)} ${round(c1.y)} ${round(c2.x)} ${round(c2.y)} ${round(to.x)} ${round(to.y)}`);
    }
    parts.push('Z');
  }
  return parts.join('');
}

const round = (n) => Math.round(n * 100) / 100;

const countNodes = (contours) =>
  contours.reduce((n, c) => n + c.curves.length, 0);

/**
 * Build the three variants exactly as fontbuild does, so what the visitor sees
 * is the amount of variation their font would actually carry.
 */
function variantsOf(contours, bounds, jitter) {
  const centre = { x: (bounds.x0 + bounds.x1) / 2, y: (bounds.y0 + bounds.y1) / 2 };
  // The builder works in 1000-unit em space; this is in bitmap pixels. The
  // shift is expressed as a fraction of x-height in both, so it has to be
  // rescaled or the nudge would be invisible on a 60-pixel glyph.
  const pxPerEmUnit = (bounds.y1 - bounds.y0) / TARGET_X_HEIGHT_UNITS;

  const out = [contours];
  for (let v = 1; v < VARIANTS; v++) {
    const sign = v % 2 === 0 ? 1 : -1;
    out.push(
      jitter(
        contours,
        {
          rotateDeg: VARIANT_ROTATION * sign,
          scale: 1 + VARIANT_SCALE * sign * 0.6,
          dy: TARGET_X_HEIGHT_UNITS * VARIANT_SHIFT * sign * 0.5 * pxPerEmUnit,
        },
        centre
      )
    );
  }
  return out;
}

/**
 * @param {HTMLElement} mount
 * @param {object} [opts]
 * @param {string} [opts.ch] the character to ask for
 * @returns {Promise<{destroy(): void}|null>} null if the environment cannot run it
 */
export async function mountDemo(mount, { ch = 'a' } = {}) {
  if (!mount) return null;

  let draw;
  let trace;
  try {
    // fontbuild is already a static import at the top of this file, for the
    // variant constants — importing it again here bought nothing.
    [draw, trace] = await Promise.all([import('./draw.js'), import('./trace.js')]);
  } catch {
    // The band keeps whatever static content it had. A demo that fails to load
    // should leave the page as it was, not leave a hole where it would have been.
    return null;
  }

  const stage = el('div', 'demo-stage');
  const padMount = el('div', 'demo-pad');
  const result = el('div', 'demo-result');
  stage.append(padMount, result);

  const idle = el('p', 'demo-idle');
  idle.append(
    `Draw a lower-case ${ch} in the box, then press `,
    el('b', null, 'Trace it'),
    '. Nothing is sent anywhere — the tracer runs here, in this tab.'
  );
  result.append(idle);

  mount.replaceChildren(stage);

  const pad = draw.createDrawPad(padMount, {
    ch,
    commitLabel: 'Trace it',
    onCommit: (glyph) => {
      if (!glyph) return;
      show(glyph);
      // Leave the ink on the pad. Clearing it here would take away the thing
      // the visitor is comparing the result against.
    },
  });

  function show(glyph) {
    const { contours, bounds } = trace.vectorize(glyph.bitmap, glyph.w, glyph.h);
    if (!contours.length || !bounds) {
      result.replaceChildren(
        el('p', 'demo-idle', 'That came out as too little ink to trace. Try a larger stroke.')
      );
      return;
    }

    const nodes = countNodes(contours);
    const takes = variantsOf(contours, bounds, jitter);

    const outlineBox = el('figure', 'demo-panel');
    outlineBox.append(renderOutline(contours, bounds, { nodes: true, label: 'Your letter as cubic Bézier outlines' }));
    const cap1 = el('figcaption');
    cap1.append(
      el('b', null, 'Real outlines'),
      // Counted, not claimed. Every number on this page comes out of the tracer.
      ` — ${nodes} cubic Bézier ${nodes === 1 ? 'curve' : 'curves'}, corners preserved. This is what goes into the font file.`
    );
    outlineBox.append(cap1);

    const variantBox = el('figure', 'demo-panel');
    const row = el('div', 'demo-variants');
    // Six glyphs, cycling the three takes twice, which is exactly what `calt`
    // does as you type — so a doubled letter is visibly two different shapes.
    for (let i = 0; i < 6; i++) {
      const take = takes[i % takes.length];
      row.append(renderOutline(take, bounds, { label: `Variant ${(i % takes.length) + 1}` }));
    }
    variantBox.append(row);
    const cap2 = el('figcaption');
    cap2.append(
      el('b', null, 'And it will not repeat'),
      ` — the same letter, ${VARIANTS} ways, rotating as you type. Look at the pair in the middle.`
    );
    variantBox.append(cap2);

    const note = el('p', 'demo-note');
    note.append(
      'That is the whole tracer, on your ink. A finished font does this for about 120 characters, ',
      'then solves the baseline and the spacing across all of them at once.'
    );

    result.replaceChildren(outlineBox, variantBox, note);
  }

  return {
    destroy() {
      pad?.destroy?.();
      mount.replaceChildren();
    },
  };
}
