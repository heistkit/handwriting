/**
 * sw.js — the app, kept on the device.
 *
 * Handwrite already does all of its work locally; the only thing it needed the
 * network for was fetching its own code. This removes that too, so a session
 * interrupted on a train resumes on the train. It pairs with src/session.js,
 * which keeps the work: that restores what you had, this makes sure there is an
 * app to restore it into.
 *
 * Not at the top of the file by accident
 * --------------------------------------
 * A service worker is the stickiest thing a static site can install. Once it
 * controls the origin it keeps controlling it, so a bug shipped here is a bug
 * that outlives the fix — the broken version serves itself from cache and never
 * asks whether there is a better one. Everything below is arranged around that:
 *
 *   - Requests are served from cache and revalidated in the background, so a fix
 *     is picked up on the next load rather than never. A pure cache-first worker
 *     would pin the reader to whatever version they first met.
 *   - `skipWaiting` and `clients.claim()`, so a new worker takes over instead of
 *     waiting for every tab to close.
 *   - The cache name carries a version, and activation deletes every other cache
 *     this origin owns, so a rename is a clean sweep rather than an accumulation.
 *
 * The CSP trap
 * ------------
 * The page is served with `connect-src 'none'`, which is the point of the privacy
 * claim. A worker takes its CSP from the response headers of its OWN script, and
 * `connect-src` governs `fetch` inside it — including the fetches `addAll` makes.
 * Under the site-wide policy this file installs and then fails on its first line
 * of real work. vercel.json therefore gives `/sw.js` its own policy with
 * `connect-src 'self'`: it may talk to this origin and nothing else, which is all
 * it ever needs and no more than the page already allows itself.
 *
 * Nothing user-generated is stored here. This cache holds the application's own
 * files — the same bytes any visitor downloads. Handwriting, photographs and
 * fonts live in IndexedDB under src/session.js, which has its own switch.
 */

/* Bump on any change to PRECACHE or to the strategies below. */
const VERSION = 'handwrite-v2';

/**
 * Everything the app needs to start with no network at all.
 *
 * The whole of `src/`, not the module graph. Working out which files the shell
 * strictly needs means deciding what counts as the shell, and the honest answer
 * is that it changes: the redraw pad, the printable template and the tutorial all
 * arrive through dynamic import, and an offline session that dies the moment
 * somebody wants to repair a glyph is not an offline session. The directory is
 * about 400 KB and every file in it is code this origin serves anyway.
 *
 * `addAll` is atomic — one 404 and the entire install rejects, leaving no offline
 * support at all and nothing on screen to say so. There is no build step to
 * generate this list, so tools/sw.test.mjs asserts it matches the directory and
 * that every entry exists. That test is the reason a hand-written list is safe.
 */
const PRECACHE = [
  '/',
  '/styles.css',
  '/vendor/opentype.min.js',
  '/assets/fonts/Geist-Variable.woff2',
  '/assets/fonts/GeistMono-Variable.woff2',
  '/src/app.js',
  '/src/browsergate.js',
  '/src/celebrate.js',
  '/src/charset.js',
  '/src/congrats.js',
  '/src/content.js',
  '/src/demo.js',
  '/src/docsearch.js',
  '/src/draw.js',
  '/src/eggs.js',
  '/src/eta.js',
  '/src/export.js',
  '/src/filetype.js',
  '/src/flourish.js',
  '/src/fold.js',
  '/src/fontbuild.js',
  '/src/fontimport.js',
  '/src/gpos.js',
  '/src/health.js',
  '/src/imageproc.js',
  '/src/leaving.js',
  '/src/legal.js',
  '/src/lite.js',
  '/src/mascot.js',
  '/src/meta.js',
  '/src/metrics.js',
  '/src/nomodule.js',
  '/src/offline.js',
  '/src/paint.js',
  '/src/pipeline.js',
  '/src/pointer.js',
  '/src/preflight.js',
  '/src/ratelimit.js',
  '/src/reveal.js',
  '/src/routes.js',
  '/src/salvage.js',
  '/src/segment.js',
  '/src/session.js',
  '/src/sfnt.js',
  '/src/slider.js',
  '/src/specimen.js',
  '/src/stepshow.js',
  '/src/template.js',
  '/src/textsize.js',
  '/src/theme.js',
  '/src/timings.js',
  '/src/trace.js',
  '/src/tutorial.js',
  '/src/welcome.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(VERSION)
      .then((cache) => cache.addAll(PRECACHE))
      // Reported rather than swallowed. An install that fails leaves the site
      // working exactly as it did before this file existed, which is why it is
      // safe to let it fail — but silently would make it undiagnosable.
      .catch((err) => { console.error('sw: precache failed', err); throw err; })
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

/** Only same-origin GETs are ours to answer. */
function ours(request) {
  if (request.method !== 'GET') return false;
  const url = new URL(request.url);
  return url.origin === self.location.origin;
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (!ours(request)) return;

  // Every address in this app is the same document — vercel.json rewrites all of
  // them to index.html and the router decides what to show. So a navigation to
  // /guide offline is answered with the cached shell, which then routes itself.
  // Matching the request instead would miss, because '/guide' was never cached
  // under that name.
  const key = request.mode === 'navigate' ? '/' : request;

  event.respondWith(
    caches.match(key).then((hit) => {
      // Revalidate in the background whether or not there was a hit. On a hit
      // this is what stops a cached bug being permanent; on a miss it is the only
      // way to answer at all.
      const fresh = fetch(request)
        .then((response) => {
          // Opaque and error responses must never be stored: caching a 404 or a
          // failed range request would serve it back forever.
          if (response.ok && response.type === 'basic') {
            const copy = response.clone();
            caches.open(VERSION).then((cache) => cache.put(key, copy)).catch(() => {});
          }
          return response;
        })
        .catch(() => null);

      if (hit) return hit;
      return fresh.then((response) => response ?? Response.error());
    })
  );
});
