/**
 * timings.js — how long things took here last time.
 *
 * The estimator in eta.js deliberately says nothing until it has enough signal:
 * a number drawn from the first 2% of a job is a guess wearing a number. That
 * is right, and it leaves a gap — on a slow device the reserved line sits empty
 * for four or five seconds at exactly the moment the reader most wants to know
 * whether to wait. This fills that gap from what the same device did last time.
 *
 * Durations only
 * --------------
 * A sample is one integer: milliseconds. Nothing else.
 *
 * The obvious design stores a duration *and* a size — glyphs traced, cells on
 * the sheet — so the estimate can scale with the work. It would be a better
 * estimator. It also means this file writes down how many characters you have
 * captured, which is a measure of how far through your own font you are, and
 * that is a fact about what you wrote. It would have to be disclosed on the
 * privacy page, and the sentence "nothing about your handwriting is stored"
 * would need a qualifier.
 *
 * Bucketing by operation instead costs some accuracy and no honesty. The three
 * operations differ from each other by much more than one run of the same
 * operation differs from the next, so the bucket is doing most of the work
 * anyway.
 *
 * Median, not mean
 * ----------------
 * One run interrupted by a backgrounded tab, a thermal throttle or a garbage
 * collection is arbitrarily slow, and a mean carries that forever across only
 * eight samples. A median ignores it entirely and still tracks a device that
 * genuinely got faster or slower, because the outlier ages out.
 */

const KEY = 'handwrite.timings';

/** The operations worth timing separately. */
export const OPS = ['capture', 'preview', 'family'];

/**
 * Eight is enough to have a stable median and few enough to follow a device
 * that changed — a laptop unplugged from power, a phone that got hot.
 */
const MAX_SAMPLES = 8;

/** Below two samples a median is just the one number, which is not a history. */
const MIN_SAMPLES = 2;

/**
 * Anything outside this is not a measurement of the work. Under a fifth of a
 * second means the operation did not really run; over ten minutes means the tab
 * was asleep for most of it, which is the single most common way a timer lies.
 */
const FLOOR_MS = 200;
const CEILING_MS = 10 * 60 * 1000;

function safeRead() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};
    const out = {};
    for (const op of OPS) {
      const list = parsed[op];
      if (!Array.isArray(list)) continue;
      // Re-validate on the way in. This is user-writable storage, and a NaN
      // reaching the median would put "NaN seconds" on screen.
      out[op] = list
        .filter((n) => Number.isFinite(n) && n >= FLOOR_MS && n <= CEILING_MS)
        .slice(-MAX_SAMPLES);
    }
    return out;
  } catch {
    return {};
  }
}

function safeWrite(all) {
  try {
    const empty = OPS.every((op) => !all[op]?.length);
    if (empty) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    /* private mode, or quota — the history simply does not persist */
  }
}

/**
 * @param {'capture'|'preview'|'family'} op
 * @param {number} ms
 * @returns {boolean} whether it was kept
 */
export function record(op, ms) {
  if (!OPS.includes(op)) return false;
  if (!Number.isFinite(ms) || ms < FLOOR_MS || ms > CEILING_MS) return false;

  const all = safeRead();
  const list = all[op] ?? [];
  list.push(Math.round(ms));
  all[op] = list.slice(-MAX_SAMPLES);
  safeWrite(all);
  return true;
}

function median(list) {
  const sorted = [...list].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

/**
 * @param {'capture'|'preview'|'family'} op
 * @returns {{ms: number, samples: number}|null} null when there is no history
 */
export function estimate(op) {
  const list = safeRead()[op];
  if (!list || list.length < MIN_SAMPLES) return null;
  return { ms: median(list), samples: list.length };
}

/** Forget everything. Nothing calls this; it exists so the store is erasable. */
export function clear() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* nothing to do */
  }
}

/** What is held, for the feedback report and for anyone checking the claim. */
export function summary() {
  const all = safeRead();
  return OPS.map((op) => ({ op, samples: all[op]?.length ?? 0 }));
}
