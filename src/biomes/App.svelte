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
  let selectedProxyKey = $state(null);
  let selectedStudyKey = $state(null);
  let proxySampleKeys = $state([]);
  let studyKeys = $state([]);

  // Circular filter state
  let openPanel = $state(null); // 'phylum' | 'geo' | 'status' | 'proxy' | 'study' | null
  let filterRailEl = $state(null);

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

      // Load proxy sample keys from public data
      try {
        const proxyRes = await fetch('/data/proxy_samples.json');
        if (proxyRes.ok) {
          const proxyJson = await proxyRes.json();
          proxySampleKeys = Object.keys(proxyJson?.proxies || {}).slice(0, 24);
        }
      } catch (e) {
        console.warn('Failed to load proxy samples', e);
      }

      // Load study keys from study_index
      try {
        const studyRes = await fetch('/data/study_index.json');
        if (studyRes.ok) {
          const studyJson = await studyRes.json();
          studyKeys = Object.keys(studyJson || {}).slice(0, 50);
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
    selectedProxyKey = null;
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

  function selectProxyKey(key) {
    selectedProxyKey = selectedProxyKey === key ? null : key;
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

    <!-- Settings toggle & panel intentionally hidden for now -->

    <!-- Main Visualization -->
    <BiomesChart
      {taxonomyTree}
      bind:selectedPhyla
      bind:unknownFilter
      bind:westernFilter
      size={viewSize}
      {tension}
      bodySiteFilter={selectedBodySites}
      proxyKey={selectedProxyKey}
      studyKey={selectedStudyKey}
    />

    <!-- Filter Rail: five independent filter circles -->
    <div class="filter-rail" bind:this={filterRailEl}>
      <div class="filter-grid">
        <button
          class="mini-circle"
          class:active={openPanel === 'phylum'}
          onclick={() => openPanel = openPanel === 'phylum' ? null : 'phylum'}
          aria-label="Phylum filters"
        >
          <span class="label">Phylum</span>
        </button>
        <button
          class="mini-circle"
          class:active={openPanel === 'geo'}
          onclick={() => openPanel = openPanel === 'geo' ? null : 'geo'}
          aria-label="Geography filters"
        >
          <span class="label">Geo</span>
        </button>
        <button
          class="mini-circle"
          class:active={openPanel === 'status'}
          onclick={() => openPanel = openPanel === 'status' ? null : 'status'}
          aria-label="Status filters"
        >
          <span class="label">Status</span>
        </button>
        <button
          class="mini-circle"
          class:active={openPanel === 'proxy'}
          onclick={() => openPanel = openPanel === 'proxy' ? null : 'proxy'}
          aria-label="Proxy filters"
        >
          <span class="label">Proxy</span>
        </button>
        <button
          class="mini-circle"
          class:active={openPanel === 'study'}
          onclick={() => openPanel = openPanel === 'study' ? null : 'study'}
          aria-label="Study filters"
        >
          <span class="label">Study</span>
        </button>
      </div>

      {#if openPanel}
        {@const overlayTitle =
          openPanel === 'phylum' ? 'Phylum' :
          openPanel === 'geo' ? 'Geography' :
          openPanel === 'status' ? 'Status' :
          openPanel === 'proxy' ? 'Proxies' :
          openPanel === 'study' ? 'Studies' : ''}
        <div class="filter-overlay" aria-live="polite">
          <div class="overlay-head">
            <div class="overlay-title">{overlayTitle}</div>
            <button class="chevron" onclick={() => openPanel = null} aria-label="Close">✕</button>
          </div>
          {#if openPanel === 'phylum'}
            <p class="overlay-desc">Filter the tree to only the selected phyla.</p>
          {:else if openPanel === 'geo'}
            <p class="overlay-desc">Limit to Western or Non-Western assignments from sample metadata.</p>
          {:else if openPanel === 'status'}
            <p class="overlay-desc">Show only uSGBs (Unknown species genome bins) when enabled.</p>
          {:else if openPanel === 'proxy'}
            <p class="overlay-desc">Filter by proxy sample groups defined in proxy_samples.json.</p>
          {:else if openPanel === 'study'}
            <p class="overlay-desc">Filter to SGBs observed within a specific study (study_index.json).</p>
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
          {:else if openPanel === 'proxy'}
            <div class="overlay-actions">
              <button class="btn" onclick={() => selectedProxyKey = null}>All</button>
              <button class="btn" onclick={() => selectedProxyKey = null}>Clear</button>
            </div>
            <section class="section">
              <div class="chips proxy-grid">
                {#each proxySampleKeys as key}
                  <button
                    class="chip"
                    class:active={selectedProxyKey === key}
                    onclick={() => selectProxyKey(key)}
                  >
                    {key}
                  </button>
                {/each}
              </div>
            </section>
          {:else if openPanel === 'study'}
            <div class="overlay-actions">
              <button class="btn" onclick={() => selectedStudyKey = null}>All</button>
              <button class="btn" onclick={() => selectedStudyKey = null}>Clear</button>
            </div>
            <section class="section">
              <div class="chips proxy-grid">
                {#each studyKeys as key}
                  <button
                    class="chip"
                    class:active={selectedStudyKey === key}
                    onclick={() => selectStudyKey(key)}
                  >
                    {key}
                  </button>
                {/each}
              </div>
            </section>
          {/if}
        </div>
      {/if}
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
    right: 14px;
    top: 50%;
    transform: translateY(-50%);
    writing-mode: vertical-rl;
    text-orientation: mixed;
    letter-spacing: 0.08em;
    font-weight: 600;
    font-size: 20px;
    color: var(--muted);
    user-select: none;
    pointer-events: none; /* don’t block chart interactions */
    z-index: 1;           /* sit behind chart overlays */
    max-width: 32px;
    background: var(--bg);
    padding: 10px 8px;
    border-radius: 12px;
    border: none;
    text-align: center;
    opacity: 1;
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

  /* Filter rail */
  .filter-rail {
    position: fixed;
    right: 14px;
    bottom: 20px;
    width: clamp(240px, 28vw, 340px);
    z-index: 9;
    display: grid;
    gap: 10px;
  }

  .filter-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(80px, 1fr));
    gap: 10px;
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
    max-height: 60vh;
    overflow: auto;
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
