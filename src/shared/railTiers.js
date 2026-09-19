// Rail tiers: how the rail gives up height when the window is short.
//
// The rail is authored for a 1000 x 2000 design-px box and fits it to the
// pixel. Off that display the stage scale stops at a type floor (see
// layoutCore.js), so a laptop window leaves the rail far fewer design px than
// that, and its content has to get smaller in a fixed order:
//
//   1. the eight country circles go from two rows of four to one row of
//      eight, where the rail is wide enough (each group keeps its description)
//   2. the details block shrinks (it is the one section that flexes)
//   3. the circles step down, 150 -> 120 -> 96, and the rail's spacing tightens
//   4. the rail scrolls
//
// Which of those apply is read off ONE ordered table per side, from the rail's
// box as computeLayout() reports it — never from measuring content, so there
// is no ResizeObserver loop and a given window always lays out the same way.
// The first row whose minW and minH both hold wins; the last rows have no minH
// and are the scrolling rail. A row's minH is the measured height of its
// content at the row's own minW (narrower wraps more, so that is its tallest);
// a tier that is worth having at two widths has two rows. This table is the
// tuning surface: to change when a tier kicks in, change its row.
//
// A tier:
//   cols     4 | 8           country circles per row
//   circle   150 | 120 | 96  country circle diameter, design px
//   label    19 | 17 | 14    its label
//   ctl      118 | 96 | 76   control circle diameter (Info, Zoom, Reset)
//   caption  19 | 17 | 15    its arced caption
//   spacing  'anchor'   the pixel-fitted constants of the 1000 x 2000 rail
//            'regular'  the same rhythm, minus the constants that only hold there
//            'tight'    smaller rail padding and section gaps
//   detail   'full' | 'compact'   the details block (biomes: smaller glyph,
//            closer rows)
//   scroll   the rail scrolls; every section takes its natural height
//   keyNames anthromes: the key's category names and its "more intensive"
//            arrow. Off in the tight rows, where the key is just its pills
//   perGroup 4 | 5  countries per lifestyle group. Not a column of the table:
//            railTier() adds the fifth (Italy, Mongolia) on a large window
//            when five — or ten, in the eight-across rows — fit the rail
//   leadIn   biomes, anchor row only: the species name is pushed down level
//            with the disk marker so the leader runs dead straight. That costs
//            the rail whatever height lies between the two, and once the
//            circles go eight across it opens a hole under the section head,
//            so every other row leaves the name where it falls and lets the
//            leader bend to it.

// What the rail does with height it has to spare. `?rail=` overrides.
//   'stretch'  the details block takes all of it, so the rail always runs from
//              the top of the window to the bottom and the key sits at the foot.
//              What the 1000 x 2000 rail does, and it has nothing to spare.
//   'pack'     the details block takes only what it needs (anthromes: a
//              timeline in proportion to its width; biomes: its content), the
//              key moves up under it, and the spare is left at the foot of the
//              rail. The anchor row is exempt: it has to stay pixel-identical.
export const RAIL_FILL = 'stretch';

/** ?rail=pack|stretch — see RAIL_FILL. */
export function readFillOverride(search = '') {
  const v = new URLSearchParams(search).get('rail');
  return v === 'pack' || v === 'stretch' ? v : null;
}

const BIG = { circle: 150, label: 19 };
const MID = { circle: 120, label: 17 };
const SMALL = { circle: 96, label: 14 };
const CTL_BIG = { ctl: 118, caption: 19 };
const CTL_MID = { ctl: 96, caption: 17 };
const CTL_SMALL = { ctl: 76, caption: 15 };

const row = (minW, minH, cols, circle, ctl, spacing, detail, scroll = false) =>
  ({
    minW, minH, cols, ...circle, ...ctl, spacing, detail, scroll,
    leadIn: spacing === 'anchor', keyNames: spacing !== 'tight', perGroup: 4
  });

