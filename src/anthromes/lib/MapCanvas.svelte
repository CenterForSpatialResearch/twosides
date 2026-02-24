<script>
  import { onMount, untrack } from 'svelte';
  import * as d3 from 'd3';
  import { geoTwoPointEquidistant } from 'd3-geo-projection';
  import * as topojson from 'topojson-client';
  import { TOPO_PROFILE, USE_PIXEL_BOUNDARIES } from './constants.js';
  import { formatYearLabel, parseYearString, sortYears } from './dataAdapter.js';

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
    mapPanX = 0,
    mapPanY = 0,
    tooltipVisible = $bindable(false),
    tooltipX = $bindable(0),
    tooltipY = $bindable(0),
    tooltipContent = $bindable(''),
    tooltipPinned = $bindable(false),
    showBarChart = $bindable(false),
    barChartData = $bindable(null),
    isolationReset = 0,
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

    if (hoveredFeature && hoveredFeature !== isolatedFeature) {
      ctx.beginPath();
      path(hoveredFeature);
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.75)';
      ctx.lineWidth = 1.5 * dpr;
      ctx.stroke();
    }

    ctx.restore();
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
      const url = `${base}data/cell-history-${TOPO_PROFILE}.json`;
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
      const url = `${base}data/country_index.json`;
      const isDev = import.meta.env.DEV;
      const res = await fetch(url, { cache: isDev ? 'no-store' : 'force-cache' });
      if (!res.ok) {
        throw new Error(`Failed to load country data (${res.status})`);
      }
      const data = await res.json();
      countryData = new Map(Object.entries(data));
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

    // Draw country boundaries overlay if enabled
    if (showBoundaries && boundariesMesh) {
      performance.mark('boundaries-render-start');

      // If cross-highlighting is active, render individual features with custom styling
      if (crossHighlightActive && highlightedCountries.size > 0 && boundariesGeo) {
        for (let i = 0; i < boundariesGeo.features.length; i++) {
          const feature = boundariesGeo.features[i];
          const iso3 = feature.properties?.ISO_A3 || feature.properties?.iso_a3 || feature.properties?.id;

          ctx.beginPath();
          path(feature);

          if (highlightedCountries.has(iso3)) {
            ctx.strokeStyle = 'rgba(255, 255, 255, 1)';
            ctx.lineWidth = 3 * dpr;
          } else {
            ctx.strokeStyle = 'rgba(255, 255, 255, 0.5)';
            ctx.lineWidth = 1 * dpr;
          }

          ctx.stroke();
        }
      } else {
        // Normal boundary rendering
        ctx.beginPath();
        path(boundariesMesh);
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.5)';
        ctx.lineWidth = 1 * dpr;
        ctx.stroke();
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
      if (!tooltipPinned) tooltipVisible = false;
      return;
    }
    const rect = canvasEl.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const x = (e.clientX - rect.left) * dpr - (mapPanX || 0) * dpr;
    const y = (e.clientY - rect.top) * dpr - (mapPanY || 0) * dpr;
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
      return;
    }

    const code = feature.properties?.a;
    if (selectedCodes?.length) {
      const selectedSet = new Set(selectedCodes);
      if (!selectedSet.has(code)) {
        hoveredFeature = null;
        drawOverlay();
        tooltipVisible = false;
        return;
      }
    }

    hoveredFeature = feature;
    drawOverlay();

    const legendEntry = legend[code];
    const label = legendEntry?.label || 'Unknown';
    const color = legendEntry?.color || '#ffffff';
    const areaSr = d3.geoArea(feature);
    const areaKm2 = areaSr * EARTH_RADIUS_KM * EARTH_RADIUS_KM;
    const yearEntry = yearDataLookup?.get?.(year);
    const percent = yearEntry?.percentages?.[String(code)];
    const percentDisplay = percent != null ? `${percent.toFixed(2)}%` : '—';
    const globalAreaKm2 = percent != null ? (percent / 100) * EARTH_SURFACE_KM2 : null;
    const globalAreaDisplay = globalAreaKm2 != null ? `${Math.round(globalAreaKm2).toLocaleString()} km²` : '—';
    const yearLabel = formatYearLabel(year) || '';
    const countryISO3 = feature.properties?.c || null;

    // Lookup crosswalk data for this country
    const crosswalk = countryData?.get(countryISO3);

    // Calculate westernized percentage
    let westPercent = 0;
    if (crosswalk) {
      const westYes = crosswalk.westernized_counts?.Yes || 0;
      const westNo = crosswalk.westernized_counts?.No || 0;
      const westTotal = westYes + westNo;
      westPercent = westTotal > 0 ? ((westYes / westTotal) * 100).toFixed(1) : 0;
    }

    // Only update position if not pinned or if manually called from click
    if (!tooltipPinned || e.type !== 'pointermove') {
      tooltipX = e.clientX;
      tooltipY = e.clientY;
    }

    tooltipContent = `
      <div class="tip-head">
        <span class="chip" style="background:${color}"></span>
        <div>
          <div class="title">${label}</div>
          <div class="subtitle">Year ${yearLabel}</div>
        </div>
      </div>
      <div class="summary">In <b>${yearLabel}</b>, <b>${label}</b> covers <b>${globalAreaDisplay}</b>, or <b>${percentDisplay}</b> of the Earth's surface.</div>
      <div class="kv">
        <div class="k">Area</div><div>${Math.round(areaKm2).toLocaleString()} km²</div>
        <div class="k">Total in ${yearLabel}</div><div>${globalAreaDisplay}</div>
        <div class="k">Anthrome code</div><div>${code}</div>
        ${countryISO3 ? `<div class="k">Present Day Country</div><div>${crosswalk?.country || countryISO3}</div>` : ''}
        ${crosswalk ? `<div class="k">Number of samples from this country</div><div>${crosswalk.samples_total || 0}</div>` : ''}
        ${crosswalk ? `<div class="k">Percent of "Western" lifestyles in sampled persons</div><div>${westPercent}%</div>` : ''}
      </div>
      ${crosswalk && crosswalk.sgbs && crosswalk.sgbs.length > 0 ? `
        <div class="actions">
          <button data-act="highlight-biomes" data-sgbs="${crosswalk.sgbs.join(',')}">
            Highlight gut microbes found in this country →
          </button>
        </div>
      ` : ''}
    `;
    tooltipVisible = true;
  }

  function handlePointerLeave() {
    if (!tooltipPinned) {
      tooltipVisible = false;
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

  function handleBackButton() {
    const sgbId = new URLSearchParams(window.location.search).get('highlightSGB');
    const base = import.meta.env.BASE_URL;
    window.location.href = `${base}src/biomes/index.html${sgbId ? `?highlightSGB=${sgbId}` : ''}`;
  }

  function handleGlobalClick(e) {
    if (e.target.closest('.back-button')) return;
    if (
      e.target.closest('.map-layer') ||
      e.target.closest('#info-panel') ||
      e.target.closest('.filter-rail')
    ) return;

    // Clear cross-highlighting
    if (crossHighlightActive) {
      highlightedCountries = new Set();
      crossHighlightActive = false;
      const url = new URL(window.location.href);
      url.searchParams.delete('highlightSGB');
      window.history.replaceState({}, '', url);
    }

    // Clear isolated pixel and bar chart
    if (isolatedCellId !== null || showBarChart) {
      isolatedCellId = null;
      isolatedFeature = null;
      drawOverlay();
      showBarChart = false;
      barChartData = null;
    }
  }

  function handleCanvasClick(e) {
    if (!projection || !currentGeo) return;

    const rect = canvasEl.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const x = (e.clientX - rect.left) * dpr - (mapPanX || 0) * dpr;
    const y = (e.clientY - rect.top) * dpr - (mapPanY || 0) * dpr;
    const lnglat = projection.invert([x, y]);
    if (!lnglat) {
      isolatedCellId = null;
      tooltipPinned = false;
      tooltipVisible = false;
      return;
    }

    const feature = currentGeo.features.find(f => d3.geoContains(f, lnglat));
    if (!feature) {
      isolatedCellId = null;
      isolatedFeature = null;
      drawOverlay();
      tooltipPinned = false;
      tooltipVisible = false;
      return;
    }

    const cellId = feature.properties?.i;

    // If clicking the same cell that's already pinned, unpin it
    if (tooltipPinned && isolatedCellId === cellId) {
      tooltipPinned = false;
      tooltipVisible = false;
      isolatedCellId = null;
      isolatedFeature = null;
      drawOverlay();
      return;
    }

    // Otherwise, pin the tooltip and isolate this cell
    if (cellId != null) {
      isolatedCellId = cellId;
      isolatedFeature = feature;
      drawOverlay();
      tooltipPinned = true;
      // Tooltip position is set by handlePointerMove
      tooltipX = e.clientX;
      tooltipY = e.clientY;
      // Manually trigger tooltip content update
      handlePointerMove(e);

      // Get historical data for this cell
      if (cellHistory && cellHistory[cellId]) {
        const history = cellHistory[cellId];
        barChartData = processHistoryData(history);
        showBarChart = true;
      }
    } else {
      showBarChart = false;
      barChartData = null;
    }
  }

  function startHandleDrag(idx, event) {
    if (!projection) return;
    event.preventDefault();
    event.stopPropagation();
    const rect = canvasEl.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    draggingHandle = true;
    const startPoints = points.map(p => [...p]);

    function onMove(ev) {
      const x = (ev.clientX - rect.left) * dpr - (mapPanX || 0) * dpr;
      const y = (ev.clientY - rect.top) * dpr - (mapPanY || 0) * dpr;
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

  // Reload data when year or profile changes
  $effect(() => {
    if (!year) return;

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

    if (initialDrawDone) {
      scheduleDraw();
    }
  });

  // Clear isolation when filtering changes
  $effect(() => {
    if (selectedCodes?.length) {
      isolatedCellId = null;
      isolatedFeature = null;
      drawOverlay();
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

  // Clear isolation when isolationReset signal increments
  $effect(() => {
    const reset = isolationReset;
    if (reset > 0) {
      untrack(() => {
        isolatedCellId = null;
        isolatedFeature = null;
        showBarChart = false;
        barChartData = null;
        tooltipPinned = false;
        tooltipVisible = false;
        drawOverlay();
      });
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

  // Handle cross-highlighting from URL parameter
  $effect(() => {
    if (!countryData) return;

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

      highlightedCountries = new Set(matchingCountries);
      crossHighlightActive = matchingCountries.length > 0;
    }
  });

</script>

<div class="map-layer" style={`width:${width}px;height:${height}px;`}>
  {#if crossHighlightActive}
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="back-button" onclick={handleBackButton}>
      ← Back to Biomes
    </div>
  {/if}

  <canvas
    bind:this={canvasEl}
    aria-label="Anthromes map"
    onpointermove={handlePointerMove}
    onpointerleave={handlePointerLeave}
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

  .back-button {
    position: absolute;
    top: 12px;
    left: 12px;
    background: rgba(0, 0, 0, 0.65);
    padding: 8px 12px;
    border-radius: 8px;
    font-size: 12px;
    color: #e5e7eb;
    border: 1px solid rgba(255, 255, 255, 0.12);
    cursor: pointer;
    pointer-events: auto;
    user-select: none;
    z-index: 10;
  }

  .back-button:hover {
    background: rgba(0, 0, 0, 0.85);
    border-color: rgba(255, 255, 255, 0.25);
  }

</style>
