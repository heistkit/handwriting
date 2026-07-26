/**
 * sfnt.js — surgery on a finished font binary.
 *
 * opentype.js writes a complete, valid OTF, but it has no GPOS writer, and a
 * few header fields it does not expose are the ones operating systems read to
 * decide that four separate files are one family. Rather than fork a 477 KB
 * dependency, this module treats the font as what it is — a directory of
 * independent tables — and rewrites that directory.
 *
 * The one genuinely fiddly part is checksums. Every table carries its own, the
 * file carries a global one in `head.checkSumAdjustment`, and that global value
 * is defined in terms of a file that contains it. The spec resolves the
 * circularity by requiring the field to be zero while the file checksum is
 * computed, which is what `finalise()` does below. Get this wrong and the font
 * still renders in most browsers but is rejected by Windows' installer, which
 * is a maddening bug to chase after the fact.
 */

const TAG = (s) => ((s.charCodeAt(0) << 24) | (s.charCodeAt(1) << 16) | (s.charCodeAt(2) << 8) | s.charCodeAt(3)) >>> 0;

// ---------------------------------------------------------------------------
// Byte writer
// ---------------------------------------------------------------------------

export class Writer {
  constructor(size = 1024) {
    this.buf = new Uint8Array(size);
    this.len = 0;
  }
  _ensure(n) {
    if (this.len + n <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < this.len + n) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
  }
  u8(v) { this._ensure(1); this.buf[this.len++] = v & 0xff; return this; }
  u16(v) { this._ensure(2); this.buf[this.len++] = (v >> 8) & 0xff; this.buf[this.len++] = v & 0xff; return this; }
  i16(v) { return this.u16(v < 0 ? v + 0x10000 : v); }
  u32(v) {
    this._ensure(4);
    this.buf[this.len++] = (v >>> 24) & 0xff;
    this.buf[this.len++] = (v >>> 16) & 0xff;
    this.buf[this.len++] = (v >>> 8) & 0xff;
    this.buf[this.len++] = v & 0xff;
    return this;
  }
  tag(s) { for (let i = 0; i < 4; i++) this.u8(s.charCodeAt(i)); return this; }
  /** Reserve two bytes to be back-filled once a forward offset is known. */
  placeholder() { const at = this.len; this.u16(0); return at; }
  patchU16(at, v) { this.buf[at] = (v >> 8) & 0xff; this.buf[at + 1] = v & 0xff; return this; }
  bytes() { return this.buf.subarray(0, this.len); }
}

// ---------------------------------------------------------------------------
// Reading an existing sfnt
// ---------------------------------------------------------------------------

/** Split a font binary into its tables. */
export function readTables(arrayBuffer) {
  const view = new DataView(arrayBuffer);
  const bytes = new Uint8Array(arrayBuffer);
  const sfntVersion = view.getUint32(0);
  const numTables = view.getUint16(4);

  const tables = new Map();
  for (let i = 0; i < numTables; i++) {
    const rec = 12 + i * 16;
    const tag = String.fromCharCode(
      bytes[rec], bytes[rec + 1], bytes[rec + 2], bytes[rec + 3]
    );
    const offset = view.getUint32(rec + 8);
    const length = view.getUint32(rec + 12);
    tables.set(tag, bytes.slice(offset, offset + length));
  }
  return { sfntVersion, tables };
}

// ---------------------------------------------------------------------------
// Checksums
// ---------------------------------------------------------------------------

/**
 * Sum of the table's contents read as big-endian uint32s.
 *
 * The spec requires the data be padded to a multiple of four *for the purposes
 * of this sum* — bytes past the end are treated as zero, which the bounds check
 * below achieves without allocating a padded copy.
 */
