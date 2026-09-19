// Layout core: the one place that turns a window size into the piece's layout.
//
// Plain JS with no framework on it, because four pages share it: the two
// Svelte apps (through stage.svelte.js) and the two plain-HTML pages, the
// splash and the loading interstitial (through pageStage.js).
//
// Everything is authored in design px against a DESIGN_W x DESIGN_H canvas and
// .stage carries exactly one transform: scale(). What this module decides is
// that scale, the design-px size of the stage under it, and how much of the
// stage the disk takes. Nothing outside it should look at window dimensions to
// size UI; read the result instead (the `layout` object in stage.svelte.js, or
// the CSS variables applyLayoutVars() writes).
//
// Modes:
//   letterbox  the fixed 3000x2000 canvas, scaled to fit and centred, leftover
//              space in --bg. How the exhibition build ran on every display.
//   wide       the stage fills the window. Two scales: the disk column shrinks
//              with the window (diskScale) while the stage transform — which is
//              what sizes the rail's type — stops at a floor (railScale), so
//              body copy never renders under MIN_BODY_CSS_PX. Where the disk
//              sits across the window is DISK_ANCHOR's call (below); the rail
//              runs from the window's edge to the disk. At 3000x2000 both
//              scales are 1 and the result is the letterbox canvas exactly.
//   stacked    portrait and narrow windows: disk on top at full width, rail
//              under it, the page scrolls.

export const DESIGN_W = 3000;
export const DESIGN_H = 2000;
/** The disk column's side at scale 1, in design px. */
export const DISK = 2000;
/** Rail body copy, in design px. */
export const BODY_PX = 17;
/** The type floor: body copy never renders smaller than this many CSS px.
    `?minBody=` overrides it; 0 turns the floor off (pure proportional scaling,
    for wall displays read from a distance). */
export const MIN_BODY_CSS_PX = 11.5;
/** Narrowest rail the wide layout will accept, in design px. */
export const RAIL_MIN_W = 560;
/** Stacked below this window width, whatever the aspect. */
export const STACKED_MAX_W = 700;
/** Stacked mode's scale ceiling (tablets in portrait). */
export const STACKED_MAX_SCALE = 0.85;
/** Stacked mode lays the stage out this many design px wide on a phone. */
export const STACKED_DESIGN_W = 580;
/** Where the wide layout puts the disk across the window. `?disk=` overrides.
 *    'canvas'  where the exhibition build had it: on a 3000x2000 canvas scaled
 *              to fit and centred in the window. The seam between rail and disk
 *              stays put; a window wider than 3:2 leaves an empty margin beyond
 *              the disk, and the rail grows outward by the same amount.
 *    'edge'    hard against the window's far edge, so the rail takes every px
 *              the disk leaves. Widest rail, no empty margin. */
export const DISK_ANCHOR = 'canvas';
/** A "large" window: from here up the country menu shows a fifth country per
    group. There is no asking a browser for inches, so this is CSS px of window
    width: a 27" display runs 2560 wide (QHD, or 4K/5K at its default scaling),
    while a 24" tops out at 1920-2240 and the largest laptops near 1730. */
export const LARGE_MIN_W = 2400;
/** Hysteresis: once stacked, return to wide only above this aspect, so a
    mobile browser's address bar sliding away does not flip the mode. */
const STACKED_EXIT_ASPECT = 1.1;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/**
 * Read the layout overrides off a query string.
 *   ?minBody=<css px>                  type floor; 0 = none
 *   ?layout=wide|stacked|letterbox     force a mode
 *   ?disk=canvas|edge                  see DISK_ANCHOR
 *   ?margin=<percent>                  safe margin, see MAX_MARGIN_PCT
 */
export function readOverrides(search = '') {
  const params = new URLSearchParams(search);
  const out = {};
  if (params.has('minBody')) {
    const v = Number(params.get('minBody'));
    if (Number.isFinite(v) && v >= 0) out.minBody = v;
  }
  const mode = params.get('layout');
  if (mode === 'wide' || mode === 'stacked' || mode === 'letterbox') out.layout = mode;
  const disk = params.get('disk');
  if (disk === 'canvas' || disk === 'edge') out.diskAnchor = disk;
  if (params.has('margin')) {
    const v = Number(params.get('margin'));
    if (Number.isFinite(v) && v >= 0) out.margin = Math.min(v, MAX_MARGIN_PCT) / 100;
  }
  return out;
}

