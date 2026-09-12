// How many rows of cells a column of the details timeline is cut into — shared
// like topoProfile.svelte.js and countrySet.svelte.js: a module-level $state
// with a getter and a cycler, no prop drilling. The DevHud cycles it. Resets to
// the default on every page load.
//
// Mode 1 gives every country the same number of rows, chosen so the cells
// resolve square. That reads well and makes any two countries directly
// comparable, but it is not honest about area: at 70km resolution Puerto Rico
// is about six land cells, and drawing it with the same ~23 rows as the whole
// world implies a resolution the data does not have.
//
// Mode 2 is the honest version — one row per land cell, so a column is as tall
// in cells as the place is large. Small countries become a handful of thick
// bands and the world becomes a continuous gradient (see PixelTimeline's
// banding threshold, which stops it emitting 43,598 sub-pixel rects).
//
// Mode 3 is mode 2 with mode 1's row count as a ceiling, so anything at or
// under that count reads honestly and anything larger still resolves square.
export const TIMELINE_MODES = [1, 2, 3];

// Mode 1 is what the piece has always drawn, and stays the default so the
// committed build renders as it did before this became switchable.
export const DEFAULT_TIMELINE_MODE = 1;

export const TIMELINE_MODE_INFO = {
  1: { label: 'Equal cells', note: 'same row count everywhere; cells resolve square' },
  2: { label: 'Cells match land area', note: 'one row per land cell at 70km' },
  3: { label: 'Land area, capped', note: 'one row per land cell, capped at mode 1' }
};

export function timelineModeLabel(mode) {
  const m = TIMELINE_MODE_INFO[mode];
  return m ? `${m.label} — ${m.note}` : String(mode);
}

let current = $state(DEFAULT_TIMELINE_MODE);

export function timelineMode() {
  return current;
}

export function setTimelineMode(next) {
  if (TIMELINE_MODES.includes(next)) current = next;
}

export function cycleTimelineMode() {
  const i = TIMELINE_MODES.indexOf(current);
  current = TIMELINE_MODES[(i + 1) % TIMELINE_MODES.length];
}
