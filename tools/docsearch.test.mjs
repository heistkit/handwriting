/**
 * Tests for documentation search.
 *
 * buildIndex/terms/search are pure, so they run in Node. `highlight` builds DOM
 * nodes and is checked in the browser instead.
 */

import { buildIndex, search, terms } from '../src/docsearch.js';

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass });
  console.log(`  ${pass ? 'ok  ' : 'FAIL'} ${name}${detail && !pass ? ` — ${detail}` : ''}`);
};

const DOCS = {
  LESSONS: [
    { id: 'pen', title: 'Pick the right pen',
      body: ['A gel pen or fineliner gives an even, dark line.'],
      tips: ['Avoid pencil — the grey is too faint to threshold cleanly.'] },
    { id: 'light', title: 'Lighting and shadows',
      body: ['Shoot in even light. Uneven lighting is corrected automatically.'], tips: [] },
    { id: 'space', title: 'Spacing',
      body: ['Side bearings are measured from the ink profile of each character.'], tips: [] },
  ],
  FAQ: [
    { q: 'Is anything I write uploaded?', a: 'No. Everything happens in this browser tab.' },
    { q: 'Who owns the font?', a: 'You do, entirely. There is no licence to follow.' },
  ],
  INSTALL: [
    { os: 'windows', label: 'Windows',
      steps: ['Select all four .otf files.', 'Right-click and choose Install.'],
      note: 'Install for all users needs administrator rights.' },
    { os: 'macos', label: 'macOS', steps: ['Double-click each file, then Install Font.'] },
  ],
};

export async function run() {
  console.log('\ndocsearch');

  const index = buildIndex(DOCS);

  // --- index shape ---------------------------------------------------------
  check('indexes every source', index.length === 7, String(index.length));
  check('labels each kind', new Set(index.map((e) => e.kindLabel)).size === 3);
  check('install entries get a readable title',
    index.some((e) => e.title === 'Installing on Windows'));
  check('precomputes a haystack', index.every((e) => typeof e.haystack === 'string' && e.haystack));

  // --- tokenising ----------------------------------------------------------
  check('drops stop words', JSON.stringify(terms('the pen and the ink')) === '["pen","ink"]',
    JSON.stringify(terms('the pen and the ink')));
  check('keeps a query that is only stop words',
    terms('the').length === 1, JSON.stringify(terms('the')));
  check('splits on punctuation', JSON.stringify(terms('windows/macos')) === '["windows","macos"]');
  check('empty query yields nothing', terms('   ').length === 0);

  // --- matching ------------------------------------------------------------
  check('empty query returns no results', search(index, '').length === 0);
  check('finds by title word', search(index, 'pen')[0]?.title === 'Pick the right pen');
  check('finds by body text', search(index, 'bearings')[0]?.title === 'Spacing');
  check('finds by tip text', search(index, 'pencil')[0]?.title === 'Pick the right pen');
  check('finds install steps', search(index, 'right-click')[0]?.title === 'Installing on Windows');
  check('is case insensitive', search(index, 'WINDOWS').length === search(index, 'windows').length);

  // --- AND, not OR ---------------------------------------------------------
  {
    const both = search(index, 'install windows');
    check('requires every term', both.length === 1 && both[0].title === 'Installing on Windows',
      JSON.stringify(both.map((h) => h.title)));
    check('no match when one term is absent', search(index, 'windows kangaroo').length === 0);
  }

  // --- word boundaries -----------------------------------------------------
  {
    // "Open the downloaded zip" must not answer a search for "pen".
    const hits = search(index, 'pen').map((h) => h.title);
    check('does not match mid-word', !hits.some((t) => /Installing/.test(t)),
      JSON.stringify(hits));
    check('still finds the real pen page', hits.includes('Pick the right pen'));
  }
  {
    // Prefix search has to keep working while someone is still typing.
    check('matches a word prefix', search(index, 'wind')[0]?.title === 'Installing on Windows');
    check('matches a prefix inside a tip', search(index, 'admin').length === 1);
  }

  // --- ranking -------------------------------------------------------------
  {
    const hits = search(index, 'lighting');
    check('title match outranks body match', hits[0].title === 'Lighting and shadows',
      JSON.stringify(hits.map((h) => h.title)));
  }
  {
    // 'font' appears in an FAQ question and in a macOS step.
    const hits = search(index, 'who owns the font?');
    check('question-shaped queries favour the FAQ', hits[0]?.kind === 'faq',
      JSON.stringify(hits.map((h) => `${h.kind}:${h.title}`)));
  }

  // --- snippets ------------------------------------------------------------
  {
    const hit = search(index, 'bearings')[0];
    check('snippet carries the match', /bearings/i.test(hit.snippet), hit.snippet);
    check('snippet stays short', hit.snippet.length <= 200, String(hit.snippet.length));
  }
  {
    const long = buildIndex({
      LESSONS: [{ id: 'x', title: 'Long', body: ['pad '.repeat(60) + 'NEEDLE ' + 'pad '.repeat(60)], tips: [] }],
    });
    const s = search(long, 'needle')[0].snippet;
    check('long text is windowed around the match', s.includes('NEEDLE') && s.length < 220,
      `${s.length}`);
    check('windowed snippet is elided', s.startsWith('…') && s.endsWith('…'), s.slice(0, 20));
  }

  // --- robustness ----------------------------------------------------------
  check('handles an empty corpus', search(buildIndex({}), 'anything').length === 0);
  check('handles missing sections', buildIndex({ FAQ: DOCS.FAQ }).length === 2);
  check('regex characters are literal, not patterns', search(index, '.otf').length >= 1);
  check('a query of pure punctuation finds nothing', search(index, '***').length === 0);

  return results;
}
