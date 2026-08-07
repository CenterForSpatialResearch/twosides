<script>
  import { onMount } from 'svelte';
  import BiomesChart, {
    ABUNDANT_MIN_SAMPLES,
    RARE_MAX_SAMPLES,
    WIDESPREAD_MIN_COUNTRIES,
    CONCENTRATED_MAX_COUNTRIES,
    LIFESTYLE_MAGENTA,
    LIFESTYLE_SHARED,
    isNonWesternExclusive
  } from './lib/BiomesChart.svelte';
  import { prepareBiomesData, colorMapping, pickTextColor, getPhylum, parseUSGB, parseWestern } from './lib/dataAdapter.js';
  import * as d3 from 'd3';
  import { feature as topoFeature } from 'topojson-client';
  import DevHud from '../shared/DevHud.svelte';
  import NavCircle from '../shared/NavCircle.svelte';
  import CountryCircle from '../shared/CountryCircle.svelte';
  import PhylumBubbles from './lib/PhylumBubbles.svelte';
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
  // SGB count per phylum (drives bubble sizing). Set alongside allPhyla.
  let phylumCountByName = $state({});
  // Leaf lookup by SGB_ID — used to compute per-country prevalence stats
  // (abundant/rare, widespread/concentrated, known/unknown) at selection time.
  let leafBySgbId = $state(new Map());

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
  // Country-first primary filter (Phase 2). ISO3 or null.
  // Seeded from ?country=ISO3 so a selection carries across the two sides.
  let selectedCountryIso3 = $state(readCountryParam());
  let primaryCountries = $state(null);        // { ISO3: {label, sgbs, ...} } from primary_countries.json
  let countryFeatureByIso = $state(new Map()); // ISO3 -> feature (target countries only)
  const PRIMARY_ORDER = ['SWE', 'GBR', 'USA', 'CHN', 'MDG', 'FJI', 'PER', 'TZA'];
  // Compact display labels — iso3_names.json expands SWE→"Sweden", USA→"United
  // States of America", GBR→"United Kingdom" etc. The picker needs short,
  // uniform labels that don't dictate the circle's layout width.
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

  // ── UI Option 1: lifestyle rows ─────────────────────────────────────────────
  // Pasolli assigns Westernized per cohort, but cohorts are country-bounded: of
  // the 30 countries in the corpus only Mongolia (not in this eight) carries
  // both labels, so the split is a clean property of the country here.
  const WESTERN_ISOS = ['SWE', 'GBR', 'USA', 'CHN'];
  const NONWESTERN_ISOS = ['MDG', 'FJI', 'PER', 'TZA'];
  const NONWESTERN_SET = new Set(NONWESTERN_ISOS);

  // SGB_IDs never reconstructed from a Westernized sample (see
  // isNonWesternExclusive in BiomesChart) — drives the magenta leaf colour and
  // the per-country magenta share.
  let nonWestOnlySgbIds = $state(new Set());
  // ISO3 -> { unknownPct, magentaPct, sgbs } for every country in PRIMARY_ORDER,
  // computed once on mount so the bubbles can be ranked without a selection.
  let countryRowStats = $state({});

  const selectedIsNonWestern = $derived(
    !!selectedCountryIso3 && NONWESTERN_SET.has(selectedCountryIso3)
  );

  // Each row ranked by share of species unknown to science, greatest first.
  function rankRow(isos) {
    return isos
      .map((iso3) => ({ iso3, unknownPct: countryRowStats[iso3]?.unknownPct ?? 0 }))
      .sort((a, b) => b.unknownPct - a.unknownPct);
  }
  const westernRow = $derived(rankRow(WESTERN_ISOS));
  const nonWesternRow = $derived(rankRow(NONWESTERN_ISOS));

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

  // Cross-side link carries every part of the current context that the other
  // side knows how to accept: the picked country AND (if the disk has landed
  // on a species) that species' SGB, so anthromes arrives with both the
  // primary country highlighted and the range annotation for the species.
  const crossLinkHref = $derived.by(() => {
    const base = import.meta.env.BASE_URL;
    const params = new URLSearchParams();
    if (selectedCountryIso3) params.set('country', selectedCountryIso3);
    const sgbId = detailMeta?.metadata?.SGB_ID;
    if (sgbId != null) params.set('highlightSGB', String(sgbId));
    const q = params.toString();
    return `${base}src/anthromes/${q ? `?${q}` : ''}`;
  });

  // Persist current selection in the URL so a page reload or cross-side link
  // preserves the country. replaceState keeps the history stack clean.
  $effect(() => {
    updateCountryParam(selectedCountryIso3);
  });
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
  let detailMeta = $state(null); // { metadata, name, phylum, leafId } from BiomesChart
  // Overlay-annotation state — multi-species range from anthromes (cell
  // tooltip or SGB link). BiomesChart writes this when the URL brings a
  // highlight; App renders a dismissible rail tag off it.
  let rangeSource = $state(null);

  function clearRange() {
    rangeSource = null;
    biomesChartRef?.clearHighlight?.();
    if (typeof window !== 'undefined') {
      const url = new URL(window.location.href);
      url.searchParams.delete('highlightSGB');
      url.searchParams.delete('highlightSGBs');
      window.history.replaceState(null, '', url.toString());
      sessionStorage.removeItem('highlightSGBs');
    }
  }
  let detailPanelEl = $state(null);
  let detailPanelAnchor = $state(null);
  let viewportW = $state(0);
  let viewportH = $state(0);

  // Leader line: from the chart's selection marker to the details panel
  let leaderFrom = $state(null); // {x, y} design px (marker, reported by chart)
  let leaderTo = $state(null);   // {x, y} design px (panel left edge, mid-height)

  function updateLeaderTo() {
    if (!detailContent || !detailPanelEl) { leaderTo = null; return; }
    // Anchor on the panel TITLE (not the panel mid-height) so the leader lands
    // in line with "Bacteria Species Details". Rect is screen px; overlay is design px.
    const titleEl = detailPanelEl.querySelector('.fblock-title');
    const r = (titleEl || detailPanelEl).getBoundingClientRect();
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
      const sortedEntries = Array.from(phylumCounts.entries()).sort((a, b) => b[1] - a[1]);
      allPhyla = sortedEntries.map(([phylum]) => phylum);
      phylumCountByName = Object.fromEntries(sortedEntries);

      // SGB → leaf map (metadata.SGB_ID is a number stringified in some places)
      const leafMap = new Map();
      for (const l of leaves) {
        const id = Number(l.data?.metadata?.SGB_ID);
        if (Number.isFinite(id)) leafMap.set(id, l);
      }
      leafBySgbId = leafMap;

      // Known / Unknown percentages (uSGB === 'Yes' means unknown)
      let known = 0, unknown = 0;
      // Western / Non-western percentages (some leaves are neither)
      let western = 0, nonwestern = 0;
      // Prevalence counts (Sample_ID_Count / Country_Count thresholds)
      let abundant = 0, rare = 0, widespread = 0, concentrated = 0;
      // Set of unknown (uSGB) SGB IDs, for the cohort "% unknown" ranking
      const unknownSgbIds = new Set();
      // Set of SGB IDs found only in non-Westernized samples (Option 1 magenta)
      const nwOnly = new Set();
      for (const l of leaves) {
        if (isNonWesternExclusive(l.data.metadata)) {
          const nwId = Number(l.data.metadata?.SGB_ID);
          if (Number.isFinite(nwId)) nwOnly.add(nwId);
        }
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
      nonWestOnlySgbIds = nwOnly;
      const totalLeaves = (known + unknown) || 1;
      knownPct = Math.round((known / totalLeaves) * 100);
      unknownPct = Math.round((unknown / totalLeaves) * 100);
      westernPct = Math.round((western / totalLeaves) * 100);
      nonwesternPct = Math.round((nonwestern / totalLeaves) * 100);
      abundantPct = Math.round((abundant / totalLeaves) * 100);
      rarePct = Math.round((rare / totalLeaves) * 100);
      widespreadPct = Math.round((widespread / totalLeaves) * 100);
      concentratedPct = Math.round((concentrated / totalLeaves) * 100);

      // Country-first picker data (Phase 2): the curated 8-country manifest and
      // the admin boundary geometries used to draw each CountryCircle globe.
      try {
        const base = import.meta.env.BASE_URL;
        const [pcRes, boundariesRes] = await Promise.all([
          fetch(`${base}data/primary_countries.json`),
          fetch(`${base}topojson/admin-boundaries/countries-110m.topojson`)
        ]);
        if (pcRes.ok) {
          primaryCountries = await pcRes.json();
          // Per-country row stats for the Option 1 bubbles. Denominator is the
          // country's distinct-SGB roster, matching countryStats below.
          const rs = {};
          for (const iso of PRIMARY_ORDER) {
            const ids = (primaryCountries[iso]?.sgbs || []).map(Number);
            if (!ids.length) continue;
            const u = ids.filter((id) => unknownSgbIds.has(id)).length;
            const m = ids.filter((id) => nwOnly.has(id)).length;
            rs[iso] = {
              sgbs: ids.length,
              unknownPct: Math.round((u / ids.length) * 100),
              magentaPct: Math.round((m / ids.length) * 100)
            };
          }
          countryRowStats = rs;
        }
        if (boundariesRes.ok) {
          const topo = await boundariesRes.json();
          const objName = Object.keys(topo.objects)[0];
          const fc = topoFeature(topo, topo.objects[objName]);
          // Only keep the 8 target-country features. The picker no longer
          // renders context boundaries, so materializing all 172 features into
          // reactive state is wasted memory + reactivity work.
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
    selectedCountryIso3 = null;
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

  // Bubble picker uses the same selectedPhyla list — a normal bubble is one
  // phylum; the aggregated Other bubble stands in for its member phyla list.
  function handleBubbleToggle(datum) {
    if (datum.isOther) {
      const members = new Set(datum.memberNames);
      const overlap = selectedPhyla.filter((p) => members.has(p));
      if (overlap.length === members.size) {
        // All members currently selected → remove them.
        selectedPhyla = selectedPhyla.filter((p) => !members.has(p));
      } else {
        // Otherwise select the whole group (idempotent union).
        const rest = selectedPhyla.filter((p) => !members.has(p));
        selectedPhyla = [...rest, ...datum.memberNames];
      }
      return;
    }
    togglePhylum(datum.name);
  }

  // Bubble input: derived list of {name, count, color, isOther?, memberNames?}.
  // Any phylum that falls through to the palette's Other colour collapses into
  // a single Other bubble carrying the summed count and its member names.
  const OTHER_COLOR = colorMapping.Other;
  const phylumBubbles = $derived.by(() => {
    if (!allPhyla.length) return [];
    const primary = [];
    const otherMembers = [];
    let otherCount = 0;
    for (const name of allPhyla) {
      const count = phylumCountByName[name] || 0;
      const color = colorMapping[name] || OTHER_COLOR;
      if (color === OTHER_COLOR) {
        otherMembers.push(name);
        otherCount += count;
      } else {
        primary.push({ name, count, color });
      }
    }
    if (otherMembers.length) {
      primary.push({
        name: 'Other',
        count: otherCount,
        color: OTHER_COLOR,
        isOther: true,
        memberNames: otherMembers
      });
    }
    return primary;
  });

  // Bubble container geometry (bound to the .phylum-key element so the pack
  // layout fits the actual available box).
  let phBoxW = $state(0);
  let phBoxH = $state(0);

  // Per-country prevalence stats — computed from the leaves whose SGB is in
  // the country's sgbs array. Uses the same thresholds as BiomesChart's
  // filter chain (ABUNDANT_MIN_SAMPLES / RARE_MAX_SAMPLES /
  // WIDESPREAD_MIN_COUNTRIES / CONCENTRATED_MAX_COUNTRIES).
  const countryStats = $derived.by(() => {
    if (!selectedCountryIso3 || !primaryCountries) return null;
    const meta = primaryCountries[selectedCountryIso3];
    if (!meta?.sgbs?.length || !leafBySgbId.size) return null;

    let matched = 0;
    let abundant = 0, rare = 0, widespread = 0, concentrated = 0;
    let known = 0, unknown = 0;
    for (const sgb of meta.sgbs) {
      const leaf = leafBySgbId.get(Number(sgb));
      if (!leaf) continue;
      matched += 1;
      const md = leaf.data?.metadata || {};
      const samples = Number(md.Sample_ID_Count);
      const countries = Number(md.Country_Count);
      if (Number.isFinite(samples)) {
        if (samples >= ABUNDANT_MIN_SAMPLES) abundant += 1;
        else if (samples <= RARE_MAX_SAMPLES) rare += 1;
      }
      if (Number.isFinite(countries)) {
        if (countries >= WIDESPREAD_MIN_COUNTRIES) widespread += 1;
        else if (countries <= CONCENTRATED_MAX_COUNTRIES) concentrated += 1;
      }
      const isU = parseUSGB(md) === 'Yes';
      if (isU) unknown += 1; else known += 1;
    }
    const pct = (n) => (matched ? Math.round((n / matched) * 100) : 0);
    return {
      matched,
      known, unknown,
      abundant, rare, widespread, concentrated,
      knownPct: pct(known),
      unknownPct: pct(unknown),
      abundantPct: pct(abundant),
      rarePct: pct(rare),
      widespreadPct: pct(widespread),
      concentratedPct: pct(concentrated)
    };
  });

  // Pick which stat to accent — the paper's headline is the uSGB gap in
  // Non-Westernized cohorts, so weight those findings above the more
  // "typical" cohort-level stats. Whichever stat wins gets the highlighted
  // tile so the panel reads as "here's what makes this cohort notable."
  const STAT_WEIGHT = {
    unknown: 1.25,        // paper's key finding
    rare: 1.10,           // single-sample species = hidden diversity
    concentrated: 1.05,   // geographic hotspots
    widespread: 1.00,     // pan-human core species
    abundant: 1.00,
    known: 0.90           // less narratively interesting
  };

  const heroStat = $derived.by(() => {
    const s = countryStats;
    if (!s) return null;
    const candidates = [
      { key: 'unknown', pct: s.unknownPct },
      { key: 'known', pct: s.knownPct },
      { key: 'widespread', pct: s.widespreadPct },
      { key: 'concentrated', pct: s.concentratedPct },
      { key: 'abundant', pct: s.abundantPct },
      { key: 'rare', pct: s.rarePct }
    ];
    let best = null;
    let bestScore = -Infinity;
    for (const c of candidates) {
      const score = c.pct * (STAT_WEIGHT[c.key] || 1);
      if (score > bestScore) {
        bestScore = score;
        best = c.key;
      }
    }
    return best;
  });

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

  function selectCountry(iso3) {
    selectedCountryIso3 = selectedCountryIso3 === iso3 ? null : iso3;
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
    detailMeta = event.detail?.meta || null;
    openPanel = null;
  }

  function handleDetailPanelClick(event) {
    event.stopPropagation();
    biomesChartRef?.handleTooltipAction?.(event);
  }

  function handleDetailClose() {
    detailContent = null;
    detailPoint = null;
    detailMeta = null;
    detailPanelAnchor = null;
  }

  // Per-species stats grid — the four axes the paper reports on. Each axis
  // returns a categorical label + the raw count that classified it. The
  // uSGB axis is always the hero (accent styling), because that's the paper's
  // headline finding for any given species.
  const speciesStats = $derived.by(() => {
    const md = detailMeta?.metadata;
    if (!md) return null;
    const samples = Number(md.Sample_ID_Count);
    const countries = Number(md.Country_Count);
    const isU = parseUSGB(md) === 'Yes';
    const w = parseWestern(md);

    // Abundance
    let abundance = { name: 'Typical', detail: 'sample count' };
    if (Number.isFinite(samples)) {
      if (samples >= ABUNDANT_MIN_SAMPLES)
        abundance = { name: 'Abundant', detail: `${samples.toLocaleString()} samples` };
      else if (samples <= RARE_MAX_SAMPLES)
        abundance = { name: 'Rare', detail: `${samples} sample${samples === 1 ? '' : 's'}` };
      else abundance = { name: 'Typical', detail: `${samples.toLocaleString()} samples` };
    }

    // Geographic reach
    let reach = { name: 'Regional', detail: 'country count' };
    if (Number.isFinite(countries)) {
      if (countries >= WIDESPREAD_MIN_COUNTRIES)
        reach = { name: 'Widespread', detail: `${countries} countries` };
      else if (countries <= CONCENTRATED_MAX_COUNTRIES)
        reach = { name: 'Concentrated', detail: `${countries} country` };
      else reach = { name: 'Regional', detail: `${countries} countries` };
    }

    // Population type
    let population = { name: '—', detail: 'lifestyle context' };
    if (w === 'western') population = { name: 'Westernized', detail: 'industrialized cohort' };
    else if (w === 'nonwestern') population = { name: 'Non-Westernized', detail: 'limited industrialization' };

    // Knowledge status — hero
    const status = isU
      ? { name: 'Previously unknown (uSGB)', detail: 'Newly identified by Pasolli 2019' }
      : { name: 'Previously known', detail: 'In reference databases before this study' };

    return { abundance, reach, population, status, isUnknown: isU };
  });

  // Countries where this SGB has been reported — parsed from Country_List
  // metadata. Split into "primary" (in our curated 8-country set, clickable
  // to jump to anthromes with that country selected) and "other" (display).
  const speciesCountries = $derived.by(() => {
    const md = detailMeta?.metadata;
    if (!md) return { primary: [], other: [] };
    let v = md.Country_List;
    if (!v) return { primary: [], other: [] };
    let arr = [];
    if (Array.isArray(v)) arr = v;
    else if (typeof v === 'string') {
      try {
        const parsed = JSON.parse(v);
        arr = Array.isArray(parsed) ? parsed : v.split(',');
      } catch {
        arr = v.split(',');
      }
    }
    const uniq = Array.from(new Set(arr.map((s) => String(s).trim()).filter(Boolean)));
    const primarySet = new Set(PRIMARY_ORDER);
    const primary = [];
    const other = [];
    for (const iso of uniq) {
      if (primarySet.has(iso)) primary.push(iso);
      else other.push(iso);
    }
    // Sort primaries by our PRIMARY_ORDER, others alphabetically.
    primary.sort((a, b) => PRIMARY_ORDER.indexOf(a) - PRIMARY_ORDER.indexOf(b));
    other.sort();
    return { primary, other };
  });

  function goToAnthromes(iso3) {
    const base = import.meta.env.BASE_URL;
    const params = new URLSearchParams();
    if (iso3) params.set('country', iso3);
    const sgbId = detailMeta?.metadata?.SGB_ID;
    if (sgbId != null) params.set('highlightSGB', String(sgbId));
    const q = params.toString();
    window.location.href = `${base}src/anthromes/${q ? `?${q}` : ''}`;
  }

  const speciesPhylumColor = $derived.by(() => {
    const p = detailMeta?.phylum;
    if (!p) return null;
    return colorMapping[p] || colorMapping.Other;
  });

  // Genome meter: sqrt-scaled so 3 000-genome outliers don't crush the small
  // end. Falls back to a full bar if the dataset max isn't reported yet.
  const speciesGenomeMeter = $derived.by(() => {
    const count = Number(detailMeta?.genomeCount) || 0;
    const max = Math.max(1, Number(detailMeta?.maxGenomeCount) || 1);
    const pct = count > 0 ? Math.min(100, Math.round(100 * Math.sqrt(count) / Math.sqrt(max))) : 0;
    return { count, max, pct };
  });

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
    <NavCircle
      side="left"
      activeLabel="BIOMES"
      linkLabel="ANTHROMES →"
      linkHref={crossLinkHref}
      linkAriaLabel="Go to Anthromes"
      homeHref={import.meta.env.BASE_URL}
    />

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
          countryIso3={selectedCountryIso3}
          lifestyleColor={uiOption() === 1 && selectedCountryIso3 !== null}
          bind:rangeSource
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

        <!-- Details panel, shared by both options but placed differently:
             Option 1 renders it at the TOP (right below the controls) so the
             marker leader lines up with its title; Option 2 renders it after
             Cohort. Defined once as a snippet, rendered per option below. -->
        {#snippet detailPanel()}
          <!-- svelte-ignore a11y_click_events_have_key_events -->
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <section class="fblock detail-block" aria-live="polite" bind:this={detailPanelEl} onclick={(e) => e.stopPropagation()}>
            {#if !detailContent}
              <p class="detail-hint">Spin the disk to inspect a species.</p>
            {:else if detailMeta}
              <!-- .panel-content carries the shared panel typography (see
                   src/shared/styles.css); .detail-scroll supplies the
                   min-height:0 that lets it scroll inside the flex column
                   rather than overflow the rail. -->
              <div class="panel-content detail-scroll">
                <!-- Graphical header replaces the section title: radial mini-glyph
                     traces this leaf's ancestor path through the tree in the
                     disk's polar coordinates, next to the SGB label + lineage
                     breadcrumbs. -->
                <div class="species-graphic">
                  {#if detailMeta.glyphPath}
                    <!-- viewBox is cropped to the glyph's actual extent:
                         buildMiniGlyphPath tops out at radius 50 and the stroke
                         is 2px, so 51 + 1px breathing room = 52. Keep it fixed
                         (not per-species bounds) or the glyph would rescale as
                         you spin. -->
                    <svg class="species-glyph" viewBox="-52 -52 104 104" aria-hidden="true">
                      <path
                        d={detailMeta.glyphPath}
                        fill="none"
                        stroke={speciesPhylumColor}
                        stroke-width="2"
                        stroke-linejoin="round"
                      />
                      <circle
                        cx="0"
                        cy="0"
                        r="3"
                        fill={speciesPhylumColor}
                      />
                    </svg>
                  {/if}
                  <div class="species-ident">
                    {#if detailMeta.metadata?.SGB_ID != null}
                      <span class="species-sgb">SGB {detailMeta.metadata.SGB_ID}</span>
                    {/if}
                    {#if detailMeta.ancestors?.length}
                      <div class="lineage-chips" aria-label="Taxonomic lineage">
                        {#each detailMeta.ancestors as a, i (a.depth + '-' + a.name)}
                          {#if i > 0}<span class="lineage-sep">›</span>{/if}
                          <span
                            class="lineage-chip"
                            class:phylum={i === 1}
                            class:leaf={i === detailMeta.ancestors.length - 1}
                            style={i === 1 ? `border-color: ${speciesPhylumColor}; color: #fff;` : ''}
                          >{a.name}</span>
                        {/each}
                      </div>
                    {/if}
                  </div>
                </div>

                <!-- Genome meter: sqrt-scaled bar with the raw count called out.
                     Fill uses the phylum colour so the whole panel reads as one
                     species-brand. Ticks give quick reference for 25/50/75%. -->
                {#if speciesGenomeMeter.count > 0}
                  <div class="genome-meter">
                    <div class="gm-head">
                      <span class="gm-label">Reconstructed genomes</span>
                      <span class="gm-count">
                        {speciesGenomeMeter.count.toLocaleString()}
                        <span class="gm-max">/ {speciesGenomeMeter.max.toLocaleString()} max</span>
                      </span>
                    </div>
                    <div class="gm-track" role="img" aria-label={`${speciesGenomeMeter.count} of ${speciesGenomeMeter.max} genomes`}>
                      <div class="gm-fill" style="width: {speciesGenomeMeter.pct}%; background: {speciesPhylumColor};"></div>
                      <span class="gm-tick" style="left: 25%"></span>
                      <span class="gm-tick" style="left: 50%"></span>
                      <span class="gm-tick" style="left: 75%"></span>
                    </div>
                  </div>
                {/if}

                {#if speciesStats}
                  <!-- Four axes in a single inline row: knowledge status (hero) ·
                       abundance · geographic reach · population type. Wraps
                       to a second line if the rail is too narrow. -->
                  <div class="sp-statline">
                    <span class="sp-stat sp-stat--hero" class:sp-stat--unknown={speciesStats.isUnknown}>
                      {speciesStats.status.name}
                    </span>
                    <span class="sp-stat">
                      {speciesStats.abundance.name}<span class="sp-stat-detail"> · {speciesStats.abundance.detail}</span>
                    </span>
                    <span class="sp-stat">
                      {speciesStats.reach.name}<span class="sp-stat-detail"> · {speciesStats.reach.detail}</span>
                    </span>
                    <span class="sp-stat">
                      {speciesStats.population.name}
                    </span>
                  </div>
                {/if}

                {#if speciesCountries.primary.length || speciesCountries.other.length}
                  <div class="sp-countries">
                    <span class="sp-countries-title">
                      Reported in
                      {(speciesCountries.primary.length + speciesCountries.other.length).toLocaleString()}
                      {(speciesCountries.primary.length + speciesCountries.other.length) === 1 ? 'country' : 'countries'}
                    </span>
                    <div class="sp-country-chips">
                      {#each speciesCountries.primary as iso3 (iso3)}
                        <button
                          class="sp-country-chip sp-country-chip--primary"
                          onclick={() => goToAnthromes(iso3)}
                          title={`Open ${SHORT_LABELS[iso3] ?? iso3} on the anthromes side`}
                        >{SHORT_LABELS[iso3] ?? iso3}</button>
                      {/each}
                      {#each speciesCountries.other as iso3 (iso3)}
                        <span class="sp-country-chip sp-country-chip--muted">{iso3}</span>
                      {/each}
                    </div>
                  </div>
                {/if}

                {#if detailMeta.metadata?.SGB_ID != null}
                  <button class="sp-cta" onclick={() => goToAnthromes(null)}>
                    <span class="sp-cta-label">See this species on the anthromes map</span>
                    <span class="sp-cta-arrow" aria-hidden="true">→</span>
                  </button>
                {/if}
              </div>
            {/if}
          </section>
        {/snippet}

        {#if uiOption() === 1}
        <!-- Option 1 (Lifestyle): the eight countries split into the two
             categories the study itself assigns, each row ranked by the share
             of that country's species previously unknown to science. Selecting
             a country recolours the disk by lifestyle exclusivity; the magenta
             key only appears for a non-Westernized selection, since magenta is
             structurally absent from every Westernized country (any species
             found there is by definition in a Westernized sample). -->
        <section class="fblock">
          <div class="fblock-headrow">
            <h3 class="fblock-title">Country</h3>
            <button
              class="mini-link"
              class:active={selectedCountryIso3 === null}
              onclick={() => (selectedCountryIso3 = null)}
              aria-label="Clear country selection"
            >All</button>
          </div>
          <p class="fblock-desc">
            Select a country to lens the tree to species found in samples collected there.
            The percentage is the share of that country's bacteria species that were
            unknown to science before this study.
          </p>

          {#snippet lifestyleRow(title, blurb, rowItems)}
            <div class="ls-row">
              <div class="ls-row-head">
                <span class="ls-row-title">{title}</span>
                <span class="ls-row-desc">{blurb}</span>
              </div>
              <div class="country-row country-row--ls">
                {#each rowItems as item (item.iso3)}
                  {@const feature = countryFeatureByIso.get(item.iso3)}
                  <div class="country-cell">
                    <CountryCircle
                      iso3={item.iso3}
                      label={SHORT_LABELS[item.iso3] ?? item.iso3}
                      {feature}
                      size={150}
                      labelFontSize={19}
                      ringStroke={3.4}
                      ringStrokeSelected={5}
                      selected={selectedCountryIso3 === item.iso3}
                      dimmed={selectedCountryIso3 !== null && selectedCountryIso3 !== item.iso3}
                      onclick={() => selectCountry(item.iso3)}
                    />
                    <span class="ls-pct">{item.unknownPct}% unknown</span>
                  </div>
                {/each}
              </div>
            </div>
          {/snippet}

          {@render lifestyleRow(
            'Western',
            'Populations living with industrialized food, medicine and urban land use.',
            westernRow
          )}

          {@render lifestyleRow(
            'Non-Western',
            'Populations with limited exposure to industrialized systems and urbanized land.',
            nonWesternRow
          )}

          <!-- Reserved space: the key only resolves once a non-Westernized
               country is selected, but the slot is always present so the rail
               below it doesn't reflow on selection. -->
          <div class="ls-key" class:ls-key--on={selectedIsNonWestern} aria-live="polite">
            {#if selectedIsNonWestern}
              <span class="ls-key-item">
                <span class="ls-key-swatch" style="background:{LIFESTYLE_MAGENTA}"></span>
                Found only in non-Westernized populations
                {#if countryRowStats[selectedCountryIso3]}
                  · {countryRowStats[selectedCountryIso3].magentaPct}%
                {/if}
              </span>
              <span class="ls-key-item">
                <span class="ls-key-swatch" style="background:{LIFESTYLE_SHARED}"></span>
                Also found in Westernized populations
              </span>
            {/if}
          </div>
        </section>

        {@render detailPanel()}
        {:else if uiOption() === 2}
        <!-- Option 2 (Country): Country is the primary filter. Known/Unknown and
             Western/Non-Western are no longer standalone filter radios — they
             surface inside the country breakdown panel when a country is
             selected. -->
        <section class="fblock">
          <div class="fblock-headrow">
            <h3 class="fblock-title">Country</h3>
            <button
              class="mini-link"
              class:active={selectedCountryIso3 === null}
              onclick={() => (selectedCountryIso3 = null)}
              aria-label="Clear country selection"
            >All</button>
          </div>
          <p class="fblock-desc">Select a country to lens the tree to species found in samples collected there.</p>
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

          {#if selectedCountryIso3 && primaryCountries?.[selectedCountryIso3]}
            {@const meta = primaryCountries[selectedCountryIso3]}
            {@const s = countryStats}
            <div class="country-breakdown" aria-live="polite">
              <div class="cb-head">
                <span class="cb-label">{SHORT_LABELS[selectedCountryIso3] ?? meta.label}</span>
              </div>

              <!-- Magazine-style big-number row: samples · species · studies.
                   Each numeral sits above its label — reads as an infographic,
                   not a filter. -->
              <div class="cb-bignums">
                <div class="cb-bignum">
                  <span class="cb-bignum-value">{meta.samples_total.toLocaleString()}</span>
                  <span class="cb-bignum-label">samples</span>
                </div>
                <div class="cb-bignum">
                  <span class="cb-bignum-value">{meta.sgbs.length.toLocaleString()}</span>
                  <span class="cb-bignum-label">species (SGBs)</span>
                </div>
                <div class="cb-bignum">
                  <span class="cb-bignum-value">{meta.studies?.length ?? 0}</span>
                  <span class="cb-bignum-label">{meta.studies?.length === 1 ? 'study' : 'studies'}</span>
                </div>
              </div>

              {#if s}
                <div class="cb-split">
                  <div class="cb-split-head">
                    <span class="cb-split-title">Previously unknown to science</span>
                    <span class="cb-split-hero">{s.unknownPct}%</span>
                  </div>
                  <div class="cb-split-bar" role="img" aria-label={`${s.unknownPct}% previously unknown, ${s.knownPct}% previously known`}>
                    <span class="cb-split-fill" style="width: {s.unknownPct}%"></span>
                  </div>
                  <div class="cb-split-legend">
                    <span class="cb-split-lg cb-split-lg--unk">Unknown (uSGB) · {s.unknown.toLocaleString()}</span>
                    <span class="cb-split-lg cb-split-lg--known">Known · {s.known.toLocaleString()}</span>
                  </div>
                </div>
              {/if}

              {#if meta.sub_cohort_ids?.length}
                <div class="cb-subs">
                  <span class="cb-sub-title">Sub-cohorts</span>
                  {#each meta.sub_cohort_ids as sid}<span class="cb-sub-chip">{sid}</span>{/each}
                </div>
              {/if}
            </div>
          {/if}
        </section>

        <!-- Overlay annotation: multi-species range from the anthromes side.
             Same visual vocabulary as anthromes' range-tag so both rails
             share the "sent from the other side" pattern. -->
        {#if rangeSource}
          <section class="range-tag" aria-live="polite">
            <div class="range-tag-row">
              <span class="range-tag-badge" aria-hidden="true"></span>
              <div class="range-tag-body">
                <span class="range-tag-title">Range: {rangeSource.label}</span>
                <span class="range-tag-sub">
                  {#if rangeSource.count}{rangeSource.count} species{/if}
                  {#if rangeSource.from}{rangeSource.count ? ' · ' : ''}from {rangeSource.from}{/if}
                </span>
              </div>
              <button class="range-tag-clear" onclick={clearRange} aria-label="Clear range highlight">×</button>
            </div>
          </section>
        {/if}

        {@render detailPanel()}
        {:else if uiOption() === 3}
        <!-- Option 3 (Split): Known/Unknown and Non/Western share a row. No
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

        {@render detailPanel()}
        {:else}
        <!-- Option 4 (Prevalence): details panel on top, then two stacked blocks —
             Prevalence (population type / samples / countries) then Known/Unknown
             with two compound buttons. Same tap-to-isolate / tap-again-to-reset
             pattern; each Block A button isolates its one dimension (clearing the
             other two axes). Cohort is intentionally omitted here to give the
             details panel room. -->
        {@render detailPanel()}

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

        <!-- Known/Unknown sits below Prevalence (the details panel is above,
             rendered at the top of this branch). Option-1-only content. -->
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

        <!-- Bottom tier: phylum key (bubble cluster; area ∝ SGB count) -->
        <section class="phylum-band">
          <div class="phylum-band-head">
            <span class="phylum-band-title">Phylum</span>
            <div class="phylum-band-actions">
              <button class="mini-link" class:active={selectedPhyla.length === 0} onclick={handleSelectAll}>All</button>
            </div>
          </div>
          {#if uiOption() === 1}
            <!-- Option 1 uses the flat pill key (same vocabulary as the
                 anthromes legend) rather than the bubble pack: the disk is
                 already carrying the magenta/white lifestyle encoding, so the
                 phylum key stays a quiet filter instead of a second chart.
                 Tap to isolate, drag across to select a contiguous range. -->
            <!-- svelte-ignore a11y_no_static_element_interactions -->
            <div class="phylum-key phylum-key--pills" onpointerdown={phPointerDown}>
              {#each allPhyla as phylum, i (phylum)}
                {@const color = colorMapping[phylum] || colorMapping.Other}
                <button
                  class="phylum-dot"
                  class:active={selectedPhyla.includes(phylum)}
                  class:dim={selectedPhyla.length > 0 && !selectedPhyla.includes(phylum)}
                  data-idx={i}
                  style="background:{color}; color:{pickTextColor(color)};"
                >
                  <span>{phylum.replace(/_/g, ' ')}</span>
                </button>
              {/each}
            </div>
          {:else}
            <div class="phylum-key" bind:clientWidth={phBoxW} bind:clientHeight={phBoxH}>
              <PhylumBubbles
                bubbles={phylumBubbles}
                {selectedPhyla}
                {pickTextColor}
                width={phBoxW}
                height={phBoxH}
                minRadius={26}
                maxRadius={100}
                padding={4}
                onToggle={handleBubbleToggle}
              />
            </div>
          {/if}
        </section>
      </div>
    </div>

    <!-- Leader line: chart selection marker → details panel -->
    {#if detailContent && leaderFrom && leaderTo}
      <svg class="leader-overlay" aria-hidden="true">
        {#if uiOption() === 4}
          <!-- Option 4: details panel is at the top, so the leader runs
               horizontally from the marker to the disk-canvas edge (rail left,
               = title left − 61px rail padding), kinks up vertically, then turns
               to end in line with the panel title. -->
          <polyline
            class="leader-line"
            points="{leaderFrom.x},{leaderFrom.y} {leaderTo.x - 61},{leaderFrom.y} {leaderTo.x - 61},{leaderTo.y} {leaderTo.x - 8},{leaderTo.y}"
          />
        {:else}
          <!-- Options 1–3: the details panel sits inline in the rail, so the
               leader is a straight horizontal run from the marker to the rail edge. -->
          <line
            class="leader-line"
            x1={leaderFrom.x} y1={leaderFrom.y}
            x2={leaderTo.x - 8} y2={leaderFrom.y}
          />
        {/if}
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

  /* Prevalence circles match the standard --tier-mid select buttons — same size
     as Known/Unknown; there's enough vertical room now for full-size circles. */

  .sel-caption {
    font-size: 13px;
    line-height: 1.3;
    color: var(--muted);
    text-align: center;
  }

  /* Country picker: 4 columns × 2 rows. Cells are equal-width regardless of
     label length so the grid stays uniform. */
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

  /* Header row inside an fblock: title on the left, All/Clear link on the
     right — same visual weight as the phylum-band-head. */
  .fblock-headrow {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 15px;
    margin-bottom: 6px;
  }

  /* Range annotation tag — mirrors the anthromes-side treatment so both
     rails share the same "sent from the other side" vocabulary. */
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

  /* Bacteria Species Details enrichment header */
  .fblock-title .phylum-swatch {
    display: inline-block;
    width: 14px;
    height: 14px;
    border-radius: 50%;
    margin-right: 10px;
    vertical-align: -1px;
    border: 1.4px solid rgba(255, 255, 255, 0.85);
    box-shadow: 0 0 0 3px rgba(0, 0, 0, 0.35);
  }

  /* Species detail-card styling — the .panel-content species / lineage / genome
     meter / stat-line rules are shared with the anthromes panel; see
     src/shared/styles.css, which also documents the 16.6px type floor that both
     panels size up from. */

  /* Country breakdown — full big-number treatment by default; collapses to a
     single-line summary when a species is also being inspected (see the
     .country-breakdown--compact variant) so the rail doesn't overflow. */
  .country-breakdown {
    margin-top: 18px;
    display: grid;
    gap: 16px;
  }

  .country-breakdown--compact {
    margin-top: 10px;
    gap: 0;
  }

  .cb-oneline {
    display: flex;
    align-items: baseline;
    flex-wrap: wrap;
    gap: 8px 14px;
    padding: 6px 0;
  }

  .cb-oneline-label {
    font-size: 18px;
    font-weight: 800;
    color: #fff;
    letter-spacing: 0.02em;
  }

  .cb-oneline-nums {
    font-size: 12px;
    font-weight: 700;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--muted);
  }

  .cb-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 10px;
    flex-wrap: wrap;
  }

  .cb-label {
    font-weight: 800;
    font-size: 22px;
    letter-spacing: 0.02em;
    color: var(--fg);
  }

  .cb-summary {
    font-size: 13px;
    color: var(--muted);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    font-weight: 700;
  }

  .cb-narrative {
    margin: 0;
    font-size: 15px;
    line-height: 1.45;
    color: var(--muted);
  }

  /* High-level "big number" row — one large numeral per metric with a small
     label underneath. Magazine layout, three columns. */
  .cb-bignums {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    column-gap: 12px;
    row-gap: 6px;
    align-items: end;
    padding: 4px 0;
  }

  .cb-bignum {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 3px;
    min-width: 0;
  }

  .cb-bignum-value {
    font-size: 34px;
    font-weight: 800;
    letter-spacing: 0.005em;
    color: #fff;
    line-height: 1;
    font-variant-numeric: tabular-nums;
  }

  .cb-bignum-label {
    font-size: 11px;
    font-weight: 800;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--muted);
  }

  /* Split-bar treatment for the Known/Unknown takeaway */
  .cb-split {
    display: grid;
    gap: 6px;
    margin-top: 4px;
  }

  .cb-split-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 8px;
  }

  .cb-split-title {
    font-size: 12px;
    font-weight: 800;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--muted);
  }

  .cb-split-hero {
    font-size: 22px;
    font-weight: 800;
    color: #fff;
    line-height: 1;
    font-variant-numeric: tabular-nums;
  }

  .cb-split-bar {
    position: relative;
    height: 12px;
    border-radius: 8px;
    background: rgba(255, 255, 255, 0.10);
    overflow: hidden;
  }

  .cb-split-fill {
    display: block;
    height: 100%;
    background: #fff;
    box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.25);
  }

  .cb-split-legend {
    display: flex;
    justify-content: space-between;
    gap: 8px;
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.04em;
    color: var(--muted);
  }

  .cb-split-lg--unk { color: #fff; }
  .cb-split-lg--known { color: var(--muted); }

  /* Legacy — kept in case Option 1 revives it */
  .cb-stats {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    grid-auto-rows: max-content;
    row-gap: 14px;
    column-gap: 14px;
  }

  .cb-col {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .cb-tile {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 8px;
    padding: 9px 12px;
    border-radius: 12px;
    border: 1.6px solid rgba(255, 255, 255, 0.16);
    background: rgba(255, 255, 255, 0.04);
    min-width: 0;
  }

  .cb-tile--accent {
    border-color: rgba(255, 255, 255, 0.6);
    background: rgba(255, 255, 255, 0.08);
  }

  .cb-name {
    font-weight: 700;
    font-size: 13px;
    color: var(--fg);
    letter-spacing: 0.02em;
    line-height: 1.15;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .cb-pct {
    font-weight: 800;
    font-size: 16px;
    color: #fff;
    letter-spacing: 0.02em;
    white-space: nowrap;
  }

  .cb-cap {
    font-size: 11px;
    line-height: 1.35;
    color: var(--muted);
    letter-spacing: 0.02em;
    padding: 0 3px;
  }

  .cb-subs {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
    font-size: 11px;
  }

  .cb-sub-title {
    color: var(--muted);
    letter-spacing: 0.08em;
    text-transform: uppercase;
    font-weight: 800;
  }

  .cb-sub-chip {
    padding: 3px 9px;
    border-radius: 999px;
    background: rgba(255, 255, 255, 0.08);
    border: 1px solid rgba(255, 255, 255, 0.14);
    color: var(--fg);
    font-family: ui-monospace, 'SF Mono', Menlo, monospace;
    font-size: 11px;
  }

  /* Cohort ranked bubbles — used by Option 2 (Split) */
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
    position: relative;
    flex: 0 1 auto;
    min-height: 220px;
    max-height: 440px;
    width: 100%;
    overflow: visible;
    touch-action: none;
    user-select: none;
  }

  /* Option 1 only: flat pill key. Sized to content rather than the bubble
     pack's fixed 220–440px box, so it doesn't strand vertical space. */
  .phylum-key--pills {
    display: flex;
    flex-wrap: wrap;
    gap: 9px;
    align-content: flex-start;
    min-height: 0;
    max-height: none;
  }

  /* ===== Option 1: Western / Non-Western lifestyle rows ===== */
  .ls-row {
    display: flex;
    flex-direction: column;
    gap: 11px;
  }

  .ls-row + .ls-row {
    margin-top: 22px;
  }

  .ls-row-head {
    display: flex;
    flex-direction: column;
    gap: 3px;
  }

  .ls-row-title {
    font-size: 21px;
    font-weight: 600;
    letter-spacing: 0.01em;
  }

  .ls-row-desc {
    font-size: 16px;
    line-height: 1.3;
    opacity: 0.62;
  }

  .country-row--ls {
    gap: 16px;
  }

  /* Percentage caption under each circle. Tabular figures so the numerals in a
     row line up regardless of digit widths. */
  .ls-pct {
    display: block;
    margin-top: 7px;
    text-align: center;
    font-size: 15.5px;
    font-weight: 600;
    letter-spacing: 0.01em;
    font-variant-numeric: tabular-nums;
    opacity: 0.78;
  }

  /* Magenta key. The slot always occupies its height so selecting a country
     doesn't reflow the rail below; only the contents appear/disappear. */
  .ls-key {
    display: flex;
    flex-direction: column;
    gap: 6px;
    min-height: 52px;
    margin-top: 20px;
    opacity: 0;
    transition: opacity 0.18s ease;
  }

  .ls-key--on {
    opacity: 1;
  }

  .ls-key-item {
    display: flex;
    align-items: center;
    gap: 9px;
    font-size: 15.5px;
    line-height: 1.25;
    font-variant-numeric: tabular-nums;
  }

  .ls-key-swatch {
    flex: 0 0 auto;
    width: 26px;
    height: 4px;
    border-radius: 2px;
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

  /* .leader-line stroke lives in shared styles.css (unified with anthromes). */

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

  /* Detail-panel content typography (.panel-content .title/.subtitle/.summary/
     .detail-link/.kv/.swatch/.pill) is shared — see src/shared/styles.css. */

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
