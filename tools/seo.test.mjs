/**
 * The crawlable surface: structured data, the sitemap, robots.txt and llms.txt.
 *
 * All four of these are copies. The structured data restates the meta
 * description, the four step cards and the whole FAQ; llms.txt restates the
 * guide; the sitemap restates routes.js; robots.txt restates the sitemap's
 * address. None of it is rendered anywhere a person would notice it going
 * stale — that is the entire point of it, it exists for readers who never load
 * the page — so the failure mode is silent by construction: the copy drifts, the
 * page keeps working, and what a search engine or an assistant is told about
 * this app is quietly a year out of date.
 *
 * So every copy is compared against the thing it copies, and the two files that
 * partition the address space are checked to actually partition it: every screen
 * with an address is either in the sitemap or carries a noindex header, never
 * both and never neither.
 *
 * Structural checks, done on source text rather than through a DOM. There is no
 * DOM here and adding one to assert that a string appears twice would be a
 * dependency bought to make a grep look official.
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { FAQ } from '../src/tutorial.js';
import { overlayIds, overlayPath, stepPath } from '../src/routes.js';

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass });
  console.log(`  ${pass ? 'ok  ' : 'FAIL'} ${name}${detail && !pass ? ` — ${detail}` : ''}`);
};

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (name) => readFile(join(root, name), 'utf8');

/** The few entities this document actually uses. */
const decode = (s) =>
  s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'");

/**
 * The step ids, read out of routes.js rather than restated.
 *
 * STEP_PATHS is not exported — it is private to the router, and exporting it to
 * make a test tidier would be cutting a seam into production code for the
 * test's benefit. Reading the source is honest about what it is, and each id it
 * finds is then put through the exported stepPath() so a regex that quietly
 * stopped matching cannot pass as "no steps to check".
 */
function stepIdsFromSource(src) {
  const block = src.match(/const STEP_PATHS = \{([\s\S]*?)\n\};/)?.[1] ?? '';
  return [...block.matchAll(/^\s*(\w+):/gm)].map((m) => m[1]);
}

