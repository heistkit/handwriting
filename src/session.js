/**
 * session.js — keep the work, so closing the tab is not losing it.
 *
 * Until this file existed, nothing about a session was stored. That was a real
 * privacy property and it is stated in the published policy, but it also meant
 * that somebody who filled a sheet by hand, photographed it, and then closed
 * the tab by accident had nothing left. The two are not actually in tension:
 * everything here stays on the device, in this origin's own storage, and none
 * of it is reachable by anything but this app. The policy has been rewritten to
 * say exactly this rather than to keep claiming nothing is kept.
 *
 * What is kept, and what is not
 * ----------------------------
 * Kept: the traced outlines, which are the work. Which step you were on. The
 * tuning settings. Which sheets have been photographed, and what the segmenter
 * found in each.
 *
 * Not kept, and this is the important half:
 *
 *   - The photographs. Each capture carries `page.bin`, the binarised scan of
 *     the whole sheet — 1400×1800 is 2.5 MB per sheet, four sheets is 10 MB,
 *     and it exists only to draw the review screen's before-and-after overlay.
 *     A restored session simply has no overlay. Storing a picture of somebody's
 *     desk to redraw a comparison they have already looked at is not a trade
 *     worth making.
 *   - The compiled font. It is derived from the outlines in about a second, and
 *     four styles of OTF is megabytes.
 *
 * Measured, on a full 112-character set: outlines are 302 KB rounded to two
 * decimal places, and the per-glyph rasters pack to 118 KB. Everything left out
 * above would have been another 12 MB.
 *
 * Why IndexedDB and not localStorage
 * ----------------------------------
 * Not because of size — 420 KB fits in localStorage's 5 MB easily. Two other
 * reasons. localStorage is synchronous, so every write blocks the main thread,
 * and this writes after every capture and every redrawn glyph. And it is one
 * budget shared with the seven settings: fill it and the next theme change
 * throws QuotaExceededError, which is a horrible failure to trace back.
 *
 * IndexedDB is asynchronous, has a quota measured in hundreds of megabytes, and
 * stores typed arrays natively through the structured clone algorithm — so the
 * rasters do not have to be JSON, which is what made them 3× bigger.
 *
 * Everything here fails soft. Private browsing rejects IndexedDB outright in
 * some browsers, quotas are enforced differently everywhere, and none of that
 * is worth an error on screen: the app worked without any of this yesterday.
 */

const DB_NAME = 'handwrite';
const DB_VERSION = 1;
const STORE = 'session';
const KEY = 'current';

/** Bumped when the shape below changes incompatibly. Older records are dropped. */
const SHAPE = 1;

const SETTING_KEY = 'handwrite.autosave';

/* -------------------------------------------------------------------------- */
/* The setting                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Is autosave on?
 *
 * Default on, and only the "off" answer is written — the same rule the
 * decoration switches follow, so somebody who has never opened Settings leaves
 * nothing behind at all.
 */
export function enabled() {
  try {
    return localStorage.getItem(SETTING_KEY) !== 'off';
  } catch {
    // Storage unreadable. Say on: the feature is the safer default, and a
    // browser that cannot read localStorage usually cannot write IndexedDB
    // either, so this resolves to "try, and fail quietly" a moment later.
    return true;
  }
}

/** @param {boolean} on */
export function setEnabled(on) {
  try {
    if (on) localStorage.removeItem(SETTING_KEY);
    else localStorage.setItem(SETTING_KEY, 'off');
  } catch {
    /* private mode — the choice lasts for this tab, which is the whole session */
  }
}

/* -------------------------------------------------------------------------- */
/* The database                                                               */
/* -------------------------------------------------------------------------- */

let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    let request;
    try {
      request = indexedDB.open(DB_NAME, DB_VERSION);
    } catch (err) {
      // Firefox in private browsing throws here rather than erroring the
      // request. Resolving null rather than rejecting keeps every caller free
      // of try/catch — "no database" is a normal state, not a failure.
      console.error('session: indexedDB is unavailable', err);
      resolve(null);
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => {
      console.error('session: could not open the database', request.error);
      resolve(null);
    };
    // A version change from another tab would otherwise leave this one holding
    // a connection that blocks it forever.
    request.onblocked = () => resolve(null);
  });
  return dbPromise;
}

