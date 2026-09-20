# Refactor notes: the responsive build

This build is the MoMA exhibition UI (`moma`) brought onto `main` as a public, responsive site. It
still reads like `moma` on purpose: the same components, the same 3000×2000 design, the same
interaction. What changed is that the layout is now computed instead of fixed, the kiosk tooling
is gone, and dead code has been pruned or marked.

This document is for whoever works on the code next. It covers:

1. [What was pruned](#1-what-was-pruned)
2. [The layout API](#2-the-layout-api), the contract to build interaction experiments on
3. [CSS marked `@orphan`](#3-css-marked-orphan)
4. [Indirect traces that remain](#4-indirect-traces-that-remain), each with a recommended direct replacement
5. [Rules to keep](#5-rules-to-keep)

Line numbers are as of the commit that added this file. Paths under `utilities/` are gitignored:
the screenshot baseline and the audit scripts exist only in a working copy that has them.

## 1. What was pruned

| Removed | Why |
| --- | --- |
| `src/shared/idleReset.js`, `IdleOverlay.svelte`, and their wiring in both `App.svelte` files | The 30-second idle reset is for an unattended kiosk. |
| `release/`, `.github/workflows/release-moma.yml`, `trigger-deploy.yml` | Exhibition packaging and its triggers. |
| `CellHistoryBar`, `CountryTimeseriesBar`, `CountryTimeseriesChart`, `HistoryCircleChart` (anthromes) | Earlier UI options; nothing mounted them. |
| `public/data/country_index.json`; processing scripts 3, 4, 6, 7, 9 and `run_batch.sh` | Fed only the components above. |
| About 270 lines of `MapCanvas.svelte`, plus parts of `gridSource.js`, `constants.js`, `dataAdapter.js` | Code paths for the removed options. |
| The trial machinery in `src/splash/narrative.js` | Only `dev`'s three trial splashes used it. `moma` kept the final splash alone. |
| The duplicated stage, rail, control-bar and info-modal code in the two `App.svelte` files | Moved to `src/shared/` (`stage.css`, `rail.css`, `ControlBar.svelte`, `InfoModal.svelte`). About 700 lines, no visual change. |

The info panels got their five hyperlinks and the open-source sentence back. The kiosk had them
removed because a link leaves the piece.

## 2. The layout API

Everything is authored in **design px** on one `.stage` element under one transform,
`scale(var(--stage-scale))`. No component multiplies by a scale itself. A component that needs to
convert a pointer position asks the stage (`screenToDesign`, `elementScale`).

### Modules

| Module | Role |
| --- | --- |
| `src/shared/layoutCore.js` | Pure functions and the named constants. `computeLayout(w, h, opts)` for the two visualizations, `computeSplashLayout(w, h)` for the splash and loading pages, `applyLayoutVars(L)` to publish the result as CSS variables. No DOM reads, no framework. |
| `src/shared/stage.svelte.js` | The Svelte wrapper: `initStage(el)`, the reactive `layout` object, `screenToDesign`, `elementScale`, `renderDpr`. |
| `src/shared/pageStage.js` | The same for the two plain-HTML pages: `initPageStage({ onVariantChange })`, `splashVariant()`. |
| `src/shared/railTiers.js` | One ordered table per side that decides what the rail shows at a given size: `railTier(side, railW, railH, force, opts)`. |
| `src/shared/stage.css`, `rail.css` | The CSS half: the viewport, the stage, the overlay stage, the rail's shared type. |

### Modes

`layout.mode` is one of three values. It is also published as `html[data-layout]`, which is what
CSS keys on.

| Mode | When | What it does |
| --- | --- | --- |
| `wide` | Any landscape window 700 px or wider | The disk fills the height, the rail takes the remaining width, and its content reflows. Two scales: the disk column is laid out smaller (`--disk-size`) while type is held at or above `MIN_BODY_CSS_PX`. At exactly 3000×2000 this reproduces the exhibition layout pixel for pixel, which is the regression anchor. |
| `letterbox` | Only with `?layout=letterbox`, and always on the splash and loading pages | The fixed 3000×2000 canvas, scaled to fit and centred. How `moma` laid out every window. |
| `stacked` | `w < 700` or portrait | A top bar, the disk, then the rail's sections in a column. The page scrolls natively. Exits only above aspect 1.1, so a window near square does not flicker. |

The reactive `layout` object exposes `mode`, `stacked`, `scale`, `designW`, `designH`, `diskSize`,
`diskCssPx`, `railW`, `railH`, `navScale`, `large` and `textEpoch`. `textEpoch` increments once a
resize settles. Text on an SVG `textPath` is keyed on it, because browsers do not re-lay-out that
text when an ancestor's transform changes.

### Sections

Each `App.svelte` declares its rail as four snippets (`controls`, `countryPanel`, `detailsPanel`,
`keyPanel`) and a `SECTIONS` table that orders them per mode:

```js
const SECTIONS = {
  wide: ['controls', 'country', 'details', 'key'],
  stacked: ['details', 'key']
};
```

Adding, dropping or reordering a menu in one mode is an edit to that table. The rail and the disk
stay sibling elements in every mode and CSS rearranges them, so crossing between `wide` and
`stacked` never remounts a chart: the zoom, the selection and the year survive.

### Rail tiers

`railTier()` walks its table from the roomiest row down and returns the first one that fits the
rail's width and height. A row sets the country circles' size and columns (one row of eight or two
of four), the control-circle size, the spacing (`anchor`, `regular`, `tight`), whether the details
block is `full` or `compact`, and whether the rail may scroll. `tight` rows also reduce the
anthrome key to pills. Relief comes in this order: wider reflow, then a shorter timeline or species
panel, then smaller circles, then a scrolling rail. The `minH` column was measured, not estimated
(`utilities/responsive-baseline/harness/tierfit.mjs`). In `stacked` mode `railH` is `null`, which
skips the anchor row and never scrolls the rail.

### Canvases

`renderDpr()` is the backing-store scale for a canvas on the stage: `devicePixelRatio`, raised by
the stage scale where the stage is drawn larger than designed (a 4K wall). It never drops below
`devicePixelRatio`. A stage drawn smaller than designed is a supersampled canvas, which is what
keeps the anthromes grid's few-pixel cells even on a laptop. Both `MapCanvas` and `BiomesChart`
read it through one untracked wrapper each, so the projection, the pan conversion and the hit
tests cannot disagree.

### URL overrides

`minBody` and `margin` are display settings: `loadOverrides()` keeps them for the tab session, so
an exhibition sets them once on the splash URL and they follow through all four pages. The rest
are inspection tools and apply only to the URL that carries them.

| Parameter | Effect |
| --- | --- |
| `?minBody=<css px>` | The type floor. `0` gives pure proportional scaling, for wall displays. |
| `?margin=<percent>` | A safe margin inside every edge, for TVs. Capped at 20. |
| `?layout=wide\|stacked\|letterbox` | Force a mode. |
| `?disk=canvas\|edge` | Where the disk sits in a window wider than 3:2 (`DISK_ANCHOR`). |
| `?rail=pack\|stretch` | Whether the details block absorbs spare rail height (`RAIL_FILL`). |
| `?tier=<index>` | Force a rail tier row. |
| `?five=1\|0` | Force the fifth country per group on or off. |

### Paths

Every link and fetch is relative to `import.meta.env.BASE_URL`. `sideHref(side)` in
`splashCopy.js` is the one place that builds a link to a visualization. `BASE_PATH=/sub/ npm run
build` must keep working.

## 3. CSS marked `@orphan`

These rules select nothing. They are marked, not deleted, so that removing them is a deliberate
step with its own review. `utilities/responsive-baseline/harness/cssaudit.py` re-runs the audit.
It reported nothing unmarked on the final tree.

| Location | Rules |
| --- | --- |
| `src/shared/styles.css:87` | `.side-title` |
| `src/shared/styles.css:107` | `.zooms-link` and its `:hover` |
| `src/shared/styles.css:135` | `.settings-toggle`, `.settings-panel` (seven rules) |
| `src/shared/styles.css:275` | `.panel-content .kv`, `.kv .k`, `.kv .v` |
| `src/shared/styles.css:298` | `.panel-content .swatch` |
| `src/shared/styles.css:310` | `.panel-content .pill`, `.badge` |
| `src/shared/CountryCircle.svelte:125` | `.ctx` (Svelte also reports it at build) |
| `src/anthromes/lib/WaffleChart.svelte:1212` | `.segment.is-selected` |
| `src/biomes/lib/BiomesChart.svelte:1389` | `.region-path` |
| `src/biomes/lib/BiomesChart.svelte:1407` | `.node circle`, `.link`, `.sgb-line`, `.hit`, `.hit.sgb-hit` |
| `src/biomes/lib/BiomesChart.svelte:1456` | `.hover-target` and the `.is-selected` rules (six selectors) |
| `src/biomes/lib/BiomesChart.svelte:1484` | Every `:global(.biomes-tooltip …)` rule to the end of the block. A hover trace, see below. |

## 4. Indirect traces that remain

These work, but they reach their result through plumbing left over from the tooltip era. Each is a
candidate for a direct replacement. None was changed in this pass, because the hover traces are
being kept until tooltips are decided.

### Biomes detail panel

`BiomesChart.createTooltipHTML()` (`BiomesChart.svelte:967`) builds an HTML string for the species
under the marker, and `showPanel()` (`:168`) dispatches it as `detail.content` together with a
structured `meta` object. `biomes/App.svelte` renders the panel entirely from `meta`. It uses
`detailContent` only as a flag for "a species is showing".

**Replace with:** dispatch `meta` alone and derive the flag from it. `createTooltipHTML()`, the
`.biomes-tooltip` CSS and the orphaned `.panel-content` rules in section 3 then have no reader.

### Anthromes detail panel

The chain is `MapCanvas.handlePointerMove()` → `buildFeatureDetail()` (`MapCanvas.svelte:1102`) →
the bound `tooltipContent` / `tooltipMeta` / `tooltipPinned` / `tooltipVisible` / `tooltipX` /
`tooltipY` props → an effect in `WaffleChart.svelte` (`:1087`) → `showPanel()` (`:344`) → a
`detail` event → `{@html detailContent}` in `anthromes/App.svelte:998`.

Since the map's click target became the country and not the pixel, nothing calls
`handlePointerMove()`, so nothing isolates a cell and this chain appears to be unreachable. The
cell leader, `cellSeries`, `isolatedPoint` and `PixelTimeline`'s cell mode hang off the same state.
Confirm that before removing anything.

**Replace with:** if cell isolation is coming back, have `MapCanvas` publish one structured
`isolatedCell` object and let `App.svelte` compose the panel from it, the way biomes does. If it
is not, the whole chain can go.

### Hover traces, kept on purpose

| Trace | State |
| --- | --- |
| `MapCanvas.handlePointerMove` (`:1029`), `handlePointerLeave` (`:1147`), `hoveredFeature` (`:372`), `tooltipPinned` | The old cell-level hover. Unwired. |
| `src/shared/Tooltip.svelte` | Imported nowhere. |
| `.biomes-tooltip` CSS in `BiomesChart.svelte` | No element carries the class. |

The live hover is separate and additive: `MapCanvas.handleCountryHover()` (`:1259`) outlines the
country under a mouse pointer on the overlay canvas. It is mouse-only
(`pointerType === 'mouse'`), draws no tooltip and selects nothing. If tooltips return, build them
on that handler and its `hoveredIso3` state, then delete the old trio.

### Fonts stored twice

`public/fonts/` serves the splash and loading pages, which load before any bundle.
`src/assets/fonts/` serves the two visualizations through Vite's asset pipeline. The files are
identical.

**Replace with:** `public/fonts/` alone, referenced from `styles.css` through `BASE_URL`. The cost
is that the font URLs lose their content hash, so check caching headers first.

### Small leftovers

- `biomes/App.svelte`: `filterRailEl` (`:201`), `viewportW` and `viewportH` (`:217`). They predate
  the stage. `layout` already carries what they were for. `viewportW` and `viewportH` still serve
  as resize triggers for the leader effect; `layout.scale` would do the same job.
- `handleDetailClose()` in `biomes/App.svelte` is an intentional no-op, because `detail-close` is
  no longer dispatched in use.
- The phylum pills are a key, not a control, so they carry no hover state. If they become a
  filter, give them the treatment the anthrome key pills have.

## 5. Rules to keep

- **3000×2000 is the regression anchor.** Every page must match
  `utilities/responsive-baseline/3000x2000/` pixel for pixel. The README there has the commands.
  The two info-modal shots are compared with `-fuzz 5%`, because the modal sits in its own fixed
  layer and its text anti-aliases differently.
- **Author in design px.** Do not read `window.innerWidth` in a component. Read `layout`.
- **Hover is mouse-only.** Every `:hover` rule added in this pass is inside
  `@media (hover: hover)`, and the map hover checks `pointerType`, so a tap never leaves anything
  lit.
- **Mark, then delete.** New dead CSS gets an `@orphan` comment and goes in the table above.
- **Do not touch the LFS paths** (`public/topojson/**/*.topojson`, `public/grid/**/*.bin`) or
  regenerate grids without a reason. They are the only files that cost bandwidth.
