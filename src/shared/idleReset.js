// Attract-loop guard for the exhibition build: after IDLE_MS with no input the
// page navigates back to the splash, so a visitor who walks away never strands
// the next one in someone else's reading.
//
// Plain JS, no runes, so the two non-Svelte pages (index.html, loading.html)
// could adopt it without pulling in the Svelte runtime. Neither needs it today
// — the splash IS home and already rotates as its own attract loop, and the
// interstitial self-navigates after 5s — but the contract stays portable.

export const IDLE_MS = 30000;
export const WARN_MS = 3000;

// pointermove fires on every frame of a drag; rebuilding both timers that often
// is pure waste. One reset per second is far finer than the 30s it guards.
const THROTTLE_MS = 1000;

// Capture phase is REQUIRED, not a preference. Several handlers in both apps
// call stopPropagation() on their own container (the detail dock, the rail, the
// info modal, the chart), so a bubble-phase listener on window would never see
// those interactions and would time out under an actively reading visitor.
const EVENTS = ['pointerdown', 'pointermove', 'wheel', 'keydown', 'touchstart'];
const LISTENER_OPTS = { capture: true, passive: true };

/**
 * Start the idle watch.
 *
 * @param {object}   opts
 * @param {string}   opts.homeHref  where to send an idle visitor (the splash).
 * @param {Function} opts.onWarn    called WARN_MS before the navigation.
 * @param {Function} opts.onCancel  called when input arrives during the warning.
 * @returns {Function} teardown
 */
export function initIdleReset({ homeHref, onWarn, onCancel }) {
  // ?idle=0 switches the timeout off, so it can be disabled on-site for
  // debugging without a rebuild.
  if (new URLSearchParams(window.location.search).get('idle') === '0') {
    return () => {};
  }

  let warnTimer = null;
  let fireTimer = null;
  let warning = false;
  let lastReset = 0;
  let stopped = false;

  function clear() {
    clearTimeout(warnTimer);
    clearTimeout(fireTimer);
    warnTimer = null;
    fireTimer = null;
  }

  function arm() {
    clear();
    warnTimer = setTimeout(() => {
      warning = true;
      onWarn?.();
    }, IDLE_MS - WARN_MS);
    fireTimer = setTimeout(() => {
      stopped = true;
      clear();
      // replace, not assign: otherwise every idle bounce stacks a history entry
      // and the splash's own back-returns-here behaviour stops meaning anything.
      window.location.replace(homeHref);
    }, IDLE_MS);
  }

  function onActivity() {
    if (stopped) return;
    const now = Date.now();
    // The warning must always cancel on the first input, throttle or not — a
    // visitor who moves the mouse should never watch the overlay linger.
    if (!warning && now - lastReset < THROTTLE_MS) return;
    lastReset = now;
    if (warning) {
      warning = false;
      onCancel?.();
    }
    arm();
  }

  for (const type of EVENTS) {
    window.addEventListener(type, onActivity, LISTENER_OPTS);
  }
  arm();

  return () => {
    stopped = true;
    clear();
    for (const type of EVENTS) {
      window.removeEventListener(type, onActivity, LISTENER_OPTS);
    }
  };
}
