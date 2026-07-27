/**
 * Tests for the router.
 *
 * routes.js reads `location` and writes through `history`, both of which are
 * globals in a browser. Rather than restructure the module to take them as
 * parameters — which would put a seam in production code purely to serve a test
 * — the globals are stubbed here. Node has no `location` or `history` of its
 * own, so nothing is being shadowed and nothing leaks between cases.
 *
 * What is actually being checked is the part that has real failure modes: the
 * mapping between a path and a screen, the subpath handling that lets this run
 * from a project directory rather than a domain root, and the rule that a
 * correction must replace rather than push. That last one is not cosmetic — a
 * pushed correction makes Back return to the address that was just rejected,
 * which bounces the reader forward again and traps them.
 */

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass });
  console.log(`  ${pass ? 'ok  ' : 'FAIL'} ${name}${detail && !pass ? ` — ${detail}` : ''}`);
};

/** Install a fake location/history and return the recorded history calls. */
function at(pathname, hash = '') {
  const calls = [];
  globalThis.location = { pathname, hash, origin: 'https://handwrite.test', href: `https://handwrite.test${pathname}${hash}` };
  globalThis.history = {
    pushState: (s, t, url) => calls.push({ method: 'push', url }),
    replaceState: (s, t, url) => calls.push({ method: 'replace', url }),
  };
  return calls;
}

export async function run() {
  const { read, write, base } = await import('../src/routes.js');

  // --- reading -------------------------------------------------------------
  {
    at('/');
    check('root is the start step', read().step === 'start' && read().overlay === null);

    at('/write');
    check('a step path reads as its step', read().step === 'write');

    at('/download');
    check('the export step lives at /download', read().step === 'export');

    at('/guide');
    const g = read();
    check('an overlay reads as an overlay', g.overlay === 'guide' && g.step === null);

    at('/licences');
    check('licences keeps its British spelling', read().overlay === 'licenses');

    at('/write/');
    check('a trailing slash is the same screen', read().step === 'write');

    at('/index.html');
    check('index.html is the root', read().step === 'start');

    at('/nonsense');
    const n = read();
    check('an unknown path names no screen', n.step === null && n.overlay === null);
  }

  // --- legacy fragments ----------------------------------------------------
  {
    at('/', '#privacy');
    const r = read();
    check('an old #privacy link still opens privacy', r.overlay === 'privacy');
    check('and is flagged as needing an upgrade', r.fromHash === true);

    at('/', '#not-a-document');
    check('an unknown fragment opens nothing', read().overlay === null);
  }

  // --- serving from a subdirectory -----------------------------------------
  {
    at('/handwriting/write');
    check('base() finds the subdirectory', base() === '/handwriting', base());
    check('and the step still reads through it', read().step === 'write');

    const calls = at('/handwriting/write');
    write({ step: 'review' });
    check('writes stay inside the subdirectory', calls[0]?.url === '/handwriting/review', calls[0]?.url);
  }

  // --- writing -------------------------------------------------------------
  {
    let calls = at('/');
    write({ step: 'capture' });
    check('navigating pushes', calls[0]?.method === 'push' && calls[0]?.url === '/capture', JSON.stringify(calls));

    calls = at('/refine');
    write({ step: 'start', replace: true });
    check('a correction replaces, never pushes', calls[0]?.method === 'replace' && calls[0]?.url === '/',
      JSON.stringify(calls));

    calls = at('/write');
    write({ step: 'write' });
    check('writing the address you are already at does nothing', calls.length === 0, JSON.stringify(calls));

    calls = at('/write');
    write({ overlay: 'settings' });
    check('an overlay writes its own path', calls[0]?.url === '/settings');

    calls = at('/', '#terms');
    write({ overlay: 'terms', replace: true });
    check('upgrading a fragment replaces it with a path', calls[0]?.method === 'replace' && calls[0]?.url === '/terms',
      JSON.stringify(calls));

    calls = at('/');
    write({ step: 'nope' });
    check('an unknown step falls back to the root rather than throwing', calls.length === 0 || calls[0].url === '/');
  }

  // --- hostile history -----------------------------------------------------
  {
    globalThis.location = { pathname: '/', hash: '', origin: 'null', href: 'file:///x/index.html' };
    globalThis.history = {
      pushState() { throw new Error('SecurityError'); },
      replaceState() { throw new Error('SecurityError'); },
    };
    let threw = false;
    try {
      write({ step: 'write' });
    } catch {
      threw = true;
    }
    // file:// and sandboxed documents reject pushState outright. The app has to
    // keep working there — losing the address bar is a degraded experience, not
    // a broken one.
    check('a history that refuses to be written does not take the app down', !threw);
  }

  delete globalThis.location;
  delete globalThis.history;
  return results;
}
