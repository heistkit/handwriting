/**
 * Tests for pulling a JPEG out of a container the browser cannot decode.
 *
 * Two properties carry the weight.
 *
 * It must pick the LARGEST embedded image, not the first. Camera raw files put
 * a small thumbnail ahead of the full-size preview, so "first" would reliably
 * hand the tracer a 160px picture of a sheet of handwriting and then report
 * that the characters could not be read.
 *
 * And it must not hang or mis-detect on hostile input. This runs on bytes that
 * already failed to decode once, so by definition it is looking at something
 * unusual — truncated files, nested markers, and long runs of 0xFF are the
 * normal case here rather than the edge case.
 */

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass });
  console.log(`  ${pass ? 'ok  ' : 'FAIL'} ${name}${detail && !pass ? ` — ${detail}` : ''}`);
};

/** A JPEG-shaped run of `size` bytes: FF D8 FF … FF D9. */
function jpeg(size, fill = 0x20) {
  const b = new Uint8Array(size);
  b.fill(fill);
  b[0] = 0xff; b[1] = 0xd8; b[2] = 0xff; b[3] = 0xe0;
  b[size - 2] = 0xff; b[size - 1] = 0xd9;
  return b;
}

function concat(...parts) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

const noise = (n, fill = 0x41) => new Uint8Array(n).fill(fill);

export async function run() {
  const { findJpegs, largestJpeg } = await import('../src/salvage.js');

  // --- the shape of a raw file ---------------------------------------------
  {
    // TIFF-ish header, small thumbnail, then the full-size preview: the layout
    // every camera raw actually uses.
    const buf = concat(noise(120), jpeg(4096, 0x11), noise(64), jpeg(40000, 0x22), noise(500));
    const runs = findJpegs(buf);
    check('both embedded images are found', runs.length === 2, String(runs.length));

    const best = largestJpeg(buf);
    check('the full-size preview is chosen, not the thumbnail',
      best !== null && best.length === 40000, String(best?.length));
    check('and it is a complete JPEG',
      best[0] === 0xff && best[1] === 0xd8 && best[best.length - 2] === 0xff && best[best.length - 1] === 0xd9);
  }

  // --- nothing to find -----------------------------------------------------
  {
    check('a file with no JPEG in it yields null', largestJpeg(noise(9000)) === null);
    check('an empty file yields null', largestJpeg(new Uint8Array(0)) === null);
    // A thumbnail alone is not worth handing to the tracer.
    check('a run under the floor is ignored', largestJpeg(jpeg(500)) === null);
  }

  // --- hostile and malformed ------------------------------------------------
  {
    // Opens and never closes. Must terminate rather than scan forever.
    const truncated = concat(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]), noise(50000));
    check('an unterminated JPEG is not returned', largestJpeg(truncated) === null);

    // A long run of 0xFF is the classic false-positive generator.
    const ffs = new Uint8Array(20000).fill(0xff);
    let threw = false;
    try { largestJpeg(ffs); } catch { threw = true; }
    check('a file of nothing but 0xFF does not throw', !threw);

    // A start marker inside another image must not split the outer one.
    const inner = jpeg(3000, 0x33);
    const outer = concat(
      new Uint8Array([0xff, 0xd8, 0xff, 0xe0]), noise(2000), inner, noise(2000),
      new Uint8Array([0xff, 0xd9])
    );
    const runs = findJpegs(outer);
    check('a nested marker does not produce overlapping runs',
      runs.every((r, i) => i === 0 || r.start >= runs[i - 1].end), JSON.stringify(runs));
  }

  // --- accepts either kind of buffer ---------------------------------------
  {
    const b = concat(noise(10), jpeg(3000));
    check('an ArrayBuffer works as well as a view',
      largestJpeg(b.buffer.slice(0)) !== null);
  }

  return results;
}
