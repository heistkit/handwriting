# TIP.md

Notes for whoever picks this up next. Not a spec, just things that cost time to
learn.

## Measure before you change a number

Tightening a test bound without knowing where the error currently sits produces
a number that means nothing. The sub-pixel tracing work only landed cleanly
because the baseline got measured first — and the measurement caught two things
reasoning had gotten wrong.

## Some changes are secretly one change

Refining the boundary alone made two of five figures *worse*. The fit tolerance
was loose on purpose, so the fitter wouldn't chase a staircase — so it was
throwing away a boundary that had just become 6× more accurate. Halving it
alongside turned a regression into a 0.004 px hairline.

If a clearly-correct change makes things worse, look for the parameter that was
tuned around the old behaviour.

## A bilinear interpolant cannot represent a corner

Three of four samples around a convex right angle are paper, so the field reads
0.25 at the tip and any 0.5 search finds a crossing *inside* the corner. This
isn't a bug to tune out. Corners get excluded — `detectCorners` has already run
on the raw walk, so it costs a set lookup.

## Greyscale is not a coverage field

Sauvola's threshold is local and varies per pixel, so raw grey's 0.5 level isn't
the edge. Anything that wants sub-pixel refinement on the photo path needs the
grey normalised against the threshold and contrast Sauvola already computes.
Settle that before writing plumbing.

## Delete knobs whose theory died

`tangentSpan` exists because of a hypothesis about staircase jogs that didn't
survive end-to-end. An honest comment doesn't save a parameter nobody will ever
move — it just makes the next reader spend ten minutes deciding whether to.

## Don't fan out agents for single-file work

Six probes and 751k tokens to scout a change that's one file and one test costs
more than doing it. Fan-out is for problems where the *shape* of the answer is
unknown.

## The test suite is not the verdict

559 passing checks and a 5.8× boundary improvement still don't tell you the font
looks like someone's handwriting. Export a real sample and look at it.
