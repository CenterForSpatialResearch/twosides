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

function fit() {
  const L = insetLayout(window.innerWidth, window.innerHeight, overrides.margin, computeSplashLayout);
  applyLayoutVars(L);
  return L;
}

/**
 * Start the stage scaling loop.
 *
 * The page's own markup must already be wrapped in .viewport > .stage (see
 * stage.css).
 *
 * Returns a teardown, for symmetry with initStage().
 */
export function initPageStage() {
  fit();
  window.addEventListener('resize', fit);
  return () => window.removeEventListener('resize', fit);
}
