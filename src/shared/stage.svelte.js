// Fixed design canvas.
//
// Both apps are authored 1:1 in plain px at DESIGN_W x DESIGN_H; a single
// transform on .stage scales that canvas to whatever display we actually get.
// Target is a Microsoft Surface Studio 2+ in kiosk at 150% Windows scaling,
// which exposes a 3000x2000 CSS-px viewport (4500x3000 native, DPR 1.5).
//
// Nothing outside this module should look at window dimensions to size UI.
export const DESIGN_W = 3000;
export const DESIGN_H = 2000;

let scale = $state(1);
let stageEl = null;

/** Current stage scale (1 = on target). Reactive. */
export function stageScale() {
  return scale;
}

export function getStageEl() {
  return stageEl;
}

// Scale-to-fit: the smaller ratio wins, so the whole canvas always fits and the
// leftover space letterboxes. Never clips, never scrolls.
function fit() {
  scale = Math.min(window.innerWidth / DESIGN_W, window.innerHeight / DESIGN_H);
  document.documentElement.style.setProperty('--stage-scale', scale);
}

/** Call from each app's onMount with its .stage node. Returns a teardown. */
export function initStage(el) {
  stageEl = el;
  fit();
  window.addEventListener('resize', fit);
  return () => {
    window.removeEventListener('resize', fit);
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
  const s = r.width / DESIGN_W;
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
