// Fixed-canvas scaling for the two plain-HTML pages: the splash (index.html)
// and the loading interstitial (loading.html).
//
// The Svelte side gets this from stage.svelte.js, but that carries the Svelte
// runtime and $state, and these two pages deliberately have no framework on
// them — they are the first paint of the piece and load before any bundle the
// visualizations need. So the same contract is reimplemented here in plain JS.
// DESIGN_W/DESIGN_H are meant to match stage.svelte.js; if one moves, move the
// other.
export const DESIGN_W = 3000;
export const DESIGN_H = 2000;

/**
 * Scale-to-fit: the smaller ratio wins, so the whole canvas always fits and the
 * leftover space letterboxes in --bg. Never clips, never scrolls.
 */
function fit() {
  const scale = Math.min(window.innerWidth / DESIGN_W, window.innerHeight / DESIGN_H);
  document.documentElement.style.setProperty('--stage-scale', scale);
  return scale;
}

/**
 * Start the fixed-canvas scaling loop.
 *
 * The page's own markup must already be wrapped in .viewport > .stage (see the
 * CSS block in each page).
 *
 * Returns a teardown, for symmetry with initStage().
 */
export function initPageStage() {
  fit();
  window.addEventListener('resize', fit);
  return () => window.removeEventListener('resize', fit);
}
