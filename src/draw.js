/**
 * draw.js — the canvas drawing pad.
 *
 * Two jobs: it is the capture path for anyone with a stylus or tablet, and it is
 * the repair path when one character from a photograph comes out wrong and the
 * review grid asks for a single glyph to be redrawn.
 *
 * The output must be indistinguishable from a scanned glyph, because everything
 * downstream (trace.vectorize -> metrics.buildMetrics -> fontbuild) cannot tell
 * the two apart and must not need to. So the committed shape is exactly what
 * segment.extractGlyph returns: an ink bitmap cropped tight to the ink, plus the
 * tight ink bounds in `page` so the metrics stage can place it against a
 * baseline.
 *
 * The bitmap is produced by rasterising the recorded stroke geometry at 3x, not
 * by reading pixels back off the on-screen canvas. The two are equivalent after
 * thresholding, but rasterising from geometry keeps the export deterministic and
 * free of the display's device-pixel-ratio and colour — which is also what lets
 * the extraction helper be unit-tested with no DOM at all.
 */

import { token, onPaletteChange } from './paint.js';

const SCALE = 3;          // backing raster resolution, per the field spec
const PAD = 2;            // transparent border around the ink, matching extractGlyph
const INK_THRESHOLD = 0.5;

// ---------------------------------------------------------------------------
// Pure extraction — no DOM, unit-tested in tools/draw.test.mjs
// ---------------------------------------------------------------------------

/**
 * Rasterise stroke geometry into a scanned-glyph-shaped object.
 *
 * @param {Array<{points: Array<{x:number,y:number,r:number}>}>} strokes
 *        stroke paths already in backing-pixel coordinates; `r` is the brush
 *        radius at that sample, also in backing pixels.
 * @param {object} opts
 * @param {number} opts.width   backing canvas width
 * @param {number} opts.height  backing canvas height
 * @param {string} [opts.ch]
 * @param {number} [opts.pad=PAD]
 * @param {number} [opts.threshold=INK_THRESHOLD]
 * @returns {{ch,bitmap:Uint8Array,w:number,h:number,pad:number,page:{x0,y0,x1,y1}}|null}
 *          null when no ink was laid down.
 */
export function rasterizeGlyph(strokes, { width, height, ch = '', pad = PAD, threshold = INK_THRESHOLD } = {}) {
  // A fractional grid is not a rounding nuisance here, it is silent corruption.
  // Every read and write below is `cov[y * width + x]`, and a typed array with a
  // fractional index is not an element access at all: the write is discarded and
  // the read gives undefined, with no error either way. With width 1063.17, only
  // rows where y * 0.17 happens to land on a whole number survive, so the ink
  // comes back as a scatter of specks — or, on a thin stroke, as nothing, and
  // the caller sees a commit that quietly did nothing.
  //
  // The pad sizes itself from mount.clientWidth, which is fractional far more
  // often than not, so this is the normal case rather than the edge one.
  width = Math.max(1, Math.floor(width));
  height = Math.max(1, Math.floor(height));

  const cov = new Float32Array(width * height);
  for (const stroke of strokes) stampStroke(cov, width, height, stroke.points);

  // Tight ink bounds first, so the crop carries no empty margin into metrics.
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (cov[y * width + x] >= threshold) {
        if (x < x0) x0 = x;
        if (y < y0) y0 = y;
        if (x > x1) x1 = x;
        if (y > y1) y1 = y;
      }
    }
  }
  if (!Number.isFinite(x0)) return null;

  const inkW = x1 - x0 + 1;
  const inkH = y1 - y0 + 1;
  const w = inkW + pad * 2;
  const h = inkH + pad * 2;
  const bitmap = new Uint8Array(w * h);
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      if (cov[y * width + x] >= threshold) {
        bitmap[(y - y0 + pad) * w + (x - x0 + pad)] = 1;
      }
    }
  }

  return {
    ch,
    bitmap,
    w,
    h,
    pad,
    // Same convention as extractGlyph: x1/y1 are one past the last ink pixel, so
    // (x1 - x0) is the ink width. This is what the baseline solver reads.
    page: { x0, y0, x1: x1 + 1, y1: y1 + 1 },
  };
}

/**
 * Stamp a variable-width stroke into the coverage buffer as a run of discs.
 *
 * Coverage is soft over the outermost pixel (a linear ramp across one pixel of
 * the radius) so that thresholding at 0.5 lands the edge sub-pixel rather than
 * on a hard pixel boundary — the tracer downstream is only as accurate as this
 * edge is.
 */
