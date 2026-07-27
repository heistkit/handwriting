/**
 * filetype.js — decide what to refuse, and explain what went wrong.
 *
 * The old rule was an allowlist: `file.type.startsWith('image/')`. That string
 * comes from the operating system and on most platforms is guessed from the
 * extension, so it is a label rather than a fact about the bytes. It rejected
 * a perfectly good JPEG that happened to have no extension, and it waved
 * through a zip renamed to .png.
 *
 * The rule is now the other way round: take anything, unless it is obviously
 * not a photograph, and let the decoder be the judge. If the browser can turn
 * it into pixels then it is an image, whatever the label said.
 *
 * The blocklist is therefore not a security control — nothing here protects
 * anything, and a determined file can rename itself past it in a second. It
 * exists so that dropping `app.js` on the page gets "that is a JavaScript
 * file" instead of a decode failure four seconds later.
 *
 * When decoding does fail, `explain()` reads the first bytes and says what it
 * actually found. That matters most for HEIC, which is what iPhones shoot by
 * default and which Chrome and Firefox cannot decode: the app used to guess at
 * HEIC in every failure message, which is wrong for a corrupt PNG.
 */

/**
 * Things that are definitely not a photograph of a sheet of paper, grouped so
 * the message can name what it is looking at.
 *
 * Deliberately not exhaustive. Anything missed here simply falls through to
 * the decoder, which is the real gate.
 */
const REFUSE = [
  {
    what: 'code',
    say: 'a code file',
    ext: ['js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'py', 'rb', 'go', 'rs', 'java', 'c', 'h',
      'cpp', 'cc', 'cs', 'php', 'sh', 'bash', 'zsh', 'fish', 'ps1', 'bat', 'cmd', 'sql',
      'json', 'yaml', 'yml', 'toml', 'ini', 'css', 'scss', 'less', 'html', 'htm', 'vue',
      'svelte', 'swift', 'kt', 'lua', 'pl', 'r', 'scala', 'dart', 'ex', 'exs', 'hs', 'clj'],
  },
  {
    what: 'archive',
    say: 'an archive',
    ext: ['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz', 'iso', 'dmg'],
  },
  {
    what: 'program',
    say: 'a program',
    ext: ['exe', 'dll', 'so', 'dylib', 'msi', 'deb', 'rpm', 'apk', 'app', 'bin', 'jar'],
  },
  {
    what: 'sound',
    say: 'a sound file',
    ext: ['mp3', 'wav', 'flac', 'm4a', 'ogg', 'aac'],
    mime: ['audio/'],
  },
  {
    what: 'font',
    say: 'a font',
    // Worth its own line: this app makes fonts, so someone will try it.
    ext: ['otf', 'ttf', 'woff', 'woff2', 'eot'],
  },
];

/** Lowercased extension, or '' when there is none. */
export function extensionOf(name = '') {
  const dot = String(name).lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return '';
  return name.slice(dot + 1).toLowerCase();
}

/**
 * @param {{name?: string, type?: string}} file
 * @returns {{ok: true} | {ok: false, what: string, message: string}}
 */
export function classify(file) {
  const ext = extensionOf(file?.name ?? '');
  const type = (file?.type ?? '').toLowerCase();

  // An explicit image label always wins, even where the extension looks
  // suspect — .gz is on the archive list, but image/svg+xml on a .svgz is a
  // real thing and the decoder can have it.
  if (type.startsWith('image/')) return { ok: true };

  for (const group of REFUSE) {
    const byExt = ext && group.ext.includes(ext);
    const byMime = group.mime?.some((m) => type.startsWith(m));
    if (byExt || byMime) {
      return {
        ok: false,
        what: group.what,
        message: `That looks like ${group.say}. This needs a photograph of your handwriting.`,
      };
    }
  }

  // Everything else gets in, including files with no extension and no type,
  // and including PDFs, documents and video. Those are not images, but they
  // are containers that very often have one inside them — a scanned PDF page
  // is a JPEG with a wrapper, and src/salvage.js will go and find it. Refusing
  // them at the door would have thrown away the readable ones along with the
  // rest.
  return { ok: true };
}

/**
 * What the first bytes actually say this file is.
 *
 * Only the cases worth a different sentence. Everything else returns null and
 * the caller falls back to a general message rather than inventing a cause.
 *
 * @param {ArrayBuffer|Uint8Array} head at least 16 bytes
 * @returns {'heic'|'jpeg'|'png'|'gif'|'webp'|'pdf'|'zip'|null}
 */
export function sniff(head) {
  const b = head instanceof Uint8Array ? head : new Uint8Array(head ?? []);
  if (b.length < 12) return null;

  const ascii = (from, to) => String.fromCharCode(...b.slice(from, to));

  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  if (b[0] === 0x89 && ascii(1, 4) === 'PNG') return 'png';
  if (ascii(0, 3) === 'GIF') return 'gif';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'webp';
  if (ascii(0, 4) === '%PDF') return 'pdf';
  if (b[0] === 0x50 && b[1] === 0x4b) return 'zip';

  // ISO base media: the box length is bytes 0-3, then the type. HEIC and its
  // relatives are identified by the brand that follows, not by the box itself —
  // an .mp4 has the same 'ftyp' box.
  if (ascii(4, 8) === 'ftyp') {
    const brand = ascii(8, 12).toLowerCase();
    if (['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'hevm', 'hevs', 'mif1', 'msf1'].includes(brand)) {
      return 'heic';
    }
  }
  return null;
}

/**
 * A sentence for a file that would not decode.
 *
 * @param {string|null} kind from sniff()
 * @returns {string}
 */
export function explain(kind) {
  if (kind === 'heic') {
    return 'That is a HEIC photo, which this browser cannot read. iPhones shoot HEIC by default — '
      + 'either re-export it as JPEG, or turn on Settings, Camera, Formats, Most Compatible.';
  }
  if (kind === 'pdf') {
    return 'That is a PDF. Export the page as an image first, or photograph the paper directly.';
  }
  if (kind === 'zip') {
    return 'That is an archive rather than an image, whatever it is named.';
  }
  if (kind) {
    return `That looks like a ${kind.toUpperCase()} but it would not open — the file may be damaged.`;
  }
  return 'That file would not open as an image. Try a JPEG or PNG straight from your camera.';
}
