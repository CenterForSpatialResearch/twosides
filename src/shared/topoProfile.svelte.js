// Map tile resolution, shared like uiOption.svelte.js: a module-level $state
// with getter/setter, no prop drilling. The DevHud cycles it and the anthromes
// settings panel also binds to it, so the two stay in sync. Resets to the
// default on every page load (no persistence).
//
// Map tile resolution, coarse to fine. All of these are served from the
// gitignored temp/grid/ folder by the serve-temp-assets plugin in
// vite.config.js; without that folder the option 404s and the map stays blank.
//
// These now use the grid format (see lib/gridSource.js), which ships the whole
// 76-year series as one blob per profile instead of a TopoJSON per year. The
// entire set is ~214MB against 1.8GB for the 33km TopoJSON alone, and switching
// years costs no network at all.
// Limited to the 50-100km band: below 50km the per-frame cost of projecting and
// filling every cell stops being interactive, and the finer profiles were only
// ever there to prove the format scales. 33km/25km/10km can still be generated
// (processing/run_grid_profiles.sh) and are served from temp/ in dev — they just
// aren't offered in the picker.
//
// All five ship in public/grid/ (Git LFS), 18MB total, so the deployed build and
// a local dev server behave identically.
export const TOPO_PROFILES = ['100km', '75km', '70km', '60km', '50km'];

// 70km is the exhibition resolution. 60km is visibly finer, but it is 58,604
// land cells against 70km's 43,598 — a 34% jump in the per-frame cost of
// projecting and filling every cell, and that is enough to take the
// interaction below comfortable. There is no separate load path per profile:
// every one in the picker goes through loadGrid/featuresForYear, so the whole
// difference between them is cell count.
export const DEFAULT_TOPO_PROFILE = '70km';

// One-time download for the full 76-year series, per profile — after which
// changing years costs no network at all. Cell count scales with 1/res², so
// 50km is ~4x the cells of 100km.
export const PROFILE_INFO = {
  '100km': { total: '1.6MB', cells: '22K' },
  '75km': { total: '2.8MB', cells: '38K' },
  '70km': { total: '3.2MB', cells: '44K' },
  '60km': { total: '4.3MB', cells: '59K' },
  '50km': { total: '6.1MB', cells: '83K' }
};

export function hasProfileInfo(p) {
  return Object.hasOwn(PROFILE_INFO, p);
}

// "50km is 83K cells, 6.1MB for all 76 years" — used by both the DevHud tooltip
// and the settings-panel tip so they can't drift apart.
export function profileSizes(p) {
  const s = PROFILE_INFO[p];
  return s ? `${p} is ${s.cells} cells, ${s.total} for all 76 years` : '';
}

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
