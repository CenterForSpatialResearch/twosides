<script>
  import { onMount, untrack } from 'svelte';
  import WaffleChart from './lib/WaffleChart.svelte';
  import PixelTimeline from './lib/PixelTimeline.svelte';
  import { prepareAnthromesData } from './lib/dataAdapter.js';
  import { loadGrid, distributionForCountry, countryTableOf } from './lib/gridSource.js';
  import { MAP_PROFILE, COUNTRY_SET, boundaryUrl } from '../shared/mapProfile.js';
  import { feature as topoFeature } from 'topojson-client';
  import NavCircle from '../shared/NavCircle.svelte';
  import CountryCircle from '../shared/CountryCircle.svelte';
  import ControlBar from '../shared/ControlBar.svelte';
  import InfoModal from '../shared/InfoModal.svelte';
  import { initStage, screenToDesign, layout } from '../shared/stage.svelte.js';
  import { railTier, readTierOverride, readFillOverride, readFiveOverride, RAIL_FILL, TOP_BAR } from '../shared/railTiers.js';

  // The fixed design canvas; everything below is authored in design px inside it.
  let stageEl = $state(null);
  $effect(() => {
    if (!stageEl) return;
    return initStage(stageEl);
  });

  // How much the rail has to give up at this window size: circle sizes, one row
  // of eight or two of four, spacing, whether it scrolls. See railTiers.js.
  const tierOverride = readTierOverride(globalThis.location?.search);
  const railFill = readFillOverride(globalThis.location?.search) ?? RAIL_FILL;
  const fiveOverride = readFiveOverride(globalThis.location?.search);
  const tier = $derived(
    railTier('anthromes', layout.railW, layout.railH, tierOverride, { large: layout.large, five: fiveOverride })
  );

  // What the rail holds, and in what order, per layout. The stacked (phone)
  // layout leads with the details because they sit right under the disk, and
  // has no 'controls': there they are a bar above the disk instead (see the
  // markup). It has no 'country' either — the picker is dropped on a phone; a
  // tap on the map still selects a country, and a second tap, the ocean or
  // Reset lets it go. Adding or dropping a menu is adding or deleting its id.
  const SECTIONS = {
    wide: ['controls', 'country', 'details', 'key'],
    stacked: ['details', 'key']
  };
  const sections = $derived(SECTIONS[layout.stacked ? 'stacked' : 'wide']);

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
  let mapReady = $state(false);
  let initialLoad = $state(true);
  let zoomLevel = $state(1);
  let rotation = $state(0);
  let mapPanX = $state(0);
  let mapPanY = $state(0);
  let waffleChartRef = $state(null);

  // Filter rail state
  let openPanel = $state(null); // 'info' | null

  // The eight primary countries, in the biomes study's lifestyle split — a
  // clean property of the country for these eight (see biomes/App.svelte).
  // The picker groups by it, in this order.
  const WESTERN_ISOS = ['SWE', 'GBR', 'USA', 'CHN'];
  const NONWESTERN_ISOS = ['MDG', 'FJI', 'PER', 'TZA'];
  // On a large window each group gains a fifth country, set in the middle of
  // its row (tier.perGroup, see railTiers.js). Italy is Westernized throughout
  // the biomes study. Mongolia is the one country it samples under both labels
  // (agro-pastoral herders and Ulaanbaatar); the biomes side draws only the
  // herders' cohort, which is what files it in this group.
  const FIFTH_WESTERN = 'ITA';
  const FIFTH_NONWESTERN = 'MNG';
  const withFifth = (isos, extra) => [...isos.slice(0, 2), extra, ...isos.slice(2)];
  const westernIsos = $derived(
    tier.perGroup === 5 ? withFifth(WESTERN_ISOS, FIFTH_WESTERN) : WESTERN_ISOS
  );
  const nonWesternIsos = $derived(
    tier.perGroup === 5 ? withFifth(NONWESTERN_ISOS, FIFTH_NONWESTERN) : NONWESTERN_ISOS
  );
  const SHORT_LABELS = {
    SWE: 'Sweden',
    GBR: 'UK',
    USA: 'USA',
    CHN: 'China',
    ITA: 'Italy',
    MNG: 'Mongolia',
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
  // WaffleChart.
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

  // The grid the ring plots from. One fetch, one resolution, one boundary set —
  // both are pinned (see shared/mapProfile.js), so there is no switch to race
  // against. The identity checks stay: they are what guarantees the ring is
  // plotting the same blobs the map drew.
  $effect(() => {
    let live = true;
    loadGrid(MAP_PROFILE, COUNTRY_SET)
      .then((g) => {
        if (live && g.manifest.profile === MAP_PROFILE && g.countrySet.key === COUNTRY_SET) grid = g;
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

  // The per-year anthrome breakdown lives on the ring rather than in the
  // details panel: with a country picked, the waffle plots that country's
  // distribution instead of the world's. Null = plot the world.
  const countryRingDistribution = $derived(
    countryDistribution ? countryDistribution.distribution : null
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
  // Netherlands". Any of the 242 Natural Earth 50m names can reach this — a
  // map click selects whatever country the cell belongs to, not just the eight
  // in the picker — so this is the full set from countries-50m.topojson, the
  // pinned set (see shared/mapProfile.js), spelled the abbreviated way that
  // file spells them. Dev's copy lists only the 110m names.
  const ARTICLE_COUNTRIES = new Set([
    'Ashmore and Cartier Is.',
    'Bahamas',
    'Br. Indian Ocean Ter.',
    'British Virgin Is.',
    'Cayman Is.',
    'Central African Rep.',
    'Comoros',
    'Congo',
    'Cook Is.',
    'Dem. Rep. Congo',
    'Dominican Rep.',
    'Faeroe Is.',
    'Falkland Is.',
    'Fr. S. Antarctic Lands',
    'Gambia',
    'Heard I. and McDonald Is.',
    'Indian Ocean Ter.',
    'Isle of Man',
    'Maldives',
    'Marshall Is.',
    'N. Mariana Is.',
    'Netherlands',
    'Philippines',
    'Pitcairn Is.',
    'Seychelles',
    'Solomon Is.',
    'Turks and Caicos Is.',
    'U.S. Virgin Is.',
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
  // keeps its old lines; it is unreachable, since a map click selects the
  // country.
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
  // heading carries the scope.
  const detailTitle = $derived(detailScale === 'cell' ? 'Cell history' : '');

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
  let historyChartW = $state(340);

  // The timeline's cell size on the display this was drawn for: the rail's 878px
  // of content over its 76 year-columns. PixelTimeline holds its cells near
  // this in a wider rail by splitting each year into more cells across.
  const TIMELINE_CELL = 878 / 76;

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
    window.addEventListener('pointermove', keyPointerMove);
    window.addEventListener('pointerup', keyPointerUp, { once: true });
    window.addEventListener('pointercancel', keyPointerCancel, { once: true });
  }

  // Stacked, a vertical swipe that starts on a pill scrolls the page (the
  // pills are touch-action: pan-y there) and the browser cancels the pointer:
  // that is a scroll, not a click, so nothing is toggled.
  function keyPointerCancel() {
    dragging = false;
    dragMoved = false;
    anchorIdx = null;
    window.removeEventListener('pointermove', keyPointerMove);
    window.removeEventListener('pointerup', keyPointerUp);
  }

  function keyPointerMove(e) {
    if (!dragging || anchorIdx == null) return;
    const idx = pillIdxFromPoint(e);
    if (idx == null) return;
    // Staying on the anchor pill is not yet a drag; leaving it is, and from
    // then on every move sweeps the range even if it comes back.
    if (idx === anchorIdx && !dragMoved) return;
    dragMoved = true;
    selectRange(anchorIdx, idx);
  }

  function keyPointerUp() {
    const idx = anchorIdx;
    const wasDrag = dragMoved;
    dragging = false;
    dragMoved = false;
    anchorIdx = null;
    window.removeEventListener('pointermove', keyPointerMove);
    window.removeEventListener('pointercancel', keyPointerCancel);
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

  // Isolating a cell is a fresh reading, so it restores every anthrome —
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
      if (id != null) handleSelectAll();
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

  // The rail scrolls in its smallest tier, and the leader's terminus scrolls
  // with it: the effect below re-measures on every scroll, and drops the line
  // while the row it points at is outside the rail's visible box.
  let railEl = $state(null);
  let railScrollTick = $state(0);

  function inRailView(y) {
    if (!railEl) return true;
    const r = railEl.getBoundingClientRect();
    return y >= r.top && y <= r.bottom;
  }

  $effect(() => {
    const start = connectorStart;
    const panel = detailPanelEl;
    const open = detailContent;
    // Recompute when the panel's contents shift under the anchor: the chart
    // appearing or resizing, or the anchor row itself
    // mounting. Under Option 1 the anchor also moves when the year changes,
    // because the anthrome name can get longer or shorter.
    barChartData; detailAnchorEl; anthromeRuleEl; detailMeta;
    railScrollTick; tier; layout.scale;
    untrack(() => {
      if (!panel || !start || !open) {
        connectorEnd = null;
        connectorElbowX = null;
        return;
      }
      const rect = panel.getBoundingClientRect();
      // getBoundingClientRect is in screen px but the overlay draws in design px.
      const rule = anthromeRuleEl;
      if (rule) {
        // Land on the RIGHT end of the rule under the anthrome's name —
        // the end facing the map — so the leader reads as one stroke that
        // becomes the underline of the word it is calling out.
        const rr = rule.getBoundingClientRect();
        if (!inRailView(rr.top + rr.height / 2)) {
          connectorEnd = null;
          connectorElbowX = null;
          return;
        }
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
      if (!inRailView(ar.top + ar.height / 2)) {
        connectorEnd = null;
        return;
      }
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

  // Boundary features by country id. The highlight ring, the focus framing and
  // countryLabel() all read from this map, so it has to describe the same set
  // the grid is attributing cells with — mixing them leaves every dependency
  // unresolvable. That is why both go through the one pinned COUNTRY_SET.
  // MapCanvas fetches the same URL, and the browser serves the second hit from
  // cache, so this costs a parse rather than a download.
  $effect(() => {
    const set = COUNTRY_SET;
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
    // Reset drops the country picker too. A country selection is not a side
    // note in the details panel: it holds the highlight, the framing AND the
    // ring's distribution, so leaving it behind would not be a reset. Clearing
    // it here is what makes the ring animate back to the world.
    selectedCountryIso3 = null;
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


  // The control circles: the rail's top tier, or the bar above the disk when
  // stacked. One list for both.
  const controlItems = $derived([
    { id: 'info', label: 'Info', glyph: 'i', active: openPanel === 'info',
      onclick: () => openPanel = openPanel === 'info' ? null : 'info' },
    { id: 'zoom-out', label: 'Zoom out', caption: 'Zoom Out', glyph: '−', onclick: zoomOut,
      disabled: zoomLevel <= ZOOM_LEVELS[0] },
    { id: 'reset', label: 'Reset', glyph: '◎', onclick: resetView },
    { id: 'zoom-in', label: 'Zoom in', caption: 'Zoom In', glyph: '＋', onclick: zoomIn,
      disabled: zoomLevel >= ZOOM_LEVELS[ZOOM_LEVELS.length - 1] }
  ]);

  // Handle window click to close overlays
  function handleWindowClick(e) {
    const target = e.target;
    // The controls count as the rail wherever they are drawn: stacked, they
    // are a bar above the disk, outside .filter-rail.
    if (target.closest('.filter-rail, .control-circles')) return;
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

<svelte:window onclick={handleWindowClick} />

<!-- .viewport fills the window; .stage is the design canvas that everything
     below is authored against (see src/shared/stage.css). -->
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
    <!-- Nav circle: switch sides + home dot. Not in the stacked layout, where
         a corner of the window is no place for it: Back, in the bar above the
         disk, stands in. -->
    {#if !layout.stacked}
      <NavCircle
        side="right"
        activeLabel="ANTHROMES"
        linkLabel="BIOMES →"
        linkHref={crossLinkHref}
        linkAriaLabel="Go to Biomes"
        homeHref={import.meta.env.BASE_URL}
      />
    {/if}

    <!-- Rail and disk are stable siblings in every layout — CSS rearranges
         them — so a window crossing into the stacked layout and back never
         remounts a chart: the year, the country and the zoom survive it. -->
    <div class="layout">
      {#if layout.stacked}
        <div class="top-bar">
          <ControlBar
            variant="flat"
            side="right"
            size={TOP_BAR.ctl}
            captionSize={TOP_BAR.caption}
            backHref={import.meta.env.BASE_URL}
            items={controlItems}
          />
        </div>
      {/if}
      <div
        class="filter-rail"
        bind:this={railEl}
        onscroll={() => railScrollTick++}
        data-cols={tier.cols}
        data-spacing={tier.spacing}
        data-detail={tier.detail}
        data-scroll={tier.scroll}
        data-fill={railFill}
        data-key={tier.keyNames && !layout.stacked ? 'full' : 'pills'}
        style:--per-group={tier.perGroup === 5 ? 5 : null}
      >
        <!-- The rail's four sections, each a snippet, so that what the rail holds
             and in what order is SECTIONS' call (see the script), not the
             markup's. -->
        {#snippet controls()}
        <!-- Top tier: large control circles, spread across the full rail width
             with an arced caption hung off the LEFT of each bubble (mirroring
             the biomes rail, which captions to the right). -->
        <ControlBar
          side="left"
          size={tier.ctl}
          captionSize={tier.caption}
          items={controlItems}
        />
        {/snippet}

        {#snippet countryPanel()}
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
                      size={tier.circle}
                      labelFontSize={tier.label}
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

          <div class="ls-rows">
            {@render lifestyleRow(
              'Westernized',
              'Populations with more exposure to urbanization, industrialized food and medicine:',
              westernIsos
            )}
            {@render lifestyleRow(
              'Non-Westernized',
              'Populations with limited exposure to urbanization and industrialized systems:',
              nonWesternIsos
            )}
          </div>
        </section>
        {/snippet}

        {#snippet detailsPanel()}
        <!-- Middle: always-visible details menu item, where Views used to be -->
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <section class="detail-dock" aria-live="polite" bind:this={detailPanelEl} onclick={(e) => e.stopPropagation()}>
          <h3 class="menu-title detail-heading">{detailHeading}</h3>
          <p class="rail-leadin">{detailBlurb}</p>
          <div class="detail-body">
            <!-- The panel is never empty. World, country and cell are three
                 scales of one chart, so they share a single slot — which is
                 also what lets the swap between them animate: the component
                 instance survives, sees its sourceKey change, and
                 drains/refills in place. The header above and the cell's
                 tooltip text below update immediately; only the field
                 animates, exactly as the ring does. -->
            {#if detailScale === 'cell'}
              <!-- Anthrome identity, then the "In <year>, X covers …"
                   sentence that comes with it. -->
              {#if detailMeta?.label}
                <div class="detail-subhead" bind:this={detailAnchorEl}>
                  {#if detailMeta?.color}
                    <span class="overlay-swatch" style={`background: ${detailMeta.color}`}></span>
                  {/if}
                  <!-- The leader calls the anthrome out BY NAME, so the name
                       carries its own rule and the line lands on that rule's
                       right end. Stacking the rule under the text in a column
                       makes it exactly as wide as the word, however long the
                       word turns out to be. -->
                  <span class="detail-name">
                    <span>{detailMeta.label}</span>
                    <span class="detail-name-rule" bind:this={anthromeRuleEl}></span>
                  </span>
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
                  {colorMapping}
                  {labelMapping}
                  {orderedCodes}
                  families={LEGEND_CATEGORIES}
                  {selectedYear}
                  onSelectYear={(y) => (selectedYear = y)}
                  selectedCodes={selectedAnthromes}
                  scrubbable
                  targetCell={TIMELINE_CELL}
                  compact={layout.stacked}
                  width={pixelChartW}
                  height={pixelChartH}
                />
              </div>
            </div>
          </div>
        </section>
        {/snippet}

        {#snippet keyPanel()}
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
        {/snippet}

        {#each sections as id (id)}
          {#if id === 'controls'}{@render controls()}
          {:else if id === 'country'}{@render countryPanel()}
          {:else if id === 'details'}{@render detailsPanel()}
          {:else if id === 'key'}{@render keyPanel()}
          {/if}
        {/each}
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
          size="full"
          showBoundaries
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
          strictCountryFocus
          profile={MAP_PROFILE}
          on:detail={handleDetail}
          on:detail-close={handleDetailClose}
        />
      </div>
    </div>
  </div>

  <!-- Leader line: isolated cell → docked detail panel. Endpoints are design px.
       White arrowhead on the map (cell) side, matching the biomes disk marker.
       Gated on cell scale because WaffleChart dispatches 'detail' on hover, not
       only on pin, so without this a line is drawn during an ordinary mouse
       move — pointing at the chart title, since anthromeRuleEl is null outside
       cell scale. Wide layouts only: stacked, the panel is under the disk and
       the elbow would land off-screen. -->
  {#if detailScale === 'cell' && detailContent && connectorStart && connectorEnd && !layout.stacked}
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
</div>

<!-- The overlay stage: what sits over the window rather than over the page
     (see src/shared/stage.css). Identical to .stage while that fills the
     window; fixed, so stacked it stays put while the page scrolls under it.
     Only there while it has something in it: an empty one is still a layer
     over the whole window, and it shifted the anti-aliasing of what lay
     under it. -->
{#if openPanel === 'info' && !error}
  <div class="overlay-stage">
    <InfoModal title="ANTHROMES" onclose={() => openPanel = null}>
      <p><strong>More than 65% of terrestrial nature</strong> has been shaped, in very different ways, by people. <strong>Anthromes</strong> are defined as the global ecological patterns shaped by direct human interactions with ecosystems.</p>
      <p>Visualized here is the <strong>Anthromes Dataset</strong> from the Anthroecology Lab. It is a “hindcast” model, projecting back in time from global population and land use data showing change over 12,025 years.</p>
      <p>As global population increases, and urbanization accelerates, <strong>biodiversity shrinks.</strong> Hence, preserving “cultured” and “wild” lands is key to preserving biodiversity.</p>
      {#snippet citations()}
        <p>Ellis, E.C., N. Gauthier, K. Klein Goldewijk, R. Bliege Bird, N. Boivin, S. Díaz, D. Fuller, J. Gill, J. Kaplan, N. Kingston, H. Locke, C. McMichael, D. Ranco, T. Rick, M.R. Shaw, L. Stephens, J.C. Svenning, and J.E.M. Watson. 2021. “People have shaped most of terrestrial nature for at least 12,000 years.” <em>Proceedings of the National Academy of Sciences</em> 118(17): e2023483118. <a href="https://doi.org/10.1073/pnas.2023483118" target="_blank" rel="noopener">https://doi.org/10.1073/pnas.2023483118</a></p>
        <p>Klein Goldewijk, K. 2025. History Database of the Global Environment (HYDE 3.5). Utrecht University. <a href="https://public.yoda.uu.nl/geo/UU01/F45D44.html" target="_blank" rel="noopener">https://public.yoda.uu.nl/geo/UU01/F45D44.html</a></p>
        <p>This project was completed by Laura Kurgan, Dan Miller and Adam Vosburgh at The Center for Spatial Research, Columbia University Graduate School of Architecture Planning and Preservation. Two Sides of the Same Coin was originally commissioned for the We the Bacteria: Notes Toward Biotic Architecture exhibition, 24th Milan Triennale International Exhibition, Inequalities, 2025. This project is open-source, and the repository is located <a href="https://github.com/CenterForSpatialResearch/twosides" target="_blank" rel="noopener">here</a>.</p>
      {/snippet}
    </InfoModal>
  </div>
{/if}

<style>
  /* Rules the two rails share (.app, .error, .fblock, .fblock-headrow, .ls-row,
     .ls-row-head, .rail-leadin, .mini-link) are in src/shared/rail.css; the
     control circles are ControlBar's and the info modal is InfoModal's. */

  .loading-overlay {
    position: absolute;
    inset: 0;
    background: var(--bg);
    z-index: 10000;
  }

  /* New rail + overlay styles */
  /* Rail, disk, margin. The disk column is a square of --disk-size and the
     rail takes what is left of the window once --disk-margin — an empty column
     beyond the disk, see DISK_ANCHOR in layoutCore.js — is set aside. On the
     display this was drawn for that is 1000 + 2000 + 0. */
  .layout {
    display: grid;
    grid-template-columns: minmax(0, 1fr) var(--disk-size) var(--disk-margin);
    height: 100%;
    align-items: stretch;
  }

  .filter-rail {
    grid-column: 1;
    /* The var()s on this rail are the rail tiers' handles (see the foot of
       src/shared/rail.css); each fallback is the 1000 x 2000 rail's number. */
    padding: var(--rail-pad, 51px 61px);
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
    gap: 0;
    height: 100%;
    overflow: hidden var(--rail-overflow-y, hidden);
    position: relative;
    z-index: 5;
    --ctl-pad-bottom: 4px;  /* see the rail rhythm note below */
  }

  /* This side's share of the tiers: the two numbers the rails differ on. */
  .filter-rail[data-spacing="regular"] {
    --country-row-pad: 24px;
  }

  .filter-rail[data-spacing="tight"] {
    --country-row-pad: 10px;
    --ls-row-gap: 14px;
  }

  .filter-rail[data-cols="8"] {
    --ls-row-gap: 0px;
  }

  /* The tight tiers — and the stacked layout at every width, a tablet's
     included — drop the key's category names and its "more intensive" arrow:
     just the pills, in one run, still in intensity order (so a drag
     across them still selects a range). */
  .filter-rail[data-key="pills"] .key-axis,
  .filter-rail[data-key="pills"] .key-cat-name {
    display: none;
  }

  .filter-rail[data-key="pills"] .key-swatches {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 6px;
  }

  .filter-rail[data-key="pills"] .key-pills {
    display: contents;
  }

  /* Packed (see rail.css): the timeline has no height of its own — it fills
     its box — so it is given one in proportion to its width. --timeline-ratio
     is the knob: field height over rail content width. */
  .filter-rail[data-fill="pack"]:not([data-spacing="anchor"]):not([data-scroll="true"]) .detail-dock {
    container-type: inline-size;
  }

  .filter-rail[data-fill="pack"]:not([data-spacing="anchor"]):not([data-scroll="true"]) .pixel-chart-box {
    flex: 0 1 auto;
    height: calc(var(--timeline-ratio, 0.3) * 100cqi);
  }

  /* Scrolling, the timeline no longer gets "whatever is left", so it is given
     a height worth reading. */
  .filter-rail[data-scroll="true"] {
    --dock-min-h: 330px;
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
     control circles, whose box ends on the ink; the control row pays
     that 4px back as padding (--ctl-pad-bottom).
     :global, because the first child is ControlBar's root, which does not
     carry this component's style scope and so could not stand as the left
     side of a scoped `* + *`. */
  .filter-rail > :global(* + *) {
    border-top: 1.3px solid rgba(255, 255, 255, 0.14);
    margin-top: var(--rail-div-above, 24px);
    padding-top: var(--rail-div-below, 22px);
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
    max-height: var(--key-max-h, 40%);
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

  /* Mouseover: a white ring, the pill's version of .country-circle:hover .ring,
     and a dimmed pill comes part of the way back the way a dimmed country
     circle does. Mouse only, so a tap or a range-drag on a touchscreen never
     leaves a pill ringed. */
  @media (hover: hover) {
    .key-pill {
      transition: opacity 0.15s ease, box-shadow 0.15s ease;
    }

    .key-pill:hover {
      box-shadow: 0 0 0 2px #fff;
    }

    .key-pill.dim:hover {
      opacity: 0.7;
    }
  }

  /* ===== MoMA: details — styled exactly like the other menu items (no card) ===== */
  /* The one section that flexes: it takes what the others leave, down to the
     least the timeline can be read at (heading, lead-in and a ~130px field). */
  .detail-dock {
    flex: var(--detail-flex, 1 1 auto);
    min-height: var(--dock-min-h, 236px);
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
    grid-template-columns: repeat(var(--per-group, 4), 1fr);
    grid-auto-rows: max-content;
    row-gap: 22px;
    column-gap: 12px;
    justify-items: center;
    align-items: start;
    padding-top: var(--country-row-pad, 24.3px);
  }

  .country-cell {
    display: flex;
    justify-content: center;
    width: 100%;
    min-width: 0;
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

  /* Lifestyle rows in the country picker — mirrors biomes' promoted row head:
     the description IS the row head, full white, sized as a lead-in. */
  .ls-row + .ls-row {
    margin-top: var(--ls-row-gap, 36px);  /* biomes' 20px + its share of the caption line */
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
    font-weight: 400;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--muted);
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

  /* ===== Stacked (portrait / phone) =====
     The same two siblings, rearranged: control bar, the disk at the full
     width of the window, then the rail as tall as its content — the page
     scrolls (see the stacked block in src/shared/stage.css). Which sections
     the rail holds there is SECTIONS' call, in the script. */
  :global(html[data-layout="stacked"]) .layout {
    display: flex;
    flex-direction: column;
    height: auto;
  }

  .top-bar {
    order: 0;
    padding: 26px 36px 4px;
  }

  /* --disk-size is the stage's width here (less on a phone held sideways,
     where it is what the window's height leaves — hence the centring). An
     explicit square rather than aspect-ratio, so the chart's own height: 100%
     has a definite height to resolve against. */
  :global(html[data-layout="stacked"]) .viz-area {
    order: 1;
    flex: 0 0 auto;
    align-self: center;
    width: var(--disk-size);
    height: var(--disk-size);
  }

  :global(html[data-layout="stacked"]) .filter-rail {
    order: 2;
    height: auto;
    overflow: visible;
  }

  /* The first section sits under the disk, not under the top of a rail, so it
     takes the divider the others have. */
  :global(html[data-layout="stacked"]) .filter-rail > :global(:first-child) {
    border-top: 1.3px solid rgba(255, 255, 255, 0.14);
    padding-top: var(--rail-div-below, 22px);
  }

  /* The key is a screenful of pills on a phone: a vertical swipe across them
     has to scroll the page. A sideways drag still sweeps a range. */
  :global(html[data-layout="stacked"]) .key-pill {
    touch-action: pan-y;
  }

  /* No leftover height to fill in a rail that is as tall as its content, so
     the timeline is given one. */
  :global(html[data-layout="stacked"]) .pixel-chart-box {
    flex: 0 0 auto;
    height: var(--stacked-timeline-h, 250px);
  }

</style>
