# Handoff — three independent modules

The algorithmic core is finished and covered by 60 passing checks
(`node tools/run-tests.mjs`). What follows are three **leaf modules**: nothing
else imports them yet, they import almost nothing, and they touch no file
anyone else is editing. They can be built in parallel with zero merge risk.

**Ground rules for all three**

- Plain ES modules, no build step, no dependencies, no network calls at runtime.
- The whole app is offline-first and privacy-by-default. Nothing may fetch, log,
  or transmit anything.
- Match the house style of `src/metrics.js` and `src/trace.js`: comments explain
  *why* a non-obvious decision was made, not what the line does.
- UI text is plain sentences, sentence case, no exclamation marks, no emoji.
- Do **not** edit: `src/pipeline.js`, `src/app.js`, `index.html`, `styles.css`,
  or anything under `src/views/`. Those are in flight.

Design tokens are defined in `styles.css` as CSS custom properties. Use them;
do not hard-code colours. Never pure white or pure black. Icons must be inline
SVG — no emoji, no icon fonts.

---

## 1. `src/template.js` — printable writing sheet

**Why it exists.** The primary capture flow asks the user to write on blank
paper. This is the alternative for people who want guide boxes: a sheet they
print, write in, and photograph. Because the app already knows the character
sequence, the boxes are a writing aid for the *human*, not a landmark for the
segmenter — so they do not need registration marks or corner fiducials.

**Print the guides in light blue** (`#9fc5e8`-ish). `toGrayscale()` in
`src/imageproc.js` accepts `{ dropBlue: true }`, which pushes saturated blue
pixels to white, so the guides vanish during binarisation exactly the way
non-photo blue pencil works in traditional drafting. This is why the guides must
be blue and not grey.

```js
/**
 * @param {object} opts
 * @param {'a4'|'letter'} opts.paper
 * @param {Array<{id,title,hint,rows:string[][]}>} opts.sheets  from charset.js
 * @returns {HTMLElement}  a print-ready DOM subtree
 */
export function renderTemplate(opts): HTMLElement

/** Opens the browser print dialog for the rendered sheet. */
export function printTemplate(element): void
```

Requirements:

- One page per sheet from `SHEETS`; also accept `LIGATURE_SHEET`.
- Each cell shows the target character small and pale in the corner, with a
  large empty box to write in. Include a dotted baseline and a dashed x-height
  line inside every box — they materially improve how consistently people write.
- Cells sized so a 13-column row fits A4 *and* US Letter without reflowing.
- `@media print` CSS scoped inside the module: exact page margins, no headers,
  `print-color-adjust: exact` so the blue survives.
- A short instruction block on page 1: use a dark pen (not pencil), write at a
  natural size, keep strokes inside the boxes, photograph in even light.

---

## 2. `src/draw.js` — canvas drawing pad

**Why it exists.** Fallback capture for people with a stylus or tablet, and the
repair path when one glyph from a scan comes out wrong. The review grid will
call this for a single character.

Output must be **interchangeable with a scanned glyph** so the rest of the
pipeline cannot tell the difference. That means returning the same shape
`segment.extractGlyph()` returns:

```js
{
  ch: string,
  bitmap: Uint8Array,   // 1 = ink, 0 = paper, row-major
  w: number, h: number,
  pad: number,          // transparent border, use 2
  page: { x0, y0, x1, y1 }   // ink bounding box in bitmap coords
}
```

```js
/**
 * @param {HTMLElement} mount
 * @param {object} opts
 * @param {string} opts.ch                     character being drawn
 * @param {number} [opts.guideXHeight=0.5]     x-height as a fraction of box height
 * @param {(glyph) => void} opts.onCommit
 */
export function createDrawPad(mount, opts): { destroy(), clear(), undo(), isEmpty() }
```

Requirements:

- Pointer Events only (`pointerdown/move/up`), so mouse, touch and stylus all
  work from one code path. Call `setPointerCapture`.
- Use `event.pressure` when the device reports it (> 0 and ≠ 0.5) to vary stroke
  width. A stylus produces dramatically better-looking letters this way.
- Smooth input with a quadratic midpoint curve between successive points; raw
  `lineTo` per pointer sample produces visible polygonal kinks at speed.
- Render at **3× the display size** on a backing canvas and threshold that to
  produce the bitmap. The tracer's accuracy is bounded by input resolution, and
  this is nearly free.
- Guides: baseline, x-height, ascender, descender lines matching `opts` — drawn
  on a separate layer that is *not* included in the exported bitmap.
- Undo (per stroke) and clear. Keyboard: `Ctrl/Cmd+Z` undo, `Esc` cancel.
- The bitmap must be cropped to the ink bounds plus `pad`, never the full
  canvas, or every drawn glyph will carry a huge empty margin into the metrics
  stage and its side bearings will be wrong.

---

## 3. `src/tutorial.js` — tutorial content and install guidance

**Why it exists.** Most people have never made a font and do not know what makes
a good sample. The single highest-value thing this app can do is tell them
before they write, not after.

Export **data, not markup** — the app shell renders it. This keeps the copy
reviewable in one place and lets the same content appear in onboarding, in
contextual help, and in the exported README.

```js
export const LESSONS: Array<{
  id: string,
  title: string,
  body: string[],          // paragraphs, plain text
  tips?: string[],
  illustration?: 'pen' | 'lighting' | 'spacing' | 'baseline' | 'photo',
}>

export const INSTALL: Array<{
  os: 'windows' | 'macos' | 'linux' | 'ios' | 'android',
  label: string,
  steps: string[],
  note?: string,
}>

export const FAQ: Array<{ q: string, a: string }>
```

Cover, at minimum:

- **Choosing a pen.** A fine-liner or gel pen around 0.5 mm. Not pencil (too
  faint, and graphite reflects), not a broad marker (strokes merge into blobs).
- **Photographing the sheet.** Flat surface, even indirect light, no hard shadow
  across the page, camera parallel to the paper. Explain that the app corrects
  rotation and uneven lighting automatically, so the only thing that really
  matters is that the ink is clearly darker than the paper.
- **Writing naturally.** People instinctively write in unnatural block capitals
  when they know they are being recorded. Tell them not to.
- **Why letters must not touch.** One sentence on why gaps between characters
  matter, since this is the only failure the app cannot silently repair.
- **What happens to bold and italic** — synthesised from the one sample, so they
  do not need to write anything four times.
- **Installing** on each OS. Be accurate: iOS cannot install a font from Files
  alone and needs a configuration-profile app; most Android apps cannot use
  custom fonts at all. Say so plainly rather than letting people fail.
- **FAQ**: Is anything uploaded? (No — everything runs in the browser and the
  page works offline once loaded.) Who owns the font? (They do, entirely.) Can
  they sell it? (Yes.) Why is the file `.otf` and not `.ttf`? (Both are
  OpenType; `.otf` carries cubic outlines, which is what the tracer produces,
  and it installs identically everywhere.)

Keep every `body` paragraph under about 40 words. This copy is read by someone
holding a pen who wants to start.
