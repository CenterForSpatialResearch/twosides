// Default topojson profile/resolution for the map. The anthromes app switches
// this at runtime — the live value and the list of resolutions live in
// src/shared/topoProfile.svelte.js, which the DevHud cycles.
export const TOPO_PROFILE = '100km';

// Resolution profile for zoom test page (independent of main map)
export const ZOOM_PROFILE = '33km';

// Whether to use pixel-snapped boundaries (matches anthrome grid) or smooth Natural Earth boundaries.
// false = smooth boundaries from admin-boundaries/countries-110m.topojson
// true = pixel-snapped boundaries from admin-boundaries/{TOPO_PROFILE}/countries.topojson
export const USE_PIXEL_BOUNDARIES = false;
