<script>
  import { onMount, untrack } from 'svelte';
  import * as d3 from 'd3';
  import { geoTwoPointEquidistant } from 'd3-geo-projection';
  import * as topojson from 'topojson-client';
  import {
    loadGrid, featuresForYear, meshForGrid, featureAt, featureIndex,
    runsForYear, runBounds
  } from './gridSource.js';
  import { MAP_PROFILE, COUNTRY_SET, boundaryUrl } from '../../shared/mapProfile.js';
  import { formatYearLabel } from './dataAdapter.js';
  import { screenToDesign, renderDpr as stageRenderDpr } from '../../shared/stage.svelte.js';

  const EARTH_RADIUS_KM = 6371.0088;
  const EARTH_SURFACE_KM2 = 4 * Math.PI * EARTH_RADIUS_KM * EARTH_RADIUS_KM;

  // --- render batching -------------------------------------------------------
  // Cells are drawn grouped by anthrome code rather than one at a time. Canvas
  // state changes and colour parsing are per-batch instead of per-cell, so the
  // ~21 legend codes cost 21 beginPath/fill/stroke cycles instead of 182,503 at
  // 33km. The geometry still goes through d3.geoPath, so every projection stays
  // correct — only the bookkeeping around it collapses.
  const codeGroupCache = new WeakMap();   // FeatureCollection -> Map<code, Feature[]>

  function groupByCode(fc) {
    let groups = codeGroupCache.get(fc);
    if (!groups) {
      groups = new Map();
      for (const f of fc.features) {
        const code = f.properties?.a;
        let bucket = groups.get(code);
        if (!bucket) groups.set(code, (bucket = []));
        bucket.push(f);
      }
      codeGroupCache.set(fc, groups);
    }
    return groups;
  }

  // rgba strings, memoised per colour+opacity so d3.color() runs once per code
  // per draw style rather than once per cell.
  const rgbaCache = new Map();
  function rgbaFor(color, opacity) {
    const key = `${color}|${opacity}`;
    let out = rgbaCache.get(key);
    if (out === undefined) {
      const rgb = d3.color(color);
      out = rgb ? `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${opacity})` : color;
      rgbaCache.set(key, out);
    }
    return out;
  }

  // --- direct-projection fast path -------------------------------------------
  // d3.geoPath costs ~2.8x the raw projection math it wraps: stream machinery,
  // clipping, and adaptive resampling that subdivides every cell edge into ~10
  // canvas ops instead of 5. Measured at 33km, one draw: 433ms of geoPath
  // against 155ms to project the same corners directly.
  //
  // So this projects the rectangles itself. Crucially it subdivides each run's
  // long edges at every column boundary rather than drawing corner to corner: a
  // 64-column run spans 19.2 degrees at 33km, and the projection curves visibly
  // across that, so a straight chord pulls the edge away from its neighbours and
  // opens seams — worst exactly where one anthrome repeats across many cells.
  // Subdividing puts the outline through the same projected vertices the
  // per-cell path used, so adjacent runs and adjacent rows share them exactly
  // and the tiling is seamless by construction.
  //
  // Within one cell the remaining difference from geoPath is the ~0.02px
  // geodesic bow it would have resampled in — the same sub-pixel difference the
  // grid hit-test accepts.
  //
  // What geoPath does that this cannot is clip. Raw projection(point) ignores
  // clipAngle, so geometry straddling the projection's far rim would draw across
  // the disc. Guarded two ways: runs are capped at 64 columns (MAX_RUN_COLS),
  // and any run whose projected span exceeds maxEdgePx is dropped. The path is
  // only used when the whole sphere is visible (clipAngle >= 180); anything
  // narrower falls back to geoPath, which clips properly.
  // `year` and `currentGeo` update independently, so confirm the manifest really
  // covers this year rather than letting runsForYear throw mid-draw.
  function canUseFastPath() {
    return !!gridData && clipAngle >= 180 && gridData.yearIndex.has(year);
  }

  // --- cached map layer ------------------------------------------------------
  // Panning does not refit the projection — only ctx.translate changes — so the
  // emitted geometry is identical frame to frame. Rendering it once into an
  // offscreen canvas turns a pan into a single drawImage, which costs the same
  // at 50km as at 100km and is the only way panning gets cheap when zoomed out,
  // where there is nothing for the viewport cull to remove.
  //
  // The offscreen holds PROJECTION-space content: offscreen pixel (0,0) is
  // projection coordinate (ox, oy). Because draw() blits while still inside
  // ctx.translate(pan), drawing it at (ox, oy) lands every pixel exactly where
  // drawing directly would have.
  let layerCanvas = null;
  let layerOx = 0, layerOy = 0, layerKey = null;
  const LAYER_MARGIN = 320;   // device px of slack, so small pans stay cached

  // Everything that changes what the layer looks like. The projection is
  // identified by its own parameters rather than object identity, since draw()
  // rebuilds it on refit even when nothing visible changed.
  function computeLayerKey(projection, dpr, circle) {
    const t = projection.translate();
    return [
      gridData?.manifest?.profile, year, dpr, circle.r,
      projection.scale(), t[0], t[1], clipAngle,
      isolatedCellId, selectedCodes?.join(','),
      Object.keys(legend || {}).length
    ].join('|');
  }

  function layerCovers(cx, cy, r) {
    if (!layerCanvas) return false;
    return cx - r >= layerOx && cy - r >= layerOy &&
           cx + r <= layerOx + layerCanvas.width &&
           cy + r <= layerOy + layerCanvas.height;
  }

  // Cached result of fitExtent: the scale and translate that fit the land
  // outline into the map circle. Keyed on everything the fit depends on —
  // notably NOT the zoom, which is applied afterwards as a plain multiplier.
  // currentMesh is compared by identity; gridSource caches one mesh per profile,
  // so it is stable until the profile changes.
  let fitCache = null;

  function fittedBase(points, clipAngle, extent, mesh) {
    const key = [
      points[0][0], points[0][1], points[1][0], points[1][1],
      clipAngle, extent[0][0], extent[0][1], extent[1][0], extent[1][1]
    ].join(',');

    if (fitCache && fitCache.key === key && fitCache.mesh === mesh) {
      return fitCache;
    }

    const probe = geoTwoPointEquidistant(points[0], points[1]).clipAngle(clipAngle);
    probe.fitExtent(extent, mesh);
    fitCache = { key, mesh, scale: probe.scale(), translate: probe.translate() };
    return fitCache;
  }

  // A coarse visibility mask over the grid, used to reject runs before spending
  // any projection on them.
  //
  // This forward-projects a lattice of block corners rather than inverting the
  // visible circle. Inversion was the wrong tool: projection.invert is undefined
  // wherever the disc reaches past the edge of the projected world, and bailing
  // on that put a hard cliff in the frame time — culling was simply off below
  // zoom ~3 at a 2560px viewport, costing 274ms a frame where 57ms was
  // available. Forward projection is defined everywhere, so the mask works at
  // every zoom and pan.
  //
  // Cost is one projection per block corner: ~5,000 at 50km, under a
  // millisecond, against the ~2,000 canvas operations each culled run avoids.
  const CULL_BLOCK = 8;   // grid cells per block edge

  function buildCullMask(projection, cx, cy, r, manifest) {
    const { res, originX, originY, ncols, nrows } = manifest;
    const bcols = Math.ceil(ncols / CULL_BLOCK);
    const brows = Math.ceil(nrows / CULL_BLOCK);

    // Corner lattice, shared between neighbouring blocks so each is projected once.
    const lx = new Float64Array((bcols + 1) * (brows + 1));
    const ly = new Float64Array((bcols + 1) * (brows + 1));
    const ok = new Uint8Array((bcols + 1) * (brows + 1));
    for (let br = 0; br <= brows; br++) {
      const lat = originY - Math.min(br * CULL_BLOCK, nrows) * res;
      for (let bc = 0; bc <= bcols; bc++) {
        const lng = originX + Math.min(bc * CULL_BLOCK, ncols) * res;
        const p = projection([lng, lat]);
        const i = br * (bcols + 1) + bc;
        if (p && Number.isFinite(p[0]) && Number.isFinite(p[1])) {
          lx[i] = p[0]; ly[i] = p[1]; ok[i] = 1;
        }
      }
    }

    // A block counts as visible when its corner bbox meets the disc's bbox. The
    // margin covers the slight bow of an edge between two corners — a block is
    // 8 cells wide, where that bow is a fraction of a pixel — plus the stroke.
    const margin = 8;
    const visible = new Uint8Array(bcols * brows);
    let anyVisible = false;
    for (let br = 0; br < brows; br++) {
      for (let bc = 0; bc < bcols; bc++) {
        const i0 = br * (bcols + 1) + bc;
        const i1 = i0 + 1;
        const i2 = i0 + (bcols + 1);
        const i3 = i2 + 1;
        // A corner that will not project leaves the block's extent unknown;
        // keep it rather than risk a hole.
        if (!ok[i0] || !ok[i1] || !ok[i2] || !ok[i3]) {
          visible[br * bcols + bc] = 1; anyVisible = true; continue;
        }
        const minX = Math.min(lx[i0], lx[i1], lx[i2], lx[i3]) - margin;
        const maxX = Math.max(lx[i0], lx[i1], lx[i2], lx[i3]) + margin;
        const minY = Math.min(ly[i0], ly[i1], ly[i2], ly[i3]) - margin;
        const maxY = Math.max(ly[i0], ly[i1], ly[i2], ly[i3]) + margin;
        if (maxX >= cx - r && minX <= cx + r && maxY >= cy - r && minY <= cy + r) {
          visible[br * bcols + bc] = 1; anyVisible = true;
        }
      }
    }
    return anyVisible ? { visible, bcols, brows } : null;
  }

  // Scratch buffer for one run's outline, reused across runs to keep the draw
  // allocation-free. A run of N columns needs 2*(N+1) points.
  const runPts = new Float64Array(4 * (64 + 1) + 4);

  function drawGridRuns(ctx, projection, dpr, opts) {
    const { runs, legend, selectedSet, baseOpacity, lineWidth, maxEdgePx, cull, motion } = opts;
    const { res, originX, originY } = gridData.manifest;
    let dropped = 0;
    let culled = 0;

    ctx.lineWidth = lineWidth;
    for (const [code, runArr] of runs) {
      if (selectedSet && !selectedSet.has(code)) continue;

      const style = rgbaFor(legend[code]?.color || '#ffffff', baseOpacity);
      ctx.fillStyle = style;
      ctx.strokeStyle = style;
      ctx.beginPath();

      for (let k = 0; k < runArr.length; k += 3) {
        const row = runArr[k], c0 = runArr[k + 1], c1 = runArr[k + 2];
        // Canonical boundary expressions: an ULP difference here between a row's
        // south edge and the next row's north edge is a visible hairline seam.
        const north = originY - row * res;
        const south = originY - (row + 1) * res;

        // Reject off-screen runs before spending a single projection on them.
        // A run sits in one block row and spans a few block columns; it survives
        // if any of those blocks is on screen.
        if (cull) {
          const br = (row / 8) | 0;
          const bc0 = (c0 / 8) | 0;
          const bc1 = (c1 / 8) | 0;
          let anyVisible = false;
          const base = br * cull.bcols;
          for (let b = bc0; b <= bc1; b++) {
            if (cull.visible[base + b]) { anyVisible = true; break; }
          }
          if (!anyVisible) { culled++; continue; }
        }

        // Walk the south edge east->west, then the north edge west->east,
        // stopping at every column boundary. Same orientation as the Feature
        // path, so winding is unchanged.
        let n = 0;
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        let ok = true;

        for (let col = c1 + 1; col >= c0 && ok; col--) {
          const p = projection([originX + col * res, south]);
          if (!p) { ok = false; break; }
          runPts[n++] = p[0]; runPts[n++] = p[1];
          if (p[0] < minX) minX = p[0]; if (p[0] > maxX) maxX = p[0];
          if (p[1] < minY) minY = p[1]; if (p[1] > maxY) maxY = p[1];
        }
        for (let col = c0; col <= c1 + 1 && ok; col++) {
          const p = projection([originX + col * res, north]);
          if (!p) { ok = false; break; }
          runPts[n++] = p[0]; runPts[n++] = p[1];
          if (p[0] < minX) minX = p[0]; if (p[0] > maxX) maxX = p[0];
          if (p[1] < minY) minY = p[1]; if (p[1] > maxY) maxY = p[1];
        }

        // NaN-safe: a non-finite point fails these comparisons too.
        if (!ok || !(maxX - minX <= maxEdgePx) || !(maxY - minY <= maxEdgePx)) {
          dropped++;
          continue;
        }

        ctx.moveTo(runPts[0], runPts[1]);
        for (let i = 2; i < n; i += 2) ctx.lineTo(runPts[i], runPts[i + 1]);
        ctx.closePath();
      }

      ctx.fill();
      // The stroke only covers the hairline seams antialiasing leaves between
      // adjacent quads. It roughly doubles rasterisation, and during a transient
      // (a focus animation) the seams are never on screen long enough to read.
      if (!motion) ctx.stroke();
    }
    return { dropped, culled };
  }

  let {
    width = 0,
    height = 0,
    innerRadiusPx = 0,
    profile = MAP_PROFILE,
    year = null,
    legend = {},
    yearDataLookup = new Map(),
    selectedCodes = [],
    zoom = { k: 1, x: 0, y: 0 },
    points = $bindable([
      [-117, 33],
      [36, 4]
    ]),
    clipAngle = 180,
    mapReady = $bindable(false),
    showBoundaries = false,
    mapPanX = $bindable(0),
    mapPanY = $bindable(0),
    mapScale = $bindable(1),
    // Draw diagnostics, surfaced by the dev HUD.
    mapDrawMs = $bindable(0),
    mapLayerReused = $bindable(false),
    mapDrawPhases = $bindable(null),
    tooltipVisible = $bindable(false),
    tooltipX = $bindable(0),
    tooltipY = $bindable(0),
    tooltipContent = $bindable(''),
    tooltipMeta = $bindable(null),
    tooltipPinned = $bindable(false),
    showBarChart = $bindable(false),
    barChartData = $bindable(null),
    // The isolated cell's raw history, { id, byYear: { year: code } }. The
    // pixel ladder in the details panel plots one class per sampled year, so
    // it needs the unmerged series rather than barChartData's merged periods.
    cellSeries = $bindable(null),
    cellIsolated = $bindable(false),
    isolationReset = 0,
    // Bindable: under strictCountryFocus, isolating a single cell is a
    // finer-grained question than "show me this country", so a pixel click
    // releases the country lock upward.
    focusIso3 = $bindable(null),
    // See WaffleChart: Option 1 makes the picked country the primary state.
    strictCountryFocus = false,
    // Where the isolated cell currently sits, in DESIGN px, or null. Tracked
    // continuously so the leader line follows the cell through pans and zooms
    // instead of staying pinned to wherever the click happened to land.
    isolatedPoint = $bindable(null),
  } = $props();

  let canvasEl = $state(null);
  let projection = $state(null);
  let currentGeo = $state(null);
  let currentMesh = $state(null);
  let loading = $state(false);
  let errorMsg = $state('');
  let boundariesMesh = $state(null);
  let boundariesGeo = $state(null);
  let boundariesLoading = $state(false);
  // Decoded grid blobs for the current profile, or null until they resolve.
  let gridData = $state(null);
  let countryNamesLoaded = false;
  let iso3ToName = $state(new Map());
  const cache = new Map();
  const inFlight = new Map();
  let animRaf = null;
  let drawRaf = null;
  let drawScheduled = false;
  let projectionCache = null;
  let initialDrawDone = $state(false);
  let isAnimating = $state(false);

  // Boundary-highlight state, driven entirely by the country picker.
  let highlightedCountries = $state(new Set());
  let crossHighlightActive = $state(false);

  // Isolate pixel state
  let isolatedCellId = $state(null);

  // Hover/isolate cell border overlay
  let overlayCanvasEl = $state(null);
  let hoveredFeature = $state(null);
  let isolatedFeature = $state(null);

  // Device px per design px for both canvases here (renderDpr() in
  // stage.svelte.js). Every site reads it through this one untracked wrapper,
  // so the projection, the pan conversion and the hit tests can never disagree,
  // and so none of the effects that reach one of them picks up the stage scale
  // as a dependency. The one effect that should follow it is beside the other
  // redraw effects below.
  const renderDpr = () => untrack(stageRenderDpr);

  // Country mouseover: the iso3 under a mouse pointer, outlined on the overlay
  // canvas and nothing more — no tooltip, no selection (handleCountryHover).
  // boundaryByIso is filled by loadBoundaries().
  let hoveredIso3 = $state(null);
  let boundaryByIso = new Map();
  let countryHoverAt = null;
  let countryHoverFrame = 0;

  // Throttle pointer move for performance
  let lastPointerMoveTime = 0;
  const POINTER_MOVE_THROTTLE = 16; // ~60fps

  /**
   * Pointer event -> device px in the canvas backing store, which is what the
   * projection works in.
   *
   * The stage transform means getBoundingClientRect() no longer matches the
   * canvas's layout size, so scaling by dpr alone would be wrong. Going through
   * the backing-store/rendered-box ratio absorbs both dpr and the stage scale in
   * one step. mapPanX/Y are design px, so they still convert with dpr.
   */
  function pointerToDevice(e) {
    const rect = canvasEl.getBoundingClientRect();
    const dpr = renderDpr();
    const sx = rect.width ? canvasEl.width / rect.width : dpr;
    const sy = rect.height ? canvasEl.height / rect.height : dpr;
    return {
      x: (e.clientX - rect.left) * sx - (mapPanX || 0) * dpr,
      y: (e.clientY - rect.top) * sy - (mapPanY || 0) * dpr
    };
  }

  // Resize canvas to device pixel ratio
  function resizeCanvas() {
    if (!canvasEl) return;
    const dpr = renderDpr();
    canvasEl.width = Math.max(1, width * dpr);
    canvasEl.height = Math.max(1, height * dpr);
    canvasEl.style.width = `${width}px`;
    canvasEl.style.height = `${height}px`;
  }

  function getCircle() {
    const cx = width / 2 + (zoom?.x || 0);
    const cy = height / 2 + (zoom?.y || 0);
    const r = Math.max(0, innerRadiusPx);
    return { cx, cy, r };
  }

  function drawOverlay() {
    if (!overlayCanvasEl || !projection) return;
    const dpr = renderDpr();
    overlayCanvasEl.width = Math.max(1, width * dpr);
    overlayCanvasEl.height = Math.max(1, height * dpr);
    const ctx = overlayCanvasEl.getContext('2d');
    ctx.clearRect(0, 0, overlayCanvasEl.width, overlayCanvasEl.height);

    const hoveredCountry = hoveredIso3 && hoveredIso3 !== focusIso3
      ? boundaryByIso.get(hoveredIso3)
      : null;
    if (!hoveredFeature && !isolatedFeature && !hoveredCountry) return;

    const circle = getCircle();
    const path = d3.geoPath(projection, ctx);

    ctx.save();
    ctx.beginPath();
    ctx.arc(circle.cx * dpr, circle.cy * dpr, Math.max(0, circle.r * dpr), 0, Math.PI * 2);
    ctx.clip();
    ctx.translate((mapPanX || 0) * dpr, (mapPanY || 0) * dpr);

    if (isolatedFeature) {
      ctx.beginPath();
      path(isolatedFeature);
      ctx.strokeStyle = 'rgba(255, 255, 255, 1)';
      ctx.lineWidth = 2 * dpr;
      ctx.stroke();
    }

    // Recomputed on every overlay paint — which is every pan, zoom and year
    // change — so the leader line always points at the cell as it is now.
    updateIsolatedPoint(circle, dpr);

    if (hoveredFeature && hoveredFeature !== isolatedFeature) {
      ctx.beginPath();
      path(hoveredFeature);
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.75)';
      ctx.lineWidth = 1.5 * dpr;
      ctx.stroke();
    }

    // Same boundary feature the selection ring strokes, so the hover outline
    // and the ring a click then draws trace the same line.
    if (hoveredCountry) {
      ctx.beginPath();
      path(hoveredCountry);
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.7)';
      ctx.lineWidth = 2 * dpr;
      ctx.lineJoin = 'round';
      ctx.stroke();
    }

    ctx.restore();
  }

  /**
   * Publish the isolated cell's centre in design px, or null when there is no
   * cell (or it has been panned outside the disk, where a leader pointing at it
   * would leave the map). The overlay draws with the pan applied as a canvas
   * translate, so the same offset has to be added here by hand.
   */
  function updateIsolatedPoint(circle, dpr) {
    if (!isolatedFeature || !projection) {
      if (isolatedPoint !== null) isolatedPoint = null;
      return;
    }
    const centroid = d3.geoPath(projection).centroid(isolatedFeature);
    if (!Number.isFinite(centroid?.[0]) || !Number.isFinite(centroid?.[1])) {
      if (isolatedPoint !== null) isolatedPoint = null;
      return;
    }
    const x = centroid[0] / dpr + (mapPanX || 0);
    const y = centroid[1] / dpr + (mapPanY || 0);
    const dx = x - circle.cx;
    const dy = y - circle.cy;
    if (dx * dx + dy * dy > circle.r * circle.r) {
      if (isolatedPoint !== null) isolatedPoint = null;
      return;
    }
    // Design px are what the leader overlay draws in; screenToDesign converts
    // the canvas box, which is already design-space here, so only the stage
    // offset of the canvas itself is needed.
    const rect = overlayCanvasEl?.getBoundingClientRect();
    if (!rect) return;
    const s = rect.width ? rect.width / Math.max(1, width) : 1;
    const p = screenToDesign(rect.left + x * s, rect.top + y * s);
    if (!isolatedPoint || Math.abs(isolatedPoint.x - p.x) > 0.5 || Math.abs(isolatedPoint.y - p.y) > 0.5) {
      isolatedPoint = p;
    }
  }

  const POINT_EPS = 1e-6;
  const CIRCLE_EPS = 1e-3;
  function pointsMatch(a, b) {
    if (!a || !b) return false;
    return Math.abs(a[0] - b[0]) < POINT_EPS && Math.abs(a[1] - b[1]) < POINT_EPS;
  }
  function circlesMatch(a, b) {
    if (!a || !b) return false;
    return (
      Math.abs(a.cx - b.cx) < CIRCLE_EPS &&
      Math.abs(a.cy - b.cy) < CIRCLE_EPS &&
      Math.abs(a.r - b.r) < CIRCLE_EPS
    );
  }

  // Route all redraws through a single rAF so rapid reactive updates collapse to one paint
  function scheduleDraw() {
    if (drawScheduled) return;
    if (!currentGeo) return;
    if (isAnimating) return;
    if (width <= 0 || height <= 0 || innerRadiusPx <= 0) return;

    drawScheduled = true;
    drawRaf = requestAnimationFrame(() => {
      drawScheduled = false;
      drawRaf = null;
      if (isAnimating) return;
      performance.mark('map-draw-start');
      untrack(() => draw());
      performance.mark('map-draw-end');
      performance.measure('map-draw', 'map-draw-start', 'map-draw-end');
    });
  }


  async function loadYearData(targetYear) {
    if (!targetYear) {
      currentGeo = null;
      currentMesh = null;
      mapReady = false;
      return;
    }
    // The set is in the key because each cell feature carries properties.c —
    // the country it belongs to — and that is what the set decides.
    const key = `${profile}:${COUNTRY_SET}:${targetYear}`;
    if (cache.has(key)) {
      const cached = cache.get(key);
      currentGeo = cached.geo;
      currentMesh = cached.mesh;
      initialDrawDone = false;
      mapReady = false;
      return;
    }

    if (inFlight.has(key)) {
      await inFlight.get(key);
      return;
    }

    loading = true;
    const fetchPromise = (async () => {
      performance.mark('topo-load-start');

      try {
        mapReady = false;

        // The grid's blobs are fetched once, then every year is assembled
        // locally — no per-year request.
        const grid = await tryLoadGrid(profile);
        if (!grid) throw new Error(`No grid data for profile ${profile}`);
        const geo = featuresForYear(grid, targetYear);
        const mesh = meshForGrid(grid);

        cache.set(key, { geo, mesh });
        currentGeo = geo;
        currentMesh = mesh;
        initialDrawDone = false;
        mapReady = false;
        errorMsg = '';
        performance.mark('topo-load-end');
        performance.measure('topo-load', 'topo-load-start', 'topo-load-end');
      } catch (err) {
        console.error('MapCanvas: Failed to load data', err);
        throw err;
      }
    })();

    inFlight.set(key, fetchPromise);

    try {
      await fetchPromise;
    } catch (err) {
      console.error(err);
      errorMsg = err?.message || 'Failed to load map';
    } finally {
      inFlight.delete(key);
      loading = false;
    }
  }

  // The set the loaded mesh came from. COUNTRY_SET is pinned here, so this only
  // ever guards against a second load — but it keeps the swap honest if the set
  // is ever moved back onto a switch.
  let boundariesSet = null;

  async function loadBoundaries(set = COUNTRY_SET) {
    if (boundariesLoading) return;
    if (boundariesMesh && boundariesSet === set) return;
    boundariesLoading = true;
    try {
      const base = import.meta.env.BASE_URL;
      const url = boundaryUrl(base, set);
      const isDev = import.meta.env.DEV;
      const res = await fetch(url, { cache: isDev ? 'no-store' : 'force-cache' });
      if (!res.ok) {
        throw new Error(`Failed to load boundaries (${res.status})`);
      }
      const topo = await res.json();
      const objKey = topo.objects ? Object.keys(topo.objects)[0] : null;
      if (!objKey) {
        throw new Error('Boundaries TopoJSON missing objects');
      }
      boundariesMesh = topojson.mesh(topo, topo.objects[objKey]);
      boundariesGeo = topojson.feature(topo, topo.objects[objKey]);
      boundariesSet = set;

      const byIso = new Map();
      for (const f of boundariesGeo.features) {
        const id = f?.id ?? f?.properties?.id ?? f?.properties?.iso_a3 ?? f?.properties?.ISO_A3;
        if (id) byIso.set(id, f);
      }
      boundaryByIso = byIso;

      // Backfill display names from the boundary features. iso3_names.json is
      // hand-maintained and inherits the same ISO_A3 gap the boundaries had, so
      // without this the tooltip prints a bare "FRA" for France. Existing
      // entries win: that file carries the study's preferred short forms.
      const named = new Map(iso3ToName);
      for (const f of boundariesGeo.features) {
        const id = f?.id ?? f?.properties?.id;
        const name = f?.properties?.name;
        if (id && name && !named.has(id)) named.set(id, name);
      }
      iso3ToName = named;
    } catch (err) {
      console.error('MapCanvas: Failed to load boundaries', err);
    } finally{
      boundariesLoading = false;
    }
  }

  // Resolve a profile's grid blobs, remembering a failure so a missing profile
  // isn't re-requested on every year change.
  // Keyed by profile AND set. Only one pair is ever requested here, but the key
  // keeps a failed set from blacklisting the profile itself.
  const gridMissing = new Set();
  async function tryLoadGrid(p, set = COUNTRY_SET) {
    const key = `${p}:${set}`;
    if (gridMissing.has(key)) return null;
    try {
      const grid = await loadGrid(p, set);
      gridData = grid;
      return grid;
    } catch (err) {
      console.error('MapCanvas: Failed to load grid', err);
      gridMissing.add(key);
      if (gridData?.manifest?.profile === p) gridData = null;
      return null;
    }
  }

  // Which cell is under a lng/lat. On the grid this is arithmetic — two
  // divisions and a map lookup.
  function findCellAt(lnglat) {
    if (!currentGeo || !gridData) return null;
    return featureAt(currentGeo, gridData, lnglat[0], lnglat[1]);
  }

  async function loadCountryNames() {
    if (countryNamesLoaded) return;
    countryNamesLoaded = true;
    try {
      const base = import.meta.env.BASE_URL;
      const isDev = import.meta.env.DEV;
      const res = await fetch(`${base}data/iso3_names.json`, { cache: isDev ? 'no-store' : 'force-cache' });
      if (!res.ok) throw new Error(`Failed to load country names (${res.status})`);
      // Merged, not assigned: the boundary backfill in loadBoundaries() may
      // already have run, and these two resolve in either order. This file's
      // names take precedence — they are the study's preferred short forms.
      iso3ToName = new Map([...iso3ToName, ...Object.entries(await res.json())]);
    } catch (err) {
      console.error('MapCanvas: Failed to load country names', err);
    }
  }

  // Set by the last draw: whether the map layer was blitted from cache rather
  // than re-rendered. Surfaced in the dev HUD.
  let lastLayerReused = false;
  let lastDrawMs = 0;

  function draw(currentPoints = points, options = {}) {
    const { projectionOverride = null, skipCache = false, motion = false } = options;
    const drawStart = performance.now();
    // Phase timestamps for the dev HUD. Guessing at where draw time goes has
    // been wrong twice; this reports it instead.
    const phaseT = { proj: 0, features: 0, boundaries: 0, handles: 0, overlay: 0 };
    if (!canvasEl || !currentGeo || !currentMesh) return;
    if (width <= 0 || height <= 0 || innerRadiusPx <= 0) return;
    if (!currentPoints || currentPoints.length < 2) return;

    performance.mark('draw-setup-start');
    resizeCanvas();

    const ctx = canvasEl.getContext('2d');
    const dpr = renderDpr();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvasEl.width, canvasEl.height);

    const circle = getCircle();
    if (circle.r <= 0) {
      console.warn('MapCanvas: skipping draw, circle radius non-positive', circle);
      return;
    }

    // Clip all drawing to the inner circle
    const clipCx = circle.cx * dpr;
    const clipCy = circle.cy * dpr;
    const clipR = circle.r * dpr;
    ctx.save();
    ctx.beginPath();
    ctx.arc(clipCx, clipCy, clipR, 0, Math.PI * 2);
    ctx.clip();
    performance.mark('draw-setup-end');
    performance.measure('draw-setup', 'draw-setup-start', 'draw-setup-end');

    performance.mark('projection-create-start');
    const refitReason =
      !projectionCache ? 'no-cache' :
      projectionCache.geo !== currentGeo ? 'geo-changed' :
      projectionCache.clipAngle !== clipAngle ? 'clip-angle' :
      projectionCache.dpr !== dpr ? 'dpr' :
      !projectionCache.points ? 'no-points' :
      !pointsMatch(projectionCache.points[0], currentPoints[0]) ? 'point-a' :
      !pointsMatch(projectionCache.points[1], currentPoints[1]) ? 'point-b' :
      !circlesMatch(projectionCache.circle, circle) ? 'circle' :
      (projectionCache.zoomK || 1) !== (zoom?.k || 1) ? 'zoom-k' :
      null;

    let shouldRefit = !!refitReason;
    if (projectionOverride) {
      projection = projectionOverride;
      shouldRefit = false;
    }

    if (shouldRefit) {
      try {
        performance.mark('projection-init-start');
        const nextProj = geoTwoPointEquidistant(currentPoints[0], currentPoints[1]).clipAngle(clipAngle);
        performance.mark('projection-init-end');
        performance.measure('projection-init', 'projection-init-start', 'projection-init-end');
        const extent = [
          [circle.cx * dpr - circle.r * dpr, circle.cy * dpr - circle.r * dpr],
          [circle.cx * dpr + circle.r * dpr, circle.cy * dpr + circle.r * dpr]
        ];
        performance.mark('projection-fit-start');
        // fitExtent walks the whole land outline — 11,008 mesh segments at 50km,
        // measured at ~45ms — and it ran on every refit, including a plain zoom
        // change. But its result does NOT depend on the zoom: the code fits and
        // only then multiplies the scale. So the fit is cached against the
        // things it actually depends on (points, clip angle, mesh, extent), and
        // a zoom change now just re-applies scale and translate.
        const fit = fittedBase(currentPoints, clipAngle, extent, currentMesh);
        performance.mark('projection-fit-end');
        performance.measure('projection-fit', 'projection-fit-start', 'projection-fit-end');
        nextProj.scale(fit.scale * 0.98 * (zoom?.k || 1));
        nextProj.translate(fit.translate);
        if (!skipCache) {
          projectionCache = {
            geo: currentGeo,
            points: currentPoints.map(p => [...p]),
            clipAngle,
            circle: { ...circle },
            zoomK: zoom?.k || 1,
            dpr,
            projection: nextProj
          };
        }
        projection = nextProj;
      } catch (err) {
        console.error('Projection error', err);
        return;
      }
    }

    projection = projectionOverride || projection || projectionCache?.projection;
    const panAbsX = Math.abs((mapPanX || 0) * dpr);
    const panAbsY = Math.abs((mapPanY || 0) * dpr);
    projection.clipExtent([[-panAbsX, -panAbsY], [canvasEl.width + panAbsX, canvasEl.height + panAbsY]]);
    performance.mark('projection-create-end');
    phaseT.proj = performance.now();
    performance.measure('projection-create', 'projection-create-start', 'projection-create-end');

    performance.mark('path-setup-start');
    const path = d3.geoPath(projection, ctx);
    ctx.save();
    ctx.beginPath();
    ctx.arc(circle.cx * dpr, circle.cy * dpr, Math.max(0, circle.r * dpr), 0, Math.PI * 2);
    ctx.clip();
    ctx.translate((mapPanX || 0) * dpr, (mapPanY || 0) * dpr);

    ctx.fillStyle = '#0e0b16';
    ctx.fillRect(-canvasEl.width, -canvasEl.height, 3 * canvasEl.width, 3 * canvasEl.height);

    const allSelected = !selectedCodes || selectedCodes.length === 0;
    const totalLegend = Object.keys(legend || {}).length;
    const isCompleteSelection = selectedCodes && selectedCodes.length === totalLegend;
    const showAll = allSelected || isCompleteSelection;
    performance.mark('path-setup-end');
    performance.measure('path-setup', 'path-setup-start', 'path-setup-end');

    performance.mark('feature-render-start');
    // One path per anthrome code, not per cell. The stroke is what covers the
    // hairline seams between adjacent cells, so it still runs — just once per
    // batch, at the same width as before (1px showing all, 0.5px when filtered).
    const selectedSet = showAll ? null : new Set(selectedCodes);
    const lineWidth = (showAll ? 1 : 0.5) * dpr;
    // Isolating a cell dims everything else to 10%; the isolated cell is drawn
    // on its own afterwards so it can stay fully opaque.
    const isolating = isolatedCellId !== null;
    const baseOpacity = isolating ? 0.1 : 1.0;

    if (canUseFastPath()) {
      // Runs already exclude nothing; the isolated cell is redrawn opaque below,
      // and an opaque fill fully covers the dimmed one underneath.
      // ctx.clip() runs on the circle BEFORE ctx.translate(pan), so in projection
      // coordinates the visible disc sits at the circle centre minus the pan.
      const discCx = (circle.cx - (mapPanX || 0)) * dpr;
      const discCy = (circle.cy - (mapPanY || 0)) * dpr;
      const discR = circle.r * dpr;

      const key = computeLayerKey(projection, dpr, circle);
      const reusable = key === layerKey && layerCovers(discCx, discCy, discR)
        && !motion;

      if (!reusable) {
        // Cover the visible disc plus slack, in projection coordinates, so an
        // ordinary drag stays inside what has already been rendered.
        const size = Math.ceil(2 * discR + 2 * LAYER_MARGIN);
        if (!layerCanvas || layerCanvas.width !== size || layerCanvas.height !== size) {
          layerCanvas = document.createElement('canvas');
          layerCanvas.width = size;
          layerCanvas.height = size;
        }
        layerOx = Math.round(discCx - discR - LAYER_MARGIN);
        layerOy = Math.round(discCy - discR - LAYER_MARGIN);

        const lctx = layerCanvas.getContext('2d');
        lctx.setTransform(1, 0, 0, 1, 0, 0);
        lctx.clearRect(0, 0, layerCanvas.width, layerCanvas.height);
        lctx.translate(-layerOx, -layerOy);

        const cull = buildCullMask(
          projection, discCx, discCy, discR + LAYER_MARGIN, gridData.manifest);

        const { dropped, culled } = drawGridRuns(lctx, projection, dpr, {
          runs: runsForYear(gridData, year),
          legend,
          selectedSet,
          baseOpacity,
          lineWidth,
          maxEdgePx: Math.max(canvasEl.width, canvasEl.height),
          cull,
          motion
        });

        // A layer rendered mid-motion is deliberately lower fidelity, so do not
        // let it be reused once the map settles.
        layerKey = motion ? null : key;
      }

      // Already inside ctx.translate(pan), so (layerOx, layerOy) is exactly where
      // direct drawing would have put it — but the pan is fractional, and
      // drawImage at a fractional offset resamples, which softens every cell
      // edge. Nudge the blit so it lands on whole device pixels: the transform
      // is translate-only at scale 1, so an integral offset is a pure copy.
      // The cost is a sub-pixel shift of the layer, invisible next to the blur
      // it avoids.
      const panDX = (mapPanX || 0) * dpr;
      const panDY = (mapPanY || 0) * dpr;
      ctx.drawImage(
        layerCanvas,
        Math.round(layerOx + panDX) - panDX,
        Math.round(layerOy + panDY) - panDY
      );
      lastLayerReused = reusable;
    } else {
      ctx.lineWidth = lineWidth;
      for (const [code, bucket] of groupByCode(currentGeo)) {
        if (selectedSet && !selectedSet.has(code)) continue;

        const style = rgbaFor(legend[code]?.color || '#ffffff', baseOpacity);
        ctx.fillStyle = style;
        ctx.strokeStyle = style;

        ctx.beginPath();
        for (let i = 0; i < bucket.length; i++) {
          const feature = bucket[i];
          if (isolating && feature.properties.i === isolatedCellId) continue;
          path(feature);
        }
        ctx.fill();
        ctx.stroke();
      }
    }

    if (isolating) {
      const isolated = featureIndex(currentGeo).get(isolatedCellId);
      const code = isolated?.properties?.a;
      if (isolated && (!selectedSet || selectedSet.has(code))) {
        const style = rgbaFor(legend[code]?.color || '#ffffff', 1.0);
        ctx.fillStyle = style;
        ctx.strokeStyle = style;
        ctx.beginPath();
        path(isolated);
        ctx.fill();
        ctx.stroke();
      }
    }
    phaseT.features = performance.now();
    performance.mark('feature-render-end');
    performance.measure('feature-render', 'feature-render-start', 'feature-render-end');

    // Draw country boundaries overlay if enabled. Base pass = mesh; primary
    // highlight = 3-pass bold ring; range annotation = dashed white on top.
    if (showBoundaries && boundariesMesh) {
      performance.mark('boundaries-render-start');

      ctx.beginPath();
      path(boundariesMesh);
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.5)';
      ctx.lineWidth = 1 * dpr;
      ctx.setLineDash([]);
      ctx.stroke();

      // Primary highlight (picker-driven, single country): bold white ring
      // with a black spacer + soft outer halo. Reads unmistakably.
      if (crossHighlightActive && highlightedCountries.size > 0 && boundariesGeo) {
        const passes = [
          { style: 'rgba(255, 255, 255, 0.22)', width: 11 * dpr },
          { style: 'rgba(0, 0, 0, 0.85)',       width: 7 * dpr  },
          { style: 'rgba(255, 255, 255, 1)',    width: 4 * dpr  }
        ];
        for (const pass of passes) {
          ctx.strokeStyle = pass.style;
          ctx.lineWidth = pass.width;
          ctx.lineJoin = 'round';
          ctx.lineCap = 'round';
          ctx.setLineDash([]);
          for (const feature of boundariesGeo.features) {
            const iso3 = feature.properties?.ISO_A3 || feature.properties?.iso_a3 || feature.properties?.id;
            if (!highlightedCountries.has(iso3)) continue;
            ctx.beginPath();
            path(feature);
            ctx.stroke();
          }
        }
      }

      phaseT.boundaries = performance.now();
      performance.mark('boundaries-render-end');
      performance.measure('boundaries-render', 'boundaries-render-start', 'boundaries-render-end');
    }

    if (phaseT.boundaries === 0) phaseT.boundaries = phaseT.features;
    performance.mark('draw-cleanup-start');
    ctx.restore();
    initialDrawDone = true;
    mapReady = true;
    phaseT.handles = performance.now();
    drawOverlay();
    phaseT.overlay = performance.now();
    performance.mark('draw-cleanup-end');
    performance.measure('draw-cleanup', 'draw-cleanup-start', 'draw-cleanup-end');

    // Wall-clock cost of the whole draw, including rasterisation the JS-side
    // benchmarks cannot see. Reported in the dev HUD.
    lastDrawMs = performance.now() - drawStart;
    mapDrawMs = lastDrawMs;
    mapLayerReused = lastLayerReused;
    mapDrawPhases = {
      proj: (phaseT.proj || drawStart) - drawStart,
      features: (phaseT.features || phaseT.proj || drawStart) - (phaseT.proj || drawStart),
      boundaries: (phaseT.boundaries || phaseT.features || drawStart) - (phaseT.features || drawStart),
      handles: (phaseT.handles || drawStart) - (phaseT.boundaries || drawStart),
      overlay: (phaseT.overlay || drawStart) - (phaseT.handles || drawStart)
    };
  }

  /**
   * `ignoreFilter` is set only by the click path under the 8/21 rules, where a
   * cell click restores every anthrome anyway (App watches cellSeries). Without
   * it, clicking a cell whose class the filter currently hides would bail out
   * below and leave the panel with a ladder chart and no head — isolated, but
   * unnamed and unleadered.
   */
  function handlePointerMove(e, ignoreFilter = false) {
    // Throttle pointer move events (but not when manually triggered from click)
    if (e.type === 'pointermove') {
      const now = performance.now();
      if (now - lastPointerMoveTime < POINTER_MOVE_THROTTLE) return;
      lastPointerMoveTime = now;
    }

    if (tooltipPinned && e.type === 'pointermove') return;
    if (!projection || !currentGeo) {
      if (!tooltipPinned) {
        tooltipVisible = false;
        tooltipMeta = null;
      }
      return;
    }
    const { x, y } = pointerToDevice(e);
    const lnglat = projection.invert([x, y]);
    if (!lnglat) {
      tooltipVisible = false;
      return;
    }

    const feature = findCellAt(lnglat);
    if (!feature) {
      hoveredFeature = null;
      drawOverlay();
      tooltipVisible = false;
      tooltipMeta = null;
      return;
    }

    const code = feature.properties?.a;
    if (!ignoreFilter && selectedCodes?.length) {
      const selectedSet = new Set(selectedCodes);
      if (!selectedSet.has(code)) {
        hoveredFeature = null;
        drawOverlay();
        tooltipVisible = false;
        tooltipMeta = null;
        return;
      }
    }

    hoveredFeature = feature;
    drawOverlay();

    // Only update position if not pinned or if manually called from click.
    // Design px: this position ends up as the leader line's start point, which
    // is drawn in the design-space overlay.
    if (!tooltipPinned || e.type !== 'pointermove') {
      const p = screenToDesign(e.clientX, e.clientY);
      tooltipX = p.x;
      tooltipY = p.y;
    }

    const detail = buildFeatureDetail(feature);
    if (!detail) return;
    tooltipMeta = detail.meta;
    tooltipContent = detail.html;
    tooltipVisible = true;
  }

  /**
   * The rail's copy for one map feature at the current year: a head (swatch +
   * name) and the "In <year>, <anthrome> covers ..." sentence. App renders the
   * country facts as a pill above the head, in the format the country and world
   * scales already use, so all three read identically.
   *
   * Split out of handlePointerMove because the isolated cell has to be restated
   * whenever the YEAR changes — its anthrome is a function of the year, so
   * scrubbing time with a cell open must rewrite the panel, not stale it.
   */
  function buildFeatureDetail(feature) {
    const code = feature?.properties?.a;
    if (code == null) return null;

    const legendEntry = legend[code];
    const label = legendEntry?.label || 'Unknown';
    const color = legendEntry?.color || '#ffffff';
    const yearEntry = yearDataLookup?.get?.(year);
    const percent = yearEntry?.percentages?.[String(code)];
    const percentDisplay = percent != null ? `${percent.toFixed(2)}%` : '—';
    const globalAreaKm2 = percent != null ? (percent / 100) * EARTH_SURFACE_KM2 : null;
    const globalAreaDisplay = globalAreaKm2 != null ? `${Math.round(globalAreaKm2).toLocaleString()} km²` : '—';
    const yearLabel = formatYearLabel(year) || '';
    const countryISO3 = feature.properties?.c || null;

    const meta = {
      color,
      label,
      year: yearLabel,
      code,
      // Present-day country of this cell, for App's scope pill.
      countryIso3: countryISO3,
      countryName: countryISO3
        ? iso3ToName.get(countryISO3) || countryISO3
        : null
    };

    const html = `
      <div class="tip-head">
        <span class="chip" style="background:${color}"></span>
        <div>
          <div class="title">${label}</div>
          <div class="subtitle">Year ${yearLabel}${
            // The country IS the click target, so name it before the click
            // rather than only after.
            meta.countryName ? ` &middot; ${meta.countryName}` : ''
          }</div>
        </div>
      </div>
      <div class="summary">In <b>${yearLabel}</b>, <b>${label}</b> covers <b>${globalAreaDisplay}</b>, or <b>${percentDisplay}</b> of the Earth's surface.</div>
    `;

    return { html, meta };
  }

  function handlePointerLeave() {
    if (!tooltipPinned) {
      tooltipVisible = false;
      tooltipMeta = null;
      hoveredFeature = null;
      drawOverlay();
    }
  }

  // Single function that clears all isolation state — tooltip, chart, and cell highlight.
  // Nothing closes unless everything closes.
  function clearAll() {
    isolatedCellId = null;
    isolatedFeature = null;
    cellIsolated = false;
    showBarChart = false;
    barChartData = null;
    cellSeries = null;
    tooltipPinned = false;
    tooltipVisible = false;
    tooltipMeta = null;
    drawOverlay();
  }


  function handleGlobalClick(e) {
    if (
      e.target.closest('#info-panel') ||
      e.target.closest('.filter-rail')
    ) return;

    // Clear cross-highlighting only — isolation/tooltip/chart are closed via
    // isolationReset signal from App so the full state clears together.
    //
    // Under strictCountryFocus, clicking dead space outside the disk must
    // leave the picked country highlighted and its ring in place.
    if (strictCountryFocus && focusIso3) return;
    if (crossHighlightActive) {
      highlightedCountries = new Set();
      crossHighlightActive = false;
    }
  }

  // Is a point from pointerToDevice inside the visible disc?
  //
  // pointerToDevice subtracts the pan, so it hands back PROJECTION coordinates,
  // and the disc has to be expressed in the same space: the clip runs before
  // ctx.translate(pan), so the visible disc sits at the circle centre MINUS the
  // pan. Same expression as discCx/discCy in the fast path.
  //
  // Without the pan term this is only correct while the map is unpanned. Once
  // auto-framing moved the map, every click inside the visible disc tested as
  // outside it, so selecting a third country silently did nothing until Reset
  // zeroed the pan.
  function isInsideDisk(x, y) {
    const circle = getCircle();
    if (!(circle.r > 0)) return false;
    const dpr = renderDpr();
    const dx = x - (circle.cx - (mapPanX || 0)) * dpr;
    const dy = y - (circle.cy - (mapPanY || 0)) * dpr;
    const r = circle.r * dpr;
    return dx * dx + dy * dy <= r * r;
  }

  // Option 1: the map's click target is the country, not the pixel.
  //
  // One assignment does the whole job. focusIso3 is bindable and App binds it to
  // selectedCountryIso3, so the boundary highlight, the ?country= param, the
  // waffle ring's distribution and the details panel all follow from it —
  // exactly the state a country circle produces.
  function selectCountryAt(x, y, lnglat) {
    // A pixel is never isolated under this option; clear anything an earlier
    // option left open.
    clearAll();

    // Outside the disk is chrome, not ocean. The canvas fills its whole
    // container, so without this a click in the rail gutter would land here and
    // contradict handleGlobalClick, which deliberately protects a country
    // selection from dead-space clicks under strictCountryFocus.
    if (!isInsideDisk(x, y)) return;

    const feature = lnglat ? findCellAt(lnglat) : null;
    const iso3 = feature?.properties?.c ?? null;

    // Ocean, ice, Antarctica, and the few land cells Natural Earth leaves
    // unattributed: clicking there is how you deselect.
    if (!iso3 || iso3 === focusIso3) {
      focusIso3 = null;
      focusPanApplied = null;
      return;
    }

    // Selecting a country frames it, wherever the selection came from — map or
    // circle. Leaving focusPanApplied alone is what lets applyFocusFraming treat
    // this as a first pass and zoom.
    focusIso3 = iso3;
  }

  // Mouse-only country hover: outline the country under the pointer, the one a
  // click there would select. Touch and pen never reach past the first line, so
  // a tap cannot leave an outline behind it. Runs the click path's own chain
  // (pointerToDevice → isInsideDisk → invert → findCellAt), and repaints the
  // overlay only when the country changes.
  function setHoveredIso3(iso3) {
    if (iso3 === hoveredIso3) return;
    hoveredIso3 = iso3;
    drawOverlay();
  }

  // Coalesced to one lookup per frame on the LAST position, rather than the
  // time throttle handlePointerMove uses: a throttle drops the final move, and
  // the outline would rest on the country the pointer has just left.
  function handleCountryHover(e) {
    if (e.pointerType !== 'mouse') return;
    // A held button is a pan (WaffleChart); the outline would only trail it.
    countryHoverAt = e.buttons ? null : { clientX: e.clientX, clientY: e.clientY };
    if (countryHoverFrame) return;
    countryHoverFrame = requestAnimationFrame(() => {
      countryHoverFrame = 0;
      const at = countryHoverAt;
      if (!at || !projection || !currentGeo || !canvasEl) { setHoveredIso3(null); return; }
      const { x, y } = pointerToDevice(at);
      if (!isInsideDisk(x, y)) { setHoveredIso3(null); return; }
      const lnglat = projection.invert([x, y]);
      const feature = lnglat ? findCellAt(lnglat) : null;
      setHoveredIso3(feature?.properties?.c ?? null);
    });
  }

  function handleCountryHoverLeave() {
    countryHoverAt = null;
    setHoveredIso3(null);
  }

  // Where the pointer went down, so a drag can be told from a click. The pan
  // gesture lives in WaffleChart and leaves the canvas's own click intact, so
  // without this every pan ended in a selection change.
  //
  // Screen px on purpose: this is about how far the finger or mouse physically
  // travelled, and clientX/Y are already in that space — converting to design px
  // would make the slop shrink and grow with the stage scale. 8px is past mouse
  // jitter and inside what a touch tap drifts on a large display.
  const CLICK_SLOP_PX = 8;
  let pointerDownAt = null;

  function handleCanvasPointerDown(e) {
    pointerDownAt = { x: e.clientX, y: e.clientY };
  }

  function handleCanvasClick(e) {
    if (!projection || !currentGeo) return;

    const down = pointerDownAt;
    pointerDownAt = null;
    if (down) {
      const ddx = e.clientX - down.x;
      const ddy = e.clientY - down.y;
      if (ddx * ddx + ddy * ddy > CLICK_SLOP_PX * CLICK_SLOP_PX) return;
    }

    const { x, y } = pointerToDevice(e);
    const lnglat = projection.invert([x, y]);

    // The click target is the COUNTRY, not the pixel: touching anywhere on
    // land selects that cell's country, the same end state a country circle
    // reaches.
    selectCountryAt(x, y, lnglat);
  }

  onMount(() => {
    resizeCanvas();
    loadCountryNames();

    // Add global click listener for clearing cross-highlight
    window.addEventListener('click', handleGlobalClick);

    return () => {
      window.removeEventListener('click', handleGlobalClick);
      if (countryHoverFrame) cancelAnimationFrame(countryHoverFrame);
    };
  });

  // Reload data when the year changes. `profile` is read here (not just inside
  // loadYearData) so a resolution change would actually refetch — the tile cache
  // is keyed by profile:set:year, and the set half of that key is pinned.
  $effect(() => {
    if (!year) return;
    profile;

    untrack(() => {
      (async () => {
        try {
          await loadYearData(year);
        } catch (err) {
          console.error('MapCanvas: Failed to load year data', err);
        }
      })();
    });
  });

  // Unified effect for all draw triggers (prevents redundant calls)
  // Geometry-dependent redraws (initial draw): wait for size/geo/points readiness
  $effect(() => {
    currentGeo;
    currentMesh;
    points;
    clipAngle;
    width;
    height;
    innerRadiusPx;

    scheduleDraw();
  });

  // The backing store follows the stage scale where the stage is magnified
  // (renderDpr), so a resize that changes only the scale still needs a redraw.
  // draw() refits the projection on a dpr change by itself.
  $effect(() => {
    stageRenderDpr();
    if (initialDrawDone) scheduleDraw();
  });

  // Visual-only redraws (selection/legend/zoom) after first draw is done
  $effect(() => {
    initialDrawDone;
    selectedCodes;
    legend;
    zoom?.k;
    zoom?.x;
    zoom?.y;
    mapPanX;
    mapPanY;
    showBoundaries;
    boundariesMesh;
    boundariesGeo;
    crossHighlightActive;
    highlightedCountries;
    isolatedCellId;

    if (initialDrawDone) {
      scheduleDraw();
    }
  });

  // Country picker: selecting a country strokes its boundary.
  // NOTE: we no longer reset pan/scale here on clear — that decision belongs
  // to the parent App, which distinguishes "picker deselect" (reset view)
  // from "pan-cleared" (keep the panned view).
  let focusPanApplied = $state(null); // last ISO3 we've panned/zoomed for
  $effect(() => {
    if (focusIso3) {
      highlightedCountries = new Set([focusIso3]);
      crossHighlightActive = true;
    } else if (crossHighlightActive && highlightedCountries.size <= 1) {
      highlightedCountries = new Set();
      crossHighlightActive = false;
      focusPanApplied = null;
      focusNeedsCorrection = false;
    }
  });

  // Zoom + pan the map to the selected country's boundary. Runs whenever the
  // focus target changes or the projection first becomes available for that
  // target (initial mount case). Uses the country's canvas-projected centroid
  // and bbox to compute the pan needed to center it, and a scale that fills
  // roughly 55% of the inner circle. Nothing happens for URL-param highlights
  // (multi-country) — they keep the current view.
  $effect(() => {
    focusIso3;
    projection;
    boundariesGeo;
    innerRadiusPx;
    untrack(() => applyFocusFraming());
  });

  // Set once the first pass has moved the map; the next projection rebuild then
  // gets one corrective pass. See the note in applyFocusFraming.
  let focusNeedsCorrection = false;

  function applyFocusFraming() {
    if (!focusIso3 || !projection || !boundariesGeo || innerRadiusPx <= 0) return;
    const firstPass = focusPanApplied !== focusIso3;
    if (!firstPass && !focusNeedsCorrection) return;

    const feature = boundariesGeo.features.find(f => {
      const id = f?.id ?? f?.properties?.id ?? f?.properties?.iso_a3 ?? f?.properties?.ISO_A3;
      return id === focusIso3;
    });
    if (!feature) return;

    const centroid = d3.geoCentroid(feature);
    if (!Number.isFinite(centroid?.[0])) return;

    const dpr = renderDpr();
    const circle = getCircle();

    const projected = projection(centroid);
    if (!projected) return;
    const pxDesign = projected[0] / dpr;
    const pyDesign = projected[1] / dpr;

    // Bounds are in canvas coords (dpr); span in design px.
    //
    // Measure with clipping OFF. The live projection carries a clipExtent sized
    // to the current pan, so a country outside the current view projects to an
    // empty bounds of [[Inf,Inf],[-Inf,-Inf]] — and the Math.max(1, ...) below
    // silently turned that into a 1px span, a huge multiplier, and a maximal
    // zoom. Focusing China after Tanzania hit exactly this: China fell wholly
    // outside the clip window, so it framed at 7 instead of 2.02. The framing
    // needs the whole country's extent, not the visible part of it.
    const savedClip = projection.clipExtent();
    let bounds;
    try {
      projection.clipExtent(null);
      bounds = framedBounds(feature);
    } finally {
      projection.clipExtent(savedClip);
    }
    const [[minX, minY], [maxX, maxY]] = bounds;

    // An unclipped bounds should always be finite; if it isn't, the geometry is
    // degenerate and any scale derived from it would be nonsense. Leave the view
    // alone rather than snapping to a wrong one.
    if (!Number.isFinite(minX) || !Number.isFinite(maxX) ||
        !Number.isFinite(minY) || !Number.isFinite(maxY)) return;

    // Centre on the projected BOUNDING BOX rather than the spherical centroid —
    // they agree for compact countries but not for China (the western bulge
    // drags the centroid off the shape's visual middle) or the USA (Alaska lifts
    // the box well above it). The box is what the eye reads as centred.
    //
    // BOTH passes anchor on this same point. When the first pass predicted the
    // centroid and the second measured the box, the difference between them
    // showed up as a visible drift a frame or two after the click — the second
    // pass was correcting the first rather than confirming it.
    const boxCx = (minX + maxX) / 2 / dpr;
    const boxCy = (minY + maxY) / 2 / dpr;
    // A single polygon straddling the projection's seam would still project to a
    // box spanning the whole plane (framedBounds only drops whole pieces); fall
    // back to the centroid, which is computed on the sphere and has no seam.
    //
    // The limit is in radians of arc — box span over projection.scale() — so it
    // reads the same at every zoom. It used to be a pixel limit (4 x the disk
    // radius), which the box outgrows simply by being zoomed in: from zoom 7 the
    // USA measured just over 4 radii, so the first pass fell back to the centroid while
    // the second, measured at the new zoom, passed and used the box. The map
    // settled on one point and then visibly jumped to the other.
    const projScale = projection.scale();
    const boxSane =
      Number.isFinite(boxCx) && Number.isFinite(boxCy) &&
      (maxX - minX) / projScale < FOCUS_BOX_MAX_RAD &&
      (maxY - minY) / projScale < FOCUS_BOX_MAX_RAD;
    const anchorX = boxSane ? boxCx : pxDesign;
    const anchorY = boxSane ? boxCy : pyDesign;

    // Second pass: the projection has now been rebuilt at the target scale, so
    // the country's position is a measurement rather than a prediction. With the
    // first pass anchored on the same box centre this should be a no-op; it
    // stays as a safety net for clamped scales and odd shapes.
    if (!firstPass) {
      mapPanX = circle.cx - anchorX;
      mapPanY = circle.cy - anchorY;
      focusNeedsCorrection = false;
      return;
    }

    const spanPx = Math.max(1, Math.max(maxX - minX, maxY - minY)) / dpr;
    const targetDiameter = circle.r * 2 * 0.55;
    const scaleMultiplier = spanPx > 0 ? targetDiameter / spanPx : 1;
    const currentScale = mapScale || 1;
    const nextScale = Math.max(1, Math.min(7, currentScale * scaleMultiplier));

    // Predict where that anchor lands at the new scale. Every projected point
    // scales about the projection's translate, so the bounds box — and its
    // centre — moves the same way, which makes this prediction exact rather
    // than approximate. The fixed point of a
    // scale change is the projection's TRANSLATE, not the circle centre: draw()
    // runs fitExtent (which sets translate so the whole world's bbox centres in
    // the circle) and only then multiplies the scale, leaving translate alone.
    // Those two points differ — the world's projected bbox centre is not the
    // circle centre — so centring on the circle instead put every country off
    // by that constant, which is why the miss always leaned the same way.
    const [tx, ty] = projection.translate();
    const txDesign = tx / dpr;
    const tyDesign = ty / dpr;
    const scaleRatio = nextScale / currentScale;
    const predictedX = txDesign + (anchorX - txDesign) * scaleRatio;
    const predictedY = tyDesign + (anchorY - tyDesign) * scaleRatio;

    // Batch all three writes; Svelte flushes them in one tick so only one draw
    // runs downstream instead of a scale-draw-refit-effect-pan-draw chain.
    mapScale = nextScale;
    mapPanX = circle.cx - predictedX;
    mapPanY = circle.cy - predictedY;
    focusPanApplied = focusIso3;
    // The refit that follows gives this effect one more run; take it as a
    // chance to correct any residue (odd-shaped countries, clamped scale).
    // Only a scale change refits. Without one (two small countries in a row,
    // both clamped to 7) the flag would sit armed until some later, unrelated
    // rebuild and re-centre the map under the user then.
    focusNeedsCorrection = nextScale !== currentScale;
  }

  // Widest box the framing will trust, in radians of arc along either axis.
  // The widest real one is France with its overseas departments at 2.2; a box
  // split by the seam starts at 3.2.
  const FOCUS_BOX_MAX_RAD = 2.6;
  // A piece counts as across the seam when it projects this many times further
  // from the main polygon than it is on the sphere. Across all 242 features the
  // honest ratios top out at 2.0 and the split ones start at 4.0.
  const FOCUS_SEAM_RATIO = 3;

  // The spherical facts about a feature's polygons: projection-independent, so
  // measured once per feature. Largest first.
  const focusPartsCache = new WeakMap();
  function focusParts(feature) {
    let parts = focusPartsCache.get(feature);
    if (parts) return parts;
    const g = feature.geometry;
    const polygons = g?.type === 'MultiPolygon' ? g.coordinates
      : g?.type === 'Polygon' ? [g.coordinates] : [];
    parts = polygons.map(coordinates => {
      const geometry = { type: 'Polygon', coordinates };
      return { geometry, area: d3.geoArea(geometry), centroid: d3.geoCentroid(geometry) };
    }).sort((a, b) => b.area - a.area);
    focusPartsCache.set(feature, parts);
    return parts;
  }

  // Projected bounds of the part of a country that can be framed together: its
  // largest polygon plus every other polygon on the same side of the seam.
  //
  // The two-point equidistant projection has a seam — the arc between the
  // antipodes of its two control points, which runs through the Southern Ocean
  // south of Tasmania and across New Zealand's waters. Land either side of it
  // lands on opposite rims of the map. Australia's Macquarie Island is across
  // it: the mainland draws at the top of the disk and the island at the bottom,
  // so the country's box was the full height of the world, the framing scale
  // clamped to 1, and selecting Australia left the map at world level. New
  // Zealand (Auckland, Campbell and Chatham Islands) did the same.
  //
  // No view can hold both sides, so frame the side the country is on. Both
  // distances scale together with the zoom, so the test reads the same at any.
  function framedBounds(feature) {
    const path = d3.geoPath(projection);
    const parts = focusParts(feature);
    const main = parts[0];
    const mainXY = main && projection(main.centroid);
    if (!mainXY || parts.length < 2) return path.bounds(feature);

    const scale = projection.scale();
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const part of parts) {
      if (part !== main) {
        const xy = projection(part.centroid);
        if (!xy) continue;
        const planar = Math.hypot(xy[0] - mainXY[0], xy[1] - mainXY[1]);
        const onSphere = d3.geoDistance(part.centroid, main.centroid) * scale;
        if (planar > FOCUS_SEAM_RATIO * onSphere) continue;
      }
      const [[x0, y0], [x1, y1]] = path.bounds(part.geometry);
      if (x0 < minX) minX = x0;
      if (y0 < minY) minY = y0;
      if (x1 > maxX) maxX = x1;
      if (y1 > maxY) maxY = y1;
    }
    return [[minX, minY], [maxX, maxY]];
  }

  // Load boundaries when toggled on, and reload them when the country set
  // changes — the overlay geometry and the grid's country codes come from the
  // same shapefile and have to be swapped together, or a cell's code resolves
  // against the wrong set's ids and every dependency stops highlighting.
  $effect(() => {
    const set = COUNTRY_SET;
    if (showBoundaries && !boundariesLoading && boundariesSet !== set) {
      loadBoundaries(set);
    }
  });

  // Switching resolution invalidates everything keyed to the old grid: cell ids
  // are per-profile, so an isolated cell would point at a different patch of
  // land.
  let loadedProfile = null;
  $effect(() => {
    const p = profile;
    untrack(() => {
      if (loadedProfile === null) { loadedProfile = p; return; }
      if (loadedProfile === p) return;
      loadedProfile = p;
      clearAll();
      gridData = null;
    });
  });

  // An isolated cell's anthrome is a function of the year, so scrubbing time
  // has to restate the panel rather than leave last year's reading in place.
  // currentGeo is a new object for each year; re-find the same cell id in it.
  $effect(() => {
    year;
    currentGeo;
    untrack(() => {
      if (isolatedCellId == null || !currentGeo) return;
      const next = currentGeo.features.find(f => f.properties?.i === isolatedCellId);
      if (!next) return;
      isolatedFeature = next;
      const detail = buildFeatureDetail(next);
      if (detail) {
        tooltipMeta = detail.meta;
        tooltipContent = detail.html;
        tooltipVisible = true;
        tooltipPinned = true;
      }
      drawOverlay();
    });
  });

  // Clear all isolation state when isolationReset signal increments
  $effect(() => {
    const reset = isolationReset;
    if (reset > 0) {
      untrack(() => clearAll());
    }
  });

