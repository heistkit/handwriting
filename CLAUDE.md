# CLAUDE.md

Handwrite turns a photograph of handwriting into an installable OpenType family.
Static site, no build step, no bundler, one vendored dependency.

`node tools/run-tests.mjs` — 615 checks, plain Node, no framework. Run it before
every commit.

Read `docs/HANDOFF.md` first — the pipeline's stage-by-stage data contract and the
things that cost time to learn are there, not here. `TIP.md` is the short version.
`TODO.md` is the live work list.

## Constraints

A change that breaks one of these is wrong regardless of how well it works.

- **Nothing leaves the device.** No uploads, analytics, telemetry, or runtime
  fetches. The page carries `connect-src 'none'`, so the browser enforces it.
- **No new dependencies, no build step.** Plain ES modules served as files. Never
  edit anything under `vendor/`.
- **No inline scripts** (`script-src 'self'`). JSON-LD is fine — a
  `type="application/ld+json"` block is data, not script.
- **Never `#000000` or `#ffffff`.** Eye strain, and pure black smears on OLED.
  Use the tokens in `styles.css`. Icons are inline SVG — no emoji, no icon fonts.
- **Nothing internal reaches the user.** No exception text, stack traces, or
  property paths in anything a reader sees. Detail goes to `console.error`; the
  reader gets a sentence about what to do next.
- **Every animation switchable off** — under `:root[data-lite='on']`,
  `:root[data-decor='off']` and `prefers-reduced-motion`.
- **Storage is disclosed in the same commit that writes it** — `src/legal.js` and
  `llms.txt`. A stale privacy policy is a worse defect than a late feature.
- **House voice.** Sentence case, no exclamation marks, no marketing voice, body
  paragraphs under about forty words. Comments explain *why* a non-obvious
  decision was made, not what the line does. Match `src/metrics.js`.
- **Do not rewrite the maintainer's prose** (README, TODO.md, TIP.md). If a
  sentence looks wrong, say so and stop.

## How to work here

- **Measure before changing a number.** A bound picked to make a test pass means
  nothing. Print the baseline, then choose the threshold from the geometry.
- **A green suite is not the verdict.** For anything that ends as a shape on a
  page, render a real sample and look at it.
- **Delete knobs whose theory died.** An honest comment does not save a parameter
  nobody will move.
- **Don't fan out subagents for single-file work.** Fan-out is for problems whose
  answer shape is unknown.
- **If a clearly-correct change makes things worse**, look for a parameter that
  was tuned around the old behaviour. Some changes are secretly one change.

## Open work

### Next
- **Font import has no UI yet.** `src/fontimport.js` is the engine and is tested;
  what is missing is a way to reach it — a drop target, the licence panel showing
  `fsType` and name IDs 13/14 before anything is built, and `filetype.js` no
  longer refusing `.otf`/`.ttf` with "that looks like a font".


### Phase 2 — sub-pixel tracing on the photo path
Gated on a real S Pen sample. Settle the coverage field first: Sauvola's
threshold is local, so raw greyscale's 0.5 level is not the edge. Then
`imageproc.js` builds and returns it *through the same deskew rotation as `bin`*,
`preprocess`'s shape and callers change, `segment.extractGlyph` crops it over the
padded window, `pipeline.capturePage` threads it. Store as `Uint8Array` 0–255,
cropped per glyph, never page-wide. Keep it away from `session.js`, which
`JSON.stringify`s everything it does not strip by name.

The rest — drop-off, traffic, Hangul — is in `TODO.md`.
