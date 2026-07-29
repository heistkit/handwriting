/**
 * Tests for the mascot's eye tracking.
 *
 * The thing worth defending is the cache. Rects cannot be read on every pointer
 * move — that is a forced layout per mouse event — so they are read once and
 * marked stale, and every way of being wrong here is a way of being wrong about
 * when they go stale. Too eager and the module is back to measuring constantly;
 * too lazy and the eyes aim at where a card used to be.
 *
 * That second failure is what these tests are mostly about, because it actually
 * shipped. The step deck is a nested scroll container, and a scroll event fired
 * at an element does not bubble to the window — so a window listener never
 * heard the deck move, and one swipe left the eyes tracking a card's old
 * position for the rest of the session.
 *
 * The window stub below models exactly that rule and nothing else about the
 * DOM: an event dispatched with `bubbles: false` reaches window listeners only
 * if they registered for the capture phase. Get that rule wrong in the module
 * and the deck test fails; get it wrong in the stub and the test is worthless,
 * which is why it is stated once, in one place, with the reason attached.
 */

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass });
  console.log(`  ${pass ? 'ok  ' : 'FAIL'} ${name}${detail && !pass ? ` — ${detail}` : ''}`);
};

/** Matches REACH in src/mascot.js — the tests do the same arithmetic. */
const REACH = 1.6;

/**
 * A window that keeps its listeners and can dispatch to them.
 *
 * `bubbles: false` means the event was fired at an element inside the document,
 * which is how scroll events from a nested scroller behave: the window is on
 * the propagation path, but only its capture-phase listeners are called.
 */
function fakeWindow() {
  const listeners = [];
  const isCapture = (opts) => opts === true || (!!opts && opts.capture === true);
  return {
    listeners,
    add(type, fn, opts) { listeners.push({ type, fn, capture: isCapture(opts) }); },
    remove(type, fn, opts) {
      const capture = isCapture(opts);
      const i = listeners.findIndex((l) => l.type === type && l.fn === fn && l.capture === capture);
      if (i >= 0) listeners.splice(i, 1);
    },
    count: (type) => listeners.filter((l) => l.type === type).length,
    dispatch(type, event = {}, { bubbles = true } = {}) {
      for (const l of [...listeners]) {
        if (l.type !== type) continue;
        if (!bubbles && !l.capture) continue;
        l.fn(event);
      }
    },
  };
}

/** A `.stepcard`, which the module asks about through `closest`. */
function makeCard(current) {
  const card = {
    current,
    classList: { contains: (name) => name === 'is-current' && card.current },
  };
  return card;
}

/** A `.mascot__stage` that counts how often it is measured. */
function makeStage(card, rect) {
  const props = new Map();
  const stage = {
    card,
    rect: { ...rect },
    reads: 0,
    look: () => [props.get('--look-x'), props.get('--look-y')],
    centred: () => !props.has('--look-x') && !props.has('--look-y'),
    style: {
      setProperty: (name, value) => { props.set(name, value); },
      removeProperty: (name) => { props.delete(name); },
    },
    getBoundingClientRect() {
      stage.reads += 1;
      return { ...stage.rect };
    },
    closest: (selector) => (selector === '.stepcard' ? stage.card : null),
  };
  return stage;
}

/**
 * Two cards side by side in a track 400 wide, the second one off screen to the
 * right — the deck exactly as a reader first meets it.
 */
function makeDeck() {
  const cards = [makeCard(true), makeCard(false)];
  const stages = [
    makeStage(cards[0], { left: 150, top: 200, width: 100, height: 100 }),
    makeStage(cards[1], { left: 550, top: 200, width: 100, height: 100 }),
  ];
  return {
    cards,
    stages,
    root: { querySelectorAll: () => stages },
    /** One card's worth of swipe: everything inside the track slides left. */
    swipe(by = 400) {
      for (const stage of stages) stage.rect.left -= by;
      cards[0].current = false;
      cards[1].current = true;
    },
  };
}

