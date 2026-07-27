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
 * Overlays sit *on top of* a step rather than replacing it, so their entry
 * records which step was underneath. Closing one returns you there.
 */
const OVERLAY_PATHS = {
  guide: '/guide',
  settings: '/settings',
  privacy: '/privacy',
  terms: '/terms',
  licenses: '/licences',
};

const stepFromPath = invert(STEP_PATHS);
const overlayFromPath = invert(OVERLAY_PATHS);

function invert(map) {
  return Object.fromEntries(Object.entries(map).map(([k, v]) => [v, k]));
}

/**
 * Strip the directory the app is served from, so this works at a subpath —
 * GitHub Pages serves projects from `/repo-name/`, and hard-coding a leading
 * slash would break every route there.
 */
/**
 * The pathname with the noise taken off, so everything downstream sees one
 * spelling of a given screen.
 *
 * The trailing slash is not a nicety. `/write/` and `/write` are the same
 * screen to a reader, and a link shared with the slash on the end is a link
 * someone typed or a CMS mangled. Left alone it defeated base(), which then
 * treated `/write` as the directory and the empty remainder as the root — so a
 * deep link with a slash landed on the start page instead of the one it named.
 */
function normalisedPath() {
  let path = location.pathname.replace(/index\.html$/, '');
  if (path.length > 1) path = path.replace(/\/+$/, '');
  return path || '/';
}

export function base() {
  const path = normalisedPath();
  // Anything the router knows about is a route, so whatever precedes it is the
  // base. Otherwise the current directory is.
  for (const p of [...Object.values(STEP_PATHS), ...Object.values(OVERLAY_PATHS)]) {
    if (p !== '/' && (path === p || path.endsWith(p))) return path.slice(0, -p.length) || '/';
  }
  return path.replace(/\/[^/]*$/, '') || '/';
}

const join = (b, p) => (b === '/' ? p : p === '/' ? `${b}/` : b + p);

/**
 * Read the current address.
 * @returns {{step: string|null, overlay: string|null}}
 */
export function read() {
  const b = base();
  let path = normalisedPath();
  if (b !== '/' && path.startsWith(b)) path = path.slice(b.length) || '/';

  const overlay = overlayFromPath[path] ?? null;
  const step = overlay ? null : (stepFromPath[path] ?? null);

  // Old links: #privacy, #terms, #licenses.
  const hash = location.hash.replace('#', '');
  if (!overlay && OVERLAY_PATHS[hash]) return { step, overlay: hash, fromHash: true };

  return { step, overlay, fromHash: false };
}

/**
 * Point the address bar at a screen.
 *
 * `replace` is for corrections — landing on an unreachable path, or upgrading
 * a legacy fragment. Those must not add a history entry, or Back would return
 * to the address that was just rejected and bounce forward again.
 */
export function write({ step, overlay = null, replace = false } = {}) {
  const b = base();
  const path = overlay ? OVERLAY_PATHS[overlay] : (STEP_PATHS[step] ?? '/');
  if (!path) return;

  const url = join(b, path);
  if (url === location.pathname && !location.hash) return;

  const method = replace ? 'replaceState' : 'pushState';
  try {
    history[method]({ step, overlay }, '', url);
  } catch {
    /* file:// and sandboxed contexts reject pushState; the app still works */
  }
}

export const stepPath = (step) => join(base(), STEP_PATHS[step] ?? '/');
export const overlayIds = () => Object.keys(OVERLAY_PATHS);
export const isOverlay = (id) => Object.hasOwn(OVERLAY_PATHS, id);