// minH is each row's measured fit at its minW plus ~25 design px, because the
// content is not quite constant: the key's percentages change width with the
// year and the country, and the biomes details run a line longer for some
// species. Re-measure with utilities/responsive-baseline/harness/tierfit.mjs.
// Half a design px of slack on the anchor row: the rail's box comes out of a
// division, and 2000 / 1 is the only one that lands exactly. The anchor row is
// the 1000 x 2000 rail and nothing else (ANCHOR_MAX_W): a wider rail of the
// same height has room to spare, and the rows under it know what to do with it.
const TABLES = {
  anthromes: [
    row(999.5, 1999.5, 4, BIG,   CTL_BIG,   'anchor',  'full'),
    row(1000,  1680,   4, BIG,   CTL_BIG,   'regular', 'full'),
    row(772,   1915,   4, BIG,   CTL_BIG,   'regular', 'full'),
    row(1434,  1270,   8, BIG,   CTL_BIG,   'regular', 'full'),
    row(1194,  1305,   8, MID,   CTL_BIG,   'regular', 'full'),
    row(1002,  1070,   8, SMALL, CTL_BIG,   'tight',   'compact'),
    row(700,   1510,   4, MID,   CTL_BIG,   'tight',   'compact'),
    row(700,   1430,   4, SMALL, CTL_MID,   'tight',   'compact'),
    row(560,   1490,   4, SMALL, CTL_SMALL, 'tight',   'compact'),
    row(700,   0,      4, SMALL, CTL_MID,   'tight',   'compact', true),
    row(0,     0,      4, SMALL, CTL_SMALL, 'tight',   'compact', true)
  ],
  biomes: [
    row(999.5, 1999.5, 4, BIG,   CTL_BIG,   'anchor',  'full'),
    row(1400,  1860,   4, BIG,   CTL_BIG,   'regular', 'full'),
    row(1250,  1940,   4, BIG,   CTL_BIG,   'regular', 'full'),
    row(1000,  1990,   4, BIG,   CTL_BIG,   'regular', 'full'),
    row(1434,  1605,   8, BIG,   CTL_BIG,   'regular', 'full'),
    row(1000,  1875,   4, BIG,   CTL_BIG,   'regular', 'compact'),
    row(1434,  1490,   8, BIG,   CTL_BIG,   'regular', 'compact'),
    row(1300,  1390,   8, MID,   CTL_BIG,   'tight',   'compact'),
    row(1194,  1435,   8, MID,   CTL_BIG,   'tight',   'compact'),
    row(1100,  1410,   8, SMALL, CTL_BIG,   'tight',   'compact'),
    row(1002,  1475,   8, SMALL, CTL_BIG,   'tight',   'compact'),
    row(700,   1985,   4, MID,   CTL_BIG,   'tight',   'compact'),
    row(700,   0,      4, SMALL, CTL_MID,   'tight',   'compact', true),
    row(0,     0,      4, SMALL, CTL_SMALL, 'tight',   'compact', true)
  ]
};

/**
 * The tier for one side's rail.
 *   side          'anthromes' | 'biomes'
 *   railW, railH  the rail's box in design px (layout.railW / layout.railH)
 *   force         a row index, to look at one tier at any window size (?tier=)
 */
const ANCHOR_MAX_W = 1000.5;

// Rail geometry the fifth-country test needs; keep in step with the CSS: the
// rail's side padding (rail.css --rail-pad), the content cap, the gap between
// circles (the wider of the two sides') and between the two groups.
const RAIL_PAD_X = { anchor: 122, regular: 122, tight: 72 };
const CONTENT_MAX_W = 1500;
const CIRCLE_GAP = 16;
const GROUP_GAP = 44;

function fitsFive(r, railW) {
  const content = Math.min(CONTENT_MAX_W, railW - RAIL_PAD_X[r.spacing]);
  const need = r.cols === 8
    ? 10 * r.circle + 8 * CIRCLE_GAP + GROUP_GAP
    : 5 * r.circle + 4 * CIRCLE_GAP;
  return content >= need;
}

/**
 * opts.large  the window is a large one (layout.large)
 * opts.five   true / false forces the fifth country on or off (?five=)
 */
export function railTier(side, railW, railH, force = null, opts = {}) {
  let table = TABLES[side];
  let r;
  if (force != null && table[force]) r = table[force];
  else {
    if (railW > ANCHOR_MAX_W) table = table.slice(1);
    // No height to test against (the stacked layout's rail is as tall as its
    // content): the widest-fitting row that does not scroll.
    const h = railH ?? Infinity;
    r = table.find((t) => railW >= t.minW && h >= t.minH) ?? table[table.length - 1];
  }
  // The anchor rail never grows a fifth country: it has to stay what it was.
  const want = opts.five ?? opts.large;
  if (!want || r.spacing === 'anchor' || !fitsFive(r, railW)) return r;
  return { ...r, perGroup: 5 };
}

/** ?five=1|0 — force the fifth country on or off, whatever the window. */
export function readFiveOverride(search = '') {
  const v = new URLSearchParams(search).get('five');
  return v === '1' ? true : v === '0' ? false : undefined;
}

/** ?tier=<row index> — see railTier(). */
export function readTierOverride(search = '') {
  const v = new URLSearchParams(search).get('tier');
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 ? n : null;
}
