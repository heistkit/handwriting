/*
 * preflight.js — the choices that have to be on the page before it paints.
 *
 * Loaded as a plain blocking classic script from <head>, deliberately: not
 * `defer`, not `type="module"`. Both of those run after the document has been
 * parsed, and running after the parse is exactly the thing this exists to
 * avoid. A synchronous classic script executes where it sits, before the
 * stylesheet below it has painted anything, which is what keeps a reader who
 * chose the dark theme from being shown a white page first.
 *
 * Duplicated from theme.js, lite.js, textsize.js and flourish.js on purpose.
 * Those modules own these settings for the life of the page; this only has to
 * get the first frame right, and importing any of them here would reintroduce
 * the deferral it is here to sidestep.
 *
 * This used to be an inline <script> in index.html. It moved out so the
 * content-security policy can say `script-src 'self'` and mean it — with
 * 'unsafe-inline' in there, a policy that otherwise forbids every outbound
 * connection would still be one injected tag away from being talked around.
 * See vercel.json.
 *
 * Written in ES5 and staying that way. It runs before anything has established
 * that this browser can handle more, and a syntax error here is a blank page
 * rather than a degraded one.
 */
(function () {
  try {
    var t = localStorage.getItem('handwrite.theme');
    if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;

    var l = localStorage.getItem('handwrite.lite');
    if (l === 'on' || l === 'off') document.documentElement.dataset.lite = l;
    else if (matchMedia('(prefers-reduced-motion: reduce)').matches)
      document.documentElement.dataset.lite = 'on';

    /* Text size matters most here. Theme is a repaint, but this one reflows the
       entire page, so applying it after first paint would move every line under
       the reader's eye. */
    if (localStorage.getItem('handwrite.textsize') === 'large')
      document.documentElement.dataset.textsize = 'large';

    /* Decoration switches. Only the "off" answer is written, so a storage
       that cannot be read leaves the defaults on — and the specimen in the
       hero starts drawing on the first frame rather than after a module
       has loaded and told it whether it is allowed to. */
    if (localStorage.getItem('handwrite.fold') === 'off')
      document.documentElement.dataset.fold = 'off';
    if (localStorage.getItem('handwrite.decor') === 'off')
      document.documentElement.dataset.decor = 'off';
  } catch (e) { /* private mode: fall back to the system preference */ }
})();
