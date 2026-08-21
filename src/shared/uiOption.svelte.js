// Dev-only UI arrangement switch, shared like stage.svelte.js: a module-level
// $state with getter/setter, no prop drilling. The DevHud cycles it; both the
// biomes and anthromes Apps read it. Resets to Option 1 on every page load
// (no persistence).
//
// To add an arrangement: append a label to UI_OPTIONS and add the matching
// {:else if uiOption() === N} branch in biomes/App.svelte. The DevHud cycles
// through however many are listed here — nothing else needs touching.
//
// Options 1-2 are the two "ui refinements" passes: one arrangement, refined
// twice. They share a layout, so almost every branch tests refinedLayout()
// rather than a literal number; only the behaviours introduced by the 8/21
// pass test refined0821(). Options 3-6 are biomes-only arrangements, and the
// anthromes side reads this only to distinguish the refined layout from
// "everything else" (its pre-refinement layout).
export const UI_OPTIONS = [
  'ui refinements 8/21', // 1 — the 8/14 arrangement, refined: the anthrome
  //                  filter also drives the details timeline, filter pills
  //                  toggle and stack, the timeline year marker scrubs, and
  //                  both sides' leader lines land on an underline under the
  //                  word they call out
  'ui refinements 8/14', // 2 — arced control labels on both sides; biomes
  //                  lifestyle rows led by their descriptions; anthromes
  //                  country selection drives the waffle ring, and the
  //                  details timeline is a pixel chart on equal-count time
  'Lifestyle', // 3 — Western / Non-Western country rows, ranked by % unknown;
  //                  leaves recolour white/magenta when a country is selected
  'Country', //  4 — country-first: CountryCircle picker + per-country breakdown
  'Split', //    5 — Known/Unknown and Non/Western share a row
  'Prevalence', // 6 — details on top, then Prevalence + Known/Unknown stacked
];

export const UI_OPTION_COUNT = UI_OPTIONS.length;

let option = $state(1);

export function uiOption() {
  return option;
}

// True for BOTH refinement passes (1 = 8/21, 2 = 8/14). They are one
// arrangement, so every layout branch that used to test `uiOption() === 1`
// tests this instead — otherwise switching to the 8/14 pass would drop the
// arced labels, the country-driven ring and the pixel timeline along with it.
export function refinedLayout() {
  return option <= 2;
}

// True only for the 8/21 pass — the behaviours that pass introduced, so the
// 8/14 option stays available for side-by-side comparison.
export function refined0821() {
  return option === 1;
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
