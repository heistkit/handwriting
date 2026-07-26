/**
 * export.js — getting the font off the page and onto the user's machine.
 *
 * Four outputs, because "download a font" means different things depending on
 * what someone is going to do next:
 *
 *   .otf   install on the operating system                    (the main event)
 *   .woff  embed on a website                                 (needs @font-face)
 *   .zip   all four styles plus a readme, in one click        (the sane default)
 *   .css   a ready-made @font-face block for the woff files
 *
 * Both containers are written by hand rather than pulled from a library. WOFF
 * is a thin wrapper over the sfnt tables we already have, and a store-only ZIP
 * is about eighty lines — neither justifies a dependency in an app whose entire
 * appeal is that it downloads once and then needs no network at all.
 */

// ---------------------------------------------------------------------------
// Little-endian writer (ZIP is LE; sfnt and WOFF are BE)
// ---------------------------------------------------------------------------

class LEWriter {
  constructor(size = 1024) {
    this.buf = new Uint8Array(size);
    this.len = 0;
  }
  _ensure(n) {
    if (this.len + n <= this.buf.length) return;
    let cap = Math.max(this.buf.length * 2, 64);
    while (cap < this.len + n) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
  }
  u16(v) { this._ensure(2); this.buf[this.len++] = v & 0xff; this.buf[this.len++] = (v >> 8) & 0xff; return this; }
  u32(v) {
    this._ensure(4);
    this.buf[this.len++] = v & 0xff;
    this.buf[this.len++] = (v >>> 8) & 0xff;
    this.buf[this.len++] = (v >>> 16) & 0xff;
    this.buf[this.len++] = (v >>> 24) & 0xff;
    return this;
  }
  raw(bytes) { this._ensure(bytes.length); this.buf.set(bytes, this.len); this.len += bytes.length; return this; }
  bytes() { return this.buf.subarray(0, this.len); }
}

// ---------------------------------------------------------------------------
// WOFF
// ---------------------------------------------------------------------------

/**
 * Wrap an sfnt in the WOFF 1.0 container.
 *
 * WOFF compresses each table independently with zlib, which the platform
 * already provides: `CompressionStream('deflate')` emits exactly the
 * zlib-wrapped stream the format wants. (Note the distinction from
 * `'deflate-raw'`, which omits the two-byte zlib header and produces a file
 * every browser will silently refuse to load.)
 *
 * WOFF2 is deliberately not attempted. It needs Brotli plus the format's glyph
 * transforms, neither of which is available natively, and the saving over WOFF
 * on a font this size does not justify shipping a compressor.
 */
export async function toWOFF(arrayBuffer, { majorVersion = 1, minorVersion = 0 } = {}) {
  const src = new Uint8Array(arrayBuffer);
  const view = new DataView(arrayBuffer);
  const flavor = view.getUint32(0);
  const numTables = view.getUint16(4);

  const entries = [];
  for (let i = 0; i < numTables; i++) {
    const rec = 12 + i * 16;
    entries.push({
      tag: view.getUint32(rec),
      checksum: view.getUint32(rec + 4),
      offset: view.getUint32(rec + 8),
      length: view.getUint32(rec + 12),
    });
  }
  entries.sort((a, b) => a.tag - b.tag);

  // Compress each table, keeping the original whenever deflate fails to help —
  // which happens for very short tables, where the zlib header outweighs any
  // saving. Equal lengths signal "stored" to the reader.
  for (const e of entries) {
    const original = src.subarray(e.offset, e.offset + e.length);
    const compressed = await deflate(original);
    if (compressed && compressed.length < original.length) {
      e.data = compressed;
      e.compLength = compressed.length;
    } else {
      e.data = original;
      e.compLength = original.length;
    }
    e.origLength = e.length;
  }

  const headerSize = 44;
  const dirSize = numTables * 20;
  let offset = headerSize + dirSize;
  for (const e of entries) {
    e.woffOffset = offset;
    offset += (e.compLength + 3) & ~3;
  }
  const totalLength = offset;

  const out = new Uint8Array(totalLength);
  const dv = new DataView(out.buffer);

  dv.setUint32(0, 0x774f4646); // 'wOFF'
  dv.setUint32(4, flavor);
  dv.setUint32(8, totalLength);
  dv.setUint16(12, numTables);
  dv.setUint16(14, 0);
  dv.setUint32(16, arrayBuffer.byteLength); // totalSfntSize
  dv.setUint16(20, majorVersion);
  dv.setUint16(22, minorVersion);
  // metaOffset / metaLength / metaOrigLength / privOffset / privLength all zero.

  entries.forEach((e, i) => {
    const rec = headerSize + i * 20;
    dv.setUint32(rec, e.tag);
    dv.setUint32(rec + 4, e.woffOffset);
    dv.setUint32(rec + 8, e.compLength);
    dv.setUint32(rec + 12, e.origLength);
    dv.setUint32(rec + 16, e.checksum);
    out.set(e.data, e.woffOffset);
  });

  return out;
}

