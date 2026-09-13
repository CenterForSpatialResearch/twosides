<script>
  import { onMount, untrack } from 'svelte';
  import WaffleChart from './lib/WaffleChart.svelte';
  import CellHistoryBar from './lib/CellHistoryBar.svelte';
  import CountryTimeseriesBar from './lib/CountryTimeseriesBar.svelte';
  import PixelTimeline from './lib/PixelTimeline.svelte';
  import { prepareAnthromesData } from './lib/dataAdapter.js';
  import { loadGrid, distributionForCountry, countryTableOf } from './lib/gridSource.js';
  import { topoProfile, setTopoProfile, TOPO_PROFILES, hasProfileInfo, profileSizes } from '../shared/topoProfile.svelte.js';
  import { countrySet, boundaryUrl } from '../shared/countrySet.svelte.js';
  import { timelineMode } from '../shared/timelineMode.svelte.js';
  import { feature as topoFeature } from 'topojson-client';
  import DevHud from '../shared/DevHud.svelte';
  import NavCircle from '../shared/NavCircle.svelte';
  import CountryCircle from '../shared/CountryCircle.svelte';
  import ArcLabel from '../shared/ArcLabel.svelte';
  import { initStage, screenToDesign } from '../shared/stage.svelte.js';
  // Option numbers live in shared/uiOption.svelte.js. Comments below that say
  // "Option 1" mean the refined arrangement, which is now options 1-8 (the
  // three splash trials, final ui, country-from-map, the narrative pass, 8/21
  // and 8/14) — hence
  // refinedLayout() for anything they all share, and refined0821() for what
  // 8/21 introduced and the later passes inherit. This side's copy (the
  // country one-liner, the lifestyle rows, the details header) is not gated:
  // the final wording was written in place, so it never needs finalUi().
  import { refinedLayout, refined0821 } from '../shared/uiOption.svelte.js';

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

  // The eight primary countries, in the biomes study's lifestyle split — a
  // clean property of the country for these eight (see biomes/App.svelte).
  // The picker groups by it, in this order.
  const WESTERN_ISOS = ['SWE', 'GBR', 'USA', 'CHN'];
  const NONWESTERN_ISOS = ['MDG', 'FJI', 'PER', 'TZA'];
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

  // Country-first primary filter. Parity with biomes side. In-memory
  // only: the two sides no longer hand a selection to one another, so there is
  // nothing to seed from the URL and nothing to keep in sync with it.
  let selectedCountryIso3 = $state(null);
  let primaryCountries = $state(null);
  let countryFeatureByIso = $state(new Map()); // ISO3 -> boundary feature, all countries
  // The decoded grid for the live resolution. loadGrid is module-cached and
  // dedupes concurrent callers, so this resolves to the very object MapCanvas
  // holds — no second fetch, and no need to thread it back up through
  // WaffleChart. Same trick as the country_index.json fetch below.
  // $state.raw, not $state: the grid is a decoded blob we only ever replace
  // wholesale, and deep-proxying its typed arrays would cost far more than it
  // buys. It also keeps gridSource's reads out of Svelte's reactive graph.
  let grid = $state.raw(null);

  // The nav coin's route to the other side: plain navigation, carrying no
  // country and no species. Both sides now draw the same eight countries, and
  // that shared vocabulary — not a URL hand-off — is what carries a reader's
  // interest across. side= only tells the interstitial which copy to show.
  const crossLinkHref = `${import.meta.env.BASE_URL}loading.html?side=biomes`;

  // Drop a selection the grid cannot back — a country with no land cells at
  // this resolution. Runs once the grid arrives.
  $effect(() => {
    if (!grid || !selectedCountryIso3) return;
    if (!countryTableOf(grid).includes(selectedCountryIso3)) {
      selectedCountryIso3 = null;
    }
  });

  // Follow the resolution and country-set pickers. The guard matters because a
  // slow 50km fetch can resolve after the user has already switched back —
  // without it the map would be drawing one profile while the ring plotted
  // another. The set is checked the same way and for the same reason.
  $effect(() => {
    const wanted = topoProfile();
    const wantedSet = countrySet();
    let live = true;
    loadGrid(wanted, wantedSet)
      .then((g) => {
        if (live && g.manifest.profile === wanted && g.countrySet.key === wantedSet) grid = g;
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  });

  const selectedCountryMeta = $derived(
    selectedCountryIso3 && primaryCountries ? primaryCountries[selectedCountryIso3] : null
  );

  // The selected country's anthrome composition, computed from the grid blobs
  // already in memory rather than a precomputed file. This is what lets every
  // country have a waffle and a pixel chart instead of only the eight
  // primaries, and it tracks the resolution actually being drawn.
  // Null until the grid lands, or for a country with no land cells (Antarctica).
  const countryDistribution = $derived(
    grid && selectedCountryIso3 ? distributionForCountry(grid, selectedCountryIso3) : null
  );

  // Option 1 moves the per-year anthrome breakdown out of the details panel and
  // onto the ring itself: with a country picked, the waffle plots that
  // country's distribution instead of the world's. Null = plot the world.
  const countryRingDistribution = $derived(
    refinedLayout() && countryDistribution ? countryDistribution.distribution : null
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

  // How the details timeline apportions its rows lives in the DevHud, beside
  // the other switchable renders — see src/shared/timelineMode.svelte.js for
  // what the three modes are and PixelTimeline's rowsMode for how they draw.

  // Land cells in whatever the timeline is showing, at the drawn resolution:
  // the country's largest per-year total (years with nodata cells run a few
  // short), or the grid's land count for the world.
  const detailCellCount = $derived.by(() => {
    if (detailScale === 'country') {
      const totals = countryDistribution?.cell_totals;
      return totals ? Math.max(0, ...Object.values(totals)) : null;
    }
    return grid?.manifest?.nLand ?? null;
  });
  const detailSourceKey = $derived(
    detailScale === 'cell'
      ? `cell:${cellSeries.id}`
      : detailScale === 'country'
        ? `country:${selectedCountryIso3}`
        : 'world'
  );
  // A display name for any ISO3, not just the eight primaries. The boundary
  // features already carry properties.name for every country, which is why this
  // does not read iso3_names.json: that file is hand-maintained, has no
  // generator, and is missing France and Norway for the same reason the
  // boundaries were (see processing/5_smooth_boundaries.py).
  function countryLabel(iso3) {
    if (!iso3) return null;
    return (
      primaryCountries?.[iso3]?.label ??
      countryFeatureByIso.get(iso3)?.properties?.name ??
      iso3
    );
  }

  // Names that are plurals or descriptions rather than proper singular nouns
  // read wrong without a definite article: "of the Netherlands", not "of
  // Netherlands". Any of the 174 Natural Earth names can reach this — a map
  // click selects whatever country the cell belongs to, not just the eight in
  // the picker — so this is the full set from countries-110m.topojson, spelled
  // the abbreviated way that file spells them.
  const ARTICLE_COUNTRIES = new Set([
    'Bahamas',
    'Central African Rep.',
    'Congo',
    'Dem. Rep. Congo',
    'Dominican Rep.',
    'Falkland Is.',
    'Fr. S. Antarctic Lands',
    'Gambia',
    'Netherlands',
    'Philippines',
    'Solomon Is.',
    'United Arab Emirates',
    'United Kingdom',
    'United States of America'
  ]);

  // Pass capitalized when the name opens a sentence: "The Netherlands' ..." .
  function withArticle(label, capitalized = false) {
    if (!label || !ARTICLE_COUNTRIES.has(label)) return label;
    return `${capitalized ? 'The' : 'the'} ${label}`;
  }

  // 8/21: the panel names what it is showing rather than being labelled
  // "Details" — matching the biomes side, where the SGB name is the heading.
  // Three scales, three headings; the line underneath restates the span, and at
  // world scale says how to narrow it.
  // Final copy: the heading is the side's subheadline (the same line the splash
  // shows while this side loads) and the blurb names the scope. The cell scale
  // keeps its old lines; it is unreachable under countryFromMap().
  const detailHeading = $derived(
    detailScale === 'cell'
      ? 'Anthrome composition of a cell'
      : 'MODELING 12,025 YEARS OF LAND USE'
  );
  // World and country scale say what the panel IS — a timeline of somewhere —
  // because the chart title that used to sit above the field said the same
  // scope a second time and cost a row of its height.
  const detailBlurb = $derived(
    detailScale === 'cell'
      ? "This cell's anthrome transitions over 12,025 years:"
      : detailScale === 'country'
        ? `Anthrome timeline of ${withArticle(countryLabel(selectedCountryIso3)) ?? 'this country'}:`
        : 'Anthrome timeline of the World:'
  );

  // No title over the field at world or country scale — the line under the
  // heading carries the scope. The land-area variants behind the dev HUD's
  // TIMELINE toggle keep one, because what they have to say (how many cells the
  // rows stand for) is said nowhere else.
  const detailTitle = $derived.by(() => {
    if (detailScale === 'cell') return 'Cell history';
    if (timelineMode() !== 1 && detailCellCount != null) {
      const scope = detailScale === 'country'
        ? withArticle(countryLabel(selectedCountryIso3))
        : 'the World';
      return `${detailCellCount.toLocaleString()} cells in ${scope}`;
    }
    return '';
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

  // "2025AD" → "2025", "10000BC" → "10,000 BCE". Thousands are grouped in the
  // BCE era only: five-digit BCE dates are read as quantities and are written
  // grouped ("10,000 BCE"), while a CE year is a name and never is ("2025").
  function formatYear(yearStr) {
    if (!yearStr) return '';
    const isBCE = /(BCE?|BC)$/.test(yearStr);
    const n = parseInt(yearStr.replace(/[^\d]/g, ''), 10);
    return isBCE ? `${n.toLocaleString()} BCE` : `${n}`;
  }

  // ── Anthrome filter: click to isolate one, drag across to select a range ──
  // Displayed order = LEGEND_CATEGORIES (intensity groups); a drag selects the
  // contiguous slice between the anchor and the pill under the pointer.
  const displayedCodes = LEGEND_CATEGORIES.flatMap(c => c.codes);
  let dragging = $state(false);
  let anchorIdx = $state(null);
  // A press only becomes a drag once it reaches a DIFFERENT pill. Under the
  // 8/21 rules a press that never leaves its own pill is a CLICK, and a click
  // toggles rather than isolates — so unlike 8/14 the selection cannot be
  // committed on pointerdown.
  let dragMoved = $state(false);

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

  /**
   * One pill, clicked (8/21). Built for touch: there is no modifier key to
   * hold on a touchscreen, so the pills have to stack by themselves.
   *
   *   everything selected     -> isolate this one         (as 8/14 did)
   *   only this one selected  -> restore every anthrome    (click again = out)
   *   a subset without it     -> add it to the subset      (stacking)
   *   a subset containing it  -> drop it, falling back to "all" rather than
   *                              ever leaving an empty filter
   *
   * The next selection is rebuilt by filtering the canonical order rather than
   * by pushing, so it can never hold a duplicate — the "is everything
   * selected" test elsewhere is a length comparison and a duplicate would
   * quietly break it.
   */
  function toggleCode(code) {
    if (code == null) return;
    const all = orderedCodes.length ? orderedCodes : displayedCodes;
    if (selectedAnthromes.length === all.length) {
      selectedAnthromes = [code];
      return;
    }
    const has = selectedAnthromes.includes(code);
    if (has && selectedAnthromes.length === 1) {
      handleSelectAll();
      return;
    }
    const keep = new Set(selectedAnthromes);
    if (has) keep.delete(code);
    else keep.add(code);
    const next = all.filter((c) => keep.has(c));
    selectedAnthromes = next.length ? next : [...all];
  }

  function keyPointerDown(e) {
    const pill = e.target?.closest?.('.key-pill');
    if (!pill || pill.dataset.idx == null) return;
    e.preventDefault();
    dragging = true;
    dragMoved = false;
    anchorIdx = parseInt(pill.dataset.idx, 10);
    if (!refined0821()) selectRange(anchorIdx, anchorIdx);
    window.addEventListener('pointermove', keyPointerMove);
    window.addEventListener('pointerup', keyPointerUp, { once: true });
  }

  function keyPointerMove(e) {
    if (!dragging || anchorIdx == null) return;
    const idx = pillIdxFromPoint(e);
    if (idx == null) return;
    if (refined0821()) {
      // Staying on the anchor pill is not yet a drag; leaving it is, and from
      // then on every move sweeps the range even if it comes back.
      if (idx === anchorIdx && !dragMoved) return;
      dragMoved = true;
    }
    selectRange(anchorIdx, idx);
  }

  function keyPointerUp() {
    const idx = anchorIdx;
    const wasDrag = dragMoved;
    dragging = false;
    dragMoved = false;
    anchorIdx = null;
    window.removeEventListener('pointermove', keyPointerMove);
    if (!refined0821()) return;
    // Touching the filter at all cancels an open cell. A cell is a reading of
    // one place and a filter is a reading of the whole map, so the two cannot
    // both be the active lens — and the cell's own leader would otherwise be
    // left pointing at a cell the filter has just dimmed away.
    if (detailContent) clearCellSelection();
    if (!wasDrag) toggleCode(displayedCodes[idx]);
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

  // 8/21: isolating a cell is a fresh reading, so it restores every anthrome —
  // you can never end up inspecting a cell through a filter that hides it, and
  // the reverse move (clicking a filter) closes the cell in keyPointerUp. Keyed
  // on the cell id rather than on cellSeries identity because MapCanvas rebuilds
  // the series on every year change, and re-stating the SAME cell must not
  // reset anything.
  let lastCellId = $state(null);
  $effect(() => {
    const id = cellSeries?.id ?? null;
    untrack(() => {
      if (id === lastCellId) return;
      lastCellId = id;
      if (id != null && refined0821()) handleSelectAll();
    });
  });

  // Connector (leader line) from the isolated map cell to the docked detail panel
  let connectorStart = $state(null);
  let connectorEnd = $state(null);
  // 8/21 only: x of the vertical kink, in design px. The leader ends ON the
  // underline under the anthrome's name, which sits at the far LEFT of the
  // rail — a single diagonal to it would cut clean across the cell-history
  // chart. Turning outside the rail instead and coming in level with the
  // underline keeps the line clear of the chart from every cell position.
  // Null in every other arrangement, which draws the old straight line.
  let connectorElbowX = $state(null);
  let detailPanelEl = $state(null);
  // The swatch + anthrome-name row; the leader points at its vertical centre.
  let detailAnchorEl = $state(null);
  // 8/21: the rule under the anthrome's name — the leader's actual terminus.
  let anthromeRuleEl = $state(null);

  // Design px between the rail's inner edge and the leader's vertical kink.
  const LEADER_ELBOW_GAP = 34;

  $effect(() => {
    const start = connectorStart;
    const panel = detailPanelEl;
    const open = detailContent;
    // Recompute when the panel's contents shift under the anchor: the chart
    // appearing or resizing, or the anchor row itself
    // mounting. Under Option 1 the anchor also moves when the year changes,
    // because the anthrome name can get longer or shorter.
    barChartData; historyChartSize; detailAnchorEl; anthromeRuleEl; detailMeta;
    untrack(() => {
      if (!panel || !start || !open) {
        connectorEnd = null;
        connectorElbowX = null;
        return;
      }
      const rect = panel.getBoundingClientRect();
      // getBoundingClientRect is in screen px but the overlay draws in design px.
      const rule = refined0821() ? anthromeRuleEl : null;
      if (rule) {
        // 8/21: land on the RIGHT end of the rule under the anthrome's name —
        // the end facing the map — so the leader reads as one stroke that
        // becomes the underline of the word it is calling out.
        const rr = rule.getBoundingClientRect();
        connectorEnd = screenToDesign(rr.right, rr.top + rr.height / 2);
        connectorElbowX = screenToDesign(rect.right, 0).x + LEADER_ELBOW_GAP;
        return;
      }
      // Panel docks on the left; the leader ends at its right edge (the rail
      // seam), vertically in line with the anthrome colour + title. Older
      // arrangements have no such row, so they fall back to the chart title.
      connectorElbowX = null;
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

      // Country-picker data (parity with biomes side). The boundaries are
      // fetched by the effect below instead, since they have to be refetched
      // when the country set changes.
      try {
        const base = import.meta.env.BASE_URL;
        const pcRes = await fetch(`${base}data/primary_countries.json`);
        if (pcRes.ok) primaryCountries = await pcRes.json();
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

  // Boundary features by country id, refetched whenever the country set
  // changes. The highlight ring, the focus framing and countryLabel() all read
  // from this map, so it has to describe the same set the grid is attributing
  // cells with — mixing them leaves every dependency unresolvable.
  // MapCanvas fetches the same URL, and the browser serves the second hit from
  // cache, so this costs a parse rather than a download.
  $effect(() => {
    const set = countrySet();
    let live = true;
    (async () => {
      try {
        const res = await fetch(boundaryUrl(import.meta.env.BASE_URL, set));
        if (!res.ok || !live) return;
        const topo = await res.json();
        if (!live) return;
        const objName = Object.keys(topo.objects)[0];
        const fc = topoFeature(topo, topo.objects[objName]);
        // Every country, not just the eight in the picker: any country is
        // selectable now, and topoFeature() above already materialised all of
        // them, so the old filter only discarded references it had paid for.
        const byIso = new Map();
        for (const f of fc.features) {
          const id = f?.id ?? f?.properties?.id ?? f?.properties?.ISO_A3;
          if (id) byIso.set(id, f);
        }
        if (live) countryFeatureByIso = byIso;
      } catch (e) {
        console.warn('Failed to load country boundaries', e);
      }
    })();
    return () => {
      live = false;
    };
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
    if (prev == null) return;
    if (waffleChartRef?.zoomToScale) waffleChartRef.zoomToScale(prev);
    else zoomLevel = prev;
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
    // Reset drops the country picker too. Under Option 1 a country selection is
    // no longer a side note in the details panel: it holds the highlight, the
    // framing AND the ring's distribution, so leaving it behind would not be a
    // reset. Clearing it here is what makes the ring animate back to the world.
    // The older arrangements kept the picker (reset = "view reset" only).
    if (refinedLayout()) selectedCountryIso3 = null;
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
    // The camera snap-back is not done here: see the deselect effect below,
    // which owns it for every route out of a country.
  }

  // Losing the country returns the map to the world, wherever the deselect came
  // from: the picker toggling the same globe off, a map click on the ocean, or
  // a map click on the already-selected country. MapCanvas deliberately leaves
  // that decision to App (see the note above applyFocusFraming) and its two map
  // routes only null focusIso3 through the binding, so an effect on the value —
  // rather than a call in each handler — is what makes them all agree.
  //
  // Only the camera resets. Filters, the year and the range overlay are the
  // user's, not the country's, and dropping a country is not a reset of them;
  // Reset is the control that clears everything.
  let lastFocusedIso3 = null;
  $effect(() => {
    const iso3 = selectedCountryIso3;
    if (iso3) {
      lastFocusedIso3 = iso3;
      return;
    }
    if (!lastFocusedIso3) return;
    lastFocusedIso3 = null;
    untrack(() => {
      mapPanX = 0;
      mapPanY = 0;
      zoomLevel = 1;
    });
  });

  // Clear anything left over from a per-cell isolation so the Details dock
  // can fall back to the country view (or the default hint).
  function clearCellSelection() {
    detailContent = null;
    detailMeta = null;
    barChartData = null;
    showBarChart = false;
    isolationReset++;
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
  <!-- Blank overlay: users arrive via loading.html, which already showed the
       loading UI for a fixed window. Keep the overlay so the background stays
       continuous, but drop the "Loading anthromes data..." / "Rendering map..."
       text — a second, differently-worded loading screen immediately after the
       first reads as a stall rather than as progress. -->
  {#if loading || (!mapReady && initialLoad)}
    <div class="loading-overlay" aria-hidden="true"></div>
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
        <div class="control-circles" class:control-circles--arced={refinedLayout()}>
          <div class="ctl-slot">
            <button class="ctl-btn" title="Info" aria-label="Info" class:active={openPanel === 'info'} onclick={() => openPanel = openPanel === 'info' ? null : 'info'}>i</button>
            {#if refinedLayout()}<ArcLabel text="Info" side="left" />{/if}
          </div>
          <div class="ctl-slot">
            <button class="ctl-btn" title="Zoom out" aria-label="Zoom out" onclick={zoomOut} disabled={zoomLevel <= ZOOM_LEVELS[0]} aria-disabled={zoomLevel <= ZOOM_LEVELS[0]}>−</button>
            {#if refinedLayout()}<ArcLabel text="Zoom Out" side="left" />{/if}
          </div>
          <div class="ctl-slot">
            <button class="ctl-btn" title="Reset" aria-label="Reset" onclick={resetView}>◎</button>
            {#if refinedLayout()}<ArcLabel text="Reset" side="left" />{/if}
          </div>
          <div class="ctl-slot">
            <button class="ctl-btn" title="Zoom in" aria-label="Zoom in" onclick={zoomIn} disabled={zoomLevel >= ZOOM_LEVELS[ZOOM_LEVELS.length - 1]} aria-disabled={zoomLevel >= ZOOM_LEVELS[ZOOM_LEVELS.length - 1]}>＋</button>
            {#if refinedLayout()}<ArcLabel text="Zoom In" side="left" />{/if}
          </div>
        </div>

        <!-- Country picker (parity with biomes side): the eight countries in
             the two lifestyle groups the biomes study assigns, each led by its
             description, so the same eight read the same way on both faces. -->
        <section class="fblock">
          <div class="fblock-headrow">
            <h3 class="menu-oneliner">Global land use patterns resolve differently when viewed within national borders.</h3>
            <button
              class="mini-link"
              class:active={selectedCountryIso3 === null}
              onclick={clearCountrySelection}
              aria-label="Clear country selection"
            >All</button>
          </div>

          {#snippet lifestyleRow(title, blurb, isos)}
            <div class="ls-row">
              <div class="ls-row-head" aria-label={title}>
                <span class="ls-row-desc">{blurb}</span>
              </div>
              <div class="country-row">
                {#each isos as iso3 (iso3)}
                  {@const feature = countryFeatureByIso.get(iso3)}
                  <div class="country-cell">
                    <CountryCircle
                      {iso3}
                      label={SHORT_LABELS[iso3] ?? iso3}
                      {feature}
                      size={150}
                      labelFontSize={19}
                      ringStroke={3.4}
                      ringStrokeSelected={5}
                      selected={selectedCountryIso3 === iso3}
                      dimmed={selectedCountryIso3 !== null && selectedCountryIso3 !== iso3}
                      onclick={() => selectCountry(iso3)}
                    />
                  </div>
                {/each}
              </div>
            </div>
          {/snippet}

          {@render lifestyleRow(
            'Westernized',
            'Populations with more exposure to urbanization, industrialized food and medicine:',
            WESTERN_ISOS
          )}
          {@render lifestyleRow(
            'Non-Westernized',
            'Populations with limited exposure to urbanization and industrialized systems:',
            NONWESTERN_ISOS
          )}
        </section>

        <!-- Middle: always-visible details menu item, where Views used to be -->
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <section class="detail-dock" aria-live="polite" bind:this={detailPanelEl} onclick={(e) => e.stopPropagation()}>
          {#if refined0821()}
            <h3 class="menu-title detail-heading">{detailHeading}</h3>
            <p class="rail-leadin">{detailBlurb}</p>
          {:else}
            <h3 class="menu-title">Details</h3>
            <p class="menu-desc">
              {#if detailContent}
                This cell's transitions through 12 025 years{selectedCountryMeta ? ` within ${withArticle(selectedCountryMeta.label)}` : ''}.
              {:else if selectedCountryMeta}
                Anthrome composition of {withArticle(selectedCountryMeta.label)} across 12 025 years.
              {:else if refinedLayout()}
                Anthrome composition of the whole world across 12 025 years.
                Pick a country or a cell to narrow it.
              {:else}
                Select a country above, or click a cell on the map.
              {/if}
            </p>
          {/if}
          <div class="detail-body">
            {#if refinedLayout()}
              <!-- Option 1: the panel is never empty. World, country and cell
                   are three scales of one chart, so they share a single slot —
                   which is also what lets the swap between them animate: the
                   component instance survives, sees its sourceKey change, and
                   drains/refills in place. The header above and the cell's
                   tooltip text below update immediately; only the field
                   animates, exactly as the ring does. -->
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
                    {#if refined0821()}
                      <!-- 8/21: the leader calls the anthrome out BY NAME, so
                           the name carries its own rule and the line lands on
                           that rule's right end. Stacking the rule under the
                           text in a column makes it exactly as wide as the
                           word, however long the word turns out to be. -->
                      <span class="detail-name">
                        <span>{detailMeta.label}</span>
                        <span class="detail-name-rule" bind:this={anthromeRuleEl}></span>
                      </span>
                    {:else}
                      <span>{detailMeta.label}</span>
                    {/if}
                  </div>
                {/if}
                {#if detailContent}
                  <div class="panel-content" onclick={handleDetailPanelClick}>
                    {@html detailContent}
                  </div>
                {/if}
              {/if}

              <div class="history-chart-section history-chart-section--fill" bind:this={historyChartEl}>
                {#if detailTitle}
                  <div class="history-chart-title">{detailTitle}</div>
                {/if}
                <div class="pixel-chart-box" bind:this={pixelChartEl}>
                  <PixelTimeline
                    mode={detailScale === 'cell' ? 'ladder' : 'stack'}
                    distribution={detailScale === 'country'
                      ? countryDistribution?.distribution ?? worldDistribution
                      : worldDistribution}
                    series={cellSeries?.byYear ?? null}
                    sourceKey={detailSourceKey}
                    rowsMode={timelineMode()}
                    cellCount={detailCellCount}
                    {colorMapping}
                    {labelMapping}
                    {orderedCodes}
                    families={LEGEND_CATEGORIES}
                    {selectedYear}
                    onSelectYear={(y) => (selectedYear = y)}
                    selectedCodes={refined0821() ? selectedAnthromes : null}
                    scrubbable={refined0821()}
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
                    <span class="detail-within">within {withArticle(selectedCountryMeta.label)}</span>
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
            {:else if selectedCountryMeta && countryDistribution}
              <div class="detail-subhead">
                <span class="country-badge">{selectedCountryMeta.label}</span>
                <span class="country-meta">{selectedCountryMeta.samples_total.toLocaleString()} samples · {selectedCountryMeta.sgbs.length.toLocaleString()} species</span>
              </div>
              <div class="history-chart-section" bind:this={historyChartEl}>
                <div class="history-chart-title">Anthrome timeline</div>
                <CountryTimeseriesBar
                  data={countryDistribution}
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
            <!-- Headline says what an anthrome IS; the line under it says what
                 the numbers in the pills are a share OF. The year moved out of
                 the headline and into that line, where it belongs with the
                 percentages it qualifies. Set as .menu-oneliner so this
                 bottom-tier headline reads in the same voice as the biomes
                 phylum key opposite it. -->
            <span class="menu-oneliner anthrome-key-title">Anthromes are patterns of human habitation and land use.</span>
            <div class="anthrome-key-actions">
              <button class="mini-link" class:active={selectedAnthromes.length === orderedCodes.length} onclick={handleSelectAll}>All</button>
            </div>
          </div>
          <p class="rail-leadin key-scope">Anthrome share in {formatYear(selectedYear)}:</p>
          <div class="key-legend">
            <div class="key-axis" aria-hidden="true">
              <span class="key-axis-label">more intensive anthromes</span>
            </div>
            <!-- svelte-ignore a11y_no_static_element_interactions -->
            <div class="key-swatches" onpointerdown={keyPointerDown}>
              <!-- Two grid columns, not six stacked blocks: the category name
                   sits beside its pills instead of on a line of its own, which
                   is six lines of height the timeline above gets back. -->
              {#each LEGEND_CATEGORIES as category}
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
          countryDistribution={countryRingDistribution}
          strictCountryFocus={refinedLayout()}
          compactCellDetail={refinedLayout()}
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
        <div class="overlay-title">ANTHROMES</div>
        <button class="chevron" onclick={() => openPanel = null} aria-label="Close">✕</button>
      </div>
      <div class="detail-body">
        <div class="info-body">
          <p><strong>More than 65% of terrestrial nature</strong> has been shaped, in very different ways, by people. <strong>Anthromes</strong> are defined as the global ecological patterns shaped by direct human interactions with ecosystems.</p>
          <p>Visualized here is the <strong>Anthromes Dataset</strong> from the Anthroecology Lab. It is a “hindcast” model, projecting back in time from global population and land use data showing change over 12,025 years.</p>
          <p>As global population increases, and urbanization accelerates, <strong>biodiversity shrinks.</strong> Hence, preserving “cultured” and “wild” lands is key to preserving biodiversity.</p>

          <div class="info-citations">
            <div class="info-citations-title">Citations</div>
            <p>Ellis, E.C., N. Gauthier, K. Klein Goldewijk, R. Bliege Bird, N. Boivin, S. Díaz, D. Fuller, J. Gill, J. Kaplan, N. Kingston, H. Locke, C. McMichael, D. Ranco, T. Rick, M.R. Shaw, L. Stephens, J.C. Svenning, and J.E.M. Watson. 2021. “People have shaped most of terrestrial nature for at least 12,000 years.” <em>Proceedings of the National Academy of Sciences</em> 118(17): e2023483118. <a href="https://doi.org/10.1073/pnas.2023483118" target="_blank" rel="noopener">https://doi.org/10.1073/pnas.2023483118</a></p>
            <p>Klein Goldewijk, K. 2025. History Database of the Global Environment (HYDE 3.5). Utrecht University. <a href="https://public.yoda.uu.nl/geo/UU01/F45D44.html" target="_blank" rel="noopener">https://public.yoda.uu.nl/geo/UU01/F45D44.html</a></p>
            <p>This project was completed by Laura Kurgan, Dan Miller and Adam Vosburgh at The Center for Spatial Research, Columbia University Graduate School of Architecture Planning and Preservation. Two Sides of the Same Coin was originally commissioned for the We the Bacteria: Notes Toward Biotic Architecture exhibition, 24th Milan Triennale International Exhibition, Inequalities, 2025. This project is open-source, and the repository is located <a href="https://github.com/CenterForSpatialResearch/twosides" target="_blank" rel="noopener">here</a>.</p>
          </div>
        </div>
      </div>
    </div>
  {/if}

  <!-- Leader line: isolated cell → docked detail panel. Endpoints are design px.
       White arrowhead on the map (cell) side, matching the biomes disk marker.
       Gated on cell scale because WaffleChart dispatches 'detail' on hover, not
       only on pin, so without this a line is drawn during an ordinary mouse
       move — pointing at the chart title, since anthromeRuleEl is null outside
       cell scale. -->
  {#if detailScale === 'cell' && detailContent && connectorStart && connectorEnd}
    <svg class="connector-overlay" aria-hidden="true">
      <defs>
        <marker id="leader-arrow" markerUnits="userSpaceOnUse"
                markerWidth="18" markerHeight="18" refX="16" refY="9"
                orient="auto-start-reverse">
          <path d="M0,0 L16,9 L0,18 Z" fill="#fff"></path>
        </marker>
      </defs>
      {#if connectorElbowX != null}
        <!-- 8/21: cell → level run out to the kink just outside the rail →
             down/up to the underline's height → in to the underline's right
             end. The kink is clamped so it can never sit right of the cell,
             which would fold the first segment back on itself. -->
        {@const elbowX = Math.min(connectorElbowX, connectorStart.x)}
        <polyline
          class="leader-line"
          marker-start="url(#leader-arrow)"
          points="{connectorStart.x},{connectorStart.y} {elbowX},{connectorStart.y} {elbowX},{connectorEnd.y} {connectorEnd.x},{connectorEnd.y}"
        ></polyline>
      {:else}
        <line
          class="leader-line"
          marker-start="url(#leader-arrow)"
          x1={connectorStart.x} y1={connectorStart.y}
          x2={connectorEnd.x} y2={connectorEnd.y}
        ></line>
      {/if}
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
  /* Rail rhythm: 28px of visible space above and below every divider, the same
     as the biomes rail (whose country panel mirrors this one, so the details
     titles under them — "MODELING 12,025 YEARS…" here, "5000 LINES…" there —
     land at the same height). The chart below takes whatever is left.
     The two values differ because what the eye measures is ink, not boxes:
     a 27px headline carries ~6px of empty line box above its letters, and the
     blocks above a divider end ~4px of box below their last ink. So
     margin = 28 - 4 and padding = 28 - 6. The top divider sits under the
     control circles, whose box ends on the ink; .control-circles--arced pays
     that 4px back as padding. */
  .filter-rail > * + * {
    border-top: 1.3px solid rgba(255, 255, 255, 0.14);
    margin-top: 24px;
    padding-top: 22px;
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
    padding-bottom: 4px;    /* see the rail rhythm note above */
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
    font-weight: 500;
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
  /* `0 0 auto`, not `0 1 auto`: the key is sized to its content and the details
     dock above it takes whatever is left, so there is nothing for shrinking to
     buy — and shrinking is what put a scrollbar on it. The content fitted its
     box to the pixel, so on any display where the stage scale is not exactly 1
     the flex distribution rounded the box a fraction under the content and
     .key-legend's overflow:auto showed a bar. The max-height still bounds it,
     and the overflow is still there as the valve if the key ever hits it. */
  .anthrome-key {
    flex: 0 0 auto;
    display: flex;
    flex-direction: column;
    gap: 10px;
    min-height: 0;
    max-height: 40%;
  }

  .anthrome-key-head {
    display: flex;
    /* Baseline, not centre: the headline wraps to two lines and `center`
       floated "All" between them. Mirrors .fblock-headrow above. */
    align-items: baseline;
    justify-content: space-between;
    gap: 15px;
  }

  /* Type comes from .menu-oneliner; this only claims the row's free width so
     the headline wraps inside it and "All" stays pinned right. */
  .anthrome-key-title {
    flex: 1 1 auto;
    min-width: 0;
  }

  /* Rail lead-in: the line under a section head that names what the block
     under IT shows — the country panel's two row descriptions, the details
     subhead, the key's share line. One treatment for all of them so a reader
     learns it once: full white at 19px rather than muted body copy, because
     these lines are part of the rail's structure and not commentary on it, and
     each ends in a colon because each introduces what follows. Same values as
     .ls-row-desc below, which is this same voice inside the country panel. */
  .rail-leadin {
    margin: 0;
    font-size: 19px;
    line-height: 1.32;
    color: #fff;
  }

  /* The share line hugs the headline it qualifies rather than sitting midway
     between it and the legend, so the three parts read as heading, caption,
     key — not as three evenly spaced bands. */
  .key-scope {
    margin-top: -4px;
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
    font-weight: 500;
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

  /* Eight rows of pills under six category heads, and the whole thing has to
     fit the rail's bottom slot without a scrollbar — on the target display it
     fitted to the pixel, so at any other scale the rounding tipped it into
     scrolling. The gaps below are what pays for the headroom; the pills keep
     their type size, since the key is read from across a room. */
  /* One grid row per category: name on the left, its pills on the right.
     The name column is a FIXED width, so all six names start on the same left
     edge and the pill rows all start on the same one too — the column reads as
     a single list of headings rather than six of different lengths. 116px is
     the longest word in the set ("SETTLEMENTS", 110px) plus slack; "Dense
     Settlements" is the one name that wraps, onto two lines, which is what the
     min-height on the name below is sized for. */
  .key-swatches {
    flex: 1;
    min-width: 0;
    display: grid;
    grid-template-columns: 116px minmax(0, 1fr);
    /* 12px between categories against 4px between a category's own wrapped
       rows (below): with the name beside the first row rather than above the
       group, that ratio is what tells the eye a second row of pills belongs to
       the name on its left and not to the one underneath. */
    gap: 12px 14px;
    align-content: start;
  }

  .key-cat-name {
    /* Top of its row, not centred in it: a category whose pills wrap to two
       rows should still have its name beside the FIRST row. min-height is one
       pill row, so a name is centred on the pills it labels — and at
       line-height 1.2 the two lines of "Dense Settlements" come to 33.6px,
       inside that same row, so the wrap costs no height. */
    align-self: start;
    display: flex;
    align-items: center;
    min-height: 34px;
    font-size: 14px;
    font-weight: 500;
    line-height: 1.2;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--muted);
  }

  .key-pills {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 6px;
    align-items: center;
  }

  /* Pill sizes to its label; colour = anthrome, tap to isolate / drag to range-select */
  .key-pill {
    display: inline-flex;
    align-items: center;
    height: 34px;
    padding: 0 13px;
    border-radius: 10px;
    border: 1.3px solid rgba(0, 0, 0, 0.18);
    font-size: 14px;
    font-weight: 500;
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

  /* Country picker: one row of 4 per lifestyle group. Cells are equal-width
     regardless of label length so the grid stays uniform. Mirrors biomes side.
     The circles, labels, head and headrow are all identical to that side; the
     one thing this side does not carry is the "{n}% unknown" caption under
     each globe, which is 20.8px of biomes' rows at 14px. The padding here and
     the gap between the two groups below spend that height as air instead, so
     the two country panels stay the same height and the details titles under
     them ("MODELING 12,025 YEARS…" here, "5000 LINES…" there) stay level.
     24.3 rather than a round number: it also absorbs the 3px more that the
     biomes control row pays back under its arc labels (see the rail rhythm
     note), which is what lands both titles on the same y. */
  .country-row {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    grid-auto-rows: max-content;
    row-gap: 22px;
    column-gap: 12px;
    justify-items: center;
    align-items: start;
    padding-top: 24.3px;
  }

  .country-cell {
    display: flex;
    justify-content: center;
    width: 100%;
    min-width: 0;
  }

  .fblock-headrow {
    display: flex;
    /* Baseline, so "All" sits on the first line of the wrapped one-liner
       headline rather than floating between its two lines. Mirrors biomes. */
    align-items: baseline;
    justify-content: space-between;
    gap: 15px;
    margin-bottom: 8px;     /* mirrors the biomes rail */
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

  /* The details section's head ("MODELING 12,025 YEARS OF LAND USE") is set in
     the section-headline voice, the same as .menu-oneliner below and as
     "5000 LINES 5000 SPECIES" opposite it. Its own rule rather than that class,
     because .menu-oneliner claims flex-grow and this sits in a column. */
  .detail-heading {
    font-size: 27px;
    font-weight: 700;
    line-height: 1.28;
    letter-spacing: 0.005em;
  }

  .menu-desc {
    margin: 0;
    font-size: 16.6px;
    line-height: 1.45;
    color: var(--muted);
  }

  /* Section one-liner: the same voice and size as the biomes rail's
     .fblock-oneliner, so the two faces' section heads read as one design. */
  .menu-oneliner {
    margin: 0;
    flex: 1 1 auto;
    min-width: 0;
    font-size: 27px;
    font-weight: 700;
    line-height: 1.28;
    letter-spacing: 0.005em;
    color: var(--fg);
  }

  /* The country section's column rhythm: the same as the biomes .fblock, so
     the two country panels are the same height and the details titles under
     them land at the same y. */
  .fblock {
    display: flex;
    flex-direction: column;
    gap: 17px;
    min-width: 0;
  }

  /* Lifestyle rows in the country picker — mirrors biomes' promoted row head:
     the description IS the row head, full white, sized as a lead-in. */
  .ls-row {
    display: flex;
    flex-direction: column;
    gap: 9px;
  }

  .ls-row + .ls-row {
    margin-top: 36px;       /* biomes' 20px + its share of the caption line */
  }

  .ls-row-head {
    display: flex;
    flex-direction: column;
    gap: 3px;
  }

  .ls-row-desc {
    font-size: 19px;
    line-height: 1.32;
    color: #fff;
  }

  /* Selected-cell subheading (swatch + anthrome name) inside the details body */
  .detail-subhead {
    display: inline-flex;
    align-items: center;
    gap: 10px;
    font-size: 19px;
    font-weight: 500;
    letter-spacing: 0.02em;
    color: #fff;
  }

  /* 8/21: the anthrome name is what the leader points at, so it gets a rule
     the line can terminate on. Column layout hands the rule the text's exact
     width; the colour and weight match .leader-line so the dashed run and the
     solid underline read as one stroke. */
  .detail-name {
    display: inline-flex;
    flex-direction: column;
    align-items: stretch;
    gap: 4px;
    min-width: 0;
  }

  .detail-name-rule {
    height: 1.9px;
    background: rgba(255, 255, 255, 0.5);
  }

  /* The rule makes the name taller than the swatch, so centring the row would
     ride the swatch up off the text. Pin both to the top instead and drop the
     swatch by half the leading. */
  .detail-subhead:has(.detail-name) {
    align-items: flex-start;
  }

  .detail-subhead:has(.detail-name) .overlay-swatch {
    margin-top: 3px;
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
    width: 960px;             /* a comfortable measure at 17px, ~75 chars */
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
    font-weight: 500;
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
    font-size: 23px;
    font-weight: 500;
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
    font-size: 17px;
    color: var(--muted);
    line-height: 1.5;
    display: flex;
    flex-direction: column;
    gap: 11px;              /* tighter than biomes' — no slack on this side */
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
     .kv/.swatch/.pill) is shared — see src/shared/styles.css. */

  .info-body {
    display: grid;
    gap: 13px;
    font-size: 17px;
    line-height: 1.55;
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

  .info-citations {
    margin-top: 18px;
    padding-top: 13px;
    border-top: 1.3px solid rgba(255, 255, 255, 0.08);
  }

  .info-citations-title {
    font-size: 12px;
    font-weight: 500;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--muted);
    margin-bottom: 7.7px;
  }

  .info-citations p {
    font-size: 14px;
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
    font-weight: 500;
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
