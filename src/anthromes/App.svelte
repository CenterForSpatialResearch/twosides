<script>
  import { onMount, untrack } from 'svelte';
  import WaffleChart from './lib/WaffleChart.svelte';
  import CellHistoryBar from './lib/CellHistoryBar.svelte';
  import CountryTimeseriesBar from './lib/CountryTimeseriesBar.svelte';
  import PixelTimeline from './lib/PixelTimeline.svelte';
  import { prepareAnthromesData } from './lib/dataAdapter.js';
  import { topoProfile, setTopoProfile, TOPO_PROFILES, hasProfileInfo, profileSizes } from '../shared/topoProfile.svelte.js';
  import { feature as topoFeature } from 'topojson-client';
  import DevHud from '../shared/DevHud.svelte';
  import NavCircle from '../shared/NavCircle.svelte';
  import CountryCircle from '../shared/CountryCircle.svelte';
  import ArcLabel from '../shared/ArcLabel.svelte';
  import { initStage, screenToDesign } from '../shared/stage.svelte.js';
  import { uiOption } from '../shared/uiOption.svelte.js';

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

  // Declared BEFORE selectedCountryIso3: its initialiser calls
  // readCountryParam(), which validates against PRIMARY_ORDER. `const` is not
  // hoisted, so with these below the state declaration any load carrying
  // ?country=ISO3 — i.e. every hand-off from the biomes side — threw a TDZ
  // ReferenceError and rendered a blank page.
  const PRIMARY_ORDER = ['SWE', 'GBR', 'USA', 'CHN', 'MDG', 'FJI', 'PER', 'TZA'];
  const SHORT_LABELS = {
    SWE: 'Sweden',
    GBR: 'UK',
    USA: 'USA',
    CHN: 'China',
    MDG: 'Madagascar',
    FJI: 'Fiji',
    PER: 'Peru',
    TZA: 'Tanzania'
  };

  // Country-first primary filter (Phase 3). Parity with biomes side.
  // Seeded from ?country=ISO3 so a selection carries across the two sides.
  let selectedCountryIso3 = $state(readCountryParam());
  // Overlay-annotation state — multi-country highlight from the biomes side.
  // MapCanvas populates these from URL params on mount; App reads them to
  // render the dismissible rail tag.
  let rangeIso3s = $state(new Set());
  let rangeSource = $state(null); // { kind, label, sgbId, from } | null
  let primaryCountries = $state(null);
  let countryFeatureByIso = $state(new Map()); // ISO3 -> feature (target countries only)
  let countryTimeseries = $state(null);

  function readCountryParam() {
    if (typeof window === 'undefined') return null;
    const p = new URLSearchParams(window.location.search).get('country');
    return p && PRIMARY_ORDER.includes(p) ? p : null;
  }

  function updateCountryParam(iso3) {
    if (typeof window === 'undefined') return;
    const url = new URL(window.location.href);
    if (iso3) url.searchParams.set('country', iso3);
    else url.searchParams.delete('country');
    window.history.replaceState(null, '', url.toString());
  }

  // Cross-side link carries the picked country AND the active range's SGB, so
  // biomes arrives with both the country lens and (if present) the species
  // highlight from the range annotation still in play.
  const crossLinkHref = $derived.by(() => {
    const base = import.meta.env.BASE_URL;
    const params = new URLSearchParams();
    if (selectedCountryIso3) params.set('country', selectedCountryIso3);
    if (rangeSource?.sgbId != null) params.set('highlightSGB', String(rangeSource.sgbId));
    const q = params.toString();
    return `${base}src/biomes/${q ? `?${q}` : ''}`;
  });

  $effect(() => {
    updateCountryParam(selectedCountryIso3);
  });
  const selectedCountryMeta = $derived(
    selectedCountryIso3 && primaryCountries ? primaryCountries[selectedCountryIso3] : null
  );

  // Option 1 moves the per-year anthrome breakdown out of the details panel and
  // onto the ring itself: with a country picked, the waffle plots that
  // country's distribution instead of the world's. Null = plot the world.
  const countryRingDistribution = $derived(
    uiOption() === 1 && selectedCountryIso3
      ? countryTimeseries?.[selectedCountryIso3]?.distribution ?? null
      : null
  );

  // The world in the same { year: { code: fraction } } shape the country
  // timeseries uses, so the details panel's pixel timeline can plot either
  // without caring which it has. summary.json's percentages are exact to
  // floating point, so no renormalising is needed here.
  const worldDistribution = $derived.by(() => {
    const out = {};
    for (const row of data) {
      const shares = {};
      for (const [code, pct] of Object.entries(row.percentages ?? {})) {
        shares[code] = pct / 100;
      }
      out[row.year] = shares;
    }
    return out;
  });

  // { id, byYear: { year: code } } for the isolated cell — the pixel ladder's
  // input. Null whenever no cell is isolated.
  let cellSeries = $state(null);

  // The details panel shows exactly one of three scales, widest first, each
  // superseded by the more specific selection: world → country → cell. The key
  // is what the pixel timeline watches to know it must animate.
  const detailScale = $derived(
    cellSeries ? 'cell' : selectedCountryIso3 ? 'country' : 'world'
  );
  const detailSourceKey = $derived(
    detailScale === 'cell'
      ? `cell:${cellSeries.id}`
      : detailScale === 'country'
        ? `country:${selectedCountryIso3}`
        : 'world'
  );
  const detailTitle = $derived(
    detailScale === 'cell'
      ? 'Cell history'
      : detailScale === 'country'
        ? 'Anthrome timeline'
        : 'World anthrome timeline'
  );

  // Every country in the study, for the scope pill. primary_countries.json only
  // covers the eight in the picker, but an isolated cell can land in any of
  // them — so the pill reads from the full index.
  let countryIndex = $state(null);

  // Sample and species totals across the whole study, so the world scale gets
  // the same pill the country and cell scales get. Species is the UNION of each
  // country's SGB list, not the sum: a species reported in five countries is
  // one species.
  const earthTotals = $derived.by(() => {
    if (!countryIndex) return null;
    let samples = 0;
    const sgbs = new Set();
    for (const entry of Object.values(countryIndex)) {
      samples += entry.samples_total || 0;
      for (const s of entry.sgbs || []) sgbs.add(s);
    }
    return { label: 'Earth', samples, species: sgbs.size };
  });

  // One pill shape for all three scales: { label, samples, species }.
  const scopePill = $derived.by(() => {
    if (detailScale === 'country' && selectedCountryMeta) {
      return {
        label: selectedCountryMeta.label,
        samples: selectedCountryMeta.samples_total,
        species: selectedCountryMeta.sgbs.length
      };
    }
    if (detailScale === 'cell') {
      // The cell's present-day country. Most land is in countries the study
      // never sampled, so there are three cases: sampled (counts), known but
      // unsampled (name + why there are no counts), and no country at all
      // (ocean, ice) which falls through to Earth.
      const iso3 = detailMeta?.countryIso3;
      if (iso3) {
        const entry = countryIndex?.[iso3];
        const label = detailMeta.countryName || iso3;
        if (entry) {
          return {
            label,
            samples: entry.samples_total || 0,
            species: (entry.sgbs || []).length
          };
        }
        return { label, note: 'not sampled in this study' };
      }
    }
    return earthTotals;
  });

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
  let historyChartSize = $state(282); // legacy: kept while old radial imports linger
  let historyChartW = $state(340);
  const CELL_BAR_H = 92;
  const COUNTRY_BAR_H = 160;

  // The Option 1 pixel timeline sizes to its own box in BOTH axes (the bar
  // charts take a fixed height), so it gets its own measured element.
  let pixelChartEl = $state(null);
  let pixelChartW = $state(800);
  let pixelChartH = $state(300);

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
      // Horizontal chart: width flexes with the section, height is fixed per
      // chart type. Only track width here — the components take {width, height}.
      const w = historyChartEl.clientWidth;
      historyChartW = Math.max(200, w - 8);
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(historyChartEl);
    return () => ro.disconnect();
  });

  $effect(() => {
    if (!pixelChartEl) return;
    const update = () => {
      pixelChartW = Math.max(200, pixelChartEl.clientWidth);
      pixelChartH = Math.max(80, pixelChartEl.clientHeight);
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(pixelChartEl);
    return () => ro.disconnect();
  });

  // Connector (leader line) from the isolated map cell to the docked detail panel
  let connectorStart = $state(null);
  let connectorEnd = $state(null);
  let detailPanelEl = $state(null);
  // The swatch + anthrome-name row; the leader points at its vertical centre.
  let detailAnchorEl = $state(null);

  $effect(() => {
    const start = connectorStart;
    const panel = detailPanelEl;
    const open = detailContent;
    // Recompute when the panel's contents shift under the anchor: the chart
    // appearing or resizing, the scope pill resolving, or the anchor row itself
    // mounting. Under Option 1 the anchor also moves when the year changes,
    // because the anthrome name can get longer or shorter.
    barChartData; historyChartSize; detailAnchorEl; scopePill; detailMeta;
    untrack(() => {
      if (!panel || !start || !open) { connectorEnd = null; return; }
      const rect = panel.getBoundingClientRect();
      // Panel docks on the left; the leader ends at its right edge (the rail
      // seam), vertically in line with the anthrome colour + title. Older
      // arrangements have no such row, so they fall back to the chart title.
      // getBoundingClientRect is in screen px but the overlay draws in design px.
      const anchor =
        detailAnchorEl ||
        panel.querySelector('.history-chart-title') ||
        panel.querySelector('.menu-title') ||
        panel;
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

      // Country-picker data (parity with biomes side)
      try {
        const base = import.meta.env.BASE_URL;
        const [pcRes, boundariesRes, tsRes, ciRes] = await Promise.all([
          fetch(`${base}data/primary_countries.json`),
          fetch(`${base}topojson/admin-boundaries/countries-110m.topojson`),
          fetch(`${base}data/country-anthrome-timeseries.json`),
          // Also fetched by MapCanvas; the browser serves the second hit from
          // cache, so this costs nothing beyond the parse.
          fetch(`${base}data/country_index.json`)
        ]);
        if (pcRes.ok) primaryCountries = await pcRes.json();
        if (tsRes.ok) countryTimeseries = await tsRes.json();
        if (ciRes.ok) countryIndex = await ciRes.json();
        if (boundariesRes.ok) {
          const topo = await boundariesRes.json();
          const objName = Object.keys(topo.objects)[0];
          const fc = topoFeature(topo, topo.objects[objName]);
          const wanted = new Set(PRIMARY_ORDER);
          const byIso = new Map();
          for (const f of fc.features) {
            const id = f?.id ?? f?.properties?.id ?? f?.properties?.ISO_A3;
            if (id && wanted.has(id)) byIso.set(id, f);
          }
          countryFeatureByIso = byIso;
        }
      } catch (e) {
        console.warn('Failed to load country picker data', e);
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
    // Reset also drops the multi-country range overlay so the map returns to
    // a completely clean baseline.
    if (rangeIso3s?.size || rangeSource) clearRange();
    // ...and the country picker with it. Under Option 1 a country selection is
    // no longer a side note in the details panel: it holds the highlight, the
    // framing AND the ring's distribution, so leaving it behind would not be a
    // reset. Clearing it here is what makes the ring animate back to the world.
    // The older arrangements kept the picker (reset = "view reset" only).
    if (uiOption() === 1) selectedCountryIso3 = null;
  }

  // "All" restores the filter to every anthrome (the default, everything shown)
  function handleSelectAll() {
    selectedAnthromes = orderedCodes.length ? [...orderedCodes] : selectedAnthromes;
  }

  function selectCountry(iso3) {
    if (selectedCountryIso3 === iso3) {
      // Toggling the same globe off — treat as picker deselect and snap the
      // map back to the default view. Pan-driven clears go through a
      // different path in WaffleChart and preserve the user's pan.
      clearCountrySelection();
    } else {
      // Any picker interaction wipes cell isolation — a country click means
      // "look at this country", not "keep the pixel view I had open."
      clearCellSelection();
      selectedCountryIso3 = iso3;
    }
  }

  function clearCountrySelection() {
    clearCellSelection();
    selectedCountryIso3 = null;
    mapPanX = 0;
    mapPanY = 0;
    zoomLevel = 1;
  }

  // Clear anything left over from a per-cell isolation so the Details dock
  // can fall back to the country view (or the default hint).
  function clearCellSelection() {
    detailContent = null;
    detailMeta = null;
    barChartData = null;
    showBarChart = false;
    isolationReset++;
  }

  // Dismiss the overlay-annotation range highlight (multi-country from a
  // biomes species). Leaves the primary picker selection alone. Also strips
  // ?highlightSGB from the URL so a reload doesn't re-apply it.
  function clearRange() {
    rangeIso3s = new Set();
    rangeSource = null;
    if (typeof window !== 'undefined') {
      const url = new URL(window.location.href);
      url.searchParams.delete('highlightSGB');
      window.history.replaceState(null, '', url.toString());
    }
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
    <NavCircle
      side="right"
      activeLabel="ANTHROMES"
      linkLabel="BIOMES →"
      linkHref={crossLinkHref}
      linkAriaLabel="Go to Biomes"
      homeHref={import.meta.env.BASE_URL}
    />

    <!-- Settings Panel -->
    <div class="settings-panel" class:open={settingsOpen}>
      <label>
        <span>View Mode</span>
        <select bind:value={viewSize}>
          <option value="preview">Preview (1200px)</option>
          <option value="full">Full (7000px)</option>
        </select>
      </label>

      <label>
        <span>Map Resolution</span>
        <select value={topoProfile()} onchange={(e) => setTopoProfile(e.currentTarget.value)}>
          {#each TOPO_PROFILES as p}
            <option value={p}>{p}</option>
          {/each}
        </select>
      </label>
      {#if hasProfileInfo(topoProfile())}
        <div class="tip">
          {profileSizes(topoProfile())}. The whole series is fetched once, so
          expect a brief pause on first load and no network at all when changing
          years.
        </div>
      {/if}

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
        <!-- Top tier: large control circles. Option 1 spreads them across the
             full rail width and hangs an arced caption off the LEFT of each
             bubble (mirroring the biomes rail, which captions to the right). -->
        <div class="control-circles" class:control-circles--arced={uiOption() === 1}>
          <div class="ctl-slot">
            <button class="ctl-btn" title="Info" aria-label="Info" class:active={openPanel === 'info'} onclick={() => openPanel = openPanel === 'info' ? null : 'info'}>i</button>
            {#if uiOption() === 1}<ArcLabel text="Info" side="left" />{/if}
          </div>
          <div class="ctl-slot">
            <button class="ctl-btn" title="Zoom out" aria-label="Zoom out" onclick={zoomOut} disabled={zoomLevel === ZOOM_LEVELS[0]} aria-disabled={zoomLevel === ZOOM_LEVELS[0]}>−</button>
            {#if uiOption() === 1}<ArcLabel text="Zoom Out" side="left" />{/if}
          </div>
          <div class="ctl-slot">
            <button class="ctl-btn" title="Reset" aria-label="Reset" onclick={resetView}>◎</button>
            {#if uiOption() === 1}<ArcLabel text="Reset" side="left" />{/if}
          </div>
          <div class="ctl-slot">
            <button class="ctl-btn" title="Zoom in" aria-label="Zoom in" onclick={zoomIn} disabled={zoomLevel === ZOOM_LEVELS[ZOOM_LEVELS.length - 1]} aria-disabled={zoomLevel === ZOOM_LEVELS[ZOOM_LEVELS.length - 1]}>＋</button>
            {#if uiOption() === 1}<ArcLabel text="Zoom In" side="left" />{/if}
          </div>
        </div>

        <!-- Country picker (parity with biomes side) -->
        <section class="fblock">
          <div class="fblock-headrow">
            <h3 class="menu-title">Country</h3>
            <button
              class="mini-link"
              class:active={selectedCountryIso3 === null}
              onclick={clearCountrySelection}
              aria-label="Clear country selection"
            >All</button>
          </div>
          <p class="menu-desc">Select a country to see the composition of its anthromes over time.</p>
          <div class="country-row">
            {#each PRIMARY_ORDER as iso3 (iso3)}
              {@const feature = countryFeatureByIso.get(iso3)}
              <div class="country-cell">
                <CountryCircle
                  {iso3}
                  label={SHORT_LABELS[iso3] ?? iso3}
                  {feature}
                  size={168}
                  labelFontSize={20}
                  ringStroke={3.4}
                  ringStrokeSelected={5}
                  selected={selectedCountryIso3 === iso3}
                  dimmed={selectedCountryIso3 !== null && selectedCountryIso3 !== iso3}
                  onclick={() => selectCountry(iso3)}
                />
              </div>
            {/each}
          </div>
        </section>

        <!-- Overlay annotation: multi-country range from the biomes side.
             Distinct from the single-country picker so the two grammars
             ("you picked one" vs "the other side sent you many") don't
             conflate. Dismissible; also clears the ?highlightSGB URL. -->
        {#if rangeIso3s.size > 0 && rangeSource}
          <section class="range-tag" aria-live="polite">
            <div class="range-tag-row">
              <span class="range-tag-badge" aria-hidden="true"></span>
              <div class="range-tag-body">
                <span class="range-tag-title">Range of {rangeSource.label}</span>
                <span class="range-tag-sub">
                  {rangeIso3s.size} {rangeIso3s.size === 1 ? 'country' : 'countries'}
                  {#if rangeSource.from} · from {rangeSource.from}{/if}
                </span>
              </div>
              <button class="range-tag-clear" onclick={clearRange} aria-label="Clear range highlight">×</button>
            </div>
          </section>
        {/if}

        <!-- Middle: always-visible details menu item, where Views used to be -->
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <section class="detail-dock" aria-live="polite" bind:this={detailPanelEl} onclick={(e) => e.stopPropagation()}>
          <h3 class="menu-title">Details</h3>
          <p class="menu-desc">
            {#if detailContent}
              This cell's transitions through 12 025 years{selectedCountryMeta ? ` within ${selectedCountryMeta.label}` : ''}.
            {:else if selectedCountryMeta}
              Anthrome composition of {selectedCountryMeta.label} across 12 025 years.
            {:else if uiOption() === 1}
              Anthrome composition of the whole world across 12 025 years.
              Pick a country or a cell to narrow it.
            {:else}
              Select a country above, or click a cell on the map.
            {/if}
          </p>
          <div class="detail-body">
            {#if uiOption() === 1}
              <!-- Option 1: the panel is never empty. World, country and cell
                   are three scales of one chart, so they share a single slot —
                   which is also what lets the swap between them animate: the
                   component instance survives, sees its sourceKey change, and
                   drains/refills in place. The header above and the cell's
                   tooltip text below update immediately; only the field
                   animates, exactly as the ring does. -->
              <!-- The scope pill sits in the same place at all three scales:
                   Earth for the world, the picked country, or an isolated
                   cell's present-day country. Same shape, same position, so
                   moving between scales reads as one continuous panel. -->
              {#if scopePill}
                <div class="detail-subhead">
                  <span class="country-badge">{scopePill.label}</span>
                  <span class="country-meta">
                    {#if scopePill.note}{scopePill.note}
                    {:else}{scopePill.samples.toLocaleString()} samples · {scopePill.species.toLocaleString()} species{/if}
                  </span>
                </div>
              {/if}

              {#if detailScale === 'cell'}
                <!-- Anthrome identity, then the "In <year>, X covers …"
                     sentence that comes with it. The country key/values and the
                     biomes cross-link that used to live in this HTML are gone —
                     the pill above states the same facts. -->
                {#if detailMeta?.label}
                  <div class="detail-subhead" bind:this={detailAnchorEl}>
                    {#if detailMeta?.color}
                      <span class="overlay-swatch" style={`background: ${detailMeta.color}`}></span>
                    {/if}
                    <span>{detailMeta.label}</span>
                  </div>
                {/if}
                {#if detailContent}
                  <div class="panel-content" onclick={handleDetailPanelClick}>
                    {@html detailContent}
                  </div>
                {/if}
              {/if}

              <div class="history-chart-section history-chart-section--fill" bind:this={historyChartEl}>
                <div class="history-chart-title">{detailTitle}</div>
                <div class="pixel-chart-box" bind:this={pixelChartEl}>
                  <PixelTimeline
                    mode={detailScale === 'cell' ? 'ladder' : 'stack'}
                    distribution={detailScale === 'country'
                      ? countryTimeseries?.[selectedCountryIso3]?.distribution ?? null
                      : worldDistribution}
                    series={cellSeries?.byYear ?? null}
                    sourceKey={detailSourceKey}
                    {colorMapping}
                    {labelMapping}
                    {orderedCodes}
                    families={LEGEND_CATEGORIES}
                    {selectedYear}
                    onSelectYear={(y) => (selectedYear = y)}
                    width={pixelChartW}
                    height={pixelChartH}
                  />
                </div>
              </div>
            {:else if detailContent}
              <!-- Cell selection takes precedence: fine-grained detail wins.
                   When a country is also active, its label surfaces here as
                   context, and returning to the country overview happens by
                   panning the map (which clears the cell isolation) or
                   picking the same anthrome tile again. -->
              {#if detailMeta?.label}
                <div class="detail-subhead">
                  {#if detailMeta?.color}
                    <span class="overlay-swatch" style={`background: ${detailMeta.color}`}></span>
                  {/if}
                  <span>{detailMeta.label}</span>
                  {#if selectedCountryMeta}
                    <span class="detail-within">within {selectedCountryMeta.label}</span>
                  {/if}
                </div>
              {/if}
              <div class="panel-content" onclick={handleDetailPanelClick}>
                {@html detailContent}
              </div>
              {#if barChartData?.length}
                <div class="history-chart-section" bind:this={historyChartEl}>
                  <div class="history-chart-title">Cell history</div>
                  <CellHistoryBar
                    periods={barChartData}
                    {selectedYear}
                    width={historyChartW}
                    height={CELL_BAR_H}
                  />
                </div>
              {/if}
            {:else if selectedCountryMeta && countryTimeseries?.[selectedCountryIso3]}
              <div class="detail-subhead">
                <span class="country-badge">{selectedCountryMeta.label}</span>
                <span class="country-meta">{selectedCountryMeta.samples_total.toLocaleString()} samples · {selectedCountryMeta.sgbs.length.toLocaleString()} species</span>
              </div>
              <div class="history-chart-section" bind:this={historyChartEl}>
                <div class="history-chart-title">Anthrome timeline</div>
                <CountryTimeseriesBar
                  data={countryTimeseries[selectedCountryIso3]}
                  {colorMapping}
                  {labelMapping}
                  {orderedCodes}
                  {selectedYear}
                  width={historyChartW}
                  height={COUNTRY_BAR_H}
                />
              </div>
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
          bind:cellSeries
          bind:isolationReset
          bind:connectorStart
          panelCloseSignal={panelCloseSignal}
          bind:focusIso3={selectedCountryIso3}
          bind:rangeIso3s
          bind:rangeSource
          countryDistribution={countryRingDistribution}
          strictCountryFocus={uiOption() === 1}
          compactCellDetail={uiOption() === 1}
          profile={topoProfile()}
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
<DevHud showMapResolution />
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

  /* Option 1: the row spans the rail's full content width, evenly distributed,
     so the controls read as one measure with the menu items below them. */
  .control-circles--arced {
    flex-wrap: nowrap;
    gap: 0;
    justify-content: space-between;
  }

  /* Positioning context for ArcLabel, which paints centred on the button and
     overflows it. */
  .ctl-slot {
    position: relative;
    flex: 0 0 auto;
    display: grid;
    place-items: center;
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

  /* Country picker: 4 columns × 2 rows. Cells are equal-width regardless of
     label length so the grid stays uniform. Mirrors biomes side. */
  .country-row {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    grid-auto-rows: max-content;
    row-gap: 22px;
    column-gap: 12px;
    justify-items: center;
    align-items: start;
    padding-top: 12px;
  }

  .country-cell {
    display: flex;
    justify-content: center;
    width: 100%;
    min-width: 0;
  }

  .fblock-headrow {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 15px;
    margin-bottom: 6px;
  }

  /* Range annotation tag — dashed-outline pattern echoes the dashed range
     stroke on the map, so the rail tag reads as "the dashed thing you see
     out there" at a glance. Distinct from the picker's solid ring. */
  .range-tag {
    display: block;
    padding: 12px 14px;
    border-radius: 14px;
    border: 1.4px dashed rgba(255, 255, 255, 0.75);
    background: rgba(255, 255, 255, 0.05);
  }

  .range-tag-row {
    display: flex;
    align-items: center;
    gap: 12px;
  }

  .range-tag-badge {
    width: 14px;
    height: 14px;
    border-radius: 50%;
    border: 1.6px dashed rgba(255, 255, 255, 0.85);
    flex: 0 0 auto;
  }

  .range-tag-body {
    display: flex;
    flex-direction: column;
    gap: 2px;
    flex: 1;
    min-width: 0;
  }

  .range-tag-title {
    font-size: 16px;
    font-weight: 800;
    letter-spacing: 0.02em;
    color: #fff;
  }

  .range-tag-sub {
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--muted);
  }

  .range-tag-clear {
    background: transparent;
    border: none;
    color: var(--fg);
    font-size: 20px;
    font-weight: 800;
    line-height: 1;
    padding: 4px 8px;
    cursor: pointer;
    opacity: 0.6;
    transition: opacity 0.15s ease;
    flex: 0 0 auto;
  }

  .range-tag-clear:hover {
    opacity: 1;
  }

  .country-badge {
    padding: 4px 10px;
    border-radius: 999px;
    background: rgba(255, 255, 255, 0.10);
    border: 1px solid rgba(255, 255, 255, 0.24);
    color: #fff;
    font-weight: 700;
    letter-spacing: 0.02em;
    font-size: 14px;
  }

  .country-meta {
    font-size: 11px;
    color: var(--muted);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    margin-left: 8px;
  }

  .detail-within {
    font-size: 11px;
    font-weight: 700;
    color: var(--muted);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    margin-left: 6px;
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

  /* Option 1's pixel timeline is the whole point of the dock when a country is
     picked, so it takes all of it — no 75% ceiling, and the body stops
     scrolling so the field can size to the box instead of overflowing it. */
  .detail-dock .history-chart-section--fill {
    max-height: none;
    align-items: stretch;
  }

  .detail-body:has(.history-chart-section--fill) {
    overflow: hidden;
  }

  .pixel-chart-box {
    flex: 1 1 auto;
    min-height: 120px;
    width: 100%;
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

  /* Detail-panel content typography (.panel-content .title/.subtitle/.summary/
     .detail-link/.kv/.swatch/.pill) is shared — see src/shared/styles.css. */

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
