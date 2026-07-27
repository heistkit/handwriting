/**
 * Tests for the lite-mode switch under storage that cannot be written.
 *
 * Chrome with "block all cookies", Safari private browsing, a sandboxed iframe:
 * `localStorage.setItem` throws, `getItem` keeps returning null, and neither
 * says so. lite.js already swallows both — the question is what it believes
 * afterwards.
 *
 * It believed storage. So pressing the switch applied lite mode to the page and
 * then re-read storage, found nothing, and reported "off". Pressing it again to
 * undo evaluated `isOn() ? 'off' : 'on'` with isOn() still false, and applied
 * "on" a second time. Lite mode went on, could never come off, and the control
 * insisted the whole time that it was never on — a one-way door with a label
 * that denies the door exists.
 *
 * The fix is to trust the attribute the page is actually wearing, and treat
 * storage as the durable record rather than the source of truth. flourish.js
 * already works this way, which is why its switches survive this environment.
 */

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass });
  console.log(`  ${pass ? 'ok  ' : 'FAIL'} ${name}${detail && !pass ? ` — ${detail}` : ''}`);
};

/**
 * A document root that records dataset writes, and a localStorage that refuses
 * everything the way a blocked one does.
 */
function stubEnvironment({ storage = 'blocked', reducedMotion = false } = {}) {
  const data = {};
  globalThis.document = {
    documentElement: {
      dataset: new Proxy(data, {
        deleteProperty(t, k) { delete t[k]; return true; },
      }),
    },
  };

  const store = new Map();
  globalThis.localStorage = storage === 'working'
    ? {
        getItem: (k) => (store.has(k) ? store.get(k) : null),
        setItem: (k, v) => store.set(k, v),
        removeItem: (k) => store.delete(k),
      }
    : {
        getItem() { throw new DOMException('denied'); },
        setItem() { throw new DOMException('denied'); },
        removeItem() { throw new DOMException('denied'); },
      };

  globalThis.matchMedia = () => ({ matches: reducedMotion, addEventListener() {} });
  return data;
}

export async function run() {
  console.log('\nlite.js');

  // Fresh module per case: `apply` keeps the tab's choice in module scope, and
  // these cases are about what happens across a sequence of presses.
  const load = async (tag) => import(`../src/lite.js?case=${tag}`);

  // --- the one-way door ----------------------------------------------------
  {
    const data = stubEnvironment({ storage: 'blocked' });
    const { isOn, apply } = await load('blocked');

    check('starts off', isOn() === false);

    // What the footer button does: apply(isOn() ? 'off' : 'on').
    apply(isOn() ? 'off' : 'on');
    check('pressing it turns lite mode on', data.lite === 'on', JSON.stringify(data));
    check('and the control can tell that it is on', isOn() === true);

    apply(isOn() ? 'off' : 'on');
    check('pressing it again turns lite mode off', data.lite === 'off', JSON.stringify(data));
    check('and the control agrees', isOn() === false);

    apply(isOn() ? 'off' : 'on');
    check('and it goes back on, so the door swings both ways', isOn() === true);
  }

  // --- an explicit choice is not discarded when the system changes ---------
  {
    stubEnvironment({ storage: 'blocked', reducedMotion: false });
    const { apply, chosen } = await load('chosen');

    apply('off');
    check('an explicit choice is remembered without storage',
      chosen() === 'off', String(chosen()));

    apply(null);
    check('and handing control back to the system clears it',
      chosen() === null, String(chosen()));
  }

  // --- with storage working, nothing changes -------------------------------
  {
    const data = stubEnvironment({ storage: 'working' });
    const { isOn, apply, chosen } = await load('working');

    apply('on');
    check('storage still records the choice when it can',
      globalThis.localStorage.getItem('handwrite.lite') === 'on');
    check('and the page wears it', data.lite === 'on');
    check('and isOn agrees', isOn() === true);
    check('and chosen reports it', chosen() === 'on');

    apply('off');
    check('turning it off works with storage too', isOn() === false, JSON.stringify(data));
  }

  // --- following the system when nothing was chosen ------------------------
  {
    const data = stubEnvironment({ storage: 'blocked', reducedMotion: true });
    const { isOn, apply } = await load('reduced');

    apply(null);
    check('a system asking for less motion turns lite on', isOn() === true);
    // apply() sets the attribute for this case deliberately, so the CSS can see
    // it — which is also why reading the attribute first is safe here.
    check('and the page wears it, so the stylesheet can act on it',
      data.lite === 'on', JSON.stringify(data));

    apply('off');
    check('and it can still be overridden by hand', isOn() === false);
  }

  delete globalThis.document;
  delete globalThis.localStorage;
  delete globalThis.matchMedia;
  return results;
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}`) {
  run();
}
