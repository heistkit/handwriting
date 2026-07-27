/**
 * eta.js — how much longer this is going to take.
 *
 * Two sources, in order of trust.
 *
 * 1. Measurement. Once work is under way, the honest estimate comes from
 *    watching how fast progress is actually moving on this machine, right now,
 *    with whatever else it happens to be doing. Nothing about a device
 *    predicts that better than observing it.
 *
 * 2. A device profile, used only to seed the first guess before there is
 *    anything to measure, and to decide whether to warn that this will be slow.
 *
 * On the device profile: core count and reported memory are weak signals. A
 * phone advertising eight cores may have four that are barely awake, and
 * navigator.deviceMemory is a coarse, rounded, Chrome-only hint. So the profile
 * leans on a short benchmark of the same kind of work the pipeline does —
 * a threshold pass over a pixel buffer — which measures the thing that
 * actually matters rather than a number the browser is willing to state.
 *
 * Privacy: every value here is read, used in memory, and dropped. Nothing is
 * stored and nothing is transmitted — there is nowhere to transmit it to. The
 * privacy page says so explicitly, and names these fields.
 */

/** Reference time in ms for the calibration loop on a fast 2024 laptop. */
const REFERENCE_MS = 6;

/**
 * Time a threshold pass over a pixel buffer — the same shape of work the
 * capture pipeline does most of.
 *
 * Deliberately tiny. A benchmark that takes long enough to be precise is a
 * benchmark that delays the thing the user actually asked for.
 */
export function benchmark(px = 512 * 512) {
  const buf = new Uint8ClampedArray(px);
  for (let i = 0; i < px; i++) buf[i] = (i * 37) & 255;

  const t0 = performance.now();
  let sum = 0;
  for (let pass = 0; pass < 3; pass++) {
    for (let i = 0; i < px; i++) sum += buf[i] > 128 ? 1 : 0;
  }
  const ms = performance.now() - t0;
  // `sum` is returned so the loop cannot be optimised away.
  return { ms, checksum: sum };
}

/**
 * A rough picture of what we are running on.
 *
 * @returns {{cores:number|null, memoryGB:number|null, benchMs:number,
 *            speed:number, tier:'fast'|'normal'|'slow', touch:boolean}}
 */
export function deviceProfile() {
  const cores = Number.isFinite(navigator.hardwareConcurrency)
    ? navigator.hardwareConcurrency
    : null;
  const memoryGB = Number.isFinite(navigator.deviceMemory) ? navigator.deviceMemory : null;

  const { ms } = benchmark();
  // >1 is faster than the reference, <1 slower.
  const speed = REFERENCE_MS / Math.max(ms, 0.01);

  let tier = 'normal';
  if (speed >= 0.8) tier = 'fast';
  else if (speed < 0.32) tier = 'slow';

  // A weak machine with few cores is the case worth warning about.
  if (tier !== 'slow' && cores !== null && cores <= 2 && speed < 0.6) tier = 'slow';

  return {
    cores,
    memoryGB,
    benchMs: +ms.toFixed(2),
    speed: +speed.toFixed(3),
    tier,
    touch: matchMedia?.('(pointer: coarse)')?.matches ?? false,
  };
}

/** Cached, because the benchmark should run once per session at most. */
let cachedProfile = null;
export function profile() {
  if (!cachedProfile) cachedProfile = deviceProfile();
  return cachedProfile;
}

/**
 * Turns a stream of progress readings into a remaining-time estimate.
 *
 * The rules exist because a bad ETA is worse than none:
 *
 *   - Nothing is shown until there is enough signal. An estimate produced from
 *     the first 2% of a job is a guess wearing a number.
 *   - The rate is smoothed, so one slow frame does not double the estimate.
 *   - The displayed value is not allowed to rise. A countdown that goes up
 *     reads as broken even when it is technically more accurate; it is held
 *     flat instead and allowed to catch up.
 */
