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
  let selectedBodySites = $state(new Set()); // retained for compatibility but hidden in UI
  let selectedStudyKey = $state(null);
  let zoomIdx = $state(0);
  const cohortOptions = [
    { key: 'CM_madagascar', label: 'Madagascar' },
    { key: 'BritoIL_2016', label: 'Fiji' },
    { key: 'ChengpingW_2017', label: 'China' },
    { key: 'AsnicarF_2017', label: 'Italy' },
    { key: 'BackhedF_2015', label: 'Sweden' },
    { key: 'Castro-NallarE_2015', label: 'USA' }
  ];
  let studyKeys = $state(cohortOptions.map(c => c.key));
  // Panel state
  let infoOpen = $state(false);

  // Circular filter state
  let openPanel = $state(null); // 'phylum' | 'geo' | 'status' | 'study' | null
  let filterRailEl = $state(null);
  let biomesChartRef = $state(null);
  let detailContent = $state(null);

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

      // Load study keys from study_index
      try {
        const studyRes = await fetch('/data/study_index.json');
        if (studyRes.ok) {
          await studyRes.json(); // already have curated cohorts; nothing else required
        }
      } catch (e) {
        console.warn('Failed to load study index', e);
      }

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

  function toggleBodySite(site) {
    const next = new Set(selectedBodySites);
    next.has(site) ? next.delete(site) : next.add(site);
    selectedBodySites = next;
  }

  function selectStudyKey(key) {
    selectedStudyKey = selectedStudyKey === key ? null : key;
  }

  // Handle keyboard shortcuts
  function handleKeydown(e) {
    if (e.key === 'M' || e.key === 'm') {
      settingsOpen = !settingsOpen;
    }
    if (e.key === 'Escape') {
      settingsOpen = false;
      openPanel = null;
    }
  }

  // Handle click outside to close panel
  function handleWindowClick(e) {
    const target = e.target;
    if (target.closest('.filter-rail') || target.closest('#settings') || target.closest('#menuToggle')) {
      return;
    }
    openPanel = null;
    if (!target.closest('.viz-area')) {
      detailContent = null;
    }
  }

  function handleZoomChange(event) {
    zoomIdx = event.detail?.index ?? 0;
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
    // no-op for now; reserved for responsive tweaks
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

  function handleDetail(event) {
    detailContent = event.detail?.content || null;
  }

  function handleDetailClose() {
    detailContent = null;
  }
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
    <!-- Nav circle: switch sides -->
    <a class="nav-circle nav-circle--left" href="/anthromes/" aria-label="Go to Anthromes">
      <svg viewBox="0 0 120 120" aria-hidden="true">
        <defs>
          <path id="nav-arc-top" d="M15 60 A45 45 0 0 1 105 60" />
          <path id="nav-arc-bottom" d="M105 60 A45 45 0 0 1 15 60" />
        </defs>
        <circle class="nav-circle__ring" cx="60" cy="60" r="52" />
        <text class="nav-circle__text nav-circle__text--active">
          <textPath href="#nav-arc-top" startOffset="50%" text-anchor="middle"><tspan class="here">BIOMES</tspan></textPath>
        </text>
        <text class="nav-circle__text">
          <textPath href="#nav-arc-bottom" startOffset="50%" text-anchor="middle">ANTHROMES →</textPath>
        </text>
      </svg>
    </a>

    <!-- Settings toggle & panel intentionally hidden for now -->

    <div class="layout">
      <div class="viz-area">
        <BiomesChart
          bind:this={biomesChartRef}
          {taxonomyTree}
          bind:selectedPhyla
          bind:unknownFilter
          bind:westernFilter
          size={viewSize}
          {tension}
          bodySiteFilter={selectedBodySites}
          proxyKey={null}
          studyKey={selectedStudyKey}
          on:detail={handleDetail}
          on:detail-close={handleDetailClose}
          on:zoomchange={handleZoomChange}
        />
      </div>

      <div class="filter-rail" bind:this={filterRailEl}>
        <div class="control-circles">
          <button class="circle-btn" title="Info" onclick={() => openPanel = openPanel === 'info' ? null : 'info'}>i</button>
          <button class="circle-btn" title="Zoom out" onclick={() => biomesChartRef?.zoomOutControl?.()} disabled={zoomIdx === 0} aria-disabled={zoomIdx === 0}>−</button>
          <button class="circle-btn" title="Reset" onclick={() => biomesChartRef?.resetControl?.()}>◎</button>
          <button class="circle-btn" title="Zoom in" onclick={() => biomesChartRef?.zoomInControl?.()} disabled={zoomIdx === 2} aria-disabled={zoomIdx === 2}>＋</button>
          <button class="circle-btn" title="Rotate left" onclick={() => biomesChartRef?.rotateLeftControl?.()}>⟲</button>
          <button class="circle-btn" title="Rotate right" onclick={() => biomesChartRef?.rotateRightControl?.()}>⟳</button>
        </div>

        <div class="overlay-slot">
          {#if openPanel}
            {@const overlayTitle =
              openPanel === 'info' ? 'Biomes Overview' :
              openPanel === 'phylum' ? 'Phylum' :
              openPanel === 'geo' ? 'Geography' :
              openPanel === 'status' ? 'Status' :
              openPanel === 'study' ? 'Cohorts' : ''}
            <div class="filter-overlay" aria-live="polite">
              <div class="overlay-head">
                <div class="overlay-title">{overlayTitle}</div>
                <button class="chevron" onclick={() => openPanel = null} aria-label="Close">✕</button>
              </div>
              {#if openPanel === 'info'}
                <div class="info-body">
                  <p>This visualization shows an evolution of the extensive human microbiome.</p>
                  <p>9,316 sample collections across 46 datasets plus a Madagascar cohort (Segata Lab).</p>
                  <p>Each line is a Species-Level Genetic Bin (SGB). 77% of species shown were previously unknown.</p>
                  <p>Western vs Non-Western diversity highlights the importance of indigenous populations.</p>
                </div>
              {:else}
              {#if openPanel === 'phylum'}
                <p class="overlay-desc">Filter the tree to only the selected phyla.</p>
              {:else if openPanel === 'geo'}
                <p class="overlay-desc">Limit to Western or Non-Western assignments from sample metadata.</p>
              {:else if openPanel === 'status'}
                <p class="overlay-desc">Show only uSGBs (Unknown species genome bins) when enabled.</p>
              {:else if openPanel === 'study'}
                <p class="overlay-desc">Filter to selected cohorts (named by primary country).</p>
              {/if}

              {#if openPanel === 'phylum'}
                <div class="overlay-actions">
                  <button class="btn" onclick={handleSelectAll} title="Select all phyla">Select all</button>
                  <button class="btn" onclick={() => selectedPhyla = []} title="Clear phyla">Clear</button>
                </div>
                <section class="section">
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
              {:else if openPanel === 'geo'}
                <div class="overlay-actions">
                  <button class="btn" onclick={() => westernFilter = 'any'}>All</button>
                  <button class="btn" onclick={() => westernFilter = 'western'}>Western</button>
                  <button class="btn" onclick={() => westernFilter = 'nonwestern'}>Non-West.</button>
                </div>
                <section class="section">
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
              {:else if openPanel === 'status'}
                <div class="overlay-actions">
                  <button class="btn" onclick={() => unknownFilter = true}>Only unknown</button>
                  <button class="btn" onclick={() => unknownFilter = false}>Clear</button>
                </div>
                <section class="section">
                  <label class="pill" title="Unknown SGBs only">
                    <input type="checkbox" bind:checked={unknownFilter} />
                    Unknown
                  </label>
                </section>
              {:else if openPanel === 'study'}
                <div class="overlay-actions">
                  <button class="btn" onclick={() => selectedStudyKey = null}>All</button>
                  <button class="btn" onclick={() => selectedStudyKey = null}>Clear</button>
                </div>
                <section class="section">
                  <div class="chips proxy-grid">
                    {#each cohortOptions as c}
                      <button
                        class="chip"
                        class:active={selectedStudyKey === c.key}
                        onclick={() => selectStudyKey(c.key)}
                      >
                        {c.label}
                      </button>
                    {/each}
                  </div>
                </section>
              {/if}
              {/if}
            </div>
          {/if}

          {#if detailContent}
            <div class="filter-overlay detail-overlay" aria-live="polite">
              <div class="overlay-head">
                <div class="overlay-title">Details</div>
                <button class="chevron" onclick={handleDetailClose} aria-label="Close">✕</button>
              </div>
              <div class="panel-content" onclick={(event) => event.stopPropagation()}>
                {@html detailContent}
              </div>
            </div>
          {/if}
        </div>

        <div class="filter-grid">
          <button class="mini-circle" class:active={openPanel === 'phylum'} onclick={() => openPanel = openPanel === 'phylum' ? null : 'phylum'} aria-label="Phylum filters">
            <svg class="mini-arc" viewBox="0 0 100 100" aria-hidden="true">
              <defs><path id="arc-phylum" d="M50 10 A40 40 0 0 1 90 50" /></defs>
              <text class="arc-text"><textPath href="#arc-phylum" startOffset="6%">Phylum</textPath></text>
            </svg>
          </button>
          <button class="mini-circle" class:active={openPanel === 'geo'} onclick={() => openPanel = openPanel === 'geo' ? null : 'geo'} aria-label="Geography filters">
            <svg class="mini-arc" viewBox="0 0 100 100" aria-hidden="true">
              <defs><path id="arc-geo" d="M50 10 A40 40 0 0 1 90 50" /></defs>
              <text class="arc-text"><textPath href="#arc-geo" startOffset="8%">Geo</textPath></text>
            </svg>
          </button>
          <button class="mini-circle" class:active={openPanel === 'status'} onclick={() => openPanel = openPanel === 'status' ? null : 'status'} aria-label="Status filters">
            <svg class="mini-arc" viewBox="0 0 100 100" aria-hidden="true">
              <defs><path id="arc-status" d="M50 10 A40 40 0 0 1 90 50" /></defs>
              <text class="arc-text"><textPath href="#arc-status" startOffset="2%">Status</textPath></text>
            </svg>
          </button>
          <button class="mini-circle" class:active={openPanel === 'study'} onclick={() => openPanel = openPanel === 'study' ? null : 'study'} aria-label="Cohort filters">
            <svg class="mini-arc" viewBox="0 0 100 100" aria-hidden="true">
              <defs><path id="arc-cohort" d="M50 10 A40 40 0 0 1 90 50" /></defs>
              <text class="arc-text"><textPath href="#arc-cohort" startOffset="0%">Cohort</textPath></text>
            </svg>
          </button>
        </div>
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

  .layout {
    display: grid;
    grid-template-columns: 2fr 1fr;
    height: 100vh;
    align-items: stretch;
    gap: 0;
  }

  .filter-rail {
    grid-column: 2;
    padding: 18px 28px;
    box-sizing: border-box;
    display: grid;
    grid-template-rows: auto 1fr auto;
    gap: 12px;
    height: 100%;
    overflow: hidden;
    position: relative;
    z-index: 5;
  }

  .viz-area {
    position: relative;
    height: 100%;
    width: 100%;
    overflow: hidden;
  }

  .nav-circle {
    position: fixed;
    bottom: 16px;
    left: 16px;
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
    font-size: 11px;
    font-weight: 800;
    letter-spacing: 0.08em;
    fill: rgba(255, 255, 255, 0.65);
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
    display: none;
  }

  .tip {
    font-size: 12px;
    color: var(--muted);
    margin-top: 8px;
    line-height: 1.45;
  }

  /* Filter rail internals */
  .overlay-slot {
    position: relative;
    width: 100%;
    height: 100%;
    overflow: hidden;
    display: flex;
  }

  .detail-overlay {
    position: absolute;
    inset: 0;
    z-index: 8;
    pointer-events: auto;
    display: flex;
  }

  .control-circles {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(56px, 1fr));
    gap: 10px;
    justify-items: center;
    width: 100%;
    max-width: 520px;
    justify-self: end;
    margin-left: auto;
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

  .circle-btn:disabled,
  .circle-btn[aria-disabled="true"] {
    opacity: 0.4;
    cursor: not-allowed;
    pointer-events: none;
    filter: grayscale(0.3);
  }

  .info-panel {
    background: var(--panel);
    border: 1px solid rgba(255, 255, 255, 0.14);
    border-radius: 12px;
    padding: 10px 12px;
    box-shadow: var(--shadow);
    font-size: 12px;
    color: var(--fg);
    display: grid;
    gap: 6px;
  }

  .info-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }

  .info-title {
    font-weight: 700;
    letter-spacing: 0.05em;
    text-transform: uppercase;
    font-size: 11px;
  }

  .info-body p {
    margin: 0;
    line-height: 1.4;
    color: var(--muted);
  }

  .filter-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(80px, 1fr));
    gap: 10px;
    width: 100%;
    align-self: end;
  }

  .mini-circle {
    width: 82px;
    height: 82px;
    border-radius: 50%;
    background: var(--bg);
    border: 2px solid rgba(255, 255, 255, 0.85);
    display: grid;
    place-items: center;
    color: var(--fg);
    cursor: pointer;
    box-shadow: var(--shadow);
    transition: background 0.2s ease, border-color 0.2s ease, transform 0.12s ease, color 0.2s ease;
  }

  .mini-arc {
    width: 72px;
    height: 72px;
    overflow: visible;
  }

  .arc-text {
    font-size: 12px;
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
    border: 1px solid rgba(255, 255, 255, 0.2);
    border-radius: 20px;
    padding: 12px 14px;
    box-shadow: var(--shadow);
    width: 100%;
    height: 100%;
    max-height: 100%;
    overflow: auto;
    position: relative;
    z-index: 6;
    display: flex;
    flex-direction: column;
    gap: 14px;
  }

  .overlay-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    margin-bottom: 10px;
  }

  .overlay-title {
    font-weight: 700;
    letter-spacing: 0.04em;
  }

  .panel-content {
    font-size: 13px;
    color: var(--muted);
    line-height: 1.5;
    display: grid;
    gap: 10px;
    overflow: auto;
    height: 100%;
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
    margin: 4px 0 10px;
    color: var(--muted);
    font-size: 12px;
    line-height: 1.4;
  }

  .overlay-actions {
    display: flex;
    gap: 8px;
    align-items: center;
  }

  .btn {
    background: rgba(255, 255, 255, 0.08);
    border: 1px solid rgba(255, 255, 255, 0.14);
    color: var(--fg);
    border-radius: 999px;
    padding: 6px 10px;
    font-weight: 600;
    font-size: 12px;
    cursor: pointer;
  }

  .chevron {
    background: rgba(255, 255, 255, 0.1);
    border: 1px solid rgba(255, 255, 255, 0.14);
    color: var(--fg);
    border-radius: 50%;
    width: 28px;
    height: 28px;
    display: grid;
    place-items: center;
    font-weight: 700;
    cursor: pointer;
  }

  .section {
    margin: 10px 0;
  }

  .chips {
    display: flex;
    flex-wrap: wrap;
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

  .chip:hover {
    background: rgba(255, 255, 255, 0.14);
    border-color: rgba(255, 255, 255, 0.22);
    transform: translateY(-1px);
  }

  .chip.active {
    box-shadow: 0 0 0 2px rgba(255, 255, 255, 0.25);
  }

  .pills {
    display: flex;
    gap: 10px;
    flex-wrap: wrap;
  }

  .pill {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    background: rgba(255, 255, 255, 0.06);
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: 999px;
    padding: 8px 12px;
    cursor: pointer;
    font-size: 12px;
  }

  .pill input {
    accent-color: var(--accent, #8af);
  }

  .proxy-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
    gap: 6px;
    margin-top: 4px;
  }

  .placeholder {
    color: var(--muted);
    font-size: 13px;
  }
</style>
