<script>
  import { onMount, untrack } from 'svelte';
  import WaffleChart from './lib/WaffleChart.svelte';
  import HistoryCircleChart from './lib/HistoryCircleChart.svelte';
  import { prepareAnthromesData } from './lib/dataAdapter.js';

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
  let historyChartSize = $state(220);

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
      const h = historyChartEl.clientHeight;
      const w = historyChartEl.clientWidth;
      // Square chart. Height must also leave room for the "Cell History" title
      // above the SVG (~20px incl. gap), or the section overflows and the panel scrolls.
      // Width only needs a hairline gutter.
      historyChartSize = Math.max(60, Math.min(h - 20, w - 6));
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
    untrack(() => {
      if (!panel || !start || !open) { connectorEnd = null; return; }
      const rect = panel.getBoundingClientRect();
      // Panel docks on the left; leader ends at its right edge, vertically centered
      connectorEnd = { x: rect.right, y: (rect.top + rect.bottom) / 2 };
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
  }

  // Clear restores the filter to all anthromes (the default, everything shown)
  function handleClear() {
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
              <button class="mini-link" onclick={handleClear}>Clear</button>
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

  <!-- Leader line: isolated cell → docked detail panel -->
  {#if detailContent && connectorStart && connectorEnd}
    <svg class="connector-overlay" aria-hidden="true">
      <line x1={connectorStart.x} y1={connectorStart.y} x2={connectorEnd.x} y2={connectorEnd.y}></line>
    </svg>
  {/if}
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
    /* fluid scale: 1 at 3840px (exhibition), ~0.67 at 2560px, floor 0.62 for laptop touch targets */
    --ui: clamp(0.62px, calc(100vw / 3840), 1px);
    width: 100%;
    height: 100vh;
    position: relative;
    overflow: hidden;
  }

  .nav-circle {
    position: fixed;
    bottom: 20px;
    right: 20px;
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


  /* New rail + overlay styles */
  .layout {
    display: grid;
    grid-template-columns: 1fr 2fr;
    height: 100%;
    align-items: stretch;
  }

  .filter-rail {
    grid-column: 1;
    padding: 40px 48px;
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
    border-top: 1px solid rgba(255, 255, 255, 0.14);
    margin-top: 18px;
    padding-top: 18px;
  }

  .control-circles,
  .anthrome-key {
    flex: 0 0 auto;
  }

  /* ===== MoMA: top control circles (largest tier) ===== */
  .control-circles {
    display: flex;
    flex-wrap: wrap;
    gap: 22px;
    align-items: center;
  }

  .ctl-btn {
    width: calc(118 * var(--ui));
    height: calc(118 * var(--ui));
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

  /* ===== MoMA: bottom anthrome filter key (always visible) ===== */
  .anthrome-key {
    flex: 0 1 auto;
    display: flex;
    flex-direction: column;
    gap: 8px;
    min-height: 0;
    max-height: 40%;
  }

  .anthrome-key-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  }

  .anthrome-key-title {
    font-size: calc(22 * var(--ui));
    font-weight: 800;
    letter-spacing: 0.02em;
  }

  .anthrome-key-actions {
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

  /* Bar-legend (mirrors the info-panel legend): vertical intensity axis + multi-column swatch grid */
  .key-legend {
    display: flex;
    gap: 14px;
    align-items: stretch;
    min-height: 0;
    overflow: auto;
  }

  /* Vertical intensity axis — arrow points up (more intensive at top) */
  /* Line + arrowhead sit on the right edge; the rotated label is offset to their left */
  .key-axis {
    position: relative;
    width: 26px;
    flex-shrink: 0;
  }

  .key-axis::before {
    content: '';
    position: absolute;
    left: 22px;
    top: 8px;
    bottom: 0;
    width: 1px;
    background: rgba(255, 255, 255, 0.3);
  }

  .key-axis::after {
    content: '';
    position: absolute;
    left: 22px;
    top: 0;
    transform: translateX(-50%);
    width: 0;
    height: 0;
    border-left: 4px solid transparent;
    border-right: 4px solid transparent;
    border-bottom: 6px solid rgba(255, 255, 255, 0.3);
  }

  .key-axis-label {
    position: absolute;
    top: 0;
    bottom: 0;
    left: 0;
    right: 10px;
    display: flex;
    align-items: center;
    justify-content: center;
    writing-mode: vertical-rl;
    transform: rotate(180deg);
    font-size: 11px;
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
    gap: 8px;
    align-content: start;
  }

  .key-family {
    display: flex;
    flex-direction: column;
    gap: 3px;
  }

  .key-cat-name {
    font-size: 11px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--muted);
  }

  .key-pills {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    align-items: center;
  }

  /* Pill sizes to its label; colour = anthrome, tap to isolate / drag to range-select */
  .key-pill {
    display: inline-flex;
    align-items: center;
    height: 30px;
    padding: 0 11px;
    border-radius: 8px;
    border: 1px solid rgba(0, 0, 0, 0.18);
    font-size: 12px;
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
    gap: 10px;
    box-sizing: border-box;
    pointer-events: auto;
  }

  /* Menu item title/description — shared look with the other rail sections */
  .menu-title {
    margin: 0;
    font-size: calc(22 * var(--ui));
    font-weight: 800;
    letter-spacing: 0.02em;
    color: var(--fg);
  }

  .menu-desc {
    margin: 0;
    font-size: 13px;
    line-height: 1.45;
    color: var(--muted);
  }

  /* Selected-cell subheading (swatch + anthrome name) inside the details body */
  .detail-subhead {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    font-size: 15px;
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
    font-size: 13px;
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
    gap: 12px;
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

  /* Info modal: centered on screen (longer read) */
  .info-modal {
    position: fixed;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    width: min(64vw, 960px);
    max-width: calc(100vw - 96px);
    max-height: 84vh;
    display: flex;
    flex-direction: column;
    background: var(--bg);
    border: 3px solid rgba(255, 255, 255, 0.85);
    border-radius: 26px;
    padding: 26px 30px;
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

  /* Leader line from isolated cell to the docked detail panel */
  .connector-overlay {
    position: fixed;
    inset: 0;
    width: 100vw;
    height: 100vh;
    pointer-events: none;
    z-index: 15;
    overflow: visible;
  }

  .connector-overlay line {
    stroke: rgba(255, 255, 255, 0.5);
    stroke-width: 1.5;
    stroke-dasharray: 4 3;
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

  /* The detail subhead (swatch + anthrome name) already covers the head,
     so drop the content's redundant title/"Year …" block inside the panel. */
  :global(.detail-body .panel-content .tip-head) {
    display: none;
  }

  /* Detail panel typography */
  :global(.panel-content .title) {
    font-size: 18px;
    font-weight: 800;
    letter-spacing: 0.04em;
    color: #fff;
  }

  :global(.panel-content .subtitle) {
    font-size: 13px;
    color: #cfd3e0;
    letter-spacing: 0.02em;
  }

  :global(.panel-content .summary) {
    font-size: 14px;
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
    font-size: 13px;
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
    padding: 11px 14px;
    font-weight: 700;
    font-size: 13px;
    cursor: pointer;
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

  .legend-section {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .legend-body {
    display: flex;
    gap: 30px;
    align-items: stretch;
  }

  /* Axis: vertical arrow + label spanning full legend height */
  .legend-axis {
    position: relative;
    width: 16px;
    flex-shrink: 0;
  }

  /* Line and arrowhead sit on the right edge of the axis column */
  .legend-axis::before {
    content: '';
    position: absolute;
    left: 20px;
    top: 6px;
    bottom: 0;
    width: 1px;
    background: rgba(255,255,255,0.3);
  }

  .legend-axis::after {
    content: '';
    position: absolute;
    left: 20px;
    top: 1px;
    transform: translateX(-50%);
    width: 0;
    height: 0;
    border-left: 3px solid transparent;
    border-right: 3px solid transparent;
    border-bottom: 5px solid rgba(255,255,255,0.3);
  }

  /* Text spans only the top half so its center sits near Urban */
  .legend-axis-label {
    position: absolute;
    top: 12px;
    bottom: 50%;
    left: 5px;
    right: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    writing-mode: vertical-rl;
    transform: rotate(180deg);
    font-size: 9px;
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
    grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
    gap: 4px 8px;
  }

  .legend-category-name {
    grid-column: 1 / -1;
    font-size: 10px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--muted);
    margin-top: 8px;
  }

  .legend-category-name:first-child {
    margin-top: 0;
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

  .viz-area {
    grid-column: 2;
    position: relative;
    overflow: visible;
  }

</style>
