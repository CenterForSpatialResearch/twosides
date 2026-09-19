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
//              body copy never renders under MIN_BODY_CSS_PX. The rail takes
//              whatever width is left. At 3000x2000 both scales are 1 and the
//              result is the letterbox canvas exactly.
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
/** Hysteresis: once stacked, return to wide only above this aspect, so a
    mobile browser's address bar sliding away does not flip the mode. */
const STACKED_EXIT_ASPECT = 1.1;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/**
 * Read the layout overrides off a query string.
 *   ?minBody=<css px>                  type floor; 0 = none
 *   ?layout=wide|stacked|letterbox     force a mode
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
  return out;
}

function pickMode(w, h, opts) {
  if (opts.layout) return opts.layout;
  const aspect = w / h;
  if (w < STACKED_MAX_W || aspect < 1) return 'stacked';
  if (opts.prevMode === 'stacked' && aspect < STACKED_EXIT_ASPECT) return 'stacked';
  return 'wide';
}

/** NavCircle shrinks with the disk so it stays clear of the year ring. */
function navScaleFor(diskSize) {
  return clamp((0.245 * diskSize - 20) / 336, 0.6, 1);
}

/**
 * Window size -> layout for the two visualizations.
 *
 * opts: { minBody, layout, prevMode } — the first two as readOverrides()
 * returns them, prevMode the mode of the previous result (for hysteresis).
 *
 * Returns, all in design px unless noted:
 *   mode                 'letterbox' | 'wide' | 'stacked'
 *   scale                the stage transform (= railScale)
 *   diskScale, railScale the two scales (CSS px per design px)
 *   designW, designH     the stage's size under the transform
 *   diskSize             the disk column's side
 *   railW, railH         the rail's box
 *   navScale             NavCircle's own scale, 0.6-1
 */
export function computeLayout(w, h, opts = {}) {
  const mode = pickMode(w, h, opts);

  if (mode === 'letterbox') {
    const scale = Math.min(w / DESIGN_W, h / DESIGN_H);
    return {
      mode, scale, diskScale: scale, railScale: scale,
      designW: DESIGN_W, designH: DESIGN_H,
      diskSize: DISK, railW: DESIGN_W - DISK, railH: DESIGN_H,
      navScale: 1
    };
  }

  if (mode === 'stacked') {
    const scale = Math.min(w / STACKED_DESIGN_W, STACKED_MAX_SCALE);
    const designW = w / scale;
    return {
      mode, scale, diskScale: scale, railScale: scale,
      designW, designH: h / scale,
      diskSize: designW, railW: designW, railH: null,
      navScale: navScaleFor(designW)
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
  return {
    mode, scale: railScale, diskScale, railScale,
    designW, designH,
    diskSize, railW: designW - diskSize, railH: designH,
    navScale: navScaleFor(diskSize)
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
    diskSize: DISK, railW: 0, railH: DESIGN_H,
    navScale: 1
  };
}

/**
 * Publish a layout to CSS: the variables stage.css and the apps read, and
 * data-layout on <html> for mode-specific rules.
 *   --stage-scale, --design-w, --design-h, --nav-scale   unitless
 *   --disk-size                                          px
 */
export function applyLayoutVars(L) {
  const root = document.documentElement;
  root.style.setProperty('--stage-scale', L.scale);
  root.style.setProperty('--design-w', L.designW);
  root.style.setProperty('--design-h', L.designH);
  root.style.setProperty('--disk-size', `${L.diskSize}px`);
  root.style.setProperty('--nav-scale', L.navScale);
  root.dataset.layout = L.mode;
}