async function deflate(bytes) {
  if (typeof CompressionStream !== 'function') return null;
  try {
    const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// ZIP
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * Build a ZIP with no compression.
 *
 * Store-only is the right call: the archive holds OTF and WOFF files whose
 * tables are already compressed, so deflate would spend time to save almost
 * nothing. It also keeps the writer short enough to read in one sitting.
 *
 * @param {Array<{name: string, data: Uint8Array|string}>} files
 */
export function makeZip(files) {
  const encoder = new TextEncoder();
  const local = new LEWriter(1 << 16);
  const entries = [];

  // A fixed timestamp. Real clock values make byte-identical inputs produce
  // different archives, which is a small thing but an unnecessary one.
  const dosTime = 0;
  const dosDate = (2024 - 1980) << 9 | (1 << 5) | 1;

  for (const file of files) {
    const data = typeof file.data === 'string' ? encoder.encode(file.data) : file.data;
    const name = encoder.encode(file.name);
    const crc = crc32(data);
    const headerOffset = local.len;

    local.u32(0x04034b50);
    local.u16(20);      // version needed
    local.u16(0);       // flags
    local.u16(0);       // method: stored
    local.u16(dosTime);
    local.u16(dosDate);
    local.u32(crc);
    local.u32(data.length);
    local.u32(data.length);
    local.u16(name.length);
    local.u16(0);
    local.raw(name);
    local.raw(data);

    entries.push({ name, crc, size: data.length, headerOffset });
  }

  const central = new LEWriter(1 << 12);
  for (const e of entries) {
    central.u32(0x02014b50);
    central.u16(20);    // version made by
    central.u16(20);    // version needed
    central.u16(0);
    central.u16(0);
    central.u16(dosTime);
    central.u16(dosDate);
    central.u32(e.crc);
    central.u32(e.size);
    central.u32(e.size);
    central.u16(e.name.length);
    central.u16(0);     // extra
    central.u16(0);     // comment
    central.u16(0);     // disk
    central.u16(0);     // internal attrs
    central.u32(0);     // external attrs
    central.u32(e.headerOffset);
    central.raw(e.name);
  }

  const end = new LEWriter(32);
  end.u32(0x06054b50);
  end.u16(0);
  end.u16(0);
  end.u16(entries.length);
  end.u16(entries.length);
  end.u32(central.len);
  end.u32(local.len);
  end.u16(0);

  const out = new Uint8Array(local.len + central.len + end.len);
  out.set(local.bytes(), 0);
  out.set(central.bytes(), local.len);
  out.set(end.bytes(), local.len + central.len);
  return out;
}

// ---------------------------------------------------------------------------
// Text artefacts
// ---------------------------------------------------------------------------

const slug = (s) => s.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'Handwriting';

/** A ready-to-paste @font-face block covering all four styles. */
export function cssSnippet(familyName, styles) {
  const base = slug(familyName);
  const blocks = styles.map((s) => {
    const weight = s.weightClass >= 700 ? 700 : 400;
    const style = s.italic ? 'italic' : 'normal';
    return `@font-face {
  font-family: '${familyName}';
  src: url('${base}-${slug(s.style)}.woff') format('woff');
  font-weight: ${weight};
  font-style: ${style};
  font-display: swap;
}`;
  });

  return `${blocks.join('\n\n')}

/* Then use it: */
body {
  font-family: '${familyName}', cursive;
  /* Letter variants rotate automatically. To switch them off: */
  /* font-feature-settings: 'calt' 0; */
}
`;
}

/** The readme that ships inside the zip. */
export function readmeText(familyName, styles, stats = {}) {
  const base = slug(familyName);
  return `${familyName}
${'='.repeat(familyName.length)}

Made from your own handwriting. This font is yours — there is no licence to
follow, no attribution required, and nothing was uploaded anywhere to create it.


WHAT IS IN HERE
---------------
${styles.map((s) => `  ${base}-${slug(s.style)}.otf     ${s.style}`).join('\n')}

  woff/                        the same four styles, for use on a website
  ${base}.css                  a stylesheet that loads them
  README.txt                   this file


INSTALLING
----------
Windows    Select all four .otf files, right-click, and choose "Install".
           Restart any app that was already open before it will appear.

macOS      Double-click each .otf file and press "Install Font". Or drag all
           four into Font Book.

Linux      Copy the .otf files into ~/.local/share/fonts/ then run
           fc-cache -f -v

iOS        Use a font-installer app; iOS cannot install fonts from Files alone.

Android    Most apps cannot use custom fonts. Some launchers and note apps can.


USING BOLD AND ITALIC
---------------------
All four styles share one family name, so your word processor will switch
between them when you press Bold or Italic. There is no need to pick
"${familyName} Bold" from the font menu by hand.


ABOUT THE LETTER VARIANTS
-------------------------
Each letter was built in ${stats.variantCount ?? 3} slightly different versions, and the font
rotates through them as you type, so repeated letters do not look identical.
This is a standard OpenType feature called "calt" and it is on by default.

If you ever want it off, most design apps expose it as "Contextual Alternates".


DETAILS
-------
  Characters      ${stats.glyphCount ?? '—'}
  Kerning pairs   ${stats.kernCount ?? '—'}
  Made           ${new Date().toISOString().slice(0, 10)}
`;
}

// ---------------------------------------------------------------------------
// Download
// ---------------------------------------------------------------------------

/** Hand a blob to the browser as a download. */
export function download(data, filename, mime = 'application/octet-stream') {
  const blob = data instanceof Blob ? data : new Blob([data], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoking immediately can cancel the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/**
 * Bundle a whole family: OTFs, WOFFs, the stylesheet and the readme.
 *
 * @param {string} familyName
 * @param {Array<{style: string, italic: boolean, weightClass: number, otf: ArrayBuffer}>} styles
 */
export async function bundleFamily(familyName, styles, stats = {}) {
  const base = slug(familyName);
  const files = [];

  for (const s of styles) {
    files.push({ name: `${base}-${slug(s.style)}.otf`, data: new Uint8Array(s.otf) });
  }
  for (const s of styles) {
    files.push({ name: `woff/${base}-${slug(s.style)}.woff`, data: await toWOFF(s.otf) });
  }

  files.push({ name: `${base}.css`, data: cssSnippet(familyName, styles) });
  files.push({ name: 'README.txt', data: readmeText(familyName, styles, stats) });

  return makeZip(files);
}

export { slug as slugify };
