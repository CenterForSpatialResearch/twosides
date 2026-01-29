// Central place to pick the topojson profile/resolution for the map.
export const TOPO_PROFILE = '33km';

// Whether to use pixel-snapped boundaries (matches anthrome grid) or smooth Natural Earth boundaries.
// false = smooth boundaries from admin-boundaries/countries-110m.topojson
// true = pixel-snapped boundaries from admin-boundaries/{TOPO_PROFILE}/countries.topojson
export const USE_PIXEL_BOUNDARIES = false;
