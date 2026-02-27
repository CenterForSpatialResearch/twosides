<script>
  import { onMount, untrack } from 'svelte';
  import WaffleChart from './lib/WaffleChart.svelte';
  import HistoryCircleChart from './lib/HistoryCircleChart.svelte';
  import ZoomsPanel from './lib/ZoomsPanel.svelte';
  import { prepareAnthromesData } from './lib/dataAdapter.js';

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
  let historyChartSize = $state(220);

  // Connector (leader line) state
  let connectorStart = $state(null);
  let connectorEnd = $state(null);
  let detailPanelEl = $state(null);

  $effect(() => {
    const start = connectorStart;
    const panel = detailPanelEl;
    untrack(() => {
      if (!panel || !start) { connectorEnd = null; return; }
      const rect = panel.getBoundingClientRect();
      connectorEnd = {
        x: rect.right,
        y: (rect.top + rect.bottom) / 2
      };
    });
  });

  $effect(() => {
    if (!historyChartEl) return;
    const update = () => {
      const h = historyChartEl.clientHeight;
      const w = historyChartEl.clientWidth;
      // Square chart — fit the smaller dimension with a small gutter
      historyChartSize = Math.max(60, Math.min(h - 24, w - 24));
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(historyChartEl);
    return () => ro.disconnect();
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

  // Handle select all - resets to show everything
  function handleSelectAll() {
    if (!orderedCodes.length || !allYears.length) return;
    selectedAnthromes = [...orderedCodes];
  }

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
  }

  // Handle clear - in original, this also resets to show everything (same as Select All)
  function handleClear() {
    if (!orderedCodes.length || !allYears.length) return;
    selectedAnthromes = [...orderedCodes];
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

  // Drag selection state
  let dragging = $state(false);
  let anchorIdx = $state(null);

  function selectRange(startIdx, endIdx) {
    const start = Math.min(startIdx, endIdx);
    const end = Math.max(startIdx, endIdx);
    selectedAnthromes = orderedCodes.slice(start, end + 1);
  }

  function handleLegendMouseDown(e, idx) {
    e.preventDefault();
    dragging = true;
    if (e.shiftKey && anchorIdx !== null) {
      selectRange(anchorIdx, idx);
    } else {
      anchorIdx = idx;
      selectRange(idx, idx);
    }
  }

  function handleLegendMouseEnter(idx) {
    if (dragging && anchorIdx !== null) {
      selectRange(anchorIdx, idx);
    }
  }

  function handleLegendMouseUp() {
    dragging = false;
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

<svelte:window onkeydown={handleKeydown} onclick={handleWindowClick} onmouseup={handleLegendMouseUp} />

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
              <a href="/src/biomes/" aria-label="Go to Biomes">
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
        <div class="control-circles">
        <button class="circle-btn" title="Info" onclick={() => openPanel = openPanel === 'info' ? null : 'info'}>i</button>
        <button class="circle-btn" title="Zoom out" onclick={zoomOut}>−</button>
        <button class="circle-btn" title="Reset" onclick={resetView}>◎</button>
        <button class="circle-btn" title="Zoom in" onclick={zoomIn}>＋</button>
      </div>

      <div class="filter-grid">
        <button class="mini-circle" class:active={openPanel === 'anthromes'} onclick={() => {
          openPanel = openPanel === 'anthromes' ? null : 'anthromes';
          selectedAnthromes = orderedCodes.length ? [...orderedCodes] : selectedAnthromes;
          showBarChart = false;
          barChartData = null;
          isolationReset++;
          panelCloseSignal++;
        }}>
          <svg class="mini-arc" viewBox="0 0 140 140" aria-hidden="true">
            <defs><path id="arc-anth" d="M70 10 A60 60 0 1 1 69.9 10" /></defs>
            <text class="arc-text"><textPath href="#arc-anth" startOffset="0%" text-anchor="start">Filters</textPath></text>
          </svg>
        </button>
        <button class="mini-circle" class:active={openPanel === 'zooms'} onclick={() => {
          openPanel = openPanel === 'zooms' ? null : 'zooms';
          showBarChart = false;
          barChartData = null;
          isolationReset++;
          panelCloseSignal++;
        }}>
          <svg class="mini-arc" viewBox="0 0 140 140" aria-hidden="true">
            <defs><path id="arc-zooms" d="M70 10 A60 60 0 1 1 69.9 10" /></defs>
            <text class="arc-text"><textPath href="#arc-zooms" startOffset="0%" text-anchor="start">Views</textPath></text>
          </svg>
        </button>
      </div>

        <div class="overlay-slot">
          {#if openPanel}
            <div class="filter-overlay" class:views-open={openPanel === 'zooms'} aria-live="polite">
              <div class="overlay-head">
                <div class="overlay-title">
                  {openPanel === 'info' ? 'Anthromes Overview' : openPanel === 'anthromes' ? 'Filters' : 'Views'}
                </div>
                <button class="chevron" onclick={() => openPanel = null} aria-label="Close">✕</button>
              </div>

            {#if openPanel === 'info'}
              <div class="info-body">
                <p><strong><u>More than 65% of terrestrial nature</u></strong> has been shaped, in very different ways, by people.</p>
                <p><strong>Anthromes</strong> are defined as the ecological patterns shaped by human habitation.</p>
                <p>Visualized here is the <strong>Anthromes Dataset</strong>. It is a "hindcast," a model built from global population and land use data showing change over <u>12,025 years</u>.</p>
                <p>As global population increases, and urbanization accelerates, <strong>biodiversity shrinks.</strong></p>
                <p><u>Preserving "cultured" and "wild" lands</u> is key to preserving biodiversity.</p>

                <div class="info-swatches" aria-label="Anthrome color swatches">
                  {#each orderedCodes as code}
                    <div class="swatch-pill">
                      <span class="swatch-pill__color" style={`background: ${colorMapping[code]}`}></span>
                      <span class="swatch-pill__label">{labelMapping[code]}</span>
                    </div>
                  {/each}
                </div>

                <div class="info-citations">
                  <div class="info-citations-title">Citations</div>
                  <p>This project was completed by Laura Kurgan, Dan Miller and Adam Vosburgh at The Center for Spatial Research, Columbia University Graduate School of Architecture Planning and Preservation. This project is open-source, and the repository is located <a href="https://github.com/CenterForSpatialResearch/twosides" target="_blank" rel="noopener">here</a>.</p>
                  <p>Ellis, E.C., N. Gauthier, K. Klein Goldewijk, R. Bliege Bird, N. Boivin, S. Diaz, D. Fuller, J. Gill, J. Kaplan, N. Kingston, H. Locke, C. McMichael, D. Ranco, T. Rick, M.R. Shaw, L. Stephens, J.C. Svenning, and J.E.M. Watson. 2021. "People have shaped most of terrestrial nature for at least 12,000 years." <em>Proceedings of the National Academy of Sciences</em> 118(17): e2023483118. <a href="https://doi.org/10.1073/pnas.2023483118" target="_blank" rel="noopener">https://doi.org/10.1073/pnas.2023483118</a></p>
                  <p>Klein Goldewijk, K. 2025. History Database of the Global Environment (HYDE 3.5). Utrecht University. <a href="https://public.yoda.uu.nl/geo/UU01/F45D44.html" target="_blank" rel="noopener">https://public.yoda.uu.nl/geo/UU01/F45D44.html</a></p>
                </div>
              </div>
              {#if showBarChart && barChartData?.length}
                <div class="history-chart-section" bind:this={historyChartEl}>
                  <div class="history-chart-title">Cell History</div>
                  <HistoryCircleChart periods={barChartData} size={historyChartSize} />
                </div>
              {/if}
            {:else if openPanel === 'anthromes'}
              <p class="overlay-desc">Select anthrome classes; click or drag to choose a range.</p>
              <div class="overlay-actions">
                <button class="btn" onclick={handleSelectAll}>Select All</button>
                <button class="btn" onclick={handleClear}>Clear</button>
              </div>
                <div class="legend-grid">
                  {#each orderedCodes as code, idx}
                    <button
                      class="legend-item"
                      class:selected={selectedAnthromes.includes(code)}
                      onmousedown={(e) => handleLegendMouseDown(e, idx)}
                      onmouseenter={() => handleLegendMouseEnter(idx)}
                      title="{labelMapping[code]} (Code: {code})"
                    >
                      <span class="sw" style="background: {colorMapping[code]};"></span>
                      <span class="lbl">{labelMapping[code]}</span>
                    </button>
                  {/each}
                </div>
                <div class="instruction-text">Click & drag to select range • Shift+click to extend</div>
              {:else if openPanel === 'zooms'}
                <ZoomsPanel legend={legend} />
              {/if}
            </div>
          {/if}

          {#if detailContent}
            <div class="filter-overlay detail-overlay" class:with-chart={showBarChart && barChartData?.length} aria-live="polite" bind:this={detailPanelEl}>
              <div class="overlay-head">
                <div class="overlay-title detail-title">
                  {#if detailMeta?.color}
                    <span class="overlay-swatch" style={`background: ${detailMeta.color}`}></span>
                  {/if}
                  <span>{detailMeta?.label ?? 'Details'}</span>
                </div>
                <button class="chevron" onclick={handleDetailClose} aria-label="Close">✕</button>
              </div>
              <!-- svelte-ignore a11y_click_events_have_key_events -->
              <!-- svelte-ignore a11y_no_static_element_interactions -->
              <div class="panel-content" onclick={handleDetailPanelClick}>
                {@html detailContent}

                {#if showBarChart && barChartData?.length}
                  <div class="history-chart-section" class:needs-space={showBarChart && barChartData?.length} bind:this={historyChartEl}>
                    <div class="history-chart-title">Cell History</div>
                    <HistoryCircleChart periods={barChartData} size={historyChartSize} />
                  </div>
                {/if}
              </div>
            </div>
          {/if}
        </div>

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

  {#if detailContent && connectorStart && connectorEnd}
    <svg class="connector-overlay" aria-hidden="true">
      <line x1={connectorStart.x} y1={connectorStart.y} x2={connectorEnd.x} y2={connectorEnd.y}></line>
    </svg>
  {/if}
{/if}

<style>
  .connector-overlay {
    position: fixed;
    inset: 0;
    width: 100vw;
    height: 100vh;
    pointer-events: none;
    z-index: 50;
    overflow: visible;
  }

  .connector-overlay line {
    stroke: rgba(255, 255, 255, 0.5);
    stroke-width: 1.5;
    stroke-dasharray: 4 3;
  }

  .loading-overlay,
  .error {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 100vh;
    text-align: center;
    color: var(--fg);
  }

  .loading-overlay {
    position: fixed;
    inset: 0;
    background: var(--bg);
    z-index: 10000;
  }

  .error h2 {
    color: #ff6b6b;
    margin-bottom: 1rem;
  }

  .app {
    width: 100%;
    height: 100vh;
    position: relative;
    overflow: hidden;
  }

  .nav-circle {
    position: fixed;
    bottom: 16px;
    right: 16px;
    width: 124px;
    height: 124px;
    border-radius: 50%;
    background: var(--bg);
    border: 2px solid rgba(255, 255, 255, 0.85);
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
    width: 110px;
    height: 110px;
    border-radius: 50%;
    text-decoration: none;
    pointer-events: auto;
  }

  .nav-circle svg {
    width: 110px;
    height: 110px;
    overflow: visible;
  }

  .nav-circle__ring {
    fill: none;
    stroke: none;
  }

  .nav-circle__text {
    font-size: 14px;
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

  .nav-circle:hover .nav-circle__text {
    fill: #fff;
  }

  .nav-circle__text--link {
    pointer-events: auto;
  }

  .nav-circle__text--link a {
    fill: inherit;
    text-decoration: none;
  }

  .nav-circle__text--link a:hover textPath,
  .nav-circle__text--link a:hover {
    text-decoration: underline;
    fill: #fff;
  }

  .nav-circle__home {
    position: absolute;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    width: 32px;
    height: 32px;
    border-radius: 50%;
    border: 1px solid transparent;
    background: transparent;
    color: rgba(255, 255, 255, 0.9);
    display: grid;
    place-items: center;
    font-size: 15px;
    line-height: 1;
    font-weight: 800;
    text-decoration: none;
    transition: background 0.2s ease, transform 0.2s ease, border-color 0.2s ease, color 0.2s ease, box-shadow 0.2s ease;
    pointer-events: auto;
  }

  .nav-circle__home:hover {
    background: #fff;
    color: var(--bg);
    border-color: #fff;
    box-shadow: 0 0 0 6px rgba(255, 255, 255, 0.08);
    transform: translate(-50%, -50%) scale(1.05);
  }

  .checkbox-label {
    display: flex;
    align-items: center;
    gap: 8px;
    cursor: pointer;
    margin-top: 8px;
  }

  .checkbox-label input[type="checkbox"] {
    cursor: pointer;
  }

  .export-btn {
    width: 100%;
    margin-top: 10px;
    padding: 8px;
    background: var(--accent);
    color: var(--bg);
    border: none;
    border-radius: 10px;
    font-weight: 600;
    cursor: pointer;
    transition: opacity 0.2s ease;
  }

  .export-btn:hover {
    opacity: 0.8;
  }

  /* Filter Circle Styles */
  .filter-circle {
    position: fixed;
    left: 24px;
    bottom: 24px;
    z-index: 999;
    transition: width 0.28s ease, height 0.28s ease, transform 0.28s ease, box-shadow 0.2s ease;
    transform-origin: bottom left;
    pointer-events: auto;
  }

  .ring-svg {
    position: absolute;
    inset: 0;
    overflow: visible;
    pointer-events: none;
    z-index: 2;
  }

  .filter-ring {
    fill: none;
    stroke: #fff;
    stroke-width: 3px;
  }

  .filter-caption {
    fill: #cfd3e0;
    font-size: 12px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    dominant-baseline: middle;
    transition: opacity 0.3s ease;
  }

  .content { display: none; }

  /* Legend Grid Styles */
  .legend-grid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 6px 10px;
    width: 100%;
    user-select: none;
    margin-top: 4px;
  }

  .legend-item {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 5px 7px;
    border-radius: 10px;
    background: rgba(255, 255, 255, 0.04);
    border: 1px solid rgba(255, 255, 255, 0.12);
    cursor: pointer;
    transition: opacity 0.15s ease, background 0.15s ease, border-color 0.15s ease;
    opacity: 0.55;
    text-align: left;
  }

  .legend-item:hover {
    opacity: 0.95;
    background: rgba(255, 255, 255, 0.07);
  }

  .legend-item.selected {
    opacity: 1;
    background: rgba(255, 255, 255, 0.10);
    border-color: rgba(255, 255, 255, 0.35);
  }

  .legend-item .sw {
    width: 12px;
    height: 12px;
    border-radius: 4px;
    border: 1px solid rgba(255, 255, 255, 0.25);
    flex: 0 0 auto;
  }

  .legend-item .lbl {
    font-size: 11px;
    line-height: 1.2;
    color: #ffffff;
    font-weight: 500;
  }

  .legend-item.selected .lbl {
    color: #ffffff;
  }

  .instruction-text {
    font-size: 10px;
    color: var(--muted);
    margin-top: 2px;
    line-height: 1.4;
    text-align: center;
  }

  /* New rail + overlay styles */
  .layout {
    display: grid;
    grid-template-columns: 1fr 2fr;
    height: 100%;
    align-items: stretch;
  }

  .filter-rail {
    --circle-gap: 14px;
    --circle-col-min: 120px;
    --mini-size: 100px;
    --mini-arc-size: 88px;
    --mini-font: 16px;
    --row-gap-between-controls: 10px;
    --control-col-min: 72px;
    --control-gap: 10px;
    grid-column: 1;
    padding: 18px 28px;
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
    gap: 12px;
    height: 100%;
    overflow: hidden;
  }

  .history-chart-section {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 6px;
    width: 100%;
    box-sizing: border-box;
  }

  .history-chart-title {
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--muted);
  }

  .overlay-slot {
    position: relative;
    width: 100%;
    overflow: hidden;
    display: flex;
    flex: 1;
    min-height: 0;
    align-items: flex-start;
  }

  .detail-overlay {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    z-index: 8;
    pointer-events: auto;
    display: flex;
    width: 100%;
  }

  .detail-overlay.with-chart {
    bottom: 0;
    height: 100%;
  }

  .history-chart-section.needs-space {
    flex: 1;
    min-height: 0;
  }

  .filter-grid {
    display: grid;
    grid-template-columns: repeat(6, minmax(var(--mini-size), 1fr));
    column-gap: var(--circle-gap);
    row-gap: var(--circle-gap);
    width: 100%;
    justify-items: start;
    align-items: center;
    justify-content: start;
    margin-bottom: 10px;
  }

  .control-circles {
    display: inline-grid;
    grid-auto-flow: column;
    grid-auto-columns: max-content;
    column-gap: var(--control-gap);
    row-gap: var(--control-gap);
    justify-items: start;
    width: fit-content;
    max-width: none;
    justify-content: start;
    margin-bottom: var(--row-gap-between-controls);
  }

  @media (max-width: 1180px) {
    .filter-grid {
      grid-template-columns: repeat(auto-fit, minmax(var(--mini-size), 1fr));
    }
  }

  .circle-btn {
    width: 48px;
    height: 48px;
    border-radius: 50%;
    background: var(--bg);
    border: 2px solid rgba(255, 255, 255, 0.85);
    color: var(--fg);
    font-weight: 700;
    font-size: 18px;
    cursor: pointer;
    transition: transform 0.12s ease, background 0.2s ease, border-color 0.2s ease, color 0.2s ease;
    box-shadow: var(--shadow);
  }

  .circle-btn:hover {
    transform: translateY(-1px);
    background: rgba(255, 255, 255, 0.12);
    border-color: #fff;
    color: #fff;
  }

  .mini-circle {
    width: var(--mini-size);
    height: var(--mini-size);
    border-radius: 50%;
    background: var(--bg);
    border: 2px solid rgba(255, 255, 255, 0.85);
    display: grid;
    place-items: center;
    color: var(--fg);
    cursor: pointer;
    box-shadow: var(--shadow);
    transition: background 0.2s ease, border-color 0.2s ease, transform 0.12s ease, color 0.2s ease;
    overflow: visible;
  }

  .mini-arc {
    width: var(--mini-arc-size);
    height: var(--mini-arc-size);
    overflow: visible;
  }

  .arc-text {
    font-size: var(--mini-font);
    font-weight: 700;
    letter-spacing: 0.04em;
    fill: currentColor;
    text-transform: uppercase;
    dominant-baseline: middle;
  }

  .mini-circle:hover {
    transform: translateY(-1px);
    background: rgba(255, 255, 255, 0.12);
    border-color: #fff;
    color: #fff;
  }

  .mini-circle.active {
    background: #fff;
    color: var(--bg);
    border-color: #fff;
  }

  .filter-overlay {
    background: var(--bg);
    border: 2px solid rgba(255, 255, 255, 0.85);
    border-radius: 20px;
    padding: 12px 14px;
    box-shadow: var(--shadow);
    width: 100%;
    overflow: auto;
    max-height: 100%;
    flex: 1 1 auto;
    min-height: 0;
    display: flex;
    flex-direction: column;
    gap: 14px;
  }

  /* Views panel uses the full middle row */
  .filter-overlay.views-open {
    padding: 8px 10px;
    height: 100%;
    max-height: 100%;
  }

  .overlay-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    margin-bottom: 8px;
  }

  .overlay-title {
    font-weight: 700;
    letter-spacing: 0.04em;
  }

  .detail-title {
    display: inline-flex;
    align-items: center;
    gap: 8px;
  }

  .overlay-swatch {
    width: 14px;
    height: 14px;
    border-radius: 4px;
    border: 1px solid rgba(255, 255, 255, 0.25);
    flex: 0 0 auto;
  }

  .panel-content {
    font-size: 13px;
    color: var(--muted);
    line-height: 1.5;
    display: flex;
    flex-direction: column;
    gap: 10px;
    overflow: hidden;
    flex: 1;
    min-height: 0;
  }

  /* Detail panel typography */
  :global(.panel-content .title) {
    font-size: 16px;
    font-weight: 800;
    letter-spacing: 0.04em;
    color: #fff;
  }

  :global(.panel-content .subtitle) {
    font-size: 12px;
    color: #cfd3e0;
    letter-spacing: 0.02em;
  }

  :global(.panel-content .summary) {
    font-size: 13px;
    color: #e7e9f1;
  }

  :global(.panel-content .kv) {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 4px 10px;
    padding: 6px 0;
    border-top: 1px dashed rgba(255,255,255,0.12);
  }

  :global(.panel-content .kv .k) {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: #9ba3c0;
  }

  :global(.panel-content .kv .v) {
    color: #f6f7fb;
    font-weight: 600;
  }

  :global(.panel-content .swatch) {
    display: inline-block;
    width: 14px;
    height: 14px;
    border-radius: 4px;
    border: 1px solid rgba(255,255,255,0.25);
    margin-right: 6px;
    vertical-align: middle;
  }

  :global(.panel-content .pill),
  :global(.panel-content .badge) {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 6px 10px;
    border-radius: 999px;
    background: rgba(255,255,255,0.08);
    border: 1px solid rgba(255,255,255,0.16);
    color: #fff;
    font-size: 11px;
    letter-spacing: 0.03em;
  }

  :global(.panel-content .actions) {
    display: grid;
    gap: 8px;
    margin-top: 2px;
  }

  :global(.panel-content .actions button) {
    text-align: left;
    background: rgba(255,255,255,0.08);
    border: 1px solid rgba(255,255,255,0.18);
    color: #fff;
    border-radius: 10px;
    padding: 8px 10px;
    font-weight: 700;
    font-size: 12px;
    cursor: pointer;
  }

  :global(.panel-content .actions button:hover) {
    background: rgba(255,255,255,0.14);
    border-color: rgba(255,255,255,0.26);
  }

  .overlay-desc {
    margin: 6px 0 10px;
    font-size: 11px;
    color: var(--muted);
    line-height: 1.4;
  }

  .info-body {
    display: grid;
    gap: 10px;
    font-size: 12px;
    line-height: 1.55;
    color: var(--muted);
  }

  .info-body p {
    margin: 0;
  }

  .info-body p + p {
    padding-top: 6px;
  }

  .info-swatches {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
    gap: 8px;
    margin-top: 4px;
  }

  .swatch-pill {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 2px 0;
    color: #e7e9f1;
    font-size: 11px;
    letter-spacing: 0.02em;
    line-height: 1.2;
  }

  .swatch-pill__color {
    width: 16px;
    height: 16px;
    border-radius: 5px;
    border: 1px solid rgba(255, 255, 255, 0.25);
    flex: 0 0 auto;
  }

  .info-body strong {
    color: #fff;
    letter-spacing: 0.02em;
  }

  .info-body u {
    text-decoration-thickness: 2px;
    text-decoration-color: rgba(255, 255, 255, 0.35);
    text-underline-offset: 3px;
  }

  .info-body em {
    color: #e7e9f1;
  }

  .info-citations {
    margin-top: 14px;
    padding-top: 10px;
    border-top: 1px solid rgba(255, 255, 255, 0.08);
  }

  .info-citations-title {
    font-size: 10px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--muted);
    margin-bottom: 6px;
  }

  .info-citations p {
    font-size: 10px;
    color: var(--muted);
    line-height: 1.5;
    margin: 0 0 8px;
  }

  .info-citations p:last-child {
    margin-bottom: 0;
  }

  .info-citations a {
    color: var(--accent, #7dd3fc);
    text-decoration: none;
  }

  .info-citations a:hover {
    text-decoration: underline;
  }

  .overlay-actions {
    display: flex;
    gap: 8px;
    align-items: center;
    margin-bottom: 6px;
  }

  .btn {
    font-size: 11px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    cursor: pointer;
    padding: 6px 10px;
    border-radius: 12px;
    border: 1px solid rgba(255, 255, 255, 0.18);
    background: rgba(255, 255, 255, 0.08);
    color: var(--fg);
  }

  .chevron {
    border: 2px solid rgba(255, 255, 255, 0.85);
    background: var(--bg);
    color: var(--fg);
    width: 30px;
    height: 30px;
    border-radius: 50%;
    cursor: pointer;
    display: grid;
    place-items: center;
    font-weight: 800;
  }

  .year-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(90px, 1fr));
    gap: 8px;
  }

  .chip {
    background: rgba(255, 255, 255, 0.08);
    border: 1px solid rgba(255, 255, 255, 0.14);
    color: var(--fg);
    border-radius: 999px;
    padding: 8px 12px;
    font-weight: 600;
    font-size: 12px;
    cursor: pointer;
    transition: transform 0.12s ease, background 0.2s ease, border-color 0.2s ease;
  }

  .chip.active {
    background: #fff;
    color: var(--bg);
    border-color: #fff;
  }

  .viz-area {
    grid-column: 2;
    position: relative;
    overflow: visible;
  }

</style>
