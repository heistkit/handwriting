/**
 * offline.js — registers the service worker, and gets out of the way.
 *
 * Kept separate from app.js because it is the one piece of this app that can
 * outlive a page load. Everything else stops mattering when the tab closes; a
 * worker keeps controlling the origin. That deserves its own file with its own
 * reasoning rather than four lines buried in the boot sequence.
 *
 * Registration is deliberately unconditional beyond what is required to work.
 * There is no setting for it, and that is not an oversight: the cache holds the
 * application's own files, the same bytes every visitor downloads, and nothing
 * derived from anybody's handwriting. The switch that governs stored *work* is in
 * Settings and belongs to src/session.js. Offering a second switch here would
 * suggest the two store comparable things.
 */

/**
 * @param {object} [opts]
 * @param {string} [opts.path]  the worker script, root-scoped
 */
export function init({ path = '/sw.js' } = {}) {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;

  // A worker needs a secure context. Registering from anything else throws, and
  // `file://` is a real way people open a downloaded copy of this page.
  if (!self.isSecureContext) return;

  // After load, not during it. Registration competes for bandwidth with the
  // resources the first paint is waiting on, and the whole benefit lands on the
  // *next* visit — so there is nothing to gain by being early and a slower first
  // render to lose.
  const start = () => {
    navigator.serviceWorker.register(path).catch((err) => {
      // Failure is not a problem worth telling anybody about: the app works
      // exactly as it did before this file existed. It is worth logging, because
      // otherwise "offline does not work" has no thread to pull.
      console.error('offline: could not register the worker', err);
    });
  };

  if (document.readyState === 'complete') start();
  else addEventListener('load', start, { once: true });
}
