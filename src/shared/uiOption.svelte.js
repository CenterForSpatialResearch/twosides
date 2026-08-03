// Dev-only UI arrangement switch, shared like stage.svelte.js: a module-level
// $state with getter/setter, no prop drilling. The DevHud toggles it; only the
// biomes App reads it. Resets to Option 2 on every page load (no persistence).
// Option 2 is the country-first layout that hosts the CountryCircle picker.
let option = $state(2);

export function uiOption() {
  return option;
}

export function setUiOption(n) {
  option = n;
}
