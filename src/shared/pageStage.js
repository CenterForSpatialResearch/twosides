// Stage scaling for the two plain-HTML pages: the splash (index.html) and the
// loading interstitial (loading.html).
//
// The Svelte side gets this from stage.svelte.js, but that carries the Svelte
// runtime and $state, and these two pages deliberately have no framework on
// them — they are the first paint of the piece and load before any bundle the
// visualizations need. Both are thin wrappers over layoutCore.js, which holds
// the numbers.
import {
  DESIGN_W, DESIGN_H, computeSplashLayout, applyLayoutVars, loadOverrides, insetLayout
} from './layoutCore.js';

export { DESIGN_W, DESIGN_H };

// Only the safe margin applies here (?margin=, see layoutCore.js); loading it
// on these pages too is also what lets an exhibition set it on the splash URL.
const overrides = loadOverrides();

let last = null;
const listeners = new Set();

function fit() {
  const L = insetLayout(window.innerWidth, window.innerHeight, overrides.margin, computeSplashLayout);
  const flipped = last && last.compact !== L.compact;
  last = L;
  applyLayoutVars(L);
  if (flipped) for (const fn of listeners) fn(splashVariant());
  return L;
}

/** 'compact' | 'full': which type scale the page should set itself in
    (splashType() in splashCopy.js). Compact is a portrait window, or any
    window small enough to need it (computeSplashLayout() in layoutCore.js). */
export function splashVariant() {
  return last?.compact ? 'compact' : 'full';
}

/**
 * Start the stage scaling loop.
 *
 * The page's own markup must already be wrapped in .viewport > .stage (see
 * stage.css).
 *
 * onVariantChange(variant) is called when a resize (a phone turning) crosses
 * between the two, so the page can re-set its type.
 *
 * Returns a teardown, for symmetry with initStage().
 */
export function initPageStage({ onVariantChange } = {}) {
  if (onVariantChange) listeners.add(onVariantChange);
  fit();
  window.addEventListener('resize', fit);
  return () => {
    window.removeEventListener('resize', fit);
    if (onVariantChange) listeners.delete(onVariantChange);
  };
}
