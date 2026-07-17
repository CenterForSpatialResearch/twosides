# Claude Code task: replace fluid `--ui` scaling with a fixed-canvas + transform-scale system

## Goal

Rework the layout scaling for both visualizations (`src/biomes` and `src/anthromes`) so the app is **designed once at a single fixed logical size and uniformly scaled** to fit any display, preserving the exact layout. Smaller/illegible text on laptops is an acceptable tradeoff; the app must **never** produce scrollbars or push content off-screen.

The deployment target is a **Microsoft Surface Studio 2+** running **fullscreen/kiosk** in a browser. At its default 150% Windows scaling it exposes a **3000 × 2000 CSS-pixel viewport at devicePixelRatio 1.5** (native panel is 4500 × 3000, 3:2). Design to that logical size.

## Design decisions (already made — implement these, don't re-litigate)

- **Design size:** `3000 × 2000` CSS px (3:2). This is the single source of truth; all layout is authored at 1:1 in plain px at this size.
- **Scaling model:** one global `transform: scale()` on a fixed-size stage. No per-property `clamp()`, no `vw`/`vh` for sizing UI elements, no `--ui` unit.
- **Off-aspect behavior:** letterbox / scale-to-fit. `scale = min(innerWidth / 3000, innerHeight / 2000)`. Center the stage; leftover space is background (`--bg`). On a 16:9 display this produces left/right bars; on a taller display, top/bottom bars. Never clip, never scroll.
- **Runtime:** fullscreen/kiosk, so assume the full viewport is usable (no browser-chrome allowance).

## What to remove

In both `src/anthromes/App.svelte` and `src/biomes/App.svelte`:

- Delete the `--ui: clamp(0.62px, calc(100vw / 3840), 1px)` declaration and every `calc(N * var(--ui))` / `var(--ui)`-based value. Replace each with the plain px value it should have **at the 3000×2000 design size** (i.e. the intended on-Surface pixel size).
- Convert every remaining hardcoded `font-size`, padding, gap, border-radius, width/height etc. so it is expressed in plain px at design scale. After this pass there should be **no mixed reference frames** — everything is design-space px and the global transform handles all scaling. (The current bug is that some dimensions scaled via `--ui` while dozens of `font-size: 13px`-style values stayed fixed, breaking layout relationships as the app shrank.)
- The `style="width:calc({c.size} * var(--ui)); ..."` inline bindings (e.g. `src/biomes/App.svelte:436`) become plain `style="width:{c.size}px; height:{c.size}px;"`.

## What to add: the stage wrapper

For each app, introduce a fixed-size stage that contains **all** app content (the `.app` div at `src/anthromes/App.svelte:324` and the biomes equivalent), and a viewport-level letterbox wrapper behind it.

```css
:root { --design-w: 3000; --design-h: 2000; }

.viewport {            /* fills the real window, provides the letterbox bg */
  position: fixed; inset: 0;
  background: var(--bg);
  overflow: hidden;
}
.stage {               /* the fixed 1:1 design canvas */
  position: absolute;
  top: 50%; left: 50%;
  width: calc(var(--design-w) * 1px);
  height: calc(var(--design-h) * 1px);
  transform: translate(-50%, -50%) scale(var(--stage-scale, 1));
  transform-origin: center center;
}
```

