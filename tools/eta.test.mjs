/**
 * Tests for the ETA estimator.
 *
 * The estimator takes an injectable clock, so the whole thing runs
 * instantly and deterministically in Node. deviceProfile() needs browser
 * globals and is checked in the browser instead.
 */

import { createEstimator, describeEta } from '../src/eta.js';

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass });
  console.log(`  ${pass ? 'ok  ' : 'FAIL'} ${name}${detail && !pass ? ` — ${detail}` : ''}`);
};

/** Drive an estimator along a constant-rate job. */
function runLinear(est, clock, totalMs, steps) {
  const out = [];
  for (let i = 0; i <= steps; i++) {
    clock.t = (totalMs * i) / steps;
    out.push(est.update(i / steps));
  }
  return out;
}

export async function run() {
  console.log('\neta');

  // --- silence until there is signal ---------------------------------------
  {
    const clock = { t: 0 };
    const est = createEstimator({ now: () => clock.t });
    est.update(0);
    clock.t = 50;
    const early = est.update(0.01);
    check('says nothing at 1% after 50ms', early.remainingMs === null && !early.confident);

    clock.t = 300;
    const stillEarly = est.update(0.03);
    check('still silent below the progress floor', !stillEarly.confident);
  }

  // --- a steady job is estimated accurately --------------------------------
  {
    const clock = { t: 0 };
    const est = createEstimator({ now: () => clock.t });
    const seq = runLinear(est, clock, 10_000, 20);
    const mid = seq[10]; // halfway through a 10s job
    check('halfway through 10s predicts ~5s',
      mid.confident && Math.abs(mid.remainingMs - 5000) < 900,
      `${Math.round(mid.remainingMs)}ms`);

    const late = seq[18]; // 90%
    check('at 90% predicts ~1s', Math.abs(late.remainingMs - 1000) < 500,
      `${Math.round(late.remainingMs)}ms`);
  }

  // --- good news lands at once, bad news creeps ----------------------------
  {
    // A job that starts fast and then stalls badly. A naive estimate would
    // balloon; a strictly non-rising one would pin itself at zero and show
    // "almost done" for the remaining ten seconds.
    const clock = { t: 0 };
    const est = createEstimator({ now: () => clock.t, minRemainingMs: 0 });
    est.update(0);

    const shown = [];
    const script = [[400, 0.30], [800, 0.55], [1200, 0.58], [3000, 0.60],
                    [6000, 0.62], [9000, 0.70], [12000, 0.85], [13000, 0.95]];
    for (const [t, p] of script) {
      clock.t = t;
      const r = est.update(p);
      if (r.confident) shown.push(Math.round(r.remainingMs));
    }

    // The point is that the figure recovers at all. A strictly non-rising
    // estimate would fall to zero at the first stall and sit there for the
    // remaining ten seconds, telling the user "almost done" the whole time.
    check('the stall is reflected, not hidden',
      shown.some((v, i) => i > 0 && v > shown[i - 1]),
      JSON.stringify(shown));

    // No single step may more than double the figure — that is the jump the
    // smoothing exists to prevent.
    const jumps = shown.slice(1).map((v, i) => (shown[i] > 50 ? v / shown[i] : 1));
    check('no step more than doubles it', jumps.every((r) => r <= 2),
      JSON.stringify(jumps.map((r) => +r.toFixed(2))));
  }
  {
    // Improvement is applied immediately — there is no reason to make someone
    // wait to hear that the wait is shorter.
    const clock = { t: 0 };
    const est = createEstimator({ now: () => clock.t, minRemainingMs: 0 });
    est.update(0);
    clock.t = 1000; est.update(0.1);        // looks like a 9s job
    const slow = est.update(0.1).remainingMs;
    clock.t = 1200; est.update(0.8);        // suddenly nearly finished
    const fast = est.update(0.8).remainingMs;
    check('an improved estimate drops at once', fast < slow / 2,
      `${Math.round(slow)} -> ${Math.round(fast)}`);
  }

  // --- a held estimate ages ------------------------------------------------
  {
    const clock = { t: 0 };
    const est = createEstimator({ now: () => clock.t });
    est.update(0);
    clock.t = 1000; est.update(0.5);
    const first = est.update(0.5).remainingMs;
    clock.t = 1600;
    const later = est.update(0.5).remainingMs;
    check('time passing reduces a held estimate', later < first,
      `${Math.round(first)} -> ${Math.round(later)}`);
  }

  // --- short jobs stay silent ----------------------------------------------
  {
    // A 1.5s job: long enough to pass the elapsed floor, too short to be worth
    // announcing. This is the common desktop case.
    const clock = { t: 0 };
    const est = createEstimator({ now: () => clock.t });
    const seq = runLinear(est, clock, 1500, 15);
    check('a 1.5s job never announces', seq.every((r) => !r.confident),
      JSON.stringify(seq.filter((r) => r.confident).map((r) => Math.round(r.remainingMs))));
  }
  {
    // A 20s job: worth telling someone about.
    const clock = { t: 0 };
    const est = createEstimator({ now: () => clock.t });
    const seq = runLinear(est, clock, 20_000, 40);
    check('a 20s job does announce', seq.some((r) => r.confident));
    const first = seq.find((r) => r.confident);
    check('and does so above the floor', first.remainingMs >= 1500,
      `${Math.round(first.remainingMs)}ms`);
  }
  {
    // Having started a countdown, it must run to the end rather than vanish.
    const clock = { t: 0 };
    const est = createEstimator({ now: () => clock.t });
    const seq = runLinear(est, clock, 20_000, 40);
    const firstIdx = seq.findIndex((r) => r.confident);
    const after = seq.slice(firstIdx, -1); // exclude p === 1
    check('a started countdown does not disappear', after.every((r) => r.confident),
      `${after.filter((r) => !r.confident).length} gaps`);
  }

  // --- degenerate inputs ---------------------------------------------------
  {
    const clock = { t: 0 };
    const est = createEstimator({ now: () => clock.t });
    est.update(0);
    clock.t = 1000;
    check('no movement yields no estimate', est.update(0).remainingMs === null);

    clock.t = 2000;
    est.update(0.5);
    clock.t = 2500;
    check('completion is not "confident"', est.update(1).confident === false);
  }
  {
    const clock = { t: 0 };
    const est = createEstimator({ now: () => clock.t });
    est.update(0);
    clock.t = 900;
    const r = est.update(1.7); // out of range
    check('clamps progress above 1', r.confident === false);
  }
  {
    const clock = { t: 0 };
    const est = createEstimator({ now: () => clock.t });
    est.update(0); clock.t = 900; est.update(0.4);
    est.reset();
    check('reset clears state', est.update(0.9).remainingMs === null);
  }

  // --- phrasing ------------------------------------------------------------
  check('sub-second reads as almost done', describeEta(600) === 'almost done');
  check('seconds are exact under ten', describeEta(4200) === 'about 4 seconds left');
  check('tens of seconds are rounded to five', describeEta(23_000) === 'about 25 seconds left');
  check('a minute is spelled', describeEta(61_000) === 'about a minute left');
  check('longer waits use halves', describeEta(150_000) === 'about 2.5 minutes left');
  check('null is empty, not "NaN"', describeEta(null) === '');
  check('infinity is empty', describeEta(Infinity) === '');

  return results;
}