/** The safe margin: `?margin=<percent>` keeps the whole piece that far inside
    every edge of the window, as a share of the window's width (left, right)
    and height (top, bottom). For TVs and very large displays, where content
    run to the glass reads as cramped and a TV may overscan; broadcast's
    title-safe area is 5% a side on 16:9 (10% on the old 4:3 standard), and
    the TV platforms' app guidelines land on 5% too. 0 on a desk monitor. */
export const MAX_MARGIN_PCT = 20;

// The overrides that describe the DISPLAY (not a debugging view) have to
// outlive a page: the piece is four pages, and the links between them carry
// no query string. They are kept for the tab's session, so an exhibition sets
// them once, on whichever URL it opens — `?margin=5&minBody=0` — and
// `?margin=0` clears one. sessionStorage, not localStorage, so nothing sticks
// to a machine past the tab.
const STICKY = ['minBody', 'margin'];
const STORE_KEY = 'twosides.display';

/** readOverrides() for the live page, with the sticky ones remembered. */
export function loadOverrides() {
  const fromUrl = readOverrides(globalThis.location?.search);
  let stored = {};
  try {
    stored = JSON.parse(sessionStorage.getItem(STORE_KEY) || '{}') || {};
  } catch { /* no storage: the URL alone decides */ }
  const out = { ...fromUrl };
  const keep = {};
  for (const k of STICKY) {
    const v = fromUrl[k] ?? stored[k];
    if (typeof v === 'number' && Number.isFinite(v)) { out[k] = v; keep[k] = v; }
  }
  try { sessionStorage.setItem(STORE_KEY, JSON.stringify(keep)); } catch { /* as above */ }
  return out;
}

/**
 * Lay out inside the safe margin: `fn(w, h)` is computeLayout or
 * computeSplashLayout, handed the window less the margin, and the stage is
 * moved in by the margin.
 */
export function insetLayout(w, h, margin, fn) {
  const m = margin || 0;
  const L = fn(w * (1 - 2 * m), h * (1 - 2 * m));
  return m ? { ...L, offsetX: L.offsetX + w * m, offsetY: L.offsetY + h * m } : L;
}

function pickMode(w, h, opts) {
  if (opts.layout) return opts.layout;
  const aspect = w / h;
  if (w < STACKED_MAX_W || aspect < 1) return 'stacked';
  if (opts.prevMode === 'stacked' && aspect < STACKED_EXIT_ASPECT) return 'stacked';
  return 'wide';
}

/** The letterboxed canvas, centred in the window. */
function centred(w, h, scale) {
  return { offsetX: (w - DESIGN_W * scale) / 2, offsetY: (h - DESIGN_H * scale) / 2 };
}

/** NavCircle shrinks with the disk so it stays clear of the year ring. */
function navScaleFor(diskSize) {
  return clamp((0.245 * diskSize - 20) / 336, 0.6, 1);
}

/**
 * Window size -> layout for the two visualizations.
 *
 * opts: { minBody, layout, diskAnchor, prevMode } — the first three as
 * readOverrides() returns them, prevMode the mode of the previous result (for
 * hysteresis).
 *
 * Returns, all in design px unless noted:
 *   mode                 'letterbox' | 'wide' | 'stacked'
 *   scale                the stage transform (= railScale)
 *   diskScale, railScale the two scales (CSS px per design px)
 *   designW, designH     the stage's size under the transform
 *   diskSize             the disk column's side
 *   diskMargin           empty column beyond the disk, on the side away from
 *                        the rail (0 unless DISK_ANCHOR is 'canvas')
 *   railW, railH         the rail's box
 *   navScale             NavCircle's own scale, 0.6-1
 *   large                the window is LARGE_MIN_W or wider
 *   offsetX, offsetY     where the stage's top-left corner sits in the window,
 *                        in CSS px: 0 when the stage fills it, half the
 *                        leftover when it is letterboxed
 */
