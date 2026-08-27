// Dev-only UI arrangement switch, shared like stage.svelte.js: a module-level
// $state with getter/setter, no prop drilling. The DevHud cycles it; both the
// biomes and anthromes Apps read it. Resets to Option 1 on every page load
// (no persistence).
//
// To add an arrangement: append a label to UI_OPTIONS and add the matching
// {:else if uiOption() === N} branch in biomes/App.svelte. The DevHud cycles
// through however many are listed here — nothing else needs touching.
//
// Options 1-3 are three passes over ONE arrangement, newest first. They share a
// layout, so almost every branch tests refinedLayout() rather than a literal
// number; the behaviours each pass added test narrative0821() / refined0821()
// instead. Options 4-7 are biomes-only arrangements, and the anthromes side
// reads this only to distinguish the refined layout from "everything else"
// (its pre-refinement layout).
//
// The splash (index.html) reads this too — see src/splash/. It only
// distinguishes option 1 from the rest, since the narrative splash arrived with
// the 8/21 narrative pass and everything before it shares the older screen.
export const UI_OPTIONS = [
  '8-21 narrative updates', // 1 — the 8/21 refinements plus the exhibit copy:
  //                  the splash becomes a rotating narrative, and biomes'
  //                  category labels ("Country", "Phylum") give way to full
  //                  sentences from the same voice
  'ui refinements 8/21', // 2 — the 8/14 arrangement, refined: the anthrome
  //                  filter also drives the details timeline, filter pills
  //                  toggle and stack, the timeline year marker scrubs, and
  //                  both sides' leader lines land on an underline under the
  //                  word they call out
  'ui refinements 8/14', // 3 — arced control labels on both sides; biomes
  //                  lifestyle rows led by their descriptions; anthromes
  //                  country selection drives the waffle ring, and the
  //                  details timeline is a pixel chart on equal-count time
  'Lifestyle', // 4 — Western / Non-Western country rows, ranked by % unknown;
  //                  leaves recolour white/magenta when a country is selected
  'Country', //  5 — country-first: CountryCircle picker + per-country breakdown
  'Split', //    6 — Known/Unknown and Non/Western share a row
  'Prevalence', // 7 — details on top, then Prevalence + Known/Unknown stacked
];

export const UI_OPTION_COUNT = UI_OPTIONS.length;

let option = $state(1);

export function uiOption() {
  return option;
}

// True for ALL THREE refinement passes (1 = narrative, 2 = 8/21, 3 = 8/14).
// They are one arrangement, so every layout branch that used to test
// `uiOption() === 1` tests this instead — otherwise switching to an older pass
// would drop the arced labels, the country-driven ring and the pixel timeline
// along with it.
export function refinedLayout() {
  return option <= 3;
}

// True from the 8/21 pass onward — the behaviours that pass introduced (the
// leader lines landing on a rule, the scrubbing year marker), which the
// narrative pass inherits. The 8/14 option stays available for comparison.
export function refined0821() {
  return option <= 2;
}

// True only for the narrative pass: the exhibit copy replacing biomes' category
// labels, and the rotating splash. Layout-identical to 8/21 otherwise — this is
// a copy change, so it is deliberately separable from refined0821().
export function narrative0821() {
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