</script>

<div class="map-layer" style={`width:${width}px;height:${height}px;`}>
  <canvas
    bind:this={canvasEl}
    aria-label="Anthromes map"
    onpointerdown={handleCanvasPointerDown}
    onpointermove={handleCountryHover}
    onpointerleave={handleCountryHoverLeave}
    onclick={handleCanvasClick}
  ></canvas>

  <canvas
    bind:this={overlayCanvasEl}
    class="overlay-canvas"
    aria-hidden="true"
  ></canvas>

  {#if loading}
    <div class="loading">Loading map…</div>
  {:else if (!mapReady)}
    <div class="loading">Rendering map…</div>
  {/if}
  {#if errorMsg && !loading}
    <div class="loading error">Error: {errorMsg}</div>
  {/if}
</div>



<style>
  .map-layer {
    position: absolute;
    inset: 0;
    margin: auto;
    z-index: 1;
    pointer-events: none;
  }

  canvas {
    width: 100%;
    height: 100%;
    display: block;
    pointer-events: auto;
  }

  .overlay-canvas {
    position: absolute;
    inset: 0;
    pointer-events: none;
  }

  .loading {
    position: absolute;
    top: 12px;
    right: 12px;
    background: rgba(0, 0, 0, 0.65);
    padding: 8px 12px;
    border-radius: 8px;
    font-size: 12px;
    color: #e5e7eb;
    border: 1px solid rgba(255, 255, 255, 0.12);
  }

  .loading.error {
    border-color: rgba(255, 107, 107, 0.4);
    color: #ff9ca1;
  }


</style>
