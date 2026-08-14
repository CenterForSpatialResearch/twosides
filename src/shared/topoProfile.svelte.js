// Map tile resolution, shared like uiOption.svelte.js: a module-level $state
// with getter/setter, no prop drilling. The DevHud cycles it and the anthromes
// settings panel also binds to it, so the two stay in sync. Resets to the
// default on every page load (no persistence).
//
// 33km is roughly 9x the cells of 100km: ~25MB per year against ~2.5MB, and a
// 166MB cell history against 18MB. It is deliberately NOT in the repo — those
// files live in the gitignored temp/ folder and are served in dev by the
// serve-temp-assets plugin in vite.config.js. Without that folder the 33km
// option 404s and the map stays blank.
export const TOPO_PROFILES = ['100km', '33km'];

export const DEFAULT_TOPO_PROFILE = '100km';

let profile = $state(DEFAULT_TOPO_PROFILE);

export function topoProfile() {
  return profile;
}

export function setTopoProfile(next) {
  if (TOPO_PROFILES.includes(next)) profile = next;
}

export function cycleTopoProfile() {
  const i = TOPO_PROFILES.indexOf(profile);
  profile = TOPO_PROFILES[(i + 1) % TOPO_PROFILES.length];
}
