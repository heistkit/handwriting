/**
 * ratelimit.js — per-device throttle on expensive pipeline operations.
 *
 * Limit: 60 heavy operations per rolling 60 seconds. A "heavy operation" is a
 * page capture or a font build; both saturate the CPU for a second or more.
 *
 * What this does and does not do
 * ------------------------------
 * It runs in the visitor's own browser, so a determined person can defeat it
 * from the developer console in about ten seconds. That is inherent — there is
 * no server in this architecture, so there is nowhere trustworthy to count.
 * It is therefore a *guardrail*, not a security control, and it is worth having
 * for the things guardrails are actually good at:
 *
 *   - stopping a runaway loop (a stuck retry, a script someone wrote against
 *     the page) from pinning the visitor's CPU and flattening their battery
 *   - making automated bulk use inconvenient enough to be deliberate
 *   - giving the Terms something concrete and honest to describe
 *
 * The ceiling is set where a human cannot reach it. Producing one font requires
 * writing ~110 characters by hand and photographing them; sixty of those in a
 * minute is not a thing a person does. Nobody using the app normally will ever
 * see this fire.
 *
 * Privacy note: the device identifier below is a random value from the
 * browser's CSPRNG. It is deliberately *not* a fingerprint — nothing about the
 * hardware, browser, network, or user goes into it, it never leaves the device,
 * and clearing site data resets it with no consequence beyond clearing the
 * counter. The privacy policy describes it in exactly these terms.
 */

export const DEVICE_LIMIT = 60;
export const WINDOW_MS = 60_000;

const KEY_ID = 'handwrite.device';
const KEY_HITS = 'handwrite.ops';

/**
 * localStorage is unavailable in some private-browsing modes and can throw on
 * quota. Every path here degrades to a working in-memory store rather than
 * breaking the app: a rate limit is never worth failing a user's work over.
 */
function safeStorage() {
  try {
    const probe = '__handwrite_probe__';
    localStorage.setItem(probe, '1');
    localStorage.removeItem(probe);
    return localStorage;
  } catch {
    const mem = new Map();
    return {
      getItem: (k) => (mem.has(k) ? mem.get(k) : null),
      setItem: (k, v) => mem.set(k, String(v)),
      removeItem: (k) => mem.delete(k),
      __ephemeral: true,
    };
  }
}

function randomId() {
  try {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
    const b = new Uint8Array(16);
    globalThis.crypto.getRandomValues(b);
    return [...b].map((n) => n.toString(16).padStart(2, '0')).join('');
  } catch {
    // No CSPRNG. The identifier only has to be unique on this device, and a
    // collision would merely share a counter, so a weak fallback is acceptable.
    return `f${Math.floor(Math.random() * 2 ** 52).toString(36)}`;
  }
}

/**
 * @param {object} [deps] injection seam for tests
 * @param {Storage} [deps.storage]
 * @param {() => number} [deps.now]
 * @param {number} [deps.limit]
 * @param {number} [deps.windowMs]
 */
export function createLimiter(deps = {}) {
  const storage = deps.storage ?? safeStorage();
  const now = deps.now ?? (() => Date.now());
  const limit = deps.limit ?? DEVICE_LIMIT;
  const windowMs = deps.windowMs ?? WINDOW_MS;

  let deviceId = storage.getItem(KEY_ID);
  if (!deviceId) {
    deviceId = randomId();
    try {
      storage.setItem(KEY_ID, deviceId);
    } catch {
      /* ephemeral is fine */
    }
  }

  function readHits() {
    try {
      const raw = storage.getItem(KEY_HITS);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      // Guard against a hand-edited or corrupted value.
      if (!Array.isArray(parsed)) return [];
      return parsed.filter((n) => typeof n === 'number' && Number.isFinite(n));
    } catch {
      return [];
    }
  }

  function writeHits(hits) {
    try {
      storage.setItem(KEY_HITS, JSON.stringify(hits));
    } catch {
      /* quota or private mode — the in-memory copy still throttles this tab */
    }
  }

  /** Drop everything outside the rolling window. */
  function live(t = now()) {
    const cutoff = t - windowMs;
    // A clock that jumped backwards would otherwise strand future timestamps
    // in the array forever, so discard anything implausibly ahead of now.
    return readHits().filter((ts) => ts > cutoff && ts <= t + 1000);
  }

  return {
    deviceId,
    limit,
    windowMs,
    ephemeral: Boolean(storage.__ephemeral),

    /** Non-mutating. Returns whether the next operation would be allowed. */
    check() {
      const t = now();
      const hits = live(t);
      const allowed = hits.length < limit;
      const oldest = hits.length ? Math.min(...hits) : t;
      return {
        allowed,
        used: hits.length,
        remaining: Math.max(0, limit - hits.length),
        retryAfterMs: allowed ? 0 : Math.max(0, oldest + windowMs - t),
      };
    },

    /** Records one operation. Call only when actually starting the work. */
    record() {
      const t = now();
      const hits = live(t);
      hits.push(t);
      writeHits(hits);
      return {
        used: hits.length,
        remaining: Math.max(0, limit - hits.length),
      };
    },

    /**
     * Convenience: check, and record if permitted. Returns the same shape as
     * check() so callers can branch on `.allowed` alone.
     */
    take() {
      const status = this.check();
      if (status.allowed) this.record();
      return status;
    },

    reset() {
      try {
        storage.removeItem(KEY_HITS);
      } catch {
        /* nothing to do */
      }
    },
  };
}

/** Shared instance used by the app. Tests build their own via createLimiter. */
let shared = null;
export function limiter() {
  if (!shared) shared = createLimiter();
  return shared;
}

/** Human-readable wait, for the message shown when a limit is hit. */
export function describeWait(ms) {
  const s = Math.ceil(ms / 1000);
  if (s <= 1) return 'a moment';
  if (s < 60) return `${s} seconds`;
  return 'a minute';
}
