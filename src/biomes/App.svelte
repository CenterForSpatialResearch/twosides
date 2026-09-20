<script>
  import { onMount, untrack } from 'svelte';
  import BiomesChart, {
    ABUNDANT_MIN_SAMPLES,
    RARE_MAX_SAMPLES,
    WIDESPREAD_MIN_COUNTRIES,
    CONCENTRATED_MAX_COUNTRIES,
    isNonWesternExclusive
  } from './lib/BiomesChart.svelte';
  import { prepareBiomesData, colorMapping, pickTextColor, getPhylum, parseUSGB, parseWestern } from './lib/dataAdapter.js';
  import * as d3 from 'd3';
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
    railTier('biomes', layout.railW, layout.railH, tierOverride, { large: layout.large, five: fiveOverride })
  );

  // What the rail holds, and in what order, per layout. The stacked (phone)
  // layout leads with the details because they sit right under the disk — the
  // leader drops straight onto them — and has no 'controls': there they are a
  // bar above the disk instead (see the markup). It has no 'country' either:
  // the picker is dropped on a phone, which explores the whole catalog. Adding
  // or dropping a menu is adding or deleting its id.
  const SECTIONS = {
    wide: ['controls', 'country', 'details', 'key'],
    stacked: ['details', 'key']
  };
  const sections = $derived(SECTIONS[layout.stacked ? 'stacked' : 'wide']);

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
  let tension = $state(0.95);
  let selectedBodySites = $state(new Set()); // retained for compatibility but hidden in UI
  let selectedStudyKey = $state(null);
  const PRIMARY_ORDER = ['SWE', 'GBR', 'USA', 'CHN', 'MDG', 'FJI', 'PER', 'TZA'];
  // On a large window each lifestyle group gains a fifth country
  // (tier.perGroup, see railTiers.js). Italy is Westernized throughout the
  // study. Mongolia is the one country it samples under both labels (LiuW_2016:
  // agro-pastoral herders and Ulaanbaatar), so its entry in
  // primary_countries.json is the non-Westernized cohort alone — 39 samples,
  // 108 species — not the country-wide roster.
  const FIFTH_WESTERN = 'ITA';
  const FIFTH_NONWESTERN = 'MNG';
  // Everything that is loaded or counted per country covers all ten, so the
  // fifth pair is ready whenever a resize brings it in.
  const ALL_ORDER = ['SWE', 'GBR', 'ITA', 'USA', 'CHN', 'MDG', 'FJI', 'MNG', 'PER', 'TZA'];
  const activeOrder = $derived(tier.perGroup === 5 ? ALL_ORDER : PRIMARY_ORDER);
  // Compact display labels — iso3_names.json expands SWE→"Sweden", USA→"United
  // States of America", GBR→"United Kingdom" etc. The picker needs short,
  // uniform labels that don't dictate the circle's layout width.
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

  // Country-first primary filter. ISO3 or null. In-memory only: the
  // two sides no longer hand a selection to one another, so there is nothing
  // to seed from the URL and nothing to keep in sync with it.
  let selectedCountryIso3 = $state(null);
  let primaryCountries = $state(null);        // { ISO3: {label, sgbs, ...} } from primary_countries.json
  let countryFeatureByIso = $state(new Map()); // ISO3 -> feature (target countries only)

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

  // Each row ranked by share of species unknown to science, greatest first.
  function rankRow(isos) {
    return isos
      .map((iso3) => ({ iso3, unknownPct: countryRowStats[iso3]?.unknownPct ?? 0 }))
      .sort((a, b) => b.unknownPct - a.unknownPct);
  }
  const westernRow = $derived(
    rankRow(tier.perGroup === 5 ? [...WESTERN_ISOS, FIFTH_WESTERN] : WESTERN_ISOS)
  );
  const nonWesternRow = $derived(
    rankRow(tier.perGroup === 5 ? [...NONWESTERN_ISOS, FIFTH_NONWESTERN] : NONWESTERN_ISOS)
  );

  // The nav coin's route to the other side: plain navigation, carrying no
  // country and no species. Both sides now draw the same eight countries, and
  // that shared vocabulary — not a URL hand-off — is what carries a reader's
  // interest across. side= only tells the interstitial which copy to show.
  const crossLinkHref = `${import.meta.env.BASE_URL}loading.html?side=anthromes`;
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
  let openPanel = $state(null); // 'info' | null
  let filterRailEl = $state(null);
  let biomesChartRef = $state(null);
  let detailContent = $state(null);
  let detailPoint = $state(null);
  let detailMeta = $state(null); // { metadata, name, phylum, leafId } from BiomesChart
  let detailPanelEl = $state(null);
  let detailPanelAnchor = $state(null);
  // 8/21: the rule under the SGB name — the leader's terminus on this side.
  let sgbRuleEl = $state(null);
  // 8/21: design px of blank lead-in above the SGB title. The leader runs DEAD
  // STRAIGHT out of the disk, so the rule has to come to the marker's height
  // rather than the line bending to find the rule — everything else in the
  // panel then follows below it. Measured rather than assumed: the panel sits
  // under a country block whose height is data-dependent, and a margin
  // translates the rule 1:1, so one correction lands it exactly.
  let sgbLeadIn = $state(0);
  let viewportW = $state(0);
  let viewportH = $state(0);

  // Leader line: from the chart's selection marker to the details panel
  let leaderFrom = $state(null); // {x, y} design px (marker, reported by chart)
  let leaderTo = $state(null);   // {x, y} design px (panel left edge, mid-height)

  // The lead-in (see sgbLeadIn) is what keeps the leader dead straight, and it
  // is paid for in rail height: the whole panel starts lower. The rail this
  // was drawn for always pays it (see `leadIn` in railTiers.js). Every other
  // rail pays it when it can: the rule falls ABOVE the marker and the details
  // block has the height to spare (see leadInRoom). Otherwise the title stays
  // where the layout puts it and the leader bends to reach it instead.
  const leadInAllowed = $derived(tier.leadIn);

  // The leader is a straight run while the rule can be brought to the marker.
  // It cannot when the rule already sits BELOW the marker (a short rail: the
  // disk's centre is higher than the details block — a lead-in pushes down,
  // never up), or when the rail has no room for the lead-in. Then it is drawn
  // the way the anthromes leader is: out level from the marker, a vertical run
  // in the rail's empty left padding, and in level to the rule.
  const leaderBent = $derived.by(() => {
    if (!leaderFrom || !leaderTo || sgbLeadIn !== 0 || layout.stacked) return false;
    const dy = leaderTo.y - leaderFrom.y;
    return leadInAllowed ? dy > 1 : Math.abs(dy) > 1;
  });

  // x of the bent leader's vertical run: midway through the rail's left
  // padding, and never left of the marker.
  const leaderElbowX = $derived(
    leaderFrom && leaderTo
      ? Math.max(leaderFrom.x + 14, (layout.diskMargin + layout.diskSize + leaderTo.x) / 2)
      : 0
  );

  let railEl = $state(null);

  // Stacked, the marker is at the foot of the disk and the details panel is
  // the section right under it, so the leader is a plumb line from one to the
  // rule along the top of the other. Only while the details ARE the first
  // section: under anything else the line would run through that instead.
  const leaderPlumb = $derived(layout.stacked && sections[0] === 'details');

  function updateLeaderTo() {
    if (!detailContent || !detailPanelEl) { leaderTo = null; return; }
    if (layout.stacked) {
      if (!leaderPlumb || !leaderFrom) { leaderTo = null; return; }
      const pr = detailPanelEl.getBoundingClientRect();
      leaderTo = { x: leaderFrom.x, y: screenToDesign(pr.left, pr.top).y };
      return;
    }
    // The leader points at the SGB by NAME, so it ends ON the rule under that
    // name — x comes from the rule's own left edge, not the panel's. The rule
    // sits at the rail's left padding, a few px inside the seam, so the run
    // stays a single straight line; nothing of the panel lies between the two,
    // unlike the anthromes side where the chart forces an elbow.
    // Rects are screen px; the overlay is design px.
    if (sgbRuleEl) {
      const rr = sgbRuleEl.getBoundingClientRect();
      // The rail scrolls in its smallest tier. The leader follows the rule as
      // it does, and is dropped while the rule is outside the rail's box.
      if (railEl) {
        const vr = railEl.getBoundingClientRect();
        const y = rr.top + rr.height / 2;
        if (y < vr.top || y > vr.bottom) { leaderTo = null; return; }
      }
      leaderTo = screenToDesign(rr.left, rr.top + rr.height / 2);
      return;
    }
    // Otherwise anchor on the panel TITLE (not the panel mid-height) so the
    // leader lands in line with "Bacteria Species Details". The 8/14 detail
    // block has no such title — its head is the species glyph with the SGB
    // label beside it — so the leader lines up with the GLYPH's centre, which
    // is the taller of the two and reads as the head's true middle. X comes
    // from the panel's own left edge, never the anchor's, so the horizontal
    // landing point stays put regardless of which element supplies the height.
    const headEl =
      detailPanelEl.querySelector('.species-glyph') || detailPanelEl.querySelector('.species-sgb');
    const anchor = headEl || detailPanelEl.querySelector('.fblock-title') || detailPanelEl;
    const r = anchor.getBoundingClientRect();
    const panelRect = detailPanelEl.getBoundingClientRect();
    leaderTo = screenToDesign(panelRect.left, r.top + r.height / 2);
  }

  // Design px the details content could still move DOWN without being cut off:
  // the slack under its last row (the block takes the rail's spare height), or
  // under the rail's last section when the rail is packed and the spare is at
  // its foot. None on the scrolling rail, where a lead-in only adds length.
  function leadInRoom() {
    if (tier.scroll) return 0;
    const slack = (box, padBottom = 0) => {
      const last = box?.lastElementChild;
      if (!last) return 0;
      const b = box.getBoundingClientRect();
      const l = last.getBoundingClientRect();
      return screenToDesign(b.left, b.bottom).y - screenToDesign(l.left, l.bottom).y - padBottom;
    };
    const inPanel = slack(detailPanelEl?.querySelector('.detail-scroll'));
    if (railFill !== 'pack' || !railEl) return inPanel;
    return inPanel + Math.max(0, slack(railEl, parseFloat(getComputedStyle(railEl).paddingBottom) || 0));
  }

  function alignSgbToMarker() {
    if (layout.stacked) { sgbLeadIn = 0; return; }
    if (!sgbRuleEl || !leaderFrom) return;
    const rr = sgbRuleEl.getBoundingClientRect();
    const ruleY = screenToDesign(rr.left, rr.top + rr.height / 2).y;
    // The lead-in the DOM carries right now, read off the title itself: state
    // may be a flush ahead of it, and the rule was measured against the DOM.
    const applied = (parseFloat(sgbRuleEl.parentElement?.style.marginTop) || 6) - 6;
    // A margin translates the rule 1:1, so where the rule would sit with no
    // lead-in gives the lead-in it needs in one step. Never negative: the title
    // cannot climb into the block above.
    const needed = Math.max(0, leaderFrom.y - (ruleY - applied));
    // Everything the content can move down by, the lead-in it already has
    // included. A lead-in that does not fit is dropped whole — a shorter one
    // would still leave the leader bent.
    const fits = leadInAllowed || needed <= applied + leadInRoom();
    const next = fits ? needed : 0;
    // Sub-pixel drift is not worth a reflow.
    if (Math.abs(next - sgbLeadIn) < 0.5) return;
    sgbLeadIn = next;
  }

  function handleMarker(event) {
    leaderFrom = event.detail || null;
    alignSgbToMarker();
    updateLeaderTo();
  }

  // Recompute the panel endpoint when the panel appears/changes or the window resizes.
  // The panel is flex:1, so async rail content (bubbles/phyla) reflows it after load —
  // observe its box so the leader endpoint tracks those late layout shifts.
  $effect(() => {
    const el = detailPanelEl;
    detailContent; detailMeta; viewportW; viewportH; sgbRuleEl; leaderFrom; tier; layout.mode; leaderPlumb;
    alignSgbToMarker();
    updateLeaderTo();
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => { alignSgbToMarker(); updateLeaderTo(); });
    ro.observe(el);
    return () => ro.disconnect();
  });

  // The lead-in moves the rule without resizing the panel (the panel already
  // holds the rail's spare height), so nothing above notices: re-measure the
  // leader's end once the new margin is in the DOM.
  $effect(() => {
    sgbLeadIn;
    untrack(updateLeaderTo);
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

      // Country-first picker data: the curated 8-country manifest and
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
          for (const iso of ALL_ORDER) {
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
          const wanted = new Set(ALL_ORDER);
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
    biomesChartRef?.resetControl?.();
  }

  // The control circles: the rail's top tier, or the bar above the disk when
  // stacked. The rail mirrors the anthromes one, so Info sits last there; the
  // bar reads the same on both sides: Back, Info, Zoom Out, Reset, Zoom In.
  const controlById = $derived({
    'zoom-out': { id: 'zoom-out', label: 'Zoom out', caption: 'Zoom Out', glyph: '−',
      onclick: () => biomesChartRef?.zoomOutControl?.(), disabled: zoomIdx === 0 },
    reset: { id: 'reset', label: 'Reset', glyph: '◎', onclick: resetAll },
    'zoom-in': { id: 'zoom-in', label: 'Zoom in', caption: 'Zoom In', glyph: '＋',
      onclick: () => biomesChartRef?.zoomInControl?.(), disabled: zoomIdx === 2 },
    info: { id: 'info', label: 'Info', glyph: 'i', active: openPanel === 'info',
      onclick: () => openPanel = openPanel === 'info' ? null : 'info' }
  });
  const controlItems = $derived(
    (layout.stacked ? ['info', 'zoom-out', 'reset', 'zoom-in'] : ['zoom-out', 'reset', 'zoom-in', 'info'])
      .map((id) => controlById[id])
  );

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

  // Which set of samples the phylum shares are computed over. null = the whole
  // catalog. The caption under the key and the percentages in the pills both
  // read off this one value, so they can never name different denominators —
  // a selected country with no resolvable SGBs falls back to the catalog on
  // both at once rather than captioning a column of 0%.
  const phylumScopeIso3 = $derived(
    selectedCountryIso3 &&
    primaryCountries?.[selectedCountryIso3]?.sgbs?.length &&
    leafBySgbId.size
      ? selectedCountryIso3
      : null
  );

  // "in the UK", not "in USA": the short labels are written for the circles,
  // where they stand alone, and two of them need an article to sit in a
  // sentence. Mirrors withArticle() on the anthromes side.
  const ARTICLE_LABELS = new Set(['UK', 'USA']);

  const phylumScopeLabel = $derived.by(() => {
    if (!phylumScopeIso3) return 'all samples';
    const label = SHORT_LABELS[phylumScopeIso3] ?? primaryCountries?.[phylumScopeIso3]?.label ?? phylumScopeIso3;
    return `samples found in ${ARTICLE_LABELS.has(label) ? 'the ' : ''}${label}`;
  });

  // Share of the scope's species that fall in each phylum, as a percentage.
  // Species, not samples, is the unit throughout this side — the disk draws one
  // line per SGB — so the share is "of the species reported here, this many are
  // Firmicutes".
  const phylumPctByName = $derived.by(() => {
    const counts = {};
    if (phylumScopeIso3) {
      for (const sgb of primaryCountries[phylumScopeIso3].sgbs) {
        const leaf = leafBySgbId.get(Number(sgb));
        if (!leaf) continue;
        const name = getPhylum(leaf);
        counts[name] = (counts[name] || 0) + 1;
      }
    } else {
      Object.assign(counts, phylumCountByName);
    }
    let total = 0;
    for (const n of Object.values(counts)) total += n;
    if (!total) return {};
    const out = {};
    for (const [name, n] of Object.entries(counts)) out[name] = (n / total) * 100;
    return out;
  });

  // Same thresholds as the anthromes key, so a share reads the same on both
  // sides of the coin: anything under a percent is "<1%" rather than "0%".
  function fmtPct(p) {
    if (!p || p <= 0) return '0%';
    if (p < 1) return '<1%';
    return `${Math.round(p)}%`;
  }

  // Pill key input: derived list of {name, pct, color, isOther?}. Any phylum
  // that falls through to the palette's Other colour (drawn gray on the disk)
  // collapses into a single Other pill carrying the summed share.
  const OTHER_COLOR = colorMapping.Other;
  const phylumPills = $derived.by(() => {
    if (!allPhyla.length) return [];
    const primary = [];
    let otherCount = 0;
    let otherPct = 0;
    for (const name of allPhyla) {
      const pct = phylumPctByName[name] || 0;
      const color = colorMapping[name] || OTHER_COLOR;
      if (color === OTHER_COLOR) {
        otherCount++;
        otherPct += pct;
      } else {
        primary.push({ name, pct, color });
      }
    }
    if (otherCount) {
      primary.push({ name: 'Other', pct: otherPct, color: OTHER_COLOR, isOther: true });
    }
    return primary;
  });

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

  // Handle click outside to close panel. Clicks inside the rail (the control
  // circles, the filters, the details block) and inside the info modal never
  // close anything, as on the anthromes side. The Info button toggles the
  // modal in its own handler; this one used to null openPanel right after
  // that toggle because the button sits in the rail, so the modal never showed.
  function handleWindowClick(e) {
    const target = e.target;
    if (target.closest('.rail, .control-circles, .info-modal')) {
      return;
    }
    openPanel = null;
  }

  function handleZoomChange(event) {
    zoomIdx = event.detail?.index ?? 0;
  }

  function handleDetail(event) {
    detailContent = event.detail?.content || null;
    detailPoint = event.detail?.point || null;
    detailMeta = event.detail?.meta || null;
    openPanel = null;
  }

  function handleDetailPanelClick(event) {
    event.stopPropagation();
  }

  // 'detail-close' is only dispatched when the chart has nothing to show,
  // which no longer happens in use; the panel keeps its last species.
  function handleDetailClose() {}

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
    const order = activeOrder;
    const primarySet = new Set(order);
    const primary = [];
    const other = [];
    for (const iso of uniq) {
      if (primarySet.has(iso)) primary.push(iso);
      else other.push(iso);
    }
    // Sort primaries by our PRIMARY_ORDER, others alphabetically.
    primary.sort((a, b) => order.indexOf(a) - order.indexOf(b));
    other.sort();
    return { primary, other };
  });

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

  // Mount effects
  onMount(() => {
    window.addEventListener('click', handleWindowClick);
    const setSize = () => {
      viewportW = window.innerWidth;
      viewportH = window.innerHeight;
    };
    setSize();
    window.addEventListener('resize', setSize);

    return () => {
      window.removeEventListener('click', handleWindowClick);
      window.removeEventListener('resize', setSize);
    };
  });

  // (moved below)
