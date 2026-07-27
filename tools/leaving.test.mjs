/**
 * Tests for the outbound-link notice.
 *
 * The classifier is the part worth testing. Everything else in leaving.js is a
 * click listener and a dialogue; what decides whether a reader is interrupted
 * is `isExternal`, and it has two symmetric ways to be wrong. Interrupting an
 * internal link is an annoyance on every navigation. Failing to catch an
 * external one silently defeats the feature on exactly the link that most
 * needed it — which is why the same-origin cases matter as much as the
 * cross-origin ones, and why a lookalike host is checked explicitly.
 */

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass });
  console.log(`  ${pass ? 'ok  ' : 'FAIL'} ${name}${detail && !pass ? ` — ${detail}` : ''}`);
};

const ORIGIN = 'https://handwrite.app';

/** A stand-in for an <a>, resolving href the way the DOM would. */
function anchor(href, attrs = {}) {
  let resolved;
  try {
    resolved = new URL(href, `${ORIGIN}/write`).href;
  } catch {
    resolved = href;
  }
  return {
    href: resolved,
    hasAttribute: (n) => n in attrs,
    dataset: attrs.dataset ?? {},
  };
}

export async function run() {
  globalThis.location = { href: `${ORIGIN}/write`, origin: ORIGIN };
  const { isExternal, describe } = await import('../src/leaving.js');

  // --- internal: must never be interrupted ---------------------------------
  {
    check('a relative link is internal', !isExternal(anchor('/terms')));
    check('an absolute same-origin link is internal', !isExternal(anchor(`${ORIGIN}/guide`)));
    check('a bare fragment is internal', !isExternal(anchor('#privacy')));
    check('a query on the same origin is internal', !isExternal(anchor('/guide?q=spacing')));
  }

  // --- external: must be caught --------------------------------------------
  {
    check('another host is external', isExternal(anchor('https://github.com/heistkit/handwriting')));
    check('http is external and still caught', isExternal(anchor('http://example.org/')));
    check('a different port on the same host is external', isExternal(anchor('https://handwrite.app:8443/x')));
    check('a different scheme on the same host is external', isExternal(anchor('http://handwrite.app/x')));
    // The whole reason the dialogue shows the host in large type.
    check('a lookalike host is external', isExternal(anchor('https://handwrite.app.example.net/')));
  }

  // --- things that are not navigations -------------------------------------
  {
    check('mailto is left alone', !isExternal(anchor('mailto:someone@example.org')));
    check('tel is left alone', !isExternal(anchor('tel:+441234567890')));
    check('javascript: is left alone', !isExternal(anchor('javascript:void 0')));
    check('a data URL is left alone', !isExternal(anchor('data:text/plain,hi')));
    // A download is a file arriving, not a page being visited. Interrupting it
    // would put a "you are leaving" dialogue in front of the user's own font.
    check('a download link is left alone', !isExternal(anchor('https://cdn.example.org/f.zip', { download: '' })));
    check('a missing anchor is not external', !isExternal(null));
    check('an anchor with no href is not external', !isExternal({ href: '' }));
  }

  // --- describe ------------------------------------------------------------
  {
    const d = describe(new URL('https://github.com/heistkit/handwriting?tab=readme#top'));
    check('the host is split out for emphasis', d.host === 'github.com', d.host);
    check('the rest carries path, query and fragment',
      d.rest === '/heistkit/handwriting?tab=readme#top', d.rest);
    check('https is reported secure', d.secure === true);

    const plain = describe(new URL('http://example.org/'));
    // A closed padlock over an unencrypted destination would be the single most
    // misleading thing this dialogue could do.
    check('http is reported insecure', plain.secure === false);
    check('a bare root path shows nothing after the host', plain.rest === '', JSON.stringify(plain.rest));

    const port = describe(new URL('https://example.org:8443/a'));
    check('a non-default port stays visible in the host', port.host === 'example.org:8443', port.host);
  }

  delete globalThis.location;
  return results;
}
