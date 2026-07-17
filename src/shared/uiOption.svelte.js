// Dev-only UI arrangement switch, shared like stage.svelte.js: a module-level
// $state with getter/setter, no prop drilling. The DevHud toggles it; only the
// biomes App reads it. Resets to Option 1 on every page load (no persistence).
let option = $state(1);

export function uiOption() {
  return option;
}

export function setUiOption(n) {
  option = n;
}
