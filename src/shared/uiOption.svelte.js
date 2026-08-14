// Dev-only UI arrangement switch, shared like stage.svelte.js: a module-level
// $state with getter/setter, no prop drilling. The DevHud cycles it; both the
// biomes and anthromes Apps read it. Resets to Option 1 on every page load
// (no persistence).
//
// To add an arrangement: append a label to UI_OPTIONS and add the matching
// {:else if uiOption() === N} branch in biomes/App.svelte. The DevHud cycles
// through however many are listed here — nothing else needs touching.
//
// Options 2-5 are biomes-only arrangements; the anthromes side reads this only
// to distinguish Option 1 from "everything else" (its pre-refinement layout).
export const UI_OPTIONS = [
  'ui refinements 8/14', // 1 — arced control labels on both sides; biomes
  //                  lifestyle rows led by their descriptions; anthromes
  //                  country selection drives the waffle ring, and the
  //                  details timeline is a pixel chart on equal-count time
  'Lifestyle', // 2 — Western / Non-Western country rows, ranked by % unknown;
  //                  leaves recolour white/magenta when a country is selected
  'Country', //  3 — country-first: CountryCircle picker + per-country breakdown
  'Split', //    4 — Known/Unknown and Non/Western share a row
  'Prevalence', // 5 — details on top, then Prevalence + Known/Unknown stacked
];

export const UI_OPTION_COUNT = UI_OPTIONS.length;

let option = $state(1);

export function uiOption() {
  return option;
}

export function setUiOption(n) {
  // Wrap into 1..UI_OPTION_COUNT so callers can pass any integer.
  option = ((n - 1 + UI_OPTION_COUNT) % UI_OPTION_COUNT) + 1;
}

export function cycleUiOption() {
  setUiOption(option + 1);
}

export function uiOptionLabel(n = option) {
  return UI_OPTIONS[n - 1] ?? String(n);
}
