// The design canvas.
//
// Both apps are authored 1:1 in plain px against a design canvas that is
// DESIGN_W x DESIGN_H on the display it was drawn for, and a single transform
// on .stage scales that canvas to whatever display we actually get. Off that
// display the canvas is not 3000x2000: it fills the window, and the disk
// column and the rail share it differently (see the modes in layoutCore.js).
// The numbers come from layoutCore.js — this module is its reactive face for
// the Svelte side, plus the pointer-space helpers.
//
// Nothing outside layoutCore should look at window dimensions to size UI.
import {
  DESIGN_W, DESIGN_H, computeLayout, applyLayoutVars, loadOverrides, insetLayout
} from './layoutCore.js';

export { DESIGN_W, DESIGN_H };

const overrides = loadOverrides();

function compute(winW, winH, prevMode) {
  return insetLayout(winW, winH, overrides.margin, (w, h) =>
    computeLayout(w, h, { ...overrides, prevMode }));
}

// Two copies of the current layout. `current` is the reactive one the `layout`
// object reads. `last` is a plain mirror for fit() and screenToDesign():
// initStage() runs inside an effect, and reading the reactive copy there would
// make that effect depend on the very state it writes.
let last = compute(DESIGN_W, DESIGN_H);
let current = $state.raw(last);
let textEpoch = $state(0);
let epochTimer = null;
let stageEl = null;
let stageRO = null;

/**
 * The current layout, reactive: every field of computeLayout()'s result, plus
 *   textEpoch  bumped 150 ms after the last resize that changed the scale. SVG
 *              text on a textPath is not re-laid-out when an ancestor's
 *              transform changes, so components that draw it key on this to
 *              remount once a resize has settled.
 */
export const layout = {
  get mode() { return current.mode; },
  get scale() { return current.scale; },
  get diskScale() { return current.diskScale; },
  get railScale() { return current.railScale; },
  get designW() { return current.designW; },
  get designH() { return current.designH; },
  get diskSize() { return current.diskSize; },
  get diskMargin() { return current.diskMargin; },
  get railW() { return current.railW; },
  get railH() { return current.railH; },
  get navScale() { return current.navScale; },
  get large() { return !!current.large; },
  /** The stacked (portrait / phone) layout: disk on top, rail under it, the
      page scrolls. */
  get stacked() { return current.mode === 'stacked'; },
  /** The disk column's side as rendered, in CSS px. */
  get diskCssPx() { return current.diskSize * current.scale; },
  get textEpoch() { return textEpoch; }
};

/** Current stage scale (1 = on target). Reactive. */
export function stageScale() {
  return current.scale;
}

export function getStageEl() {
  return stageEl;
}

function fit() {
  const next = compute(window.innerWidth, window.innerHeight, last.mode);
  // NavCircle carries its own scale on top of the stage's, and its arced
  // labels go stale the same way when that one moves.
  const scaleChanged = next.scale !== last.scale || next.navScale !== last.navScale
    || next.mode !== last.mode;
  last = next;
  current = next;
  applyLayoutVars(next);
  return scaleChanged;
}

function onResize() {
  if (!fit()) return;
  clearTimeout(epochTimer);
  epochTimer = setTimeout(() => { textEpoch += 1; }, 150);
}

/**
 * Set the scale BEFORE the app mounts (call from main.js, ahead of mount()).
 *
 * The rail's arced captions and the nav coin are SVG text on a textPath, and
 * the browser sizes that text with a factor taken from the ancestor transform
 * at layout time. If the first layout happens at the CSS default of 1 and the
 * transform only changes afterwards (which is what initStage() did from an
 * effect), Chromium does not re-lay-out the SVG text until something else
 * dirties it — typically the first hover — so on any display that is not
 * exactly 3:2 the captions painted at the wrong size until the mouse moved.
 * Fitting first means the first layout is already under the final transform.
 */
export function fitStage() {
  fit();
}

/** Call from each app's onMount with its .stage node. Returns a teardown. */
export function initStage(el) {
  stageEl = el;
  fit();
  window.addEventListener('resize', onResize);
  // Stacked, the stage is as tall as its content and the PAGE scrolls, so
  // .viewport needs a real height to scroll by: the stage's own, which only
  // the stage knows. Published as --stage-h (design px, unitless) and spent by
  // stage.css in that mode alone. The stage's height does not depend on
  // .viewport's, so this cannot feed back into itself.
  if (typeof ResizeObserver !== 'undefined') {
    stageRO = new ResizeObserver(() => {
      document.documentElement.style.setProperty('--stage-h', el.offsetHeight);
    });
    stageRO.observe(el);
  }
  return () => {
    window.removeEventListener('resize', onResize);
    clearTimeout(epochTimer);
    stageRO?.disconnect();
    stageRO = null;
    if (stageEl === el) stageEl = null;
  };
}

/**
 * Screen coords (clientX/clientY) -> design px relative to the stage origin.
 *
 * Reads the ratio off the live box rather than trusting `scale`, so it stays
 * correct no matter how the stage is transformed.
 */
export function screenToDesign(clientX, clientY) {
  if (!stageEl) return { x: clientX, y: clientY };
  const r = stageEl.getBoundingClientRect();
  const s = r.width / last.designW;
  return { x: (clientX - r.left) / s, y: (clientY - r.top) / s };
}

/**
 * Ratio between an element's rendered box and its layout box, i.e. the stage
 * scale as seen by that element. Use it to convert screen-space deltas from
 * pointer events into the design px that layout state is stored in.
 *
 * `rect` is a getBoundingClientRect() (transformed); clientWidth is the
 * untransformed layout width.
 */
export function elementScale(el, rect) {
  if (!el?.clientWidth) return 1;
  return (rect ?? el.getBoundingClientRect()).width / el.clientWidth;
}