Set `--stage-scale` in JS on load and on resize (CSS can't divide length/length to a unitless factor, so compute it):

```js
function fitStage() {
  const s = Math.min(window.innerWidth / 3000, window.innerHeight / 2000);
  document.documentElement.style.setProperty('--stage-scale', s);
}
window.addEventListener('resize', fitStage);
fitStage();
```

Everything currently using `position: fixed` (nav circle, side title, settings panel, zooms link, etc. — see `src/anthromes/App.svelte:557,578,992,1019`) must move **inside `.stage`** and become `position: absolute`. `position: fixed` inside a transformed ancestor is positioned relative to that ancestor anyway, but switch to `absolute` for clarity and correct stacking. Their coordinates are now design-space px.

## Critical gotcha: canvas pointer math (this WILL break if ignored)

`src/anthromes/lib/MapCanvas.svelte` (and any other canvas: `WaffleChart.svelte`, `BiomesChart.svelte`, `HistoryCircleChart.svelte`) converts pointer events to canvas coordinates like:

```js
const rect = canvasEl.getBoundingClientRect();
const dpr = window.devicePixelRatio || 1;
const x = (e.clientX - rect.left) * dpr - (mapPanX || 0) * dpr;   // lines ~684-687, ~985-988
```

Under a CSS transform on an ancestor, `getBoundingClientRect()` returns the **scaled** box, so `rect.width` no longer equals the canvas's layout width and multiplying by `dpr` alone is wrong. Replace the `* dpr` conversion with a transform-agnostic ratio that maps screen px straight to device px:

```js
const rect = canvasEl.getBoundingClientRect();
const sx = canvasEl.width  / rect.width;    // absorbs BOTH dpr and stage scale
const sy = canvasEl.height / rect.height;
const x = (e.clientX - rect.left) * sx - (mapPanX || 0) * dpr;
const y = (e.clientY - rect.top)  * sy - (mapPanY || 0) * dpr;
```

Apply this to every `getBoundingClientRect()`-based pointer→canvas conversion (hover, click/select, wheel-drag pan). The internal rendering math (`circle.cx * dpr`, `ctx.lineWidth = 2 * dpr`, projection cache keyed on `dpr`, etc.) stays as-is — it works in device pixels and is unaffected by the CSS transform. Keep the canvas backing store sized as it is now (`canvasEl.width = layoutWidth * dpr`); `layoutWidth` here is design-space px.

## Tooltips and viewport-level overlays

Anything positioned from raw `e.clientX/e.clientY` (e.g. `tooltipX = e.clientX` around `MapCanvas.svelte:745`, and `src/shared/Tooltip.svelte`) is in **screen** coordinates. Keep such overlays rendered **outside `.stage`** at the viewport level so `clientX/clientY` remain correct, OR divide the offset by `--stage-scale` if they must live inside the stage. Prefer rendering tooltips at viewport level. `document.elementFromPoint(e.clientX, e.clientY)` (`App.svelte:105`) uses screen coords and needs no change.

## Files in scope

- `src/anthromes/App.svelte` — remove `--ui`, add stage wrapper + `fitStage`, convert all dims to design px.
- `src/biomes/App.svelte` — same (note the `--tier-*` vars at lines ~563-565 and the inline `--ui` binding at ~436).
- `src/anthromes/lib/MapCanvas.svelte`, `WaffleChart.svelte`, `HistoryCircleChart.svelte`, `ZoomsPanel.svelte` — fix pointer→canvas math where `getBoundingClientRect()` is used.
- `src/biomes/lib/BiomesChart.svelte` — same pointer-math fix if it does canvas hit-testing.
- `src/shared/styles.css` — the shared chrome classes (`.side-title`, `.settings-panel`, `.nav-circle`, etc.) use fixed px positioned to the viewport; these must live inside the stage and be authored in design px. Update accordingly.

## Constraints

- Do not change data loading, projection logic, chart-drawing internals, or visual design beyond what the scaling refactor requires.
- Keep both apps behaviorally identical to today at the 3000×2000 target; only the scaling mechanism changes.
- No new dependencies.

## Dev HUD (dev-branch tooling — always visible on this branch)

This is a dev branch, so the following tooling is **always on**, no gating/toggle needed. It is deliberately **not styled to match the site** — use plain technical styling: monospace font (`ui-monospace, monospace`), no rounded corners/shadows/gradients, high-contrast, small. It should read like an engineering overlay, not part of the piece. Keep it in its own component (e.g. `src/shared/DevHud.svelte`) mounted inside `.viewport` but **outside `.stage`** so it isn't scaled, and reused by both apps.

**1. Letterbox fill.** When `--stage-scale < 1` (i.e. not on the exact target), fill the letterbox area — the `.viewport` background behind/around `.stage` — with **pure blue `#0000FF`** instead of `--bg`, so it's unmistakable you're not on the target display. At exactly 3:2 there are no bars, so blue won't show; that's fine.

**2. Scale readout.** A fixed, monospace text block (corner of the viewport) showing at least:

```
UI SCALE: 85%   (of target)
VIEWPORT: 2560 × 1440
TARGET:   3000 × 2000
DPR:      2.0
```

`UI SCALE` = `--stage-scale` as a percent, rounded. Update live on resize. Use white text on a solid black/blue background box for contrast.

**3. Magnifier lens (1:1 target, follows cursor).** A toggle button in the HUD turns on a fixed-size lens rectangle (e.g. 420 × 280 screen px) that **follows the cursor**. Inside the lens, the region of the page under the cursor is shown at **true 1:1 target pixels** — i.e. rendered at `scale(1)` rather than `--stage-scale`, so magnification relative to the on-screen view is `1 / --stage-scale`. This lets you preview the physical legibility of any region as it will appear on the Surface, regardless of how shrunk the overall stage currently is. Label the lens with its effective zoom (e.g. `1:1 TARGET (117%)`).

Implementation note / **canvas caveat** — do not naively `cloneNode` the stage for the lens: the map/waffle `<canvas>` elements will clone as blank because bitmaps don't copy. Recommended approach:

- **Canvas layers** (the legibility-critical, dense parts): the existing backing stores are already rendered at `layoutWidth * dpr` device pixels — more detail than is shown when scaled down — so draw a magnified slice directly from the live source canvas into a lens canvas with `ctx.drawImage(sourceCanvas, sx, sy, sw, sh, 0, 0, lensW, lensH)`, where the source rect is derived from the cursor's design-space position. This gives a true 1:1 view with no re-render (same-origin canvas, reads are allowed).
- **DOM/SVG chrome:** either transform a live clone of the chrome subtree at `scale(1)` positioned to the cursor, or, if that's not worth the effort, scope the lens to the canvas layers and leave chrome out — call that out in a code comment. Pick based on effort; the canvas view is the important one.

## Acceptance criteria

1. At a **3000×2000 / DPR 1.5** emulated viewport (Chrome DevTools custom device), both apps look pixel-correct with no letterbox bars (and therefore no blue).
2. At **2560×1440** (the dev BenQ logical size, 16:9) and at a typical laptop **1440×900**, the entire layout is visible, uniformly smaller, centered, with **blue `#0000FF`** left/right bars, and **no scrollbars**.
3. Map/waffle hover, selection, and wheel-drag pan hit the correct targets at every scale (verify at 3000×2000, 1440×900, and a zoomed-out DevTools responsive view).
4. Tooltips appear at the cursor at every scale.
5. No remaining `var(--ui)` / `100vw`-based sizing anywhere in `src/`.
6. The scale readout shows the correct live `UI SCALE %`, viewport, target, and DPR, and updates on resize.
7. The magnifier toggles on, follows the cursor, and shows the hovered region at true 1:1 target pixels — including a correct, magnified view of the map/waffle canvas (not a blank rectangle).

---

## Out of scope for Claude Code (do these yourself — display/exhibition setup, not code)

- **Preview on the Mac:** Chrome DevTools → add custom device **3000 × 2000, DPR 1.5**, use Responsive/zoom-to-fit. You can't get a true 3000×2000 CSS viewport physically on the 5K BenQ (DPR 2 would need a 6000×4000 panel), so emulation is the faithful preview — including the 3:2 aspect.
- **Color:** lock the Surface to its **sRGB** profile and set the BenQ to **sRGB** (OSD or macOS color profile). CSS hex colors are interpreted as sRGB regardless; this just stops the wide-gamut panels from over-saturating them, so your preview matches the exhibition.
- **Runtime:** launch fullscreen/kiosk on the Surface so the full 3000×2000 logical viewport is used.

---

## Progress log

### 2026-07-17 — Biomes rail: filter panels + cohort ranking

Reworked the biomes menu rail (`src/biomes/App.svelte`, `src/biomes/lib/BiomesChart.svelte`) to bring back the main-branch filters under the current dev-branch (MoMA) styling.

- **Known/Unknown + Non/Western share one row.** Non/Western filter restored (`westernFilter` prop, predicate, and reactive re-render re-added to `BiomesChart`). Each button shows its share of all species (`{knownPct}%` etc.); Western + Non-Western don't sum to 100 because some species have no westernization label.
- **No "All" button** on either group — they behave like Cohort: everything shows by default, tap a value to isolate it, tap the same value again to reset (`toggleUnknown` / `toggleWestern`).
- **Cohort ranking is fixed to "% Unknown"** (share of each cohort's SGBs that are uSGB). Total and Per-capita toggles removed — Total just ranked by sampling effort, Per-capita over-rewarded tiny cohorts (Italy, n=15). % Unknown puts Madagascar #1 → Italy last, matching the piece's non-Western-diversity/preservation thesis. Each bubble shows the country name + "x% unknown", unified with the Known/Unknown + Non/Western button labels (`.sel-name` / `.sel-pct`).
- **Cohort bubbles stay true circles.** `.bubble` is `flex: 0 0 auto` (+ `min-width: 0`) so flexbox can't squash them into ellipses, and the largest diameter is solved from the measured row width (`bind:clientWidth={bubbleRowW}`) so `Σ diameters + gaps ≤ row width`, capped at 160 — i.e. as large as possible while the row stays on one line.
- **Selection is restricted to the active filter.** Added `selectableByAngle` (subset of `leavesByAngle` in the keep-set); the rotation angle-snap searches it, so spinning the disk only lands on filtered leaves. Applying a filter re-snaps the center selection immediately so a now-excluded leaf isn't left highlighted.
- Renamed the details panel heading "Details" → "Bacteria Species Details".
