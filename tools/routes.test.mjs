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
  const { read, write, base, overlayPath } = await import('../src/routes.js');

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

    at('/feedback');
    const fb = read();
    check('feedback has an address of its own', fb.overlay === 'feedback' && fb.step === null);

    at('/guide/pen');
    const gp = read();
    check('a lesson reads as a section of the guide',
      gp.overlay === 'guide' && gp.section === 'pen' && gp.step === null);

    at('/guide');
    check('the guide with no lesson has no section', read().section === null);

    at('/guide/pen/');
    check('a trailing slash on a lesson is the same lesson', read().section === 'pen');

    at('/guide/pen/extra');
    const deep = read();
    check('a third segment names nothing — the guide is not a tree',
      deep.overlay === null && deep.step === null);

    at('/settings/pen');
    const sp = read();
    check('only the guide takes a section', sp.overlay === null && sp.step === null);

    at('/guide/a%20b');
    check('a section is percent-decoded', read().section === 'a b');

    // The address bar is the one input a stranger can hand you, and read() runs
    // on popstate and hashchange — a throw here is the whole router down.
    at('/guide/%zz');
    let bad;
    try {
      bad = read();
    } catch {
      bad = 'threw';
    }
    check('a malformed escape does not throw', bad !== 'threw' && bad.overlay === 'guide');
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
  //
  // base() is derived from this module's own URL rather than guessed from the
  // current path, because the guess could not tell `/repo/` — the app's root,
  // in a subdirectory — from `/repo`, a route called repo at the domain root,
  // and got that case wrong in the direction that 404s on reload. Under Node
  // the module URL is a file: path, which the detector deliberately refuses, so
  // what is testable here is that it declines rather than inventing a base.
  {
    at('/write');
    check('base() declines a non-http module URL', base() === '/', base());

    const calls = at('/write');
    write({ step: 'review' });
    check('and writes are rooted', calls[0]?.url === '/review', calls[0]?.url);
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

    calls = at('/review');
    write({ overlay: 'feedback' });
    check('feedback writes its own path', calls[0]?.url === '/feedback', JSON.stringify(calls));

    calls = at('/guide');
    write({ overlay: 'guide', section: 'pen' });
    check('a lesson writes a two-segment path', calls[0]?.url === '/guide/pen', JSON.stringify(calls));

    // The /guide/nonsense correction. Replaced, never pushed, or Back returns to
    // the address that was just rejected and bounces forward again.
    calls = at('/guide/nonsense');
    write({ overlay: 'guide', section: null, replace: true });
    check('a section naming no lesson is replaced away, never pushed',
      calls[0]?.method === 'replace' && calls[0]?.url === '/guide', JSON.stringify(calls));

    calls = at('/guide');
    write({ overlay: 'settings', section: 'pen' });
    check('an overlay that takes no section ignores one',
      calls[0]?.url === '/settings', JSON.stringify(calls));

    calls = at('/guide');
    write({ overlay: 'guide', section: 'a b' });
    check('a section is encoded on the way out',
      calls[0]?.url === '/guide/a%20b', JSON.stringify(calls));

    at('/');
    check('overlayPath builds a linkable lesson address', overlayPath('guide', 'pen') === '/guide/pen');
    check('and a bare overlay address without one', overlayPath('guide') === '/guide');

    // The href in the guide and the address the router reads have to be the same
    // string, or a copied permalink opens something other than the lesson it sat
    // beside.
    at(overlayPath('guide', 'pen'));
    check('a permalink round-trips through read()', read().section === 'pen');
  }

  // --- lesson ids are addresses --------------------------------------------
  //
  // /guide/pen is only stable if `pen` is. These ids are hand-authored in two
  // files — tutorial.js, and content.js which ships when tutorial.js fails to
  // load — and nothing else validates them, so a typo, a duplicate or an id that
  // cannot survive a URL would otherwise be discovered in someone's bookmark.
  // They live here rather than with docsearch because their public consequence
  // is an address, not a search hit.
  {
    const { LESSONS } = await import('../src/tutorial.js');
    const { FALLBACK_LESSONS } = await import('../src/content.js');

    for (const [name, list] of [['tutorial', LESSONS], ['fallback', FALLBACK_LESSONS]]) {
      const ids = list.map((l) => l.id);
      check(`every ${name} lesson has an id`, ids.every(Boolean), JSON.stringify(ids));
      // A duplicate would not error: getElementById returns the first, so one
      // address would quietly open the wrong lesson.
      check(`${name} lesson ids are unique`, new Set(ids).size === ids.length, ids.join(','));
      check(`${name} lesson ids need no encoding`,
        ids.every((id) => encodeURIComponent(id) === id), ids.join(','));
    }

    // The fallback is not a different guide, it is the same guide with less in
    // it. Wherever a lesson exists in both, the address has to be the same one,
    // or a copied link works only while tutorial.js happens to load.
    const shared = LESSONS.filter((l) => FALLBACK_LESSONS.some((f) => f.id === l.id));
    check('the fallback shares its ids with the real guide', shared.length >= 6,
      `${shared.length} shared: ${shared.map((l) => l.id).join(',')}`);
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