function run(mode, fn) {
  return open().then((db) => {
    if (!db) return null;
    return new Promise((resolve) => {
      let tx;
      try {
        tx = db.transaction(STORE, mode);
      } catch (err) {
        console.error('session: could not start a transaction', err);
        resolve(null);
        return;
      }
      const request = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(request ? request.result : true);
      tx.onerror = () => {
        console.error('session: the transaction failed', tx.error);
        resolve(null);
      };
      tx.onabort = () => {
        // Quota is the realistic cause. Nothing to tell the reader: their work
        // is still on screen, it simply is not being kept.
        console.error('session: the transaction was aborted', tx.error);
        resolve(null);
      };
    });
  });
}

/* -------------------------------------------------------------------------- */
/* Reading and writing                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Everything worth keeping, and nothing else.
 *
 * Built by hand rather than by spreading the app's state, because the two
 * things this must never write — the page scans and the compiled font — are
 * both properties of that state, and a spread would pick them up the moment
 * anybody added a field.
 *
 * @param {object} state          the app's state object
 * @param {object} [opts]
 * @param {boolean} [opts.lean]   drop the per-glyph rasters
 * @param {number} [opts.at]      the timestamp to record
 */
export function snapshot(state, { lean = false, at = 0 } = {}) {
  return {
    v: SHAPE,
    savedAt: at,
    step: state.step,
    naturalSlant: state.naturalSlant,
    settings: { ...state.settings },
    // The sheets, without their photographs. `page` is deliberately absent.
    sheets: [...state.captures.entries()].map(([id, capture]) => ({
      id,
      stats: capture.stats,
      issues: capture.issues,
      slant: capture.slant,
      angle: capture.angle,
    })),
    glyphs: state.glyphs.map((g) => ({
      ch: g.ch,
      w: g.w,
      h: g.h,
      pad: g.pad,
      row: g.row,
      col: g.col,
      sheetId: g.sheetId,
      contours: g.contours,
      // The raster is what the review grid draws its thumbnail from. Under lite
      // mode it is dropped: that mode means "this device is working hard, or I
      // want less of everything", and 118 KB of copying on every save is
      // exactly the sort of thing it exists to switch off. A restored lean
      // session redraws its thumbnails from the outlines instead.
      bitmap: lean ? null : g.bitmap,
    })),
  };
}

/* -------------------------------------------------------------------------- */
/* Compression                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Gzip, through the platform's own stream. No dependency, no build step.
 *
 * Measured on a full 112-character set: 302 KB of JSON becomes 49 KB, a little
 * over six to one. Outlines compress like that because they are runs of similar
 * numbers in a repeating `{"x":…,"y":…}` frame — the frame itself is most of
 * the bytes, and it is the same frame every time.
 *
 * The trade is honest rather than free: structured clone would have stored the
 * typed arrays natively and this puts them through JSON first. At six to one it
 * is still four times smaller, and it makes the quota argument disappear on a
 * phone rather than merely be unlikely.
 *
 * CompressionStream is not everywhere — Safari got it in 16.4. Where it is
 * missing the record is stored as it is, tagged so the reader knows which it
 * got, and everything keeps working at 302 KB.
 */
const canZip = () => typeof CompressionStream === 'function';

async function drain(stream) {
  const chunks = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
}

async function zip(text) {
  const bytes = new TextEncoder().encode(text);
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'));
  return drain(stream);
}

async function unzip(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new TextDecoder().decode(await drain(stream));
}

/**
 * Numbers are rounded to two decimal places on the way out.
 *
 * The outlines are fitted to a raster of whole pixels, so the digits past the
 * second are noise from the fit rather than shape anybody could see — and they
 * are most of the file. This alone takes 564 KB to 302 KB, before gzip touches
 * it.
 */
const round2 = (key, value) => (typeof value === 'number' ? Math.round(value * 100) / 100 : value);

