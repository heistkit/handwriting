# TODO.md

## Now — clears the decks
- [x] Split `142ec69`. `metrics.profilesFromContours` is inert font-import
      groundwork inside a tracing commit. Unpushed, so `git reset --soft` and
      recommit.
- [x] Delete `tangentSpan`. Theory died; the knob shouldn't outlive it.
- [ ] Export an S Pen sample and look at it. Everything below assumes tracing is
      fixed — this is the only thing that confirms it.
      *Still open. The hero specimen's hand-authored letterforms have been put
      through the pad and looked at — letterforms survive intact, refinement is
      2.2x at ~110 px — but that is authored artwork, not stylus ink.*
- [x] Rewrite `docs/HANDOFF.md`. It still says "the algorithmic core is
      finished" and scopes modules that already exist.
- [ ] Push.

## Phase 2 — photo path sub-pixel
- [ ] Settle the coverage field first: `0.5 + (threshold − grey) / (2·contrast)`
      or something better. Design question, not plumbing.
- [ ] `imageproc.js` builds and returns it — through the same deskew rotation as
      `bin` or it won't align.
- [ ] `preprocess` return shape + callers.
- [ ] `segment.extractGlyph` — crop over the padded window; decide what
      `partIds` masking means for a continuous field.
- [ ] `pipeline.capturePage` threads it.
- [ ] Store as `Uint8Array` 0–255, cropped per glyph, never page-wide.
- [ ] Keep it away from `session.js` — it `JSON.stringify`s everything it
      doesn't strip by name.

## Font import (.ttf/.otf)
- [ ] Parallel normaliser that skips `solveAllRows` and feeds `computeSpacing`.
- [ ] Finish `profilesFromContours` so bearings don't need a raster round-trip.
- [ ] Preserve imported bearings by default; re-derive only on request.
- [ ] Read OS/2 `fsType` + name IDs 13/14, show them, refuse restricted
      embedding.
- [ ] UPM normalise to 1000 / x-height 500; quad→cubic via `glyph.path`.

## Drop-off — ship before 120 characters
- [ ] Build a usable font from sheet 1 (~40 chars).
- [ ] Fallback for missing glyphs instead of blocking.
- [ ] Let people install early and add sheets later.

## Traffic
- [ ] Specimen page in the export `.zip` carries the URL. Every shared font
      links back.
- [ ] Submit to AlternativeTo + Product Hunt — those pages already rank for
      "Calligraphr alternative".
- [ ] Post to r/handwriting, r/fountainpens, r/bulletjournal, stylus communities.
      Lead with the output, not the app.
- [ ] Write the constrained-charset explainer. That's the part people argue
      with, and arguing is how contributors arrive.
- [ ] `CONTRIBUTING.md` + a couple of scoped issues.

## Bigger
- [ ] Hangul. Jamo composition makes it tractable and nobody serves it.
- [ ] Real Bold from a second heavier-pen sheet instead of 2% synthetic.
- [ ] Surface `health.js` per-glyph, route bad traces to the redraw pad.
- [ ] In-browser glyph completion for characters never written (€, ß, æ,
      accents) — only if it stays client-side.
