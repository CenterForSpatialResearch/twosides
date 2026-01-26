<script>
  import { onMount, untrack } from 'svelte';
  import * as d3 from 'd3';
  import MapCanvas from './MapCanvas.svelte';
  import Tooltip from '../../shared/Tooltip.svelte';
  import { TOPO_PROFILE } from './constants.js';
  import { formatYearLabel } from './dataAdapter.js';

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
    mapReady = $bindable(false)
  } = $props();

  const fullSize = 7000;
  const previewSize = 1200;

  let svgElement = $state(null);
  let chartContainer = $state(null);

  let tooltipVisible = $state(false);
  let tooltipX = $state(0);
  let tooltipY = $state(0);
  let tooltipContent = $state('');
  let tooltipPinned = $state(false);

  let zoomTransform = $state(d3.zoomIdentity);
  let mapZoom = $state({ k: 1, x: 0, y: 0 });
  let containerWidth = $state(0);
  let containerHeight = $state(0);
  let innerRadiusPx = $state(0);
  let yearAngles = $state(new Map());

  let mapYear = $state(null);
  let yearPreview = $state(null);
  let draggingYear = $state(false);
  let mapPoints = $state([
    [-75, 41],
    [48, -15]
  ]);
  let clipAngle = $state(120);
  const defaultPoints = [
    [-75, 41],
    [48, -15]
  ];

  function zoomFilter(event) {
    if (draggingYear) return false;
    if (event.ctrlKey) return false;
    return true;
  }

  const zoomScale = d3.zoom()
    .filter(zoomFilter)
    .scaleExtent([1, 15])
    .on('zoom', (event) => {
      zoomTransform = event.transform;
      d3.select(svgElement).select('g.zoom-container').attr('transform', event.transform);
    });

  // Memoized computed values using $derived
  const stackedData = $derived.by(() => {
    if (!data.length || !orderedCodes.length || !years.length) return null;

    performance.mark('stack-start');
    const labels = orderedCodes.map(code => labelMapping[code]).filter(Boolean);

    const dataByYear = data.map(d => {
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

    const totalsByYear = new Map(data.map(d => [d.year, d.total]));

    performance.mark('stack-end');
    performance.measure('stack-computation', 'stack-start', 'stack-end');

    return { stack, labels, dataByYear, totalsByYear };
  });

  const yearDataLookup = $derived.by(() => new Map(data.map(d => [d.year, d])));

  const layout = $derived.by(() => {
    if (!stackedData) return null;

    performance.mark('layout-start');
    const dim = size === 'full' ? fullSize : previewSize;
    const outerMargin = 260;
    const radius = dim / 2 - outerMargin;
    const innerRadius = size === 'full' ? 2200 : Math.max(180, radius * 0.44);

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

  function createTooltipHTML(d) {
    const code = Object.keys(labelMapping).find(k => labelMapping[k] === d.label);
    const color = colorMapping[code] || '#ccc';
    const total = stackedData?.totalsByYear?.get(d.year) || 0;
    const count = d.seg[1] - d.seg[0];
    const pct = total > 0 ? ((count / total) * 100).toFixed(1) + '%' : '—';

    return `
      <div class="tip-head">
        <span class="chip" style="background:${color}"></span>
        <div>
          <div class="title">${d.label}</div>
          <div class="subtitle">Year ${formatYearLabel(d.year)}</div>
        </div>
      </div>
      <div class="summary">In <b>${formatYearLabel(d.year)}</b>, <b>${d.label}</b> accounts for <b>${count.toLocaleString()}</b> units (<b>${pct}</b> of the year's total).</div>
      <div class="kv">
        <div class="k">Year total</div><div>${total.toLocaleString()}</div>
        <div class="k">Segment value</div><div>${count.toLocaleString()}</div>
        <div class="k">Share</div><div>${pct}</div>
      </div>
    `;
  }

  function renderChart() {
    if (!svgElement || !stackedData || !layout) return;

    const { dim, innerRadius, radius, angle, rScale } = layout;
    const svg = d3.select(svgElement);

    svg.attr('viewBox', `${-dim / 2} ${-dim / 2} ${dim} ${dim}`);

    // Ensure zoom container exists
    let zoomGroup = svg.select('g.zoom-container');
    if (zoomGroup.empty()) {
      zoomGroup = svg.append('g').attr('class', 'zoom-container');
    }
    zoomGroup.selectAll('*').remove();

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

    // Stack layers
    const arc = d3.arc()
      .innerRadius(d => rScale(d.seg[0]))
      .outerRadius(d => rScale(d.seg[1]))
      .startAngle(d => angle(d.year))
      .endAngle(d => angle(d.year) + angle.bandwidth())
      .padAngle(0.006)
      .padRadius(innerRadius);

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
      .on('mousemove', function(event, d) {
        if (tooltipPinned) return;
        tooltipX = event.clientX;
        tooltipY = event.clientY;
        tooltipContent = createTooltipHTML(d);
        tooltipVisible = true;
      })
      .on('mouseover', function(event, d) {
        const key = `${d.year}__${d.label}`;
        d3.selectAll(`[data-key="${key}"]`).classed('is-hover', true);
        if (!tooltipPinned) {
          tooltipContent = createTooltipHTML(d);
          tooltipVisible = true;
        }
      })
      .on('mouseout', function(event, d) {
        const key = `${d.year}__${d.label}`;
        d3.selectAll(`[data-key="${key}"]`).classed('is-hover', false);
        if (!tooltipPinned) {
          tooltipVisible = false;
        }
      })
      .on('click', function(event, d) {
        tooltipPinned = !tooltipPinned;
        if (tooltipPinned) {
          tooltipX = event.clientX;
          tooltipY = event.clientY;
          tooltipContent = createTooltipHTML(d);
          tooltipVisible = true;
        } else {
          tooltipVisible = false;
        }
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
    const labelRadius = innerRadius - 30;
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
      const x1 = Math.cos(a) * (innerRadius - 6);
      const y1 = Math.sin(a) * (innerRadius - 6);
      const x2 = Math.cos(a) * innerRadius;
      const y2 = Math.sin(a) * innerRadius;
      const lx = Math.cos(a) * labelRadius;
      const ly = Math.sin(a) * labelRadius;
      const rot = (a * 180) / Math.PI + 90;
      const isTop = Math.sin(a) < 0;
      let flipY = Math.sin(a) > 0 ? -1 : 1; // bottom half flipped horizontally
      if (yr === '100AD') flipY = -flipY; // Special case: flip 100AD
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

    const handle = yearAxis.selectAll('circle.year-handle')
      .data([null])
      .join('circle')
      .attr('class', 'year-handle')
      .attr('r', 40)
      .on('pointerdown', startYearDrag);

    handle.raise();
    updateYearHighlight();
  }

  function applyFilters() {
    if (!svgElement || !orderedCodes.length) return;

    const svg = d3.select(svgElement);
    const g = svg.select('g.zoom-container');

    const labelToCode = {};
    Object.keys(labelMapping).forEach(code => {
      labelToCode[labelMapping[code]] = Number(code);
    });

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

  function updateYearHighlight() {
    if (!svgElement || !layout || !yearAngles || yearAngles.size === 0) return;
    const displayYear = draggingYear ? yearPreview : selectedYear;
    if (!displayYear || !yearAngles.has(displayYear)) return;

    const a = yearAngles.get(displayYear);
    const handleRadius = layout.innerRadius - 100;
    const hx = Math.cos(a) * handleRadius;
    const hy = Math.sin(a) * handleRadius;

    const svg = d3.select(svgElement);
    svg.selectAll('.year-label')
      .classed('selected', d => d === displayYear);

    svg.selectAll('.year-handle')
      .attr('cx', hx)
      .attr('cy', hy);
  }

  function angularDistance(a, b) {
    const diff = Math.abs(a - b) % (2 * Math.PI);
    return diff > Math.PI ? 2 * Math.PI - diff : diff;
  }

  function pointerToChartCoords(event) {
    if (!chartContainer || !layout) return null;
    const rect = chartContainer.getBoundingClientRect();
    const scale = layout.dim / rect.width;
    const localX = (event.clientX - rect.left - rect.width / 2) * scale;
    const localY = (event.clientY - rect.top - rect.height / 2) * scale;
    const t = zoomTransform || d3.zoomIdentity;
    const x = (localX - t.x) / t.k;
    const y = (localY - t.y) / t.k;
    return { x, y };
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
      if (diff < bestDiff) {
        bestDiff = diff;
        bestYear = yr;
      }
    });
    return bestYear;
  }

  function commitYear(year) {
    if (!year) return;
    selectedYear = year;
    mapYear = year;
    yearPreview = year;
    draggingYear = false;
    updateYearHighlight();
  }

  function startYearDrag(event) {
    event.stopPropagation();
    event.preventDefault();
    draggingYear = true;
    const yr = nearestYearFromPointer(event) || selectedYear;
    if (yr) yearPreview = yr;
    updateYearHighlight();

    window.addEventListener('pointermove', onYearDragMove);
    window.addEventListener('pointerup', onYearDragEnd, { once: true });
  }

  function onYearDragMove(event) {
    const yr = nearestYearFromPointer(event);
    if (yr) {
      yearPreview = yr;
      updateYearHighlight();
    }
  }

  function onYearDragEnd(event) {
    const yr = nearestYearFromPointer(event) || yearPreview || selectedYear;
    commitYear(yr);
    window.removeEventListener('pointermove', onYearDragMove);
  }

  onMount(() => {
    if (!selectedYear && years.length) {
      selectedYear = years[years.length - 1];
    }
    mapYear = selectedYear;
    yearPreview = selectedYear;

    if (chartContainer) {
      const rect = chartContainer.getBoundingClientRect();
      containerWidth = rect.width;
      containerHeight = rect.height;

      const ro = new ResizeObserver(entries => {
        const r = entries[0].contentRect;
        containerWidth = r.width;
        containerHeight = r.height;
      });
      ro.observe(chartContainer);
    }

    const svg = d3.select(svgElement);
    // Base group for zoom target
    svg.append('g').attr('class', 'zoom-container');

    if (chartContainer) {
      d3.select(chartContainer).call(zoomScale);
    }
  });

  // Render chart when stackedData or layout change
  $effect(() => {
    if (!stackedData || !layout) return;

    performance.mark('render-start');
    untrack(() => {
      renderChart();
      applyFilters();
    });
    performance.mark('render-end');
    performance.measure('chart-render', 'render-start', 'render-end');
  });

  // Apply filters when selection changes
  $effect(() => {
    selectedAnthromes.length;
    applyFilters();
  });

  // Keep map year in sync when not dragging
  $effect(() => {
    if (!draggingYear && selectedYear) {
      untrack(() => {
        mapYear = selectedYear;
        if (!yearPreview) {
          yearPreview = selectedYear;
        }
        updateYearHighlight();
      });
    }
  });

  // Sync zoom transform to map so both layers move together (zoom transform already in screen px)
  $effect(() => {
    zoomTransform.k;
    zoomTransform.x;
    zoomTransform.y;
    containerWidth;
    containerHeight;
    layout;

    untrack(() => {
      if (!layout || !containerWidth || !containerHeight) return;
      const unitToPx = Math.min(containerWidth, containerHeight) / layout.dim;
      mapZoom = {
        k: zoomTransform.k,
        x: zoomTransform.x * unitToPx,
        y: zoomTransform.y * unitToPx
      };
    });
  });
</script>

<div class="chart-container" bind:this={chartContainer}>
  <MapCanvas
    width={containerWidth}
    height={containerHeight}
    innerRadiusPx={innerRadiusPx}
    profile={TOPO_PROFILE}
    year={mapYear}
    legend={legend}
    yearDataLookup={yearDataLookup}
    selectedCodes={selectedAnthromes}
    zoom={mapZoom}
    bind:points={mapPoints}
    bind:mapReady
    {clipAngle}
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

  <Tooltip
    bind:visible={tooltipVisible}
    bind:x={tooltipX}
    bind:y={tooltipY}
    bind:pinned={tooltipPinned}
    content={tooltipContent}
    onClose={() => (tooltipPinned = false)}
  />
</div>

<style>
  .chart-container {
    width: 100%;
    height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    position: relative;
    overflow: hidden;
    touch-action: none;
  }

  svg {
    display: block;
    margin: auto;
    background: transparent;
    max-width: 100%;
    max-height: 100%;
    position: absolute;
    inset: 0;
    z-index: 2;
    pointer-events: none;
  }

  :global(.layer path.segment) {
    vector-effect: non-scaling-stroke;
    stroke-linecap: round;
    stroke: none;
    opacity: 0.92;
    pointer-events: all;
  }

  :global(.segment.is-hover) {
    opacity: 1;
    filter: drop-shadow(0 0 6px rgba(0, 0, 0, 0.35));
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
    font-size: 26px;
    opacity: 0.95;
    font-weight: 800;
    letter-spacing: 0.08em;
    pointer-events: all;
  }

  :global(.year-axis text.selected) {
    fill: var(--accent);
  }

  :global(.year-handle) {
    fill: #ffffff;
    stroke: #0e0b16;
    stroke-width: 2px;
    filter: drop-shadow(0 0 8px rgba(0, 0, 0, 0.45));
    cursor: grab;
    pointer-events: all;
  }

  :global(.year-handle:active) {
    cursor: grabbing;
  }

  :global(.map-mask-stroke) {
    fill: none;
    stroke: #ffffff;
    stroke-opacity: 0.3;
    stroke-width: 1.5;
  }

  .debug-panel {
    position: fixed;
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

  .reset-btn:hover {
    background: rgba(255, 255, 255, 0.1);
    border-color: rgba(255, 255, 255, 0.35);
  }
</style>
