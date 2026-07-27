/**
 * paint.js — a palette token, resolved to a colour a canvas will accept.
 *
 * The bug this exists to stop
 * ---------------------------
 * `getComputedStyle(el).getPropertyValue('--text')` does not return a colour.
 * For an unregistered custom property it returns the *token stream* exactly as
 * written, and every colour in this app is written with light-dark():
 *
 *     getPropertyValue('--text')  →  "light-dark(#1c2128, #e4e9ef)"
 *
 * Hand that to ctx.strokeStyle and the canvas rejects it as an invalid colour.
 * Canvas colour setters do not throw and do not clear — an invalid assignment
 * is simply ignored, so the context keeps whatever it had, which for a fresh
 * context is #000000.
 *
 * That is how the draw pad came to render black ink, black guide rules and a
 * black ghost letter on a near-black surface in dark mode, with nothing in the
 * console. Every colour it asked for silently became the same colour.
 *
 * The fix is to make the browser do the resolving. Put the token on a real
 * element, let the cascade compute it, and read the computed value back — that
 * is the only path that resolves light-dark(), color-mix(), relative colours,
 * and anything else CSS grows later, because it is CSS doing the work.
 *
 * Why background-color and not color
 * ----------------------------------
 * `color` is inherited. If the var fails, the declaration is invalid at
 * computed-value time, `color` falls back to `inherit`, and the probe returns
 * the page's text colour — a plausible-looking answer to a question that
 * failed. `background-color` is not inherited and starts at `transparent`, so
 * a failure is unambiguous and the caller's fallback is actually used.
 */

const CACHE = new Map();
let cachedFor = null;

/**
 * Which palette is live. Cheap enough to check on every call, and it means a
 * theme switch invalidates the cache without anyone having to remember to.
 */
function paletteKey() {
  const picked = document.documentElement.dataset.theme;
  if (picked) return picked;
  if (typeof matchMedia === 'function') {
    return matchMedia('(prefers-color-scheme: light)').matches ? 'system-light' : 'system-dark';
  }
  return 'system-unknown';
}

/**
 * Resolve a per-theme fallback against the live palette.
 *
 * A single hardcoded fallback is always wrong in one theme. Every one of them
 * in this app was the dark branch, so the failure path — token missing, CSS
 * blocked, stylesheet not applied yet — painted #e4e9ef ink on a #fbfcfd
 * surface in light mode: 1.19:1, an invisible interface in exactly the
 * situation the fallback exists to rescue.
 *
 * 'system-unknown' lands on dark, matching `color-scheme: dark` in :root.
 */
function pick(fallback, key) {
  if (typeof fallback === 'string' || !fallback) return fallback;
  const light = key === 'light' || key === 'system-light';
  return light ? fallback.light : fallback.dark;
}

/**
 * @param {string} name  custom property, including the leading dashes
 * @param {string|{light: string, dark: string}} fallback  used when the token
 *   is missing or does not resolve. Prefer the two-branch form for anything
 *   that has to stay legible against a themed surface.
 * @returns {string} an rgb()/rgba()/color() string
 */
export function token(name, fallback) {
  try {
    const key = paletteKey();
    if (key !== cachedFor) {
      CACHE.clear();
      cachedFor = key;
    }
    const hit = CACHE.get(name);
    if (hit) return hit;

    const probe = document.createElement('span');
    probe.setAttribute('aria-hidden', 'true');
    // Out of flow and zero-sized: this must not be able to affect layout, and
    // display:none would stop the cascade computing anything at all.
    probe.style.cssText =
      'position:fixed;left:-9999px;top:0;width:0;height:0;pointer-events:none;contain:strict';
    probe.style.backgroundColor = `var(${name})`;

    const host = document.body || document.documentElement;
    host.append(probe);
    const computed = getComputedStyle(probe).backgroundColor;
    probe.remove();

    const failed = !computed || computed === 'rgba(0, 0, 0, 0)' || computed === 'transparent';
    const out = failed ? pick(fallback, key) : computed;
    CACHE.set(name, out);
    return out;
  } catch {
    return pick(fallback, paletteKeySafe());
  }
}

/** paletteKey() reads the DOM, and this path is reached because something threw. */
function paletteKeySafe() {
  try {
    return paletteKey();
  } catch {
    return 'system-unknown';
  }
}

/** Drop everything. For a caller that knows the palette moved under it. */
export function forget() {
  CACHE.clear();
  cachedFor = null;
}

/**
 * Call `fn` whenever the live palette changes — an explicit theme choice, or
 * the system flipping while the visitor is following it.
 *
 * @param {() => void} fn
 * @returns {() => void} unsubscribe
 */
export function onPaletteChange(fn) {
  const fire = () => {
    forget();
    fn();
  };

  let observer = null;
  try {
    observer = new MutationObserver(fire);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  } catch {
    /* no MutationObserver — the explicit switch simply will not repaint live */
  }

  let query = null;
  if (typeof matchMedia === 'function') {
    query = matchMedia('(prefers-color-scheme: light)');
    query.addEventListener?.('change', fire);
  }

  return () => {
    observer?.disconnect();
    query?.removeEventListener?.('change', fire);
  };
}
