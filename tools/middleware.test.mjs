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
  new Request('https://inkwell.test/', {
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
    check('tolerates no forwarding header', passesThrough(mw(new Request('https://inkwell.test/'))));
    check('tolerates an empty header',
      passesThrough(mw(new Request('https://inkwell.test/', { headers: { 'x-forwarded-for': '' } }))));
    check('tolerates x-real-ip only',
      passesThrough(mw(new Request('https://inkwell.test/', { headers: { 'x-real-ip': '192.0.2.7' } }))));
  }

  // --- scope ---------------------------------------------------------------
  {
    const m = config.matcher;
    check('matcher is document-only', Array.isArray(m) && m.includes('/') && m.length <= 2,
      JSON.stringify(m));
    check('matcher excludes assets', !JSON.stringify(m).includes('assets'));
  }

  return results;
}
