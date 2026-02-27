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
  let unknownFilter = $state('all'); // 'all' | 'unknown' | 'known'
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
  let detailPoint = $state(null);
  let detailPanelEl = $state(null);
  let detailPanelAnchor = $state(null);
  let viewportW = $state(0);
  let viewportH = $state(0);

  // Load data on mount
  onMount(async () => {
    try {
      const result = await prepareBiomesData();
      taxonomyTree = result.taxonomyTree;

      // Extract all phyla from the tree
      const root = d3.hierarchy(taxonomyTree);
      const leaves = root.leaves();

      const phylumCounts = d3.rollup(leaves, v => v.length, leaf => getPhylum(leaf));
      allPhyla = Array.from(phylumCounts.entries())
        .sort((a, b) => b[1] - a[1])
        .map(([phylum]) => phylum);

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
    unknownFilter = 'all';
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
      detailPoint = null;
    }
  }

  function handleZoomChange(event) {
    zoomIdx = event.detail?.index ?? 0;
  }

  // Close detail when any panel opens
  $effect(() => {
    if (openPanel && detailContent) {
      detailContent = null;
      detailPoint = null;
    }
  });

  $effect(() => {
    if (detailPanelEl && detailPoint) {
      const rect = detailPanelEl.getBoundingClientRect();
      detailPanelAnchor = {
        x: rect.left + 2,
        y: rect.top + rect.height / 2
      };
    } else {
      detailPanelAnchor = null;
    }
  });

  function handleDetail(event) {
    detailContent = event.detail?.content || null;
    detailPoint = event.detail?.point || null;
    openPanel = null;
  }

  function handleDetailPanelClick(event) {
    event.stopPropagation();
    biomesChartRef?.handleTooltipAction?.(event);
  }

  function handleDetailClose() {
    detailContent = null;
    detailPoint = null;
    detailPanelAnchor = null;
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
    const setSize = () => {
      viewportW = window.innerWidth;
      viewportH = window.innerHeight;
    };
    setSize();
    window.addEventListener('resize', setSize);

    return () => {
      window.removeEventListener('click', handleWindowClick);
      window.removeEventListener('resize', handleResize);
      window.removeEventListener('resize', setSize);
    };
  });

  // (moved below)
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
    <!-- Nav circle: switch sides + home dot -->
    <div class="nav-circle nav-circle--left">
      <div class="nav-circle__outer">
        <svg viewBox="0 0 120 120" aria-hidden="true">
          <defs>
            <!-- upper arc (left→right across the top) -->
            <path id="nav-arc-top-left" d="M8 60 A52 52 0 0 1 112 60" />
            <!-- lower arc (right→left across the bottom) -->
            <path id="nav-arc-bottom-right" d="M112 60 A52 52 0 0 1 8 60" />
          </defs>
          <g class="nav-circle__labels" transform="rotate(45 60 60)">
            <circle class="nav-circle__ring" cx="60" cy="60" r="52" />
            <text class="nav-circle__text nav-circle__text--active">
              <textPath href="#nav-arc-top-left" startOffset="50%" text-anchor="middle"><tspan class="here">BIOMES</tspan></textPath>
            </text>
            <text class="nav-circle__text nav-circle__text--link">
              <a href="/src/anthromes/" aria-label="Go to Anthromes">
                <textPath href="#nav-arc-bottom-right" startOffset="50%" text-anchor="middle">ANTHROMES →</textPath>
              </a>
            </text>
          </g>
        </svg>
      </div>

      <a class="nav-circle__home" href="/src/" aria-label="Back to home">←</a>
    </div>

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

        <div class="filter-grid">
          <button class="mini-circle" class:active={openPanel === 'phylum'} onclick={() => openPanel = openPanel === 'phylum' ? null : 'phylum'} aria-label="Phylum filters">
            <svg class="mini-arc" viewBox="0 0 140 140" aria-hidden="true">
              <defs><path id="arc-phylum" d="M70 10 A60 60 0 1 1 69.9 10" /></defs>
              <text class="arc-text"><textPath href="#arc-phylum" startOffset="0%" text-anchor="start">Phylum</textPath></text>
            </svg>
          </button>
          <button class="mini-circle" class:active={openPanel === 'geo'} onclick={() => openPanel = openPanel === 'geo' ? null : 'geo'} aria-label="Geography filters">
            <svg class="mini-arc" viewBox="0 0 140 140" aria-hidden="true">
              <defs><path id="arc-geo" d="M70 10 A60 60 0 1 1 69.9 10" /></defs>
              <text class="arc-text"><textPath href="#arc-geo" startOffset="0%" text-anchor="start">NON/WESTERN</textPath></text>
            </svg>
          </button>
          <button class="mini-circle" class:active={openPanel === 'status'} onclick={() => openPanel = openPanel === 'status' ? null : 'status'} aria-label="Status filters">
            <svg class="mini-arc" viewBox="0 0 140 140" aria-hidden="true">
              <defs><path id="arc-status" d="M70 10 A60 60 0 1 1 69.9 10" /></defs>
              <text class="arc-text"><textPath href="#arc-status" startOffset="0%" text-anchor="start">UN/KNOWN</textPath></text>
            </svg>
          </button>
          <button class="mini-circle" class:active={openPanel === 'study'} onclick={() => openPanel = openPanel === 'study' ? null : 'study'} aria-label="Cohort filters">
            <svg class="mini-arc" viewBox="0 0 140 140" aria-hidden="true">
              <defs><path id="arc-cohort" d="M70 10 A60 60 0 1 1 69.9 10" /></defs>
              <text class="arc-text"><textPath href="#arc-cohort" startOffset="0%" text-anchor="start">Cohort</textPath></text>
            </svg>
          </button>
        </div>

        <div class="overlay-slot">
          {#if openPanel}
            {@const overlayTitle =
              openPanel === 'info' ? 'Biomes Overview' :
              openPanel === 'phylum' ? 'Phylum' :
              openPanel === 'geo' ? 'NON/WESTERN' :
              openPanel === 'status' ? 'UN/KNOWN' :
              openPanel === 'study' ? 'Cohort' : ''}
            <div class="filter-overlay" aria-live="polite">
              <div class="overlay-head">
                <div class="overlay-title">{overlayTitle}</div>
                <button class="chevron" onclick={() => openPanel = null} aria-label="Close">✕</button>
              </div>
              {#if openPanel === 'info'}
                <div class="info-body">
                  <p><strong>5000 Lines 5000 Species</strong></p>
                  <p>This visualization shows an Evolution of the Extensive Human Microbiome. It reconstructs data from the Segata Lab: 9,316 sample collections spanning 46 datasets from multiple populations and an additional cohort from Madagascar. The scientists reconstructed a catalog that greatly expands the set of 150,000 microbial genomes publicly available.</p>
                  <p>Each line represents the evolutionary pathway of a Species Level Genetic Bin (SGB), a grouping that organizes genomes based on their similarity, allowing for broader identification of species, both previously known and unknown.</p>
                  <p><strong>Known / Unknown:</strong> within this study, 77% of bacteria species visualized and analyzed were previously unknown.</p>
                  <p><strong>Western / Non Western:</strong> a key finding from these data is that the human microbiome is more diverse than previously understood, especially in indigenous anthromes, which has led to calls for their preservation (see back of coin).</p>
                  <div class="info-citations">
                    <div class="info-citations-title">Citations</div>
                    <p>Pasolli, Edoardo, Francesco Asnicar, Serena Manara, Moreno Zolfo, Nicolai Karcher, Federica Armanini, Francesco Beghini, et al. 2019. "Extensive Unexplored Human Microbiome Diversity Revealed by Over 150,000 Genomes from Metagenomes Spanning Age, Geography, and Lifestyle." <em>Cell</em> 176(3): 649–662. <a href="https://doi.org/10.1016/j.cell.2019.01.001" target="_blank" rel="noopener">https://doi.org/10.1016/j.cell.2019.01.001</a></p>
                    <p>This project was completed by Laura Kurgan, Dan Miller and Adam Vosburgh at The Center for Spatial Research, Columbia University Graduate School of Architecture Planning and Preservation. This project is open-source, and the repository is located <a href="https://github.com/CenterForSpatialResearch/twosides" target="_blank" rel="noopener">here</a>.</p>
                  </div>
                </div>
              {:else}
              {#if openPanel === 'phylum'}
                <p class="overlay-desc">Filter the tree to only the selected phyla, evolutionary lineages that shape how biological diversity is organized and understood.</p>
              {:else if openPanel === 'geo'}
                <div class="overlay-desc">
                  <p><strong>Westernized</strong><br />Study-defined category referring to industrialized, urban populations with high exposure to modern medical and food systems.</p>
                  <p><strong>Non-Westernized</strong><br />Study-defined category referring to populations with limited industrialization and lower exposure to modern medical and food systems.</p>
                </div>
              {:else if openPanel === 'status'}
                <div class="overlay-desc">
                  <p><strong>Unknown (uSGB)</strong><br />Genome-defined species-level group newly identified in this study — not previously represented in reference databases.</p>
                  <p><strong>Unknown (uSGB)</strong><br />Previously uncharacterized microbial lineage revealed through large-scale metagenomic assembly.</p>
                </div>
              {:else if openPanel === 'study'}
                <p class="overlay-desc"><strong>Cohort</strong><br />A defined group of study participants whose samples were collected and analyzed together.</p>
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
                <section class="section">
                  <div class="pills">
                    <label class="pill">
                      <input type="radio" name="western" value="any" bind:group={westernFilter} />
                      All
                    </label>
                    <label class="pill">
                      <input type="radio" name="western" value="western" bind:group={westernFilter} />
                      Westernized
                    </label>
                    <label class="pill">
                      <input type="radio" name="western" value="nonwestern" bind:group={westernFilter} />
                      Non-Westernized
                    </label>
                  </div>
                </section>
              {:else if openPanel === 'status'}
                <section class="section">
                  <div class="pills">
                    <label class="pill">
                      <input type="radio" name="usgb" value="all" bind:group={unknownFilter} />
                      All
                    </label>
                    <label class="pill">
                      <input type="radio" name="usgb" value="known" bind:group={unknownFilter} />
                      Known (ref. databases)
                    </label>
                    <label class="pill">
                      <input type="radio" name="usgb" value="unknown" bind:group={unknownFilter} />
                      Unknown (uSGB)
                    </label>
                  </div>
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
            <div class="filter-overlay detail-overlay" aria-live="polite" bind:this={detailPanelEl}>
              <div class="overlay-head">
                <div class="overlay-title">Details</div>
                <button class="chevron" onclick={handleDetailClose} aria-label="Close">✕</button>
              </div>
              <!-- svelte-ignore a11y_click_events_have_key_events -->
              <!-- svelte-ignore a11y_no_static_element_interactions -->
              <div class="panel-content" onclick={handleDetailPanelClick}>
                {@html detailContent}
              </div>
            </div>
          {/if}
        </div>

        {#if detailContent && detailPoint && detailPanelAnchor}
          <svg
            class="leader-overlay"
            aria-hidden="true"
            width={viewportW}
            height={viewportH}
            viewBox={`0 0 ${viewportW} ${viewportH}`}
          >
            <line x1={detailPoint.x} y1={detailPoint.y} x2={detailPanelAnchor.x} y2={detailPanelAnchor.y} />
          </svg>
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

  .layout {
    display: grid;
    grid-template-columns: 2fr 1fr;
    height: 100vh;
    align-items: stretch;
    gap: 0;
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
    grid-column: 2;
    padding: 18px 28px;
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
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

  /* Leader overlay uses fixed viewport coords */

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
    overflow: hidden;
    display: flex;
    flex: 1;
    min-height: 0;
    align-items: flex-start;
  }

  .leader-overlay {
    position: fixed;
    inset: 0;
    pointer-events: none;
    z-index: 9;
  }

  .leader-overlay line {
    stroke: rgba(255, 255, 255, 0.65);
    stroke-width: 1.5;
    stroke-dasharray: 4 3;
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

  .control-circles {
    display: grid;
    grid-auto-flow: column;
    grid-auto-columns: max-content;
    grid-template-columns: repeat(6, max-content);
    column-gap: var(--control-gap);
    row-gap: 0;
    justify-items: start;
    width: fit-content;
    max-width: none;
    justify-self: end;
    margin-left: auto;
    justify-content: end;
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
  }

  .panel-content p {
    margin: 0;
  }

  .panel-content p + p {
    margin-top: 16px;
  }

  .panel-content strong {
    color: #fff;
    letter-spacing: 0.02em;
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
    background: var(--bg);
    border: 2px solid rgba(255, 255, 255, 0.85);
    color: var(--fg);
    border-radius: 50%;
    width: 28px;
    height: 28px;
    display: grid;
    place-items: center;
    font-weight: 800;
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
