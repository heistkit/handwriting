/**
 * welcome.js — the hello, on the first visit only.
 *
 * The four steps were already on the page, in the deck two screens down. That
 * is fine for someone who has decided to read, and it is the wrong shape for
 * someone who has just arrived and does not yet know what this is: it asks them
 * to scroll before they have a reason to. So the same four lines are shown
 * once, up front, in a dialogue they can close in four different ways.
 *
 * Once means once. It is remembered so a second visit goes straight to the
 * page, and it never opens on top of something else — a link into /guide or
 * /privacy is a reader who already knows where they are going, and stacking a
 * greeting over their destination would be worse than not greeting them.
 *
 * Storage, not a cookie
 * ---------------------
 * The privacy policy says, in a published document: "Seven things, all in your
 * browser's local storage, and nothing else. No session storage, no IndexedDB,
 * no cookies." A cookie here would make that sentence false, would be sent to
 * the server on every request for a static site that has no use for it, and
 * would drag in consent obligations for a flag that exists to be polite once.
 * localStorage does the same job and is already what every other setting uses.
 *
 * When storage cannot be written — Safari private browsing, blocked cookies —
 * the greeting simply appears again next visit. That is the failure worth
 * having: the alternative is a reader who never sees it because a write that
 * silently did nothing was treated as proof they had.
 */

const KEY = 'handwrite.welcomed';

/** Has this reader been greeted before? */
export function greeted() {
  try {
    return localStorage.getItem(KEY) === 'yes';
  } catch {
    // Storage unavailable. Say no: showing a short dialogue twice is a smaller
    // cost than never showing it at all.
    return false;
  }
}

/** Do not greet them again. */
export function remember() {
  try {
    localStorage.setItem(KEY, 'yes');
  } catch {
    /* Nothing to be done, and nothing worth telling them about. */
  }
}

/**
 * Wire the dialogue up, and open it if this is a first visit.
 *
 * @param {object} hooks
 * @param {(sel: string) => void} hooks.open       the app's modal opener
 * @param {(sel: string) => void} hooks.close      the app's overlay closer
 * @param {() => void} hooks.onGuide               open the guide
 * @param {() => void} hooks.onStart               begin the flow
 * @param {() => boolean} hooks.canGreet           false when anything else owns the screen
 * @returns {{ open(): void }} so a control elsewhere can show it again
 */
export function mount({ open, close, onGuide, onStart, canGreet = () => true } = {}) {
  const panel = document.getElementById('welcome');
  if (!panel) return { open() {} };

  const dismiss = () => {
    // Remembered on the way out rather than on the way in. Someone who closes
    // the tab mid-sentence gets the greeting again, which is the forgiving end
    // of the mistake; marking it read the instant it appeared would mean a
    // reader who never actually read it never sees it again.
    remember();
    close('#welcome');
  };

  document.getElementById('close-welcome')?.addEventListener('click', dismiss);
  document.getElementById('welcome-guide')?.addEventListener('click', () => {
    dismiss();
    onGuide?.();
  });
  document.getElementById('welcome-start')?.addEventListener('click', () => {
    dismiss();
    onStart?.();
  });

  // Escape and a backdrop click are already handled for every .sheet-modal by
  // the app's own listeners, and they route through closeOverlay — which leaves
  // the address alone for a dialogue that owns none, as this one does. What
  // they do not do is record that the greeting happened, so that is caught here
  // rather than by duplicating either handler.
  const observer = new MutationObserver(() => {
    if (panel.hidden) remember();
  });
  observer.observe(panel, { attributes: true, attributeFilter: ['hidden'] });

  const show = () => open('#welcome');

  if (!greeted() && canGreet()) show();

  return { open: show };
}
