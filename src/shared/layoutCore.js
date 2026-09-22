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
//              (The splash and the loading page carry this name too, though
//              in a narrow window their stage is the window: see
//              computeSplashLayout.)
//   wide       the stage fills the window. Two scales: the disk shrinks with
//              the window (diskScale) while the stage transform — which is
//              what sizes the rail's type — stops at a floor (railScale), so
//              body copy never renders under MIN_BODY_CSS_PX. How wide the
//              rail is comes from RAIL_SHARE_STEPS (below); it runs from the
//              window's edge to its share of it, and the disk sits centred in
//              what is left. Because that table ends at 1/3, a 3000x2000
//              window still gives both scales 1 and the letterbox canvas
//              exactly — 1000 of rail and 2000 of disk, no margin.
//   stacked    portrait and narrow windows: disk on top at full width, rail
//              under it, the page scrolls.

export const DESIGN_W = 3000;
export const DESIGN_H = 2000;
/** The disk's side at scale 1, in design px. Its COLUMN can be wider — see
    diskMargin — but the disk itself is always this square, scaled. */
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
/** Stacked mode's control bar above the disk, design px (its padding plus
    TOP_BAR.ctl in railTiers.js). */
export const STACKED_BAR_H = 100;
/** ===== THE SEAM: the tuning surface for how wide the rail is. =====
 *
 *  Each row is [window width in CSS px, the rail's share of it]. Rows run left
 *  to right by width. Between two rows the share ramps linearly, so dragging a
 *  window across a break slides the seam rather than jumping it; below the
 *  first row and above the last it holds flat. Add, move or delete rows freely
 *  — this table is the whole rule.
 *
 *  Why the share falls as the window grows: a small window has already spent
 *  its rail on the type floor (see MIN_BODY_CSS_PX), so the rail's content is
 *  fighting for room and every point of share buys a real tier. A large window
 *  has none of that problem — a third is plenty, and the width is worth more
 *  to the disk. 1/3 is the exhibition composition: the 3000x2000 canvas gave
 *  the disk 2000 and the rail 1000.
 *
 *  Raising a share only shrinks the disk where the disk is bound by the
 *  window's WIDTH — aspects squarer than 1/(1 - share). On wider windows the
 *  disk is bound by height, and what the rail gains is empty margin it would
 *  otherwise have sat beside.
 *
 *  `?split=<percent>` pins one share at every width, which is how two settings
 *  are compared without editing this.
 */
export const RAIL_SHARE_STEPS = [
  [1512, 0.40],
  [2560, 1 / 3]
];

/** The rail's share at one window width: RAIL_SHARE_STEPS, interpolated. */
export function railShareFor(w) {
  const first = RAIL_SHARE_STEPS[0];
  const last = RAIL_SHARE_STEPS[RAIL_SHARE_STEPS.length - 1];
  if (w <= first[0]) return first[1];
  if (w >= last[0]) return last[1];
  const i = RAIL_SHARE_STEPS.findIndex(([stepW]) => stepW > w);
  const [w0, s0] = RAIL_SHARE_STEPS[i - 1];
  const [w1, s1] = RAIL_SHARE_STEPS[i];
  return s0 + (s1 - s0) * ((w - w0) / (w1 - w0));
}

/** Where the wide layout puts the disk across the window. `?disk=` overrides.
 *    'split'   the seam sits at railShareFor() of the window's width. The disk
 *              is a square, so where the window is wider than the disk is tall
 *              it cannot fill its own column; the remainder is split either
 *              side of it (diskMargin) and the disk is centred in what it has.
 *    'edge'    hard against the window's far edge, so the rail takes every px
 *              the disk leaves. Widest rail, no empty margin. */
export const DISK_ANCHOR = 'split';
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
 *   ?disk=split|edge                   see DISK_ANCHOR
 *   ?split=<percent>                   pin the rail's share, see RAIL_SHARE_STEPS
 *   ?margin=<percent>                  safe margin, see MAX_MARGIN_PCT
 */
