<script>
  import { onMount, onDestroy } from 'svelte';
  import * as d3 from 'd3';
  import * as topojson from 'topojson-client';
  import { ZOOM_PROFILE } from './constants.js';

  let { legend = {} } = $props();

  const FIXED_ZOOM  = 11;
  const COLS        = 3;
  const GAP         = 10;   // px gap between grid cells
  const INFO_H      = 56;   // px reserved below each circle for title + shift + desc
  const HEADER_H    = 100;  // px for the sort-by header area (includes intro + desc line)

  let panelEl  = $state(null);
  let gridEl   = $state(null);
  let panelW   = $state(0);
  let panelH   = $state(0);
  let sortBy   = $state('selected');
  let rendering = $state(false);
  let zoomK    = $state(FIXED_ZOOM);

  const ZOOM_MIN  = 8;
  const ZOOM_MAX  = 14;
  const ZOOM_STEP = 1;


  // Generation counter — stale async renders bail when gen !== renderGen
  let renderGen = 0;

  // Singleton hover tooltip appended to document.body
  let tooltipEl = null;

  // Data cache
  const cache = {
    topo: null,
    changeYears: null,
    locations: new Map(),
  };

  // ── Layout ────────────────────────────────────────────────────────────────
  // Returns { diam, rows, total } such that `rows` is the smallest integer
  // where all rows fit without scrolling.
  function calcLayout(w, h) {
    if (w <= 0 || h <= 0) return null;
    const availH = h - HEADER_H;
    // With GAP between columns but not on edges:
    const initDiam = (w - GAP * (COLS - 1)) / COLS;
    // Row height = circle + info + gap (last row has no trailing gap)
    // rows * (diam + INFO_H + GAP) - GAP = availH
    // → rowsFrac = (availH + GAP) / (initDiam + INFO_H + GAP)
    const rowsFrac = (availH + GAP) / (initDiam + INFO_H + GAP);
    const rows = Math.max(1, Math.ceil(rowsFrac));
    // Solve for exact diam: rows*(diam + INFO_H + GAP) - GAP = availH
    const diam = (availH + GAP - rows * (INFO_H + GAP)) / rows;
    return { diam: Math.max(20, diam), rows, total: COLS * rows };
  }

  // ── Projection scale ──────────────────────────────────────────────────────
  function getScale(radius) {
    return radius * 2.5 * Math.pow(2, zoomK - 9);
  }

  // ── Data loading ──────────────────────────────────────────────────────────
  async function loadTopo() {
    if (cache.topo) return cache.topo;
    const base = import.meta.env.BASE_URL;
    const url  = `${base}topojson/${ZOOM_PROFILE}/2025AD.topojson`;
    const raw  = await fetch(url).then(r => r.json());
    const key  = Object.keys(raw.objects)[0];
    cache.topo = topojson.feature(raw, raw.objects[key]);
    return cache.topo;
  }

  async function loadChangeYears() {
    if (cache.changeYears) return cache.changeYears;
    const base = import.meta.env.BASE_URL;
    const url  = `${base}data/anthrome-change-years-${ZOOM_PROFILE}.json`;
    cache.changeYears = await fetch(url).then(r => r.json());
    return cache.changeYears;
  }

  async function loadLocations(sort, count) {
    if (!cache.locations.has(sort)) {
      const base = import.meta.env.BASE_URL;
      let url;
      if (sort === 'selected') {
        url = `${base}data/zooms-selected.json`;
      } else {
        const isInt = sort.startsWith('intensive');
        const yr    = sort.endsWith('1900') ? '1900' : '2000';
        const file  = isInt
          ? `zooms-intensive-since-${yr}.json`
          : `zooms-cultured-since-${yr}.json`;
        url = `${base}data/${file}`;
      }
      const data = await fetch(url).then(r => r.json());
      cache.locations.set(sort, data);
    }
    return cache.locations.get(sort).slice(0, count);
  }

  // ── Change-year formatting (matches test page) ────────────────────────────
  function fmtYear(yr) {
    if (!yr || yr === 'Unknown') return 'N/A';
    if (typeof yr === 'string' && yr.includes('BC')) {
      const n = parseInt(yr.replace('BC', ''));
      return n >= 1000 ? `${(n / 1000).toFixed(1)}kBC` : `${n}BC`;
    }
    return String(yr).replace('AD', '');
  }

  // ── Tooltip ───────────────────────────────────────────────────────────────
  function getTooltip() {
    if (!tooltipEl) {
      tooltipEl = document.createElement('div');
      tooltipEl.className = 'zp-hover-tip';
      document.body.appendChild(tooltipEl);
    }
    return tooltipEl;
  }

  // ── Canvas rendering ──────────────────────────────────────────────────────
  function renderCanvas(circleEl, location, diam, geo, changeYears) {
    const radius = diam / 2;
    const dpr    = window.devicePixelRatio || 1;

    const canvas       = document.createElement('canvas');
    canvas.width       = Math.round(diam * dpr);
    canvas.height      = Math.round(diam * dpr);
    canvas.style.width  = `${diam}px`;
    canvas.style.height = `${diam}px`;

    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);

    const projection = d3.geoAzimuthalEquidistant()
      .center([location.lon, location.lat])
      .scale(getScale(radius))
      .translate([radius, radius]);

    const path = d3.geoPath(projection, ctx);

    // Draw anthrome features
    for (const feature of geo.features) {
      const code  = feature.properties.a;
      const color = legend[code]?.color || '#444';
      ctx.fillStyle = color;
      ctx.beginPath();
      path(feature);
      ctx.fill();
    }

    // Circular clip mask
    ctx.globalCompositeOperation = 'destination-in';
    ctx.fillStyle = '#000';
    ctx.beginPath();
    ctx.arc(radius, radius, radius, 0, 2 * Math.PI);
    ctx.fill();
    ctx.globalCompositeOperation = 'source-over';

    circleEl.innerHTML = '';
    circleEl.appendChild(canvas);

    // Hover tooltip
    const tip = getTooltip();
    canvas.addEventListener('mousemove', (e) => {
      const rect   = canvas.getBoundingClientRect();
      const x      = ((e.clientX - rect.left) / rect.width)  * diam;
      const y      = ((e.clientY - rect.top)  / rect.height) * diam;
      const lonlat = projection.invert([x, y]);
      if (!lonlat) { tip.style.display = 'none'; return; }

      const feat = geo.features.find(f => d3.geoContains(f, lonlat));
      if (feat) {
        const code = feat.properties.a;
        const cy   = changeYears[feat.properties.i] || 'Unknown';
        tip.innerHTML = `<strong>${legend[code]?.label ?? 'Unknown'}</strong><br>Changed: ${fmtYear(cy)}`;
        tip.style.display = 'block';
        tip.style.left    = `${e.clientX + 12}px`;
        tip.style.top     = `${e.clientY + 12}px`;
      } else {
        tip.style.display = 'none';
      }
    });
    canvas.addEventListener('mouseleave', () => { tip.style.display = 'none'; });
  }

  // ── Main render ───────────────────────────────────────────────────────────
  async function doRender(gen) {
    if (!gridEl || panelW <= 0 || panelH <= 0) return;
    const layout = calcLayout(panelW, panelH);
    if (!layout || layout.diam <= 0) return;

    rendering = true;

    // Parallel data fetch
    const [geo, changeYears, locations] = await Promise.all([
      loadTopo(),
      loadChangeYears(),
      loadLocations(sortBy, layout.total),
    ]);

    if (gen !== renderGen) { rendering = false; return; } // stale

    // Pass layout metrics as CSS vars so the grid uses them
    gridEl.style.setProperty('--zp-diam', `${layout.diam}px`);
    gridEl.style.setProperty('--zp-info', `${INFO_H}px`);
    gridEl.style.setProperty('--zp-gap',  `${GAP}px`);
    gridEl.style.setProperty('--zp-cols', `${COLS}`);

    gridEl.innerHTML = '';

    for (const loc of locations) {
      if (gen !== renderGen) break;

      const wrapper = document.createElement('div');
      wrapper.className = 'zp-wrapper';

      const circle = document.createElement('div');
      circle.className = 'zp-circle';

      const info = document.createElement('div');
      info.className = 'zp-info';
      info.innerHTML = `
        <div class="zp-title">${loc.title}</div>
        ${loc.shift != null ? `<div class="zp-shift">${loc.shift.toFixed(2)}</div>` : ''}
        ${loc.description ? `<div class="zp-desc-item">${loc.description}</div>` : ''}
      `;

      wrapper.appendChild(circle);
      wrapper.appendChild(info);
      gridEl.appendChild(wrapper);

      renderCanvas(circle, loc, layout.diam, geo, changeYears);
    }

    if (gen === renderGen) rendering = false;
  }

  // ── Reactive trigger ──────────────────────────────────────────────────────
  $effect(() => {
    const w    = panelW;
    const h    = panelH;
    const sort = sortBy;
    const zoom = zoomK;
    if (gridEl && w > 0 && h > 0) {
      renderGen++;
      const gen = renderGen;
      doRender(gen);
    }
  });

  // ── Lifecycle ─────────────────────────────────────────────────────────────
  onMount(() => {
    if (!panelEl) return;
    const ro = new ResizeObserver(entries => {
      const r = entries[0].contentRect;
      panelW = r.width;
      panelH = r.height;
    });
    ro.observe(panelEl);
    return () => ro.disconnect();
  });

  onDestroy(() => {
    zoomK = FIXED_ZOOM;
    if (tooltipEl) {
      tooltipEl.remove();
      tooltipEl = null;
    }
  });
