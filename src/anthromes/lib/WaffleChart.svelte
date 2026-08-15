<script>
  import { onMount, untrack } from 'svelte';
  import { createEventDispatcher } from 'svelte';
  import * as d3 from 'd3';
  import { elementScale } from '../../shared/stage.svelte.js';
  import MapCanvas from './MapCanvas.svelte';
  import { TOPO_PROFILE } from './constants.js';
  import { formatYearLabel } from './dataAdapter.js';
  import {
    SWAP_PHASE_MS,
    SWAP_STAGGER_MS,
    SWAP_SEG_MS
  } from '../../shared/swapTransition.js';

  let {
    data = [],
    years = [],
    colorMapping = {},
    labelMapping = {},
    orderedCodes = [],
    legend = {},
    selectedAnthromes = $bindable([]),
    selectedYear = $bindable(null),
    size = 'full',
    debugMenuVisible = false,
    showBoundaries = false,
    mapReady = $bindable(false),
    mapScale = $bindable(1),
    mapRotation = 0,
    mapPanX = $bindable(0),
    mapPanY = $bindable(0),
    barChartData = $bindable(null),
    cellSeries = $bindable(null),
    showBarChart = $bindable(false),
    isolationReset = $bindable(0),
    cellIsolated = $bindable(false),
    panelCloseSignal = 0,
    connectorStart = $bindable(null),
    focusIso3 = $bindable(null),
    rangeIso3s = $bindable(new Set()),
    rangeSource = $bindable(null),
    // Per-year anthrome shares for the focused country, shaped
    // { "1850AD": { "61": 0.42, ... } }. When set, the ring plots this instead
    // of the world-wide distribution and swaps with an animated transition.
    countryDistribution = null,
    // Option 1's country semantics: the picked country is the primary state —
    // it owns the highlight, the framing AND the ring's distribution — so it
    // survives incidental gestures (panning, clicking dead space) and is
    // released only by an explicit one (isolating a cell, re-clicking the
    // bubble, Reset). The older arrangements treat it as a side note and let a
    // pan or an outside click drop it, so they leave this off.
    strictCountryFocus = false,
    // Option 1 renders the cell's country facts as a rail pill, so MapCanvas
    // omits them from the detail HTML.
    compactCellDetail = false,
    // The isolated cell's live position in design px — the leader's start.
    isolatedPoint = $bindable(null),
    // Map tile resolution (see TOPO_PROFILES); switchable from the settings panel.
    profile = TOPO_PROFILE,
  } = $props();

  const fullSize = 7000;
  const previewSize = 1200;

  let svgElement = $state(null);
  let chartContainer = $state(null);

  // Map tooltip state (bound to MapCanvas via bind:)
  let mapTooltipVisible = $state(false);
  let mapTooltipX = $state(0);
  let mapTooltipY = $state(0);
  let mapTooltipContent = $state('');
  let mapTooltipMeta = $state(null);
  let mapTooltipPinned = $state(false);

  // Unified info panel
  let panelVisible = $state(false);
  let panelContent = $state('');
  let panelPinned = $state(false);
  let panelMeta = $state(null);
  const dispatch = createEventDispatcher();

  let mapZoom = $state({ k: 1, x: 0, y: 0 });
  let containerWidth = $state(0);
  let containerHeight = $state(0);
  let innerRadiusPx = $state(0);

  // Map pan state — backed by bindable props so parent can reset via bind:mapPanX/Y
  let panning = $state(false);
  let panStart = { x: 0, y: 0, px: 0, py: 0 };
  // Track whether this pointerdown has produced actual movement yet.
  // closePanel/isolationReset fire only on first real movement, not on simple clicks,
  // to avoid a race where the reset effect fires after handleCanvasClick isolates a cell.
  let panHasMoved = false;

  const SCROLL_ZOOM_MIN = 0.5;
  const SCROLL_ZOOM_MAX = 8;

  // Cursor state — grab only inside inner circle
  let hoverInCircle = $state(false);

  // Pointer events arrive in screen px, but innerRadiusPx and mapPanX/Y are
  // design px. getBoundingClientRect() reports the stage-transformed box while
  // clientWidth stays in layout px, so their ratio is the stage scale as seen
  // here — divide screen deltas by it to get back to design space.
  function offsetFromCenter(event, rect) {
    const s = elementScale(chartContainer, rect);
    return {
      dx: (event.clientX - (rect.left + rect.width / 2)) / s,
      dy: (event.clientY - (rect.top + rect.height / 2)) / s,
      s
    };
  }

  function handlePanStart(event) {
    if (panning || !chartContainer || !innerRadiusPx) return;
    const rect = chartContainer.getBoundingClientRect();
    const { dx, dy, s } = offsetFromCenter(event, rect);
    if (dx * dx + dy * dy > innerRadiusPx * innerRadiusPx) return;
    panning = true;
    panHasMoved = false;
    panStart = { x: event.clientX, y: event.clientY, px: mapPanX, py: mapPanY, s };
    event.preventDefault();
    window.addEventListener('pointermove', handlePanMove);
    window.addEventListener('pointerup', handlePanEnd, { once: true });
  }

  function handlePanMove(event) {
    if (!panHasMoved) {
      panHasMoved = true;
      // Under strictCountryFocus a pan is purely a view gesture: it moves the
      // camera and changes no selection at all. The country keeps its
      // highlight, an isolated cell keeps its panel, and the leader line
      // simply follows the cell across the disk. The older arrangements treat
      // a pan as "free-explore" and drop both.
      if (strictCountryFocus) return;
      closePanel();
      isolationReset++;
      if (focusIso3) focusIso3 = null;
    }
    const s = panStart.s || 1;
    mapPanX = panStart.px + (event.clientX - panStart.x) / s;
    mapPanY = panStart.py + (event.clientY - panStart.y) / s;
  }

  function handlePanEnd() {
    panning = false;
    window.removeEventListener('pointermove', handlePanMove);
  }

  function handleContainerMove(event) {
    if (panning || !chartContainer || !innerRadiusPx) return;
    const rect = chartContainer.getBoundingClientRect();
    const { dx, dy } = offsetFromCenter(event, rect);
    hoverInCircle = dx * dx + dy * dy <= innerRadiusPx * innerRadiusPx;
  }

  function handleWheel(event) {
    if (!chartContainer || !innerRadiusPx) return;
    const rect = chartContainer.getBoundingClientRect();
    const { dx, dy } = offsetFromCenter(event, rect);
    // Only zoom when the pointer is inside the inner circle (the map area).
    if (dx * dx + dy * dy > innerRadiusPx * innerRadiusPx) return;

    event.preventDefault();

    // Normalize delta across mouse wheel (deltaMode 1 = lines, 2 = pages) and
    // trackpad (deltaMode 0 = pixels). A factor of ~0.999 per pixel gives a
    // comfortable ~10% change per 100 px of scroll on both input types.
    let delta = event.deltaY;
    if (event.deltaMode === 1) delta *= 16;   // lines → pixels approximation
    if (event.deltaMode === 2) delta *= 400;  // pages → pixels approximation

    const oldScale = mapScale;
    const factor = Math.pow(0.999, delta);
    const newScale = Math.min(SCROLL_ZOOM_MAX, Math.max(SCROLL_ZOOM_MIN, oldScale * factor));
    const clampedFactor = newScale / oldScale;

    // Zoom to cursor: adjust pan so the point under the pointer stays fixed.
    // dx/dy is the cursor offset from the container center, in design px.
    mapPanX = dx + clampedFactor * (mapPanX - dx);
    mapPanY = dy + clampedFactor * (mapPanY - dy);
    mapScale = newScale;
  }

  function closePanel() {
    panelVisible = false;
    panelPinned = false;
    panelMeta = null;
    connectorStart = null;
    mapTooltipPinned = false;
    mapTooltipVisible = false;
    mapTooltipContent = '';
    mapTooltipX = 0;
    mapTooltipY = 0;
    dispatch('detail-close');
  }

  function showPanel(html, x = null, y = null, pinned = false, meta = undefined) {
    if (meta !== undefined) panelMeta = meta;
    if (!html) panelMeta = null;
    panelContent = html;
    panelVisible = !!html;
    if (panelVisible) {
      if (x != null && y != null) connectorStart = { x, y };
      if (pinned) panelPinned = true;
      dispatch('detail', { content: html, meta: panelMeta });
    } else {
      dispatch('detail-close');
    }
  }

  export function handlePanelAction(event) {
    // Match both old <button> actions and the new inline <a class="detail-link">.
    const btn = event.target.closest('[data-act]');
    if (!btn) return;
    const act = btn.getAttribute('data-act');
    if (act === 'highlight-biomes') {
      const sgbs = btn.getAttribute('data-sgbs');
      if (sgbs) {
        const base = import.meta.env.BASE_URL;
        sessionStorage.setItem('highlightSGBs', sgbs);
        window.location.href = `${base}src/biomes/index.html?highlightSGBs=session`;
      }
    }
  }

  let yearAngles = $state(new Map());

  let mapYear = $state(null);
  let yearPreview = $state(null);
  let draggingYear = $state(false);
  const defaultPoints = [[-109, 27], [40, 10]]; //previously [117,33],[36,4] ; -109, 26, 40 ,10
  let mapPoints = $state(defaultPoints.map(p => [...p]));
  let clipAngle = $state(180);

  // Whichever distribution the ring is currently plotting: the world-wide
  // per-year counts, or — when a country is focused — that country's per-year
  // anthrome shares reshaped into the same {year, counts, total, percentages}
  // rows the world data uses.
  //
  // Shares are renormalised so every year sums to exactly COUNTRY_TOTAL. The
  // source fractions are rounded to 2dp and can land a few millionths off 1,
  // which would otherwise make the ring's outer edge visibly ragged; the world
  // data has a constant total per year, so the two views want to fill the same
  // radial band identically.
  const COUNTRY_TOTAL = 10000;

  const activeData = $derived.by(() => {
    if (!countryDistribution || !years.length || !orderedCodes.length) return data;
    return years.map(year => {
      const dist = countryDistribution[year] || {};
      const sum = orderedCodes.reduce((s, code) => s + (dist[String(code)] || 0), 0);
      const norm = sum > 0 ? 1 / sum : 0;
      const counts = {};
      const percentages = {};
      for (const code of orderedCodes) {
        const share = (dist[String(code)] || 0) * norm;
        counts[code] = share * COUNTRY_TOTAL;
        percentages[String(code)] = share * 100;
      }
      return { year, counts, total: COUNTRY_TOTAL, percentages };
    });
  });

  // Identifies which dataset is on screen, so the render effect can tell a
  // "same data, re-layout" pass from a genuine world <-> country swap.
  const activeKey = $derived(countryDistribution ? `country:${focusIso3 ?? '?'}` : 'world');

  // Memoized computed values using $derived
  const stackedData = $derived.by(() => {
    const rows = activeData;
    if (!rows.length || !orderedCodes.length || !years.length) return null;

    performance.mark('stack-start');
    const labels = orderedCodes.map(code => labelMapping[code]).filter(Boolean);

    const dataByYear = rows.map(d => {
      const obj = {};
      Object.keys(d.counts).forEach(code => {
        const label = labelMapping[code];
        if (label) {
          obj[label] = d.counts[code] || 0;
        }
      });
      return [d.year, obj];
    });

    const stack = d3.stack()
      .keys(labels)
      .value((yearEntry, key) => yearEntry[1][key] || 0)
      (dataByYear);

    const totalsByYear = new Map(rows.map(d => [d.year, d.total]));

    performance.mark('stack-end');
    performance.measure('stack-computation', 'stack-start', 'stack-end');

    return { stack, labels, dataByYear, totalsByYear };
  });

  // World-wide rows only — MapCanvas reads this to state each cell's share of
  // the Earth's surface, which must not change when a country is focused.
  const yearDataLookup = $derived.by(() => new Map(data.map(d => [d.year, d])));

  const layout = $derived.by(() => {
    if (!stackedData) return null;

    performance.mark('layout-start');
    const dim = size === 'full' ? fullSize : previewSize;
    const outerMargin = size === 'full' ? 200 : 150;
    const radius = dim / 2 - outerMargin;
    // Target a thicker ring (~50% of radial span)
    // Slightly thinner ring (about 1/3 thinner than previous)
    const innerRadius = radius * 0.75;

    const angle = d3.scaleBand()
      .domain(years)
      .range([0, 2 * Math.PI])
      .align(0);

    const maxCount = d3.max(stackedData.stack[stackedData.stack.length - 1], d => d[1]);
    const rScale = d3.scaleLinear()
      .domain([0, maxCount])
      .range([innerRadius, radius]);

    performance.mark('layout-end');
    performance.measure('layout-computation', 'layout-start', 'layout-end');

    return { dim, radius, innerRadius, angle, rScale };
  });

  // Update innerRadiusPx when layout or container size changes
  $effect(() => {
    if (!layout || !containerWidth || !containerHeight) return;
    const pxPerUnit = Math.min(containerWidth, containerHeight) / layout.dim;
    innerRadiusPx = layout.innerRadius * pxPerUnit;
  });

  const EARTH_RADIUS_KM = 6371.0088;
  const EARTH_SURFACE_KM2 = 4 * Math.PI * EARTH_RADIUS_KM * EARTH_RADIUS_KM;

  function createTooltipData(d) {
    const code = Object.keys(labelMapping).find(k => labelMapping[k] === d.label);
    const color = colorMapping[code] || '#ccc';
    const yearEntry = yearDataLookup?.get(d.year);
    const percent = yearEntry?.percentages?.[String(code)];
    const percentDisplay = percent != null ? `${percent.toFixed(2)}%` : '—';
    const globalAreaKm2 = percent != null ? (percent / 100) * EARTH_SURFACE_KM2 : null;
    const globalAreaDisplay = globalAreaKm2 != null ? `${Math.round(globalAreaKm2).toLocaleString()} km²` : '—';
    const yearLabel = formatYearLabel(d.year);

    const html = `
      <div class="tip-head">
        <span class="chip" style="background:${color}"></span>
        <div>
          <div class="title">${d.label}</div>
          <div class="subtitle">Year ${yearLabel}</div>
        </div>
      </div>
      <div class="summary">In <b>${yearLabel}</b>, <b>${d.label}</b> covers <b>${globalAreaDisplay}</b>, or <b>${percentDisplay}</b> of the Earth's surface.</div>
    `;
    return {
      html,
      meta: {
        code,
        label: d.label,
        color,
        year: yearLabel
      }
    };
  }

  /**
   * Arc generator for the ring segments, with a `t` that pulls every radius
   * toward the inner edge: t = 1 is the segment at full extent, t = 0 is a
   * zero-thickness sliver sitting on the map's rim. The world <-> country swap
   * animates t so segments collapse into and grow back out of the disk.
   */
  function makeSegmentArc(lay, t = 1) {
    const { rScale, angle, innerRadius } = lay;
    const toward = (v) => innerRadius + (rScale(v) - innerRadius) * t;
    return d3.arc()
      .innerRadius(d => toward(d.seg[0]))
      .outerRadius(d => toward(d.seg[1]))
      .startAngle(d => angle(d.year))
      .endAngle(d => angle(d.year) + angle.bandwidth())
      .padAngle(0.006)
      .padRadius(innerRadius);
  }

  // The layout the ring on screen was actually drawn with. The swap animation
  // needs it: by the time the effect fires, `layout` already holds the INCOMING
  // dataset's rScale, and running the outgoing segments' values through that
  // scale would snap them to a wildly wrong radius before they collapse.
  let renderedLayout = null;

  function renderChart() {
    if (!svgElement || !stackedData || !layout) return;
    renderedLayout = layout;

    const { dim, radius, innerRadius, angle, rScale } = layout;
    const svg = d3.select(svgElement);

    svg.attr('viewBox', `${-dim / 2} ${-dim / 2} ${dim} ${dim}`);

    // Ensure zoom container exists
    let zoomGroup = svg.select('g.zoom-container');
    if (zoomGroup.empty()) {
      zoomGroup = svg.append('g').attr('class', 'zoom-container');
    }
    zoomGroup.selectAll('*').remove();

    zoomGroup.attr('transform', 'rotate(-90)');

    let defs = svg.select('defs');
    if (defs.empty()) {
      defs = svg.append('defs');
    }
    defs.selectAll('*').remove();

    const g = zoomGroup.append('g');

    g.append('circle')
      .attr('class', 'map-mask-stroke')
      .attr('r', innerRadius)
      .attr('cx', 0)
      .attr('cy', 0);

    // Gap ring: thin dark border between the map and the waffle slices
    g.append('circle')
      .attr('class', 'map-gap-ring')
      .attr('r', innerRadius)
      .attr('cx', 0)
      .attr('cy', 0);

    // Stack layers
    const arc = makeSegmentArc(layout, 1);

    const arcHit = d3.arc()
      .innerRadius(d => Math.max(0, rScale(d.seg[0]) - 8))
      .outerRadius(d => rScale(d.seg[1]) + 8)
      .startAngle(d => angle(d.year))
      .endAngle(d => angle(d.year) + angle.bandwidth())
      .padAngle(0.012)
      .padRadius(innerRadius);

    const layers = g.selectAll('g.layer')
      .data(stackedData.stack, d => d.key)
      .join('g')
      .attr('class', 'layer')
      .attr('fill', d => {
        const code = Object.keys(labelMapping).find(k => labelMapping[k] === d.key);
        return colorMapping[code] || '#ccc';
      });

    layers.selectAll('path.segment')
      .data(d => d.map(seg => ({ label: d.key, year: seg.data[0], seg: [seg[0], seg[1]] })))
      .join('path')
      .attr('class', 'segment')
      .attr('d', arc)
      .attr('data-key', d => `${d.year}__${d.label}`);

    layers.selectAll('path.hit')
      .data(d => d.map(seg => ({ label: d.key, year: seg.data[0], seg: [seg[0], seg[1]] })))
      .join('path')
      .attr('class', 'hit')
      .attr('d', arcHit)
      .attr('data-key', d => `${d.year}__${d.label}`)
      .on('click', function(_event, d) {
        // Changing the year is a time gesture, not a selection gesture: an
        // isolated cell stays isolated and MapCanvas restates it for the new
        // year. Dropping the isolation here made the ring unusable as a scrub
        // control whenever a cell was open.
        commitYear(d.year);
      });

    // Radial grid
    const tickCount = 6;
    const ticks = rScale.ticks(tickCount);
    g.append('g')
      .attr('class', 'axis-circles')
      .selectAll('circle')
      .data(ticks)
      .join('circle')
      .attr('r', rScale);

    // Year axis + labels
    const labelRadius = radius + 50;
    yearAngles = new Map();
    const yearAxis = g.append('g').attr('class', 'year-axis');

    const yearNodes = yearAxis.selectAll('g.year-node')
      .data(years, d => d)
      .join(enter => {
        const node = enter.append('g').attr('class', 'year-node');
        node.append('line').attr('class', 'year-tick');
        node.append('text')
          .attr('class', 'year-label')
          .attr('data-year', d => d)
          .on('click', (event, yr) => {
            event.stopPropagation();
            commitYear(yr);
          });
        return node;
      });

    yearNodes.each(function(yr) {
      const a = angle(yr) + angle.bandwidth() / 2 - Math.PI / 2;
      yearAngles.set(yr, a);
      const x1 = Math.cos(a) * radius;
      const y1 = Math.sin(a) * radius;
      const x2 = Math.cos(a) * (radius + 10);
      const y2 = Math.sin(a) * (radius + 10);
      const lx = Math.cos(a) * labelRadius;
      const ly = Math.sin(a) * labelRadius;
      const rot = (a * 180) / Math.PI + 90;
      const isTop = Math.cos(a) > 0;
      let flipY = Math.cos(a) > 0 ? 1 : -1;
      const node = d3.select(this);
      node.select('line')
        .attr('x1', x1).attr('y1', y1)
        .attr('x2', x2).attr('y2', y2)
        .attr('data-year', yr);
      node.select('text')
        .attr('transform', `translate(${lx},${ly}) rotate(${rot}) scale(${flipY}, ${isTop ? 1 : -1})`)
        .attr('text-anchor', 'middle')
        .attr('alignment-baseline', 'middle')
        .text(formatYearLabel(yr));
    });

    yearAxis.selectAll('path.year-bracket')
      .data(['inner', 'outer'])
      .join('path')
      .attr('class', d => `year-bracket year-bracket-${d}`)
      .attr('pointer-events', 'none');

    yearAxis.selectAll('g.year-drag-handle')
      .data([null])
      .join(enter => {
        const g = enter.append('g')
          .attr('class', 'year-drag-handle')
          .on('pointerdown', startYearDrag);

        g.append('path')
          .attr('class', 'year-handle-arc');

        return g;
      });

    updateYearHighlight();
  }

  const labelToCode = $derived.by(() => {
    const m = {};
    Object.keys(labelMapping).forEach(code => {
      m[labelMapping[code]] = Number(code);
    });
    return m;
  });

  // Mirrors the `.layer path.segment` / dimmed-segment rules below. The swap
  // animation tweens opacity numerically, so it needs the literal values;
  // applyFilters hands styling back to CSS the moment the swap is done.
  const SEGMENT_OPACITY = 0.92;
  const SEGMENT_DIM_OPACITY = 0.02;

  function segmentIsShown(d) {
    if (!orderedCodes.length) return true;
    if (selectedAnthromes.length === orderedCodes.length) return true;
    const code = labelToCode[d.label];
    return !!code && selectedAnthromes.includes(code);
  }

  function applyFilters() {
    if (!svgElement || !orderedCodes.length) return;

    const svg = d3.select(svgElement);
    const g = svg.select('g.zoom-container');

    const allAnthromesSelected = selectedAnthromes.length === orderedCodes.length;
    if (allAnthromesSelected) {
      g.classed('isolated', false);
      g.selectAll('.segment, .hit').style('opacity', null).style('pointer-events', null);
      return;
    }

    const selectedSet = new Set(selectedAnthromes);
    g.classed('isolated', true);

    g.selectAll('.segment').each(function() {
      const segment = d3.select(this);
      const d = segment.datum();
      const code = labelToCode[d.label];
      const show = code && selectedSet.has(code);
      segment.style('opacity', show ? null : 0.02)
        .style('pointer-events', show ? 'all' : 'none');
    });

    g.selectAll('.hit').each(function() {
      const hit = d3.select(this);
      const d = hit.datum();
      const code = labelToCode[d.label];
      const show = code && selectedSet.has(code);
      hit.style('opacity', show ? null : 0)
        .style('pointer-events', show ? 'all' : 'none');
    });
  }

  // ===== World <-> country ring swap =====
  //
  // The outgoing ring collapses into the disk staggered BACKWARDS through time
  // (2025 first, 10000BC last); once it has gone the incoming ring grows back
  // out staggered FORWARDS. Timing is shared with the details-panel pixel
  // timeline so the two read as one gesture — see swapTransition.js.
  const yearIndex = $derived(new Map(years.map((y, i) => [y, i])));

  let renderedKey = null;   // activeKey of the ring currently on screen
  let swapToken = 0;        // invalidates a swap that a newer one supersedes
  let swapTimers = [];

  function clearSwapTimers() {
    swapTimers.forEach(clearTimeout);
    swapTimers = [];
  }

  function animateSwap(nextKey) {
    const outLay = renderedLayout;
    if (!svgElement || !layout || !outLay) {
      renderChart();
      applyFilters();
      renderedKey = nextKey;
      return;
    }

    const token = ++swapToken;
    clearSwapTimers();

    const span = Math.max(1, years.length - 1);
    const svg = d3.select(svgElement);

    // Nothing is clickable mid-swap: for half of it there is no ring at all.
    svg.selectAll('path.hit').style('pointer-events', 'none');

    svg.selectAll('path.segment')
      .interrupt()
      .transition()
      .delay(d => ((span - (yearIndex.get(d.year) ?? 0)) / span) * SWAP_STAGGER_MS)
      .duration(SWAP_SEG_MS)
      .ease(d3.easeCubicIn)
      .attrTween('d', (d) => (t) => makeSegmentArc(outLay, 1 - t)(d))
      .style('opacity', 0);

    swapTimers.push(setTimeout(() => {
      if (token !== swapToken) return;

      // Rebuild from the incoming dataset while the ring is empty, then pin
      // every segment to the collapsed state before the browser paints it.
      renderChart();
      applyFilters();
      renderedKey = nextKey;

      const inLay = renderedLayout;
      const svgIn = d3.select(svgElement);
      svgIn.selectAll('path.hit').style('pointer-events', 'none');
      svgIn.selectAll('path.segment')
        .attr('d', makeSegmentArc(inLay, 0))
        .style('opacity', 0)
        .transition()
        .delay(d => ((yearIndex.get(d.year) ?? 0) / span) * SWAP_STAGGER_MS)
        .duration(SWAP_SEG_MS)
        .ease(d3.easeCubicOut)
        .attrTween('d', (d) => (t) => makeSegmentArc(inLay, t)(d))
        .style('opacity', d => (segmentIsShown(d) ? SEGMENT_OPACITY : SEGMENT_DIM_OPACITY));

      swapTimers.push(setTimeout(() => {
        if (token !== swapToken) return;
        // Hand styling back to CSS/applyFilters so nothing stays pinned to a
        // literal opacity, and make the ring clickable again.
        svgIn.selectAll('path.segment').interrupt().attr('d', makeSegmentArc(inLay, 1)).style('opacity', null);
        applyFilters();
      }, SWAP_PHASE_MS + 20));
    }, SWAP_PHASE_MS));
  }

  function angularDistance(a, b) {
    const diff = Math.abs(a - b) % (2 * Math.PI);
    return diff > Math.PI ? 2 * Math.PI - diff : diff;
  }

  function pointerToChartCoords(event) {
    if (!chartContainer || !layout) return null;
    const rect = chartContainer.getBoundingClientRect();
    // Ratio of chart units to the rendered box, so the stage scale divides out
    // on its own — this needs no separate transform correction.
    const scale = layout.dim / rect.width;
    const localX = (event.clientX - rect.left - rect.width / 2) * scale;
    const localY = (event.clientY - rect.top - rect.height / 2) * scale;
    // Inverse of rotate(-90): (localX, localY) -> (-localY, localX)
    return { x: -localY, y: localX };
  }

  function nearestYearFromPointer(event) {
    if (!yearAngles || yearAngles.size === 0) return null;
    const coords = pointerToChartCoords(event);
    if (!coords) return null;
    const theta = Math.atan2(coords.y, coords.x);
    let bestYear = null;
    let bestDiff = Infinity;
    yearAngles.forEach((ang, yr) => {
      const diff = angularDistance(theta, ang);
      if (diff < bestDiff) { bestDiff = diff; bestYear = yr; }
    });
    return bestYear;
  }

  function updateYearHighlight() {
    if (!svgElement || !layout || !yearAngles || yearAngles.size === 0) return;
    const displayYear = draggingYear ? yearPreview : selectedYear;
    if (!displayYear || !yearAngles.has(displayYear)) return;

    const { angle, innerRadius, radius } = layout;
    const startAngle = angle(displayYear);
    const endAngle = startAngle + angle.bandwidth();

    const innerBracket = d3.arc()
      .innerRadius(innerRadius - 22)
      .outerRadius(innerRadius - 4)
      .startAngle(startAngle)
      .endAngle(endAngle);

    const outerBracket = d3.arc()
      .innerRadius(radius + 4)
      .outerRadius(radius + 22)
      .startAngle(startAngle)
      .endAngle(endAngle);

    // Handle: half-disc sitting on the outer edge of the year bracket.
    // The outer bracket ends at radius + 22; HANDLE_OFFSET adds a small gap beyond it.
    // ↓ adjust this value to slide the disc in/out
    const HANDLE_OFFSET = 10; // SVG units beyond the ring edge (outer bracket = radius + 22)
    const handleBaseR = radius + HANDLE_OFFSET;

    // r_dome = semicircle radius whose diameter spans the year's chord at handleBaseR
    // ↓ adjust this multiplier to resize the dome (kept a comfortable grab
    //   target, but pulled back so it no longer crowds the year labels)
    const r_dome = handleBaseR * Math.sin(angle.bandwidth() / 2) * 1.15;

    // Base endpoints on the handle base circle
    const px_s = Math.sin(startAngle) * handleBaseR;
    const py_s = -Math.cos(startAngle) * handleBaseR;
    const px_e = Math.sin(endAngle) * handleBaseR;
    const py_e = -Math.cos(endAngle) * handleBaseR;

    // Path: flat arc along handle base (CW) then semicircular dome back (CCW = outward)
    // Open dome arc only — no flat base edge drawn.
    // SVG still fills the enclosed region (maintaining hit area) but only strokes the curve.
    const handlePath =
      `M ${px_e} ${py_e}` +
      ` A ${r_dome} ${r_dome} 0 1 0 ${px_s} ${py_s}`;

    const svg = d3.select(svgElement);

    // Reposition labels: selected gets shifted outward by half the extra font height
    // so the inner edge of all labels stays flush with the same imaginary circle.
    // The extra outward push (in SVG units) compensates for the larger CSS font size.
    const selectedOutwardShift = 20; // SVG units ≈ half the size difference (65px vs 52px) scaled to viewBox
    const labelRadius = radius + 50;
    svg.selectAll('.year-label')
      .classed('selected', d => d === displayYear)
      .each(function(yr) {
        const ang = yearAngles.get(yr);
        if (ang == null) return;
        const isSelected = yr === displayYear;
        const r = isSelected ? labelRadius + selectedOutwardShift : labelRadius;
        const lx = Math.cos(ang) * r;
        const ly = Math.sin(ang) * r;
        const rot = (ang * 180) / Math.PI + 90;
        const flipY = Math.cos(ang) > 0 ? 1 : -1;
        const isTop = Math.cos(ang) > 0;
        d3.select(this).attr('transform', `translate(${lx},${ly}) rotate(${rot}) scale(${flipY}, ${isTop ? 1 : -1})`);
      });

    svg.select('.year-bracket-inner').attr('d', innerBracket());
    svg.select('.year-bracket-outer').attr('d', outerBracket());

    svg.select('.year-drag-handle').attr('transform', null);
    svg.select('.year-handle-arc')
      .attr('d', handlePath)
      .attr('stroke-width', 18); // SVG user units — scaled with r_dome above
  }

  function startYearDrag(event) {
    event.stopPropagation();
    event.preventDefault();
    // Scrubbing the year keeps any isolated cell open — see the ring click
    // handler above for why.
    draggingYear = true;
    yearPreview = nearestYearFromPointer(event) || selectedYear;
    updateYearHighlight();
    window.addEventListener('pointermove', onYearDragMove);
    window.addEventListener('pointerup', onYearDragEnd, { once: true });
  }

  function onYearDragMove(event) {
    const yr = nearestYearFromPointer(event);
    if (yr) { yearPreview = yr; updateYearHighlight(); }
  }

  function onYearDragEnd(event) {
    const yr = nearestYearFromPointer(event) || yearPreview || selectedYear;
    draggingYear = false;
    commitYear(yr);
    window.removeEventListener('pointermove', onYearDragMove);
  }

  function commitYear(year) {
    if (!year) return;
    selectedYear = year;
    mapYear = year;
    yearPreview = year;
    updateYearHighlight();
  }


  onMount(() => {
    if (!selectedYear && years.length) {
      selectedYear = years[years.length - 1];
    }
    mapYear = selectedYear;
    yearPreview = selectedYear;

    if (chartContainer) {
      // Layout px, not getBoundingClientRect() — the latter reports the
      // stage-transformed box, which would size the map to the scaled view.
      // (ResizeObserver's contentRect below is already untransformed.)
      containerWidth = chartContainer.clientWidth;
      containerHeight = chartContainer.clientHeight;

      const ro = new ResizeObserver(entries => {
        const r = entries[0].contentRect;
        containerWidth = r.width;
        containerHeight = r.height;
      });
      ro.observe(chartContainer);
    }

    const svg = d3.select(svgElement);
    svg.append('g').attr('class', 'zoom-container');
  });

  // Render chart when stackedData or layout change. A change of activeKey means
  // the ring is switching between the world and a country, which is the one
  // case that animates rather than redrawing outright.
  $effect(() => {
    if (!stackedData || !layout) return;
    const key = activeKey;

    performance.mark('render-start');
    untrack(() => {
      if (renderedKey !== null && renderedKey !== key) {
        animateSwap(key);
      } else {
        clearSwapTimers();
        swapToken++;
        renderChart();
        applyFilters();
        renderedKey = key;
      }
    });
    performance.mark('render-end');
    performance.measure('chart-render', 'render-start', 'render-end');
  });

  $effect(() => () => clearSwapTimers());

  // Apply filters when selection changes
  $effect(() => {
    selectedAnthromes.length;
    applyFilters();
  });

  // Keep map year in sync with selected year
  $effect(() => {
    if (selectedYear) {
      untrack(() => {
        mapYear = selectedYear;
        updateYearHighlight();
      });
    }
  });

  // Sync mapScale/rotation to MapCanvas (map only; bars stay static).
  $effect(() => {
    mapScale;
    mapRotation;
    containerWidth;
    containerHeight;
    layout;

    untrack(() => {
      if (!layout || !containerWidth || !containerHeight) return;
      mapZoom = {
        k: mapScale,
        x: 0,
        y: 0
      };
    });
  });

  // Route map tooltip changes to the unified info panel
  $effect(() => {
    const vis = mapTooltipVisible;
    const content = mapTooltipContent;
    const x = mapTooltipX;
    const y = mapTooltipY;
    const pinned = mapTooltipPinned;
    const meta = mapTooltipMeta;

    untrack(() => {
      if (panelPinned && !pinned) { closePanel(); return; } // map tooltip cleared — close panel
      if (vis || pinned) {
        showPanel(content, x, y, pinned, meta ?? null);
      } else {
        if (!panelPinned) showPanel('');
      }
    });
  });

  // Keep the leader anchored to the cell itself. showPanel seeds connectorStart
  // from the click position; MapCanvas then republishes the cell's projected
  // centre on every repaint, so the line tracks it through pans, zooms and year
  // changes instead of staying where the pointer happened to be.
  $effect(() => {
    const p = isolatedPoint;
    untrack(() => {
      if (!p || !panelVisible) return;
      connectorStart = p;
    });
  });

  // Close panel when parent signals a reset
  $effect(() => {
    const sig = panelCloseSignal;
    if (sig > 0) {
      untrack(() => closePanel());
    }
  });
