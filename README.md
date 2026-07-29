# Handwrite

**Upload your handwriting. Apply everywhere.**

Write about 120 characters on blank paper, photograph the page, and get back an
OpenType family — Regular, Bold, Italic, Bold Italic — in your own hand, with
proper spacing, kerning, and letters that vary the way real writing does.

**Everything runs in the browser.** No server, no account, no upload. Once the
page has loaded it works offline, and the font is built on your own machine.

---

## Why it works without AI

The obvious way to build this is to photograph a page of handwriting and use a
vision model to find and identify the letters. Handwrite does something simpler
and strictly more reliable: **it tells you exactly what to write, and in what
order.**

That single constraint removes handwriting *recognition* from the problem
entirely. The app never has to decide whether a shape is an `a` or an `o` — it
already knows. It only has to find the ink and read it left to right, which is a
solved problem in classical image processing. There is no model to be wrong, no
inference step to introduce errors, and nothing to send anywhere.

The knowledge that would have gone into a model goes somewhere more useful
instead: knowing that `p` descends and `k` ascends is what lets the app recover
a baseline from a sheet of *unruled* paper, by solving those constraints across
a whole row at once.

## How it works

```
photo ─► preprocess ─► segment ─► trace ─► metrics ─► compile ─► font
```

**Preprocess.** Sauvola local thresholding via summed-area tables, so a phone
photo with a shadow across one corner binarises correctly where a single global
threshold would blow out half the page. Rotation is corrected by maximising the
sharpness of the ink projection profile.

**Segment.** Connected components are grouped into characters by merging pieces
that sit *above and below* each other — which reunites the dot of an `i` with
its stem, and the two bars of an `=`, while leaving neighbouring letters alone.
Because the expected count per row is known, a row that comes up long fuses its
closest pair, and one that comes up short splits its widest glyph at the
narrowest waist. Both repairs run without asking.

**Trace.** Boundaries are walked along pixel edges, corners are detected on the
raw walk *before* any smoothing can hide them, then everything except those
corners is smoothed and fitted with cubic Béziers. Fitted outlines land within
about 0.3 px of the true shape on analytic test figures.

**Metrics.** Side bearings are set from each glyph's own ink profile so that the
*perceived* gap is constant — a flat `H` gets the full bearing, a round `o` less,
a diagonal `A` less still. This is most of the difference between amateur and
professional spacing, and it removes the need for most kerning. What remains is
generated for the pairs whose shapes genuinely interlock: measured on a real
layout engine, ordinary prose shifts under 1.5%, while `AVATAR To Wave off; r.`
tightens by 5%.

**Compile.** Bold is synthesised by displacing outline points along their own
outward normals; italic by shearing about the middle of the x-height band. Three
variants of every letter rotate through a `calt` chaining substitution, so
repeated letters differ. Kerning is written as a class-based GPOS table so that
variants inherit their parent's values.

## Running it

No build step, no dependencies. Serve the folder:

```bash
node tools/serve.mjs
```

Then open <http://localhost:8745>.

## Deploying

Still no build step and no environment to configure — but the folder is no
longer quite "upload it as-is", because every screen has its own address
(`/write`, `/guide`, `/terms`) and none of those is a file on disk.

**The host has to answer extensionless paths with `index.html`.** Without that,
a deep link or a reload anywhere but `/` returns 404, and the router never gets
a chance to run.

**Vercel** — push to `main`. `vercel.json` is in the repo and supplies the
rewrite, `cleanUrls`, and the security headers, so nothing needs setting in the
dashboard. `middleware.js` applies the per-address rate limit at the edge and is
picked up automatically; it is the one thing here that is billed, as fluid
compute.

**Any other static host** — configure a fallback to `/index.html` for paths
without a file extension, and make sure files *with* an extension still 404
rather than being served the HTML. (Answering a missing `.js` with a page of
HTML turns a broken asset into a silent mystery.) The edge rate limit is
Vercel-specific and simply will not run; the per-device limit in
`src/ratelimit.js` is unaffected.

**Offline** — a copy already loaded keeps working with no network at all. That
is a property of the app, not of the host.

## Tests

```bash
node tools/run-tests.mjs
```

467 checks covering the vectoriser (against analytically-defined shapes, so
"how wrong is it" is an exact question), the spacing engine, the drawing pad,
a full round trip of the font binary — built, then handed back to an
independent parser to confirm every table survived — and the surrounding
machinery: both rate limits, the edge matcher, the docs index, and the ETA
estimator.

## Layout

| Path | |
|---|---|
| `src/charset.js` | the 120 characters, the writing sheets, ligature pairs |
| `src/imageproc.js` | thresholding, deskew, slant detection, components |
| `src/segment.js` | line finding, character grouping, count self-repair |
| `src/trace.js` | contours → corner-preserving cubic Béziers |
| `src/metrics.js` | baseline solving, perceptual bearings, kerning |
| `src/fontbuild.js` | four styles, variants, GSUB (`liga` + `calt`) |
| `src/gpos.js` | hand-written class-based kerning table |
| `src/sfnt.js` | table splicing, checksums, family-linking flags |
| `src/export.js` | OTF, WOFF, ZIP, CSS |
| `src/health.js` | pre-export quality report |
| `src/draw.js` | canvas pad, output byte-compatible with a scan |
| `src/template.js` | printable sheet, guides in drop-out blue |
| `src/tutorial.js` | lessons, per-platform install steps, FAQ |
| `src/pipeline.js` | the orchestrator — the only stateful part |
| `src/app.js` | UI |
| `src/routes.js` | one address per screen; history, deep links, fallbacks |
| `src/leaving.js` | names the destination before any outbound link |
| `src/legal.js` | privacy, terms, licences — as data, rendered in three places |
| `src/ratelimit.js` | the per-device limit; `middleware.js` is the edge one |
| `src/theme.js` `src/lite.js` `src/textsize.js` | the three stored settings |
| `src/reveal.js` | scroll-in, one observer, off under lite and reduced motion |
| `src/eta.js` | device profile, benchmark, smoothed time remaining |
| `src/docsearch.js` | the guide's index and search |
| `src/content.js` | fallback copy when `tutorial.js` fails to load |

`opentype.js` is vendored in `vendor/`. It writes everything except GPOS, which
is why `gpos.js` and `sfnt.js` exist.

## Credits

Typeface: [Geist](https://vercel.com/font), self-hosted under the SIL Open Font
License so the app makes no external requests.

## Licence

The code is MIT. **Fonts you make with it are entirely yours** — no licence, no
attribution, no restrictions. Sell them if you like.