export async function run() {
  console.log('\nseo');

  const html = await read('index.html');
  const robots = await read('robots.txt');
  const sitemap = await read('sitemap.xml');
  const llms = await read('llms.txt');
  const vercel = JSON.parse(await read('vercel.json'));
  const routesSrc = await read('src/routes.js');
  const metaSrc = await read('src/meta.js');

  // --- the structured data parses at all -----------------------------------
  const raw = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)?.[1] ?? '';
  check('index.html carries a JSON-LD block', raw.trim().length > 0);

  let doc = null;
  try {
    doc = JSON.parse(raw);
  } catch (err) {
    // The whole failure mode: a trailing comma costs nothing visible. The page
    // renders, the block is ignored in silence, and the structured data is gone.
    check('and it is valid JSON', false, String(err.message));
  }
  if (doc) check('and it is valid JSON', true);

  const graph = doc?.['@graph'] ?? [];
  const node = (type) => graph.find((n) => n['@type'] === type);
  const app = node('WebApplication');
  const howto = node('HowTo');
  const faq = node('FAQPage');

  check('it declares the schema.org context', doc?.['@context'] === 'https://schema.org');
  check('it describes a WebApplication', !!app);
  check('it describes a HowTo', !!howto);
  check('it describes a FAQPage', !!faq);

  // Fragment-only ids, for the reason index.html gives above the block: an
  // absolute one would tell every crawler that a self-hosted copy is really
  // handwritingfont.vercel.app.
  const ids = graph.map((n) => n['@id']).filter(Boolean);
  check('every @id is a fragment, so it resolves against whatever host serves it',
    ids.length === graph.length && ids.every((id) => id.startsWith('#')), ids.join(', '));

  // --- nothing invented -----------------------------------------------------
  {
    // Structured data is read by machines that cannot sanity-check it, which
    // makes it the one place where a made-up number is both easiest to add and
    // most likely to be believed. Nobody has rated this app.
    const invented = ['aggregateRating', 'ratingValue', 'reviewCount', 'ratingCount',
      'interactionStatistic', 'userInteractionCount', 'award']
      .filter((prop) => raw.includes(prop));
    check('no rating, review count or interaction count is claimed',
      invented.length === 0, invented.join(', '));
  }

  // --- the description is the page's own ------------------------------------
  {
    const meta = decode(html.match(/<meta name="description" content="([^"]*)"/)?.[1] ?? '');
    check('the page has a meta description', meta.length > 0);
    check('and the WebApplication repeats it verbatim rather than rewording it',
      app?.description === meta, `${JSON.stringify(app?.description)} vs ${JSON.stringify(meta)}`);
  }

  // --- the HowTo is the four cards on the page ------------------------------
  {
    const cards = [...html.matchAll(
      /<div class="stepcard__text">[\s\S]*?<h3>([\s\S]*?)<\/h3>\s*<p>([\s\S]*?)<\/p>/g
    )].map(([, name, text]) => ({
      name: decode(name.trim()),
      text: decode(text.replace(/\s+/g, ' ').trim()),
    }));

    check('the four step cards are still in the document', cards.length === 4,
      `${cards.length} found`);

    const steps = (howto?.step ?? []).map((s) => ({ name: s.name, text: s.text }));
    check('the HowTo has one step per card', steps.length === cards.length);
    const same = steps.length === cards.length &&
      steps.every((s, i) => s.name === cards[i].name && s.text === cards[i].text);
    check('and each step repeats its card word for word', same,
      JSON.stringify(steps.filter((s, i) => s.name !== cards[i]?.name || s.text !== cards[i]?.text)));

    check('the steps are numbered in order',
      (howto?.step ?? []).every((s, i) => s.position === i + 1));
  }

  // --- the FAQPage is tutorial.js -------------------------------------------
  {
    const asked = (faq?.mainEntity ?? []).map((q) => ({
      q: q.name,
      a: q.acceptedAnswer?.text,
    }));
    check('the FAQPage has one entry per question in tutorial.js',
      asked.length === FAQ.length, `${asked.length} vs ${FAQ.length}`);
    const drifted = FAQ
      .map((entry, i) => (asked[i]?.q === entry.q && asked[i]?.a === entry.a ? null : entry.q))
      .filter(Boolean);
    check('and every question and answer matches it verbatim', drifted.length === 0,
      drifted.join('; '));
  }

  // --- the sitemap and the noindex header partition the addresses -----------
  const locs = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  const origin = locs[0] ? new URL(locs[0]).origin : '';
  const sitemapPaths = new Set(locs.map((u) => new URL(u).pathname.replace(/^(.+)\/$/, '$1')));

  {
    check('the sitemap lists at least the landing page', locs.length > 0);
    check('and every entry is an absolute https URL, as the specification requires',
      locs.every((u) => u.startsWith('https://')), locs.join(', '));
    check('and they are all the same host', locs.every((u) => new URL(u).origin === origin));
    check('and none is listed twice', sitemapPaths.size === locs.length);
  }

  // The noindex rule, read back out of the deployment config the same way the
  // markup test reads the policy: what is asserted has to be the string that
  // ships, not a second copy of it kept here.
  const noindex = vercel.headers.find((h) =>
    h.headers.some((x) => x.key === 'X-Robots-Tag' && /noindex/.test(x.value)));
  check('a noindex header rule is deployed', !!noindex);
  const noindexed = new Set(
    (noindex?.source.match(/\(([^)]*)\)/)?.[1] ?? '').split('|').filter(Boolean).map((s) => `/${s}`)
  );
  check('and it names at least one address', noindexed.size > 0, noindex?.source);
  check('it follows links from the pages it hides, so the guide is still reachable',
    /follow/.test(noindex?.headers.find((x) => x.key === 'X-Robots-Tag')?.value ?? ''));

  {
    const steps = stepIdsFromSource(routesSrc);
    check('the step ids were read out of routes.js', steps.length >= 5, steps.join(', '));

    const addresses = [
      ...steps.map((id) => stepPath(id)),
      ...overlayIds().map((id) => overlayPath(id)),
    ];
    // Both files answer the same question — is this address a page? — and the
    // only way they can disagree quietly is by both saying nothing.
    const orphaned = addresses.filter((p) => !sitemapPaths.has(p) && !noindexed.has(p));
    check('every address is either in the sitemap or marked noindex',
      orphaned.length === 0, orphaned.join(', '));
    const both = addresses.filter((p) => sitemapPaths.has(p) && noindexed.has(p));
    check('and none is both at once', both.length === 0, both.join(', '));

    // The sitemap must not offer a URL that no longer exists.
    const unknown = [...sitemapPaths].filter((p) => !addresses.includes(p));
    check('and the sitemap names no address the router does not have',
      unknown.length === 0, unknown.join(', '));
  }

  // --- meta.js knows every screen -------------------------------------------
  {
    const named = new Set([...metaSrc.matchAll(/^\s{2}(\w+):\s*\{/gm)].map((m) => m[1]));
    const steps = stepIdsFromSource(routesSrc).filter((id) => id !== 'start');
    const missing = [...steps, ...overlayIds()].filter((id) => !named.has(id));
    // 'start' is deliberately absent: it takes the title index.html authored,
    // which is the one place the landing page's name should live.
    check('src/meta.js has a title for every screen but the start', missing.length === 0,
      missing.join(', '));
    check('and does not name the start screen, which keeps the authored title',
      !named.has('start'));
  }

  // --- robots.txt -----------------------------------------------------------
  {
    check('robots.txt allows everything', /User-agent:\s*\*/i.test(robots) && /^Allow:\s*\/$/m.test(robots));
    const declared = robots.match(/^Sitemap:\s*(\S+)$/mi)?.[1];
    check('robots.txt names the sitemap', !!declared);
    check('and names it at the same host the sitemap uses',
      !!declared && new URL(declared).origin === origin, `${declared} vs ${origin}`);
    check('and points at a file that exists', declared?.endsWith('/sitemap.xml'));

    // Blocking the modules is the standard way to accidentally hide a
    // client-rendered site from the one crawler that would have rendered it.
    const blocked = [...robots.matchAll(/^Disallow:\s*(\S+)$/gm)].map((m) => m[1]);
    check('nothing needed to render the page is disallowed',
      !blocked.some((p) => p === '/' || /^\/(src|vendor|assets|styles)/.test(p)),
      blocked.join(', '));
  }

  // --- llms.txt -------------------------------------------------------------
  {
    check('llms.txt exists and is substantial', llms.length > 1000);
    check('and opens with a title and a summary',
      /^# \S/m.test(llms) && /^> /m.test(llms));
    const linked = locs.filter((u) => llms.includes(u));
    check('and links every page the sitemap lists', linked.length === locs.length,
      locs.filter((u) => !llms.includes(u)).join(', '));
    // The claim the whole app rests on, stated where an assistant will read it.
    check('and states that nothing is uploaded',
      /no upload|not? .{0,20}uploaded|nothing is ever uploaded/i.test(llms));
  }

  return results;
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}`) {
  run();
}
