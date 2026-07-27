/**
 * Tests for the edge rate limiter.
 *
 * The middleware is a plain function over a standard Request, so it runs in
 * Node exactly as it will on the edge — no Vercel emulation needed.
 *
 * Note this suite mutates module-level state in middleware.js (the counter map
 * is a module singleton, as it must be on the edge). The cases below are
 * ordered so that each uses a fresh address.
 */

import mw, { config } from '../middleware.js';

/**
 * A passed-through request is not `undefined` — on a frameworkless project it
 * is the Response that `next()` returns, marked with `x-middleware-next: 1`.
 * Asserting on that header is what actually proves the request reaches the
 * static file rather than being answered with an empty body.
 */
const passesThrough = (r) =>
  r instanceof Response && r.headers.get('x-middleware-next') === '1';

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass });
  console.log(`  ${pass ? 'ok  ' : 'FAIL'} ${name}${detail && !pass ? ` — ${detail}` : ''}`);
};

const req = (ip) =>
  new Request('https://handwrite.test/', {
    headers: ip ? { 'x-forwarded-for': `${ip}, 10.0.0.1` } : {},
  });

export async function run() {
  console.log('\nmiddleware');

  // --- the limit binds at exactly 500 --------------------------------------
  {
    let allowed = 0;
    let firstBlock = null;
    for (let i = 1; i <= 520; i++) {
      const r = mw(req('203.0.113.9'));
      if (passesThrough(r)) allowed++;
      else if (firstBlock === null) firstBlock = i;
    }
    check('allows exactly 500', allowed === 500, String(allowed));
    check('blocks from the 501st', firstBlock === 501, String(firstBlock));
  }

  // --- the block is per address, not global --------------------------------
  {
    check('a different address is unaffected', passesThrough(mw(req('198.51.100.4'))));
  }

  // --- the rejection is well-formed ----------------------------------------
  {
    const r = mw(req('203.0.113.9'));
    check('rejects with 429', r?.status === 429, String(r?.status));
    check('sets retry-after', Number(r?.headers.get('retry-after')) > 0,
      r?.headers.get('retry-after'));
    check('retry-after is within the window', Number(r?.headers.get('retry-after')) <= 60,
      r?.headers.get('retry-after'));
    check('sets ratelimit headers', r?.headers.get('x-ratelimit-limit') === '500');
    // A cached 429 at the CDN would serve the block to every visitor.
    check('forbids caching the rejection', r?.headers.get('cache-control') === 'no-store',
      r?.headers.get('cache-control'));
    check('rejection is a readable page', /text\/html/.test(r?.headers.get('content-type') || ''));
  }

  // --- rejection body explains itself --------------------------------------
  {
    const body = await mw(req('203.0.113.9')).text();
    check('body mentions the wait', /try again in about/i.test(body));
    check('body reassures about lost work', /nothing has been lost/i.test(body));
    check('body is a complete document', /<!doctype html>/i.test(body));
  }

  // --- passing a request through -------------------------------------------
  {
    const r = mw(req('198.51.100.55'));
    check('continues with a Response, not undefined', r instanceof Response, typeof r);
    check('marks the response as pass-through',
      r.headers.get('x-middleware-next') === '1', JSON.stringify([...r.headers]));
    check('pass-through carries no body', r.status === 200);
  }

  // --- missing or malformed client address ---------------------------------
  {
    check('tolerates no forwarding header', passesThrough(mw(new Request('https://handwrite.test/'))));
    check('tolerates an empty header',
      passesThrough(mw(new Request('https://handwrite.test/', { headers: { 'x-forwarded-for': '' } }))));
    check('tolerates x-real-ip only',
      passesThrough(mw(new Request('https://handwrite.test/', { headers: { 'x-real-ip': '192.0.2.7' } }))));
  }

  // --- scope ---------------------------------------------------------------
  {
    const m = config.matcher;
    check('matcher covers the root', Array.isArray(m) && m.includes('/'));

    // Every screen has its own address now, so the matcher has to cover them
    // all or the limit is sidestepped by asking for /write instead of /. What
    // matters is that it still counts *documents* only: one page load is one
    // hit, and the 19 sub-resources behind it are the CDN's problem.
    const pattern = m.find((entry) => entry.includes('(?!'));
    const re = new RegExp(`^${pattern}$`);

    const documents = ['/write', '/capture', '/review', '/refine', '/download', '/guide', '/settings', '/privacy', '/terms', '/licences'];
    check('matcher covers every routed screen',
      documents.every((p) => re.test(p)),
      documents.filter((p) => !re.test(p)).join(', '));

    const assets = [
      '/styles.css', '/src/app.js', '/src/routes.js', '/vendor/opentype.min.js',
      '/assets/fonts/Geist-Variable.woff2', '/index.html', '/favicon.ico',
    ];
    check('matcher excludes every asset',
      assets.every((p) => !re.test(p)),
      assets.filter((p) => re.test(p)).join(', '));
  }

  return results;
}
