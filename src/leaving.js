/**
 * leaving.js — a stop before every link that goes somewhere else.
 *
 * Why bother, on a page with four outbound links
 * ----------------------------------------------
 * The whole claim of this app is that nothing leaves your device. Every
 * outbound link is a moment where that stops being true — not because the app
 * sends anything, but because *you* arrive somewhere with a referrer, an IP and
 * whatever that site does next. Naming the destination before you go is the
 * only point at which that is still your decision.
 *
 * It also puts the URL in front of you in full. Link text can say one thing and
 * point at another, and on a page whose links are mostly to a source repository
 * — the thing a suspicious reader would want to check — being able to read the
 * address before following it is worth one extra click.
 *
 * What it deliberately does not do
 * --------------------------------
 * It does not claim to make anything safe. It is a notice, not a scanner, and
 * the Terms say so in clause 8.4. Pretending otherwise would be worse than
 * having no interstitial at all.
 *
 * Modified clicks pass straight through. Ctrl-click, middle-click and
 * shift-click are all explicit "open this somewhere else" instructions, and
 * intercepting them replaces something the reader asked for with a dialogue
 * they did not. Downloads and `mailto:` are left alone for the same reason.
 */

const SAFE_PROTOCOLS = new Set(['http:', 'https:']);

/** A click the browser already has a special meaning for. */
const modified = (e) =>
  e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey;

export function isExternal(anchor) {
  if (!anchor?.href) return false;
  if (anchor.hasAttribute('download')) return false;
  let url;
  try {
    url = new URL(anchor.href, location.href);
  } catch {
    return false;
  }
  if (!SAFE_PROTOCOLS.has(url.protocol)) return false;
  return url.origin !== location.origin;
}

/**
 * @param {object} handlers
 * @param {(url: URL, anchor: HTMLAnchorElement) => void} handlers.onLeave
 */
export function intercept({ onLeave }) {
  document.addEventListener('click', (e) => {
    if (modified(e)) return;
    const anchor = e.target.closest?.('a[href]');
    if (!isExternal(anchor)) return;
    // Opt-out for anything that genuinely should not be interrupted.
    if (anchor.dataset.noInterstitial !== undefined) return;

    e.preventDefault();
    onLeave(new URL(anchor.href, location.href), anchor);
  });
}

/**
 * Split a URL so the host can be shown large and the rest small.
 *
 * The host is the part that decides where you actually end up, so it gets the
 * emphasis. A long path rendered at the same weight is how a reader's eye
 * slides past `github.com.example.net` without stopping.
 */
export function describe(url) {
  return {
    host: url.host,
    rest: `${url.pathname}${url.search}${url.hash}`.replace(/^\/$/, ''),
    href: url.href,
    secure: url.protocol === 'https:',
  };
}