</script>


<!-- .viewport fills the window; .stage is the design canvas that everything
     below is authored against (see src/shared/stage.css). -->
<div class="viewport">
<div class="stage" bind:this={stageEl}>
{#if loading}
  <!-- Blank overlay: see the note on the anthromes side. The state is kept so
       data still fetches; only the text goes. -->
  <div class="loading" aria-hidden="true"></div>
{:else if error}
  <div class="error">
    <h2>Error</h2>
    <p>{error}</p>
  </div>
{:else}
  <div class="app">
    <!-- Nav circle: switch sides + home dot. Not in the stacked layout, where
         a corner of the window is no place for it: Back, in the bar above the
         disk, stands in. -->
    {#if !layout.stacked}
      <NavCircle
        side="left"
        activeLabel="BIOMES"
        linkLabel="ANTHROMES →"
        linkHref={crossLinkHref}
        linkAriaLabel="Go to Anthromes"
        homeHref={import.meta.env.BASE_URL}
      />
    {/if}

    <!-- Disk and rail are stable siblings in every layout — CSS rearranges
         them — so a window crossing into the stacked layout and back never
         remounts the chart: the rotation, the zoom and the filters survive. -->
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
      <div class="viz-area">
        <BiomesChart
          bind:this={biomesChartRef}
          {taxonomyTree}
          bind:selectedPhyla
          bind:unknownFilter
          bind:westernFilter
          bind:abundanceFilter
          bind:geoFilter
          size="full"
          {tension}
          bodySiteFilter={selectedBodySites}
          proxyKey={null}
          studyKey={selectedStudyKey}
          countryIso3={selectedCountryIso3}
          markerAt={layout.stacked ? 'bottom' : 'right'}
          on:detail={handleDetail}
          on:detail-close={handleDetailClose}
          on:zoomchange={handleZoomChange}
          on:marker={handleMarker}
        />
      </div>

      <div
        class="rail"
        bind:this={railEl}
        onscroll={updateLeaderTo}
        data-cols={tier.cols}
        data-spacing={tier.spacing}
        data-detail={tier.detail}
        data-scroll={tier.scroll}
        data-fill={railFill}
        style:--per-group={tier.perGroup === 5 ? 5 : null}
      >
        <!-- The rail's four sections, each a snippet, so that what the rail holds
             and in what order is SECTIONS' call (see the script), not the
             markup's. -->
        {#snippet controls()}
        <!-- Top tier: largest control circles. Option 1 spreads them across the
             full rail width and hangs an arced caption off the RIGHT of each
             bubble (the anthromes rail mirrors this to the left). -->
        <ControlBar
          side="right"
          size={tier.ctl}
          captionSize={tier.caption}
          items={controlItems}
        />
        {/snippet}

        {#snippet detailsPanel()}
          <!-- svelte-ignore a11y_click_events_have_key_events -->
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <section
            class="fblock detail-block"
            aria-live="polite"
            bind:this={detailPanelEl}
            onclick={(e) => e.stopPropagation()}
          >
            <!-- Section head, the side's subheadline: the same slot the
                 anthromes details panel gives "MODELING 12,025 YEARS OF LAND
                 USE". It sits inside the SGB title's measured lead-in, so the
                 rule under the SGB name still lands at the marker's height. -->
            <h3 class="fblock-title detail-heading">5000 LINES 5000 SPECIES</h3>
            <!-- Never empty: the disk selects whichever species the marker
                 points at, from first render on, and nothing clears it. -->
            {#if detailMeta}
              <!-- .panel-content carries the shared panel typography (see
                   src/shared/styles.css); .detail-scroll supplies the
                   min-height:0 that lets it scroll inside the flex column
                   rather than overflow the rail. -->
              <div class="panel-content detail-scroll">
                <!-- Graphical header replaces the section title: radial mini-glyph
                     traces this leaf's ancestor path through the tree in the
                     disk's polar coordinates, next to the SGB label + lineage
                     breadcrumbs. -->
                {#if detailMeta.metadata?.SGB_ID != null}
                  <!-- The leader calls the species out by name, so the SGB
                       label is lifted out of the ident column to sit ABOVE the
                       glyph with a rule under it, and the line terminates on
                       that rule's LEFT end — the end facing the disk — so the
                       dashed run and the underline read as one stroke. -->
                  <div class="species-title" style={`margin-top: ${6 + sgbLeadIn}px`}>
                    <span class="species-sgb">SGB {detailMeta.metadata.SGB_ID}</span>
                    <span class="species-sgb-rule" bind:this={sgbRuleEl}></span>
                  </div>
                {/if}
                <!-- The one-liner glosses the name the leader has just pointed
                     at, so it reads AFTER it — "SGB 5089", the rule, then what
                     an SGB is. Above the title it would push the rule down out
                     of the marker's reach; the SGB block has to stay the first
                     thing in the panel for the leader to run straight. -->
                <h3 class="fblock-oneliner detail-oneliner">A species is defined through genomic similarity.</h3>
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
                      {speciesStats.abundance.name}<span class="sp-stat-detail">&nbsp;· {speciesStats.abundance.detail}</span>
                    </span>
                    <span class="sp-stat">
                      {speciesStats.reach.name}<span class="sp-stat-detail">&nbsp;· {speciesStats.reach.detail}</span>
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
                        <span class="sp-country-chip sp-country-chip--primary">{SHORT_LABELS[iso3] ?? iso3}</span>
                      {/each}
                      {#each speciesCountries.other as iso3 (iso3)}
                        <span class="sp-country-chip sp-country-chip--muted">{iso3}</span>
                      {/each}
                    </div>
                  </div>
                {/if}

              </div>
            {/if}
          </section>
        {/snippet}

        {#snippet countryPanel()}
        <!-- Lifestyle: the eight countries split into the two categories the
             study itself assigns, each row ranked by the share of that
             country's species previously unknown to science. The row head
             drops the "Westernized"/"Non-Westernized" titles and promotes each
             row's description into that slot (see lifestyleRow below). -->
        <section class="fblock">
          <div class="fblock-headrow">
            <!-- One sentence of exhibit copy names what the block is FOR rather
                 than what it contains. The "All" mini-link carries the
                 affordance an instruction would have spelled out. -->
            <h3 class="fblock-oneliner">An extensive microbiome contains fragments of DNA from people in many countries.</h3>
            <button
              class="mini-link"
              class:active={selectedCountryIso3 === null}
              onclick={() => (selectedCountryIso3 = null)}
              aria-label="Clear country selection"
            >All</button>
          </div>

          {#snippet lifestyleRow(title, blurb, rowItems)}
            <div class="ls-row">
              <!-- The "Western"/"Non-Western" title is dropped and the
                   description promoted into its slot: the country circles
                   below already carry the lifestyle split visually, so the
                   label was restating what the row shows. The title is kept
                   for screen readers via aria-label. -->
              <div class="ls-row-head ls-row-head--promoted" aria-label={title}>
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
                      size={tier.circle}
                      labelFontSize={tier.label}
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

          <div class="ls-rows">
            {@render lifestyleRow(
              'Westernized',
              'Populations with more exposure to urbanization, industrialized food and medicine:',
              westernRow
            )}

            {@render lifestyleRow(
              'Non-Westernized',
              'Populations with limited exposure to urbanization and industrialized systems:',
              nonWesternRow
            )}
          </div>

        </section>
        {/snippet}

        {#snippet keyPanel()}
        <!-- Bottom tier: phylum key (bubble cluster; area ∝ SGB count) -->
        <section class="phylum-band">
          <div class="phylum-band-head">
            <span class="fblock-oneliner">Phyla group species into major microbial lineages.</span>
            <!-- No "All" over the pill key: the pills are a legend, not a
                 filter, so there is nothing to clear. -->
          </div>
          <!-- A flat pill key (same vocabulary as the anthromes legend) rather
               than a chart: the pills are a key only, not a filter, and cannot
               be selected. Phyla the palette has no colour for (drawn gray on
               the disk) collapse into one Other pill. -->
          <!-- The caption belongs to the pills, not to the section: it names
               the denominator the percentages in them are taken over. -->
          <p class="rail-leadin phylum-scope">Phylum share in {phylumScopeLabel}:</p>
          <div class="phylum-key phylum-key--pills">
            {#each phylumPills as b (b.name)}
              {@const label = b.name.replace(/_/g, ' ')}
              <span
                class="phylum-dot"
                style="background:{b.color}; color:{pickTextColor(b.color)};"
                title="{label} — {fmtPct(b.pct)}"
              >
                <span>{label} ({fmtPct(b.pct)})</span>
              </span>
            {/each}
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
    </div>

    <!-- Leader line: chart selection marker → details panel -->
    {#if detailContent && leaderFrom && leaderTo}
      <svg class="leader-overlay" aria-hidden="true">
        <!-- The details panel sits inline in the rail, so the leader is a
             straight run from the marker to the rail edge. y comes from the
             MARKER rather than from leaderTo: alignSgbToMarker() brings the rule
             to the marker, so the run is horizontal by construction and still
             reads straight during the frame before the lead-in has settled.
             That only holds while the SGB block is the first thing in the
             panel — the lead-in can push the rule down but never up, so
             anything rendered above the title puts the rule out of reach of a
             high marker. See the note on the one-liner's placement above. -->
        {#if layout.stacked}
          <!-- Stacked: a plumb line from the marker at the foot of the disk to
               the rule along the top of the details panel (see leaderPlumb). -->
          <line
            class="leader-line"
            x1={leaderFrom.x} y1={leaderFrom.y}
            x2={leaderFrom.x}
            y2={leaderTo.y}
          />
        {:else if leaderBent}
          <!-- The rule cannot come to the marker (see leaderBent), so the line
               goes to the rule: level out of the disk, up or down the rail's
               empty left padding, level in to the rule's left end. -->
          <polyline
            class="leader-line"
            points="{leaderFrom.x},{leaderFrom.y} {leaderElbowX},{leaderFrom.y} {leaderElbowX},{leaderTo.y} {leaderTo.x},{leaderTo.y}"
          />
        {:else}
          <line
            class="leader-line"
            x1={leaderFrom.x} y1={leaderFrom.y}
            x2={leaderTo.x}
            y2={leaderFrom.y}
          />
        {/if}
      </svg>
    {/if}
  </div>
{/if}
</div>
</div>

<!-- The overlay stage: what sits over the window rather than over the page
     (see src/shared/stage.css). Identical to .stage while that fills the
     window; fixed, so stacked it stays put while the page scrolls under it.
     Only there while it has something in it: an empty one is still a layer
     over the whole window, and it shifted the anti-aliasing of what lay
     under it. -->
{#if openPanel === 'info' && !loading && !error}
  <div class="overlay-stage">
    <InfoModal title="BIOMES" onclose={() => openPanel = null}>
      <p><strong>5000 Lines 5000 Species</strong></p>
      <p>This visualization shows an evolution of the extensive human microbiome. It reconstructs data from the Segata Lab: 9,316 sample collections spanning 46 datasets from multiple populations and an additional cohort from Madagascar. The scientists reconstructed a catalog that greatly expands the set of 150,000 microbial genomes publicly available.</p>
      <p>Each line represents the evolutionary pathway of a Species Level Genetic Bin (SGB), a grouping that organizes genomes based on their similarity, allowing for broader identification of species, both previously known and unknown.</p>
      <p><strong>Known / Unknown:</strong> within this study, {unknownPct}% of bacteria species visualized and analyzed were previously unknown.</p>
      <p><strong>Westernized / Non-Westernized:</strong> a key finding from these data is that the human microbiome is more diverse than previously understood, especially in indigenous anthromes, which has led to calls for their preservation (see back of coin).</p>
      {#snippet citations()}
        <p>Pasolli, Edoardo, Francesco Asnicar, Serena Manara, Moreno Zolfo, Nicolai Karcher, Federica Armanini, Francesco Beghini, et al. 2019. “Extensive Unexplored Human Microbiome Diversity Revealed by Over 150,000 Genomes from Metagenomes Spanning Age, Geography, and Lifestyle.” <em>Cell</em> 176(3): 649–662. <a href="https://doi.org/10.1016/j.cell.2019.01.001" target="_blank" rel="noopener">https://doi.org/10.1016/j.cell.2019.01.001</a></p>
        <p>This project was completed by Laura Kurgan, Dan Miller and Adam Vosburgh at The Center for Spatial Research, Columbia University Graduate School of Architecture Planning and Preservation. Two Sides of the Same Coin was originally commissioned for the We the Bacteria: Notes Toward Biotic Architecture exhibition, 24th Milan Triennale International Exhibition, Inequalities, 2025. This project is open-source, and the repository is located <a href="https://github.com/CenterForSpatialResearch/twosides" target="_blank" rel="noopener">here</a>.</p>
      {/snippet}
    </InfoModal>
  </div>
{/if}

<style>
  /* Split from .error now that it carries no text: an opaque cover in the page
     background, sitting above whatever has already painted, so the hand-off
     from loading.html reads as one continuous dark screen. */
  .loading {
    position: absolute;
    inset: 0;
    background: var(--bg);
    z-index: 10000;
  }

  /* Rules the two rails share (.app, .error, .fblock, .fblock-headrow, .ls-row,
     .ls-row-head, .rail-leadin, .mini-link) are in src/shared/rail.css; the
     control circles are ControlBar's and the info modal is InfoModal's. */

  /* Margin, disk, rail. The disk column is a square of --disk-size and the
     rail takes what is left of the window once --disk-margin — an empty column
     beyond the disk, see DISK_ANCHOR in layoutCore.js — is set aside. On the
     display this was drawn for that is 0 + 2000 + 1000. */
  .layout {
    display: grid;
    grid-template-columns: var(--disk-margin) var(--disk-size) minmax(0, 1fr);
    height: 100%;
    align-items: stretch;
    gap: 0;
  }

  .rail {
    --ctl-pad-bottom: 7px;  /* see the rail rhythm note below */
    grid-column: 3;
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
  }

  /* This side's share of the tiers: the numbers the rails differ on, and the
     details block's compact form. */
  .rail[data-spacing="tight"] {
    --country-row-pad: 6px;
    --ls-row-gap: 12px;
  }

  .rail[data-cols="8"] {
    --ls-row-gap: 0px;
  }

  /* Off the anchor the lineage row stops reserving its four lines: that
     constant is measured for a 705px column, and in a narrower rail a long
     lineage runs to five and was clipped. */
  .rail:not([data-spacing="anchor"]) {
    --lineage-h: auto;
  }

  /* Compact details: a smaller glyph and closer rows. The one-liner's pull-up
     is paired with the row gap (it sits 5px under the rule whatever the gap). */
  .rail[data-detail="compact"] {
    --glyph-size: 96px;
    --detail-gap: 12px;
    --oneliner-pull: -7px;
  }

  /* Thin gray divider between every menu item (details reads as just another one) */
  /* Rail rhythm: 28px of visible space above and below every divider, the
     same as the anthromes rail — see the note there for why margin and
     padding differ (28 - 4 below a block's last ink, 28 - 6 above a
     headline's letters). The arc labels on this side hang 3px below the
     control circles, so the control row pays back 7px here where the
     anthromes rail pays 4 (--ctl-pad-bottom).
     :global, because the first child is ControlBar's root, which does not
     carry this component's style scope and so could not stand as the left
     side of a scoped `* + *`. */
  .rail > :global(* + *) {
    border-top: 1.3px solid rgba(255, 255, 255, 0.14);
    margin-top: var(--rail-div-above, 24px);
    padding-top: var(--rail-div-below, 22px);
  }

  .fblock,
  .phylum-band {
    flex: 0 0 auto;
  }

  /* A size container, so the panel's contents can answer to the panel's own
     width rather than the window's (the stat line does, in styles.css). */
  .detail-block {
    flex: var(--detail-flex, 1 1 auto);
    min-height: 0;
    container: detail / inline-size;
  }

  .viz-area {
    grid-column: 2;
    position: relative;
    height: 100%;
    width: 100%;
    overflow: hidden;
  }


  /* ===== Middle tier: menu items ===== */
  .fblock-title {
    margin: 0;
    font-size: 24px;
    font-weight: 800;
    letter-spacing: 0.02em;
    color: var(--fg);
  }

  /* Curatorial one-liner — replaces a category label with a full sentence from
     the exhibit copy. Sized above .fblock-title (larger tier) but lighter
     weight so it reads as a "phrase" rather than a heading label. Sits in the
     same fblock-headrow flex slot as the old title, so `flex: 1 1 auto` +
     `min-width: 0` lets it wrap while the sibling "All" mini-link stays
     anchored to the right. */
  .fblock-oneliner {
    margin: 0;
    flex: 1 1 auto;
    min-width: 0;
    font-size: 27px;
    font-weight: 700;
    line-height: 1.28;
    letter-spacing: 0.005em;
    color: var(--fg);
  }

  /* "5000 LINES 5000 SPECIES" is set in the section-headline voice, the same as
     .fblock-oneliner above and as "MODELING 12,025 YEARS OF LAND USE" opposite
     it. Its own rule rather than that class, because .fblock-oneliner claims
     flex-grow and this sits in a column. */
  .detail-heading {
    font-size: 27px;
    font-weight: 700;
    line-height: 1.28;
    letter-spacing: 0.005em;
  }

  /* Sits under the SGB rule inside .panel-content, whose grid gap already
     spaces it; the only correction it needs is to sit a little tighter to the
     rule it glosses than to the block that follows. Pulled up by most of that
     gap, so widening the panel's rhythm below (see .detail-block
     .panel-content) does not push the gloss off the name it glosses. */
  .detail-oneliner {
    margin-top: var(--oneliner-pull, -22.75px);
  }

  /* Compact detail panel — `align-content: start` (see .panel-content) stacks
     the blocks from the top rather than spreading them, so this sets the
     rhythm between them outright. The gap was 7px when the rail had no room
     to spare; the panel now runs to the foot of the rail with well over a
     hundred px unused under the last block, and at that height the five
     blocks read as one crowded mass. This is the air, spent between them
     rather than pooled at the bottom. Nothing above the SGB rule is touched:
     the leader lands on that rule, so the space all goes below it. */
  /* 22px while the panel had over a hundred px unused beneath the last block.
     The phylum key below now spends most of that — the percentages in its
     pills carry it to six rows, and it has a caption — so the rhythm gave
     back four px per gap and sat at 18.
     27.75px since the rail dividers went to an even 28px: that handed this
     panel 39px it had no use for, which pooled under the country chips and
     left the phylum divider 67px below them against 28px everywhere else.
     Spread over the panel's gaps instead, it puts that divider back on the
     rhythm. Four gaps, not five, carry it: the one-liner's pull-up below grows
     by the same amount so it stays 5px under the SGB rule. The panel is one
     height for every species (see .sp-country-chips), so this is exact for
     all of them, not only the one on screen at load. */
  .detail-block .panel-content {
    gap: var(--detail-gap, 27.75px);
  }
  .detail-block .species-graphic {
    gap: 10px;
  }
  .detail-block .genome-meter,
  .detail-block .sp-statline,
  .detail-block .sp-countries {
    padding: 0;
  }
  /* The last row's bottom margin draws nothing but still counts toward the
     panel's scroll height, and with the panel now fitted to within 4px it was
     what tipped .detail-scroll into a scrollbar. */
  .detail-block .sp-countries {
    margin-bottom: 0;
  }
  /* Within a block, one step looser as well, so the added rhythm between
     blocks doesn't make each block look tighter by comparison. */
  .detail-block .genome-meter {
    gap: 9px;
  }
  .detail-block .sp-statline {
    gap: 10px 8px;
  }
  .detail-block .sp-countries {
    gap: 10px 11px;
  }

  /* Known / Unknown + Non / Western: medium circular select buttons */
  /* ===== Option 1: nested-pair button rows + per-button captions =====
     Two visually-grouped pairs: a small gap within each pair, a larger gap
     between the two pairs. Each button carries a short caption beneath it. */
  /* Stacked variant (Prevalence, 6 buttons): a 3-column grid, two rows. Column
     gap is the larger between-pair space, row gap the small within-pair space.
     Grid keeps the second row of buttons aligned across columns even when the
     first-row captions differ in height. */
  /* Prevalence circles match the standard 150px select buttons — same size
     as Known/Unknown; there's enough vertical room now for full-size circles. */

  /* Country picker: 4 columns × 2 rows. Cells are equal-width regardless of
     label length so the grid stays uniform. */
  .country-row {
    display: grid;
    grid-template-columns: repeat(var(--per-group, 4), 1fr);
    grid-auto-rows: max-content;
    row-gap: 22px;
    column-gap: 12px;
    justify-items: center;
    align-items: start;
    padding-top: var(--country-row-pad, 10px);
  }

  /* A column, not a row: .ls-pct is a SIBLING of the circle, so while this was
     `display:flex` with the default row direction the caption sat beside the
     globe and ran into the next one along. Stacking it puts the caption under
     the country's name, which is what its centred text and top margin were
     written for. */
  .country-cell {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: flex-start;
    width: 100%;
    min-width: 0;
  }

  /* Bacteria Species Details enrichment header */
  /* Species detail-card styling — the .panel-content species / lineage / genome
     meter / stat-line rules are shared with the anthromes panel; see
     src/shared/styles.css, which also documents the 16.6px type floor that both
     panels size up from. */

  /* Country breakdown — full big-number treatment by default; collapses to a
     single-line summary when a species is also being inspected (see the
     .country-breakdown--compact variant) so the rail doesn't overflow. */
  /* High-level "big number" row — one large numeral per metric with a small
     label underneath. Magazine layout, three columns. */
  /* Split-bar treatment for the Known/Unknown takeaway */
  /* Legacy — kept in case Option 1 revives it */
  /* Cohort ranked bubbles — used by the Split arrangement */
  /* ===== Bottom tier: phylum key ===== */
  .phylum-band {
    display: flex;
    flex-direction: column;
    gap: 13px;
    min-height: 0;
  }

  .phylum-band-head {
    display: flex;
    /* Baseline, mirroring .fblock-headrow: "All" sits on the headline's first
       line whether or not the one-liner wraps. */
    align-items: baseline;
    justify-content: space-between;
    gap: 15px;
  }

  /* Hugs the headline it qualifies rather than sitting midway between it and
     the pills — heading, caption, key, not three evenly spaced bands. Mirrors
     .key-scope on the anthromes rail. */
  .phylum-scope {
    margin-top: -7px;
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

  /* Flat pill key, sized to content so it doesn't strand vertical space. */
  .phylum-key--pills {
    display: flex;
    flex-wrap: wrap;
    gap: 9px;
    align-content: flex-start;
    min-height: 0;
    max-height: none;
  }

  /* ===== Options 1-3: Western / Non-Western lifestyle rows ===== */
  .ls-row + .ls-row {
    margin-top: var(--ls-row-gap, 20px);  /* breathing room between the two groups; mirrored */
  }

  .ls-row-desc {
    font-size: 16px;
    line-height: 1.3;
    opacity: 0.62;
  }

  /* The description IS the row head, so it takes the title's weight — larger,
     full white, no dimming. Sized between a heading (21px) and .ls-row-desc
     (16px) so it reads as a lead-in rather than a heading. */
  .ls-row-head--promoted .ls-row-desc {
    font-size: 19px;
    line-height: 1.32;
    color: #fff;
    opacity: 1;
  }

  .country-row--ls {
    gap: 16px;
  }

  /* Percentage caption under each circle. Tabular figures so the numerals in a
     row line up regardless of digit widths. */
  .ls-pct {
    display: block;
    margin-top: 4px;
    text-align: center;
    line-height: 1.2;
    font-size: 14px;
    font-weight: 400;
    letter-spacing: 0.01em;
    font-variant-numeric: tabular-nums;
    opacity: 0.78;
  }

  /* Compact key pill; colour = phylum. A legend entry, not a control: the
     same shape as the anthromes key-pill but with no selected/dimmed state. */
  .phylum-dot {
    display: inline-flex;
    align-items: center;
    height: 41px;
    padding: 0 17px;
    border-radius: 11.5px;
    border: 1.3px solid rgba(0, 0, 0, 0.18);
    white-space: nowrap;
    box-sizing: border-box;
    user-select: none;
  }

  .phylum-dot span {
    font-size: 17px;
    font-weight: 500;
    line-height: 1;
    letter-spacing: 0.01em;
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
    overflow: var(--detail-overflow, auto);
  }

  .panel-content {
    font-size: 17px;
    color: var(--muted);
    line-height: 1.5;
    display: grid;
    /* Rows size to their content and stack from the top. Without this, grid's
       default align-content:stretch spreads the panel's leftover height evenly
       across every row — so each block (the SGB title, the glyph row, the
       genome meter) sat in a box ~37px taller than itself, reading as slack
       under each heading rather than as space at the foot of the panel. */
    align-content: start;
    gap: 14px;              /* looser than the anthromes detail panel's 11px */
    overflow: var(--detail-overflow, auto);
  }

  /* Detail-panel content typography (.panel-content .title/.subtitle/.summary/
     .kv/.swatch/.pill) is shared — see src/shared/styles.css. */

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

  :global(html[data-layout="stacked"]) .rail {
    order: 2;
    height: auto;
    overflow: visible;
  }

  /* The first section sits under the disk, not under the top of a rail, so it
     takes the divider the others have — which is also the rule the leader
     drops onto (see leaderPlumb). */
  :global(html[data-layout="stacked"]) .rail > :global(:first-child) {
    border-top: 1.3px solid rgba(255, 255, 255, 0.14);
    padding-top: var(--rail-div-below, 22px);
  }

  /* A legend, not a control: the page scrolls under a finger on it. */
  :global(html[data-layout="stacked"]) .phylum-key {
    touch-action: auto;
  }

</style>