</script>

<div class="zooms-panel" bind:this={panelEl}>
  <!-- Sort dropdown — centered at top -->
  <div class="zp-header">
    <p class="zp-intro">Zooms of selected sites at higher resolution. Highlight cells to see the year that cell changed to its current anthrome.</p>
    <div class="zp-sort">
      <label for="zp-sort-sel">Sort By</label>
      <div class="zp-sort-row">
        <button class="zp-zoom-btn" onclick={() => zoomK = Math.max(ZOOM_MIN, zoomK - ZOOM_STEP)} disabled={zoomK <= ZOOM_MIN}>−</button>
        <select id="zp-sort-sel" bind:value={sortBy}>
          <option value="selected">Selected sites</option>
          <option value="intensive-1900">Largest Intensive Shifts since 1900</option>
          <option value="cultured-1900">Largest Cultured Shifts since 1900</option>
          <option value="intensive-2000">Largest Intensive Shifts since 2000</option>
          <option value="cultured-2000">Largest Cultured Shifts since 2000</option>
        </select>
        <button class="zp-zoom-btn" onclick={() => zoomK = Math.min(ZOOM_MAX, zoomK + ZOOM_STEP)} disabled={zoomK >= ZOOM_MAX}>+</button>
      </div>
    </div>
  </div>

  {#if rendering}
    <div class="zp-loading">Rendering…</div>
  {/if}

  <!-- Grid filled programmatically by doRender() -->
  <div class="zp-grid" bind:this={gridEl}></div>
</div>

<style>
  .zooms-panel {
    width: 100%;
    height: 100%;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    position: relative;
  }

  /* ── Header ── */
  .zp-header {
    height: 100px;
    display: flex;
    flex-direction: column;
    justify-content: center;
    align-items: center;
    gap: 6px;
    flex-shrink: 0;
    padding: 0 8px;
  }

  .zp-intro {
    margin: 0;
    font-size: 12px;
    color: var(--muted);
    text-align: center;
    line-height: 1.4;
    width: 75%;
  }

  .zp-sort {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 3px;
  }

  .zp-sort label {
    font-size: 10px;
    text-transform: uppercase;
    color: var(--muted);
    letter-spacing: 0.06em;
  }

  .zp-sort-row {
    display: flex;
    align-items: center;
    gap: 4px;
  }

  .zp-sort select {
    padding: 4px 8px;
    border-radius: 6px;
    border: 1px solid rgba(255, 255, 255, 0.18);
    background: #1a1625;
    color: var(--fg);
    font-size: 11px;
    cursor: pointer;
    max-width: 220px;
  }

  .zp-sort select option {
    background: #1a1625;
    color: var(--fg);
  }

  .zp-sort select:focus {
    outline: none;
    border-color: var(--accent);
  }

  .zp-zoom-btn {
    width: 22px;
    height: 22px;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 5px;
    border: 1px solid rgba(255, 255, 255, 0.18);
    background: #1a1625;
    color: var(--fg);
    font-size: 14px;
    line-height: 1;
    cursor: pointer;
    flex-shrink: 0;
    padding: 0;
    transition: border-color 0.15s, opacity 0.15s;
  }

  .zp-zoom-btn:hover:not(:disabled) {
    border-color: var(--accent);
  }

  .zp-zoom-btn:disabled {
    opacity: 0.3;
    cursor: default;
  }

  /* ── Loading ── */
  .zp-loading {
    position: absolute;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    color: var(--muted);
    font-size: 12px;
    pointer-events: none;
  }

  /* ── Grid (circles rendered programmatically) ── */
  .zp-grid {
    flex: 1;
    display: grid;
    grid-template-columns: repeat(var(--zp-cols, 2), 1fr);
    gap: var(--zp-gap, 10px);
    overflow: hidden;
    align-content: start;
  }

  /* ── Programmatically-created elements ── */
  :global(.zp-wrapper) {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
  }

  :global(.zp-circle) {
    width: var(--zp-diam, 80px);
    height: var(--zp-diam, 80px);
    border-radius: 50%;
    overflow: hidden;
    background: #06070d;
    flex-shrink: 0;
  }

  :global(.zp-circle canvas) {
    display: block;
  }

  :global(.zp-info) {
    width: var(--zp-diam, 80px);
    height: var(--zp-info, 56px);
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: flex-start;
    padding-top: 3px;
    overflow: hidden;
  }

  :global(.zp-desc-item) {
    font-size: 9px;
    color: var(--muted);
    text-align: center;
    line-height: 1.2;
    max-width: 100%;
    margin-top: 2px;
  }

  :global(.zp-title) {
    font-size: 10px;
    font-weight: 600;
    color: var(--fg, #fff);
    text-align: center;
    white-space: normal;
    max-width: 100%;
    line-height: 1.2;
  }

  :global(.zp-shift) {
    font-size: 9px;
    color: var(--accent, #7dd3fc);
    text-align: center;
    line-height: 1.3;
  }

  /* ── Hover tooltip (appended to body) ── */
  :global(.zp-hover-tip) {
    position: fixed;
    display: none;
    pointer-events: none;
    background: rgba(0, 0, 0, 0.88);
    color: #f1f5f9;
    padding: 6px 10px;
    border-radius: 6px;
    font-size: 12px;
    line-height: 1.4;
    border: 1px solid rgba(255, 255, 255, 0.12);
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.5);
    z-index: 9999;
    white-space: nowrap;
  }
</style>
