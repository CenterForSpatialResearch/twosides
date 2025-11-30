<script>
  import { onMount, untrack } from 'svelte';
  import * as d3 from 'd3';
  import { geoTwoPointEquidistant } from 'd3-geo-projection';
  import * as topojson from 'topojson-client';
  import { TOPO_PROFILE } from './constants.js';
  import Tooltip from '../../shared/Tooltip.svelte';

  const EARTH_RADIUS_KM = 6371.0088;

  let {
    width = 0,
    height = 0,
    innerRadiusPx = 0,
    profile = TOPO_PROFILE,
    year = null,
    legend = {},
    selectedCodes = [],
    zoom = { k: 1, x: 0, y: 0 },
    points = $bindable([
      [-75, 41],
      [48, -15]
    ]),
    clipAngle = 120,
    mapReady = $bindable(false)
  } = $props();

  let canvasEl = $state(null);
  let projection = $state(null);
  let currentGeo = $state(null);
  let currentMesh = $state(null);
  let loading = $state(false);
  let errorMsg = $state('');
  const cache = new Map();
  const inFlight = new Map();
  let draggingHandle = $state(false);
  let animRaf = null;
  let drawRaf = null;
  let drawScheduled = false;
  let projectionCache = null;
  let initialDrawDone = $state(false);
  let isAnimating = $state(false);
  const DEBUG_PROJECTION = false;

  // Tooltip state
  let tooltipVisible = $state(false);
  let tooltipX = $state(0);
  let tooltipY = $state(0);
  let tooltipContent = $state('');
  let tooltipPinned = $state(false);

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
    const r = Math.max(0, innerRadiusPx * (zoom?.k || 1));
    return { cx, cy, r };
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
      const url = new URL(`/topojson/${profile}/${targetYear}.topojson`, window.location.origin).toString();

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

  function updateHandles(currentPoints = points) {
    if (!projection || !currentPoints || currentPoints.length < 2) {
      handlePositions = handlePositions.map(h => ({ ...h, visible: false }));
      return;
    }
    const dpr = window.devicePixelRatio || 1;
    const next = currentPoints.map(pt => {
      const proj = projection(pt);
      if (!proj) return { x: 0, y: 0, visible: false };
      return { x: proj[0] / dpr, y: proj[1] / dpr, visible: true };
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
        nextProj.scale(nextProj.scale() * 0.98);
        if (!skipCache) {
          projectionCache = {
            geo: currentGeo,
            points: currentPoints.map(p => [...p]),
            clipAngle,
            circle: { ...circle },
            dpr,
            projection: nextProj
          };
        }
        projection = nextProj;
        if (DEBUG_PROJECTION) {
          console.debug('MapCanvas: refit projection', refitReason);
        }
      } catch (err) {
        console.error('Projection error', err);
        return;
      }
    } else if (DEBUG_PROJECTION) {
      console.debug('MapCanvas: reuse projection cache');
    }

    projection = projectionOverride || projection || projectionCache?.projection;
    projection.clipExtent([[0, 0], [canvasEl.width, canvasEl.height]]);
    performance.mark('projection-create-end');
    performance.measure('projection-create', 'projection-create-start', 'projection-create-end');

    performance.mark('path-setup-start');
    const path = d3.geoPath(projection, ctx);
    ctx.save();
    ctx.beginPath();
    ctx.arc(circle.cx * dpr, circle.cy * dpr, Math.max(0, circle.r * dpr), 0, Math.PI * 2);
    ctx.clip();

    ctx.fillStyle = '#0e0b16';
    ctx.fillRect(0, 0, canvasEl.width, canvasEl.height);

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
        const code = feature.properties?.anthrome;
        const color = legend[code]?.color || '#ffffff';

        ctx.beginPath();
        path(feature);
        ctx.fillStyle = color;
        ctx.fill();
      }
    } else {
      const selectedSet = new Set(selectedCodes);
      for (let i = 0; i < currentGeo.features.length; i++) {
        const feature = currentGeo.features[i];
        const code = feature.properties?.anthrome;
        if (!selectedSet.has(code)) continue;

        const color = legend[code]?.color || '#ffffff';

        ctx.beginPath();
        path(feature);
        ctx.fillStyle = color;
        ctx.fill();
      }
    }
    performance.mark('feature-render-end');
    performance.measure('feature-render', 'feature-render-start', 'feature-render-end');

    performance.mark('draw-cleanup-start');
    ctx.restore();
    updateHandles(currentPoints);
    initialDrawDone = true;
    mapReady = true;
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
        startProj.scale(startProj.scale() * 0.98);
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
      proj.scale(proj.scale() * 0.98);
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
    // Throttle pointer move events
    const now = performance.now();
    if (now - lastPointerMoveTime < POINTER_MOVE_THROTTLE) return;
    lastPointerMoveTime = now;

    if (tooltipPinned) return;
    if (!projection || !currentGeo) {
      tooltipVisible = false;
      return;
    }
    const rect = canvasEl.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const x = (e.clientX - rect.left) * dpr;
    const y = (e.clientY - rect.top) * dpr;
    const lnglat = projection.invert([x, y]);
    if (!lnglat) {
      tooltipVisible = false;
      return;
    }

    const feature = currentGeo.features.find(f => d3.geoContains(f, lnglat));
    if (!feature) {
      tooltipVisible = false;
      return;
    }

    const code = feature.properties?.anthrome;
    if (selectedCodes?.length) {
      const selectedSet = new Set(selectedCodes);
      if (!selectedSet.has(code)) {
        tooltipVisible = false;
        return;
      }
    }

    const legendEntry = legend[code];
    const label = legendEntry?.label || 'Unknown';
    const color = legendEntry?.color || '#ffffff';
    const areaSr = d3.geoArea(feature);
    const areaKm2 = areaSr * EARTH_RADIUS_KM * EARTH_RADIUS_KM;

    tooltipX = e.clientX;
    tooltipY = e.clientY;
    tooltipContent = `
      <div class="tip-head">
        <span class="chip" style="background:${color}"></span>
        <div>
          <div class="title">${label}</div>
          <div class="subtitle">Year ${year || ''}</div>
        </div>
      </div>
      <div class="summary">In <b>${year || ''}</b>, <b>${label}</b> covers <b>${Math.round(areaKm2).toLocaleString()}</b> km² in this region.</div>
      <div class="kv">
        <div class="k">Area</div><div>${Math.round(areaKm2).toLocaleString()} km²</div>
        <div class="k">Anthrome code</div><div>${code}</div>
      </div>
    `;
    tooltipVisible = true;
  }

  function handlePointerLeave() {
    if (!tooltipPinned) {
      tooltipVisible = false;
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
      const x = (ev.clientX - rect.left) * dpr;
      const y = (ev.clientY - rect.top) * dpr;
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

    if (initialDrawDone) {
      scheduleDraw();
    }
  });
</script>

<div class="map-layer" style={`width:${width}px;height:${height}px;`}>
  <canvas
    bind:this={canvasEl}
    aria-label="Anthromes map"
    onpointermove={handlePointerMove}
    onpointerleave={handlePointerLeave}
  ></canvas>

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

  {#if loading}
    <div class="loading">Loading map…</div>
  {:else if (!mapReady)}
    <div class="loading">Rendering map…</div>
  {/if}
  {#if errorMsg && !loading}
    <div class="loading error">Error: {errorMsg}</div>
  {/if}
</div>

<Tooltip
  bind:visible={tooltipVisible}
  bind:x={tooltipX}
  bind:y={tooltipY}
  bind:pinned={tooltipPinned}
  content={tooltipContent}
  onClose={() => (tooltipPinned = false)}
/>

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
