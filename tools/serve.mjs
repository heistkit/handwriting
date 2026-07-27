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
    });
    res.end(body);
  } catch (err) {
    res.writeHead(500, { 'content-type': 'text/plain' });
    res.end(String(err));
  }
}).listen(PORT, () => {
  console.log(`Handwrite dev server → http://localhost:${PORT}`);
});
