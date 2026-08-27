// Fixed-canvas scaling + dev HUD for the two plain-HTML pages: the splash
// (index.html) and the loading interstitial (loading.html).
//
// The Svelte side gets this from stage.svelte.js + DevHud.svelte, but those
// carry the Svelte runtime and $state, and these two pages deliberately have no
// framework on them — they are the first paint of the piece and load before any
// bundle the visualizations need. So the same contract is reimplemented here in
// plain JS. DESIGN_W/DESIGN_H, the readout list and the HUD's look are meant to
// match the Svelte pair; if one moves, move the other.
//
// The 1:1 lens is deliberately NOT ported. It works by cloning .stage and
// repainting every canvas inside it; the splash is a CSS 3D rotateY on a coin
// with backface-visibility doing the hiding, which a static clone cannot
// reproduce. It would show a misleading picture rather than a magnified one.
export const DESIGN_W = 3000;
export const DESIGN_H = 2000;

// Deliberately NOT styled to match the piece — it should read as an engineering
// overlay, not part of the work. Kept byte-for-byte in step with DevHud.svelte.
const HUD_CSS = `
.hud {
  position: fixed;
  left: 0;
  bottom: 0;
  z-index: 100000;
  display: flex;
  align-items: stretch;
  gap: 6px;
  background: #000;
  color: #fff;
  border: 1px solid #0000ff;
  padding: 6px 8px;
  font-family: ui-monospace, monospace;
  font-size: 11px;
  line-height: 1.45;
  white-space: pre;
  user-select: none;
}
.hud.collapsed { padding: 4px 5px; }
.hud-collapse {
  flex: 0 0 auto;
  align-self: stretch;
  background: transparent;
  color: #fff;
  border: none;
  border-right: 1px solid #0000ff;
  padding: 0 6px 0 2px;
  font-family: ui-monospace, monospace;
  font-size: 11px;
  cursor: pointer;
}
.hud.collapsed .hud-collapse { border-right: none; padding: 0 2px; }
.hud-body { display: flex; flex-direction: column; }
.hud-row { letter-spacing: 0.02em; }
.hud-btn {
  display: block;
  width: 100%;
  margin-top: 5px;
  padding: 3px 6px;
  background: #000;
  color: #fff;
  border: 1px solid #fff;
  border-radius: 0;
  font-family: ui-monospace, monospace;
  font-size: 11px;
  text-align: left;
  cursor: pointer;
}
.hud-btn.on { background: #0000ff; }
`;

/**
 * Scale-to-fit: the smaller ratio wins, so the whole canvas always fits and the
 * leftover space letterboxes. Never clips, never scrolls.
 *
 * Also drives the letterbox colour — pure blue in the bars whenever we are not
 * on the target display. At exactly 3:2 there are no bars, so this never shows
 * on the Surface.
 */
function fit() {
  const scale = Math.min(window.innerWidth / DESIGN_W, window.innerHeight / DESIGN_H);
  const root = document.documentElement.style;
  root.setProperty('--stage-scale', scale);
  root.setProperty('--letterbox-bg', scale < 0.9999 ? '#0000FF' : 'var(--bg)');
  return scale;
}

function row(text) {
  const el = document.createElement('div');
  el.className = 'hud-row';
  el.textContent = text;
  return el;
}

/**
 * Build the HUD.
 *
 * `uiOptions` is the extension point the splash uses once it has more than one
 * arrangement to show: pass { labels, get, cycle } and the HUD grows the same
 * UI OPTION button the Svelte HUD has. Omit it and no button is rendered —
 * a page with a single arrangement has nothing to cycle through.
 */
function buildHud(uiOptions) {
  const el = document.createElement('div');
  el.className = 'hud';

  const collapse = document.createElement('button');
  collapse.className = 'hud-collapse';
  const body = document.createElement('div');
  body.className = 'hud-body';

  const rScale = row('');
  const rViewport = row('');
  const rTarget = row(`TARGET:   ${DESIGN_W} × ${DESIGN_H}`);
  const rDpr = row('');
  body.append(rScale, rViewport, rTarget, rDpr);

  let optionBtn = null;
  if (uiOptions) {
    optionBtn = document.createElement('button');
    optionBtn.className = 'hud-btn';
    optionBtn.addEventListener('click', () => {
      uiOptions.cycle();
      paintOption();
    });
    body.appendChild(optionBtn);
  }

  function paintOption() {
    if (!optionBtn) return;
    const n = uiOptions.get();
    const count = uiOptions.labels.length;
    optionBtn.textContent = `UI OPTION: ${n}/${count} · ${uiOptions.labels[n - 1] ?? n}`;
    optionBtn.classList.toggle('on', n !== 1);
  }

  let collapsed = false;
  function paintCollapse() {
    collapse.textContent = collapsed ? '▶' : '◀';
    collapse.title = collapsed ? 'Expand dev HUD' : 'Collapse dev HUD';
    collapse.setAttribute('aria-label', collapse.title);
    el.classList.toggle('collapsed', collapsed);
    body.style.display = collapsed ? 'none' : '';
  }
  collapse.addEventListener('click', () => {
    collapsed = !collapsed;
    paintCollapse();
  });

  paintCollapse();
  paintOption();
  el.append(collapse, body);

  return {
    el,
    update(scale) {
      const dpr = window.devicePixelRatio || 1;
      rScale.textContent = `UI SCALE: ${Math.round(scale * 100)}%  (of target)`;
      rViewport.textContent = `VIEWPORT: ${window.innerWidth} × ${window.innerHeight}`;
      rDpr.textContent = `DPR:      ${dpr.toFixed(2)}`;
    }
  };
}

/**
 * Start the fixed-canvas scaling loop and mount the HUD.
 *
 * The page's own markup must already be wrapped in .viewport > .stage (see the
 * CSS block in each page). The HUD is appended to <body>, i.e. OUTSIDE .stage,
 * so it never gets scaled with the canvas.
 *
 * Returns a teardown, for symmetry with initStage().
 */
export function initPageStage({ uiOptions = null } = {}) {
  const style = document.createElement('style');
  style.textContent = HUD_CSS;
  document.head.appendChild(style);

  const hud = buildHud(uiOptions);
  document.body.appendChild(hud.el);

  const update = () => hud.update(fit());
  update();
  window.addEventListener('resize', update);
  return () => window.removeEventListener('resize', update);
}
