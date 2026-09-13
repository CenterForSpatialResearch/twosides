// How many ABC Pelikan cuts the piece draws with — shared like
// timelineMode.svelte.js: a module-level $state with a getter and a cycler, no
// prop drilling. The DevHud cycles it. Resets to two on every page load.
//
// 2: Regular and Bold only, the cheaper licence — the default. Everything set
//    at 500 draws Regular, so body and labels become one weight and only the
//    headlines stand apart — except the anthrome and phylum keys, which draw
//    Regular with a 0.7px outline as a stand-in for Medium (see styles.css).
// 3: Regular, Medium and Bold — 400 read, 500 touch, 700 headlines.
//
// The switch itself is CSS: styles.css defines both families, uses the
// two-weight one unless <html> carries data-font-weights="3", so this only has
// to set that attribute.
export const FONT_WEIGHT_MODES = [2, 3];

export const DEFAULT_FONT_WEIGHTS = 2;

export const FONT_WEIGHT_INFO = {
  3: 'three weights',
  2: 'two weights'
};

let current = $state(DEFAULT_FONT_WEIGHTS);

export function fontWeights() {
  return current;
}

export function cycleFontWeights() {
  const i = FONT_WEIGHT_MODES.indexOf(current);
  current = FONT_WEIGHT_MODES[(i + 1) % FONT_WEIGHT_MODES.length];
  document.documentElement.dataset.fontWeights = String(current);
}
