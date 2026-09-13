// Dev-only UI arrangement switch, shared like stage.svelte.js: a module-level
// $state with getter/setter, no prop drilling. The DevHud cycles it; both the
// biomes and anthromes Apps read it. Resets to Option 1 on every page load
// (no persistence).
//
// To add a biomes-only arrangement: append a label to UI_OPTIONS and add the
// matching {:else if uiOption() === N} branch in biomes/App.svelte. The DevHud
// cycles through however many are listed here — nothing else needs touching.
//
// To add a new refinement PASS: prepend it instead, so newest stays first and
// stays the page-load default. That shifts every option down by one, so bump
// the thresholds below and +1 every literal in biomes/App.svelte (there
// are seven) plus the splash test in index.html. Anthromes carries no literals
// — it reads only the predicates — which is what keeps this cheap.
//
// Options 1-3 are splash trials (splash-1/2/3): three alternative sequences for
// the rotating splash, prepended in front of the final ui so they can be
// compared on the dev server. Everywhere except the splash they ARE the final
// ui — every predicate below widens to cover them — and splashVariant() is the
// only thing that tells them apart. Once one is picked it replaces the final
// ui's splash and these three go away, which unshifts every number by three.
//
// Options 4-8 are five passes over ONE arrangement, newest first. They share a
// layout, so almost every branch tests refinedLayout() rather than a literal
// number; the behaviours each pass added test finalUi() / countryFromMap() /
// narrative0821() / refined0821() instead. Options 9-12 are biomes-only arrangements, and the
// anthromes side reads this only to distinguish the refined layout from
// "everything else" (its pre-refinement layout).
//
// The splash (index.html) reads this too — see src/splash/. It only
// distinguishes the narrative options from the rest, since the narrative splash
// arrived with the 8/21 narrative pass and everything before it shares the
// older screen.
export const UI_OPTIONS = [
  'splash-1', // 1 — final ui; splash framing lines top then bottom (half a
  //                  turn each) on the title ring, then one turn of
  //                  "Biomes organize…" / "Anthromes organize…"
  'splash-2', // 2 — as splash-1, with a turn of "Biomes begin…" /
  //                  "Anthromes begin…" before the "organize" turn
  'splash-3', // 3 — final ui; one turn with the framing lines set in the
  //                  titles' place, then the titles return with "organize…"
  'final ui', // 4 — the country-from-map pass with the final copy: the
  //                  lifestyle split is named Westernized / Non-Westernized
  //                  everywhere (info panel, row titles), as it is on the
  //                  species stat line
  'country from map', // 5 — the narrative pass, with the map's click target
  //                  changed from the pixel to the country: touching anywhere
  //                  on land selects that cell's country, the same end state as
  //                  clicking a country circle, and every country has a waffle
  //                  and a pixel chart rather than only the eight primaries
  '8-21 narrative updates', // 6 — the 8/21 refinements plus the exhibit copy:
  //                  the splash becomes a rotating narrative, and biomes'
  //                  category labels ("Country", "Phylum") give way to full
  //                  sentences from the same voice
  'ui refinements 8/21', // 7 — the 8/14 arrangement, refined: the anthrome
  //                  filter also drives the details timeline, filter pills
  //                  toggle and stack, the timeline year marker scrubs, and
  //                  both sides' leader lines land on an underline under the
  //                  word they call out
  'ui refinements 8/14', // 8 — arced control labels on both sides; biomes
  //                  lifestyle rows led by their descriptions; anthromes
  //                  country selection drives the waffle ring, and the
  //                  details timeline is a pixel chart on equal-count time
  'Lifestyle', // 9 — Western / Non-Western country rows, ranked by % unknown;
  //                  leaves recolour white/magenta when a country is selected
  'Country', // 10 — country-first: CountryCircle picker + per-country breakdown
  'Split', //   11 — Known/Unknown and Non/Western share a row
  'Prevalence', // 12 — details on top, then Prevalence + Known/Unknown stacked
];

export const UI_OPTION_COUNT = UI_OPTIONS.length;

let option = $state(1);

export function uiOption() {
  return option;
}

// True for ALL FIVE refinement passes and the splash trials in front of them
// (1-3 = splash trials, 4 = final ui, 5 = country-from-map, 6 = narrative,
// 7 = 8/21, 8 = 8/14). They are one arrangement, so every layout
// branch that used to test `uiOption() === 1` tests this instead — otherwise
// switching to an older pass would drop the arced labels, the country-driven
// ring and the pixel timeline along with it.
export function refinedLayout() {
  return option <= 8;
}

// True from the 8/21 pass onward — the behaviours that pass introduced (the
// leader lines landing on a rule, the scrubbing year marker), which the
// narrative pass inherits. The 8/14 option stays available for comparison.
export function refined0821() {
  return option <= 7;
}

// True for the narrative pass and everything newer: the exhibit copy replacing
// biomes' category labels, and the rotating splash. Layout-identical to 8/21
// otherwise — this is a copy change, so it is deliberately separable from
// refined0821(). It widens like the other two rather than pinning to a single
// option; left at `=== 1` the country-from-map pass would silently lose the
// exhibit copy and land on the classic splash, with nothing to signal it.
export function narrative0821() {
  return option <= 6;
}

// True from the country-from-map pass onward: a click on the MAP selects the
// clicked cell's country instead of isolating that pixel, reaching the same
// state a country circle does. Layout-identical to the narrative pass otherwise
// — this is an interaction change, so it is separable from narrative0821().
export function countryFromMap() {
  return option <= 5;
}

// True for the newest pass (and the splash trials, which are that pass with a
// different splash): the final copy. Identical to country-from-map
// otherwise — this is a wording change (Westernized / Non-Westernized for the
// lifestyle split, matching the species stat line), so it is separable from
// countryFromMap().
export function finalUi() {
  return option <= 4;
}

// Which splash trial is selected: 1, 2 or 3 for options splash-1/2/3, and 0
// for everything else (the final ui's own sequence). Read only by the splash.
export function splashVariant() {
  return option <= 3 ? option : 0;
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
