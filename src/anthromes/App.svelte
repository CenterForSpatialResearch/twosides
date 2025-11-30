<script>
  import { onMount } from 'svelte';
  import WaffleChart from './lib/WaffleChart.svelte';
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
  let debugMenuVisible = $state(true);
  let mapReady = $state(false);
  let initialLoad = $state(true);

  // Filter state
  let filterExpanded = $state(false);
  let filterCircleSize = $state(160); // diameter (COLLAPSED_R * 2)
  let filterCompact = $state(false);
  let expandedTimestamp = $state(0);
  let filterCircleEl = $state(null);

  // Load data on mount
  onMount(async () => {
    try {
      performance.mark('data-prep-start');
      console.info('Anthromes: loading data…');
      const result = await prepareAnthromesData();
      performance.mark('data-prep-end');
      performance.measure('data-preparation', 'data-prep-start', 'data-prep-end');
      console.info('Anthromes: data loaded');

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

  // Filter circle expand/collapse
  function expandFilter() {
    filterExpanded = true;
    expandedTimestamp = Date.now();

    // Calculate expanded size
    const vw = Math.max(document.documentElement.clientWidth, window.innerWidth || 0);
    const vh = Math.max(document.documentElement.clientHeight, window.innerHeight || 0);
    const maxR = Math.floor(Math.min(vw, vh) / 2) - 28;
    const r = Math.min(440, maxR);
    filterCircleSize = r * 2;
  }

  function collapseFilter() {
    filterExpanded = false;
    filterCircleSize = 160;
  }

  // Handle window click to collapse filter
  function handleWindowClick(e) {
    const target = e.target;
    if (target.closest('.filter-circle') || target.closest('.settings-panel') || target.closest('.settings-toggle')) return;
    if (filterExpanded && Date.now() - expandedTimestamp > 100) {
      collapseFilter();
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
    <div class="side-title">ANTHROMES // 12,017 YEARS OF LAND USE</div>

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

      <button class="export-btn" onclick={handleExport}>
        Export SVG
      </button>

      <div class="tip">
        Press M to toggle settings, Esc to reset
      </div>
    </div>

    <!-- Main Visualization -->
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
    />

    <!-- Circular Filter Widget -->
    <div
      bind:this={filterCircleEl}
      class="filter-circle"
      class:expanded={filterExpanded}
      class:compact={filterCompact}
      style="width: {filterCircleSize}px; height: {filterCircleSize}px; left: 24px; bottom: 24px;"
      aria-live="polite"
    >
      <svg class="ring-svg" viewBox="-{filterCircleSize/2} -{filterCircleSize/2} {filterCircleSize} {filterCircleSize}" aria-hidden="true">
        <circle class="filter-ring" cx="0" cy="0" r="{filterCircleSize/2 - 3}" />
        <text class="filter-caption" style="opacity: {filterExpanded ? 1 : 0};">
          <textPath href="#fc-arc-right" startOffset="50%" text-anchor="middle">
            MODELING 12,017 YEARS OF LAND USE
          </textPath>
        </text>
        <defs>
          <path id="fc-arc-right" d="M 0 -{filterCircleSize/2 - 25} A {filterCircleSize/2 - 25} {filterCircleSize/2 - 25} 0 0 1 0 {filterCircleSize/2 - 25}" />
        </defs>
      </svg>

      <div class="content">
        <!-- Collapsed -->
        {#if !filterExpanded}
          <div class="fc-collapsed">
            <span class="label">FILTER</span>
            <button class="chev" title="Expand" onclick={(e) => { e.stopPropagation(); expandFilter(); }}>▾</button>
          </div>
        {/if}

        <!-- Expanded -->
        {#if filterExpanded}
          <div class="fc-expanded">
            <div class="sections">
              <div class="fc-head">
                <div class="fc-title">Filters & Legend</div>
                <div class="actions">
                  <button class="btn" title="Select all" onclick={handleSelectAll}>Select All</button>
                  <button class="btn" title="Clear" onclick={handleClear}>Clear</button>
                  <button class="chevron" title="Collapse" onclick={(e) => { e.stopPropagation(); collapseFilter(); }}>▴</button>
                </div>
              </div>

              <section class="section">
                <h3>Anthrome Range</h3>
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
              </section>

            </div>
          </div>
        {/if}
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

  .content {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 50%;
    background: transparent;
    box-shadow: var(--shadow);
    padding: 18px;
    z-index: 1;
  }

  .filter-circle.expanded .content {
    background: var(--panel);
  }

  .fc-collapsed {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .fc-collapsed .label {
    font-size: 12px;
    font-weight: 800;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--muted);
  }

  .fc-collapsed .chev {
    border: 1px solid rgba(255, 255, 255, 0.18);
    background: rgba(255, 255, 255, 0.06);
    color: var(--fg);
    width: 34px;
    height: 28px;
    border-radius: 10px;
    cursor: pointer;
  }

  .fc-expanded {
    display: flex;
    width: 100%;
    height: 100%;
  }

  .sections {
    margin: auto;
    width: 86%;
    height: 86%;
    display: flex;
    flex-direction: column;
    gap: 10px;
    align-items: center;
    justify-content: center;
    text-align: center;
  }

  .fc-head {
    width: 100%;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }

  .fc-title {
    font-size: 10px;
    color: var(--muted);
    letter-spacing: 0.14em;
    text-transform: uppercase;
  }

  .actions {
    display: flex;
    gap: 8px;
  }

  .btn {
    font-size: 10px;
    font-weight: 800;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    cursor: pointer;
    padding: 6px 9px;
    border-radius: 10px;
    border: 1px solid rgba(255, 255, 255, 0.18);
    background: rgba(255, 255, 255, 0.06);
    color: var(--fg);
  }

  .chevron {
    border: 1px solid rgba(255, 255, 255, 0.18);
    background: rgba(255, 255, 255, 0.06);
    color: var(--fg);
    width: 34px;
    height: 28px;
    border-radius: 10px;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .section {
    width: 100%;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 6px;
  }

  .section h3 {
    margin: 0;
    font-size: 10px;
    color: var(--muted);
    letter-spacing: 0.14em;
    text-transform: uppercase;
  }

  .filter-circle.compact .sections {
    width: 84%;
    height: 84%;
    gap: 8px;
  }

  .filter-circle.compact .section h3 {
    font-size: 9px;
    letter-spacing: 0.16em;
  }

  .filter-circle.compact .btn {
    font-size: 9px;
    padding: 5px 8px;
  }

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
    background: rgba(255, 255, 255, 0.09);
    border-color: rgba(255, 255, 255, 0.35);
    box-shadow: 0 0 0 2px rgba(255, 255, 255, 0.08) inset;
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

  .instruction-text {
    font-size: 10px;
    color: var(--muted);
    margin-top: 2px;
    line-height: 1.4;
    text-align: center;
  }

</style>
