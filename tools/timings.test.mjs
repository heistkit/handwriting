/**
 * Tests for the duration history behind the remembered ETA.
 *
 * Two properties matter more than the arithmetic.
 *
 * It must never put a number on screen that came from a lie. The store is
 * user-writable localStorage, so anything read back is re-validated; a NaN or a
 * string reaching the median would print "NaN seconds" over the progress bar.
 *
 * And it must survive a storage that refuses. Private browsing and a full quota
 * both throw on write, and an estimator that takes the app down when it cannot
 * remember something is worse than one that simply says nothing.
 */

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass });
  console.log(`  ${pass ? 'ok  ' : 'FAIL'} ${name}${detail && !pass ? ` — ${detail}` : ''}`);
};

function memStorage(seed = {}) {
  const m = new Map(Object.entries(seed));
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    _map: m,
  };
}

const KEY = 'handwrite.timings';

export async function run() {
  globalThis.localStorage = memStorage();
  const t = await import('../src/timings.js');

  // --- nothing remembered yet ----------------------------------------------
  {
    check('no history means no estimate', t.estimate('family') === null);
    t.record('family', 4000);
    // One sample is a number, not a history — and a first run that happened to
    // be slow would otherwise set the expectation for every run after it.
    check('one sample is still not a history', t.estimate('family') === null);
  }

  // --- the median ----------------------------------------------------------
  {
    t.record('family', 6000);
    const e = t.estimate('family');
    check('two samples give an estimate', e !== null && e.samples === 2);
    check('and it is the median', e.ms === 5000, String(e?.ms));

    // A tab backgrounded mid-run produces one arbitrarily slow reading. A mean
    // would carry it for the next eight builds; a median ignores it outright.
    t.record('family', 300000);
    const e2 = t.estimate('family');
    check('one absurd run does not move the estimate much', e2.ms === 6000, String(e2.ms));
  }

  // --- bounds --------------------------------------------------------------
  {
    check('a sub-threshold duration is refused', t.record('family', 30) === false);
    check('an implausible one is refused', t.record('family', 60 * 60 * 1000) === false);
    check('NaN is refused', t.record('family', NaN) === false);
    check('an unknown operation is refused', t.record('nonsense', 4000) === false);
  }

  // --- the window ----------------------------------------------------------
  {
    globalThis.localStorage = memStorage();
    for (let i = 1; i <= 12; i++) t.record('preview', 1000 * i);
    const e = t.estimate('preview');
    check('at most eight samples are kept', e.samples === 8, String(e.samples));
    // 5000..12000 — the first four have aged out, so a device that got faster
    // or slower converges instead of being averaged against its own past.
    check('and they are the most recent eight', e.ms === 8500, String(e.ms));
  }

  // --- buckets are independent ---------------------------------------------
  {
    globalThis.localStorage = memStorage();
    t.record('capture', 2000);
    t.record('capture', 2400);
    t.record('family', 9000);
    t.record('family', 11000);
    check('reading a photograph and building a font are timed apart',
      t.estimate('capture').ms === 2200 && t.estimate('family').ms === 10000);
  }

  // --- hostile storage ------------------------------------------------------
  {
    globalThis.localStorage = memStorage({ [KEY]: 'not json at all' });
    check('unparseable storage reads as empty', t.estimate('family') === null);

    globalThis.localStorage = memStorage({ [KEY]: JSON.stringify({ family: [1000, 'x', null, NaN, 2000] }) });
    const e = t.estimate('family');
    // 'x', null and NaN are dropped on the way in. If any of them survived,
    // the median would be a string or NaN and the overlay would say so.
    check('junk inside the stored array is dropped', e !== null && e.samples === 2, JSON.stringify(e));
    check('and what is left is still usable', Number.isFinite(e.ms) && e.ms === 1500, String(e?.ms));

    globalThis.localStorage = {
      getItem: () => { throw new Error('SecurityError'); },
      setItem: () => { throw new Error('QuotaExceededError'); },
      removeItem: () => { throw new Error('nope'); },
    };
    let threw = false;
    try {
      t.record('family', 3000);
      t.estimate('family');
      t.clear();
    } catch {
      threw = true;
    }
    check('a storage that refuses does not take the app down', !threw);
    check('and simply has nothing to offer', t.estimate('family') === null);
  }

  delete globalThis.localStorage;
  return results;
}
