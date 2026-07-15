<script>
  import { onMount } from 'svelte';
  import BiomesChart from './lib/BiomesChart.svelte';
  import { prepareBiomesData, colorMapping, pickTextColor, getPhylum, parseUSGB } from './lib/dataAdapter.js';
  import * as d3 from 'd3';

  // State
  let loading = $state(true);
  let error = $state(null);
  let taxonomyTree = $state(null);
  let allPhyla = $state([]);

  // UI State
  let selectedPhyla = $state([]);
  let unknownFilter = $state('all'); // 'all' | 'unknown' | 'known'
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

  // MoMA: cohort diversity ranking
  let rankMetric = $state('total'); // 'total' (distinct SGBs) | 'percapita' (SGBs per sample)
  let cohortStats = $state({}); // key -> { sgbs, samples }

  // Ranked + sized cohort bubbles for the active metric
  const BUBBLE_MIN = 120;  // px diameter floor (finger-tappable)
  const BUBBLE_MAX = 250;  // px diameter cap
  let rankedCohorts = $derived.by(() => {
    const scored = cohortOptions.map(c => {
      const s = cohortStats[c.key] || {};
      const total = s.sgbs || 0;
      const percap = (s.sgbs && s.samples) ? s.sgbs / s.samples : 0;
      return { ...c, total, percap, value: rankMetric === 'total' ? total : percap };
    });
    scored.sort((a, b) => b.value - a.value);
    const maxV = Math.max(1, ...scored.map(d => d.value));
    scored.forEach(d => {
      const t = maxV > 0 ? Math.sqrt(d.value) / Math.sqrt(maxV) : 0; // area ∝ value
      d.size = Math.round(BUBBLE_MIN + t * (BUBBLE_MAX - BUBBLE_MIN));
    });
    return scored;
  });

  // MoMA: known / unknown percentages (computed from leaves on mount)
  let knownPct = $state(0);
  let unknownPct = $state(0);

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

      // Known / Unknown percentages (uSGB === 'Yes' means unknown)
      let known = 0, unknown = 0;
      for (const l of leaves) {
        if (parseUSGB(l.data.metadata) === 'Yes') unknown++; else known++;
      }
      const totalLeaves = (known + unknown) || 1;
      knownPct = Math.round((known / totalLeaves) * 100);
      unknownPct = Math.round((unknown / totalLeaves) * 100);

      // Cohort diversity stats (distinct SGBs + sample size) for the curated cohorts
      try {
        const studyRes = await fetch(`${import.meta.env.BASE_URL}data/study_index.json`);
        if (studyRes.ok) {
          const sj = await studyRes.json();
          const stats = {};
          for (const c of cohortOptions) {
            const r = sj[c.key];
            if (r) stats[c.key] = { sgbs: (r.sgbs || []).length, samples: r.samples_total ?? 0 };
          }
          cohortStats = stats;
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
  }

  // Handle phylum chip toggle
  function togglePhylum(phylum) {
    if (selectedPhyla.includes(phylum)) {
      selectedPhyla = selectedPhyla.filter(p => p !== phylum);
    } else {
      selectedPhyla = [...selectedPhyla, phylum];
    }
  }

  // ── Phylum pills: tap isolates one, drag across selects a contiguous range ──
  // (mirrors the anthromes filter key; pointer-based so it works on touch)
  let phDragging = $state(false);
  let phAnchor = $state(null);

  function phIdxFromPoint(e) {
    const el = document.elementFromPoint(e.clientX, e.clientY);
    const pill = el?.closest?.('.phylum-dot');
    const idx = pill?.dataset?.idx;
    return idx == null ? null : parseInt(idx, 10);
  }
  function selectPhylaRange(a, b) {
    const s = Math.min(a, b), e = Math.max(a, b);
    selectedPhyla = allPhyla.slice(s, e + 1);
  }
  function phPointerDown(e) {
    const pill = e.target?.closest?.('.phylum-dot');
    if (!pill || pill.dataset.idx == null) return;
    e.preventDefault();
    phDragging = true;
    phAnchor = parseInt(pill.dataset.idx, 10);
    selectPhylaRange(phAnchor, phAnchor);
    window.addEventListener('pointermove', phPointerMove);
    window.addEventListener('pointerup', phPointerUp, { once: true });
  }
  function phPointerMove(e) {
    if (!phDragging || phAnchor == null) return;
    const idx = phIdxFromPoint(e);
    if (idx != null) selectPhylaRange(phAnchor, idx);
  }
  function phPointerUp() {
    phDragging = false;
    phAnchor = null;
    window.removeEventListener('pointermove', phPointerMove);
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
    // Never close things when interacting inside the modals
    if (target.closest('.detail-modal') || target.closest('.info-modal')) {
      return;
    }
    // Rail interactions (filters/controls) keep the detail panel open
    if (target.closest('.rail') || target.closest('#settings') || target.closest('#menuToggle')) {
      openPanel = null;
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

      <a class="nav-circle__home" href={import.meta.env.BASE_URL} aria-label="Back to home">←</a>
    </div>

    <!-- Settings toggle & panel intentionally hidden for now -->

    <div class="layout">
      <div class="viz-area">
        <BiomesChart
          bind:this={biomesChartRef}
          {taxonomyTree}
          bind:selectedPhyla
          bind:unknownFilter
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

      <div class="rail">
        <!-- Top tier: largest control circles -->
        <div class="control-circles">
          <button class="ctl-btn" title="Zoom out" aria-label="Zoom out" onclick={() => biomesChartRef?.zoomOutControl?.()} disabled={zoomIdx === 0} aria-disabled={zoomIdx === 0}>−</button>
          <button class="ctl-btn" title="Reset" aria-label="Reset" onclick={() => biomesChartRef?.resetControl?.()}>◎</button>
          <button class="ctl-btn" title="Zoom in" aria-label="Zoom in" onclick={() => biomesChartRef?.zoomInControl?.()} disabled={zoomIdx === 2} aria-disabled={zoomIdx === 2}>＋</button>
          <button class="ctl-btn" title="Info" aria-label="Info" class:active={openPanel === 'info'} onclick={() => openPanel = openPanel === 'info' ? null : 'info'}>i</button>
        </div>

        <!-- Middle tier: always-visible filter blocks -->
        <div class="filter-blocks">
          <section class="fblock">
            <h3 class="fblock-title">Known / Unknown</h3>
            <p class="fblock-desc"><strong>Known</strong> — a species-level group already represented in reference databases. <strong>Unknown (uSGB)</strong> — a genome-defined species-level group newly identified in this study, not previously represented in reference databases.</p>
            <div class="sel-buttons">
              <button class="sel-btn" class:active={unknownFilter === 'all'} onclick={() => unknownFilter = 'all'}>All</button>
              <button class="sel-btn" class:active={unknownFilter === 'known'} onclick={() => unknownFilter = 'known'}>Known ({knownPct}%)</button>
              <button class="sel-btn" class:active={unknownFilter === 'unknown'} onclick={() => unknownFilter = 'unknown'}>Unknown ({unknownPct}%)</button>
            </div>
          </section>

          <section class="fblock">
            <div class="fblock-headrow">
              <h3 class="fblock-title">Cohort</h3>
              <div class="rank-toggle">
                <button class:active={rankMetric === 'total'} onclick={() => rankMetric = 'total'}>Total</button>
                <button class:active={rankMetric === 'percapita'} onclick={() => rankMetric = 'percapita'}>Per-capita</button>
              </div>
            </div>
            <p class="fblock-desc">A defined group of study participants whose samples were collected and analyzed together. Sized and ranked by the bacterial diversity observed in each population, most to least{rankMetric === 'percapita' ? ', adjusted per sample.' : '.'}</p>
            <div class="cohort-bubbles">
              {#each rankedCohorts as c (c.key)}
                <button
                  class="bubble"
                  class:active={selectedStudyKey === c.key}
                  style="width:calc({c.size} * var(--ui)); height:calc({c.size} * var(--ui));"
                  title={rankMetric === 'total' ? `${c.total} distinct SGBs` : `${c.percap.toFixed(2)} SGBs / sample`}
                  onclick={() => selectStudyKey(c.key)}
                >
                  <span class="bubble-label">{c.label}</span>
                </button>
              {/each}
            </div>
          </section>
        </div>

        <!-- Bottom tier: phylum key -->
        <section class="phylum-band">
          <div class="phylum-band-head">
            <span class="phylum-band-title">Phylum</span>
            <div class="phylum-band-actions">
              <button class="mini-link" onclick={handleSelectAll}>All</button>
              <button class="mini-link" onclick={() => selectedPhyla = []}>Clear</button>
            </div>
          </div>
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <div class="phylum-key" onpointerdown={phPointerDown}>
            {#each allPhyla as phylum, i}
              {@const color = colorMapping[phylum] || colorMapping.Other}
              {@const textColor = pickTextColor(color)}
              <button
                class="phylum-dot"
                class:active={selectedPhyla.includes(phylum)}
                class:dim={selectedPhyla.length > 0 && !selectedPhyla.includes(phylum)}
                data-idx={i}
                style="background:{color}; color:{textColor};"
              >
                <span>{phylum.replace(/_/g, ' ')}</span>
              </button>
            {/each}
          </div>
        </section>
      </div>
    </div>

    <!-- Center-docked detail panel (scales outward from center) -->
    {#if detailContent}
      <!-- svelte-ignore a11y_click_events_have_key_events -->
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div class="detail-modal" aria-live="polite" bind:this={detailPanelEl} onclick={(e) => e.stopPropagation()}>
        <div class="overlay-head">
          <div class="overlay-title">Details</div>
          <button class="chevron" onclick={handleDetailClose} aria-label="Close">✕</button>
        </div>
        <div class="panel-content" onclick={handleDetailPanelClick}>
          {@html detailContent}
        </div>
      </div>
    {/if}

    <!-- Info modal -->
    {#if openPanel === 'info'}
      <!-- svelte-ignore a11y_click_events_have_key_events -->
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div class="detail-modal info-modal" aria-live="polite" onclick={(e) => e.stopPropagation()}>
        <div class="overlay-head">
          <div class="overlay-title">Biomes Overview</div>
          <button class="chevron" onclick={() => openPanel = null} aria-label="Close">✕</button>
        </div>
        <div class="info-body">
          <p><strong>5000 Lines 5000 Species</strong></p>
          <p>This visualization shows an Evolution of the Extensive Human Microbiome. It reconstructs data from the Segata Lab: 9,316 sample collections spanning 46 datasets from multiple populations and an additional cohort from Madagascar. The scientists reconstructed a catalog that greatly expands the set of 150,000 microbial genomes publicly available.</p>
          <p>Each line represents the evolutionary pathway of a Species Level Genetic Bin (SGB), a grouping that organizes genomes based on their similarity, allowing for broader identification of species, both previously known and unknown.</p>
          <p><strong>Known / Unknown:</strong> within this study, {unknownPct}% of bacteria species visualized and analyzed were previously unknown.</p>
          <p><strong>Western / Non Western:</strong> a key finding from these data is that the human microbiome is more diverse than previously understood, especially in indigenous anthromes, which has led to calls for their preservation (see back of coin).</p>
          <div class="info-citations">
            <div class="info-citations-title">Citations</div>
            <p>Pasolli, Edoardo, Francesco Asnicar, Serena Manara, Moreno Zolfo, Nicolai Karcher, Federica Armanini, Francesco Beghini, et al. 2019. "Extensive Unexplored Human Microbiome Diversity Revealed by Over 150,000 Genomes from Metagenomes Spanning Age, Geography, and Lifestyle." <em>Cell</em> 176(3): 649–662. <a href="https://doi.org/10.1016/j.cell.2019.01.001" target="_blank" rel="noopener">https://doi.org/10.1016/j.cell.2019.01.001</a></p>
            <p>This project was completed by Laura Kurgan, Dan Miller and Adam Vosburgh at The Center for Spatial Research, Columbia University Graduate School of Architecture Planning and Preservation. This project is open-source, and the repository is located <a href="https://github.com/CenterForSpatialResearch/twosides" target="_blank" rel="noopener">here</a>.</p>
          </div>
        </div>
      </div>
    {/if}
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
    /* fluid scale: 1 at 3840px (exhibition), ~0.67 at 2560px, floor 0.62 for laptop touch targets */
    --ui: clamp(0.62px, calc(100vw / 3840), 1px);
    width: 100%;
    height: 100vh;
    position: relative;
    overflow: hidden;
  }

  .layout {
    display: grid;
    grid-template-columns: minmax(0, 2fr) minmax(0, 1fr);
    height: 100vh;
    align-items: stretch;
    gap: 0;
  }

  /* MoMA circle-size tiers (sized for a ~3840px exhibition display) */
  .rail {
    --tier-top: calc(118 * var(--ui));     /* biggest: controls */
    --tier-mid: calc(150 * var(--ui));     /* medium: filter/select */
    --tier-key: calc(118 * var(--ui));     /* smallest: phylum key */
    grid-column: 2;
    padding: 44px 48px;
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
    gap: 40px;
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
    bottom: 20px;
    left: 20px;
    width: calc(248 * var(--ui));
    height: calc(248 * var(--ui));
    border-radius: 50%;
    background: var(--bg);
    border: 3px solid rgba(255, 255, 255, 0.85);
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
    width: calc(220 * var(--ui));
    height: calc(220 * var(--ui));
    border-radius: 50%;
    text-decoration: none;
    pointer-events: auto;
  }

  .nav-circle svg {
    width: calc(220 * var(--ui));
    height: calc(220 * var(--ui));
    overflow: visible;
  }

  .nav-circle__ring {
    fill: none;
    stroke: none;
  }

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
    width: calc(60 * var(--ui));
    height: calc(60 * var(--ui));
    border-radius: 50%;
    border: 1px solid rgba(255, 255, 255, 0.4);
    background: transparent;
    color: rgba(255, 255, 255, 0.9);
    display: grid;
    place-items: center;
    font-size: calc(28 * var(--ui));
    line-height: 1;
    font-weight: 800;
    text-decoration: none;
    pointer-events: auto;
  }


  /* ===== MoMA rail: top control circles (biggest tier) ===== */
  .control-circles {
    display: flex;
    flex-wrap: wrap;
    gap: 22px;
    justify-content: flex-end;
    align-items: center;
  }

  .ctl-btn {
    width: var(--tier-top);
    height: var(--tier-top);
    border-radius: 50%;
    background: var(--bg);
    border: 3px solid rgba(255, 255, 255, 0.85);
    color: var(--fg);
    font-weight: 700;
    font-size: calc(44 * var(--ui));
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

  /* ===== Middle tier: filter blocks ===== */
  .filter-blocks {
    display: grid;
    grid-template-columns: minmax(240px, 0.85fr) minmax(0, 1.15fr);
    gap: 44px;
    align-items: start;
  }

  .fblock {
    display: flex;
    flex-direction: column;
    gap: 18px;
    min-width: 0;
  }

  .fblock-headrow {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 18px;
    flex-wrap: wrap;
  }

  .fblock-title {
    margin: 0;
    font-size: calc(30 * var(--ui));
    font-weight: 800;
    letter-spacing: 0.02em;
    color: var(--fg);
  }

  .fblock-desc {
    margin: 0;
    font-size: 19px;
    line-height: 1.5;
    color: var(--muted);
  }

  .fblock-desc strong {
    color: #fff;
  }

  /* Known / Unknown: medium circular select buttons */
  .sel-buttons {
    display: flex;
    flex-wrap: wrap;
    gap: 20px;
  }

  .sel-btn {
    width: var(--tier-mid);
    height: var(--tier-mid);
    border-radius: 50%;
    background: var(--bg);
    border: 3px solid rgba(255, 255, 255, 0.85);
    color: var(--fg);
    font-weight: 700;
    font-size: calc(22 * var(--ui));
    line-height: 1.15;
    cursor: pointer;
    display: grid;
    place-items: center;
    text-align: center;
    padding: 10px;
    box-sizing: border-box;
    box-shadow: var(--shadow);
  }

  .sel-btn.active {
    background: #fff;
    color: var(--bg);
    border-color: #fff;
  }

  .sel-btn:active {
    transform: scale(0.96);
  }

  /* Cohort rank toggle — underline + opacity select (no pill, keeps headrow short) */
  .rank-toggle {
    display: inline-flex;
    gap: 18px;
    align-items: baseline;
  }

  .rank-toggle button {
    background: transparent;
    color: var(--fg);
    border: none;
    border-bottom: 2px solid transparent;
    padding: 0 0 2px;
    font-size: 18px;
    font-weight: 700;
    line-height: 1.2;
    cursor: pointer;
    opacity: 0.45;
    transition: opacity 0.15s ease;
  }

  .rank-toggle button.active {
    opacity: 1;
    border-bottom-color: currentColor;
  }

  /* Cohort ranked bubbles */
  .cohort-bubbles {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 20px;
    padding-top: 6px;
  }

  .bubble {
    border-radius: 50%;
    background: var(--bg);
    border: 3px solid rgba(255, 255, 255, 0.85);
    color: var(--fg);
    cursor: pointer;
    display: grid;
    place-items: center;
    text-align: center;
    padding: 6px;
    box-sizing: border-box;
    box-shadow: var(--shadow);
    transition: width 0.35s ease, height 0.35s ease;
  }

  .bubble-label {
    font-size: calc(22 * var(--ui));
    font-weight: 700;
    line-height: 1.1;
  }

  .bubble.active {
    background: #fff;
    color: var(--bg);
    border-color: #fff;
  }

  .bubble:active {
    transform: scale(0.96);
  }

  /* ===== Bottom tier: phylum key ===== */
  .phylum-band {
    margin-top: auto;
    display: flex;
    flex-direction: column;
    gap: 12px;
    min-height: 0;
  }

  .phylum-band-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  }

  .phylum-band-title {
    font-size: calc(28 * var(--ui));
    font-weight: 800;
    letter-spacing: 0.02em;
  }

  .phylum-band-actions {
    display: flex;
    gap: 12px;
  }

  .mini-link {
    background: transparent;
    border: 2px solid rgba(255, 255, 255, 0.5);
    color: var(--muted);
    border-radius: 999px;
    padding: 10px 22px;
    font-size: 18px;
    font-weight: 700;
    cursor: pointer;
  }

  .phylum-key {
    display: flex;
    flex-wrap: wrap;
    gap: 14px;
    overflow: auto;
    align-content: flex-start;
  }

  /* Pill sizes to its label; colour = phylum, tap to toggle (mirrors anthromes key-pill) */
  .phylum-dot {
    display: inline-flex;
    align-items: center;
    height: 36px;
    padding: 0 16px;
    border-radius: 10px;
    border: 1px solid rgba(0, 0, 0, 0.18);
    cursor: pointer;
    white-space: nowrap;
    box-sizing: border-box;
    user-select: none;
    touch-action: none;
    opacity: 0.92;
    transition: opacity 0.15s ease;
  }

  .phylum-dot span {
    font-size: 14px;
    font-weight: 600;
    line-height: 1;
    letter-spacing: 0.01em;
  }

  .phylum-dot.active {
    border-color: #fff;
    box-shadow: 0 0 0 3px rgba(255, 255, 255, 0.85);
    opacity: 1;
  }

  .phylum-dot.dim {
    opacity: 0.32;
  }

  /* ===== Detail panel: docked in the right sidebar, vertically centered ===== */
  .detail-modal {
    position: fixed;
    top: 50%;
    right: 48px;
    /* span the full sidebar column: disk column is 1.3fr of 2.3fr = 56.52vw */
    left: calc(56.52vw + 48px);
    transform: translateY(-50%);
    max-height: 82vh;
    overflow: auto;
    background: var(--bg);
    border: 3px solid rgba(255, 255, 255, 0.85);
    border-radius: 26px;
    padding: 30px 34px;
    box-shadow: var(--shadow);
    z-index: 20;
    pointer-events: auto;
    transform-origin: center right;
    animation: modal-pop-side 0.18s ease;
  }

  /* Info stays centered on screen (longer read) */
  .info-modal {
    top: 50%;
    left: 50%;
    right: auto;
    width: min(52vw, 760px);
    transform: translate(-50%, -50%);
    transform-origin: center center;
    animation: modal-pop-center 0.18s ease;
  }

  @keyframes modal-pop-side {
    from { transform: translateY(-50%) scale(0.85); opacity: 0; }
    to   { transform: translateY(-50%) scale(1); opacity: 1; }
  }

  @keyframes modal-pop-center {
    from { transform: translate(-50%, -50%) scale(0.85); opacity: 0; }
    to   { transform: translate(-50%, -50%) scale(1); opacity: 1; }
  }

  .info-body {
    display: grid;
    gap: 14px;
    font-size: 17px;
    line-height: 1.6;
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

  .info-body em {
    color: #e7e9f1;
  }

  .overlay-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    margin-bottom: 18px;
  }

  .overlay-title {
    font-weight: 700;
    letter-spacing: 0.04em;
    font-size: 26px;
  }

  .panel-content {
    font-size: 18px;
    color: var(--muted);
    line-height: 1.55;
    display: grid;
    gap: 14px;
    overflow: auto;
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
    font-size: 24px;
    font-weight: 800;
    letter-spacing: 0.04em;
    color: #fff;
  }

  :global(.panel-content .subtitle) {
    font-size: 16px;
    color: #cfd3e0;
    letter-spacing: 0.02em;
  }

  :global(.panel-content .summary) {
    font-size: 18px;
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
    font-size: 15px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: #9ba3c0;
  }

  :global(.panel-content .kv .v) {
    color: #f6f7fb;
    font-weight: 600;
    font-size: 17px;
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
    border-radius: 12px;
    padding: 14px 16px;
    font-weight: 700;
    font-size: 17px;
    cursor: pointer;
  }

  :global(.panel-content .actions button:hover) {
    background: rgba(255,255,255,0.14);
    border-color: rgba(255,255,255,0.26);
  }

  .chevron {
    background: var(--bg);
    border: 2px solid rgba(255, 255, 255, 0.85);
    color: var(--fg);
    border-radius: 50%;
    width: 48px;
    height: 48px;
    font-size: 22px;
    display: grid;
    place-items: center;
    font-weight: 800;
    cursor: pointer;
    flex: none;
  }

</style>