export function createEstimator({
  minProgress = 0.06,
  minElapsedMs = 600,
  /*
   * Below this, say nothing at all.
   *
   * On a quick machine the whole capture runs in about a second and a half, so
   * without this the panel flashes "almost done" for a moment and then clears
   * — motion that costs attention and tells the user nothing they could not
   * see from the bar. An estimate is only worth printing when the wait is long
   * enough that someone might otherwise wonder whether it has hung.
   */
  minRemainingMs = 1500,
  smoothing = 0.25,
  now = () => performance.now(),
} = {}) {
  let start = null;
  let lastT = null;
  let lastP = 0;
  let rate = null; // progress units per ms
  let shown = null; // last announced remaining time
  let shownAt = null; // when it was announced
  let announced = false; // whether we have committed to showing a countdown

  return {
    reset() {
      start = lastT = null;
      lastP = 0;
      rate = null;
      shown = shownAt = null;
      announced = false;
    },

    /**
     * @param {number} p progress in 0..1
     * @returns {{remainingMs:number|null, elapsedMs:number, confident:boolean}}
     */
    update(p) {
      const t = now();
      p = Math.min(Math.max(p, 0), 1);

      if (start === null) {
        start = lastT = t;
        lastP = p;
        return { remainingMs: null, elapsedMs: 0, confident: false };
      }

      const dt = t - lastT;
      const dp = p - lastP;

      // Ignore ticks with no measurable movement; they carry no rate
      // information and would drag the average toward zero.
      if (dt > 0 && dp > 0) {
        const instant = dp / dt;
        rate = rate === null ? instant : rate + smoothing * (instant - rate);
        lastT = t;
        lastP = p;
      }

      const elapsedMs = t - start;
      const confident = rate !== null && p >= minProgress && elapsedMs >= minElapsedMs && p < 1;
      if (!confident) return { remainingMs: null, elapsedMs, confident: false };

      const raw = (1 - p) / rate;

      /*
       * Asymmetric smoothing of the displayed figure.
       *
       * The previous value is first aged by however long has passed, so a held
       * estimate still counts down. Then: if the job is going better than
       * thought, drop to the new number immediately — good news can arrive at
       * full speed. If it is going worse, creep toward the new number rather
       * than jumping, because a countdown that leaps upward reads as broken.
       *
       * The creep matters more than it looks. A pure never-rise rule sounds
       * tidier, but a job that starts fast and then stalls drags the estimate
       * to zero and pins it there — so a genuinely long wait ends up showing
       * "almost done" for ten seconds, or nothing at all. Rising slowly is
       * less tidy and much more honest.
       */
      if (shown === null) {
        shown = raw;
      } else {
        const aged = Math.max(0, shown - (t - shownAt));
        shown = raw < aged ? raw : aged + (raw - aged) * 0.18;
      }
      shown = Math.max(0, shown);
      shownAt = t;

      // Once it has been announced, keep counting down to zero rather than
      // disappearing partway — vanishing mid-count reads as a failure.
      const worthShowing = announced || shown >= minRemainingMs;
      if (worthShowing) announced = true;

      return { remainingMs: shown, elapsedMs, confident: worthShowing };
    },
  };
}

/**
 * Human phrasing. Deliberately vague at the top end: "about 2 minutes" is
 * honest about its own precision in a way that "1:53 remaining" is not.
 */
export function describeEta(ms) {
  if (ms === null || !Number.isFinite(ms)) return '';
  const s = Math.round(ms / 1000);
  if (s <= 1) return 'almost done';
  if (s < 10) return `about ${s} seconds left`;
  if (s < 60) return `about ${Math.round(s / 5) * 5} seconds left`;
  const m = Math.round(s / 30) / 2;
  return `about ${m === 1 ? 'a minute' : `${m} minutes`} left`;
}

/** Shown once, up front, when the device looks like it will struggle. */
export function slowDeviceNote(p = profile()) {
  if (p.tier !== 'slow') return null;
  return 'This device looks slow for image work — it will still finish, just give it longer. Lite mode is on to help.';
}