export function computeLayout(w, h, opts = {}) {
  const mode = pickMode(w, h, opts);

  if (mode === 'letterbox') {
    const scale = Math.min(w / DESIGN_W, h / DESIGN_H);
    return {
      mode, scale, diskScale: scale, railScale: scale,
      designW: DESIGN_W, designH: DESIGN_H,
      diskSize: DISK, diskMargin: 0, railW: DESIGN_W - DISK, railH: DESIGN_H,
      navScale: 1,
      ...centred(w, h, scale)
    };
  }

  if (mode === 'stacked') {
    const scale = Math.min(w / STACKED_DESIGN_W, STACKED_MAX_SCALE);
    const designW = w / scale;
    return {
      mode, scale, diskScale: scale, railScale: scale,
      designW, designH: h / scale,
      diskSize: designW, diskMargin: 0, railW: designW, railH: null,
      navScale: navScaleFor(designW),
      offsetX: 0, offsetY: 0
    };
  }

  const floor = (opts.minBody ?? MIN_BODY_CSS_PX) / BODY_PX;
  const diskScale = Math.max(0.05, Math.min(
    h / DESIGN_H,
    w / DESIGN_W,
    (w - RAIL_MIN_W * floor) / DISK
  ));
  const railScale = Math.max(diskScale, floor);
  const designW = w / railScale;
  const designH = h / railScale;
  const diskSize = DISK * diskScale / railScale;

  // The rail's width in CSS px. 'canvas': the exhibition canvas centred in this
  // window would put the seam 500 canvas-px off the window's centre line, so
  // the rail is what lies between that and the window's edge — but never
  // under its minimum, and never more than the disk leaves. Whatever is then
  // left over is the margin beyond the disk.
  const canvasScale = Math.min(w / DESIGN_W, h / DESIGN_H);
  const diskCss = DISK * diskScale;
  const railCss = (opts.diskAnchor ?? DISK_ANCHOR) === 'edge'
    ? w - diskCss
    : Math.min(w - diskCss, Math.max(RAIL_MIN_W * railScale, w / 2 - 500 * canvasScale));
  const railW = railCss / railScale;
  // Snapped: on a 3:2 window the margin is a rounding remainder, not a column.
  const margin = designW - diskSize - railW;
  return {
    mode, scale: railScale, diskScale, railScale,
    designW, designH,
    diskSize, diskMargin: margin > 0.01 ? margin : 0, railW, railH: designH,
    large: w >= LARGE_MIN_W,
    navScale: navScaleFor(diskSize),
    offsetX: 0, offsetY: 0
  };
}

/**
 * Window size -> layout for the splash and the loading interstitial. One disk
 * centred on the stage, so there is one scale and no rail.
 */
export function computeSplashLayout(w, h) {
  const scale = Math.min(w / DESIGN_W, h / DESIGN_H);
  return {
    mode: 'letterbox', scale, diskScale: scale, railScale: scale,
    designW: DESIGN_W, designH: DESIGN_H,
    diskSize: DISK, diskMargin: 0, railW: 0, railH: DESIGN_H,
    navScale: 1,
    ...centred(w, h, scale)
  };
}

/**
 * Publish a layout to CSS: the variables stage.css and the apps read, and
 * data-layout on <html> for mode-specific rules.
 *   --stage-scale, --design-w, --design-h, --nav-scale   unitless
 *   --disk-size, --disk-margin                           design px
 *   --stage-x, --stage-y                                 CSS px
 */
export function applyLayoutVars(L) {
  const root = document.documentElement;
  root.style.setProperty('--stage-scale', L.scale);
  root.style.setProperty('--design-w', L.designW);
  root.style.setProperty('--design-h', L.designH);
  root.style.setProperty('--disk-size', `${L.diskSize}px`);
  root.style.setProperty('--disk-margin', `${L.diskMargin}px`);
  root.style.setProperty('--nav-scale', L.navScale);
  root.style.setProperty('--stage-x', `${L.offsetX}px`);
  root.style.setProperty('--stage-y', `${L.offsetY}px`);
  root.dataset.layout = L.mode;
}
