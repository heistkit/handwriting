/*
 * nomodule.js — the message for a browser that cannot run this app at all.
 *
 * Loaded as `<script nomodule src="src/nomodule.js">`. The `nomodule` attribute
 * is the browser telling us it has no ES module support, rather than us
 * inferring it from a feature test that could be wrong for some other reason —
 * and a browser new enough to understand `nomodule` skips this file entirely,
 * so it costs a modern reader nothing, not even a request.
 *
 * Kept in its own file rather than folded into preflight.js, which is the other
 * script that moved out of index.html for the content-security policy. They
 * cannot share one: preflight runs everywhere, this must run *only* where
 * modules are absent, and merging them would mean re-deriving that condition
 * with a feature test — replacing the browser's own answer with a guess, which
 * is the thing the `nomodule` attribute exists to avoid.
 *
 * Deliberately ES5, and deliberately document.write. This executes while the
 * parser is still working through <head>, so there is no <body> to append to
 * yet; document.write inserts at the point the parser has reached, which is
 * exactly where this belongs. A blocking classic script is still allowed to do
 * that — the intervention browsers apply to document.write concerns injecting
 * further scripts over a slow connection, not writing markup.
 */
document.documentElement.className += ' bgate-open';
document.write(
  '<div class="bgate" role="alertdialog" aria-labelledby="bgate-nomod">' +
    '<div class="bgate__panel">' +
      '<h1 class="bgate__title" id="bgate-nomod">This browser is too old to run Handwrite</h1>' +
      '<p class="bgate__lede">It does not support JavaScript modules, which every part of this app is written as. There is no version of the page that would work here.</p>' +
      '<p class="bgate__advice">Any browser from 2018 onward has them. Updating is the whole fix.</p>' +
    '</div>' +
  '</div>'
);
