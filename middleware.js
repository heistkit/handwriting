/**
 * middleware.js — per-address request throttle, enforced at the edge.
 *
 * Limit: 500 page requests per rolling 60 seconds per client address.
 *
 * Runs as Vercel Edge Middleware, which means it executes before the static
 * file is served and cannot be bypassed from the browser — unlike the
 * per-device limit in src/ratelimit.js, which is a guardrail rather than a
 * control. Together they are the two limits described in the Terms.
 *
 * Scope
 * -----
 * The matcher below restricts this to document requests: `/` and `/index.html`.
 * That makes the unit a *page load*, not an HTTP request, which is both what
 * the limit is meant to express and what keeps it cheap — a single visit pulls
 * 19 files, so counting all of them would make 500/min mean 26 visits/min and
 * would break shared office and campus networks behind one NAT address.
 *
 * Sub-resources are left to the CDN, which is the right layer for them: they
 * are immutable, edge-cached, and mostly never reach an origin at all.
 *
 * Honest accounting of what this guarantees
 * -----------------------------------------
 * The counter lives in the memory of one edge isolate. Consequently:
 *
 *   - It is per-region. A client spread across regions gets a higher effective
 *     ceiling than 500/min globally.
 *   - Isolates are recycled when idle, which resets counters.
 *   - Two isolates in the same region do not share state.
 *
 * It is therefore a reliable brake on the realistic case — a burst from one
 * source, which lands in one region and hits one isolate — and an approximation
 * globally. Making it exact requires shared state (Vercel KV or Upstash Redis)
 * and turns a zero-dependency file into a service with a database. That
 * tradeoff is not worth taking pre-emptively, and the seam is here if it ever
 * becomes worth it: replace `hit()` with an atomic INCR against a store.
 *
 * Platform-level volumetric attacks are Vercel's job and are already handled
 * upstream of this file by their DDoS mitigation and Attack Challenge Mode.
 *
 * Failure policy: fail open. Every path is wrapped so that a bug here degrades
 * to "serve the page" rather than "take the site down".
 *
 * Continuing the request
 * ----------------------
 * On a project with no framework, a request is passed through by returning
 * `next()` from @vercel/functions — which is a Response carrying the header
 * `x-middleware-next: 1`. Returning nothing is *not* the documented contract
 * here, and would risk serving an empty body at `/`, so the helper is used
 * even though it costs a dependency in an otherwise dependency-free project.
 */

import { next } from '@vercel/functions';

export const config = {
  matcher: ['/', '/index.html'],
};

const LIMIT = 500;
const WINDOW_MS = 60_000;

/**
 * Hard cap on tracked addresses. Without it, a flood from many spoofed sources
 * would grow this map until the isolate ran out of memory — turning a rate
 * limiter into the very outage it exists to prevent.
 */
const MAX_TRACKED = 20_000;

/** address -> number[] of request timestamps within the window */
const hits = new Map();
let lastSweep = 0;

/** Drop expired entries. Amortised: at most once per second. */
function sweep(now) {
  if (now - lastSweep < 1000) return;
  lastSweep = now;
  const cutoff = now - WINDOW_MS;
  for (const [addr, times] of hits) {
    const live = times.filter((t) => t > cutoff);
    if (live.length) hits.set(addr, live);
    else hits.delete(addr);
  }
}

/**
 * The client address. `x-forwarded-for` is a list appended to by each proxy;
 * on Vercel the client is the first entry. `x-real-ip` is the fallback.
 *
 * These headers are client-supplied in principle, but on Vercel they are
 * rewritten at the edge, so the leftmost value is trustworthy here in a way it
 * would not be behind an arbitrary proxy.
 */
function clientAddress(request) {
  const fwd = request.headers.get('x-forwarded-for');
  if (fwd) {
    const first = fwd.split(',')[0].trim();
    if (first) return first;
  }
  return request.headers.get('x-real-ip') || 'unknown';
}

function hit(address, now) {
  sweep(now);

  const cutoff = now - WINDOW_MS;
  const times = (hits.get(address) || []).filter((t) => t > cutoff);

  if (times.length >= LIMIT) {
    const retryAfter = Math.max(1, Math.ceil((Math.min(...times) + WINDOW_MS - now) / 1000));
    return { allowed: false, remaining: 0, retryAfter };
  }

  times.push(now);

  // Only start tracking a new address if there is room. An address already
  // being tracked keeps its counter, so an in-progress flood stays throttled
  // even once the table is full.
  if (hits.has(address) || hits.size < MAX_TRACKED) hits.set(address, times);

  return { allowed: true, remaining: LIMIT - times.length, retryAfter: 0 };
}

const RETRY_PAGE = (retryAfter) => `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Too many requests — Handwrite</title>
<style>
  :root { color-scheme: light dark; }
  body { margin:0; min-height:100vh; display:grid; place-items:center;
         font:16px/1.6 ui-sans-serif,system-ui,sans-serif; background:#f7f7f5; color:#22252b; padding:2rem; }
  @media (prefers-color-scheme: dark) { body { background:#16181d; color:#e8e9ec; } }
  main { max-width:34rem; text-align:center; }
  h1 { font-size:1.35rem; margin:0 0 .75rem; letter-spacing:-.02em; }
  p { margin:0 0 .6rem; opacity:.78; }
</style>
<main>
  <h1>Too many requests</h1>
  <p>This network has requested the page more than ${LIMIT} times in a minute, so it has been paused briefly to keep the site responsive for everyone.</p>
  <p>Try again in about ${retryAfter} second${retryAfter === 1 ? '' : 's'}.</p>
  <p>If you were in the middle of making a font, nothing has been lost — the work happens in your browser, not here.</p>
</main>`;

export default function middleware(request) {
  try {
    const now = Date.now();
    const result = hit(clientAddress(request), now);

    if (!result.allowed) {
      return new Response(RETRY_PAGE(result.retryAfter), {
        status: 429,
        headers: {
          'content-type': 'text/html; charset=utf-8',
          'retry-after': String(result.retryAfter),
          'x-ratelimit-limit': String(LIMIT),
          'x-ratelimit-remaining': '0',
          // A 429 must never be cached, or the CDN would serve it to everyone.
          'cache-control': 'no-store',
        },
      });
    }
  } catch {
    // Fail open: a defect in the limiter must not take the site down.
  }
  return next();
}
