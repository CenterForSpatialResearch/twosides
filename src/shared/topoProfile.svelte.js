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
export const TOPO_PROFILES = ['100km', '75km', '50km', '33km', '25km', '10km'];

export const DEFAULT_TOPO_PROFILE = '100km';

// One-time download for the full series, per profile. Cell count scales with
// 1/res², so 10km is ~100x the cells of 100km.
export const TEMP_TOPO_PROFILES = {
  '100km': { total: '2.1MB', cells: '22K' },
  '75km': { total: '3.1MB', cells: '38K' },
  '50km': { total: '6.3MB', cells: '83K' },
  '33km': { total: '14MB', cells: '183K' },
  '25km': { total: '25MB', cells: '320K' },
  '10km': { total: '164MB', cells: '2.2M' }
};

export function isTempProfile(p) {
  return Object.hasOwn(TEMP_TOPO_PROFILES, p);
}

// "33km is 183K cells, 14MB for all 76 years" — used by both the DevHud tooltip
// and the settings-panel tip so they can't drift apart.
export function tempProfileSizes(p) {
  const s = TEMP_TOPO_PROFILES[p];
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