</script>

<div class="chart-container" bind:this={chartContainer} onpointerdown={handlePanStart} onpointermove={handleContainerMove} onpointerleave={() => { hoverInCircle = false; }} onwheel={handleWheel} class:panning class:in-circle={hoverInCircle}>
  <MapCanvas
    width={containerWidth}
    height={containerHeight}
    innerRadiusPx={innerRadiusPx}
    {profile}
    year={mapYear}
    legend={legend}
    yearDataLookup={yearDataLookup}
    selectedCodes={selectedAnthromes}
    zoom={mapZoom}
    rotation={mapRotation}
    bind:points={mapPoints}
    bind:mapReady
    {clipAngle}
    {showBoundaries}
    {debugMenuVisible}
    bind:mapPanX
    bind:mapPanY
    bind:mapScale
    bind:tooltipVisible={mapTooltipVisible}
    bind:tooltipX={mapTooltipX}
    bind:tooltipY={mapTooltipY}
    bind:tooltipContent={mapTooltipContent}
    bind:tooltipMeta={mapTooltipMeta}
    bind:tooltipPinned={mapTooltipPinned}
    bind:showBarChart
    bind:barChartData
    bind:cellSeries
    bind:cellIsolated
    isolationReset={isolationReset}
    bind:focusIso3
    {strictCountryFocus}
    {compactCellDetail}
    bind:isolatedPoint
    bind:rangeIso3s
    bind:rangeSource
  />

  {#if debugMenuVisible}
    <div class="debug-panel">
      <div class="debug-header">Projection Debug</div>

      <div class="debug-section">
        <div class="debug-label">Point A (Longitude, Latitude)</div>
        <div class="debug-inputs">
          <input
            type="number"
            step="0.1"
            value={mapPoints[0][0]}
            oninput={(e) => {
              const newPoints = [[parseFloat(e.target.value), mapPoints[0][1]], mapPoints[1]];
              mapPoints = newPoints;
            }}
            placeholder="Lon"
          />
          <input
            type="number"
            step="0.1"
            value={mapPoints[0][1]}
            oninput={(e) => {
              const newPoints = [[mapPoints[0][0], parseFloat(e.target.value)], mapPoints[1]];
              mapPoints = newPoints;
            }}
            placeholder="Lat"
          />
        </div>
      </div>

      <div class="debug-section">
        <div class="debug-label">Point B (Longitude, Latitude)</div>
        <div class="debug-inputs">
          <input
            type="number"
            step="0.1"
            value={mapPoints[1][0]}
            oninput={(e) => {
              const newPoints = [mapPoints[0], [parseFloat(e.target.value), mapPoints[1][1]]];
              mapPoints = newPoints;
            }}
            placeholder="Lon"
          />
          <input
            type="number"
            step="0.1"
            value={mapPoints[1][1]}
            oninput={(e) => {
              const newPoints = [mapPoints[0], [mapPoints[1][0], parseFloat(e.target.value)]];
              mapPoints = newPoints;
            }}
            placeholder="Lat"
          />
        </div>
      </div>

      <div class="debug-section">
        <div class="debug-label">Clip Angle</div>
        <input
          type="number"
          step="1"
          value={clipAngle}
          oninput={(e) => clipAngle = parseFloat(e.target.value)}
          placeholder="Angle"
          class="full-width"
        />
      </div>

      <div class="debug-section">
        <button
          class="reset-btn"
          type="button"
          onclick={() => {
            mapPoints = defaultPoints.map(p => [...p]);
          }}
        >
          Reset projection points
        </button>
      </div>
    </div>
  {/if}

  <svg bind:this={svgElement} id="chart"></svg>

</div>

<!-- Info panel now emitted to parent rail via detail events -->

<style>
  .chart-container {
    width: 100%;
    height: 100%;
    display: grid;
    place-items: center;
    position: relative;
    overflow: visible;
    touch-action: none;
  }

  .chart-container.in-circle {
    cursor: grab;
  }

  .chart-container.panning {
    cursor: grabbing;
  }

  svg {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: contain;
    background: transparent;
    position: absolute;
    inset: 0;
    z-index: 2;
    pointer-events: none;
    /* The year grab handle sits at the disk's 9-o'clock edge and overflows the
       SVG's left viewport edge (the column seam). Outermost <svg> defaults to
       overflow:hidden, which slices the handle at a vertical line — override it.
       (.viz-area z-index:6 then paints the overflow above the rail.) */
    overflow: visible;
  }

  :global(.layer path.segment) {
    vector-effect: non-scaling-stroke;
    stroke-linecap: round;
    stroke: none;
    opacity: 0.92;
    pointer-events: all;
  }

  :global(.segment.is-selected) {
    opacity: 1;
    filter: drop-shadow(0 0 10px rgba(0, 0, 0, 0.5));
  }

  :global(.hit) {
    fill: rgba(0, 0, 0, 0);
    pointer-events: all;
  }

  :global(.axis-circles circle) {
    stroke: #ffffff;
    stroke-opacity: 0.45;
    fill: none;
    stroke-dasharray: 2, 2;
  }

  :global(.year-axis line) {
    stroke: #ffffff;
    stroke-opacity: 0.6;
  }

  :global(.year-axis text) {
    fill: #ffffff;
    font-size: 52px;
    opacity: 0.95;
    font-weight: 800;
    letter-spacing: 0.08em;
    pointer-events: all;
  }

  :global(.year-axis text.selected) {
    fill: var(--accent);
    font-size: 65px;
  }

  :global(.year-bracket) {
    fill: #ffffff;
    opacity: 0.9;
  }

  :global(.year-drag-handle) {
    cursor: grab;
    pointer-events: all;
    filter: drop-shadow(0 8px 24px rgba(0, 0, 0, 0.45));
  }

  :global(.year-drag-handle:active) {
    cursor: grabbing;
  }

  :global(.year-handle-arc) {
    fill: rgba(0, 0, 0, 0.01); /* near-transparent but hittable */
    stroke: rgba(255, 255, 255, 0.9);
    transition: fill 0.18s ease;
  }

  :global(.year-drag-handle:active .year-handle-arc) {
    fill: rgba(255, 255, 255, 0.15);
  }

  :global(.map-mask-stroke) {
    fill: none;
    stroke: #ffffff;
    stroke-opacity: 0.3;
    stroke-width: 1.5;
  }

  :global(.map-gap-ring) {
    fill: none;
    stroke: #0e0b16;
    stroke-width: 24;
    pointer-events: none;
  }

  .debug-panel {
    position: absolute;
    top: 20px;
    left: 20px;
    background: rgba(14, 11, 22, 0.95);
    border: 1px solid rgba(255, 255, 255, 0.2);
    border-radius: 12px;
    padding: 16px;
    min-width: 280px;
    z-index: 1000;
    font-family: system-ui, -apple-system, sans-serif;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.5);
  }

  .debug-header {
    font-size: 14px;
    font-weight: 700;
    color: #ffffff;
    margin-bottom: 12px;
    letter-spacing: 0.05em;
    text-transform: uppercase;
  }

  .debug-section {
    margin-bottom: 12px;
  }

  .debug-label {
    font-size: 11px;
    color: #9ca3af;
    margin-bottom: 6px;
    font-weight: 500;
  }

  .debug-inputs {
    display: flex;
    gap: 8px;
  }

  .debug-panel input[type="number"] {
    background: rgba(255, 255, 255, 0.08);
    border: 1px solid rgba(255, 255, 255, 0.15);
    border-radius: 6px;
    padding: 6px 8px;
    color: #ffffff;
    font-size: 13px;
    font-family: 'SF Mono', Monaco, monospace;
    flex: 1;
    transition: border-color 0.15s ease;
  }

  .debug-panel input[type="number"]:focus {
    outline: none;
    border-color: var(--accent, #00d4ff);
  }

  .debug-panel input[type="number"].full-width {
    width: 100%;
  }

  .debug-panel input[type="number"]::-webkit-inner-spin-button,
  .debug-panel input[type="number"]::-webkit-outer-spin-button {
    opacity: 1;
  }

  .reset-btn {
    width: 100%;
    padding: 10px;
    border: 1px solid rgba(255, 255, 255, 0.2);
    border-radius: 8px;
    background: rgba(255, 255, 255, 0.06);
    color: #ffffff;
    font-weight: 600;
    cursor: pointer;
    transition: background 0.15s ease, border-color 0.15s ease;
  }

</style>
