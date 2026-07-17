<script>
  import { onMount } from 'svelte';
  import BiomesChart, {
    ABUNDANT_MIN_SAMPLES,
    RARE_MAX_SAMPLES,
    WIDESPREAD_MIN_COUNTRIES,
    CONCENTRATED_MAX_COUNTRIES
  } from './lib/BiomesChart.svelte';
  import { prepareBiomesData, colorMapping, pickTextColor, getPhylum, parseUSGB, parseWestern } from './lib/dataAdapter.js';
  import * as d3 from 'd3';
  import DevHud from '../shared/DevHud.svelte';
  import { initStage, screenToDesign } from '../shared/stage.svelte.js';
  import { uiOption } from '../shared/uiOption.svelte.js';

  // The fixed design canvas; everything below is authored in design px inside it.
  let stageEl = $state(null);
  $effect(() => {
    if (!stageEl) return;
    return initStage(stageEl);
  });

  // State
  let loading = $state(true);
  let error = $state(null);
  let taxonomyTree = $state(null);
  let allPhyla = $state([]);

  // UI State
  let selectedPhyla = $state([]);
  let unknownFilter = $state('all'); // 'all' | 'unknown' | 'known'
  let westernFilter = $state('any'); // 'any' | 'western' | 'nonwestern'
  let abundanceFilter = $state('any'); // 'any' | 'abundant' | 'rare' (Sample_ID_Count)
  let geoFilter = $state('any');       // 'any' | 'widespread' | 'concentrated' (Country_Count)
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

  // MoMA: cohort diversity ranking — by share of species previously unknown (uSGB)
  let cohortStats = $state({}); // key -> { sgbs, unknown }

  // Ranked + sized cohort bubbles, by share of species previously unknown (uSGB)
  const BUBBLE_MIN = 60;   // px diameter floor (finger-tappable)
  const BUBBLE_MAX = 160;  // px diameter cap
  const BUBBLE_GAP = 20;   // must match .cohort-bubbles `gap` in CSS
  let bubbleRowW = $state(0); // measured content width of the bubble row (design px)
  let rankedCohorts = $derived.by(() => {
    const scored = cohortOptions.map(c => {
      const s = cohortStats[c.key] || {};
      const upct = s.sgbs ? (s.unknown || 0) / s.sgbs : 0; // 0..1 share unknown (uSGB)
      return { ...c, upct };
    });
    scored.sort((a, b) => b.upct - a.upct);
    const maxV = Math.max(1e-6, ...scored.map(d => d.upct));
    const ts = scored.map(d => Math.sqrt(d.upct) / Math.sqrt(maxV)); // area ∝ value
    const sumT = ts.reduce((a, b) => a + b, 0);
    const n = scored.length;
    // Largest diameter that still fits the whole row on one line (bubbles never
    // shrink — see .bubble flex — so they'd ellipse if the row overflowed).
    // Solve n*MIN + sumT*(effMax-MIN) + gaps <= rowWidth for effMax, capped at MAX.
    let effMax = BUBBLE_MAX;
    if (bubbleRowW > 0 && sumT > 0) {
      const avail = bubbleRowW - (n - 1) * BUBBLE_GAP - 1; // -1px safety
      const fit = BUBBLE_MIN + (avail - n * BUBBLE_MIN) / sumT;
      effMax = Math.max(BUBBLE_MIN, Math.min(BUBBLE_MAX, fit));
    }
    scored.forEach((d, i) => {
      d.size = Math.floor(BUBBLE_MIN + ts[i] * (effMax - BUBBLE_MIN));
    });
    return scored;
  });

  // MoMA: known / unknown percentages (computed from leaves on mount)
  let knownPct = $state(0);
  let unknownPct = $state(0);

  // MoMA: western / non-western percentages (computed from leaves on mount)
  let westernPct = $state(0);
  let nonwesternPct = $state(0);

  // Prevalence percentages — share of all SGBs clearing each threshold constant
  // (computed from leaves on mount, same pass as known/unknown). abundantPct
  // doubles as the "top X% by sample count" figure in the compound-button caption.
  let abundantPct = $state(0);
  let rarePct = $state(0);
  let widespreadPct = $state(0);
  let concentratedPct = $state(0);

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

  // Leader line: from the chart's selection marker to the details panel
  let leaderFrom = $state(null); // {x, y} design px (marker, reported by chart)
  let leaderTo = $state(null);   // {x, y} design px (panel left edge, mid-height)

  function updateLeaderTo() {
    if (!detailContent || !detailPanelEl) { leaderTo = null; return; }
    const r = detailPanelEl.getBoundingClientRect();
    // Rect is screen px; the overlay draws in design px.
    leaderTo = screenToDesign(r.left, r.top + r.height / 2);
  }

  function handleMarker(event) {
    leaderFrom = event.detail || null;
    updateLeaderTo();
  }

  // Recompute the panel endpoint when the panel appears/changes or the window resizes.
  // The panel is flex:1, so async rail content (bubbles/phyla) reflows it after load —
  // observe its box so the leader endpoint tracks those late layout shifts.
  $effect(() => {
    const el = detailPanelEl;
    detailContent; viewportW; viewportH;
    updateLeaderTo();
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => updateLeaderTo());
    ro.observe(el);
    return () => ro.disconnect();
  });

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
      // Western / Non-western percentages (some leaves are neither)
      let western = 0, nonwestern = 0;
      // Prevalence counts (Sample_ID_Count / Country_Count thresholds)
      let abundant = 0, rare = 0, widespread = 0, concentrated = 0;
      // Set of unknown (uSGB) SGB IDs, for the cohort "% unknown" ranking
      const unknownSgbIds = new Set();
      for (const l of leaves) {
        const isUnknown = parseUSGB(l.data.metadata) === 'Yes';
        if (isUnknown) unknown++; else known++;
        if (isUnknown) {
          const id = Number(l.data.metadata?.SGB_ID);
          if (!Number.isNaN(id)) unknownSgbIds.add(id);
        }
        const w = parseWestern(l.data.metadata);
        if (w === 'western') western++; else if (w === 'nonwestern') nonwestern++;
        const samples = Number(l.data.metadata?.Sample_ID_Count);
        if (samples >= ABUNDANT_MIN_SAMPLES) abundant++;
        else if (samples <= RARE_MAX_SAMPLES) rare++;
        const countries = Number(l.data.metadata?.Country_Count);
        if (countries >= WIDESPREAD_MIN_COUNTRIES) widespread++;
        else if (countries <= CONCENTRATED_MAX_COUNTRIES) concentrated++;
      }
      const totalLeaves = (known + unknown) || 1;
      knownPct = Math.round((known / totalLeaves) * 100);
      unknownPct = Math.round((unknown / totalLeaves) * 100);
      westernPct = Math.round((western / totalLeaves) * 100);
      nonwesternPct = Math.round((nonwestern / totalLeaves) * 100);
      abundantPct = Math.round((abundant / totalLeaves) * 100);
      rarePct = Math.round((rare / totalLeaves) * 100);
      widespreadPct = Math.round((widespread / totalLeaves) * 100);
      concentratedPct = Math.round((concentrated / totalLeaves) * 100);

      // Cohort diversity stats (distinct SGBs + sample size) for the curated cohorts
      try {
        const studyRes = await fetch(`${import.meta.env.BASE_URL}data/study_index.json`);
        if (studyRes.ok) {
          const sj = await studyRes.json();
          const stats = {};
          for (const c of cohortOptions) {
            const r = sj[c.key];
            if (r) {
              const ids = (r.sgbs || []).map(Number);
              const unknownCount = ids.filter(id => unknownSgbIds.has(id)).length;
              stats[c.key] = { sgbs: ids.length, samples: r.samples_total ?? 0, unknown: unknownCount };
            }
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

  // "All" restores the phylum filter to its default (empty = every phylum shown),
  // mirroring the anthromes key's All button.
  function handleSelectAll() {
    selectedPhyla = [];
  }

  // Full reset to page-load state: every filter, the details panel, and the
  // chart's zoom/rotation/highlight.
  function resetAll() {
    selectedPhyla = [];
    unknownFilter = 'all';
    westernFilter = 'any';
    abundanceFilter = 'any';
    geoFilter = 'any';
    selectedStudyKey = null;
    openPanel = null;
    detailContent = null;
    detailPoint = null;
    biomesChartRef?.resetControl?.();
  }

  // Known/Unknown and Western/Non-western behave like Cohort: no "All" button.
  // All are shown by default; tap a value to isolate it, tap again to reset.
  function toggleUnknown(value) {
    unknownFilter = unknownFilter === value ? 'all' : value;
  }
  function toggleWestern(value) {
    westernFilter = westernFilter === value ? 'any' : value;
  }

  // ── Option 1 Prevalence filters (Block A) ──
  // Three axes — 'western' (Westernized_Mode), 'abundance' (Sample_ID_Count),
  // 'geo' (Country_Count) — behave as one isolate-group: tapping any button
  // clears all three axes, then sets its own. Tapping the active one resets.
  // (The .active classes still check a single dimension each, so a Block B
  // compound that sets several of these lights every button it implies.)
  function togglePrevalence(axis, value) {
    const current =
      axis === 'western' ? westernFilter : axis === 'abundance' ? abundanceFilter : geoFilter;
    const wasActive = current === value;
    westernFilter = 'any';
    abundanceFilter = 'any';
    geoFilter = 'any';
    if (wasActive) return; // re-tap of the active button = reset
    if (axis === 'western') westernFilter = value;
    else if (axis === 'abundance') abundanceFilter = value;
    else geoFilter = value;
  }

  // Option 1 Block B "Known/Unknown" row. Every button first resets all four
  // dimensions, then applies its own — so compound buttons never leave a stray
  // filter behind, and re-tapping an active button is a clean full reset.
  function selectKnownRow(next) {
    const active =
      unknownFilter === (next.unknownFilter ?? 'all') &&
      abundanceFilter === (next.abundanceFilter ?? 'any') &&
      geoFilter === (next.geoFilter ?? 'any') &&
      westernFilter === (next.westernFilter ?? 'any');
    unknownFilter = 'all';
    abundanceFilter = 'any';
    geoFilter = 'any';
    westernFilter = 'any';
    if (active) return; // re-tap of the already-active button = reset
    if (next.unknownFilter) unknownFilter = next.unknownFilter;
    if (next.abundanceFilter) abundanceFilter = next.abundanceFilter;
    if (next.geoFilter) geoFilter = next.geoFilter;
    if (next.westernFilter) westernFilter = next.westernFilter;
  }

  // Active-state helpers for Block B buttons. Known/Unknown light on their single
  // dimension alone — same shared-state reflection as Block A's Abundant/Concentrated
  // — so a compound selection (which also sets unknownFilter) lights Unknown too.
  // The compound buttons still require every claimed dimension to be set.
  const knownActive = $derived(unknownFilter === 'known');
  const unknownActive = $derived(unknownFilter === 'unknown');
  const unknownAbundantActive = $derived(
    unknownFilter === 'unknown' && abundanceFilter === 'abundant' && geoFilter === 'any' && westernFilter === 'any'
  );
  const unknownConcNonWestActive = $derived(
    unknownFilter === 'unknown' && geoFilter === 'concentrated' && westernFilter === 'nonwestern' && abundanceFilter === 'any'
  );

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
    if (target.closest('.detail-rail') || target.closest('.info-modal')) {
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

<!-- .viewport fills the window and shows the letterbox; .stage is the fixed
     3000x2000 canvas that everything below is authored against. -->
<div class="viewport">
<div class="stage" bind:this={stageEl}>
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
              <a href="{import.meta.env.BASE_URL}src/anthromes/" aria-label="Go to Anthromes">
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
          bind:westernFilter
          bind:abundanceFilter
          bind:geoFilter
          size={viewSize}
          {tension}
          bodySiteFilter={selectedBodySites}
          proxyKey={null}
          studyKey={selectedStudyKey}
          on:detail={handleDetail}
          on:detail-close={handleDetailClose}
          on:zoomchange={handleZoomChange}
          on:marker={handleMarker}
        />
      </div>

      <div class="rail">
        <!-- Top tier: largest control circles -->
        <div class="control-circles">
          <button class="ctl-btn" title="Zoom out" aria-label="Zoom out" onclick={() => biomesChartRef?.zoomOutControl?.()} disabled={zoomIdx === 0} aria-disabled={zoomIdx === 0}>−</button>
          <button class="ctl-btn" title="Reset" aria-label="Reset" onclick={resetAll}>◎</button>
          <button class="ctl-btn" title="Zoom in" aria-label="Zoom in" onclick={() => biomesChartRef?.zoomInControl?.()} disabled={zoomIdx === 2} aria-disabled={zoomIdx === 2}>＋</button>
          <button class="ctl-btn" title="Info" aria-label="Info" class:active={openPanel === 'info'} onclick={() => openPanel = openPanel === 'info' ? null : 'info'}>i</button>
        </div>

        {#if uiOption() === 2}
        <!-- Option 2 (unchanged): Known/Unknown and Non/Western share a row. No
             "All" button — like Cohort, all are shown by default; tap to isolate,
             tap again to reset. -->
        <div class="filter-row">
          <section class="fblock">
            <h3 class="fblock-title">Known / Unknown</h3>
            <p class="fblock-desc"><strong>Known</strong> — a species-level group already represented in reference databases. <strong>Unknown (uSGB)</strong> — a genome-defined species-level group newly identified in this study, not previously represented in reference databases.</p>
            <div class="sel-buttons">
              <button class="sel-btn" class:active={unknownFilter === 'known'} onclick={() => toggleUnknown('known')}>
                <span class="sel-name">Known</span>
                <span class="sel-pct">{knownPct}%</span>
              </button>
              <button class="sel-btn" class:active={unknownFilter === 'unknown'} onclick={() => toggleUnknown('unknown')}>
                <span class="sel-name">Unknown</span>
                <span class="sel-pct">{unknownPct}%</span>
              </button>
            </div>
          </section>

          <section class="fblock">
            <h3 class="fblock-title">Non / Western</h3>
            <p class="fblock-desc"><strong>Westernized</strong> — industrialized, urban populations with high exposure to modern medical and food systems. <strong>Non-Westernized</strong> — populations with limited industrialization and lower exposure to those systems.</p>
            <div class="sel-buttons">
              <button class="sel-btn" class:active={westernFilter === 'western'} onclick={() => toggleWestern('western')}>
                <span class="sel-name">Western</span>
                <span class="sel-pct">{westernPct}%</span>
              </button>
              <button class="sel-btn" class:active={westernFilter === 'nonwestern'} onclick={() => toggleWestern('nonwestern')}>
                <span class="sel-name">Non-Western</span>
                <span class="sel-pct">{nonwesternPct}%</span>
              </button>
            </div>
          </section>
        </div>

        <section class="fblock">
          <h3 class="fblock-title">Cohort</h3>
          <p class="fblock-desc">A defined group of study participants whose samples were collected and analyzed together. Sized and ranked by the share of each population's species that were previously unknown to science, most to least.</p>
          <div class="cohort-bubbles" bind:clientWidth={bubbleRowW}>
            {#each rankedCohorts as c (c.key)}
              <button
                class="bubble"
                class:active={selectedStudyKey === c.key}
                style="width:{c.size}px; height:{c.size}px;"
                title={`${Math.round(c.upct * 100)}% unknown (uSGB)`}
                onclick={() => selectStudyKey(c.key)}
              >
                <span class="sel-name">{c.label}</span>
                <span class="sel-pct">{Math.round(c.upct * 100)}% unknown</span>
              </button>
            {/each}
          </div>
        </section>
        {:else}
        <!-- Option 1: two stacked blocks — Prevalence (population type / samples /
             countries) then Known/Unknown with two compound buttons. Same
             tap-to-isolate / tap-again-to-reset pattern; each Block A button
             isolates its one dimension (clearing the other two axes). Cohort is
             intentionally omitted here to give the details panel room. -->
        <section class="fblock">
          <h3 class="fblock-title">Prevalence</h3>
          <p class="fblock-desc">How often bacteria are found in human populations, and where.</p>
          <div class="sel-buttons sel-buttons--stack">
            <!-- Three axis-pairs, each a vertical stack; row 1 / row 2 across:
                 Western  Abundant  Widespread  /  Non-Western  Rare  Concentrated -->
            <div class="sel-col">
              <button class="sel-btn" class:active={westernFilter === 'western'} onclick={() => togglePrevalence('western', 'western')}>
                <span class="sel-name">Western</span>
                <span class="sel-pct">{westernPct}%</span>
              </button>
              <span class="sel-caption">From industrialized, urban populations.</span>
            </div>
            <div class="sel-col">
              <button class="sel-btn" class:active={abundanceFilter === 'abundant'} onclick={() => togglePrevalence('abundance', 'abundant')}>
                <span class="sel-name">Abundant</span>
                <span class="sel-pct">{abundantPct}%</span>
              </button>
              <span class="sel-caption">Found in many samples across the dataset.</span>
            </div>
            <div class="sel-col">
              <button class="sel-btn" class:active={geoFilter === 'widespread'} onclick={() => togglePrevalence('geo', 'widespread')}>
                <span class="sel-name">Widespread</span>
                <span class="sel-pct">{widespreadPct}%</span>
              </button>
              <span class="sel-caption">Present across several countries.</span>
            </div>
            <div class="sel-col">
              <button class="sel-btn" class:active={westernFilter === 'nonwestern'} onclick={() => togglePrevalence('western', 'nonwestern')}>
                <span class="sel-name">Non-Western</span>
                <span class="sel-pct">{nonwesternPct}%</span>
              </button>
              <span class="sel-caption">From populations with limited industrialization.</span>
            </div>
            <div class="sel-col">
              <button class="sel-btn" class:active={abundanceFilter === 'rare'} onclick={() => togglePrevalence('abundance', 'rare')}>
                <span class="sel-name">Rare</span>
                <span class="sel-pct">{rarePct}%</span>
              </button>
              <span class="sel-caption">Found in only one sample so far.</span>
            </div>
            <div class="sel-col">
              <button class="sel-btn" class:active={geoFilter === 'concentrated'} onclick={() => togglePrevalence('geo', 'concentrated')}>
                <span class="sel-name">Concentrated</span>
                <span class="sel-pct">{concentratedPct}%</span>
              </button>
              <span class="sel-caption">Found in only one country.</span>
            </div>
          </div>
        </section>

        {/if}

        <!-- Details: shared by both options, occupying the flexible middle band.
             Option 1 places it ABOVE Known/Unknown so the horizontal marker
             leader lines up with the panel; Option 2 has it after Cohort. The
             leader endpoint tracks its box, so it follows the move. -->
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <section class="fblock detail-block" aria-live="polite" bind:this={detailPanelEl} onclick={(e) => e.stopPropagation()}>
          <h3 class="fblock-title">Bacteria Species Details</h3>
          <p class="fblock-desc">The evolutionary lineage and genome profile of the species at the marker.</p>
          <div class="panel-content detail-scroll" onclick={handleDetailPanelClick}>
            {#if detailContent}
              {@html detailContent}
            {:else}
              <p class="detail-hint">Spin the disk to inspect a species.</p>
            {/if}
          </div>
        </section>

        {#if uiOption() === 1}
        <!-- Known/Unknown sits below the details panel in Option 1 (swapped so
             the marker leader aligns with the panel). Option-1-only content. -->
        <section class="fblock">
          <h3 class="fblock-title">Known / Unknown</h3>
          <p class="fblock-desc">Which bacteria species were already known before this study, and how the newly-identified ones break down by prevalence.</p>
          <div class="sel-buttons sel-buttons--pairs">
            <div class="sel-pair">
              <div class="sel-col">
                <button class="sel-btn" class:active={knownActive} onclick={() => selectKnownRow({ unknownFilter: 'known' })}>
                  <span class="sel-name">Known</span>
                  <span class="sel-pct">{knownPct}%</span>
                </button>
                <span class="sel-caption">Bacteria species known before this study.</span>
              </div>
              <div class="sel-col">
                <button class="sel-btn" class:active={unknownActive} onclick={() => selectKnownRow({ unknownFilter: 'unknown' })}>
                  <span class="sel-name">Unknown</span>
                  <span class="sel-pct">{unknownPct}%</span>
                </button>
                <span class="sel-caption">Bacteria species newly identified in this study.</span>
              </div>
            </div>
            <div class="sel-pair">
              <div class="sel-col">
                <button class="sel-btn" class:active={unknownAbundantActive} onclick={() => selectKnownRow({ unknownFilter: 'unknown', abundanceFilter: 'abundant' })}>
                  <span class="sel-name">Unknown + Abundant</span>
                </button>
                <span class="sel-caption">Unknown bacteria species that are also common — found in the top {abundantPct}% of species by sample count.</span>
              </div>
              <div class="sel-col">
                <button class="sel-btn" class:active={unknownConcNonWestActive} onclick={() => selectKnownRow({ unknownFilter: 'unknown', geoFilter: 'concentrated', westernFilter: 'nonwestern' })}>
                  <span class="sel-name">Unknown + Concentrated + Non-Western</span>
                </button>
                <span class="sel-caption">Unknown species found concentrated in a single country, with limited exposure to industrialized systems.</span>
              </div>
            </div>
          </div>
        </section>
        {/if}

        <!-- Bottom tier: phylum key -->
        <section class="phylum-band">
          <div class="phylum-band-head">
            <span class="phylum-band-title">Phylum</span>
            <div class="phylum-band-actions">
              <button class="mini-link" class:active={selectedPhyla.length === 0} onclick={handleSelectAll}>All</button>
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

    <!-- Leader line: chart selection marker → details panel -->
    {#if detailContent && leaderFrom && leaderTo}
      <svg class="leader-overlay" aria-hidden="true">
        <!-- Straight horizontal run from the marker to just shy of the rail edge -->
        <line
          class="leader-line"
          x1={leaderFrom.x} y1={leaderFrom.y}
          x2={leaderTo.x - 8} y2={leaderFrom.y}
        />
      </svg>
    {/if}

    <!-- Info modal -->
    {#if openPanel === 'info'}
      <!-- svelte-ignore a11y_click_events_have_key_events -->
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div class="info-modal" aria-live="polite" onclick={(e) => e.stopPropagation()}>
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
</div>
<!-- Outside .stage so it renders at true screen px, unscaled -->
<DevHud />
</div>

<style>
  .loading,
  .error {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 100%;
    text-align: center;
    font-size: 21px;
    color: var(--fg);
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

  .layout {
    display: grid;
    grid-template-columns: minmax(0, 2fr) minmax(0, 1fr);
    height: 100%;
    align-items: stretch;
    gap: 0;
  }

  /* MoMA circle-size tiers, in design px on the 3000x2000 canvas */
  .rail {
    --tier-top: 118px;     /* biggest: controls */
    --tier-mid: 150px;     /* medium: filter/select */
    --tier-key: 118px;     /* smallest: phylum key */
    grid-column: 2;
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
  .rail > * + * {
    border-top: 1.3px solid rgba(255, 255, 255, 0.14);
    margin-top: 23px;
    padding-top: 23px;
  }

  .control-circles,
  .fblock,
  .filter-row,
  .phylum-band {
    flex: 0 0 auto;
  }

  /* Known/Unknown + Non/Western sit side by side in one rail row */
  .filter-row {
    display: flex;
    gap: 44px;
    align-items: flex-start;
  }

  .filter-row .fblock {
    flex: 1 1 0;
    min-width: 0;
  }

  .detail-block {
    flex: 1 1 auto;
    min-height: 0;
  }

  .viz-area {
    position: relative;
    height: 100%;
    width: 100%;
    overflow: hidden;
  }

  .nav-circle {
    position: absolute;
    bottom: 26px;
    left: 26px;
    width: 248px;
    height: 248px;
    border-radius: 50%;
    background: var(--bg);
    border: 3.8px solid rgba(255, 255, 255, 0.85);
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
    width: 220px;
    height: 220px;
    border-radius: 50%;
    text-decoration: none;
    pointer-events: auto;
  }

  .nav-circle svg {
    width: 220px;
    height: 220px;
    overflow: visible;
  }

  .nav-circle__ring {
    fill: none;
    stroke: none;
  }

  /* In SVG user units (viewBox is 120 wide), not px — scales with the svg box. */
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
    width: 60px;
    height: 60px;
    border-radius: 50%;
    border: 1.3px solid rgba(255, 255, 255, 0.4);
    background: transparent;
    color: rgba(255, 255, 255, 0.9);
    display: grid;
    place-items: center;
    font-size: 28px;
    line-height: 1;
    font-weight: 800;
    text-decoration: none;
    pointer-events: auto;
  }


  /* ===== MoMA rail: top control circles (biggest tier) ===== */
  .control-circles {
    display: flex;
    flex-wrap: wrap;
    gap: 28px;
    justify-content: flex-end;
    align-items: center;
  }

  .ctl-btn {
    width: var(--tier-top);
    height: var(--tier-top);
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

  /* ===== Middle tier: menu items ===== */
  .fblock {
    display: flex;
    flex-direction: column;
    gap: 13px;
    min-width: 0;
  }

  .fblock-title {
    margin: 0;
    font-size: 24px;
    font-weight: 800;
    letter-spacing: 0.02em;
    color: var(--fg);
  }

  .fblock-desc {
    margin: 0;
    font-size: 16.6px;
    line-height: 1.45;
    color: var(--muted);
  }

  .fblock-desc strong {
    color: #fff;
  }

  /* Known / Unknown + Non / Western: medium circular select buttons */
  .sel-buttons {
    display: flex;
    flex-wrap: nowrap;
    gap: 22px;
  }

  .sel-btn {
    width: var(--tier-mid);
    height: var(--tier-mid);
    border-radius: 50%;
    background: var(--bg);
    border: 3.8px solid rgba(255, 255, 255, 0.85);
    color: var(--fg);
    cursor: pointer;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    text-align: center;
    padding: 10px;
    box-sizing: border-box;
    box-shadow: var(--shadow);
  }

  .sel-name {
    font-size: 16px;
    font-weight: 700;
    line-height: 1.05;
  }

  .sel-pct {
    font-size: 13px;
    font-weight: 600;
    line-height: 1.1;
    margin-top: 3px;
    opacity: 0.7;
  }

  .sel-btn.active {
    background: #fff;
    color: var(--bg);
    border-color: #fff;
  }

  .sel-btn.active .sel-pct {
    opacity: 0.75;
  }

  .sel-btn:active {
    transform: scale(0.96);
  }

  /* ===== Option 1: nested-pair button rows + per-button captions =====
     Two visually-grouped pairs: a small gap within each pair, a larger gap
     between the two pairs. Each button carries a short caption beneath it. */
  .sel-buttons--pairs {
    width: 100%;
    gap: 60px;               /* the larger space that separates the two pairs */
    align-items: flex-start;
  }

  .sel-pair {
    flex: 1 1 0;             /* each pair fills half the row */
    display: flex;
    gap: 22px;               /* the small space within a pair */
    align-items: flex-start;
  }

  .sel-col {
    flex: 1 1 0;             /* two equal columns per pair — captions get the full
                               available width, so they wrap to fewer lines */
    min-width: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 11px;
  }

  /* Stacked variant (Prevalence, 6 buttons): a 3-column grid, two rows. Column
     gap is the larger between-pair space, row gap the small within-pair space.
     Grid keeps the second row of buttons aligned across columns even when the
     first-row captions differ in height. */
  .sel-buttons--stack {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    column-gap: 60px;
    row-gap: 18px;
    width: 100%;
    align-items: start;
  }

  /* Prevalence circles are smaller than the standard --tier-mid select buttons:
     six of them in two rows, so the extra height matters for the details panel. */
  .sel-buttons--stack .sel-btn {
    width: 140px;
    height: 140px;
  }

  .sel-buttons--stack .sel-name {
    font-size: 15.5px;
  }

  .sel-caption {
    font-size: 13px;
    line-height: 1.3;
    color: var(--muted);
    text-align: center;
  }

  /* Cohort ranked bubbles */
  .cohort-bubbles {
    display: flex;
    flex-wrap: nowrap;
    align-items: center;
    gap: 20px;
    padding-top: 7.7px;
  }

  .bubble {
    flex: 0 0 auto;   /* never grow/shrink — a squashed bubble reads as an ellipse */
    min-width: 0;     /* let width equal the set diameter even if content is wider */
    border-radius: 50%;
    background: var(--bg);
    border: 3.8px solid rgba(255, 255, 255, 0.85);
    color: var(--fg);
    cursor: pointer;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    text-align: center;
    padding: 7.7px;
    box-sizing: border-box;
    box-shadow: var(--shadow);
    transition: width 0.35s ease, height 0.35s ease;
  }

  .bubble.active {
    background: #fff;
    color: var(--bg);
    border-color: #fff;
  }

  .bubble.active .sel-pct {
    opacity: 0.75;
  }

  .bubble:active {
    transform: scale(0.96);
  }

  /* ===== Bottom tier: phylum key ===== */
  .phylum-band {
    display: flex;
    flex-direction: column;
    gap: 13px;
    min-height: 0;
  }

  .phylum-band-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 15px;
  }

  .phylum-band-title {
    font-size: 22px;
    font-weight: 800;
    letter-spacing: 0.02em;
  }

  .phylum-band-actions {
    display: flex;
    gap: 15px;
  }

  /* Matches the cohort Total/Per-capita toggle: text with an underline on the
     active state. "All" is active when no phylum filter is applied (the default). */
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

  .phylum-key {
    display: flex;
    flex-wrap: wrap;
    gap: 14px;
    overflow: auto;
    align-content: flex-start;
  }

  /* Compact key pill; colour = phylum, tap to toggle. Matches the anthromes
     key-pill: selection is shown by opacity alone (dimmed when not selected),
     never a border/box-shadow ring. */
  .phylum-dot {
    display: inline-flex;
    align-items: center;
    height: 41px;
    padding: 0 17px;
    border-radius: 11.5px;
    border: 1.3px solid rgba(0, 0, 0, 0.18);
    cursor: pointer;
    white-space: nowrap;
    box-sizing: border-box;
    user-select: none;
    touch-action: none;
    transition: opacity 0.15s ease;
  }

  .phylum-dot span {
    font-size: 16.6px;
    font-weight: 600;
    line-height: 1;
    letter-spacing: 0.01em;
  }

  .phylum-dot.dim {
    opacity: 0.35;
  }

  /* ===== Leader line from the chart selection marker to the details panel =====
     Spans the design canvas; its SVG user units are design px. */
  .leader-overlay {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    pointer-events: none;
    z-index: 6;
    overflow: visible;
  }

  .leader-line {
    stroke: rgba(255, 255, 255, 0.85);
    stroke-width: 1.9;
    stroke-dasharray: 2.6 7.7;
    stroke-linecap: round;
  }

  /* ===== Details: styled exactly like the other menu items (no card) ===== */
  .detail-block {
    display: flex;
    flex-direction: column;
    gap: 13px;
    pointer-events: auto;
  }

  .detail-scroll {
    flex: 1 1 auto;
    min-height: 0;
    overflow: auto;
  }

  .detail-hint {
    margin: 0;
    font-size: 16.6px;
    font-weight: 700;
    letter-spacing: 0.02em;
    color: var(--fg);
    opacity: 0.85;
  }

  /* Info stays a centered overlay on the design canvas (longer read).
     Percentages resolve against .stage, i.e. the 3000x2000 canvas. */
  .info-modal {
    position: absolute;
    top: 50%;
    left: 50%;
    width: 973px;
    max-width: calc(100% - 123px);
    max-height: 82%;
    overflow: auto;
    transform: translate(-50%, -50%);
    background: var(--bg);
    border: 3.8px solid rgba(255, 255, 255, 0.85);
    border-radius: 33px;
    padding: 38px 44px;
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

  .info-body {
    display: grid;
    gap: 18px;
    font-size: 22px;
    line-height: 1.6;
    color: var(--muted);
  }

  .info-body p {
    margin: 0;
  }

  .info-body p + p {
    padding-top: 7.7px;
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
    gap: 15px;
    margin-bottom: 23px;
  }

  .overlay-title {
    font-weight: 700;
    letter-spacing: 0.04em;
    font-size: 33px;
  }

  .panel-content {
    font-size: 16.6px;
    color: var(--muted);
    line-height: 1.5;
    display: grid;
    gap: 11px;              /* unified with the anthromes detail panel */
    overflow: auto;
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

  .info-citations a:hover {
    text-decoration: underline;
  }

  /* Detail panel typography */
  :global(.panel-content .title) {
    font-size: 23px;
    font-weight: 800;
    letter-spacing: 0.04em;
    color: #fff;
  }

  :global(.panel-content .subtitle) {
    font-size: 16.6px;
    color: #cfd3e0;
    letter-spacing: 0.02em;
  }

  :global(.panel-content .summary) {
    font-size: 16.6px;
    color: #e7e9f1;
  }

  /* Inline, clickable action link that lives at the end of the summary sentence
     (e.g. "Highlight countries … →") — underline + arrow signal it's tappable.
     Unified across biomes + anthromes; replaces the old boxed .actions button. */
  :global(.panel-content .detail-link) {
    color: var(--accent, #7dd3fc);
    text-decoration: underline;
    text-underline-offset: 2.6px;
    cursor: pointer;
    pointer-events: auto;
  }

  :global(.panel-content .kv) {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 5px 13px;
    padding: 7.7px 0;
    border-top: 1.3px dashed rgba(255,255,255,0.12);
  }

  :global(.panel-content .kv .k) {
    font-size: 14px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: #9ba3c0;
  }

  :global(.panel-content .kv .v) {
    color: #f6f7fb;
    font-weight: 600;
    font-size: 16.6px;
  }

  :global(.panel-content .swatch) {
    display: inline-block;
    width: 18px;
    height: 18px;
    border-radius: 5px;
    border: 1.3px solid rgba(255,255,255,0.25);
    margin-right: 7.7px;
    vertical-align: middle;
  }

  :global(.panel-content .pill),
  :global(.panel-content .badge) {
    display: inline-flex;
    align-items: center;
    gap: 7.7px;
    padding: 7.7px 13px;
    border-radius: 999px;
    background: rgba(255,255,255,0.08);
    border: 1.3px solid rgba(255,255,255,0.16);
    color: #fff;
    font-size: 14px;
    letter-spacing: 0.03em;
  }

  :global(.panel-content .actions) {
    display: grid;
    gap: 10px;
    margin-top: 2.6px;
  }

  :global(.panel-content .actions button) {
    text-align: left;
    background: rgba(255,255,255,0.08);
    border: 1.3px solid rgba(255,255,255,0.18);
    color: #fff;
    border-radius: 15px;
    padding: 14px 18px;
    font-weight: 700;
    font-size: 16.6px;
    cursor: pointer;
  }

  :global(.panel-content .actions button:hover) {
    background: rgba(255,255,255,0.14);
    border-color: rgba(255,255,255,0.26);
  }

  .chevron {
    background: var(--bg);
    border: 2.6px solid rgba(255, 255, 255, 0.85);
    color: var(--fg);
    border-radius: 50%;
    width: 61px;
    height: 61px;
    font-size: 28px;
    display: grid;
    place-items: center;
    font-weight: 800;
    cursor: pointer;
    flex: none;
  }

</style>
