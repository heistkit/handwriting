# Handoff

Handwrite turns a photograph of someone's handwriting into an installable
OpenType family — Regular, Bold, Italic, Bold Italic — with measured spacing,
generated kerning, and three variants of every character so repeated letters do
not look rubber-stamped. It is a static site. There is no build step, no
bundler, no framework, and one vendored dependency.

`node tools/run-tests.mjs` — 559 checks, plain Node, no test framework.

An earlier version of this file described three modules to be written. All three
shipped: `src/template.js`, `src/draw.js` and `src/tutorial.js` are complete and
have been in use for months. It also said not to edit `src/app.js`,
`index.html`, `styles.css` or `src/pipeline.js`. That is no longer true either —
they are the shell, and ordinary work touches them.

## Constraints that are not negotiable

These are the things that make a change wrong regardless of how well it works.

- **Nothing leaves the device.** No uploads, no analytics, no telemetry, no
  fonts or images fetched at runtime. The served page carries a
  `connect-src 'none'` content-security policy, so the browser enforces this
  rather than anyone having to trust it. A change that needs the network is a
  change to the product, not to the code.
- **No new dependencies and no build step.** Plain ES modules served as files.
  The one vendored library is `vendor/opentype.js` — do not edit anything under
  `vendor/`.
- **No inline scripts.** `script-src 'self'`. JSON-LD is fine, because a
  `type="application/ld+json"` block is data and the parser returns before the
  inline check.
- **Never `#000000` or `#ffffff`.** Eye strain, and pure black smears on OLED.
  Colours come from the tokens in `styles.css`; do not hard-code them. Icons are
  inline SVG — no emoji, no icon fonts.
- **Nothing internal reaches the user.** No raw exception text, no stack traces,
  no property paths in a message anyone reads. Detail goes to `console.error`;
  the reader gets a sentence about what to do next.
- **Every animation must be switchable off** — under `:root[data-lite='on']`,
  `:root[data-decor='off']` and `prefers-reduced-motion`. Decoration is never
  the only place information lives.
- **House voice.** Sentence case, no exclamation marks, no marketing voice, body
  paragraphs under about forty words. Comments explain *why* a non-obvious
  decision was made, not what the line does — match `src/metrics.js` and
  `src/trace.js`.
- **Storage is disclosed.** Anything written to the device is described in
  `src/legal.js` and `llms.txt`, in the same commit that writes it. The policy
  going stale is a worse defect than the feature being late.

## The pipeline

Photograph in, font out. Each stage hands the next a specific shape, and the
shapes are the part worth knowing.

```
imageproc.preprocess   file        → { bin, w, h, slant, angle }
segment.segmentSheet   bin         → rows of cells, with issues and stats
segment.extractGlyph   cell        → { ch, bitmap, w, h, pad, page }
trace.vectorize        bitmap      → contours of cubic Béziers
metrics.buildMetrics   extracted   → { glyphs, spacing, kerning, rows }
fontbuild.buildFamily  glyphs      → four styles
pipeline.serialise     family      → .otf bytes
export.packageFamily   bytes       → the .zip
```

`src/pipeline.js` orchestrates it. `src/app.js` is the shell around it: steps,
routing, settings, and every screen.

**Segmentation never recognises anything.** The app dictates which characters to
write and in what order, so it only has to find the ink and read it left to
right. That removes the entire class of OCR errors and is why no printed grid or
registration mark is needed. It also means putting the capitals photograph in
the everyday slot would write every character under the wrong name — which is
why `capturePage` refuses a sheet that scores badly against the one it was asked
for, rather than warning about it.

**Baselines are solved, not assumed.** The paper is unruled, so `solveAllRows`
recovers a baseline per row by solving ascender and descender constraints across
the whole row at once, using the zone declared for each character in
`charset.js`. This is why `normalizeGlyph` takes a `rowMetric`, and why glyphs
carry `page` coordinates all the way through.

**There is no vector-in entry point.** `normalizeGlyph(extracted, rowMetric)`
reads bitmap-space contours plus page coordinates and a solved
`{ scale, baseline }`. Anything arriving as outlines already — an imported font,
say — has its baseline at zero and none of that, so it needs a parallel
normaliser that skips `solveAllRows` and feeds `computeSpacing` directly.
`metrics.profilesFromContours` exists for exactly that and is not yet called.

## Things that cost time to learn

- **opentype.js can read GPOS but not write it.** Kerning is assembled as raw
  bytes in `src/gpos.js`.
- **Winding is measured, never assumed.** The tracer walks in bitmap space with
  y down, `normalizeGlyph` flips y, and a flip reverses winding — so an outer
  contour reaches `embolden` clockwise. It takes its direction from the signed
  area of the largest contour. Before that, Bold came out *thinner* than Regular
  in every font the app had ever exported.
- **The drawing pad carries a coverage field beside its mask.** `stampStroke`
  builds a one-pixel ramp so a 0.5 threshold lands between pixels;
  `trace.vectorize` takes it as `opts.coverage` and refines the boundary onto
  the half-coverage crossing. Corners are excluded — a bilinear interpolant
  cannot represent one. The fit tolerance halves when coverage is present, and
  that is one change with the refinement, not two.
- **`capture.page.bin` is about 2.5 MB per sheet.** It exists only to draw the
  review screen's before/after overlay. It must never be persisted, and a test
  asserts it never reaches an autosave snapshot.
- **`session.js` strips `bitmap` by name and passes everything else through
  `JSON.stringify`.** Adding a large typed array to a glyph without adding it to
  that exclusion will serialise it as decimal text on a debounce timer.
- **`filetype.js` currently refuses `.otf` and `.ttf`** with "that looks like a
  font", because people try it. If font import ships, that message becomes
  wrong.
- **`getComputedStyle` returns a live declaration.** Read it after the element
  has been removed and every value is an empty string.
- **Custom properties do not resolve for canvas.** `getPropertyValue('--text')`
  returns the token stream, `light-dark(...)` and all, which canvas rejects
  silently. `src/paint.js` makes the browser do the resolving; use it rather
  than reading tokens directly.

## Source layout

`src/` is flat and every file opens with a header explaining what it is for. The
ones to read first, in this order: `charset.js` (what gets written, and why that
set), `pipeline.js` (the whole flow in one file), `metrics.js` (the spacing
engine, where most of the quality lives), `app.js` (everything the user
touches).

`tools/` holds the tests, one suite per module, registered in
`tools/run-tests.mjs`. They are numerical checks on pure functions plus a few
scanners over the CSS and markup. There is no DOM, so anything imported there
must not touch `document` at module scope.

## Open work

`TODO.md` at the repo root is the live list. The near items: sub-pixel tracing
on the photograph path — the coverage field has to be settled first, since
Sauvola's threshold is local and raw greyscale's 0.5 level is therefore not the
edge — font import from an existing `.ttf`, and shipping a usable font from the
first sheet instead of asking for all 112 characters up front.

Two pieces of advice, both learned the expensive way. Measure before changing a
number: a bound picked to make a test pass is a number that means nothing. And a
green suite is not the verdict — for anything that ends up as a shape on a page,
render a real sample and look at it.