export async function run() {
  const win = fakeWindow();
  let hoverFine = true;
  let reduced = false;

  const env = {
    matchMedia: (query) => ({
      matches: query.includes('prefers-reduced-motion') ? reduced : hoverFine,
    }),
    document: { documentElement: { dataset: {} } },
    addEventListener: (...args) => win.add(...args),
    removeEventListener: (...args) => win.remove(...args),
  };
  for (const [k, v] of Object.entries(env)) globalThis[k] = v;

  const { mount } = await import('../src/mascot.js');

  // --- the deck moving under the eyes ---------------------------------------
  {
    const deck = makeDeck();
    const stop = mount(deck.root);

    // Pointer on the centre of the card in view: the drop looks straight ahead.
    win.dispatch('pointermove', { clientX: 200, clientY: 250 });
    check('a pointer at the centre of the card in view is looked at straight',
      deck.stages[0].look().join() === '0.000,0.000', deck.stages[0].look().join());

    // Swipe the deck one card. The event is fired at the track, which is a
    // scroll container inside the page — it does not bubble, and the window
    // never scrolled at all.
    deck.swipe();
    win.dispatch('scroll', {}, { bubbles: false });

    // The second card now sits where the first one was, so the same pointer
    // position is again dead centre. Reading a stale rect puts the card's
    // centre 400 to the right of the pointer, which is 2.5 card-reaches away
    // and clamps: the eyes peg hard left while the pointer is in the middle of
    // the face.
    win.dispatch('pointermove', { clientX: 200, clientY: 250 });
    const [x, y] = deck.stages[1].look();
    check('after the deck is swiped the new card is measured where it now is',
      x === '0.000' && y === '0.000', `look-x ${x}, look-y ${y}`);
    check('and the card swiped out of view is not left staring',
      deck.stages[0].centred());

    // Half a swipe, to be sure the first one was not a fluke of round numbers.
    deck.stages[1].rect.left += 40;
    win.dispatch('scroll', {}, { bubbles: false });
    win.dispatch('pointermove', { clientX: 200, clientY: 250 });
    const expected = ((200 - 240) / (100 * REACH)).toFixed(3);
    check('a partial swipe moves the eyes by exactly what the card moved',
      deck.stages[1].look()[0] === expected, `${deck.stages[1].look()[0]} vs ${expected}`);

    stop();
  }

  // --- the page moving under the eyes, which is the other scroller ----------
  {
    const deck = makeDeck();
    const stop = mount(deck.root);
    win.dispatch('pointermove', { clientX: 200, clientY: 250 });

    // A document-level scroll does bubble to the window, and must still count.
    for (const stage of deck.stages) stage.rect.top -= 100;
    win.dispatch('scroll', {});
    win.dispatch('pointermove', { clientX: 200, clientY: 150 });
    check('a page scroll invalidates the rects as well',
      deck.stages[0].look().join() === '0.000,0.000', deck.stages[0].look().join());

    // So must a resize, which is the other thing that moves a card without
    // anybody scrolling anything.
    deck.stages[0].rect.left += 60;
    win.dispatch('resize', {});
    win.dispatch('pointermove', { clientX: 260, clientY: 150 });
    check('a resize invalidates them too',
      deck.stages[0].look().join() === '0.000,0.000', deck.stages[0].look().join());

    stop();
  }

  // --- the constraint that made a cache necessary in the first place --------
  {
    const deck = makeDeck();
    const stop = mount(deck.root);

    for (let i = 0; i < 8; i += 1) {
      win.dispatch('pointermove', { clientX: 180 + i, clientY: 250 });
    }
    check('a run of pointer moves measures once, not once each',
      deck.stages[0].reads === 1, `${deck.stages[0].reads} measurements over 8 moves`);

    win.dispatch('scroll', {}, { bubbles: false });
    check('and a scroll on its own measures nothing until the pointer moves',
      deck.stages[0].reads === 1, `${deck.stages[0].reads} measurements`);

    win.dispatch('pointermove', { clientX: 200, clientY: 250 });
    check('the measurement happens on the move that needs it',
      deck.stages[0].reads === 2, `${deck.stages[0].reads} measurements`);

    stop();
  }

  // --- teardown -------------------------------------------------------------
  {
    const deck = makeDeck();
    const stop = mount(deck.root);
    check('mounting listens for scrolls', win.count('scroll') === 1);
    stop();
    // A capture listener removed without the capture flag is not removed at
    // all, and it holds the stages and their rects alive behind it.
    check('teardown removes every listener it added', win.listeners.length === 0,
      win.listeners.map((l) => l.type).join());
    check('and returns the eyes to centre', deck.stages[0].centred());
  }

  // --- what must keep being true -------------------------------------------
  {
    const deck = makeDeck();
    const stop = mount(deck.root);
    win.dispatch('pointermove', { clientX: 200, clientY: 250 });
    check('only the card in view tracks the pointer', deck.stages[1].centred());

    // Lite mode, the decoration switch and reduced motion each stop it, and the
    // eyes go back to centre rather than freezing where they were.
    globalThis.document.documentElement.dataset.lite = 'on';
    win.dispatch('pointermove', { clientX: 300, clientY: 250 });
    check('lite mode returns the eyes to centre', deck.stages[0].centred());
    delete globalThis.document.documentElement.dataset.lite;

    globalThis.document.documentElement.dataset.decor = 'off';
    win.dispatch('pointermove', { clientX: 300, clientY: 250 });
    check('the decoration switch does the same', deck.stages[0].centred());
    delete globalThis.document.documentElement.dataset.decor;

    reduced = true;
    win.dispatch('pointermove', { clientX: 300, clientY: 250 });
    check('so does reduced motion', deck.stages[0].centred());
    reduced = false;

    // Leaving the window is not the pointer sitting at the edge.
    win.dispatch('pointermove', { clientX: 300, clientY: 250 });
    win.dispatch('pointerleave', {});
    check('the pointer leaving returns the eyes to centre', deck.stages[0].centred());

    stop();
  }

  // --- touchscreens ---------------------------------------------------------
  {
    // No cursor to follow, and reacting to taps would make the drop lurch as
    // you scrolled past it. Nothing is listened for at all.
    hoverFine = false;
    const deck = makeDeck();
    const stop = mount(deck.root);
    check('a coarse pointer is not tracked', win.listeners.length === 0,
      win.listeners.map((l) => l.type).join());
    stop();
    hoverFine = true;
  }

  for (const k of Object.keys(env)) delete globalThis[k];
  return results;
}
