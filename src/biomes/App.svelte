<script>
  import { onMount } from 'svelte';
  import BiomesChart from './lib/BiomesChart.svelte';
  import { prepareBiomesData, colorMapping, pickTextColor, getPhylum } from './lib/dataAdapter.js';
  import * as d3 from 'd3';

  // State
  let loading = $state(true);
  let error = $state(null);
  let taxonomyTree = $state(null);
  let allPhyla = $state([]);

  // UI State
  let selectedPhyla = $state([]);
  let unknownFilter = $state(false);
  let westernFilter = $state('any');
  let viewSize = $state('full'); // 'full' or 'preview'
  let tension = $state(0.95);
  let settingsOpen = $state(false);
  let filterExpanded = $state(false);

  // Circular filter state
  let filterCircleSize = $state(160); // diameter (COLLAPSED_R * 2)
  let filterCompact = $state(false);

  const COLLAPSED_R = 80;
  const IDEAL_EXPANDED_R = 420;
  const VIEW_MARGIN = 28;

  // Track timestamps to prevent immediate closure
  let expandedTimestamp = $state(0);
  let filterCircleEl = $state(null);

  // Load data on mount
  onMount(async () => {
    try {
      const result = await prepareBiomesData();
      taxonomyTree = result.taxonomyTree;

      // Extract all phyla from the tree
      const root = d3.hierarchy(taxonomyTree);
      const leaves = root.leaves();

      const phylaSet = new Set(leaves.map(leaf => getPhylum(leaf)));
      allPhyla = Array.from(phylaSet).sort((a, b) => a.localeCompare(b));

      loading = false;
    } catch (err) {
      console.error('Failed to load biomes data:', err);
      error = err.message;
      loading = false;
    }
  });

  // Handle select all phyla
  function handleSelectAll() {
    selectedPhyla = [...allPhyla];
  }

  // Handle clear all filters
  function handleClear() {
    selectedPhyla = [];
    unknownFilter = false;
    westernFilter = 'any';
  }

  // Handle phylum chip toggle
  function togglePhylum(phylum) {
    if (selectedPhyla.includes(phylum)) {
      selectedPhyla = selectedPhyla.filter(p => p !== phylum);
    } else {
      selectedPhyla = [...selectedPhyla, phylum];
    }
  }

  // Handle keyboard shortcuts
  function handleKeydown(e) {
    if (e.key === 'M' || e.key === 'm') {
      settingsOpen = !settingsOpen;
    }
    if (e.key === 'Escape') {
      settingsOpen = false;
      if (filterExpanded) {
        collapseFilter();
      }
    }
  }

  // Circular filter expand/collapse
  function maxRadiusForViewport() {
    const vw = Math.max(document.documentElement.clientWidth, window.innerWidth || 0);
    const vh = Math.max(document.documentElement.clientHeight, window.innerHeight || 0);
    return Math.floor(Math.min(vw, vh) / 2) - VIEW_MARGIN;
  }

  function setCircleRadius(r) {
    filterCircleSize = r * 2; // diameter
  }

  function ensureCircleFits() {
    if (!filterExpanded || !filterCircleEl) return;

    const sections = filterCircleEl.querySelector('.sections');
    if (!sections) return;

    const rPx = filterCircleSize / 2;
    const innerDiameter = filterCircleSize * 0.86;
    const sRect = sections.getBoundingClientRect();
    const tooWide = sRect.width > innerDiameter;
    const tooHigh = sRect.height > innerDiameter;

    if (tooWide || tooHigh) {
      const cap = maxRadiusForViewport();
      if (rPx + 30 <= cap) {
        setCircleRadius(rPx + 30);
        requestAnimationFrame(ensureCircleFits);
        return;
      }
      filterCompact = true;
    } else {
      filterCompact = false;
    }
  }

  function expandFilter() {
    filterExpanded = true;
    expandedTimestamp = Date.now();
    const startR = Math.min(IDEAL_EXPANDED_R, maxRadiusForViewport());
    setCircleRadius(startR);
    requestAnimationFrame(ensureCircleFits);
  }

  function collapseFilter() {
    filterExpanded = false;
    filterCompact = false;
    setCircleRadius(COLLAPSED_R);
  }

  // Handle click outside to collapse filter
  function handleWindowClick(e) {
    const target = e.target;
    if (target.closest('.filter-circle') || target.closest('#settings') || target.closest('#menuToggle')) {
      return;
    }
    if (filterExpanded && Date.now() - expandedTimestamp > 100) {
      collapseFilter();
    }
  }

  // Handle export
  function handleExport() {
    const svg = document.getElementById('chart');
    if (!svg) return;

    const dim = viewSize === 'full' ? 7000 : 1200;
    const clone = svg.cloneNode(true);

    // Add background rect
    const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    rect.setAttribute('x', -dim / 2);
    rect.setAttribute('y', -dim / 2);
    rect.setAttribute('width', dim);
    rect.setAttribute('height', dim);
    rect.setAttribute('fill', '#0e0b16');
    clone.insertBefore(rect, clone.firstChild);

    // Inline all styles
    clone.querySelectorAll('*').forEach(el => {
      const cs = getComputedStyle(el);
      let style = '';
      for (let i = 0; i < cs.length; i++) {
        const prop = cs[i];
        if (!prop.startsWith('-')) {
          style += `${prop}:${cs.getPropertyValue(prop)};`;
        }
      }
      el.setAttribute('style', style);
    });

    const blob = new Blob([new XMLSerializer().serializeToString(clone)], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `biomes_tree_export_${viewSize}.svg`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }

  // Resize handler
  function handleResize() {
    if (!filterExpanded) return;
    const rPx = filterCircleSize / 2;
    const cap = maxRadiusForViewport();
    if (rPx > cap) setCircleRadius(cap);
    requestAnimationFrame(ensureCircleFits);
  }

  // Mount effects
  onMount(() => {
    window.addEventListener('click', handleWindowClick);
    window.addEventListener('resize', handleResize);

    return () => {
      window.removeEventListener('click', handleWindowClick);
      window.removeEventListener('resize', handleResize);
    };
  });
</script>

<svelte:window onkeydown={handleKeydown} />

{#if loading}
  <div class="loading">
    <p>Loading biomes data...</p>
  </div>
{:else if error}
  <div class="error">
    <h2>Error</h2>
    <p>{error}</p>
  </div>
{:else}
  <div class="app">
    <!-- Side Title -->
    <div class="side-title">BIOMES // 5000 LINES 5000 SPECIES</div>

    <!-- Settings Toggle -->
    <button
      id="menuToggle"
      class="settings-toggle"
      onclick={() => settingsOpen = !settingsOpen}
      aria-label="Settings"
      title="Settings (M)"
    >
      ⚙️
    </button>

    <!-- Settings Panel -->
    <div id="settings" class="settings-panel" class:open={settingsOpen}>
      <label>
        <span>View Size</span>
        <select bind:value={viewSize}>
          <option value="preview">Preview (1200×1200)</option>
          <option value="full">Full Export (6400×6400)</option>
        </select>
      </label>

      <label>
        <span>Bundling Tension</span>
        <span class="tension-value">{tension.toFixed(2)}</span>
      </label>
      <input
        type="range"
        bind:value={tension}
        min="0.1"
        max="1.0"
        step="0.05"
        class="tension-slider"
      />

      <button class="export-btn" onclick={handleExport}>
        Export SVG
      </button>

      <div class="tip">
        Tip: hover for details, click to pin; click empty space to unpin. Press "M" to toggle this menu. Scroll to zoom, drag to pan.
      </div>
    </div>

    <!-- Main Visualization -->
    <BiomesChart
      {taxonomyTree}
      bind:selectedPhyla
      bind:unknownFilter
      bind:westernFilter
      size={viewSize}
      {tension}
    />

    <!-- Circular Filter Widget -->
    <div
      bind:this={filterCircleEl}
      class="filter-circle"
      class:expanded={filterExpanded}
      class:compact={filterCompact}
      style="width: {filterCircleSize}px; height: {filterCircleSize}px;"
      aria-live="polite"
    >
      <svg class="ring-svg" viewBox="-{filterCircleSize/2} -{filterCircleSize/2} {filterCircleSize} {filterCircleSize}" aria-hidden="true">
        <circle class="filter-ring" cx="0" cy="0" r="{filterCircleSize/2 - 3}" />
        <text class="filter-caption" style="opacity: {filterExpanded ? 1 : 0};">
          <textPath href="#fc-arc-right" startOffset="50%" text-anchor="middle">
            AN EXTENSIVE HUMAN MICROBIOME
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
                <div class="fc-title">Filters</div>
                <div class="actions">
                  <button class="btn" title="Select all phyla" onclick={handleSelectAll}>Select All</button>
                  <button class="btn" title="Clear all filters" onclick={handleClear}>Clear</button>
                  <button class="chevron" title="Collapse" onclick={(e) => { e.stopPropagation(); collapseFilter(); }}>▴</button>
                </div>
              </div>

              <section class="section">
                <h3>Phylum</h3>
                <div class="chips">
                  {#each allPhyla as phylum}
                    {@const color = colorMapping[phylum] || colorMapping.Other}
                    {@const textColor = pickTextColor(color)}
                    <button
                      class="chip"
                      class:active={selectedPhyla.includes(phylum)}
                      style="background: {color}; color: {textColor};"
                      onclick={() => togglePhylum(phylum)}
                    >
                      {phylum.replace(/_/g, ' ')}
                    </button>
                  {/each}
                </div>
              </section>

              <section class="section">
                <h3>Geography</h3>
                <div class="pills">
                  <label class="pill">
                    <input type="radio" name="western" value="any" bind:group={westernFilter} />
                    Any
                  </label>
                  <label class="pill">
                    <input type="radio" name="western" value="western" bind:group={westernFilter} />
                    Western
                  </label>
                  <label class="pill">
                    <input type="radio" name="western" value="nonwestern" bind:group={westernFilter} />
                    Non-Western
                  </label>
                </div>
              </section>

              <section class="section">
                <h3>Status</h3>
                <label class="pill" title="Unknown SGBs only">
                  <input type="checkbox" bind:checked={unknownFilter} />
                  Unknown
                </label>
              </section>
            </div>
          </div>
        {/if}
      </div>
    </div>
  </div>
{/if}

<style>
  .loading,
  .error {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 100vh;
    text-align: center;
    color: var(--fg);
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

  .side-title {
    position: fixed;
    left: 14px;
    top: 50%;
    transform: translateY(-50%);
    writing-mode: vertical-rl;
    text-orientation: mixed;
    letter-spacing: 0.08em;
    font-weight: 600;
    font-size: 20px;
    color: var(--muted);
    opacity: 0.9;
    user-select: none;
    z-index: 4;
  }

  .settings-toggle {
    position: fixed;
    top: 12px;
    right: 12px;
    z-index: 8;
    background: var(--panel);
    border: 1px solid rgba(255, 255, 255, 0.14);
    width: 40px;
    height: 40px;
    border-radius: 12px;
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    box-shadow: var(--shadow);
    font-size: 18px;
    color: var(--muted);
  }

  .settings-toggle:hover {
    color: var(--fg);
  }

  .settings-panel {
    position: fixed;
    top: 64px;
    right: 12px;
    z-index: 7;
    background: linear-gradient(180deg, rgba(20, 18, 38, 0.97), rgba(20, 18, 38, 0.9));
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: 14px;
    padding: 12px 14px;
    width: 320px;
    box-shadow: var(--shadow);
    backdrop-filter: blur(6px);
    display: none;
  }

  .settings-panel.open {
    display: block;
  }

  .settings-panel label {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    color: var(--muted);
    font-size: 13px;
    margin: 8px 0;
  }

  .settings-panel select,
  .settings-panel button {
    background: var(--panel);
    color: var(--fg);
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: 10px;
    padding: 6px 10px;
  }

  .tension-slider {
    width: 100%;
    accent-color: var(--accent);
    margin: 0 0 8px 0;
  }

  .tension-value {
    color: var(--fg);
    font-weight: 600;
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

  .tip {
    font-size: 12px;
    color: var(--muted);
    margin-top: 8px;
    line-height: 1.45;
  }

  /* Circular Filter */
  .filter-circle {
    position: fixed;
    right: 24px;
    bottom: 24px;
    z-index: 999;
    transition: width 0.28s ease, height 0.28s ease, transform 0.28s ease, box-shadow 0.2s ease;
    transform-origin: bottom right;
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
    padding: 22px;
    z-index: 1;
  }

  .filter-circle.expanded .content {
    background: var(--panel);
  }

  /* Collapsed state */
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

  /* Expanded state */
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
    gap: 12px;
    align-items: center;
    justify-content: center;
    text-align: center;
  }

  .fc-head {
    width: 60%;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }

  .fc-title {
    font-size: 11px;
    color: var(--muted);
    letter-spacing: 0.1em;
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
  }

  .section {
    width: 100%;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 8px;
  }

  .section h3 {
    margin: 0;
    font-size: 11px;
    color: var(--muted);
    letter-spacing: 0.1em;
    text-transform: uppercase;
  }

  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    justify-content: center;
  }

  .chip {
    white-space: nowrap;
    cursor: pointer;
    user-select: none;
    font-size: 12px;
    letter-spacing: 0.05em;
    text-transform: uppercase;
    font-weight: 700;
    padding: 8px 12px;
    border-radius: 999px;
    border: 1px solid rgba(255, 255, 255, 0.25);
    transition: transform 0.15s ease, filter 0.2s ease, outline 0.2s ease, opacity 0.2s ease;
  }

  .chip:hover {
    transform: translateY(-1px);
    filter: brightness(1.06);
  }

  .chip.active {
    outline: 2px solid rgba(255, 255, 255, 0.75);
  }

  .pills {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
    justify-content: center;
  }

  .pill {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    border-radius: 999px;
    border: 1px solid rgba(255, 255, 255, 0.18);
    background: rgba(255, 255, 255, 0.06);
    color: var(--fg);
    font-size: 12px;
    font-weight: 700;
    text-transform: uppercase;
    cursor: pointer;
  }

  .pill input {
    accent-color: var(--accent);
    cursor: pointer;
  }

  /* Compact mode */
  .filter-circle.compact .sections {
    width: 84%;
    height: 84%;
    gap: 10px;
  }

  .filter-circle.compact .section h3 {
    font-size: 10px;
    letter-spacing: 0.12em;
  }

  .filter-circle.compact .chip {
    font-size: 11px;
    padding: 7px 10px;
  }

  .filter-circle.compact .pill {
    font-size: 11px;
    padding: 7px 10px;
  }

  .filter-circle.compact .btn {
    font-size: 9px;
    padding: 5px 8px;
  }
</style>
