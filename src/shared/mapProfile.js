// Map tile resolution, pinned for the exhibition build.
//
// The resolution used to be switchable at runtime (a dev-HUD cycle and a
// settings-panel picker over ['100km','75km','70km','60km','50km']). Both of
// those surfaces are gone here, so the value is a constant — named rather than
// sprinkled as a literal, since it appears in the grid fetch, the map draw and
// the ring's country distribution and all three must agree.
//
// 70km is the exhibition resolution. 60km is visibly finer, but it is 58,604
// land cells against 70km's 43,598 — a 34% jump in the per-frame cost of
// projecting and filling every cell, and that is enough to take the interaction
// below comfortable.
//
// This is a GRID profile (see lib/gridSource.js): the whole 76-year series
// ships as one blob, so switching years costs no network at all. It lives in
// public/grid/ (Git LFS), which is why the per-year TopoJSON path in
// MapCanvas.loadYearData never fires — see the note there.
export const MAP_PROFILE = '70km';
