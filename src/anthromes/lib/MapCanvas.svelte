<script>
  import { onMount, untrack } from 'svelte';
  import * as d3 from 'd3';
  import { geoTwoPointEquidistant } from 'd3-geo-projection';
  import * as topojson from 'topojson-client';
  import { TOPO_PROFILE, USE_PIXEL_BOUNDARIES } from './constants.js';
  import { formatYearLabel, parseYearString, sortYears } from './dataAdapter.js';
  import { screenToDesign } from '../../shared/stage.svelte.js';
  import { uiOption } from '../../shared/uiOption.svelte.js';

  const EARTH_RADIUS_KM = 6371.0088;
  const EARTH_SURFACE_KM2 = 4 * Math.PI * EARTH_RADIUS_KM * EARTH_RADIUS_KM;

  let {
    width = 0,
    height = 0,
    innerRadiusPx = 0,
    profile = TOPO_PROFILE,
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
    debugMenuVisible = false,
    mapPanX = $bindable(0),
    mapPanY = $bindable(0),
    mapScale = $bindable(1),
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
    // Option 1 renders the cell's country facts as a pill in the rail, so the
    // detail HTML omits its key/value block and biomes cross-link.
    compactCellDetail = false,
    // Where the isolated cell currently sits, in DESIGN px, or null. Tracked
    // continuously so the leader line follows the cell through pans and zooms
    // instead of staying pinned to wherever the click happened to land.
    isolatedPoint = $bindable(null),
    // Overlay annotation: multi-country highlight coming from the biomes side.
    // Kept separate from the primary picker highlight so we can render both
    // with distinct visual language (primary = bold white ring, range =
    // dashed white on top). App renders a dismissible rail tag off these.
    rangeIso3s = $bindable(new Set()),
    rangeSource = $bindable(null), // { kind, label, sgbId } | null
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
  let cellHistory = $state(null);
  let cellHistoryLoading = $state(false);
  let countryData = $state(null);
  let countryDataLoading = $state(false);
  let iso3ToName = $state(new Map());
  const cache = new Map();
  const inFlight = new Map();
  let draggingHandle = $state(false);
  let animRaf = null;
  let drawRaf = null;
  let drawScheduled = false;
  let projectionCache = null;
  let initialDrawDone = $state(false);
  let isAnimating = $state(false);

  // Cross-highlighting state
  let highlightedCountries = $state(new Set());
  let crossHighlightActive = $state(false);

  // Isolate pixel state
  let isolatedCellId = $state(null);

  // Hover/isolate cell border overlay
  let overlayCanvasEl = $state(null);
  let hoveredFeature = $state(null);
  let isolatedFeature = $state(null);

  // Throttle pointer move for performance
  let lastPointerMoveTime = 0;
  const POINTER_MOVE_THROTTLE = 16; // ~60fps

  // Handle positions for the two-point projection controls
  let handlePositions = $state([
    { x: 0, y: 0, visible: false },
    { x: 0, y: 0, visible: false }
  ]);

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
    const dpr = window.devicePixelRatio || 1;
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
    const dpr = window.devicePixelRatio || 1;
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
    const dpr = window.devicePixelRatio || 1;
    overlayCanvasEl.width = Math.max(1, width * dpr);
    overlayCanvasEl.height = Math.max(1, height * dpr);
    const ctx = overlayCanvasEl.getContext('2d');
    ctx.clearRect(0, 0, overlayCanvasEl.width, overlayCanvasEl.height);

    if (!hoveredFeature && !isolatedFeature) return;

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
    if (!currentGeo || draggingHandle) return;
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
    const key = `${profile}:${targetYear}`;
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
      const base = import.meta.env.BASE_URL;
      const url = `${base}topojson/${profile}/${targetYear}.topojson`;

      try {
        mapReady = false;
        const res = await fetch(url, { cache: 'no-cache' });
        if (!res.ok) {
          throw new Error(`Failed to load ${url} (${res.status})`);
        }

        const text = await res.text();
        const topo = JSON.parse(text);

        const objKey = topo.objects ? Object.keys(topo.objects)[0] : null;
        if (!objKey || !topo.objects[objKey]) {
          throw new Error(`TopoJSON missing objects at ${url}`);
        }

        const geo = topojson.feature(topo, topo.objects[objKey]);
        const mesh = topojson.mesh(topo, topo.objects[objKey]);
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

  async function loadBoundaries() {
    if (boundariesMesh || boundariesLoading) return;
    boundariesLoading = true;
    try {
      const base = import.meta.env.BASE_URL;
      // Use pixel-snapped boundaries (matches anthrome grid) or smooth Natural Earth boundaries
      const url = USE_PIXEL_BOUNDARIES
        ? `${base}topojson/admin-boundaries/${TOPO_PROFILE}/countries.topojson`
        : `${base}topojson/admin-boundaries/countries-110m.topojson`;
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
    } catch (err) {
      console.error('MapCanvas: Failed to load boundaries', err);
    } finally{
      boundariesLoading = false;
    }
  }

  async function loadCellHistory() {
    if (cellHistory || cellHistoryLoading) return;
    cellHistoryLoading = true;
    try {
      const base = import.meta.env.BASE_URL;
      const url = `${base}data/cell-history-${profile}.json`;
      const isDev = import.meta.env.DEV;
      const res = await fetch(url, { cache: isDev ? 'no-store' : 'force-cache' });
      if (!res.ok) {
        throw new Error(`Failed to load cell history (${res.status})`);
      }
      cellHistory = await res.json();
    } catch (err) {
      console.error('MapCanvas: Failed to load cell history', err);
    } finally {
      cellHistoryLoading = false;
    }
  }

  async function loadCountryData() {
    if (countryData || countryDataLoading) return;
    countryDataLoading = true;
    try {
      const base = import.meta.env.BASE_URL;
      const isDev = import.meta.env.DEV;

      const [countryRes, namesRes] = await Promise.all([
        fetch(`${base}data/country_index.json`, { cache: isDev ? 'no-store' : 'force-cache' }),
        fetch(`${base}data/iso3_names.json`,    { cache: isDev ? 'no-store' : 'force-cache' }),
      ]);

      if (!countryRes.ok) throw new Error(`Failed to load country data (${countryRes.status})`);
      countryData = new Map(Object.entries(await countryRes.json()));

      if (namesRes.ok) {
        iso3ToName = new Map(Object.entries(await namesRes.json()));
      }
    } catch (err) {
      console.error('MapCanvas: Failed to load country data', err);
    } finally {
      countryDataLoading = false;
    }
  }

  function updateHandles(currentPoints = points) {
    if (!projection || !currentPoints || currentPoints.length < 2) {
      handlePositions = handlePositions.map(h => ({ ...h, visible: false }));
      return;
    }
    const dpr = window.devicePixelRatio || 1;
    const next = currentPoints.map(pt => {
      const proj = projection(pt);
      if (!proj) return { x: 0, y: 0, visible: false };
      return { x: proj[0] / dpr + mapPanX, y: proj[1] / dpr + mapPanY, visible: true };
    });
    handlePositions = next;
  }

  function draw(currentPoints = points, options = {}) {
    const { projectionOverride = null, skipCache = false } = options;
    if (!canvasEl || !currentGeo || !currentMesh) return;
    if (width <= 0 || height <= 0 || innerRadiusPx <= 0) return;
    if (!currentPoints || currentPoints.length < 2) return;

    performance.mark('draw-setup-start');
    resizeCanvas();

    const ctx = canvasEl.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
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
        // Use mesh (shared arcs) for bounds; fewer coords than full feature collection
        nextProj.fitExtent(extent, currentMesh);
        performance.mark('projection-fit-end');
        performance.measure('projection-fit', 'projection-fit-start', 'projection-fit-end');
        nextProj.scale(nextProj.scale() * 0.98 * (zoom?.k || 1));
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
        if (debugMenuVisible) {
          console.debug('MapCanvas: refit projection', refitReason);
        }
      } catch (err) {
        console.error('Projection error', err);
        return;
      }
    } else if (debugMenuVisible) {
      console.debug('MapCanvas: reuse projection cache');
    }

    projection = projectionOverride || projection || projectionCache?.projection;
    const panAbsX = Math.abs((mapPanX || 0) * dpr);
    const panAbsY = Math.abs((mapPanY || 0) * dpr);
    projection.clipExtent([[-panAbsX, -panAbsY], [canvasEl.width + panAbsX, canvasEl.height + panAbsY]]);
    performance.mark('projection-create-end');
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
    // Draw features directly (matches test-anthromes-d3.html approach)
    if (showAll) {
      for (let i = 0; i < currentGeo.features.length; i++) {
        const feature = currentGeo.features[i];
        const code = feature.properties?.a;
        const cellId = feature.properties?.i;
        const color = legend[code]?.color || '#ffffff';

        // Determine opacity for isolate pixel feature
        let opacity = 1.0;
        if (isolatedCellId !== null && cellId !== isolatedCellId) {
          opacity = 0.1; // 90% transparent
        }

        // Parse color and apply opacity
        const rgb = d3.color(color);
        if (rgb) {
          ctx.fillStyle = `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${opacity})`;
          ctx.strokeStyle = `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${opacity})`;
        } else {
          ctx.fillStyle = color;
          ctx.strokeStyle = color;
        }

        ctx.beginPath();
        path(feature);
        ctx.fill();
        ctx.lineWidth = 1 * dpr;
        ctx.stroke();
      }
    } else {
      const selectedSet = new Set(selectedCodes);
      for (let i = 0; i < currentGeo.features.length; i++) {
        const feature = currentGeo.features[i];
        const code = feature.properties?.a;
        if (!selectedSet.has(code)) continue;

        const cellId = feature.properties?.i;
        const color = legend[code]?.color || '#ffffff';

        // Determine opacity for isolate pixel feature
        let opacity = 1.0;
        if (isolatedCellId !== null && cellId !== isolatedCellId) {
          opacity = 0.1; // 90% transparent
        }

        // Parse color and apply opacity
        const rgb = d3.color(color);
        if (rgb) {
          ctx.fillStyle = `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${opacity})`;
          ctx.strokeStyle = `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${opacity})`;
        } else {
          ctx.fillStyle = color;
          ctx.strokeStyle = color;
        }

        ctx.beginPath();
        path(feature);
        ctx.fill();
        ctx.lineWidth = 0.5 * dpr;
        ctx.stroke();
      }
    }
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

      // Range annotation (from biomes species): dashed white on top. Draws
      // last so it sits above the primary bold ring — countries that are
      // both primary and range read as a dashed white inside a bold halo.
      if (rangeIso3s && rangeIso3s.size > 0 && boundariesGeo) {
        // Subtle dark backing so the dashes read on light-colored anthrome
        // fills as well as dark ones.
        ctx.strokeStyle = 'rgba(0, 0, 0, 0.55)';
        ctx.lineWidth = 5 * dpr;
        ctx.setLineDash([]);
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';
        for (const feature of boundariesGeo.features) {
          const iso3 = feature.properties?.ISO_A3 || feature.properties?.iso_a3 || feature.properties?.id;
          if (!rangeIso3s.has(iso3)) continue;
          ctx.beginPath();
          path(feature);
          ctx.stroke();
        }
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.95)';
        ctx.lineWidth = 2.4 * dpr;
        ctx.setLineDash([6 * dpr, 5 * dpr]);
        for (const feature of boundariesGeo.features) {
          const iso3 = feature.properties?.ISO_A3 || feature.properties?.iso_a3 || feature.properties?.id;
          if (!rangeIso3s.has(iso3)) continue;
          ctx.beginPath();
          path(feature);
          ctx.stroke();
        }
        ctx.setLineDash([]);
      }

      performance.mark('boundaries-render-end');
      performance.measure('boundaries-render', 'boundaries-render-start', 'boundaries-render-end');
    }

    performance.mark('draw-cleanup-start');
    ctx.restore();
    updateHandles(currentPoints);
    initialDrawDone = true;
    mapReady = true;
    drawOverlay();
    performance.mark('draw-cleanup-end');
    performance.measure('draw-cleanup', 'draw-cleanup-start', 'draw-cleanup-end');
  }

  function animateProjection(fromPts, toPts) {
    if (!fromPts || !toPts || fromPts.length < 2 || toPts.length < 2) return;
    if (animRaf) cancelAnimationFrame(animRaf);
    if (drawRaf) {
      cancelAnimationFrame(drawRaf);
      drawRaf = null;
      drawScheduled = false;
    }
    isAnimating = true;

    const interp = [
      d3.interpolateNumber(fromPts[0][0], toPts[0][0]),
      d3.interpolateNumber(fromPts[0][1], toPts[0][1]),
      d3.interpolateNumber(fromPts[1][0], toPts[1][0]),
      d3.interpolateNumber(fromPts[1][1], toPts[1][1])
    ];
    const duration = 500;
    const ease = t => t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
    const start = performance.now();

    const dpr = window.devicePixelRatio || 1;
    const circle = getCircle();
    const extent = [
      [circle.cx * dpr - circle.r * dpr, circle.cy * dpr - circle.r * dpr],
      [circle.cx * dpr + circle.r * dpr, circle.cy * dpr + circle.r * dpr]
    ];

    // Start projection params
    let startProj = projectionCache?.projection || projection;
    if (!startProj) {
      try {
        startProj = geoTwoPointEquidistant(fromPts[0], fromPts[1]).clipAngle(clipAngle);
        startProj.fitExtent(extent, currentMesh || currentGeo);
        startProj.scale(startProj.scale() * 0.98 * (zoom?.k || 1));
        startProj.clipExtent([[0, 0], [canvasEl.width, canvasEl.height]]);
      } catch (err) {
        console.error('Projection error (start)', err);
      }
    }
    const startScale = startProj?.scale() || 1;
    const startTranslate = startProj?.translate ? startProj.translate() : [0, 0];

    // Final projection params (heavy work once)
    let finalProjection = null;
    let endScale = startScale;
    let endTranslate = startTranslate;
    try {
      const proj = geoTwoPointEquidistant(toPts[0], toPts[1]).clipAngle(clipAngle);
      proj.fitExtent(extent, currentMesh || currentGeo);
      proj.scale(proj.scale() * 0.98 * (zoom?.k || 1));
      proj.clipExtent([[0, 0], [canvasEl.width, canvasEl.height]]);
      finalProjection = proj;
      endScale = proj.scale();
      endTranslate = proj.translate();
    } catch (err) {
      console.error('Projection error (final)', err);
    }

    function step(now) {
      const t = Math.min(1, (now - start) / duration);
      const k = ease(t);
      const pts = [
        [interp[0](k), interp[1](k)],
        [interp[2](k), interp[3](k)]
      ];

      // Build interpolated projection without running fitExtent every frame
      const proj = geoTwoPointEquidistant(pts[0], pts[1]).clipAngle(clipAngle);
      const lerpScale = startScale + (endScale - startScale) * k;
      const lerpTx = startTranslate[0] + (endTranslate[0] - startTranslate[0]) * k;
      const lerpTy = startTranslate[1] + (endTranslate[1] - startTranslate[1]) * k;
      proj.scale(lerpScale);
      proj.translate([lerpTx, lerpTy]);
      proj.clipExtent([[0, 0], [canvasEl.width, canvasEl.height]]);

      draw(pts, { projectionOverride: proj, skipCache: true });
      if (t < 1) {
        animRaf = requestAnimationFrame(step);
      } else {
        animRaf = null;
        points = toPts;
        if (finalProjection) {
          projectionCache = {
            geo: currentGeo,
            points: toPts.map(p => [...p]),
            clipAngle,
            circle: { ...circle },
            zoomK: zoom?.k || 1,
            dpr,
            projection: finalProjection
          };
          projection = finalProjection;
          draw(toPts, { projectionOverride: finalProjection, skipCache: false });
        } else {
          draw(toPts);
        }
        isAnimating = false;
      }
    }

    animRaf = requestAnimationFrame(step);
  }

  function handlePointerMove(e) {
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

    const feature = currentGeo.features.find(f => d3.geoContains(f, lnglat));
    if (!feature) {
      hoveredFeature = null;
      drawOverlay();
      tooltipVisible = false;
      tooltipMeta = null;
      return;
    }

    const code = feature.properties?.a;
    if (selectedCodes?.length) {
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
   * name), the "In <year>, <anthrome> covers ..." sentence, and — for the older
   * arrangements — a key/value block plus the cross-link to biomes.
   *
   * Option 1 drops that block (compactCellDetail): App renders the same country
   * facts as a pill above the head, in the format the country and world scales
   * already use, so all three read identically.
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
    const crosswalk = countryData?.get(countryISO3);

    let westPercent = 0;
    if (crosswalk) {
      const westYes = crosswalk.westernized_counts?.Yes || 0;
      const westNo = crosswalk.westernized_counts?.No || 0;
      const westTotal = westYes + westNo;
      westPercent = westTotal > 0 ? ((westYes / westTotal) * 100).toFixed(1) : 0;
    }

    const meta = {
      color,
      label,
      year: yearLabel,
      code,
      // Present-day country of this cell, for App's scope pill.
      countryIso3: countryISO3,
      countryName: countryISO3
        ? iso3ToName.get(countryISO3) || crosswalk?.country || countryISO3
        : null
    };

    const kvBlock = compactCellDetail || !(countryISO3 || crosswalk) ? '' : `
      <div class="kv">
        ${countryISO3 ? `<div class="k">Present Day Country</div><div>${meta.countryName}</div>` : ''}
        ${crosswalk ? `<div class="k">Number of samples from this country</div><div>${crosswalk.samples_total || 0}</div>` : ''}
        ${crosswalk ? `<div class="k">Percent of "Western" lifestyles in sampled persons</div><div>${westPercent}%</div>` : ''}
      </div>`;

    const linkBlock = !compactCellDetail && crosswalk?.sgbs?.length
      ? `<a class="detail-link" data-act="highlight-biomes" data-sgbs="${crosswalk.sgbs.join(',')}">Highlight gut microbes found in this country →</a>`
      : '';

    const html = `
      <div class="tip-head">
        <span class="chip" style="background:${color}"></span>
        <div>
          <div class="title">${label}</div>
          <div class="subtitle">Year ${yearLabel}</div>
        </div>
      </div>
      <div class="summary">In <b>${yearLabel}</b>, <b>${label}</b> covers <b>${globalAreaDisplay}</b>, or <b>${percentDisplay}</b> of the Earth's surface.</div>
      ${kvBlock}
      ${linkBlock}
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

  // Process cell history into chronological periods with grouped consecutive years
  function processHistoryData(history) {
    // Convert to array and sort chronologically (BCE to CE/AD)
    const sortedYears = sortYears(Object.keys(history || {}));
    const entries = sortedYears.map(yearStr => [yearStr, history[yearStr]]);

    if (entries.length === 0) return [];

    const toSignedYear = (yearStr) => {
      const { year, isBCE } = parseYearString(yearStr);
      return isBCE ? -year : year;
    };

    const signedYears = sortedYears.map(toSignedYear);
    const yearSteps = signedYears.map((value, idx) => {
      if (idx < signedYears.length - 1) {
        return signedYears[idx + 1] - value;
      }
      if (signedYears.length > 1) {
        return value - signedYears[idx - 1];
      }
      return 1;
    });
    const positiveSteps = yearSteps.filter(step => step > 0);
    const minStep = positiveSteps.length ? Math.min(...positiveSteps) : 1;

    // Group consecutive years with same anthrome
    const periods = [];
    let currentPeriod = null;

    for (const [yearStr, anthrome] of entries) {
      const signedYear = toSignedYear(yearStr);
      if (!currentPeriod || currentPeriod.anthrome !== anthrome) {
        // Start new period
        if (currentPeriod) {
          periods.push(currentPeriod);
        }
        currentPeriod = {
          startYear: signedYear,
          endYear: signedYear,
          startYearRaw: yearStr,
          endYearRaw: yearStr,
          anthrome,
          color: legend[anthrome]?.color || '#ffffff',
          label: legend[anthrome]?.label || 'Unknown'
        };
      } else {
        // Extend current period
        currentPeriod.endYear = signedYear;
        currentPeriod.endYearRaw = yearStr;
      }
    }

    // Add final period
    if (currentPeriod) {
      periods.push(currentPeriod);
    }

    // Calculate proportions based on actual TIME DURATION
    periods.forEach(period => {
      let duration = period.endYear - period.startYear;
      if (duration <= 0) duration = minStep;
      period.duration = duration;
    });

    const totalDuration = periods.reduce((sum, period) => sum + period.duration, 0);

    // Add height percentage and year range to each period
    periods.forEach(period => {
      period.heightPercent = totalDuration > 0 ? (period.duration / totalDuration) * 100 : 0;
      period.startYearLabel = formatYearLabel(period.startYearRaw);
      period.endYearLabel = formatYearLabel(period.endYearRaw);
    });

    // Compute label positions with minimum spacing (labels are absolute-positioned)
    const labelHeightPx = 30;
    const labelHeightPercent = timelineHeightPx > 0
      ? (labelHeightPx / timelineHeightPx) * 100
      : 6;
    const labelPaddingPercent = Math.max(2, labelHeightPercent / 2);
    const minGapPercent = Math.max(3, labelHeightPercent + 1);
    const desiredPositions = [];
    let acc = 0;
    periods.forEach(period => {
      desiredPositions.push(acc + period.heightPercent / 2);
      acc += period.heightPercent;
    });
    periods.forEach((period, idx) => {
      period.segmentCenterPercent = desiredPositions[idx];
    });

    const minPos = labelPaddingPercent;
    const maxPos = 100 - labelPaddingPercent;
    const available = Math.max(0, maxPos - minPos);
    const maxGap = available / Math.max(1, periods.length - 1);
    const effectiveMinGap = Math.min(minGapPercent, maxGap || minGapPercent);

    let positions = desiredPositions.slice();
    const enforceForward = () => {
      for (let i = 1; i < positions.length; i += 1) {
        const minPosForIndex = positions[i - 1] + effectiveMinGap;
        if (positions[i] < minPosForIndex) {
          positions[i] = minPosForIndex;
        }
      }
    };
    const enforceBackward = () => {
      for (let i = positions.length - 2; i >= 0; i -= 1) {
        const maxPosForIndex = positions[i + 1] - effectiveMinGap;
        if (positions[i] > maxPosForIndex) {
          positions[i] = maxPosForIndex;
        }
      }
    };

    // Iteratively enforce bounds and spacing without shifting all labels uniformly.
    for (let iter = 0; iter < 3; iter += 1) {
      if (positions.length === 0) break;

      if (positions[0] < minPos) {
        positions[0] = minPos;
      }
      enforceForward();

      const lastIdx = positions.length - 1;
      if (positions[lastIdx] > maxPos) {
        positions[lastIdx] = maxPos;
      }
      enforceBackward();
    }

    if (positions.length > 0) {
      enforceForward();
      const lastIdx = positions.length - 1;
      if (positions[lastIdx] > maxPos) {
        positions[lastIdx] = maxPos;
        enforceBackward();
      }
      if (positions[0] < minPos) {
        positions[0] = minPos;
        enforceForward();
      }
    }

    const leaderMinGapPercent = Math.max(0.75, labelHeightPercent * 0.2);
    positions.forEach((pos, idx) => {
      const period = periods[idx];
      period.labelTopPercent = pos;
      // Leader line connects segment center to label position
      if (pos < period.segmentCenterPercent) {
        // Label above segment: line extends from label down to segment
        period.leaderTopPercent = pos;
        period.leaderHeightPercent = period.segmentCenterPercent - pos;
      } else {
        // Label below segment: line extends from segment down to label
        period.leaderTopPercent = period.segmentCenterPercent;
        period.leaderHeightPercent = pos - period.segmentCenterPercent;
      }
      period.leaderVisible = period.leaderHeightPercent > leaderMinGapPercent;
    });
    // TODO: Further label/leader refinements needed to reduce overlaps in dense segments.

    return periods;
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
    // Under strictCountryFocus a picker selection is NOT a cross-highlight:
    // clicking dead space outside the disk must leave the country highlighted
    // and its ring in place. Only the ?highlightSGB overlay (which has no rail
    // control of its own) is dismissed this way.
    if (strictCountryFocus && focusIso3) return;
    if (crossHighlightActive) {
      highlightedCountries = new Set();
      crossHighlightActive = false;
      const url = new URL(window.location.href);
      url.searchParams.delete('highlightSGB');
      window.history.replaceState({}, '', url);
    }
  }

  function handleCanvasClick(e) {
    if (!projection || !currentGeo) return;

    const { x, y } = pointerToDevice(e);
    const lnglat = projection.invert([x, y]);
    if (!lnglat) {
      clearAll();
      return;
    }

    const feature = currentGeo.features.find(f => d3.geoContains(f, lnglat));
    if (!feature) {
      clearAll();
      return;
    }

    const cellId = feature.properties?.i;

    // If clicking the same cell that's already isolated, clear everything
    if (isolatedCellId === cellId) {
      clearAll();
      return;
    }

    // Otherwise, pin the tooltip and isolate this cell
    if (cellId != null) {
      // The country lens SURVIVES a cell click: the picker stays selected, the
      // boundary highlight stays, and the ring keeps plotting the country. A
      // cell is a finer reading *within* the current lens, not a replacement
      // for it — so the ring has nothing to change and does not animate. Only
      // the details panel narrows, country -> cell.
      isolatedCellId = cellId;
      cellIsolated = true;
      isolatedFeature = feature;
      drawOverlay();
      tooltipPinned = true;
      // Tooltip position is set by handlePointerMove; design px (see above)
      const p = screenToDesign(e.clientX, e.clientY);
      tooltipX = p.x;
      tooltipY = p.y;
      // Manually trigger tooltip content update
      handlePointerMove(e);

      // Get historical data for this cell
      if (cellHistory && cellHistory[cellId]) {
        const history = cellHistory[cellId];
        barChartData = processHistoryData(history);
        cellSeries = { id: cellId, byYear: history };
        showBarChart = true;
      }
    } else {
      showBarChart = false;
      barChartData = null;
      cellSeries = null;
    }
  }

  function startHandleDrag(idx, event) {
    if (!projection) return;
    event.preventDefault();
    event.stopPropagation();
    const dpr = window.devicePixelRatio || 1;
    draggingHandle = true;
    const startPoints = points.map(p => [...p]);

    function onMove(ev) {
      const { x, y } = pointerToDevice(ev);
      const inv = projection.invert([x, y]);
      if (!inv) return;
      const next = [...points];
      next[idx] = inv;
      points = next;
      // Update handle position live without reprojecting map
      const proj = projection(inv);
      if (proj) {
        handlePositions = handlePositions.map((h, i) => i === idx
          ? { x: proj[0] / dpr, y: proj[1] / dpr, visible: true }
          : h
        );
      }
    }

    function onUp() {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      draggingHandle = false;
      animateProjection(startPoints, points);
    }

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }

  onMount(() => {
    resizeCanvas();

    // Add global click listener for clearing cross-highlight
    window.addEventListener('click', handleGlobalClick);

    return () => {
      window.removeEventListener('click', handleGlobalClick);
    };
  });

  // Reload data when year or profile changes. `profile` is read here (not just
  // inside loadYearData) so switching resolution actually refetches — the
  // effect has to depend on it, and the tile cache is keyed by profile:year.
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
    rangeIso3s;

    if (initialDrawDone) {
      scheduleDraw();
    }
  });

  // Country picker (Phase 3): drive the same highlight mechanism as the
  // cross-highlight URL param, so selecting a country strokes its boundary.
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

    const dpr = window.devicePixelRatio || 1;
    const circle = getCircle();

    const projected = projection(centroid);
    if (!projected) return;
    const pxDesign = projected[0] / dpr;
    const pyDesign = projected[1] / dpr;

    // Bounds are in canvas coords (dpr); span in design px.
    const path = d3.geoPath(projection);
    const [[minX, minY], [maxX, maxY]] = path.bounds(feature);

    // Second pass: the projection has now been rebuilt at the target scale, so
    // the country's position is a measurement rather than a prediction. Centre
    // on the projected BOUNDING BOX rather than the spherical centroid — they
    // agree for compact countries but not for China (the western bulge drags
    // the centroid off the shape's visual middle) or the USA (Alaska lifts the
    // box well above it). The box is what the eye reads as centred.
    if (!firstPass) {
      const boxCx = (minX + maxX) / 2 / dpr;
      const boxCy = (minY + maxY) / 2 / dpr;
      // A country straddling the antimeridian can project to a box spanning the
      // whole plane; fall back to the centroid, which is computed on the sphere
      // and has no such seam.
      const sane =
        Number.isFinite(boxCx) && Number.isFinite(boxCy) &&
        (maxX - minX) / dpr < circle.r * 4 && (maxY - minY) / dpr < circle.r * 4;
      mapPanX = circle.cx - (sane ? boxCx : pxDesign);
      mapPanY = circle.cy - (sane ? boxCy : pyDesign);
      focusNeedsCorrection = false;
      return;
    }

    const spanPx = Math.max(1, Math.max(maxX - minX, maxY - minY)) / dpr;
    const targetDiameter = circle.r * 2 * 0.55;
    const scaleMultiplier = spanPx > 0 ? targetDiameter / spanPx : 1;
    const currentScale = mapScale || 1;
    const nextScale = Math.max(1, Math.min(7, currentScale * scaleMultiplier));

    // Predict where the centroid lands at the new scale. The fixed point of a
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
    const predictedX = txDesign + (pxDesign - txDesign) * scaleRatio;
    const predictedY = tyDesign + (pyDesign - tyDesign) * scaleRatio;

    // Batch all three writes; Svelte flushes them in one tick so only one draw
    // runs downstream instead of a scale-draw-refit-effect-pan-draw chain.
    mapScale = nextScale;
    mapPanX = circle.cx - predictedX;
    mapPanY = circle.cy - predictedY;
    focusPanApplied = focusIso3;
    // The refit that follows gives this effect one more run; take it as a
    // chance to correct any residue (odd-shaped countries, clamped scale).
    focusNeedsCorrection = true;
  }

  // Clear isolation when filtering changes
  $effect(() => {
    if (selectedCodes?.length) {
      isolatedCellId = null;
      isolatedFeature = null;
      untrack(() => drawOverlay());
    }
  });

  // Load boundaries when toggled on
  $effect(() => {
    if (showBoundaries && !boundariesMesh && !boundariesLoading) {
      loadBoundaries();
    }
  });

  // Load cell history on mount (needed for historical bar chart)
  $effect(() => {
    if (!cellHistory && !cellHistoryLoading) {
      loadCellHistory();
    }
  });

  // Switching resolution invalidates everything keyed to the old grid: cell ids
  // are per-profile, so an isolated cell would point at a different patch of
  // land, and the cell history file has to be refetched for the new grid.
  let loadedHistoryProfile = null;
  $effect(() => {
    const p = profile;
    untrack(() => {
      if (loadedHistoryProfile === null) { loadedHistoryProfile = p; return; }
      if (loadedHistoryProfile === p) return;
      loadedHistoryProfile = p;
      clearAll();
      cellHistory = null;
      cellHistoryLoading = false;
      loadCellHistory();
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

  // Load country crosswalk data on mount
  $effect(() => {
    if (!countryData && !countryDataLoading) {
      loadCountryData();
    }
  });

  // timelineHeightPx kept as constant 0 since vertical bar chart is removed;
  // processHistoryData still uses it with a safe fallback when 0.
  const timelineHeightPx = 0;

  // Cross-highlighting from URL parameter — fills the *range* set (multi-
  // country annotation), separate from the primary picker highlight above.
  //
  // Option 1 does not carry a species across the sides at all: arriving from
  // biomes should land on the plain map, not on a set of countries lit up by
  // whichever leaf the disk happened to be resting on. The biomes side already
  // omits ?highlightSGB from its links under Option 1; this also ignores the
  // param on a pasted or bookmarked URL.
  $effect(() => {
    if (!countryData) return;
    if (uiOption() === 1) return;

    const urlParams = new URLSearchParams(window.location.search);
    const highlightSGB = urlParams.get('highlightSGB');

    if (highlightSGB) {
      const sgbId = parseInt(highlightSGB, 10);
      const matchingCountries = [];

      for (const [iso3, data] of countryData.entries()) {
        if (data.sgbs && data.sgbs.includes(sgbId)) {
          matchingCountries.push(iso3);
        }
      }

      rangeIso3s = new Set(matchingCountries);
      rangeSource = matchingCountries.length
        ? { kind: 'species', label: `SGB ${sgbId}`, sgbId, from: 'biomes' }
        : null;
    }
  });

</script>

<div class="map-layer" style={`width:${width}px;height:${height}px;`}>
  <canvas
    bind:this={canvasEl}
    aria-label="Anthromes map"
    onclick={handleCanvasClick}
  ></canvas>

  <canvas
    bind:this={overlayCanvasEl}
    class="overlay-canvas"
    aria-hidden="true"
  ></canvas>

  {#if debugMenuVisible}
    <div class="handles">
      {#each handlePositions as h, idx}
        {#if h.visible}
          <div
            class="handle"
            style={`left:${h.x}px; top:${h.y}px;`}
            title={`Projection point ${idx === 0 ? 'A' : 'B'}`}
            onpointerdown={(e) => startHandleDrag(idx, e)}
          ></div>
        {/if}
      {/each}
    </div>
  {/if}

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

  .handles {
    position: absolute;
    inset: 0;
    pointer-events: none;
  }

  .handle {
    position: absolute;
    width: 20px;
    height: 20px;
    border-radius: 50%;
    background: #ffffff;
    border: 3px solid #0e0b16;
    box-shadow: 0 0 0 3px rgba(0, 0, 0, 0.35);
    transform: translate(-50%, -50%);
    cursor: grab;
    pointer-events: auto;
  }

  .handle:active {
    cursor: grabbing;
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