function stampStroke(cov, width, height, points) {
  if (!points.length) return;
  if (points.length === 1) {
    stampDisc(cov, width, height, points[0].x, points[0].y, points[0].r);
    return;
  }
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const dist = Math.hypot(b.x - a.x, b.y - a.y);
    const steps = Math.max(1, Math.ceil(dist / 0.6));
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      stampDisc(
        cov, width, height,
        a.x + (b.x - a.x) * t,
        a.y + (b.y - a.y) * t,
        a.r + (b.r - a.r) * t
      );
    }
  }
}

function stampDisc(cov, width, height, cx, cy, r) {
  const rOuter = r + 0.5;
  const minX = Math.max(0, Math.floor(cx - rOuter));
  const maxX = Math.min(width - 1, Math.ceil(cx + rOuter));
  const minY = Math.max(0, Math.floor(cy - rOuter));
  const maxY = Math.min(height - 1, Math.ceil(cy + rOuter));
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      const c = Math.min(1, Math.max(0, r + 0.5 - d));
      if (c) {
        const i = y * width + x;
        if (c > cov[i]) cov[i] = c;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// The interactive pad
// ---------------------------------------------------------------------------

/**
 * The width actually available inside `mount`, in CSS pixels.
 *
 * Falls back to the viewport rather than a constant, because the pad is built
 * inside a dialogue that is still `display: none` at that moment, so every
 * measurement on it reads 0.
 */
function availableWidth(mount) {
  let box = 0;
  try {
    const cs = getComputedStyle(mount);
    box = mount.clientWidth - parseFloat(cs.paddingLeft || 0) - parseFloat(cs.paddingRight || 0);
  } catch {
    box = 0;
  }
  if (box > 0) return box;
  // 2.5rem of dialogue padding either side, and a little clearance.
  const viewport = (typeof innerWidth === 'number' ? innerWidth : 380) - 88;
  return Math.max(260, viewport);
}

/**
 * @param {HTMLElement} mount
 * @param {object} opts
 * @param {string} opts.ch                 the character being drawn
 * @param {number} [opts.guideXHeight=0.5] x-height as a fraction of box height
 * @param {(glyph) => void} opts.onCommit
 * @param {() => void} [opts.onClose]       optional; called on Esc
 * @param {string} [opts.commitLabel]       label on the commit button
 * @returns {{destroy():void, clear():void, undo():void, isEmpty():boolean}}
 */
export function createDrawPad(mount, opts = {}) {
  const { ch = '', guideXHeight = 0.5, onCommit = () => {}, onClose,
    // The pad is used in two places that mean different things by the same
    // gesture: the repair flow is saving a character into a font, the landing
    // demo is asking the tracer to run. One label cannot be honest for both.
    commitLabel = 'Save character' } = opts;

  // clientWidth includes the mount's own padding, so the canvas came out wider
  // than the box it sits in and the guide rules ran off the right-hand edge of
  // the card. And when the pad is built inside a dialogue that is still
  // display:none, every measurement is 0 — the old fallback was a flat 360px,
  // which overflows a 375px phone once the card's padding is counted.
  // Rounded, and not only for tidiness: W is multiplied by SCALE and handed to
  // rasterizeGlyph as a raster width, and a fractional raster loses the ink.
  const W = Math.round(Math.min(Math.max(availableWidth(mount), 260), 440));
  const H = Math.round(W * 1.15);
  const dpr = window.devicePixelRatio || 1;

  // Guide lines, expressed as fractions of the pad height. The x-height rule is
  // placed guideXHeight of the way from baseline up to the ascender, matching
  // the printable sheet so the two capture flows produce comparable proportions.
  const yAsc = Math.round(H * 0.16);
  const yBase = Math.round(H * 0.74);
  const yDesc = Math.round(H * 0.92);
  const yX = Math.round(yBase - guideXHeight * (yBase - yAsc));

  const penWidth = Math.max(2.2, H * 0.012);

  // Resolved through a probe element, not read off the custom property. The
  // tokens are written with light-dark(), and getPropertyValue hands back the
  // unresolved token stream — which a canvas rejects, silently, leaving every
  // one of these black. See src/paint.js.
  //
  // The fallbacks carry both branches. A single literal is always wrong in one
  // theme, and every one of these used to be the dark value, so a failed
  // resolve painted near-white ink on a near-white surface in light mode.
  //
  // Declared once and refreshed in place, because the visitor can change the
  // theme with the pad open and a canvas repaints nothing by itself.
  let ink, lineColor, ghostColor;
  function readPalette() {
    ink = token('--text', { light: '#1c2128', dark: '#e4e9ef' });
    lineColor = token('--accent', { light: '#1a7f37', dark: '#3fb950' });
    ghostColor = token('--text-3', { light: '#656d76', dark: '#8a929c' });
  }
  readPalette();

  // -- DOM ------------------------------------------------------------------
  const wrap = document.createElement('div');
  wrap.className = 'draw-pad';
  // Only the measured size stays inline; everything else is in styles.css, so
  // the toolbar can be laid out by a stylesheet rather than by four properties
  // an element style would always win over.
  wrap.style.width = `${W}px`;

  const stage = document.createElement('div');
  stage.className = 'draw-pad__stage';
  stage.style.width = `${W}px`;
  stage.style.height = `${H}px`;

  const guideCanvas = makeCanvas(W, H, dpr);
  const inkCanvas = makeCanvas(W, H, dpr);
  Object.assign(guideCanvas.style, { position: 'absolute', inset: '0' });
  Object.assign(inkCanvas.style, { position: 'absolute', inset: '0', cursor: 'crosshair' });
  stage.append(guideCanvas, inkCanvas);

  const toolbar = document.createElement('div');
  toolbar.className = 'draw-tools';

  const undoBtn = toolButton('i-refresh', 'Undo', () => undo());
  const clearBtn = toolButton('i-x', 'Clear', () => clear());
  const saveBtn = toolButton('i-check', commitLabel, () => commit());
  saveBtn.classList.add('btn-primary');
  toolbar.append(undoBtn, clearBtn, saveBtn);

  wrap.append(stage, toolbar);
  mount.append(wrap);

  const gctx = guideCanvas.getContext('2d');
  const ictx = inkCanvas.getContext('2d');
  gctx.scale(dpr, dpr);
  ictx.scale(dpr, dpr);

  // -- State ----------------------------------------------------------------
  /** @type {Array<{points: Array<{x,y,p}>, pressured: boolean}>} */
  const strokes = [];
  let current = null;

  drawGuides();
  updateButtons();

  // -- Drawing --------------------------------------------------------------
  function onPointerDown(e) {
    if (e.button != null && e.button !== 0) return;
    e.preventDefault();
    inkCanvas.setPointerCapture?.(e.pointerId);
    const pt = localPoint(e);
    current = { points: [pt], pressured: reportsPressure(e.pressure) };
    strokes.push(current);
  }

  function onPointerMove(e) {
    if (!current) return;
    e.preventDefault();
    // A move can coalesce several samples; replaying them all makes fast strokes
    // smoother and gives the tracer more to work with.
    const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
    for (const ev of events.length ? events : [e]) {
      const pt = localPoint(ev);
      if (reportsPressure(ev.pressure)) current.pressured = true;
      current.points.push(pt);
    }
    redrawInk();
  }

  function onPointerUp(e) {
    if (!current) return;
    e.preventDefault();
    inkCanvas.releasePointerCapture?.(e.pointerId);
    current = null;
    redrawInk();
    updateButtons();
  }

  function onKeyDown(e) {
    if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z')) {
      e.preventDefault();
      undo();
    } else if (e.key === 'Escape') {
      // The host app owns the modal and closes it on Escape too; calling back is
      // only for standalone use, so this never double-closes anything.
      onClose?.();
    }
  }

  inkCanvas.addEventListener('pointerdown', onPointerDown);
  inkCanvas.addEventListener('pointermove', onPointerMove);
  inkCanvas.addEventListener('pointerup', onPointerUp);
  inkCanvas.addEventListener('pointercancel', onPointerUp);
  document.addEventListener('keydown', onKeyDown);

  // -- Rendering ------------------------------------------------------------
  function drawGuides() {
    gctx.clearRect(0, 0, W, H);

    // The character being drawn, large and pale, so the writer knows the target.
    gctx.save();
    gctx.fillStyle = ghostColor;
    // 0.16 was tuned against a colour that was accidentally black; against the
    // real quiet grey it left the target letter invisible, which defeats it.
    gctx.globalAlpha = 0.3;
    gctx.textAlign = 'center';
    gctx.textBaseline = 'alphabetic';
    gctx.font = `${Math.round((yBase - yX) * 1.9)}px ui-sans-serif, system-ui, sans-serif`;
    gctx.fillText(ch, W / 2, yBase);
    gctx.restore();

    const line = (y, color, alpha, dash) => {
      gctx.save();
      gctx.strokeStyle = color;
      gctx.globalAlpha = alpha;
      gctx.setLineDash(dash);
      gctx.lineWidth = 1;
      gctx.beginPath();
      gctx.moveTo(0, y + 0.5);
      gctx.lineTo(W, y + 0.5);
      gctx.stroke();
      gctx.restore();
    };
    // These alphas were tuned while every colour here was accidentally black,
    // so they were never graded against anything real. Composited on --surface,
    // --border-strong at 0.5 measured 1.26:1 dark and 1.25:1 light — invisible.
    // Worse, no opacity of --border-strong reaches the 3:1 floor for a
    // meaningful graphic: solid, it is only 1.64:1. So the two faint rules take
    // the quiet text tone instead, at 3.91:1 dark / 3.40:1 light.
    //
    // They are not decoration. The printable sheet tells the writer to "rest
    // each letter on the dotted baseline and size it to the dashed mid-line".
    line(yAsc, ghostColor, 0.8, [4, 4]);
    line(yX, lineColor, 0.75, [6, 4]);   // 4.27:1 dark / 3.17:1 light
    line(yBase, lineColor, 0.85, []);    // 5.13:1 dark / 3.76:1 light
    line(yDesc, ghostColor, 0.8, [4, 4]);
  }

  function redrawInk() {
    ictx.clearRect(0, 0, W, H);
    ictx.strokeStyle = ink;
    ictx.fillStyle = ink;
    ictx.lineJoin = 'round';
    ictx.lineCap = 'round';
    for (const stroke of strokes) strokeOnScreen(ictx, stroke, penWidth);
  }

  // The theme can change while the pad is open — the switch is two clicks away
  // in the header — and the canvas is a bitmap, so nothing repaints itself.
  const stopWatchingPalette = onPaletteChange(() => {
    readPalette();
    drawGuides();
    redrawInk();
  });

  // -- Actions --------------------------------------------------------------
  function undo() {
    if (!strokes.length) return;
    strokes.pop();
    current = null;
    redrawInk();
    updateButtons();
  }

  function clear() {
    strokes.length = 0;
    current = null;
    redrawInk();
    updateButtons();
  }

  function isEmpty() {
    return strokes.length === 0;
  }

  function commit() {
    if (isEmpty()) return;
    const backing = strokes.map((s) => ({
      points: densify(s.points, s.pressured, penWidth).map((p) => ({
        x: p.x * SCALE,
        y: p.y * SCALE,
        r: (p.w * SCALE) / 2,
      })),
    }));
    const glyph = rasterizeGlyph(backing, { width: W * SCALE, height: H * SCALE, ch });
    if (!glyph) return;

    // Where the rules actually are, in the same backing pixels the bitmap and
    // `page` are measured in.
    //
    // The metrics solver recovers a baseline from the *zones* of the characters
    // in a row: an 'x' sits between baseline and x-height, a 'k' rises to the
    // ascender. That works on a photographed sheet with thirteen characters to
    // triangulate from. It cannot work here, where a row is one character —
    // and for a descender, a full-height character or a maths sign it pins
    // nothing at all, so the solver fell through to a page-median x-height
    // measured on a *photograph*, in page pixels, and applied it to a glyph
    // measured in pad pixels. Two unrelated coordinate systems, one division,
    // and the character came out several times the size of everything else,
    // with no error anywhere.
    //
    // There is nothing to infer. This pad drew those rules itself, at known
    // positions, and told the writer to sit the letter on them. Saying so is
    // both exact and shorter than any inference.
    glyph.guides = {
      baseline: yBase * SCALE,
      xHeight: (yBase - yX) * SCALE,
      ascHeight: (yBase - yAsc) * SCALE,
      descDepth: (yDesc - yBase) * SCALE,
    };
    onCommit(glyph);
  }

  function updateButtons() {
    const empty = isEmpty();
    undoBtn.disabled = empty;
    clearBtn.disabled = empty;
    saveBtn.disabled = empty;
  }

  function destroy() {
    inkCanvas.removeEventListener('pointerdown', onPointerDown);
    inkCanvas.removeEventListener('pointermove', onPointerMove);
    inkCanvas.removeEventListener('pointerup', onPointerUp);
    inkCanvas.removeEventListener('pointercancel', onPointerUp);
    document.removeEventListener('keydown', onKeyDown);
    stopWatchingPalette();
    wrap.remove();
  }

  function localPoint(e) {
    const rect = inkCanvas.getBoundingClientRect();
    return {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
      p: e.pressure,
    };
  }

  return { destroy, clear, undo, isEmpty };
}

// ---------------------------------------------------------------------------
// Shared stroke geometry
// ---------------------------------------------------------------------------

/**
 * A device reports real pressure when the value is above zero and not exactly
 * 0.5 — 0.5 is the constant every non-pressure pointer returns, so trusting it
 * would just feed the width jitter that is noise, not signal.
 */
function reportsPressure(pressure) {
  return typeof pressure === 'number' && pressure > 0 && pressure !== 0.5;
}

function widthFor(p, pressured, base) {
  if (!pressured) return base;
  // Map pressure onto a width range wide enough to read as a stylus, floored so
  // a light touch never disappears entirely.
  return base * (0.45 + 1.2 * Math.min(1, Math.max(0, p)));
}

/**
 * Turn raw samples into a dense, width-carrying polyline using a quadratic curve
 * through successive midpoints. A raw lineTo per sample leaves visible polygonal
 * kinks on fast strokes, and the tracer reproduces every one as a corner in the
 * outline, so the smoothing has to happen before the bitmap, not after.
 */
function densify(raw, pressured, base) {
  const pts = raw.map((p) => ({ x: p.x, y: p.y, w: widthFor(p.p, pressured, base) }));
  if (pts.length <= 2) return pts;

  const out = [pts[0]];
  const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, w: (a.w + b.w) / 2 });

  // First segment: straight run into the first midpoint.
  sampleQuad(pts[0], pts[0], mid(pts[0], pts[1]), out);
  for (let i = 1; i < pts.length - 1; i++) {
    sampleQuad(mid(pts[i - 1], pts[i]), pts[i], mid(pts[i], pts[i + 1]), out);
  }
  // Final segment: last midpoint out to the last raw point.
  const n = pts.length;
  sampleQuad(mid(pts[n - 2], pts[n - 1]), pts[n - 1], pts[n - 1], out);
  return out;
}

