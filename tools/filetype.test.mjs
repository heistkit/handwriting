/**
 * Tests for what the capture step will take.
 *
 * The property that matters is the direction of the rule. It used to be an
 * allowlist on `file.type`, which is a label the operating system guesses from
 * the extension — so a real JPEG with no extension was refused and a zip named
 * .png was waved through. It is a blocklist now, and the decoder is the actual
 * gate, so the tests are mostly about what must NOT be refused.
 *
 * sniff() is checked against real magic bytes rather than against itself: the
 * whole reason it exists is that the app used to blame HEIC for every failure,
 * including failures that had nothing to do with HEIC.
 */

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass });
  console.log(`  ${pass ? 'ok  ' : 'FAIL'} ${name}${detail && !pass ? ` — ${detail}` : ''}`);
};

const file = (name, type = '') => ({ name, type });

/** Build a header with an ASCII signature at a byte offset. */
function head(...parts) {
  const b = new Uint8Array(16);
  for (const [offset, value] of parts) {
    if (typeof value === 'string') {
      for (let i = 0; i < value.length; i++) b[offset + i] = value.charCodeAt(i);
    } else {
      b.set(value, offset);
    }
  }
  return b;
}

export async function run() {
  const { classify, sniff, explain, extensionOf } = await import('../src/filetype.js');

  // --- what must still get through --------------------------------------
  {
    // The case the old allowlist got wrong: a camera file with no extension
    // and no type at all. The decoder decides, not the label.
    check('a file with no extension and no type is accepted',
      classify(file('IMG_4021')).ok);
    check('an unknown extension is accepted', classify(file('scan.qqq')).ok);
    check('an ordinary jpeg is accepted', classify(file('a.jpg', 'image/jpeg')).ok);
    check('HEIC is accepted here, and fails later with a real reason',
      classify(file('IMG_1.HEIC', 'image/heic')).ok);
    check('an image label beats a suspect extension',
      classify(file('drawing.svgz', 'image/svg+xml')).ok);
    check('case in the extension does not matter', classify(file('SHEET.JPEG', '')).ok);
  }

  // --- what gets a specific refusal ---------------------------------------
  {
    const code = classify(file('app.js'));
    check('a code file is refused', code.ok === false && code.what === 'code');
    check('and the message names it', /code file/.test(code.message || ''), code.message);

    check('an archive is refused', classify(file('fonts.zip')).what === 'archive');
    check('a program is refused', classify(file('setup.exe')).what === 'program');
    check('a font is refused', classify(file('MyHand.otf')).what === 'font');
    check('sound is refused by its type alone', classify(file('memo', 'audio/mp4')).what === 'sound');

    // Deliberately NOT refused. These are not images, but they are containers
    // that usually have one inside — a scanned PDF page is a JPEG with a
    // wrapper — and src/salvage.js goes looking. Refusing them at the door
    // would throw away the readable ones with the rest.
    check('a PDF is let through to the salvage path', classify(file('scan.pdf')).ok);
    check('a video is let through too', classify(file('clip.mov', 'video/quicktime')).ok);
    check('a camera raw is let through', classify(file('DSC_0001.NEF')).ok);
  }

  // --- sniffing the bytes --------------------------------------------------
  {
    check('jpeg', sniff(head([0, [0xff, 0xd8, 0xff]])) === 'jpeg');
    check('png', sniff(head([0, [0x89]], [1, 'PNG'])) === 'png');
    check('gif', sniff(head([0, 'GIF89a'])) === 'gif');
    check('webp', sniff(head([0, 'RIFF'], [8, 'WEBP'])) === 'webp');
    check('pdf', sniff(head([0, '%PDF'])) === 'pdf');
    check('zip', sniff(head([0, [0x50, 0x4b, 0x03, 0x04]])) === 'zip');

    check('heic, by its brand', sniff(head([4, 'ftyp'], [8, 'heic'])) === 'heic');
    check('and its relatives', sniff(head([4, 'ftyp'], [8, 'mif1'])) === 'heic');
    // The one that makes the check worth writing: an mp4 carries the same
    // 'ftyp' box, so testing for the box alone would call every video a HEIC.
    check('an mp4 is not mistaken for heic', sniff(head([4, 'ftyp'], [8, 'isom'])) === null);

    check('too few bytes is not a guess', sniff(new Uint8Array(4)) === null);
    check('nothing recognisable is null', sniff(head([0, 'hello world!'])) === null);
  }

  // --- the sentences -------------------------------------------------------
  {
    check('heic gets advice that can be acted on',
      /HEIC/.test(explain('heic')) && /JPEG|Most Compatible/.test(explain('heic')));
    check('an unknown failure does not blame HEIC', !/HEIC/i.test(explain(null)), explain(null));
  }

  // --- the helper ----------------------------------------------------------
  {
    check('no extension', extensionOf('IMG_1') === '');
    check('a dotfile has no extension', extensionOf('.gitignore') === '');
    check('a trailing dot has none either', extensionOf('weird.') === '');
    check('the last one wins', extensionOf('a.tar.gz') === 'gz');
  }

  return results;
}
