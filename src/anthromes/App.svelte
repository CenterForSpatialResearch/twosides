<script>
  import { onMount, untrack } from 'svelte';
  import WaffleChart from './lib/WaffleChart.svelte';
  import HistoryCircleChart from './lib/HistoryCircleChart.svelte';
  import { prepareAnthromesData } from './lib/dataAdapter.js';
  import DevHud from '../shared/DevHud.svelte';
  import { initStage, screenToDesign } from '../shared/stage.svelte.js';

  // The fixed design canvas; everything below is authored in design px inside it.
  let stageEl = $state(null);
  $effect(() => {
    if (!stageEl) return;
    return initStage(stageEl);
  });

  const LEGEND_CATEGORIES = [
    { name: 'Dense Settlements', codes: [11, 12] },
    { name: 'Villages',          codes: [21, 22, 23, 24] },
    { name: 'Croplands',         codes: [31, 32, 33, 34] },
    { name: 'Rangelands',        codes: [41, 42, 43] },
    { name: 'Cultured',          codes: [51, 52, 53, 54] },
    { name: 'Wildlands',         codes: [61, 62, 63] },
  ];

  // State
  let loading = $state(true);
  let error = $state(null);
  let data = $state([]);
  let years = $state([]);
  let allYears = $state([]);
  let orderedCodes = $state([]);
  let colorMapping = $state({});
  let labelMapping = $state({});
  let legend = $state({});

  // UI State
  let selectedAnthromes = $state([]);
  let selectedYear = $state(null);
  let viewSize = $state('full'); // 'full' or 'preview'
  let settingsOpen = $state(false);
  let debugMenuVisible = $state(false);
  let showBoundaries = $state(true);
  let mapReady = $state(false);
  let initialLoad = $state(true);
  let zoomLevel = $state(1);
  let rotation = $state(0);
  let mapPanX = $state(0);
  let mapPanY = $state(0);
  let infoOpen = $state(false);
  let waffleChartRef = $state(null);

  // Filter rail state
  let openPanel = $state(null); // 'anthromes' | 'zooms'

  // Cell history chart state (lifted from MapCanvas via WaffleChart bindings)
  let showBarChart = $state(false);
  let barChartData = $state(null);

  // Reset signals (incrementing triggers reset in WaffleChart / MapCanvas)
  let isolationReset = $state(0);
  let panelCloseSignal = $state(0);
  let detailContent = $state(null);
  let detailMeta = $state(null);

  // History chart section sizing
  let historyChartEl = $state(null);
  let historyChartSize = $state(282);

  // Current-year land-cover percentages (drives the bottom filter key sizing)
  let currentPercentages = $derived.by(() => {
    const entry = data.find(d => d.year === selectedYear);
    return entry?.percentages ?? {};
  });

  // Black or white label depending on the anthrome colour's luminance
  function textColor(hex) {
    if (!hex) return '#000';
    const c = hex.replace('#', '');
    const r = parseInt(c.slice(0, 2), 16);
    const g = parseInt(c.slice(2, 4), 16);
    const b = parseInt(c.slice(4, 6), 16);
    const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    return lum > 0.42 ? '#000' : '#fff';
  }

  function fmtPct(p) {
    if (!p || p <= 0) return '0%';
    if (p < 1) return '<1%';
    return `${Math.round(p)}%`;
  }

  // "2025AD" → "2025", "10000BC" → "10000 BCE"
  function formatYear(yearStr) {
    if (!yearStr) return '';
    const isBCE = /(BCE?|BC)$/.test(yearStr);
    const n = parseInt(yearStr.replace(/[^\d]/g, ''), 10);
    return isBCE ? `${n} BCE` : `${n}`;
  }

  // ── Anthrome filter: click to isolate one, drag across to select a range ──
  // Displayed order = LEGEND_CATEGORIES (intensity groups); a drag selects the
  // contiguous slice between the anchor and the pill under the pointer.
  const displayedCodes = LEGEND_CATEGORIES.flatMap(c => c.codes);
  let dragging = $state(false);
  let anchorIdx = $state(null);

  function selectRange(a, b) {
    const start = Math.min(a, b);
    const end = Math.max(a, b);
    selectedAnthromes = displayedCodes.slice(start, end + 1);
  }

  function pillIdxFromPoint(e) {
    const el = document.elementFromPoint(e.clientX, e.clientY);
    const pill = el?.closest?.('.key-pill');
    const idx = pill?.dataset?.idx;
    return idx == null ? null : parseInt(idx, 10);
  }

  function keyPointerDown(e) {
    const pill = e.target?.closest?.('.key-pill');
    if (!pill || pill.dataset.idx == null) return;
    e.preventDefault();
    dragging = true;
    anchorIdx = parseInt(pill.dataset.idx, 10);
    selectRange(anchorIdx, anchorIdx);
    window.addEventListener('pointermove', keyPointerMove);
    window.addEventListener('pointerup', keyPointerUp, { once: true });
  }

  function keyPointerMove(e) {
    if (!dragging || anchorIdx == null) return;
    const idx = pillIdxFromPoint(e);
    if (idx != null) selectRange(anchorIdx, idx);
  }

  function keyPointerUp() {
    dragging = false;
    anchorIdx = null;
    window.removeEventListener('pointermove', keyPointerMove);
  }

  $effect(() => {
    if (!historyChartEl) return;
    const update = () => {
      // clientWidth/Height are layout px, so they stay in design space even
      // though the stage transform scales the rendered box.
      const h = historyChartEl.clientHeight;
      const w = historyChartEl.clientWidth;
      // Square chart. Height must also leave room for the "Cell History" title
      // above the SVG (~26px incl. gap), or the section overflows and the panel scrolls.
      // Width only needs a hairline gutter.
      historyChartSize = Math.max(77, Math.min(h - 26, w - 8));
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(historyChartEl);
    return () => ro.disconnect();
  });

  // Connector (leader line) from the isolated map cell to the docked detail panel
  let connectorStart = $state(null);
  let connectorEnd = $state(null);
  let detailPanelEl = $state(null);

  $effect(() => {
    const start = connectorStart;
    const panel = detailPanelEl;
    const open = detailContent;
    // Recompute when the Cell History chart appears or resizes, since the seam
    // the leader targets moves with it.
    barChartData; historyChartSize;
    untrack(() => {
      if (!panel || !start || !open) { connectorEnd = null; return; }
      const rect = panel.getBoundingClientRect();
      // Panel docks on the left; leader ends at its right edge (rail edge),
      // vertically in line with the "Cell History" chart title. Falls back to the
      // panel title when no chart is shown.
      // getBoundingClientRect is in screen px but the overlay draws in design px.
      const histTitle = panel.querySelector('.history-chart-title');
      const anchor = histTitle || panel.querySelector('.menu-title') || panel;
      const ar = anchor.getBoundingClientRect();
      connectorEnd = screenToDesign(rect.right, ar.top + ar.height / 2);
    });
  });

  // Load data on mount
  onMount(async () => {
    try {
      performance.mark('data-prep-start');
      const result = await prepareAnthromesData();
      performance.mark('data-prep-end');
      performance.measure('data-preparation', 'data-prep-start', 'data-prep-end');

      data = result.data;
      years = result.years;
      allYears = result.allYears;
      orderedCodes = result.orderedCodes;
      colorMapping = result.colorMapping;
      labelMapping = result.labelMapping;
      legend = result.legend;

      // Initialize selectedAnthromes with all codes
      selectedAnthromes = [...orderedCodes];

      // Set default selected year
      if (years.length > 0) {
        selectedYear = years[years.length - 1];
      }

      loading = false;
    } catch (err) {
      console.error('Failed to load data:', err);
      error = err.message;
      loading = false;
    }
  });

  // Track when initial map load completes
  $effect(() => {
    if (!loading && mapReady && initialLoad) {
      initialLoad = false;
    }
  });

  const ZOOM_LEVELS = [1, 2, 7];

  function zoomIn() {
    const next = ZOOM_LEVELS.find(z => z > zoomLevel);
    if (next != null) zoomLevel = next;
  }

  function zoomOut() {
    const prev = [...ZOOM_LEVELS].reverse().find(z => z < zoomLevel);
    if (prev != null) zoomLevel = prev;
  }

  function resetView() {
    zoomLevel = 1;
    rotation = 0;
    mapPanX = 0;
    mapPanY = 0;
    if (years.length > 0) selectedYear = years[years.length - 1];
    selectedAnthromes = orderedCodes.length ? [...orderedCodes] : selectedAnthromes;
    showBarChart = false;
    barChartData = null;
    isolationReset++;
    panelCloseSignal++;
    openPanel = null;
    detailContent = null;
    detailMeta = null;
  }

  // "All" restores the filter to every anthrome (the default, everything shown)
  function handleSelectAll() {
    selectedAnthromes = orderedCodes.length ? [...orderedCodes] : selectedAnthromes;
  }

  // Handle keyboard shortcuts
  function handleKeydown(e) {
    if (e.key === 'M' || e.key === 'm') {
      settingsOpen = !settingsOpen;
    }
    if (e.key === 'Escape') {
      settingsOpen = false;
    }
  }

  // Handle export
  function handleExport() {
    const svg = document.getElementById('chart');
    if (!svg) return;

    const serializer = new XMLSerializer();
    const source = serializer.serializeToString(svg);
    const blob = new Blob([source], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `anthromes_chart_${viewSize}.svg`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }

  // Handle window click to close overlays
  function handleWindowClick(e) {
    const target = e.target;
    if (target.closest('.filter-rail') || target.closest('.settings-panel') || target.closest('.settings-toggle')) return;
    openPanel = null;
    // Close info panel and clear isolation when clicking outside chart/filter-rail.
    // Tooltip, history chart, and cell isolation always close together.
    if (!target.closest('#info-panel') && !target.closest('.viz-area')) {
      panelCloseSignal++;
      isolationReset++;
      detailContent = null;
      detailMeta = null;
    }
  }

  function handleDetail(event) {
    detailContent = event.detail?.content || null;
    detailMeta = event.detail?.meta ?? null;
    openPanel = null;
  }

  function handleDetailClose() {
    detailContent = null;
    detailMeta = null;
  }

  function handleDetailPanelClick(event) {
    event.stopPropagation();
    waffleChartRef?.handlePanelAction?.(event);
  }

  // Close detail when any panel opens (prevent stacking overlays)
  $effect(() => {
    if (openPanel && detailContent) {
      detailContent = null;
      detailMeta = null;
    }
  });
</script>

<svelte:window onkeydown={handleKeydown} onclick={handleWindowClick} />

<!-- .viewport fills the window and shows the letterbox; .stage is the fixed
     3000x2000 canvas that everything below is authored against. -->
<div class="viewport">
<div class="stage" bind:this={stageEl}>
{#if error}
  <div class="error">
    <h2>Error</h2>
    <p>{error}</p>
  </div>
{:else}
  <!-- Loading overlay -->
  {#if loading}
    <div class="loading-overlay">
      <p>Loading anthromes data...</p>
    </div>
  {:else if !mapReady && initialLoad}
    <div class="loading-overlay">
      <p>Rendering map...</p>
    </div>
  {/if}

  <div class="app">
    <!-- Nav circle: switch sides + home dot -->
    <div class="nav-circle nav-circle--right">
      <div class="nav-circle__outer">
        <svg viewBox="0 0 120 120" aria-hidden="true">
          <defs>
            <!-- upper arc (left→right across the top) -->
            <path id="nav-arc-top-right" d="M8 60 A52 52 0 0 1 112 60" />
            <!-- lower arc (right→left across the bottom) -->
            <path id="nav-arc-bottom-left" d="M112 60 A52 52 0 0 1 8 60" />
          </defs>
          <g class="nav-circle__labels" transform="rotate(45 60 60)">
            <circle class="nav-circle__ring" cx="60" cy="60" r="52" />
            <text class="nav-circle__text nav-circle__text--active">
              <textPath href="#nav-arc-top-right" startOffset="50%" text-anchor="middle"><tspan class="here">ANTHROMES</tspan></textPath>
            </text>
            <text class="nav-circle__text nav-circle__text--link">
              <a href="{import.meta.env.BASE_URL}src/biomes/" aria-label="Go to Biomes">
                <textPath href="#nav-arc-bottom-left" startOffset="50%" text-anchor="middle">BIOMES →</textPath>
              </a>
            </text>
          </g>
        </svg>
      </div>

      <a class="nav-circle__home" href={import.meta.env.BASE_URL} aria-label="Back to home">←</a>
    </div>

    <!-- Settings Panel -->
    <div class="settings-panel" class:open={settingsOpen}>
      <label>
        <span>View Mode</span>
        <select bind:value={viewSize}>
          <option value="preview">Preview (1200px)</option>
          <option value="full">Full (7000px)</option>
        </select>
      </label>

      <label class="checkbox-label">
        <input type="checkbox" bind:checked={debugMenuVisible} />
        <span>Show Projection Debug Menu</span>
      </label>

      <label class="checkbox-label">
        <input type="checkbox" bind:checked={showBoundaries} />
        <span>Show Country Boundaries</span>
      </label>

      <button class="export-btn" onclick={handleExport}>
        Export SVG
      </button>

      <div class="tip">
        Press M to toggle settings, Esc to reset
      </div>
    </div>

    <div class="layout">
      <div class="filter-rail">
        <!-- Top tier: large control circles -->
        <div class="control-circles">
          <button class="ctl-btn" title="Info" aria-label="Info" class:active={openPanel === 'info'} onclick={() => openPanel = openPanel === 'info' ? null : 'info'}>i</button>
          <button class="ctl-btn" title="Zoom out" aria-label="Zoom out" onclick={zoomOut} disabled={zoomLevel === ZOOM_LEVELS[0]} aria-disabled={zoomLevel === ZOOM_LEVELS[0]}>−</button>
          <button class="ctl-btn" title="Reset" aria-label="Reset" onclick={resetView}>◎</button>
          <button class="ctl-btn" title="Zoom in" aria-label="Zoom in" onclick={zoomIn} disabled={zoomLevel === ZOOM_LEVELS[ZOOM_LEVELS.length - 1]} aria-disabled={zoomLevel === ZOOM_LEVELS[ZOOM_LEVELS.length - 1]}>＋</button>
        </div>

        <!-- Middle: always-visible details menu item, where Views used to be -->
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <section class="detail-dock" aria-live="polite" bind:this={detailPanelEl} onclick={(e) => e.stopPropagation()}>
          <h3 class="menu-title">Details</h3>
          <p class="menu-desc">The history of anthropogenic land use for an area</p>
          <div class="detail-body">
            {#if detailContent}
              {#if detailMeta?.label}
                <div class="detail-subhead">
                  {#if detailMeta?.color}
                    <span class="overlay-swatch" style={`background: ${detailMeta.color}`}></span>
                  {/if}
                  <span>{detailMeta.label}</span>
                </div>
              {/if}
              <div class="panel-content" onclick={handleDetailPanelClick}>
                {@html detailContent}
              </div>
              {#if barChartData?.length}
                <div class="history-chart-section" bind:this={historyChartEl}>
                  <div class="history-chart-title">Cell History</div>
                  <HistoryCircleChart periods={barChartData} size={historyChartSize} />
                </div>
              {/if}
            {:else}
              <p class="detail-hint">Select an area on the map</p>
            {/if}
          </div>
        </section>

        <!-- Bottom tier: always-visible anthrome filter key. Click to isolate one, drag across to select a range. -->
        <section class="anthrome-key">
          <div class="anthrome-key-head">
            <span class="anthrome-key-title">Anthromes in {formatYear(selectedYear)}</span>
            <div class="anthrome-key-actions">
              <button class="mini-link" class:active={selectedAnthromes.length === orderedCodes.length} onclick={handleSelectAll}>All</button>
            </div>
          </div>
          <div class="key-legend">
            <div class="key-axis" aria-hidden="true">
              <span class="key-axis-label">more intensive anthromes</span>
            </div>
            <!-- svelte-ignore a11y_no_static_element_interactions -->
            <div class="key-swatches" onpointerdown={keyPointerDown}>
              {#each LEGEND_CATEGORIES as category}
                <div class="key-family">
                  <div class="key-cat-name">{category.name}</div>
                  <div class="key-pills">
                    {#each category.codes as code}
                      {@const pct = currentPercentages[String(code)] ?? 0}
                      <button
                        class="key-pill"
                        class:dim={!selectedAnthromes.includes(code)}
                        data-idx={displayedCodes.indexOf(code)}
                        style="background:{colorMapping[code]}; color:{textColor(colorMapping[code])};"
                        title="{labelMapping[code]} — {fmtPct(pct)}"
                      >{labelMapping[code]} ({fmtPct(pct)})</button>
                    {/each}
                  </div>
                </div>
              {/each}
            </div>
          </div>
        </section>
      </div>

      <div class="viz-area">
        <WaffleChart
          bind:this={waffleChartRef}
          {data}
          {years}
          {colorMapping}
          {labelMapping}
          {legend}
          {orderedCodes}
          bind:selectedAnthromes
          bind:selectedYear
          bind:mapReady
          size={viewSize}
          {debugMenuVisible}
          {showBoundaries}
          bind:mapScale={zoomLevel}
          mapRotation={rotation}
          bind:mapPanX
          bind:mapPanY
          bind:showBarChart
          bind:barChartData
          bind:isolationReset
          bind:connectorStart
          panelCloseSignal={panelCloseSignal}
          on:detail={handleDetail}
          on:detail-close={handleDetailClose}
        />
      </div>
    </div>
  </div>

  <!-- Info modal (center-docked) -->
  {#if openPanel === 'info'}
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="info-modal" aria-live="polite" onclick={(e) => e.stopPropagation()}>
      <div class="overlay-head">
        <div class="overlay-title">Anthromes Overview</div>
        <button class="chevron" onclick={() => openPanel = null} aria-label="Close">✕</button>
      </div>
      <div class="detail-body">
        <div class="info-body">
          <p><strong><u>More than 65% of terrestrial nature</u></strong> has been shaped, in very different ways, by people.</p>
          <p><strong>Anthromes</strong> are defined as the global ecological patterns shaped by direct human interactions with ecosystems.</p>
          <p>Visualized here is the <strong>Anthromes Dataset</strong>. It is a "hindcast," a model built from global population and land use data showing change over <u>12,025 years</u>.</p>
          <p>As global population increases, and urbanization accelerates, <strong>biodiversity shrinks.</strong></p>
          <p><u>Preserving "cultured" and "wild" lands</u> is key to preserving biodiversity.</p>

          <div class="legend-section">
            <div class="legend-category-name">Legend</div>
            <div class="legend-body">
              <div class="legend-axis" aria-hidden="true">
                <span class="legend-axis-label">more intensive anthromes</span>
              </div>
              <div class="info-swatches" aria-label="Anthrome color swatches">
                {#each LEGEND_CATEGORIES as category}
                  <div class="legend-category-name">{category.name}</div>
                  {#each category.codes as code}
                    <div class="swatch-pill">
                      <span class="swatch-pill__color" style={`background: ${colorMapping[code]}`}></span>
                      <span class="swatch-pill__label">{labelMapping[code]}</span>
                    </div>
                  {/each}
                {/each}
              </div>
            </div>
          </div>

          <div class="info-citations">
            <div class="info-citations-title">Citations</div>
            <p>Ellis, E.C., N. Gauthier, K. Klein Goldewijk, R. Bliege Bird, N. Boivin, S. Diaz, D. Fuller, J. Gill, J. Kaplan, N. Kingston, H. Locke, C. McMichael, D. Ranco, T. Rick, M.R. Shaw, L. Stephens, J.C. Svenning, and J.E.M. Watson. 2021. "People have shaped most of terrestrial nature for at least 12,000 years." <em>Proceedings of the National Academy of Sciences</em> 118(17): e2023483118. <a href="https://doi.org/10.1073/pnas.2023483118" target="_blank" rel="noopener">https://doi.org/10.1073/pnas.2023483118</a></p>
            <p>Klein Goldewijk, K. 2025. History Database of the Global Environment (HYDE 3.5). Utrecht University. <a href="https://public.yoda.uu.nl/geo/UU01/F45D44.html" target="_blank" rel="noopener">https://public.yoda.uu.nl/geo/UU01/F45D44.html</a></p>
            <p>This project was completed by Laura Kurgan, Dan Miller and Adam Vosburgh at The Center for Spatial Research, Columbia University Graduate School of Architecture Planning and Preservation. This project is open-source, and the repository is located <a href="https://github.com/CenterForSpatialResearch/twosides" target="_blank" rel="noopener">here</a>.</p>
          </div>
        </div>
      </div>
    </div>
  {/if}

  <!-- Leader line: isolated cell → docked detail panel. Endpoints are design px.
       White arrowhead on the map (cell) side, matching the biomes disk marker. -->
  {#if detailContent && connectorStart && connectorEnd}
    <svg class="connector-overlay" aria-hidden="true">
      <defs>
        <marker id="leader-arrow" markerUnits="userSpaceOnUse"
                markerWidth="18" markerHeight="18" refX="16" refY="9"
                orient="auto-start-reverse">
          <path d="M0,0 L16,9 L0,18 Z" fill="#fff"></path>
        </marker>
      </defs>
      <line
        class="leader-line"
        marker-start="url(#leader-arrow)"
        x1={connectorStart.x} y1={connectorStart.y}
        x2={connectorEnd.x} y2={connectorEnd.y}
      ></line>
    </svg>
  {/if}
{/if}
</div>
<!-- Outside .stage so it renders at true screen px, unscaled -->
<DevHud />
</div>

<style>
  .loading-overlay,
  .error {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 100%;
    text-align: center;
    font-size: 21px;
    color: var(--fg);
  }

  .loading-overlay {
    position: absolute;
    inset: 0;
    background: var(--bg);
    z-index: 10000;
  }

  .error h2 {
    color: #ff6b6b;
    margin-bottom: 20px;
  }

  .app {
    width: 100%;
    height: 100%;
    position: relative;
    overflow: hidden;
  }

  .nav-circle {
    position: absolute;
    bottom: 26px;
    right: 26px;
    width: 248px;
    height: 248px;
    border-radius: 50%;
    background: var(--bg);
    border: 3.8px solid rgba(255, 255, 255, 0.85);
    box-shadow: var(--shadow);
    display: grid;
    place-items: center;
    color: var(--fg);
    text-decoration: none;
    z-index: 8;
    pointer-events: auto;
    overflow: visible;
  }

  .nav-circle__outer {
    display: grid;
    place-items: center;
    width: 220px;
    height: 220px;
    border-radius: 50%;
    text-decoration: none;
    pointer-events: auto;
  }

  .nav-circle svg {
    width: 220px;
    height: 220px;
    overflow: visible;
  }

  .nav-circle__ring {
    fill: none;
    stroke: none;
  }

  /* In SVG user units (viewBox is 120 wide), not px — scales with the svg box. */
  .nav-circle__text {
    font-size: 15px;
    font-weight: 800;
    letter-spacing: 0.02em;
    fill: rgba(255, 255, 255, 0.65);
    pointer-events: none;
  }

  .nav-circle__text--active {
    fill: #fff;
  }

  .nav-circle__text .here {
    text-decoration: underline;
  }

  .nav-circle__text--link {
    pointer-events: auto;
  }

  .nav-circle__text--link a {
    fill: inherit;
    text-decoration: none;
  }

  .nav-circle__home {
    position: absolute;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    width: 60px;
    height: 60px;
    border-radius: 50%;
    border: 1.3px solid rgba(255, 255, 255, 0.4);
    background: transparent;
    color: rgba(255, 255, 255, 0.9);
    display: grid;
    place-items: center;
    font-size: 28px;
    line-height: 1;
    font-weight: 800;
    text-decoration: none;
    pointer-events: auto;
  }

  .checkbox-label {
    display: flex;
    align-items: center;
    gap: 10px;
    cursor: pointer;
    margin-top: 10px;
  }

  .checkbox-label input[type="checkbox"] {
    cursor: pointer;
  }

  .export-btn {
    width: 100%;
    margin-top: 13px;
    padding: 10px;
    background: var(--accent);
    color: var(--bg);
    border: none;
    border-radius: 13px;
    font-weight: 600;
    cursor: pointer;
    transition: opacity 0.2s ease;
  }


  /* New rail + overlay styles */
  .layout {
    display: grid;
    grid-template-columns: 1fr 2fr;
    height: 100%;
    align-items: stretch;
  }

  .filter-rail {
    grid-column: 1;
    padding: 51px 61px;
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
    gap: 0;
    height: 100%;
    overflow: hidden;
    position: relative;
    z-index: 5;
  }

  /* Thin gray divider between every menu item (details reads as just another one) */
  .filter-rail > * + * {
    border-top: 1.3px solid rgba(255, 255, 255, 0.14);
    margin-top: 23px;
    padding-top: 23px;
  }

  .control-circles,
  .anthrome-key {
    flex: 0 0 auto;
  }

  /* ===== MoMA: top control circles (largest tier) ===== */
  .control-circles {
    display: flex;
    flex-wrap: wrap;
    gap: 28px;
    align-items: center;
  }

  .ctl-btn {
    width: 118px;
    height: 118px;
    border-radius: 50%;
    background: var(--bg);
    border: 3.8px solid rgba(255, 255, 255, 0.85);
    color: var(--fg);
    font-weight: 700;
    font-size: 44px;
    cursor: pointer;
    display: grid;
    place-items: center;
    box-shadow: var(--shadow);
  }

  .ctl-btn.active {
    background: #fff;
    color: var(--bg);
    border-color: #fff;
  }

  .ctl-btn:active {
    transform: scale(0.95);
  }

  .ctl-btn:disabled,
  .ctl-btn[aria-disabled="true"] {
    opacity: 0.35;
    cursor: not-allowed;
    pointer-events: none;
    filter: grayscale(0.3);
  }

  /* ===== MoMA: bottom anthrome filter key (always visible) ===== */
  .anthrome-key {
    flex: 0 1 auto;
    display: flex;
    flex-direction: column;
    gap: 10px;
    min-height: 0;
    max-height: 40%;
  }

  .anthrome-key-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 15px;
  }

  .anthrome-key-title {
    font-size: 22px;
    font-weight: 800;
    letter-spacing: 0.02em;
  }

  .anthrome-key-actions {
    display: flex;
    gap: 15px;
  }

  /* Matches the biomes cohort Total/Per-capita toggle: text with an underline on
     the active state. "All" is active when every anthrome is shown (the default). */
  .mini-link {
    background: transparent;
    color: var(--fg);
    border: none;
    border-bottom: 2.6px solid transparent;
    padding: 0 0 2.6px;
    font-size: 23px;
    font-weight: 700;
    line-height: 1.2;
    cursor: pointer;
    opacity: 0.45;
    transition: opacity 0.15s ease;
  }

  .mini-link.active {
    opacity: 1;
    border-bottom-color: currentColor;
  }

  /* Bar-legend (mirrors the info-panel legend): vertical intensity axis + multi-column swatch grid */
  .key-legend {
    display: flex;
    gap: 18px;
    align-items: stretch;
    min-height: 0;
    overflow: auto;
  }

  /* Vertical intensity axis — arrow points up (more intensive at top) */
  /* Line + arrowhead sit on the right edge; the rotated label is offset to their left */
  .key-axis {
    position: relative;
    width: 33px;
    flex-shrink: 0;
  }

  .key-axis::before {
    content: '';
    position: absolute;
    left: 28px;
    top: 10px;
    bottom: 0;
    width: 1.3px;
    background: rgba(255, 255, 255, 0.3);
  }

  .key-axis::after {
    content: '';
    position: absolute;
    left: 28px;
    top: 0;
    transform: translateX(-50%);
    width: 0;
    height: 0;
    border-left: 5px solid transparent;
    border-right: 5px solid transparent;
    border-bottom: 7.7px solid rgba(255, 255, 255, 0.3);
  }

  .key-axis-label {
    position: absolute;
    top: 0;
    bottom: 0;
    left: 0;
    right: 13px;
    display: flex;
    align-items: center;
    justify-content: center;
    writing-mode: vertical-rl;
    transform: rotate(180deg);
    font-size: 14px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: rgba(255, 255, 255, 0.4);
    white-space: nowrap;
    user-select: none;
  }

  .key-swatches {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 10px;
    align-content: start;
  }

  .key-family {
    display: flex;
    flex-direction: column;
    gap: 3.8px;
  }

  .key-cat-name {
    font-size: 14px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--muted);
  }

  .key-pills {
    display: flex;
    flex-wrap: wrap;
    gap: 7.7px;
    align-items: center;
  }

  /* Pill sizes to its label; colour = anthrome, tap to isolate / drag to range-select */
  .key-pill {
    display: inline-flex;
    align-items: center;
    height: 38px;
    padding: 0 14px;
    border-radius: 10px;
    border: 1.3px solid rgba(0, 0, 0, 0.18);
    font-size: 15px;
    font-weight: 600;
    white-space: nowrap;
    cursor: pointer;
    box-sizing: border-box;
    user-select: none;
    touch-action: none;
    transition: opacity 0.15s ease;
  }

  .key-pill.dim {
    opacity: 0.35;
  }

  /* ===== MoMA: details — styled exactly like the other menu items (no card) ===== */
  .detail-dock {
    flex: 1 1 auto;
    min-height: 0;
    width: 100%;
    display: flex;
    flex-direction: column;
    gap: 13px;
    box-sizing: border-box;
    pointer-events: auto;
  }

  /* Menu item title/description — shared look with the other rail sections */
  .menu-title {
    margin: 0;
    font-size: 22px;
    font-weight: 800;
    letter-spacing: 0.02em;
    color: var(--fg);
  }

  .menu-desc {
    margin: 0;
    font-size: 16.6px;
    line-height: 1.45;
    color: var(--muted);
  }

  /* Selected-cell subheading (swatch + anthrome name) inside the details body */
  .detail-subhead {
    display: inline-flex;
    align-items: center;
    gap: 10px;
    font-size: 19px;
    font-weight: 700;
    letter-spacing: 0.02em;
    color: #fff;
  }

  .detail-hint {
    margin: 0;
    flex: 1;
    min-height: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    text-align: center;
    font-size: 16.6px;
    font-weight: 700;
    letter-spacing: 0.02em;
    color: var(--fg);
    opacity: 0.85;
  }

  .detail-body {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    gap: 15px;
    overflow: auto;
  }

  /* Text shows at its natural height (no scroll); the chart yields to it */
  .detail-body .panel-content {
    flex: 0 0 auto;
    overflow: visible;
  }

  /* Chart grows into the leftover space, but never past 75% of the body and
     never enough to push the text above into a scroll */
  .detail-dock .history-chart-section {
    flex: 1 1 auto;
    min-height: 0;
    max-height: 75%;
    justify-content: flex-start;
  }

  /* Info modal: centered on the design canvas (longer read).
     Percentages resolve against .stage, i.e. the 3000x2000 canvas. */
  .info-modal {
    position: absolute;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    width: 1229px;
    max-width: calc(100% - 123px);
    max-height: 84%;
    display: flex;
    flex-direction: column;
    background: var(--bg);
    border: 3.8px solid rgba(255, 255, 255, 0.85);
    border-radius: 33px;
    padding: 33px 38px;
    box-shadow: var(--shadow);
    z-index: 20;
    pointer-events: auto;
    transform-origin: center center;
    animation: modal-pop-center 0.18s ease;
  }

  @keyframes modal-pop-center {
    from { transform: translate(-50%, -50%) scale(0.85); opacity: 0; }
    to   { transform: translate(-50%, -50%) scale(1); opacity: 1; }
  }

  /* Leader line from isolated cell to the docked detail panel.
     Spans the design canvas; its SVG user units are design px. */
  .connector-overlay {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    pointer-events: none;
    z-index: 15;
    overflow: visible;
  }

  /* .leader-line stroke lives in shared styles.css (unified with biomes). */

  .history-chart-section {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 7.7px;
    width: 100%;
    box-sizing: border-box;
  }

  .history-chart-title {
    font-size: 13px;
    font-weight: 700;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--muted);
  }

  .overlay-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    margin-bottom: 13px;
  }

  .overlay-title {
    font-size: 20.5px;
    font-weight: 700;
    letter-spacing: 0.04em;
  }

  .overlay-swatch {
    width: 18px;
    height: 18px;
    border-radius: 5px;
    border: 1.3px solid rgba(255, 255, 255, 0.25);
    flex: 0 0 auto;
  }

  .panel-content {
    font-size: 16.6px;
    color: var(--muted);
    line-height: 1.5;
    display: flex;
    flex-direction: column;
    gap: 11px;              /* unified with the biomes detail panel */
    overflow: hidden;
    flex: 1;
    min-height: 0;
  }

  /* The detail subhead (swatch + anthrome name) already covers the head,
     so drop the content's redundant title/"Year …" block inside the panel. */
  :global(.detail-body .panel-content .tip-head) {
    display: none;
  }

  /* Detail panel typography */
  :global(.panel-content .title) {
    font-size: 23px;
    font-weight: 800;
    letter-spacing: 0.04em;
    color: #fff;
  }

  :global(.panel-content .subtitle) {
    font-size: 16.6px;
    color: #cfd3e0;
    letter-spacing: 0.02em;
  }

  :global(.panel-content .summary) {
    font-size: 16.6px;
    color: #e7e9f1;
  }

  /* Inline, clickable action link (e.g. "Highlight gut microbes … →") — underline
     + arrow signal it's tappable. Unified with the biomes detail panel; replaces
     the old boxed .actions button. */
  :global(.panel-content .detail-link) {
    color: var(--accent, #7dd3fc);
    text-decoration: underline;
    text-underline-offset: 2.6px;
    cursor: pointer;
    pointer-events: auto;
  }

  :global(.panel-content .kv) {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 5px 13px;
    padding: 7.7px 0;
    border-top: 1.3px dashed rgba(255,255,255,0.12);
  }

  :global(.panel-content .kv .k) {
    font-size: 14px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: #9ba3c0;
  }

  :global(.panel-content .kv .v) {
    color: #f6f7fb;
    font-weight: 600;
    font-size: 16.6px;
  }

  :global(.panel-content .swatch) {
    display: inline-block;
    width: 18px;
    height: 18px;
    border-radius: 5px;
    border: 1.3px solid rgba(255,255,255,0.25);
    margin-right: 7.7px;
    vertical-align: middle;
  }

  :global(.panel-content .pill),
  :global(.panel-content .badge) {
    display: inline-flex;
    align-items: center;
    gap: 7.7px;
    padding: 7.7px 13px;
    border-radius: 999px;
    background: rgba(255,255,255,0.08);
    border: 1.3px solid rgba(255,255,255,0.16);
    color: #fff;
    font-size: 14px;
    letter-spacing: 0.03em;
  }

  :global(.panel-content .actions) {
    display: grid;
    gap: 10px;
    margin-top: 2.6px;
  }

  :global(.panel-content .actions button) {
    text-align: left;
    background: rgba(255,255,255,0.08);
    border: 1.3px solid rgba(255,255,255,0.18);
    color: #fff;
    border-radius: 15px;
    padding: 14px 18px;
    font-weight: 700;
    font-size: 16.6px;
    cursor: pointer;
  }

  .info-body {
    display: grid;
    gap: 13px;
    font-size: 15px;
    line-height: 1.55;
    color: var(--muted);
  }

  .info-body p {
    margin: 0;
  }

  .info-body p + p {
    padding-top: 7.7px;
  }

  .legend-section {
    display: flex;
    flex-direction: column;
    gap: 5px;
  }

  .legend-body {
    display: flex;
    gap: 38px;
    align-items: stretch;
  }

  /* Axis: vertical arrow + label spanning full legend height */
  .legend-axis {
    position: relative;
    width: 20px;
    flex-shrink: 0;
  }

  /* Line and arrowhead sit on the right edge of the axis column */
  .legend-axis::before {
    content: '';
    position: absolute;
    left: 26px;
    top: 7.7px;
    bottom: 0;
    width: 1.3px;
    background: rgba(255,255,255,0.3);
  }

  .legend-axis::after {
    content: '';
    position: absolute;
    left: 26px;
    top: 1.3px;
    transform: translateX(-50%);
    width: 0;
    height: 0;
    border-left: 3.8px solid transparent;
    border-right: 3.8px solid transparent;
    border-bottom: 6.4px solid rgba(255,255,255,0.3);
  }

  /* Text spans only the top half so its center sits near Urban */
  .legend-axis-label {
    position: absolute;
    top: 15px;
    bottom: 50%;
    left: 6.4px;
    right: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    writing-mode: vertical-rl;
    transform: rotate(180deg);
    font-size: 11.5px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: rgba(255,255,255,0.35);
    white-space: nowrap;
    pointer-events: none;
    user-select: none;
  }

  .info-swatches {
    flex: 1;
    min-width: 0;
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(192px, 1fr));
    gap: 5px 10px;
  }

  .legend-category-name {
    grid-column: 1 / -1;
    font-size: 13px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--muted);
    margin-top: 10px;
  }

  .legend-category-name:first-child {
    margin-top: 0;
  }

  .swatch-pill {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 2.6px 0;
    color: #e7e9f1;
    font-size: 14px;
    letter-spacing: 0.02em;
    line-height: 1.2;
  }

  .swatch-pill__color {
    width: 20px;
    height: 20px;
    border-radius: 6.4px;
    border: 1.3px solid rgba(255, 255, 255, 0.25);
    flex: 0 0 auto;
  }

  .info-body strong {
    color: #fff;
    letter-spacing: 0.02em;
  }

  .info-body u {
    text-decoration-thickness: 2.6px;
    text-decoration-color: rgba(255, 255, 255, 0.35);
    text-underline-offset: 3.8px;
  }

  .info-body em {
    color: #e7e9f1;
  }

  .info-citations {
    margin-top: 18px;
    padding-top: 13px;
    border-top: 1.3px solid rgba(255, 255, 255, 0.08);
  }

  .info-citations-title {
    font-size: 13px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--muted);
    margin-bottom: 7.7px;
  }

  .info-citations p {
    font-size: 13px;
    color: var(--muted);
    line-height: 1.5;
    margin: 0 0 10px;
  }

  .info-citations p:last-child {
    margin-bottom: 0;
  }

  .info-citations a {
    color: var(--accent, #7dd3fc);
    text-decoration: none;
  }

  .chevron {
    border: 2.6px solid rgba(255, 255, 255, 0.85);
    background: var(--bg);
    color: var(--fg);
    width: 38px;
    height: 38px;
    border-radius: 50%;
    cursor: pointer;
    display: grid;
    place-items: center;
    font-size: 17px;
    font-weight: 800;
  }

  .viz-area {
    grid-column: 2;
    position: relative;
    overflow: visible;
    /* Above the rail (z 5): the disk's 9-o'clock year handle overflows past the
       column seam and would otherwise be clipped under the rail. Stopgap until a
       relayout — the disk only reaches the rail's empty right padding, so this
       doesn't cover any interactive rail element. */
    z-index: 6;
  }

</style>
