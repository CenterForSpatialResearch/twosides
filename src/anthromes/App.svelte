<script>
  import { onMount } from 'svelte';
  import WaffleChart from './lib/WaffleChart.svelte';
  import HistoryCircleChart from './lib/HistoryCircleChart.svelte';
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

  // Filter rail state
  let openPanel = $state(null); // 'anthromes' | 'zooms'

  // Cell history chart state (lifted from MapCanvas via WaffleChart bindings)
  let showBarChart = $state(false);
  let barChartData = $state(null);

  // Reset signals (incrementing triggers reset in WaffleChart / MapCanvas)
  let isolationReset = $state(0);
  let panelCloseSignal = $state(0);

  // History chart section sizing
  let historyChartEl = $state(null);
  let historyChartSize = $state(220);

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
    const idx = ZOOM_LEVELS.indexOf(zoomLevel);
    if (idx < ZOOM_LEVELS.length - 1) zoomLevel = ZOOM_LEVELS[idx + 1];
  }

  function zoomOut() {
    const idx = ZOOM_LEVELS.indexOf(zoomLevel);
    if (idx > 0) zoomLevel = ZOOM_LEVELS[idx - 1];
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
    <!-- Side Title -->
    <div class="side-title">ANTHROMES // 12,025 YEARS OF LAND USE</div>

    <!-- Anthrome Zooms Link -->
    <a
      class="zooms-link"
      href="/anthrome-change-year-test.html"
      aria-label="Anthrome Zooms"
      title="Anthrome Zooms"
    >
      Anthrome Zooms
    </a>

    <!-- Settings Toggle -->
    <button
      class="settings-toggle"
      onclick={() => settingsOpen = !settingsOpen}
      aria-label="Settings"
      title="Settings (M)"
    >
      ⚙️
    </button>

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
          <span class="label">Anthromes</span>
        </button>
        <button class="mini-circle" class:active={openPanel === 'zooms'} onclick={() => openPanel = openPanel === 'zooms' ? null : 'zooms'}>
          <span class="label">Zooms</span>
        </button>
      </div>

        {#if openPanel}
          <div class="filter-overlay" aria-live="polite">
            <div class="overlay-head">
              <div class="overlay-title">
                {openPanel === 'anthromes' ? 'Anthromes' : 'Zooms'}
              </div>
              <button class="chevron" onclick={() => openPanel = null} aria-label="Close">✕</button>
            </div>

          {#if openPanel === 'anthromes'}
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
              <p class="overlay-desc">Zoom presets — coming soon.</p>
            {/if}
          </div>
        {/if}

        {#if showBarChart && barChartData?.length}
          <div class="history-chart-section" bind:this={historyChartEl}>
            <div class="history-chart-title">Cell History</div>
            <HistoryCircleChart periods={barChartData} size={historyChartSize} />
          </div>
        {/if}
      </div>

      <div class="viz-area">
        <WaffleChart
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
          mapScale={zoomLevel}
          mapRotation={rotation}
          bind:mapPanX
          bind:mapPanY
          bind:showBarChart
          bind:barChartData
          bind:isolationReset
          panelCloseSignal={panelCloseSignal}
        />
      </div>
    </div>
  </div>
{/if}

<style>
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
    background: #fff;
    border-color: #fff;
    box-shadow: 0 0 0 2px rgba(255, 255, 255, 0.2) inset;
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
    color: var(--bg);
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
    grid-column: 1;
    padding: 18px 28px;
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
    gap: 12px;
    height: 100%;
    overflow: visible;
  }

  .history-chart-section {
    position: fixed;
    left: 0;
    top: 50vh;           /* start at the midpoint of the screen */
    width: 33.33vw;      /* full filter rail width */
    height: 40vh;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 6px;
    overflow: visible;
    padding: 8px;
    box-sizing: border-box;
    pointer-events: none;
  }

  .history-chart-title {
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--muted);
  }

  .filter-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(80px, 1fr));
    gap: 10px;
    max-width: 50%;
  }

  .control-circles {
    display: grid;
    grid-template-columns: repeat(5, 1fr);
    gap: 8px;
    justify-items: center;
    max-width: 50%;
  }

  .circle-btn {
    width: 48px;
    height: 48px;
    border-radius: 50%;
    background: rgba(255, 255, 255, 0.08);
    border: 1px solid rgba(255, 255, 255, 0.18);
    color: var(--fg);
    font-weight: 700;
    font-size: 18px;
    cursor: pointer;
    transition: transform 0.12s ease, background 0.2s ease, border-color 0.2s ease;
    box-shadow: var(--shadow);
  }

  .circle-btn:hover {
    transform: translateY(-1px);
    background: rgba(255, 255, 255, 0.16);
    border-color: rgba(255, 255, 255, 0.28);
  }

  .mini-circle {
    width: 82px;
    height: 82px;
    border-radius: 50%;
    background: rgba(255, 255, 255, 0.08);
    border: 1px solid rgba(255, 255, 255, 0.16);
    display: grid;
    place-items: center;
    color: var(--fg);
    cursor: pointer;
    box-shadow: var(--shadow);
    transition: background 0.2s ease, border-color 0.2s ease, transform 0.12s ease;
  }

  .mini-circle .label {
    font-size: 12px;
    font-weight: 700;
    letter-spacing: 0.03em;
    color: var(--muted);
  }

  .mini-circle:hover {
    transform: translateY(-1px);
    background: rgba(255, 255, 255, 0.14);
    border-color: rgba(255, 255, 255, 0.28);
  }

  .mini-circle.active {
    background: #fff;
    color: var(--bg);
    border-color: #fff;
  }

  .filter-overlay {
    background: var(--bg);
    border: 1px solid rgba(255, 255, 255, 0.2);
    border-radius: 20px;
    padding: 12px 14px;
    box-shadow: var(--shadow);
    max-height: 70vh;
    overflow: auto;
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

  .overlay-desc {
    margin: 6px 0 10px;
    font-size: 11px;
    color: var(--muted);
    line-height: 1.4;
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
    border: 1px solid rgba(255, 255, 255, 0.18);
    background: rgba(255, 255, 255, 0.1);
    color: var(--fg);
    width: 30px;
    height: 30px;
    border-radius: 50%;
    cursor: pointer;
    display: grid;
    place-items: center;
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
