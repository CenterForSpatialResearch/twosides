<script>
  import { onMount } from 'svelte';
  import * as d3 from 'd3';
  import Tooltip from '../../shared/Tooltip.svelte';

  // Props
  let {
    data = [],
    years = [],
    colorMapping = {},
    labelMapping = {},
    orderedCodes = [],
    selectedAnthromes = $bindable([]),
    selectedYear = $bindable(null),
    yearRange = null,
    size = 'full' // 'full' or 'preview'
  } = $props();

  // State
  let svgElement = $state(null);
  let tooltipVisible = $state(false);
  let tooltipX = $state(0);
  let tooltipY = $state(0);
  let tooltipContent = $state('');
  let tooltipPinned = $state(false);

  // Constants
  const fullSize = 7000;
  const previewSize = 1200;

  // Render the visualization
  function render() {
    if (!svgElement || !data.length) return;

    const dim = size === 'full' ? fullSize : previewSize;
    const svg = d3.select(svgElement);

    svg.attr('viewBox', `${-dim/2} ${-dim/2} ${dim} ${dim}`);

    // Clear previous content but keep zoom container
    let zoomGroup = svg.select('g.zoom-container');
    if (zoomGroup.empty()) {
      zoomGroup = svg.append('g').attr('class', 'zoom-container');
    }
    zoomGroup.selectAll('*').remove();

    const g = zoomGroup.append('g');
    const defs = svg.select('defs');
    if (defs.empty()) {
      svg.append('defs');
    }
    svg.select('defs').selectAll('*').remove();

    const outerMargin = 260;
    const radius = dim/2 - outerMargin;
    const innerRadius = (size === 'full') ? 2200 : Math.max(180, radius * 0.44);

    // Clip path for center image
    const clipId = 'map-clip';
    defs.append('clipPath')
      .attr('id', clipId)
      .append('circle')
      .attr('r', innerRadius)
      .attr('cx', 0)
      .attr('cy', 0);

    // Center map image (if available)
    g.append('image')
      .attr('href', '/anthromes/2017AD_twoPoint_sphere-plain.png')
      .attr('x', -innerRadius * 1.75)
      .attr('y', -innerRadius * 1.1)
      .attr('width', innerRadius * 3.7)
      .attr('height', innerRadius * 2.2)
      .attr('preserveAspectRatio', 'none')
      .attr('clip-path', `url(#${clipId})`);

    g.append('circle')
      .attr('class', 'map-mask-stroke')
      .attr('r', innerRadius)
      .attr('cx', 0)
      .attr('cy', 0);

    // Prepare data for stacking
    const codeToLabel = {};
    orderedCodes.forEach(code => {
      if (labelMapping[code]) {
        codeToLabel[code] = labelMapping[code];
      }
    });

    const labels = orderedCodes.map(code => labelMapping[code]).filter(Boolean);

    // Calculate totals by year
    const totalsByYear = new Map();
    data.forEach(d => {
      totalsByYear.set(d.year, d.total);
    });

    // Prepare data for stacking: [year, {label: count, ...}]
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

    // Stack the data
    const stacked = d3.stack()
      .keys(labels)
      .value((yearEntry, key) => yearEntry[1][key] || 0)
      (dataByYear);

    // Scales
    const angle = d3.scaleBand()
      .domain(years)
      .range([0, 2 * Math.PI])
      .align(0);

    const maxCount = d3.max(stacked[stacked.length - 1], d => d[1]);
    const rScale = d3.scaleLinear()
      .domain([0, maxCount])
      .range([innerRadius, radius]);

    // Arc generators
    const arc = d3.arc()
      .innerRadius(d => rScale(d.seg[0]))
      .outerRadius(d => rScale(d.seg[1]))
      .startAngle(d => angle(d.year))
      .endAngle(d => angle(d.year) + angle.bandwidth())
      .padAngle(0.003)
      .padRadius(innerRadius);

    const arcHit = d3.arc()
      .innerRadius(d => Math.max(0, rScale(d.seg[0]) - 8))
      .outerRadius(d => rScale(d.seg[1]) + 8)
      .startAngle(d => angle(d.year))
      .endAngle(d => angle(d.year) + angle.bandwidth())
      .padAngle(0.006)
      .padRadius(innerRadius);

    // Create layers
    const layers = g.selectAll('g.layer')
      .data(stacked, d => d.key)
      .join('g')
      .attr('class', 'layer')
      .attr('fill', d => {
        const code = Object.keys(labelMapping).find(k => labelMapping[k] === d.key);
        return colorMapping[code] || '#ccc';
      });

    // Create segments
    const segments = layers.selectAll('path.segment')
      .data(d => d.map(seg => ({ label: d.key, year: seg.data[0], seg: [seg[0], seg[1]] })))
      .join('path')
      .attr('class', 'segment')
      .attr('d', arc)
      .attr('data-key', d => `${d.year}__${d.label}`);

    // Create hit areas
    const hits = layers.selectAll('path.hit')
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

    // Add radial grid
    const tickCount = 6;
    const ticks = rScale.ticks(tickCount);
    g.append('g')
      .attr('class', 'axis-circles')
      .selectAll('circle')
      .data(ticks)
      .join('circle')
      .attr('r', rScale);

    // Add year axis
    const yearAxis = g.append('g').attr('class', 'year-axis');
    years.forEach(year => {
      const a = angle(year) + angle.bandwidth() / 2 - Math.PI / 2;
      const x1 = Math.cos(a) * (innerRadius - 6);
      const y1 = Math.sin(a) * (innerRadius - 6);
      const x2 = Math.cos(a) * innerRadius;
      const y2 = Math.sin(a) * innerRadius;

      yearAxis.append('line')
        .attr('x1', x1).attr('y1', y1)
        .attr('x2', x2).attr('y2', y2)
        .attr('data-year', year);

      const lx = Math.cos(a) * (innerRadius - 20);
      const ly = Math.sin(a) * (innerRadius - 20);

      yearAxis.append('text')
        .attr('x', lx).attr('y', ly)
        .attr('text-anchor', 'middle')
        .attr('alignment-baseline', 'middle')
        .attr('data-year', year)
        .text(year);
    });
  }

  // Create tooltip HTML
  function createTooltipHTML(d) {
    const code = Object.keys(labelMapping).find(k => labelMapping[k] === d.label);
    const color = colorMapping[code] || '#ccc';
    const total = d3.sum(Object.values(data.find(yd => yd.year === d.year)?.counts || {}));
    const count = d.seg[1] - d.seg[0];
    const pct = total > 0 ? ((count / total) * 100).toFixed(1) + '%' : '—';

    return `
      <div class="tip-head">
        <span class="chip" style="background:${color}"></span>
        <div>
          <div class="title">${d.label}</div>
          <div class="subtitle">Year ${d.year}</div>
        </div>
      </div>
      <div class="summary">In <b>${d.year}</b>, <b>${d.label}</b> accounts for <b>${count.toLocaleString()}</b> units (<b>${pct}</b> of the year's total).</div>
      <div class="kv">
        <div class="k">Year total</div><div>${total.toLocaleString()}</div>
        <div class="k">Segment value</div><div>${count.toLocaleString()}</div>
        <div class="k">Share</div><div>${pct}</div>
      </div>
    `;
  }

  // Re-render when props change
  $effect(() => {
    if (data.length > 0) {
      render();
    }
  });

  // Apply filters when selection changes
  $effect(() => {
    if (!svgElement) return;

    // Track dependencies
    selectedAnthromes.length;
    yearRange?.value;

    applyFilters();
  });

  function applyFilters() {
    if (!svgElement) return;

    const svg = d3.select(svgElement);
    const g = svg.select('g.zoom-container');

    // Create inverse mapping (label -> code) for O(1) lookup
    // Convert string keys to numbers to match orderedCodes type
    const labelToCode = {};
    Object.keys(labelMapping).forEach(code => {
      labelToCode[labelMapping[code]] = Number(code);
    });

    // Get year range values and create year index map for O(1) lookup
    const allYears = yearRange?.years || [];
    const yearMinIdx = yearRange?.value[0] ?? 0;
    const yearMaxIdx = yearRange?.value[1] ?? allYears.length - 1;
    const yearToIdx = new Map(allYears.map((year, idx) => [year, idx]));

    // Check if all anthromes and all years are selected (no filtering)
    const allAnthromesSelected = selectedAnthromes.length === orderedCodes.length;
    const allYearsSelected = !yearRange || (yearMinIdx === 0 && yearMaxIdx === allYears.length - 1);

    if (allAnthromesSelected && allYearsSelected) {
      g.classed('isolated', false);
      g.selectAll('.segment, .hit').style('opacity', null).style('pointer-events', null);
      return;
    }

    // Create set of selected anthrome codes for fast lookup
    const selectedSet = new Set(selectedAnthromes);

    g.classed('isolated', true);

    // Filter segments
    g.selectAll('.segment').each(function() {
      const segment = d3.select(this);
      const d = segment.datum();
      const code = labelToCode[d.label];
      const inAnthrome = code && selectedSet.has(code);

      // Year filtering: Use Map for O(1) lookup instead of indexOf
      const yearIdx = yearToIdx.get(d.year) ?? -1;
      const inYear = !yearRange || (yearIdx >= yearMinIdx && yearIdx <= yearMaxIdx);

      const show = inAnthrome && inYear;
      segment.style('opacity', show ? null : 0.02)
             .style('pointer-events', show ? 'all' : 'none');
    });

    // Filter hit areas
    g.selectAll('.hit').each(function() {
      const hit = d3.select(this);
      const d = hit.datum();
      const code = labelToCode[d.label];
      const inAnthrome = code && selectedSet.has(code);

      // Year filtering: Use Map for O(1) lookup
      const yearIdx = yearToIdx.get(d.year) ?? -1;
      const inYear = !yearRange || (yearIdx >= yearMinIdx && yearIdx <= yearMaxIdx);

      const show = inAnthrome && inYear;
      hit.style('opacity', show ? null : 0)
         .style('pointer-events', show ? 'all' : 'none');
    });
  }

  onMount(() => {
    // Set up zoom behavior
    const svg = d3.select(svgElement);

    // Ensure zoom container exists
    let zoomGroup = svg.select('g.zoom-container');
    if (zoomGroup.empty()) {
      zoomGroup = svg.append('g').attr('class', 'zoom-container');
    }

    // Capture zoomGroup reference in closure for better performance
    const zoom = d3.zoom()
      .scaleExtent([1, 15])
      .on('zoom', (event) => {
        // Use captured reference instead of re-querying DOM
        zoomGroup.attr('transform', event.transform);
      });

    svg.call(zoom);

    render();
  });
</script>

<div class="chart-container">
  <svg bind:this={svgElement} id="chart"></svg>

  <Tooltip
    bind:visible={tooltipVisible}
    bind:x={tooltipX}
    bind:y={tooltipY}
    bind:pinned={tooltipPinned}
    content={tooltipContent}
  />
</div>

<style>
  .chart-container {
    width: 100%;
    height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  svg {
    display: block;
    margin: auto;
    background: var(--bg);
    max-width: 100%;
    max-height: 100%;
  }

  :global(.layer path.segment) {
    vector-effect: non-scaling-stroke;
    stroke-linecap: round;
    stroke: none;
    opacity: 0.92;
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
    font-size: 11px;
    opacity: 0.9;
  }

  :global(.map-mask-stroke) {
    fill: none;
    stroke: #ffffff;
    stroke-opacity: 0.25;
    stroke-width: 1.5;
  }
</style>
