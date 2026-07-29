/**
 * pointer.js — keeps `data-pointer` on <html> honest for the life of the page.
 *
 * preflight.js sets it once from a media query. That is a guess about the
 * device, and a device is not one thing: a tablet gains a trackpad when it is
 * docked, a laptop with a touchscreen is used by finger a minute after being
 * used by mouse, a phone gets a Bluetooth mouse. Worse, the media query answers
 * for the *primary* pointer, so a touchscreen laptop reports `(hover: hover)`
 * and `(pointer: fine)` — correctly — while somebody is touching it.
 *
 * Every pointerdown carries the answer for the interaction that is actually
 * happening, so the answer is read from there and the attribute corrected in
 * place. That is the part a media query cannot do at all.
 *
 * `touch` is the only pointerType that does not hover. A pen does — a stylus
 * over a Surface reports a position before it contacts the glass — so it is
 * grouped with the mouse rather than with touch, which is the opposite of what
 * `(pointer: coarse)` would have concluded about it.
 *
 * Capture phase, so this lands before any handler that might stop propagation.
 * Passive, because it never calls preventDefault and saying so lets the browser
 * scroll without waiting to find out.
 *
 * What reads it: every `:hover` rule in styles.css is scoped to
 * `:where(html[data-pointer="fine"])`, and the redraw button on a glyph tile is
 * shown outright under `coarse` rather than hidden behind a hover that will
 * never fire. tools/hover.test.mjs is what stops a new rule being added without
 * the scope.
 */

function set(kind) {
  const root = document.documentElement;
  if (root.dataset.pointer !== kind) root.dataset.pointer = kind;
}

export function init() {
  const query = '(hover: hover) and (pointer: fine)';

  // Said again here, having already been said in preflight.js. Not redundant:
  // preflight is a separate file that a strict extension or a proxy can fail to
  // deliver, and every hover in the app is scoped to this attribute now. The
  // cost of repeating it is one media query; the cost of assuming it is that a
  // desktop visitor gets a page where nothing responds to the mouse.
  let mq = null;
  try {
    mq = matchMedia(query);
    set(mq.matches ? 'fine' : 'coarse');
  } catch {
    // No matchMedia. Assume a pointer that hovers, because that is the older
    // machine this branch describes, and because the failure it avoids —
    // hover rules silently dead on a desktop — is the worse of the two.
    set('fine');
  }

  addEventListener(
    'pointerdown',
    (e) => set(e.pointerType === 'touch' ? 'coarse' : 'fine'),
    { capture: true, passive: true },
  );

  // A mouse plugged into a tablet changes the query without generating a
  // pointerdown. Rare and cheap to handle; without it a device that has just
  // become hoverable stays in the touch layout until something is tapped.
  mq?.addEventListener?.('change', (ev) => set(ev.matches ? 'fine' : 'coarse'));
}
