/**
 * routes.js — every screen has an address.
 *
 * The app used to live entirely at `/`, with the legal documents hanging off a
 * fragment. That makes three ordinary things impossible: sending someone a
 * link to the guide, reloading without losing your place, and using the back
 * button to mean what it means everywhere else.
 *
 * Paths rather than fragments, because a fragment is a position within a
 * document and these are different screens. `/write` is a page. `#write` is a
 * heading somewhere.
 *
 * A guide lesson is the one thing here that genuinely *is* a position within a
 * document, so `/guide#pen` would be the reading of the paragraph above. It is
 * still a path — `/guide/pen` — for a mechanical reason rather than a
 * philosophical one: app.js wires the router to `hashchange` as well as
 * `popstate`, and applyRoute() reads the address and then, before it decides
 * anything, calls closeRoutedOverlays(). A fragment inside the guide would
 * therefore fire the router on every in-page jump and tear the open dialogue
 * down and rebuild it under the reader. A second path segment fires nothing it
 * should not.
 *
 * What this can and cannot restore
 * --------------------------------
 * A path names a screen, not a session. Nothing about your work is stored —
 * that is the whole privacy design — so reloading on `/refine` cannot bring
 * your font back, because there is no copy of it anywhere to bring back.
 * Rather than show an empty Refine screen pretending otherwise, an
 * unreachable path lands on the furthest screen that *is* reachable and
 * corrects the address. The URL never claims a state the app is not in.
 *
 * Legacy `#privacy` links keep working: they are rewritten to `/privacy` on
 * arrival, so anything already shared stays good.
 */

/** Step id ↔ path. `start` is the root, so it has no segment of its own. */
const STEP_PATHS = {
  start: '/',
  write: '/write',
  capture: '/capture',
  review: '/review',
  refine: '/refine',
  export: '/download',
};

/**
 * Overlays sit on top of a step visually, but their address replaces it — the
 * path says `/settings`, not `/write/settings`, and nothing about the step
 * underneath is recorded. Closing one therefore has to be told which step to
 * return the address to; app.js passes `state.step`, which is the step still on
 * screen behind the dialogue.
 */
const OVERLAY_PATHS = {
  guide: '/guide',
  settings: '/settings',
  feedback: '/feedback',
  privacy: '/privacy',
  terms: '/terms',
  licenses: '/licences',
};

/**
 * Overlays whose address may carry one further segment naming a section inside
 * them. `/guide/pen` is the guide, opened at the lesson about pens.
 *
 * Only the guide, because only the guide has what a section address needs: a
 * flat list of lessons with ids authored by hand in tutorial.js and content.js,
 * which do not move when the copy is edited. The legal documents are built from
 * `section.heading` strings and have no ids at all, and Settings has no sections
 * to name — so `/privacy/whatever` and `/settings/whatever` stay unrecognised
 * and are corrected away like any other path that names nothing.
 *
 * One segment, not a tree. A second would be naming something that does not
 * exist, so `/guide/pen/extra` is not a guide address at all.
 */
const SECTIONED_OVERLAYS = new Set(['guide']);

const stepFromPath = invert(STEP_PATHS);
const overlayFromPath = invert(OVERLAY_PATHS);

function invert(map) {
  return Object.fromEntries(Object.entries(map).map(([k, v]) => [v, k]));
}

/**
 * Percent-decode one path segment, tolerating rubbish.
 *
 * decodeURIComponent throws a URIError on a malformed escape such as `%zz`, and
 * the address bar is the one input a stranger can hand you. read() is called
 * from applyRoute(), from popstate and from hashchange, so a throw here is the
 * whole router down. An undecodable segment is handed back as it came: it will
 * match no lesson and be corrected away, which is the outcome any unrecognised
 * address already gets.
 */
function safeDecode(segment) {
  try {
    return decodeURIComponent(segment) || null;
  } catch {
    return segment || null;
  }
}

/**
 * The pathname with the noise taken off, so everything downstream sees one
 * spelling of a given screen.
 *
 * The trailing slash is not a nicety. `/write/` and `/write` are the same
 * screen to a reader, and a link shared with the slash on the end is one
 * someone typed or a CMS tidied.
 */
function normalisedPath() {
  let path = location.pathname.replace(/index\.html$/, '');
  if (path.length > 1) path = path.replace(/\/+$/, '');
  return path || '/';
}

