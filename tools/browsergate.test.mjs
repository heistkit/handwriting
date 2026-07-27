/**
 * Tests for the browser gate.
 *
 * The only property worth defending here is the asymmetry the module is built
 * on: blocking a browser that would have worked is worse than letting a broken
 * one through. So the cases below are mostly about *not* blocking — a probe
 * that throws, a probe whose global is missing in a way that says nothing, a
 * browser that has everything. The one positive case checks that a genuinely
 * absent capability is actually reported, since a gate that never fires is the
 * other way to be useless.
 *
 * Node has none of the globals the probes read, so they are stubbed. That also
 * makes the fail-open path testable, which is the whole point: a real browser
 * cannot easily be made to throw inside `CSS.supports` on demand.
 */

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass });
  console.log(`  ${pass ? 'ok  ' : 'FAIL'} ${name}${detail && !pass ? ` — ${detail}` : ''}`);
};

/** A browser with everything the app needs. */
function goodBrowser() {
  return {
    document: {
      createElement: () => ({ getContext: () => ({ getImageData() {} }) }),
      fonts: { add() {} },
    },
    Blob: function Blob() {},
    FontFace: function FontFace() {},
    CSS: { supports: () => true },
  };
}

function install(env) {
  for (const [k, v] of Object.entries(env)) globalThis[k] = v;
  // URL is a real global in Node and the rest of the suite constructs them, so
  // the probe's one method is attached rather than the constructor replaced.
  URL.createObjectURL ??= () => '';
}
function uninstall(env) {
  for (const k of Object.keys(env)) delete globalThis[k];
  delete URL.createObjectURL;
}

export async function run() {
  // Read before anything is stubbed.
  const { readFile } = await import('node:fs/promises');
  const src = await readFile(new URL('../src/browsergate.js', import.meta.url), 'utf8');
  {
    // A version check is a guess about what a name implies, and it is wrong in
    // both directions. If either of these starts failing, someone has added one.
    //
    // Comments are stripped first, because the module's own header explains at
    // length why it does not read the user agent and does not sniff for
    // automation — and a test that fails on the explanation would train whoever
    // hits it to delete the explanation.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    check('the gate never reads the user agent',
      !/navigator\s*\.\s*(userAgent|userAgentData|vendor|appVersion)/.test(code));
    check('and ships no bot detection',
      !/webdriver|headless|phantom|selenium/i.test(code));
  }

  const env = goodBrowser();
  install(env);
  const { check: probe } = await import('../src/browsergate.js');

  // --- everything present --------------------------------------------------
  {
    const v = probe();
    check('a capable browser is not blocked', v.ok === true && v.missing.length === 0,
      JSON.stringify(v.missing));
  }

  // --- one genuine absence is reported -------------------------------------
  {
    globalThis.CSS = { supports: () => false };
    const v = probe();
    check('a missing capability is reported', v.ok === false && v.missing.length === 1);
    check('and it is named, not just counted', v.missing[0]?.id === 'lightdark', JSON.stringify(v.missing));
    check('with a reason a reader could act on', (v.missing[0]?.why || '').length > 40);
    globalThis.CSS = env.CSS;
  }

  // --- fail open -----------------------------------------------------------
  {
    // A probe that throws must count as present. Undeterminable is not the same
    // as absent, and treating it as absent is how a gate blocks a browser that
    // would have worked — the failure this module exists to avoid.
    globalThis.CSS = { supports() { throw new Error('locked down'); } };
    const v = probe();
    check('a probe that throws is treated as present', v.ok === true, JSON.stringify(v.missing));
    globalThis.CSS = env.CSS;

    globalThis.document = {
      createElement() { throw new Error('no DOM'); },
      fonts: { add() {} },
    };
    const v2 = probe();
    check('a DOM that refuses does not block either', v2.ok === true, JSON.stringify(v2.missing));
    globalThis.document = env.document;
  }

  // --- a canvas with no 2d context is a real absence ------------------------
  {
    globalThis.document = { createElement: () => ({ getContext: () => null }), fonts: { add() {} } };
    const v = probe();
    check('a canvas with no 2d context is blocked', v.missing.some((m) => m.id === 'canvas'));
    globalThis.document = env.document;
  }

  uninstall(env);
  return results;
}