function checksum(data) {
  let sum = 0;
  const n = data.length;
  for (let i = 0; i < n; i += 4) {
    const b0 = data[i] ?? 0;
    const b1 = data[i + 1] ?? 0;
    const b2 = data[i + 2] ?? 0;
    const b3 = data[i + 3] ?? 0;
    sum = (sum + (((b0 << 24) | (b1 << 16) | (b2 << 8) | b3) >>> 0)) >>> 0;
  }
  return sum >>> 0;
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/**
 * Reassemble tables into a font binary.
 *
 * Records are sorted by tag and data is aligned to four bytes, both required by
 * the specification. `head.checkSumAdjustment` is zeroed before the whole-file
 * checksum is taken and written afterwards; see the note at the top.
 */
export function writeTables(sfntVersion, tables) {
  const tags = [...tables.keys()].sort();
  const numTables = tags.length;

  // Binary-search hint fields. Nothing reads them any more, but a font with
  // wrong values here fails strict validators for no visible reason.
  let entrySelector = 0;
  while (1 << (entrySelector + 1) <= numTables) entrySelector++;
  const searchRange = (1 << entrySelector) * 16;
  const rangeShift = numTables * 16 - searchRange;

  const headerSize = 12 + numTables * 16;
  let total = headerSize;
  const layout = [];
  for (const tag of tags) {
    const data = tables.get(tag);
    const padded = (data.length + 3) & ~3;
    layout.push({ tag, data, offset: total, length: data.length });
    total += padded;
  }

  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);

  view.setUint32(0, sfntVersion);
  view.setUint16(4, numTables);
  view.setUint16(6, searchRange);
  view.setUint16(8, entrySelector);
  view.setUint16(10, rangeShift);

  // Zero the adjustment field before anything is summed.
  const head = tables.get('head');
  if (head && head.length >= 12) {
    head[8] = head[9] = head[10] = head[11] = 0;
  }

  layout.forEach((entry, i) => {
    const rec = 12 + i * 16;
    view.setUint32(rec, TAG(entry.tag));
    view.setUint32(rec + 4, checksum(entry.data));
    view.setUint32(rec + 8, entry.offset);
    view.setUint32(rec + 12, entry.length);
    out.set(entry.data, entry.offset);
  });

  if (head) {
    const headEntry = layout.find((e) => e.tag === 'head');
    const adjustment = (0xb1b0afba - checksum(out)) >>> 0;
    view.setUint32(headEntry.offset + 8, adjustment);
  }

  return out.buffer;
}

// ---------------------------------------------------------------------------
// Field patches
// ---------------------------------------------------------------------------

/**
 * Set the bold and italic bits in `head.macStyle`.
 *
 * OS/2's fsSelection carries the same information and is what modern text
 * engines consult, but Windows' GDI path still reads macStyle when deciding
 * which file to use for a bold run. Setting only one of the two produces a
 * family that looks correct in a browser and silently refuses to go bold in
 * older desktop applications.
 */
export function patchMacStyle(tables, { bold = false, italic = false }) {
  const head = tables.get('head');
  if (!head || head.length < 46) return;
  const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
  let macStyle = view.getUint16(44);
  macStyle = bold ? macStyle | 0x01 : macStyle & ~0x01;
  macStyle = italic ? macStyle | 0x02 : macStyle & ~0x02;
  view.setUint16(44, macStyle);
}

/** Write the italic angle into `post`, in degrees counter-clockwise. */
export function patchItalicAngle(tables, degrees) {
  const post = tables.get('post');
  if (!post || post.length < 8) return;
  const view = new DataView(post.buffer, post.byteOffset, post.byteLength);
  // Fixed 16.16 signed.
  view.setInt32(4, Math.round(degrees * 65536));
}

/**
 * Mark that the OS/2 typo metrics are the authoritative ones.
 *
 * Without bit 7 set, applications are free to prefer the win/hhea metrics
 * instead, and handwriting fonts — whose ascenders and descenders are far more
 * extreme than a text face's — then get line spacing that either overlaps or
 * yawns open depending on which application is asked.
 */
export function patchUseTypoMetrics(tables) {
  const os2 = tables.get('OS/2');
  if (!os2 || os2.length < 64) return;
  const view = new DataView(os2.buffer, os2.byteOffset, os2.byteLength);
  view.setUint16(62, view.getUint16(62) | 0x80);
}

/**
 * Apply every post-processing step to a font opentype.js has just produced.
 *
 * @param {ArrayBuffer} arrayBuffer
 * @param {{gpos?: Uint8Array, bold?: boolean, italic?: boolean, italicAngle?: number}} opts
 */
export function finalise(arrayBuffer, opts = {}) {
  const { sfntVersion, tables } = readTables(arrayBuffer);
  const { gpos, bold = false, italic = false, italicAngle = 0 } = opts;

  if (gpos && gpos.length) tables.set('GPOS', gpos);
  patchMacStyle(tables, { bold, italic });
  patchItalicAngle(tables, italicAngle);
  patchUseTypoMetrics(tables);

  return writeTables(sfntVersion, tables);
}
