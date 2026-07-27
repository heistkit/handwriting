/**
 * salvage.js — get an image out of a file the browser refused to decode.
 *
 * The browser decodes what it decodes: JPEG, PNG, GIF, BMP, WebP, SVG, and —
 * depending on which browser — AVIF, TIFF, HEIC. Everything else fails, and
 * until now that was the end of it.
 *
 * But a great many files that a browser cannot decode still have a perfectly
 * ordinary JPEG sitting inside them:
 *
 *   camera raw   DNG, CR2, NEF, ARW and friends are TIFF containers, and
 *                nearly all of them carry a full-size JPEG preview
 *   PDF          a scanned page is usually a DCTDecode stream, which is a
 *                JPEG with a wrapper around it
 *   HEIC         often carries a JPEG thumbnail even where the main image is
 *                HEVC and unreadable
 *
 * So rather than parse any of those formats, this scans the bytes for JPEG
 * markers and takes the largest complete one it finds. No format knowledge, no
 * dependency, and it works on containers nobody has thought of yet.
 *
 * The cost is real and deliberate. It walks the whole file, which for a 60 MB
 * raw is tens of milliseconds of scanning and a large copy — and it only runs
 * after the normal path has already failed, so nothing pays for it unless the
 * alternative was giving up.
 *
 * What it cannot do
 * -----------------
 * Invent a decoder. If a HEIC has no embedded JPEG, this finds nothing, and
 * the honest failure message is still the answer. It does not make every file
 * readable; it makes the readable-but-hidden ones readable.
 */

/** Below this a run is a thumbnail or a false positive, not a page. */
const MIN_BYTES = 2048;

/**
 * Every complete JPEG in the buffer, as {start, end} byte offsets.
 *
 * A JPEG starts FF D8 FF and ends FF D9. Scanning for the pair rather than
 * parsing segment lengths means a truncated or slightly malformed inner file
 * cannot derail the search — it simply does not close, and is skipped.
 *
 * @param {Uint8Array} bytes
 * @returns {Array<{start: number, end: number}>}
 */
export function findJpegs(bytes) {
  const found = [];
  const n = bytes.length;
  let i = 0;

  while (i < n - 3) {
    // Start of Image, followed by any marker — the third byte rules out the
    // FF D8 pairs that turn up constantly inside compressed data.
    if (bytes[i] === 0xff && bytes[i + 1] === 0xd8 && bytes[i + 2] === 0xff) {
      let j = i + 3;
      let end = -1;
      while (j < n - 1) {
        if (bytes[j] === 0xff && bytes[j + 1] === 0xd9) { end = j + 2; break; }
        j += 1;
      }
      if (end === -1) break;              // nothing closes after here
      if (end - i >= MIN_BYTES) found.push({ start: i, end });
      i = end;                            // never nest one inside another
    } else {
      i += 1;
    }
  }
  return found;
}

/**
 * The largest complete JPEG in the buffer, or null.
 *
 * Largest rather than first on purpose: raw files put a small thumbnail before
 * the full-size preview, and the thumbnail is far too small to trace.
 *
 * @param {ArrayBuffer|Uint8Array} buffer
 * @returns {Uint8Array|null}
 */
export function largestJpeg(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const runs = findJpegs(bytes);
  if (!runs.length) return null;

  let best = runs[0];
  for (const run of runs) {
    if (run.end - run.start > best.end - best.start) best = run;
  }
  return bytes.subarray(best.start, best.end);
}

/**
 * Try to produce something decodable from a file that would not decode.
 *
 * @param {Blob} file
 * @returns {Promise<Blob|null>} a JPEG, or null if there was nothing to find
 */
export async function salvage(file) {
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const jpeg = largestJpeg(bytes);
    if (!jpeg) return null;
    // Copied out of the view rather than handed a subarray: the underlying
    // buffer holds the whole original file, and a Blob over a view of it would
    // keep every byte of a 60 MB raw alive for as long as the blob lives.
    return new Blob([jpeg.slice()], { type: 'image/jpeg' });
  } catch {
    return null;
  }
}
