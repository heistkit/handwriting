/**
 * Development static server.
 *
 * Hand-rolled rather than pulled from npm so the repo stays dependency-free —
 * the app itself has no build step, and a dev server is not a good reason to
 * introduce a lockfile.
 *
 * The MIME table is the only part that matters: browsers refuse to execute an
 * ES module served as anything other than a JavaScript type, and the failure
 * shows up as a bare "Failed to load module script" with no further detail.
 */

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const PORT = Number(process.env.PORT) || 8745;

/**
 * The same content-security policy the deployment sends.
 *
 * Read out of vercel.json rather than written twice. A policy that exists only
 * in production is a policy nobody finds out they have broken until it is
 * deployed — and the failure it produces is a blocked resource and a silent
 * gap on the page, not an error anyone would go looking for. Serving it here
 * means the browser refuses the same things in development that it refuses
 * live, and a test asserts the two are still the same string.
 */
const VERCEL_HEADERS = JSON.parse(await readFile(join(ROOT, 'vercel.json'), 'utf8')).headers;

const cspFor = (source) =>
  VERCEL_HEADERS.find((h) => h.source === source)
    ?.headers.find((h) => h.key === 'Content-Security-Policy')?.value;

const CSP = cspFor('/(.*)');

/**
 * Paths that vercel.json gives a policy of their own.
 *
 * `/sw.js` is the only one so far, and it has to be honoured here or offline
 * support cannot be tested locally at all. The site-wide policy carries
 * `connect-src 'none'`, a service worker inherits the policy of its own script,
 * and `connect-src` governs the fetches `cache.addAll` makes — so serving the
 * worker under the site-wide policy makes it install and then immediately fail,
 * with the registration going straight to `redundant`. Which is exactly what
 * happened here, and it looks precisely like a bug in the worker.
 *
 * Matched exactly rather than by pattern. vercel.json's sources are its own glob
 * dialect and reimplementing it would be a second thing to get wrong; an exact
 * lookup is enough for every override this file has, and an override that stops
 * matching is caught by tools/sw.test.mjs asserting the entry exists.
 */
const OVERRIDES = new Map(
  ['/sw.js']
    .map((source) => [source, cspFor(source)])
    .filter(([, value]) => value)
);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.otf': 'font/otf',
  '.ttf': 'font/ttf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.md': 'text/markdown; charset=utf-8',
  // robots.txt, llms.txt and sitemap.xml. Without these they fall to
  // application/octet-stream, which makes the browser download the file
  // instead of showing it — and "did I break the sitemap" then looks
  // identical to "the sitemap is fine".
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
};

createServer(async (req, res) => {
  try {
    const url = decodeURIComponent(req.url.split('?')[0]);
    let path = join(ROOT, normalize(url).replace(/^(\.\.[/\\])+/, ''));

    let info = await stat(path).catch(() => null);
    if (info?.isDirectory()) {
      path = join(path, 'index.html');
      info = await stat(path).catch(() => null);
    }
    // A lesson address is one segment deeper than every other screen —
    // /guide/pen — so the browser resolves this document's relative assets
    // against /guide/ rather than the root: styles.css, vendor/opentype.min.js
    // and src/app.js from the document itself, and assets/fonts/*.woff2 from
    // inside styles.css, whose own URL stays /guide/styles.css even once it is
    // hoisted. Hoisting them back is what vercel.json does in production;
    // without the same rule here the page loads unstyled and scriptless in
    // development only, which is the worst place for the two to disagree.
    // Extension-only, so /guide/pen itself still falls through to the route
    // branch below and gets index.html.
    if (!info && extname(url) && url.startsWith('/guide/')) {
      const hoisted = join(ROOT, normalize(url.slice('/guide'.length)).replace(/^(\.\.[/\\])+/, ''));
      const alt = await stat(hoisted).catch(() => null);
      if (alt?.isFile()) {
        path = hoisted;
        info = alt;
      }
    }

    // Every screen has its own address — /write, /guide, /terms — and none of
    // them is a file. Anything without an extension that does not exist on disk
    // is a route, so it gets index.html and the router sorts it out. Requests
    // that do name a file (a missing .js, a typo'd .woff2) still 404, because
    // answering those with HTML turns a broken asset into a silent mystery.
    if (!info && !extname(url)) {
      path = join(ROOT, 'index.html');
      info = await stat(path).catch(() => null);
    }
    if (!info) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('Not found');
      return;
    }

    const body = await readFile(path);
    res.writeHead(200, {
      'content-type': TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream',
      'cache-control': 'no-store',
      'content-security-policy': OVERRIDES.get(url) ?? CSP,
    });
    res.end(body);
  } catch (err) {
    res.writeHead(500, { 'content-type': 'text/plain' });
    res.end(String(err));
  }
}).listen(PORT, () => {
  console.log(`Handwrite dev server → http://localhost:${PORT}`);
});
