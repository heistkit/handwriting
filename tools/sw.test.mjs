/**
 * Checks on the service worker's precache list.
 *
 * `caches.addAll` is atomic: one entry that 404s and the whole install rejects,
 * so the site silently has no offline support and nothing on screen says so. With
 * no build step there is nothing generating the list, which makes it exactly the
 * kind of hand-maintained inventory that goes stale the first time somebody adds
 * a module. This is the test that makes writing it by hand defensible.
 *
 * It also pins the one piece of configuration the worker cannot survive without:
 * its own content-security policy. The site is served `connect-src 'none'`, a
 * worker inherits the CSP of its own script, and `connect-src` governs the
 * fetches `addAll` makes — so under the site-wide policy this file installs and
 * then fails on its first useful line.
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass });
  console.log(`  ${pass ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};

const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

export async function run() {
  console.log('\nsw.js');

  const source = readFileSync(`${root}/sw.js`, 'utf8');
  const block = source.match(/const PRECACHE = \[([\s\S]*?)\];/);
  check('the precache list can be read', Boolean(block));
  if (!block) return results;

  const list = [...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  check('and is not empty', list.length > 10, `${list.length} entries`);

  // -- every entry resolves to something on disk ----------------------------
  const missing = list.filter((p) => {
    if (p === '/') return !existsSync(`${root}/index.html`);
    return !existsSync(root + p);
  });
  check('every precached path exists', missing.length === 0, missing.join(', '));

  // -- no duplicates, which would double the install for nothing ------------
  const dupes = list.filter((p, i) => list.indexOf(p) !== i);
  check('no entry is listed twice', dupes.length === 0, dupes.join(', '));

  // -- the whole of src/ is covered -----------------------------------------
  //
  // The list deliberately takes the directory rather than the module graph, so a
  // new module is covered the moment it exists. This is what notices when one is
  // added and the list is not touched.
  const modules = readdirSync(`${root}/src`).filter((f) => f.endsWith('.js'));
  const cached = new Set(list.filter((p) => p.startsWith('/src/')).map((p) => p.slice(5)));
  const uncovered = modules.filter((f) => !cached.has(f));
  check('every module in src/ is precached', uncovered.length === 0, uncovered.join(', '));

  const ghosts = [...cached].filter((f) => !modules.includes(f));
  check('and nothing is precached that no longer exists', ghosts.length === 0, ghosts.join(', '));

  // -- the shell itself -----------------------------------------------------
  for (const need of ['/', '/styles.css', '/vendor/opentype.min.js']) {
    check(`the shell includes ${need}`, list.includes(need));
  }
  const fonts = readdirSync(`${root}/assets/fonts`).filter((f) => f.endsWith('.woff2'));
  check('and every bundled font', fonts.every((f) => list.includes(`/assets/fonts/${f}`)),
    fonts.join(', '));

  // -- the worker must not cache itself -------------------------------------
  //
  // A worker that precaches its own script serves the old copy of itself back on
  // every update check, which is the classic way to make one permanently
  // unfixable. The browser handles worker updates; it needs no help.
  check('the worker does not precache itself', !list.includes('/sw.js'));

  // -- and it needs a policy of its own -------------------------------------
  const vercel = JSON.parse(readFileSync(`${root}/vercel.json`, 'utf8'));
  const own = vercel.headers.find((h) => h.source === '/sw.js');
  check('vercel.json gives /sw.js its own headers', Boolean(own));

  const csp = own?.headers.find((h) => h.key === 'Content-Security-Policy')?.value ?? '';
  check('whose policy lets it reach this origin', csp.includes("connect-src 'self'"), csp);

  const siteWide = vercel.headers
    .find((h) => h.source === '/(.*)')
    ?.headers.find((h) => h.key === 'Content-Security-Policy')?.value ?? '';
  check('while the site-wide policy still forbids every connection',
    siteWide.includes("connect-src 'none'"),
    'the page must not gain network access from this');

  const cacheControl = own?.headers.find((h) => h.key === 'Cache-Control')?.value ?? '';
  check('and the worker script is revalidated rather than held',
    /max-age=0|no-cache|must-revalidate/.test(cacheControl), cacheControl);

  // -- registration is wired and is not load-bearing ------------------------
  const app = readFileSync(`${root}/src/app.js`, 'utf8');
  check('app.js registers the worker', app.includes('initOffline()'));

  const offline = readFileSync(`${root}/src/offline.js`, 'utf8');
  check('registration is skipped outside a secure context',
    offline.includes('isSecureContext'),
    'file:// and plain http would throw');
  check('and a failure to register is caught, not thrown',
    /\.catch\(/.test(offline), 'the app must work exactly as before if this fails');

  return results;
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}`) run();