export function readOverrides(search = '') {
  const params = new URLSearchParams(search);
  const out = {};
  if (params.has('minBody')) {
    const v = Number(params.get('minBody'));
    if (Number.isFinite(v) && v >= 0) out.minBody = v;
  }
  if (params.has('split')) {
    // Bounded well inside 0-100: past these the disk or the rail stops being
    // a column at all, and RAIL_MIN_W would be doing all the work anyway.
    const v = Number(params.get('split'));
    if (Number.isFinite(v)) out.railShare = clamp(v, 20, 60) / 100;
  }
  const mode = params.get('layout');
  if (mode === 'wide' || mode === 'stacked' || mode === 'letterbox') out.layout = mode;
  const disk = params.get('disk');
  if (disk === 'split' || disk === 'edge') out.diskAnchor = disk;
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
const STICKY = ['minBody', 'margin', 'railShare'];
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
 * opts: { minBody, layout, diskAnchor, railShare, prevMode } — the first four
 * as readOverrides() returns them, prevMode the mode of the previous result
 * (for hysteresis).
 *
 * Returns, all in design px unless noted:
 *   mode                 'letterbox' | 'wide' | 'stacked'
 *   scale                the stage transform (= railScale)
 *   diskScale, railScale the two scales (CSS px per design px)
 *   designW, designH     the stage's size under the transform
 *   diskSize             the disk's side; its column is this plus diskMargin
 *                        either side
 *   diskMargin           empty column on EACH side of the disk: whatever the
 *                        rail leaves over is split in two, so the disk is
 *                        centred across the window (0 under DISK_ANCHOR
 *                        'edge', and 0 wherever the disk fills its column).
 *                        Only ever the HORIZONTAL slack — where the disk is
 *                        bound by width instead, the leftover is vertical and
 *                        the charts centre themselves in it (a square viewBox
 *                        under the default preserveAspectRatio), so nothing
 *                        here describes it
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
    const designH = h / scale;
    // The disk is the window's width — but never taller than the window has
    // room for under the bar, so a small phone held sideways still shows the
    // whole of it at once.
    const diskSize = Math.max(200, Math.min(designW, designH - STACKED_BAR_H));
    return {
      mode, scale, diskScale: scale, railScale: scale,
      designW, designH,
      diskSize, diskMargin: 0, railW: designW, railH: null,
      navScale: navScaleFor(diskSize),
      offsetX: 0, offsetY: 0
    };
  }

  const floor = (opts.minBody ?? MIN_BODY_CSS_PX) / BODY_PX;
  const share = opts.railShare ?? railShareFor(w);
  // The disk is the smaller of what the window's height allows and what its
  // own column is wide — and, whichever wins, never so large that the rail is
  // squeezed under RAIL_MIN_W at the type floor.
  const diskScale = Math.max(0.05, Math.min(
    h / DESIGN_H,
    (w * (1 - share)) / DISK,
    (w - RAIL_MIN_W * floor) / DISK
  ));
  const railScale = Math.max(diskScale, floor);
  const designW = w / railScale;
  const designH = h / railScale;
  const diskSize = DISK * diskScale / railScale;

  // The rail's width in CSS px. 'split': its share of the window, but never
  // under its minimum, and never more than the disk leaves. Whatever the disk
  // then fails to use of its own column — it is a square, so on a window wider
  // than it is tall it cannot fill it — is split evenly either side of it,
  // centring it in the space it has.
  const diskCss = DISK * diskScale;
  const railCss = (opts.diskAnchor ?? DISK_ANCHOR) === 'edge'
    ? w - diskCss
    : Math.min(w - diskCss, Math.max(RAIL_MIN_W * railScale, w * share));
  const railW = railCss / railScale;
  // Snapped: where the disk fills its column the margin is a rounding
  // remainder, not a pair of columns.
  const margin = designW - diskSize - railW;
  return {
    mode, scale: railScale, diskScale, railScale,
    designW, designH,
    diskSize, diskMargin: margin > 0.01 ? margin / 2 : 0, railW, railH: designH,
    large: w >= LARGE_MIN_W,
    navScale: navScaleFor(diskSize),
    offsetX: 0, offsetY: 0
  };
}

/** The splash composition's width in design px: the title ring (r = 930
    viewBox units on a 900px disk) plus the titles' own height, both sides. What
    a portrait window has to fit; a landscape one is bounded by DESIGN_H. */
export const SPLASH_W = 1840;
/** Below this scale the splash sets its type a step larger, whatever the
    window's shape: a phone held sideways is height-bound at about 0.2. */
export const SPLASH_COMPACT_SCALE = 0.3;

/**
 * Window size -> layout for the splash and the loading interstitial. One disk
 * centred on the stage, so there is one scale and no rail.
 *
 * The scale is bound by the window's height, or by the composition's width
 * (SPLASH_W) where that is the tighter fit — a portrait window, or a narrow
 * one. A window with room for the whole 3000x2000 canvas at that scale keeps
 * it, centred, exactly as the exhibition build had it (1 at 3000x2000, 0.9 at
 * 3340x1800); only a narrower one gives the stage the window's own size, and
 * the disk is centred in that instead. `compact` — a portrait window, or any
 * window small enough that the scale is under SPLASH_COMPACT_SCALE — tells the
 * two pages to set their type a step larger (splashType() in splashCopy.js),
 * since the scale on a phone is around 0.2.
 */
export function computeSplashLayout(w, h) {
  const scale = Math.min(w / SPLASH_W, h / DESIGN_H);
  const fits = DESIGN_W * scale <= w && DESIGN_H * scale <= h;
  return {
    mode: 'letterbox', scale, diskScale: scale, railScale: scale,
    designW: fits ? DESIGN_W : w / scale, designH: fits ? DESIGN_H : h / scale,
    diskSize: DISK, diskMargin: 0, railW: 0, railH: fits ? DESIGN_H : h / scale,
    navScale: 1,
    compact: w < h || scale < SPLASH_COMPACT_SCALE,
    ...(fits ? centred(w, h, scale) : { offsetX: 0, offsetY: 0 })
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
