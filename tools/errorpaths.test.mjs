/**
 * What happens when the input is wrong.
 *
 * Every other suite feeds these functions the thing they were designed for. This
 * one feeds them the things a real person will: a renamed file, an empty one, a
 * font with no lowercase, a page that is entirely ink, a glyph with no outline.
 *
 * The bar is not "produces something sensible" — for most of these there is no
 * sensible answer. It is that the failure is *reachable*: a thrown error a caller
 * can catch, or a null a caller can test, and never a hang, a silent wrong
 * answer, or a TypeError from four frames deeper than anyone is looking.
 */

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass });
  console.log(`  ${pass ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};

/** Run something that is allowed to throw, and say which it did. */
function attempt(fn) {
  try { return { value: fn(), threw: null }; }
  catch (err) { return { value: undefined, threw: err }; }
}

export async function run() {
  console.log('\nerror paths');

  const mod = await import('../vendor/opentype.js');
  const opentype = mod.default ?? mod;
  globalThis.opentype = opentype;

  const { readFont, normaliseImported, rehydrateImported, scaleFor, licence } =
    await import('../src/fontimport.js');
  const { profilesFromContours, computeSpacing } = await import('../src/metrics.js');
  const { removeRules } = await import('../src/imageproc.js');
  const { snapshot } = await import('../src/session.js');

  // -- files that are not fonts ---------------------------------------------
  {
    // The accept attribute filters the picker, not the file. Anything can be
    // renamed, and on a phone the picker is frequently ignored entirely.
    const junk = new Uint8Array(2048);
    for (let i = 0; i < junk.length; i++) junk[i] = (i * 7) & 0xff;
    const a = attempt(() => readFont(junk.buffer, { chars: ['a'] }));
    check('random bytes throw rather than returning a broken font',
      a.threw instanceof Error, a.threw ? a.threw.constructor.name : `returned ${typeof a.value}`);

    const b = attempt(() => readFont(new ArrayBuffer(0), { chars: ['a'] }));
    check('an empty file throws too', b.threw instanceof Error,
      b.threw ? b.threw.message.slice(0, 40) : 'returned a value');

    // A PNG renamed to .otf — the most likely wrong file, because it is the
    // right file for the other half of this app.
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
    const c = attempt(() => readFont(png.buffer, { chars: ['a'] }));
    check('a photograph renamed to .otf throws', c.threw instanceof Error);
  }

  const rect = (name, unicode, w, h, advance, lsb = 40) => {
    const path = new opentype.Path();
    path.moveTo(lsb, 0); path.lineTo(lsb + w, 0);
    path.lineTo(lsb + w, h); path.lineTo(lsb, h); path.close();
    return new opentype.Glyph({ name, unicode, advanceWidth: advance, path });
  };
  const notdef = () =>
    new opentype.Glyph({ name: '.notdef', unicode: 0, advanceWidth: 500, path: new opentype.Path() });
  const font = (glyphs, extra = {}) => new opentype.Font({
    familyName: 'E', styleName: 'Regular', unitsPerEm: 1000,
    ascender: 800, descender: -200, glyphs, ...extra,
  });

  // -- fonts that parse but have nothing useful in them ---------------------
  {
    const empty = opentype.parse(font([notdef()]).toArrayBuffer());
    const read = readFont(font([notdef()]).toArrayBuffer(), { chars: ['a', 'b'] });
    check('a font with only .notdef yields no glyphs and says which are missing',
      read.glyphs.length === 0 && read.missing.join('') === 'ab', read.missing.join(''));
    check('and licence() still answers on it', licence(empty).restricted === false);

    // No 'x' to measure, which is the fallback branch in scaleFor. A font of
    // capitals only is an entirely ordinary thing to import.
    const caps = opentype.parse(font([notdef(), rect('A', 65, 400, 700, 480)]).toArrayBuffer());
    const s = scaleFor(caps);
    check('a font with no lowercase x still gets a usable scale',
      Number.isFinite(s) && s > 0, String(s));

    // A glyph that is a real glyph with a real advance and no ink at all.
    const withSpace = opentype.parse(font([
      notdef(),
      new opentype.Glyph({ name: 'space', unicode: 32, advanceWidth: 300, path: new opentype.Path() }),
    ]).toArrayBuffer());
    check('a glyph with no outline returns null rather than an empty shape',
      normaliseImported(' ', withSpace.charToGlyph(' '), 1) === null);
  }

  // -- degenerate geometry ---------------------------------------------------
  {
    const p = profilesFromContours([]);
    check('no contours profile as nothing, not as NaN',
      p.ys.length === 0 && p.left.length === 0);
    check('and a null contour list does not throw',
      attempt(() => profilesFromContours(null)).threw === null);
    check('and a contour with no curves does not throw',
      attempt(() => profilesFromContours([{ curves: [] }])).threw === null);
  }

  // -- pages that are not pages ---------------------------------------------
  {
    // Every pixel ink. A photograph taken with the lens covered binarises to
    // exactly this, and it is one long horizontal run on every row.
    const w = 200, h = 120;
    const all = new Uint8Array(w * h).fill(1);
    const r = attempt(() => removeRules(all, w, h));
    check('an all-ink page does not throw', r.threw === null,
      r.threw ? r.threw.message : `removed ${r.value?.removed}`);
    check('and does not erase the entire page as one rule',
      r.value && r.value.bin.some((v) => v === 1),
      r.value ? `${r.value.removed} of ${w * h} px removed` : 'threw');

    check('a one-pixel page does not throw',
      attempt(() => removeRules(new Uint8Array(1), 1, 1)).threw === null);
    check('and neither does an empty one',
      attempt(() => removeRules(new Uint8Array(0), 0, 0)).threw === null);
  }

  // -- an imported session survives a reload ---------------------------------
  //
  // The claim made in a comment, tested. session.js stores the contours and the
  // original bearings and nothing else; rehydrateImported rebuilds the rest. If
  // it and normaliseImported ever disagree, a font built after a reload is spaced
  // differently from the same font built before one.
  {
    const src = font([notdef(), rect('x', 120, 300, 500, 380), rect('o', 111, 320, 500, 400)]);
    const { glyphs } = readFont(src.toArrayBuffer(), { chars: ['x', 'o'] });

    const direct = glyphs.map((g) => ({ ...g, profiles: g.profiles, ink: { ...g.ink } }));
    computeSpacing(direct, {});

    // What comes back out of the database: contours and `original`, nothing more.
    const stored = snapshot(
      { step: 'refine', naturalSlant: 0, settings: {}, captures: new Map(), glyphs,
        imported: { family: 'E', count: 2 } },
      { at: 0 },
    );
    check('the snapshot records that these glyphs were imported',
      stored.imported?.count === 2, JSON.stringify(stored.imported));
    check('and keeps the spacing the source font arrived with',
      stored.glyphs.every((g) => g.original && Number.isFinite(g.original.advanceWidth)));
    check('and does not store what it can recompute',
      stored.glyphs.every((g) => g.profiles === undefined && g.ink === undefined),
      'profiles and ink are functions of the contours');

    const restored = stored.glyphs.map((g) => rehydrateImported({ ...g }));
    check('rehydration puts back everything computeSpacing needs',
      restored.every((g) => g.ink && Number.isFinite(g.inkWidth) && g.profiles?.ys.length > 10));

    computeSpacing(restored, {});
    const drift = direct.map((g, i) => Math.abs(g.advanceWidth - restored[i].advanceWidth));
    check('and a reloaded font is spaced identically to one that never reloaded',
      Math.max(...drift) < 1e-6,
      direct.map((g, i) => `${g.ch} off by ${drift[i].toExponential(1)}`).join(', '));
  }

  return results;
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}`) run();