/* -------------------------------------------------------------------------- */
/* Reading and writing                                                        */
/* -------------------------------------------------------------------------- */

/** Write a snapshot. Resolves either way; a failure is logged, never thrown. */
export async function save(record) {
  if (!enabled()) return false;

  let payload;
  try {
    /*
     * The rasters travel beside the JSON, not inside it.
     *
     * Measured: putting them through JSON.stringify cost 333ms for a full set,
     * because 112 rasters of 8,400 bytes is 940 KB of numbers to turn into
     * decimal text one at a time. IndexedDB stores a Uint8Array natively
     * through structured clone, so handing them over as they are skips the
     * encode, the decode, and the three-times size — and gzip was never going
     * to help much with them either, since the interesting half of a glyph
     * raster is genuinely noisy.
     *
     * So: outlines and metadata as compressed JSON, rasters as an array of
     * typed arrays alongside, matched back up by index on the way in.
     */
    const rasters = record.glyphs.map((g) => g.bitmap ?? null);
    const lean = { ...record, glyphs: record.glyphs.map(({ bitmap, ...rest }) => rest) };
    const json = JSON.stringify(lean, round2);
    payload = {
      v: SHAPE,
      zipped: canZip(),
      savedAt: record.savedAt,
      body: canZip() ? await zip(json) : json,
      rasters,
    };
  } catch (err) {
    console.error('session: could not prepare the snapshot', err);
    return false;
  }

  const ok = await run('readwrite', (store) => store.put(payload, KEY));
  return ok !== null;
}

/**
 * Read back whatever is there, or null.
 *
 * A record from an incompatible shape is treated as nothing and cleared, rather
 * than half-restored — a session that comes back missing the field the tuner
 * reads is worse than one that does not come back.
 */
export async function load() {
  const stored = await run('readonly', (store) => store.get(KEY));
  if (!stored) return null;
  if (stored.v !== SHAPE) {
    console.error(`session: found shape ${stored.v}, expected ${SHAPE}; discarding`);
    forget();
    return null;
  }

  let record;
  try {
    // A record written where CompressionStream existed can be read on a visit
    // where it does not — a browser update, or the same person on a different
    // one. Nothing can be done about that except say so and start clean, which
    // is better than restoring a session that decompresses to rubbish.
    if (stored.zipped && !canZip()) {
      console.error('session: the saved work is compressed and this browser cannot read it');
      return null;
    }
    const json = stored.zipped ? await unzip(stored.body) : stored.body;
    record = JSON.parse(json);
  } catch (err) {
    console.error('session: the saved work could not be read back', err);
    forget();
    return null;
  }

  if (!Array.isArray(record.glyphs) || !record.glyphs.length) return null;

  // The rasters travelled beside the JSON rather than inside it, so put them
  // back by index. A lean save wrote nulls, and null is what the review grid
  // already understands as "redraw this one from its outline".
  const rasters = stored.rasters ?? [];
  record.glyphs.forEach((g, i) => { g.bitmap = rasters[i] ?? null; });

  return record;
}

/** Throw it away. Exposed to the reader as a control, not only used internally. */
export async function forget() {
  return (await run('readwrite', (store) => store.delete(KEY))) !== null;
}

/**
 * Roughly how much is being kept, in bytes, or null if nothing is.
 *
 * For the line in Settings beside the forget control. An estimate is honest
 * here and a precise figure would not be more useful — what somebody wants to
 * know is whether this is kilobytes or gigabytes.
 */
export async function weigh() {
  const stored = await run('readonly', (store) => store.get(KEY));
  if (!stored) return null;
  // The stored bytes themselves, not a reconstruction of them: the body is
  // already compressed and the rasters are already typed arrays, so this is
  // the real figure rather than an estimate of one. No decompression, which
  // matters because Settings calls this every time it opens.
  const body = stored.body?.byteLength ?? stored.body?.length ?? 0;
  const rasters = (stored.rasters ?? []).reduce((n, r) => n + (r?.byteLength ?? 0), 0);
  return body + rasters;
}