/**
 * Where the app is served from.
 *
 * Taken from this module's own URL, not guessed from the current path. The
 * guess — walk the path looking for a segment that happens to be a known route
 * — cannot tell `/repo/` (the app's root, in a subdirectory) from `/repo` (a
 * route called repo at the domain root), and it got that exact case wrong:
 * served from `user.github.io/repo/`, the first navigation pushed
 * `user.github.io/write`, which looked right until a reload or a shared link
 * 404'd.
 *
 * `import.meta.url` has no such ambiguity — the module is at `<base>/src/
 * routes.js`, whatever the base is. It is trusted only when it is an http(s)
 * URL: under Node, or a bundler that rewrites it, it is a filesystem path and
 * would produce a base that has nothing to do with the served one.
 */
function detectBase() {
  try {
    const here = new URL('../', import.meta.url);
    if (here.protocol === 'http:' || here.protocol === 'https:') {
      return here.pathname.length > 1 ? here.pathname.replace(/\/+$/, '') : '/';
    }
  } catch {
    /* no import.meta in this environment */
  }
  return '/';
}

const BASE = detectBase();

export function base() {
  return BASE;
}

const join = (b, p) => (b === '/' ? p : p === '/' ? `${b}/` : b + p);

/**
 * Read the current address.
 * @returns {{step: string|null, overlay: string|null, section: string|null,
 *   fromHash: boolean}} `section` is the part of an overlay being asked for, and
 *   is a request rather than a promise — whether it names anything is the
 *   caller's to decide, because only the caller knows what loaded.
 */
export function read() {
  const b = base();
  let path = normalisedPath();
  if (b !== '/' && path.startsWith(b)) path = path.slice(b.length) || '/';

  let overlay = overlayFromPath[path] ?? null;
  let section = null;

  // `/guide/pen`: the leading segments name the overlay, the last names a
  // section within it. Tried only when the whole path is not itself an overlay,
  // so `/guide` can never be mistaken for a sectioned address.
  if (!overlay) {
    const cut = path.lastIndexOf('/');
    const parent = cut > 0 ? (overlayFromPath[path.slice(0, cut)] ?? null) : null;
    if (parent && SECTIONED_OVERLAYS.has(parent)) {
      overlay = parent;
      section = safeDecode(path.slice(cut + 1));
    }
  }

  const step = overlay ? null : (stepFromPath[path] ?? null);

  // Old links: #privacy, #terms, #licenses.
  const hash = location.hash.replace('#', '');
  if (!overlay && OVERLAY_PATHS[hash]) return { step, overlay: hash, section: null, fromHash: true };

  return { step, overlay, section, fromHash: false };
}

/**
 * Point the address bar at a screen.
 *
 * `replace` is for corrections — landing on an unreachable path, or upgrading
 * a legacy fragment. Those must not add a history entry, or Back would return
 * to the address that was just rejected and bounce forward again.
 */
export function write({ step, overlay = null, section = null, replace = false } = {}) {
  const b = base();
  const path = pathFor({ step, overlay, section });
  if (!path) return;

  const url = join(b, path);
  if (url === location.pathname && !location.hash) return;

  const method = replace ? 'replaceState' : 'pushState';
  try {
    history[method]({ step, overlay, section }, '', url);
  } catch {
    /* file:// and sandboxed contexts reject pushState; the app still works */
  }
}

/**
 * The path a screen lives at, base excluded.
 *
 * One function rather than two copies, because the address written into history
 * and the address put into a permalink have to be the same string. Two copies
 * drift, and the way that shows up is a link in the guide that opens something
 * other than the lesson it sits beside.
 */
function pathFor({ step, overlay = null, section = null }) {
  if (!overlay) return STEP_PATHS[step] ?? '/';
  const path = OVERLAY_PATHS[overlay];
  if (!path) return null;
  if (!section || !SECTIONED_OVERLAYS.has(overlay)) return path;
  return `${path}/${encodeURIComponent(section)}`;
}

export const stepPath = (step) => join(base(), pathFor({ step }));

/**
 * The absolute path of an overlay, or of a section within one — for putting in
 * an href. An address nobody can obtain is not an address, and the address bar
 * only ever shows `/guide` unless something writes the longer form.
 */
export const overlayPath = (overlay, section = null) =>
  join(base(), pathFor({ overlay, section }) ?? '/');
export const overlayIds = () => Object.keys(OVERLAY_PATHS);
export const isOverlay = (id) => Object.hasOwn(OVERLAY_PATHS, id);