function sampleQuad(p0, c, p1, out) {
  const approx = Math.hypot(c.x - p0.x, c.y - p0.y) + Math.hypot(p1.x - c.x, p1.y - c.y);
  const steps = Math.max(2, Math.ceil(approx / 2));
  for (let s = 1; s <= steps; s++) {
    const t = s / steps;
    const mt = 1 - t;
    const a = mt * mt, b = 2 * mt * t, d = t * t;
    out.push({
      x: a * p0.x + b * c.x + d * p1.x,
      y: a * p0.y + b * c.y + d * p1.y,
      w: a * p0.w + b * c.w + d * p1.w,
    });
  }
}

/** Draw one stroke on screen with the same midpoint-quadratic smoothing. */
function strokeOnScreen(ctx, stroke, base) {
  const pts = densify(stroke.points, stroke.pressured, base);
  if (!pts.length) return;
  if (pts.length === 1) {
    ctx.beginPath();
    ctx.arc(pts[0].x, pts[0].y, pts[0].w / 2, 0, Math.PI * 2);
    ctx.fill();
    return;
  }
  // Variable width: draw each short segment at its own line width. The segments
  // are dense enough that the width steps read as a continuous taper.
  for (let i = 1; i < pts.length; i++) {
    ctx.beginPath();
    ctx.lineWidth = (pts[i - 1].w + pts[i].w) / 2;
    ctx.moveTo(pts[i - 1].x, pts[i - 1].y);
    ctx.lineTo(pts[i].x, pts[i].y);
    ctx.stroke();
  }
}

// ---------------------------------------------------------------------------
// Small DOM helpers
// ---------------------------------------------------------------------------

function makeCanvas(w, h, dpr) {
  const c = document.createElement('canvas');
  c.width = Math.round(w * dpr);
  c.height = Math.round(h * dpr);
  c.style.width = `${w}px`;
  c.style.height = `${h}px`;
  return c;
}

function toolButton(icon, label, onClick) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'btn';
  b.append(iconSvg(icon));
  const span = document.createElement('span');
  span.textContent = label;
  b.append(span);
  b.addEventListener('click', onClick);
  return b;
}

function iconSvg(id) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('width', '18');
  svg.setAttribute('height', '18');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.8');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#${id}`);
  svg.append(use);
  return svg;
}

