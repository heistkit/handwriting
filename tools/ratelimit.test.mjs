/**
 * Tests for the per-device limiter.
 *
 * The limiter is injectable (storage + clock), so all of this runs in plain
 * Node with no browser and no waiting on real time.
 */

import { createLimiter } from '../src/ratelimit.js';

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass });
  console.log(`  ${pass ? 'ok  ' : 'FAIL'} ${name}${detail && !pass ? ` — ${detail}` : ''}`);
};

/** Minimal Storage stand-in. */
function memStorage(initial = {}) {
  const m = new Map(Object.entries(initial));
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    _map: m,
  };
}

/** Storage whose writes always throw, as in some private-browsing modes. */
function hostileStorage() {
  return {
    getItem: () => null,
    setItem: () => {
      throw new Error('QuotaExceededError');
    },
    removeItem: () => {
      throw new Error('nope');
    },
  };
}

export async function run() {
  console.log('\nratelimit');

  // --- basic accounting ----------------------------------------------------
  {
    let t = 1_000_000;
    const lim = createLimiter({ storage: memStorage(), now: () => t, limit: 5, windowMs: 60_000 });

    const first = lim.check();
    check('starts with a full budget', first.allowed && first.remaining === 5,
      JSON.stringify(first));

    for (let i = 0; i < 5; i++) lim.take();
    const after = lim.check();
    check('blocks once the budget is spent', !after.allowed && after.remaining === 0,
      JSON.stringify(after));

    check('reports a wait under one window',
      after.retryAfterMs > 0 && after.retryAfterMs <= 60_000,
      String(after.retryAfterMs));
  }

  // --- the window actually rolls -------------------------------------------
  {
    let t = 5_000_000;
    const lim = createLimiter({ storage: memStorage(), now: () => t, limit: 3, windowMs: 60_000 });

    lim.take(); lim.take(); lim.take();
    check('blocked at the limit', !lim.check().allowed);

    t += 59_000;
    check('still blocked just inside the window', !lim.check().allowed);

    t += 2_000; // now 61s after the first three
    const rolled = lim.check();
    check('recovers once the window passes', rolled.allowed && rolled.remaining === 3,
      JSON.stringify(rolled));
  }

  // --- partial recovery ----------------------------------------------------
  {
    let t = 9_000_000;
    const lim = createLimiter({ storage: memStorage(), now: () => t, limit: 4, windowMs: 60_000 });

    lim.take(); lim.take();
    t += 40_000;
    lim.take(); lim.take();
    check('full after four in the window', !lim.check().allowed);

    t += 25_000; // the first two have now expired, the later two have not
    const partial = lim.check();
    check('recovers only the expired share', partial.allowed && partial.remaining === 2,
      JSON.stringify(partial));
  }

  // --- check() must not consume -------------------------------------------
  {
    let t = 2_000_000;
    const lim = createLimiter({ storage: memStorage(), now: () => t, limit: 3, windowMs: 60_000 });
    lim.check(); lim.check(); lim.check(); lim.check();
    check('check() does not spend budget', lim.check().remaining === 3);
  }

  // --- persistence across instances ---------------------------------------
  {
    let t = 3_000_000;
    const store = memStorage();
    const a = createLimiter({ storage: store, now: () => t, limit: 3, windowMs: 60_000 });
    a.take(); a.take();

    const b = createLimiter({ storage: store, now: () => t, limit: 3, windowMs: 60_000 });
    check('a reload keeps the counter', b.check().remaining === 1, JSON.stringify(b.check()));
    check('a reload keeps the device id', a.deviceId === b.deviceId);
  }

  // --- device id shape -----------------------------------------------------
  {
    const a = createLimiter({ storage: memStorage() });
    const b = createLimiter({ storage: memStorage() });
    check('device ids are unique per device', a.deviceId !== b.deviceId);
    check('device id is opaque and short', typeof a.deviceId === 'string' && a.deviceId.length >= 8);
  }

  // --- hostile inputs ------------------------------------------------------
  {
    let t = 4_000_000;
    const lim = createLimiter({
      storage: memStorage({ 'inkwell.ops': '{"not":"an array"}' }),
      now: () => t, limit: 3, windowMs: 60_000,
    });
    check('survives a corrupted counter', lim.check().allowed && lim.check().remaining === 3);
  }
  {
    let t = 4_500_000;
    const lim = createLimiter({
      storage: memStorage({ 'inkwell.ops': 'definitely not json' }),
      now: () => t, limit: 3, windowMs: 60_000,
    });
    check('survives unparseable storage', lim.check().allowed);
  }
  {
    // A clock that jumped backwards leaves timestamps in the future. Without a
    // guard those never expire and the user is locked out until they clear
    // site data.
    let t = 6_000_000;
    const lim = createLimiter({
      storage: memStorage({ 'inkwell.ops': JSON.stringify([t + 5_000_000, t + 6_000_000]) }),
      now: () => t, limit: 3, windowMs: 60_000,
    });
    check('discards timestamps from the future', lim.check().remaining === 3,
      JSON.stringify(lim.check()));
  }

  // --- storage that refuses to co-operate ----------------------------------
  {
    let t = 7_000_000;
    let threw = false;
    let lim;
    try {
      lim = createLimiter({ storage: hostileStorage(), now: () => t, limit: 3, windowMs: 60_000 });
      lim.take();
      lim.check();
      lim.reset();
    } catch {
      threw = true;
    }
    check('never throws when storage is unavailable', !threw);
    check('still yields a usable device id', typeof lim?.deviceId === 'string' && lim.deviceId.length > 0);
  }

  // --- the shipped configuration -------------------------------------------
  {
    const lim = createLimiter({ storage: memStorage() });
    check('ships at 60 per minute', lim.limit === 60 && lim.windowMs === 60_000,
      `${lim.limit}/${lim.windowMs}`);
  }

  return results;
}
