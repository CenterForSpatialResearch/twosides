<script>
  import { onMount } from 'svelte';
  import * as d3 from 'd3';
  import Tooltip from '../../shared/Tooltip.svelte';
  import {
    colorMapping,
    pickTextColor,
    getPhylum,
    prettyName,
    lineage,
    safe,
    sgbLabel,
    locationsFromMeta,
    parseUSGB,
    parseWestern,
    isWesternYes,
    isWesternNo
  } from './dataAdapter.js';

  // Props
  let {
    taxonomyTree = null,
    selectedPhyla = $bindable([]),
    unknownFilter = $bindable(false),
    westernFilter = $bindable('any'),
    bodySiteFilter = $bindable(new Set()),
    proxyKey = $bindable(null),
    studyKey = $bindable(null),
    size = 'full',
    tension = 0.95
  } = $props();

  // State
  let svgElement = $state(null);
  let tooltipVisible = $state(false);
  let tooltipX = $state(0);
  let tooltipY = $state(0);
  let tooltipContent = $state('');
  let tooltipPinned = $state(false);
  let currentTooltipDatum = $state(null); // Track which datum the tooltip is showing

  // Internal state (handles doesn't need to be reactive)
  let handles = { root: null, selections: {} };
  let selectedLeafId = $state(null);
  let highlightedLeaf = $state(null);
  let maxGenomeCount = $state(1);
  let tickDenom = $state(1);

  // Cross-highlighting state
  let highlightedSGBs = $state(new Set());
  let crossHighlightActive = $state(false);
  let showBackButton = $state(false);

  // Constants
  const fullSize = 6400;        // match desired 6400x6400 canvas
  const previewSize = 1200;
  const fullRadius = 2800;      // leave margin so disk never clips at default
  const previewRadius = 550;
  const zoomMin = 0.5;
  const zoomMax = 7.0;           // allow deeper preset zooms
  const zoomStep = 1.25;
  const anchorFraction = -0.30;  // shift left on zoom, but keep disk within its 2/3 column
  const anchorPx = null;         // use fraction-based anchor; set number to override
  const rotateStepDeg = 10;
  const resetFraction = 0.5;     // center within the 2/3 viz area
  const resetYOffset = -130;     // refined lift toward vertical center
  const resetPx = null;          // set to number to override resetFraction
  const defaultScale = 0.8;      // fit without edge overlap on load
  const geographyFilters = ['Western', 'Non-Western', 'Unknown'];
  const proxyFilters = ['Proxy', 'Study', 'Site'];
  const zoomPresets = [2, 7];
  const backgroundColor = '#0e0b16';
  const DIM_OPACITY = 0.02;
  const DIM_LABEL_OPACITY = 0.10;
  let currentTransform = d3.zoomIdentity;
  let zoomBehavior = null;
  let rotationDeg = 0;
  let infoPanelEl = $state(null);
  let panelContent = $state('');
  let panelVisible = $state(false);
  let connectorStart = $state(null);
  let connectorEnd = $state(null);
  let viewportW = $state(0);
  let viewportH = $state(0);
  let proxySgbMap = {};
  let studySgbMap = {};
  let proxyLoaded = false;
  let studyLoaded = false;

  function closePanel() {
    panelVisible = false;
    panelContent = '';
    connectorStart = null;
    connectorEnd = null;
    currentTooltipDatum = null;
    tooltipPinned = false;
  }

  function applyTransforms() {
    if (!svgElement) return;
    const g = d3.select(svgElement).select('g.zoom-container');
    g.attr('transform', `${currentTransform} rotate(${rotationDeg || 0})`);
  }

  function clampScale(k) {
    return Math.max(zoomMin, Math.min(zoomMax, k));
  }

  function applyZoom(k, anchorX, anchorY) {
    const rect = svgElement.getBoundingClientRect();
    const dim = size === 'full' ? fullSize : previewSize;
    const scale = dim / rect.width; // convert screen px -> user units
    // Translate so disk center moves from screen center to anchor in user space
    const tx = (anchorX - rect.width / 2) * scale;
    const ty = (anchorY - rect.height / 2) * scale;
    const target = d3.zoomIdentity.translate(tx, ty).scale(k);
    currentTransform = target;
    if (zoomBehavior && svgElement) {
      d3.select(svgElement).call(zoomBehavior.transform, target);
    } else {
      applyTransforms();
    }
  }

  function performZoomStep(dir = 1) {
    if (!svgElement) return;
    const rect = svgElement.getBoundingClientRect();
    const anchorX = anchorPx ?? rect.width * anchorFraction;
    const anchorY = rect.height / 2 + resetYOffset;
    const nextK = clampScale(currentTransform.k * (dir > 0 ? zoomStep : 1 / zoomStep));
    applyZoom(nextK, anchorX, anchorY);
  }

  const zoomIn = () => performZoomStep(1);
  const zoomOut = () => performZoomStep(-1);

  function resetView() {
    if (!svgElement) return;
    const rect = svgElement.getBoundingClientRect();
    const anchorX = resetPx ?? rect.width * resetFraction;
    applyZoom(defaultScale, anchorX, rect.height / 2 + resetYOffset);
    rotationDeg = 0;
    applyTransforms();
  }

  function rotateBy(deltaDeg) {
    // snap to 5° increments for fewer repaints
    const snap = 5;
    const snapped = Math.round(deltaDeg / snap) * snap;
    rotationDeg = (rotationDeg + snapped + 360) % 360;
    applyTransforms();
  }

  // Render the visualization
  function render() {
    if (!svgElement || !taxonomyTree) {
      return;
    }

    const dim = size === 'full' ? fullSize : previewSize;
    const radius = size === 'full' ? fullRadius : previewRadius;

    const svg = d3.select(svgElement);
    svg.attr('viewBox', `${-dim / 2} ${-dim / 2} ${dim} ${dim}`);

    // Ensure zoom container exists and is persistent
    let g = svg.select('g.zoom-container');
    if (g.empty()) {
      g = svg.append('g').attr('class', 'zoom-container');
    }

    // Clear zoom container content but keep the container itself
    g.selectAll('*').remove();

    let defs = svg.select('defs');
    if (defs.empty()) {
      defs = svg.append('defs');
    }
    defs.selectAll('*').remove();

    // Create tree layout
    const tree = d3.cluster().size([2 * Math.PI, radius]);
    const root = d3.hierarchy(taxonomyTree);
    root.sort((a, b) => b.descendants().length - a.descendants().length);
    tree(root);

    handles.root = root;

    const leaves = root.leaves();
    leaves.forEach((d, i) => d.leafId = i);

    // Calculate metrics
    const reconstructedCounts = leaves.map(d => d.data.metadata?.["#_Reconstructed_genomes"] || 0);
    const maxRec = d3.max(reconstructedCounts) || 0;
    maxGenomeCount = Math.max(1, maxRec);

    const sortedCounts = reconstructedCounts.slice().sort((a, b) => a - b);
    const p95 = d3.quantileSorted(sortedCounts, 0.95) || maxRec;
    tickDenom = Math.max(1, Math.round(p95));

    // Ring dimensions
    const angleWidth = 0.0005;
    const usgbInner = radius + 20;
    const usgbOuter = usgbInner + 24;
    const westInner = usgbOuter + 12;
    const westOuter = westInner + 24;
    const barMaxLength = radius * 0.05;
    const barScale = d3.scaleSymlog()
      .domain([0, Math.max(1, maxRec)])
      .range([0, barMaxLength])
      .constant(1);
    const barInner = westOuter + 30;

    // Line generator with bundle curve
    const line = d3.lineRadial()
      .curve(d3.curveBundle.beta(tension))
      .angle(d => d.x)
      .radius(d => d.y);

    // SGB lines + hits
    const sgbGroup = g.append('g');
    const sgbLines = sgbGroup.selectAll('path.sgb-line')
      .data(leaves)
      .join('path')
      .attr('class', 'sgb-line')
      .attr('data-leaf-id', d => d.leafId)
      .attr('d', d => {
        const theta = d.x - Math.PI / 2;
        const x0 = Math.cos(theta) * d.y;
        const y0 = Math.sin(theta) * d.y;
        const outerRadius = barInner + barScale(d.data.metadata?.["#_Reconstructed_genomes"] || 0);
        const x1 = Math.cos(theta) * outerRadius;
        const y1 = Math.sin(theta) * outerRadius;
        return `M${x0},${y0}L${x1},${y1}`;
      });

    const sgbHits = sgbGroup.selectAll('path.sgb-hit')
      .data(leaves)
      .join('path')
      .attr('class', 'hit sgb-hit')
      .attr('data-leaf-id', d => d.leafId)
      .attr('d', d => {
        const theta = d.x - Math.PI / 2;
        const x0 = Math.cos(theta) * d.y;
        const y0 = Math.sin(theta) * d.y;
        const outerRadius = barInner + barScale(d.data.metadata?.["#_Reconstructed_genomes"] || 0);
        const x1 = Math.cos(theta) * outerRadius;
        const y1 = Math.sin(theta) * outerRadius;
        return `M${x0},${y0}L${x1},${y1}`;
      });

    attachTooltipHandlers(sgbHits, d => d);

    // Regions + labels
    const regionsLayer = g.append('g');
    const labelsLayer = g.append('g');
    let id = 0;
    const maxDepth = d3.max(root.descendants(), d => d.depth);
    const regionPaths = [];
    const labelEls = [];

    for (let depth = 2; depth <= maxDepth; depth++) {
      const nodes = root.descendants().filter(d => d.depth === depth);
      d3.groups(nodes, d => getPhylum(d)).forEach(([phylum, group]) => {
        if (group.length < 2) return;

        const sorted = group.sort((a, b) => a.x - b.x);
        const innerR = sorted[0].y - (radius / maxDepth) * 0.75;
        const outerR = sorted[0].y;
        const ptsOuter = sorted.map(d => [d.x, outerR]);
        const ptsInner = sorted.map(d => [d.x, innerR]).reverse();
        const pathData = d3.lineRadial()
          .curve(d3.curveCardinalClosed.tension(0.7))
          (ptsOuter.concat(ptsInner));

        const gradID = `grad-${phylum}-${depth}`;
        const gdef = defs.append('radialGradient').attr('id', gradID);
        gdef.selectAll('stop')
          .data([
            { offset: '0%', color: backgroundColor, opacity: 0 },
            { offset: '100%', color: colorMapping[phylum] || colorMapping.Other, opacity: 1 }
          ])
          .join('stop')
          .attr('offset', d => d.offset)
          .attr('stop-color', d => d.color)
          .attr('stop-opacity', d => d.opacity);

        const bandNode = sorted[0];
        const region = regionsLayer.append('path')
          .datum(bandNode)
          .attr('class', 'region-path')
          .attr('d', pathData)
          .attr('fill', `url(#${gradID})`);
        regionPaths.push(region.node());

        const arcID = `arc-${id++}`;
        defs.append('path')
          .attr('id', arcID)
          .attr('d', d3.arc()({
            innerRadius: outerR - 12,
            outerRadius: outerR - 12,
            startAngle: sorted[0].x,
            endAngle: sorted[sorted.length - 1].x
          }));

        const labelText = labelsLayer.append('text')
          .attr('class', 'region-label');
        labelText.append('textPath')
          .attr('xlink:href', `#${arcID}`)
          .attr('startOffset', '50%')
          .text(phylum.replace(/_/g, ' '));
        labelEls.push(labelText.node());
      });
    }

    // Links + hits
    const linkData = root.links().filter(d => !d.target.children);
    const links = g.append('g')
      .selectAll('path.link')
      .data(linkData)
      .join('path')
      .attr('class', 'link')
      .attr('data-leaf-id', d => d.target.leafId)
      .attr('d', d => line(d.target.ancestors().reverse()));

    const linkHits = g.append('g')
      .selectAll('path.hit-link')
      .data(linkData)
      .join('path')
      .attr('class', 'hit')
      .attr('data-leaf-id', d => d.target.leafId)
      .attr('d', d => line(d.target.ancestors().reverse()));

    attachTooltipHandlers(linkHits, d => d.target);

    // Nodes
    const nodes = g.append('g')
      .selectAll('g.node')
      .data(root.descendants())
      .join('g')
      .attr('class', 'node')
      .attr('data-leaf-id', d => d.children ? null : d.leafId)
      .attr('transform', d => `rotate(${d.x * 180 / Math.PI - 90}) translate(${d.y},0)`);

    nodes.append('circle')
      .attr('r', d => d.children ? 0 : 2.5)
      .attr('fill', d => colorMapping[getPhylum(d)] || colorMapping.Other);

    attachTooltipHandlers(nodes, d => d);

    // Internal labels
    const internals = g.append('g')
      .selectAll('text.internal-label')
      .data(root.descendants().filter(d => d.children))
      .join('text')
      .attr('class', 'internal-label')
      .attr('transform', d => `rotate(${d.x * 180 / Math.PI - 90}) translate(${d.y},0)` + (d.x >= Math.PI ? ' rotate(180)' : ''))
      .attr('dy', '0.31em')
      .attr('x', d => d.x < Math.PI ? 6 : -6)
      .attr('text-anchor', d => d.x < Math.PI ? 'start' : 'end')
      .text(d => (d.data.name || '').split('__').pop().replace(/_/g, ' '));

    // Bars
    const bars = g.append('g')
      .selectAll('path.bar')
      .data(leaves)
      .join('path')
      .attr('class', 'bar')
      .attr('data-leaf-id', d => d.leafId)
      .attr('d', d => {
        const count = d.data.metadata?.["#_Reconstructed_genomes"] || 0;
        const r0 = barInner;
        const r1 = barInner + barScale(count);
        return d3.arc()({
          innerRadius: r0,
          outerRadius: r1,
          startAngle: d.x - 0.0005,
          endAngle: d.x + 0.0005
        });
      })
      .attr('fill', d => colorMapping[getPhylum(d)] || colorMapping.Other);

    attachTooltipHandlers(bars);

    // Bar axis
    const axisGroup = g.append('g').attr('class', 'bar-axis');
    axisGroup.append('line')
      .attr('x1', 0).attr('y1', barInner)
      .attr('x2', 0).attr('y2', barInner + barMaxLength)
      .attr('stroke', 'white');

    [1, 10, 100, 500].filter(v => v <= maxRec).forEach(t => {
      const y = barInner + barScale(t);
      axisGroup.append('line')
        .attr('x1', 0).attr('y1', y)
        .attr('x2', 8).attr('y2', y);
      axisGroup.append('text')
        .attr('x', 10).attr('y', y)
        .attr('dy', '.32em')
        .text(t);
    });

    // Unknown & Western rings
    const usgb = g.append('g')
      .selectAll('path.usgb')
      .data(leaves)
      .join('path')
      .attr('class', 'usgb')
      .attr('data-leaf-id', d => d.leafId)
      .attr('d', d => d3.arc()({
        innerRadius: usgbInner,
        outerRadius: usgbOuter,
        startAngle: d.x - 0.0005,
        endAngle: d.x + 0.0005
      }))
      .attr('fill', d => (parseUSGB(d.data.metadata) === 'Yes') ? 'white' : 'black')
      .attr('opacity', d => (parseUSGB(d.data.metadata) === 'Yes') ? 1 : 0.5);

    attachTooltipHandlers(usgb);

    g.append('circle')
      .attr('r', (usgbInner + usgbOuter) / 2)
      .attr('fill', 'none')
      .attr('stroke', 'white')
      .attr('stroke-width', 2);

    const west = g.append('g')
      .selectAll('path.western')
      .data(leaves)
      .join('path')
      .attr('class', 'western')
      .attr('data-leaf-id', d => d.leafId)
      .attr('d', d => d3.arc()({
        innerRadius: westInner,
        outerRadius: westOuter,
        startAngle: d.x - 0.0005,
        endAngle: d.x + 0.0005
      }))
      .attr('fill', d => isWesternNo(d.data.metadata) ? 'white' : 'black')
      .attr('opacity', d => isWesternNo(d.data.metadata) ? 1 : 0.5);

    attachTooltipHandlers(west);

    g.append('circle')
      .attr('r', (westInner + westOuter) / 2)
      .attr('fill', 'none')
      .attr('stroke', 'white')
      .attr('stroke-width', 2);

    // Store selections for filtering
    handles.selections = {
      nodes,
      internals,
      links,
      linkHits,
      bars,
      sgbLines,
      usgb,
      west,
      regions: d3.selectAll(regionsLayer.selectAll('path').nodes()),
      labels: d3.selectAll(labelsLayer.selectAll('text').nodes())
    };

    applyFiltersNow();
    applyTransforms();
  }

  function updateConnector() {
    if (!panelVisible || !infoPanelEl || !connectorStart) return;
    const rect = infoPanelEl.getBoundingClientRect();
    const x2 = rect.left + 6; // slight inset from panel edge
    const midY = rect.top + rect.height / 2;
    const y2 = Math.max(rect.top + 6, Math.min(rect.bottom - 6, connectorStart.y || midY));
    connectorEnd = { x: x2, y: y2 };
  }

  // Create tooltip HTML with mini-glyph and genome meter
  function createTooltipHTML(d) {
    const phylum = getPhylum(d);
    const meta = d?.data?.metadata || {};
    const rec = +meta["#_Reconstructed_genomes"] || 0;
    const status = (parseUSGB(meta) === 'Yes') ? 'Unknown' : '—';
    const geo = (parseWestern(meta) === 'western') ? 'Western' : (parseWestern(meta) === 'nonwestern' ? 'Non-Western' : '—');
    const leaf = !d.children;
    const color = colorMapping[phylum] || colorMapping.Other;
    const glyphStroke = color;

    // Mini-glyph path
    const chain = d.ancestors().reverse();
    const yVals = chain.map(n => n.y);
    const yMin = Math.min(...yVals);
    const yMax = Math.max(...yVals);
    const rMin = 12, rMax = 50;
    const glyphLine = d3.lineRadial()
      .curve(d3.curveBundle.beta(0.85))
      .angle(n => n.x)
      .radius(n => (yMax === yMin ? (rMin + rMax) / 2 : rMin + (n.y - yMin) / (yMax - yMin) * (rMax - rMin)));
    const glyphPath = glyphLine(chain);

    // Summary text
    const loc = locationsFromMeta(meta);
    const sgb = sgbLabel(d);
    const summary = `<b>${sgb}</b> includes <b>${rec.toLocaleString()}</b> genomes within the <b>${phylum.replace(/_/g, ' ')}</b> phylum, identified from <b>${loc}</b>.`;

    // Genome meter ticks
    const maxTicks = 20;
    const denom = Math.max(1, tickDenom);
    const fraction = Math.min(1, rec / denom);
    const targetTicks = Math.max((rec > 0 ? 1 : 0), fraction * maxTicks);
    const ticksInt = Math.min(maxTicks, Math.round(targetTicks));

    let ticksHTML = '';
    for (let i = 0; i < maxTicks; i++) {
      const filled = i < ticksInt ? 'filled' : '';
      ticksHTML += `<span class="tick ${filled}" style="--tickColor: ${color}"></span>`;
    }

    return `
      <div class="tip-header">
        <div class="h-left">
          <span class="swatch" style="background:${color}"></span>
          <div>
            <div class="title">${sgb}</div>
            <div class="subtitle">${phylum.replace(/_/g, ' ')}${lineage(d) ? ' • ' + lineage(d) : ''}</div>
          </div>
        </div>
        <svg class="mini-glyph" viewBox="-60 -60 120 120" aria-hidden="true">
          <path d="${glyphPath}" stroke="${glyphStroke}" fill="none" stroke-width="1.2" vector-effect="non-scaling-stroke" />
        </svg>
      </div>

      <div class="summary">${summary}</div>

      <div class="genome-meter">
        <div class="ticks">${ticksHTML}</div>
        <div class="num"><span class="val">${rec.toLocaleString()}</span> genomes identified</div>
      </div>

      <div class="kv">
        <div class="k">Status</div><div>${safe(status)}</div>
        <div class="k">Geography</div><div>${safe(geo)}</div>
      </div>

      ${leaf ? `<div class="actions">
        <button data-act="highlight">Highlight this species</button>
        ${meta?.SGB_ID ? `<button data-act="highlight-countries" data-sgb="${meta.SGB_ID}">Highlight countries where this species is found →</button>` : ''}
      </div>` : ''}
    `;
  }

  // Attach tooltip handlers
  function attachTooltipHandlers(selection, accessor = (d) => d) {
    selection
      .classed('hover-target', true)
      .on('mousemove', function (event, d) {
        if (tooltipPinned) return;
        const datum = accessor(d);
        tooltipX = event.clientX;
        tooltipY = event.clientY;
        connectorStart = { x: event.clientX, y: event.clientY };
        panelContent = createTooltipHTML(datum);
        panelVisible = true;
        currentTooltipDatum = datum; // Track current datum
        updateConnector();
      })
      .on('mouseover', function (event, d) {
        d3.select(this).classed('is-hover', true);
        const lid = this.getAttribute('data-leaf-id');
        if (lid) toggleClassForLeaf(lid, 'is-hover', true);
        if (!tooltipPinned) {
          const datum = accessor(d);
          panelContent = createTooltipHTML(datum);
          panelVisible = true;
          currentTooltipDatum = datum; // Track current datum
          connectorStart = { x: event.clientX, y: event.clientY };
          updateConnector();
        }
      })
      .on('mouseout', function () {
        d3.select(this).classed('is-hover', false);
        const lid = this.getAttribute('data-leaf-id');
        if (lid) toggleClassForLeaf(lid, 'is-hover', false);
        if (!tooltipPinned) {
          panelVisible = false;
          currentTooltipDatum = null; // Clear datum when hiding
          connectorStart = null;
          connectorEnd = null;
        }
      })
      .on('click', function (event, d) {
        const datum = accessor(d);
        const lid = this.getAttribute('data-leaf-id');

        if (tooltipPinned && currentTooltipDatum === datum) {
          tooltipPinned = false;
          clearSelected();
          event.stopPropagation();
          return;
        }

        tooltipPinned = true;
        tooltipX = event.clientX;
        tooltipY = event.clientY;
        panelContent = createTooltipHTML(datum);
        currentTooltipDatum = datum; // Track current datum
        panelVisible = true;
        connectorStart = { x: event.clientX, y: event.clientY };
        updateConnector();

        if (lid) {
          clearSelected();
          selectedLeafId = lid;
          toggleClassForLeaf(lid, 'is-selected', true);
        }

        event.stopPropagation();
      });
  }

  // Helper functions
  function toggleClassForLeaf(id, cls, on = true) {
    if (id == null) return;
    const svg = d3.select(svgElement);
    svg.selectAll(`[data-leaf-id="${id}"]`).classed(cls, on);
  }

  function clearSelected() {
    selectedLeafId = null;
    const svg = d3.select(svgElement);
    svg.selectAll('.is-selected').classed('is-selected', false);
  }

  function clearHighlight() {
    highlightedLeaf = null;
    highlightedSGBs = new Set();
    crossHighlightActive = false;
    const svg = d3.select(svgElement);
    const g = svg.select('g.zoom-container');
    g.classed('isolated', false);
    g.selectAll('.node, .link, .bar, .usgb, .western, .sgb-line')
      .attr('opacity', null)
      .style('pointer-events', null);
  }

  function highlightLeaf(d) {
    highlightedLeaf = d;
    const keep = new Set(d.ancestors());
    keep.add(d);

    const svg = d3.select(svgElement);
    const g = svg.select('g.zoom-container');
    g.classed('isolated', true);
    g.selectAll('.node, .link, .bar, .usgb, .western, .sgb-line')
      .attr('opacity', datum => {
        const nd = datum?.target ? datum.target : datum;
        return keep.has(nd) ? 1 : DIM_OPACITY;
      })
      .style('pointer-events', datum => {
        const nd = datum?.target ? datum.target : datum;
        return keep.has(nd) ? null : 'none';
      });
  }

  function highlightMultipleLeaves(leaves) {
    const keep = new Set();
    leaves.forEach(leaf => {
      leaf.ancestors().forEach(a => keep.add(a));
      keep.add(leaf);
    });

    const svg = d3.select(svgElement);
    const g = svg.select('g.zoom-container');
    g.classed('isolated', true);
    g.selectAll('.node, .link, .bar, .usgb, .western, .sgb-line')
      .attr('opacity', datum => {
        const nd = datum?.target ? datum.target : datum;
        return keep.has(nd) ? 1 : DIM_OPACITY;
      })
      .style('pointer-events', datum => {
        const nd = datum?.target ? datum.target : datum;
        return keep.has(nd) ? null : 'none';
      });
  }

  // Filtering logic
  function leafMatchesFilters(leaf) {
    if (selectedPhyla.length > 0) {
      const ph = getPhylum(leaf);
      if (!selectedPhyla.includes(ph)) return false;
    }
    if (unknownFilter) {
      if (parseUSGB(leaf.data.metadata) !== 'Yes') return false;
    }
    if (westernFilter === 'western') {
      if (!isWesternYes(leaf.data.metadata)) return false;
    } else if (westernFilter === 'nonwestern') {
      if (!isWesternNo(leaf.data.metadata)) return false;
    }
    // Body site filter (best-effort; expects metadata.body_site)
    if (bodySiteFilter.size > 0) {
      const bs = (leaf.data?.metadata?.body_site || '').toLowerCase();
      const matches = Array.from(bodySiteFilter).some(site => bs.includes(site.toLowerCase()));
      if (!matches) return false;
    }
    // Proxy filter placeholder (no-op if no proxy selected)
    if (proxyKey) {
      const sgbIdRaw = leaf?.data?.metadata?.SGB_ID;
      const sgbId = sgbIdRaw == null ? null : Number(sgbIdRaw);
      const allowed = proxySgbMap[proxyKey] || null;
      if (allowed && (sgbId == null || !allowed.has(sgbId))) return false;
    }
    // Study filter
    if (studyKey) {
      const sgbIdRaw = leaf?.data?.metadata?.SGB_ID;
      const sgbId = sgbIdRaw == null ? null : Number(sgbIdRaw);
      const allowed = studySgbMap[studyKey] || null;
      if (allowed && (sgbId == null || !allowed.has(sgbId))) return false;
    }
    return true;
  }

  function computeKeepSet(root) {
    const anyActive =
      selectedPhyla.length > 0 ||
      unknownFilter ||
      westernFilter !== 'any' ||
      bodySiteFilter.size > 0 ||
      !!proxyKey;
    if (!anyActive) return null;

    const matchedLeaves = root.leaves().filter(leafMatchesFilters);
    const keep = new Set();
    matchedLeaves.forEach(l => {
      l.ancestors().forEach(a => keep.add(a));
      keep.add(l);
    });
    return keep;
  }

  let filterRaf = null;

  function applyFiltersNow() {
    const { root, selections } = handles;
    if (!root) return;

    const keep = computeKeepSet(root);

    function styleDim(sel, isKept, isLabel = false) {
      return sel
        .attr('opacity', d => isKept(d) ? 1 : (isLabel ? DIM_LABEL_OPACITY : DIM_OPACITY))
        .style('pointer-events', d => isKept(d) ? null : 'none');
    }

    const svg = d3.select(svgElement);
    const g = svg.select('g.zoom-container');

    if (keep === null) {
      g.classed('isolated', false);
      Object.values(selections).forEach(sel => {
        if (sel) {
          sel.attr('opacity', null).style('pointer-events', null);
        }
      });
      return;
    }

    g.classed('isolated', true);
    styleDim(selections.nodes, d => keep.has(d));
    styleDim(selections.internals, d => keep.has(d), true);
    styleDim(selections.links, d => keep.has(d.target));
    styleDim(selections.linkHits, d => keep.has(d.target));
    styleDim(selections.bars, d => keep.has(d));
    styleDim(selections.sgbLines, d => keep.has(d));
    styleDim(selections.usgb, d => keep.has(d));
    styleDim(selections.west, d => keep.has(d));
    styleDim(selections.regions, d => keep.has(d));
    styleDim(selections.labels, d => keep.has(d), true);
  }

  function scheduleFilters() {
    if (filterRaf) return;
    const cb = () => {
      filterRaf = null;
      applyFiltersNow();
    };
    if (typeof requestIdleCallback === 'function') {
      filterRaf = requestIdleCallback(cb, { timeout: 50 });
    } else {
      filterRaf = requestAnimationFrame(cb);
    }
  }

  // Handle tooltip actions
  function handleTooltipAction(event) {
    const btn = event.target.closest('button');
    if (!btn) return;

    const act = btn.getAttribute('data-act');
    if (act === 'highlight' && currentTooltipDatum) {
      highlightLeaf(currentTooltipDatum);
      btn.textContent = 'Highlighted';
      setTimeout(() => {
        btn.textContent = 'Highlight this species';
      }, 1200);
    } else if (act === 'highlight-countries') {
      const sgbId = parseInt(btn.getAttribute('data-sgb'), 10);
      if (sgbId) {
        const base = import.meta.env.BASE_URL;
        window.location.href = `${base}src/anthromes/index.html?highlightSGB=${sgbId}`;
      }
    }
  }

  function handleBackButton() {
    const sgbsParam = new URLSearchParams(window.location.search).get('highlightSGBs');
    const base = import.meta.env.BASE_URL;
    window.location.href = `${base}src/anthromes/index.html${sgbsParam ? `?highlightSGBs=${sgbsParam}` : ''}`;
  }

  // Handle window click (unpin, clear selection, clear highlight)
  function handleWindowClick(event) {
    const target = event.target;
    if (target.closest('.back-button')) return;
    if (target.closest('#info-panel') || target.closest('svg#chart') || target.closest('.zoom-controls')) return;

    closePanel();
    clearSelected();
    clearHighlight();

    // Clear URL parameters and cross-highlighting state
    if (crossHighlightActive || showBackButton) {
      crossHighlightActive = false;
      showBackButton = false;
      const url = new URL(window.location.href);
      url.searchParams.delete('highlightSGBs');
      url.searchParams.delete('highlightSGB');
      window.history.replaceState({}, '', url);
    }

    scheduleFilters();
  }

  // Handle escape key
  function handleEscape(event) {
    if (event.key === 'Escape') {
      tooltipPinned = false;
      tooltipVisible = false;
      currentTooltipDatum = null;
      clearSelected();
      clearHighlight();
      scheduleFilters();
    }
  }

  // Re-render when props change
  $effect(() => {
    if (taxonomyTree) {
      render();
    }
  });

  // Re-apply filters when filter props change
  $effect(() => {
    // Track dependencies
    selectedPhyla.length;
    unknownFilter;
    westernFilter;
    bodySiteFilter.size;
    proxyKey;
    studyKey;

    scheduleFilters();
  });

  // Lazy-load study SGB map only when a study filter is requested
  $effect(() => {
    if (!studyKey || studyLoaded) return;
    fetch('/data/study_index.json')
      .then(res => res.ok ? res.json() : null)
      .then(json => {
        if (json) {
          Object.entries(json).forEach(([key, val]) => {
            studySgbMap[key] = new Set((val?.sgbs || []).map(Number));
          });
          studyLoaded = true;
          applyFiltersNow();
        }
      })
      .catch(() => {});
  });

  onMount(() => {
    // Lazy-load proxy SGB map from public JSON
    fetch('/data/proxy_samples.json')
      .then(res => res.ok ? res.json() : null)
      .then(json => {
        if (json?.proxies) {
          Object.entries(json.proxies).forEach(([key, val]) => {
            proxySgbMap[key] = new Set((val?.sgbs || []).map(Number));
          });
          proxyLoaded = true;
          scheduleFilters();
        }
      })
      .catch(() => {});

    const svg = d3.select(svgElement);

    // Ensure zoom container exists
    let zoomGroup = svg.select('g.zoom-container');
    if (zoomGroup.empty()) {
      zoomGroup = svg.append('g').attr('class', 'zoom-container');
    }

    zoomBehavior = d3.zoom()
      .filter((event) => {
        // Disable wheel/pinch; allow drag for pan
        const t = event.type;
        if (t === 'wheel' || t === 'touchstart' || t === 'touchmove') return false;
        return true;
      })
      .scaleExtent([zoomMin, zoomMax])
      .on('zoom', (event) => {
        currentTransform = event.transform;
        applyTransforms();
      });

    svg.call(zoomBehavior);

    // Initial transform: full view centered
    resetView();

    // Don't render here - let $effect handle it when taxonomyTree is set

    // Check for cross-highlighting from URL parameters
    const urlParams = new URLSearchParams(window.location.search);
    const highlightSGBsParam = urlParams.get('highlightSGBs');
    const highlightSGBParam = urlParams.get('highlightSGB');

    if (highlightSGBsParam || highlightSGBParam) {
      showBackButton = true;
      crossHighlightActive = true;

      // Wait for taxonomy tree to load using polling
      const checkTreeInterval = setInterval(() => {
        if (taxonomyTree && handles.root) {
          clearInterval(checkTreeInterval);

          // Parse comma-separated SGB IDs (or single SGB ID)
          const sgbIds = highlightSGBsParam
            ? highlightSGBsParam.split(',').map(id => parseInt(id.trim(), 10))
            : [parseInt(highlightSGBParam, 10)];

          // Find ALL matching leaves
          const leaves = handles.root.leaves();
          const matchedLeaves = leaves.filter(leaf => {
            const sgbId = leaf?.data?.metadata?.SGB_ID;
            return sgbId && sgbIds.includes(sgbId);
          });

          if (matchedLeaves.length > 0) {
            // Collect all ancestors to keep visible
            const keep = new Set();
            matchedLeaves.forEach(leaf => {
              keep.add(leaf);
              leaf.ancestors().forEach(a => keep.add(a));
            });

            // Dim non-highlighted nodes
            const g = svg.select('g.zoom-container');
            g.classed('isolated', true);
            g.selectAll('.node, .link, .bar, .usgb, .western, .sgb-line')
              .attr('opacity', datum => {
                const nd = datum?.target ? datum.target : datum;
                return keep.has(nd) ? 1 : 0.02;
              })
              .style('pointer-events', datum => {
                const nd = datum?.target ? datum.target : datum;
                return keep.has(nd) ? null : 'none';
              });

            // Make matched leaves bold
            matchedLeaves.forEach(leaf => {
              if (leaf.leafId != null) {
                svg.selectAll(`[data-leaf-id="${leaf.leafId}"]`)
                   .classed('is-selected', true);
              }
            });
          }
        }
      }, 100);

      // Safety timeout
      setTimeout(() => clearInterval(checkTreeInterval), 10000);
    }

    // Add event listeners
    window.addEventListener('click', handleWindowClick);
    window.addEventListener('keydown', handleEscape);

    return () => {
      window.removeEventListener('click', handleWindowClick);
      window.removeEventListener('keydown', handleEscape);
    };
  });
</script>

<div class="chart-container">
  {#if crossHighlightActive}
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="back-button" onclick={handleBackButton}>
      ← Back to Anthromes
    </div>
  {/if}

  <div class="rail">
    <div class="control-circles">
      <button class="circle-btn" title="Zoom out" onclick={zoomOut}>−</button>
      <button class="circle-btn" title="Reset" onclick={resetView}>◎</button>
      <button class="circle-btn" title="Zoom in" onclick={zoomIn}>＋</button>
      <button class="circle-btn" title="Rotate left" onclick={() => rotateBy(-rotateStepDeg)}>⟲</button>
      <button class="circle-btn" title="Rotate right" onclick={() => rotateBy(rotateStepDeg)}>⟳</button>
    </div>
    <div class="preset-row">
      {#each zoomPresets as zp}
        <button
          class="chip"
          onclick={() => {
            const rect = svgElement?.getBoundingClientRect();
            if (!rect) return;
            const anchorY = rect.height / 2 + resetYOffset;
            const anchorX = (zp <= 2)
              ? 0                                        // 2x: center on left edge
              : -rect.width * 1.5;                       // 7x: force farther left to expose rim
            applyZoom(zp, anchorX, anchorY);
            applyFiltersNow(); // ensure dimming updates immediately at this zoom
          }}>
          {zp}x
        </button>
      {/each}
    </div>
  </div>

  <div class="viz-area">
    <svg bind:this={svgElement} id="chart" aria-label="Radial phylogenetic tree visualization" role="img">
    </svg>

    <svg class="connector-overlay" width="100%" height="100%" aria-hidden="true">
      {#if connectorStart && connectorEnd && panelVisible}
        <line x1={connectorStart.x} y1={connectorStart.y} x2={connectorEnd.x} y2={connectorEnd.y}></line>
      {/if}
    </svg>
  </div>

  {#if panelVisible && panelContent}
    <aside class="info-panel" id="info-panel" bind:this={infoPanelEl} aria-live="polite">
      <div class="info-header">
        <div class="info-title">Details</div>
        <button class="close-btn" onclick={closePanel} aria-label="Close">✕</button>
      </div>
      <div class="panel-content biomes-tooltip">
        {@html panelContent}
      </div>
    </aside>
  {/if}

  <!-- Filters handled via circular menu in App; inline stack hidden -->
</div>

<style>
  .chart-container {
    width: 100vw;
    height: 100vh;
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(260px, 360px);
    align-items: center;
    position: relative;
  }

  .viz-area {
    grid-column: 1;
    grid-row: 1;
    position: relative;
    width: 100%;
    height: 100%;
    overflow: visible;
    background: var(--bg);
    z-index: 1;
    padding: 0 8px;
    box-sizing: border-box;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  svg {
    display: block;
    background: transparent;
    width: 100%;
    height: 100%;
  }

  .rail {
    grid-column: 2;
    grid-row: 1;
    align-self: flex-start;
    justify-self: end;
    width: 100%;
    max-width: 360px;
    padding: 14px 12px 18px;
    box-sizing: border-box;
    display: grid;
    gap: 14px;
  }

  .control-circles {
    display: grid;
    grid-template-columns: repeat(5, 1fr);
    gap: 8px;
    justify-items: center;
  }

  .circle-btn {
    width: 48px;
    height: 48px;
    border-radius: 50%;
    background: rgba(255, 255, 255, 0.08);
    border: 1px solid rgba(255, 255, 255, 0.18);
    color: var(--fg);
    font-weight: 700;
    font-size: 18px;
    cursor: pointer;
    transition: transform 0.12s ease, background 0.2s ease, border-color 0.2s ease;
    box-shadow: var(--shadow);
  }

  .circle-btn:hover {
    transform: translateY(-1px);
    background: rgba(255, 255, 255, 0.16);
    border-color: rgba(255, 255, 255, 0.28);
  }

  .circle-btn.active {
    background: var(--accent, rgba(255, 255, 255, 0.2));
    border-color: var(--accent, rgba(255, 255, 255, 0.35));
  }

  .preset-row {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    justify-content: center;
  }

  .chip {
    border-radius: 999px;
    border: 1px solid rgba(255, 255, 255, 0.18);
    background: rgba(255, 255, 255, 0.06);
    color: var(--fg);
    padding: 6px 10px;
    font-weight: 600;
    cursor: pointer;
    transition: background 0.2s ease, border-color 0.2s ease;
  }

  .chip:hover {
    background: rgba(255, 255, 255, 0.14);
    border-color: rgba(255, 255, 255, 0.28);
  }


  .connector-overlay {
    position: absolute;
    inset: 0;
    pointer-events: none;
  }

  .connector-overlay line {
    stroke: rgba(255, 255, 255, 0.5);
    stroke-width: 1.5;
    stroke-dasharray: 4 3;
  }

  .info-panel {
    position: absolute;
    top: 72px;
    right: 16px;
    width: 28vw;
    max-width: 340px;
    min-width: 220px;
    max-height: 72vh;
    background: var(--bg);
    border: 1px solid rgba(255, 255, 255, 0.35);
    border-radius: 12px;
    padding: 12px 14px;
    overflow: auto;
    color: var(--fg);
    z-index: 12;
    box-shadow: var(--shadow);
  }

  .panel-content.biomes-tooltip {
    position: relative;
    left: 0;
    top: 0;
    display: block;
    max-width: 100%;
    min-width: 0;
  }

  .info-panel .placeholder {
    color: var(--muted);
    font-size: 14px;
  }

  .info-panel .info-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 8px;
  }

  .info-panel .info-title {
    font-weight: 700;
    letter-spacing: 0.03em;
  }

  .info-panel .close-btn {
    background: rgba(255, 255, 255, 0.08);
    border: 1px solid rgba(255, 255, 255, 0.2);
    color: var(--fg);
    border-radius: 8px;
    width: 28px;
    height: 28px;
    cursor: pointer;
  }

  .filter-stack {
    position: absolute;
    top: 72px;
    right: 16px;
    width: 28vw;
    max-width: 340px;
    min-width: 220px;
    max-height: 72vh;
    background: rgba(14, 11, 22, 0.9);
    border: 1px solid rgba(255, 255, 255, 0.18);
    border-radius: 14px;
    padding: 10px 12px;
    display: grid;
    grid-template-columns: 1fr;
    gap: 10px;
    box-shadow: var(--shadow);
    z-index: 11;
    overflow: auto;
  }

  .panel-toggle {
    position: absolute;
    width: 42px;
    height: 42px;
    border-radius: 50%;
    background: rgba(14, 11, 22, 0.9);
    border: 1px solid rgba(255, 255, 255, 0.18);
    color: var(--fg);
    font-weight: 700;
    cursor: pointer;
    z-index: 1001;
    box-shadow: var(--shadow);
  }

  .panel-toggle.fab {
    right: 24px;
    bottom: 120px; /* stack above existing filter circle */
  }

  .filter-card {
    background: rgba(255, 255, 255, 0.02);
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 10px;
    padding: 10px;
  }

  .card-title {
    font-weight: 700;
    font-size: 13px;
    letter-spacing: 0.06em;
    margin-bottom: 8px;
    text-transform: uppercase;
    color: var(--muted);
  }

  .pill-row {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    justify-content: flex-start;
  }

  .pill-row.wrap {
    flex-wrap: wrap;
  }

  .pill {
    background: rgba(255, 255, 255, 0.08);
    color: var(--fg);
    border: 1px solid rgba(255, 255, 255, 0.16);
    border-radius: 999px;
    padding: 10px 12px;
    font-size: 12px;
    cursor: pointer;
    letter-spacing: 0.02em;
    transition: background 0.2s ease, border-color 0.2s ease, transform 0.12s ease;
  }

  .pill:hover {
    background: rgba(255, 255, 255, 0.14);
    border-color: rgba(255, 255, 255, 0.28);
    transform: translateY(-1px);
  }

  .pill.small {
    padding: 6px 8px;
    font-size: 11px;
  }

  .pill.active {
    background: var(--accent, #8af);
    color: var(--bg);
    border-color: var(--accent, #8af);
  }

  .proxy-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
    gap: 6px;
    margin-top: 8px;
  }

  :global(.region-path) {
    fill-opacity: 1;
    stroke: none;
  }

  :global(.region-label) {
    font-size: 24px;
    fill: var(--fg);
    font-weight: 300;
  }

  :global(.internal-label) {
    font-size: 6px;
    fill: var(--fg);
  }

  :global(.node circle) {
    stroke: white;
    stroke-width: 0.4;
  }

  :global(.link) {
    fill: none;
    stroke: var(--fg);
    stroke-width: 0.5;
    stroke-opacity: 0.35;
    vector-effect: non-scaling-stroke;
    stroke-linecap: round;
  }

  :global(.sgb-line) {
    stroke: var(--fg);
    stroke-width: 0.5;
    fill: none;
    opacity: 0.8;
    vector-effect: non-scaling-stroke;
    stroke-linecap: round;
  }

  :global(.hit) {
    fill: none;
    stroke: transparent;
    stroke-width: 14;
    pointer-events: stroke;
  }

  :global(.hit.sgb-hit) {
    stroke-width: 16;
  }

  :global(.bar-axis line) {
    stroke: var(--fg);
    stroke-width: 1;
  }

  :global(.bar-axis text) {
    fill: var(--fg);
    font-size: 10px;
  }

  :global(.hover-target) {
    cursor: crosshair;
  }

  :global(.is-hover.link),
  :global(.is-selected.link) {
    stroke-opacity: 1;
  }

  :global(.is-hover.link) {
    stroke-width: 1.2;
  }

  :global(.is-selected.link) {
    stroke-width: 2;
  }

  :global(.is-hover.sgb-line) {
    stroke-width: 1.2;
    opacity: 1;
  }

  :global(.is-selected.sgb-line) {
    stroke-width: 2;
    opacity: 1;
  }

  :global(.is-hover .node circle),
  :global(.node.is-hover circle) {
    r: 4;
  }

  :global(.node.is-selected circle) {
    r: 5;
    stroke-width: 1;
  }

  :global(.bar.is-hover),
  :global(.usgb.is-hover),
  :global(.western.is-hover) {
    filter: drop-shadow(0 0 6px rgba(255, 255, 255, 0.7));
  }

  :global(.bar.is-selected),
  :global(.usgb.is-selected),
  :global(.western.is-selected) {
    filter: drop-shadow(0 0 10px rgba(255, 255, 255, 0.9));
  }

  /* Biomes-specific tooltip styles */
  .biomes-tooltip {
    position: fixed;
    left: 0;
    top: 0;
    pointer-events: auto;
    z-index: 10;
    background: var(--panel);
    color: var(--fg);
    border: 1px solid rgba(255, 255, 255, 0.14);
    border-radius: 12px;
    box-shadow: var(--shadow);
    max-width: 380px;
    min-width: 260px;
    padding: 12px 14px;
    line-height: 1.45;
  }

  .biomes-tooltip.hidden {
    display: none;
  }

  :global(.biomes-tooltip .tip-header) {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 10px;
    margin-bottom: 8px;
  }

  :global(.biomes-tooltip .h-left) {
    display: flex;
    gap: 10px;
    align-items: flex-start;
  }

  :global(.biomes-tooltip .swatch) {
    width: 12px;
    height: 12px;
    border-radius: 50%;
    border: 1px solid rgba(255, 255, 255, 0.45);
    margin-top: 4px;
  }

  :global(.biomes-tooltip .title) {
    font-size: 16px;
    font-weight: 700;
    letter-spacing: 0.02em;
  }

  :global(.biomes-tooltip .subtitle) {
    font-size: 12px;
    color: var(--muted);
    margin-top: 2px;
  }

  :global(.biomes-tooltip .mini-glyph) {
    width: 110px;
    height: 110px;
    flex: 0 0 auto;
  }

  :global(.biomes-tooltip .summary) {
    font-size: 13px;
    margin: 8px 0 6px;
  }

  :global(.biomes-tooltip .summary b) {
    font-weight: 700;
  }

  :global(.biomes-tooltip .kv) {
    display: grid;
    grid-template-columns: 1fr auto;
    gap: 6px 12px;
    margin-top: 6px;
    font-size: 12px;
    border-top: 1px dashed rgba(255, 255, 255, 0.12);
    padding-top: 8px;
  }

  :global(.biomes-tooltip .kv .k) {
    color: var(--muted);
  }

  :global(.biomes-tooltip .actions) {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 8px;
  }

  :global(.biomes-tooltip button) {
    pointer-events: auto;
    background: #1d1a33;
    border: 1px solid rgba(255, 255, 255, 0.12);
    color: var(--fg);
    border-radius: 8px;
    padding: 6px 8px;
    font-size: 12px;
    cursor: pointer;
  }

  :global(.biomes-tooltip .genome-meter) {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 6px;
  }

  :global(.biomes-tooltip .genome-meter .ticks) {
    display: flex;
    gap: 2px;
    align-items: flex-end;
    flex-wrap: nowrap;
  }

  :global(.biomes-tooltip .genome-meter .tick) {
    width: 6px;
    height: 12px;
    background: transparent;
    border: 1px solid rgba(255, 255, 255, 0.25);
    border-radius: 2px;
  }

  :global(.biomes-tooltip .genome-meter .tick.filled) {
    background: var(--tickColor, #fff);
    border-color: transparent;
  }

  :global(.biomes-tooltip .genome-meter .num) {
    font-size: 12px;
    color: var(--muted);
    white-space: nowrap;
  }

  .back-button {
    position: absolute;
    top: 20px;
    left: 20px;
    background: rgba(14, 11, 22, 0.85);
    padding: 8px 12px;
    border-radius: 8px;
    font-size: 12px;
    color: #e5e7eb;
    border: 1px solid rgba(255, 255, 255, 0.12);
    cursor: pointer;
    user-select: none;
    z-index: 10;
  }

  .back-button:hover {
    background: rgba(14, 11, 22, 0.95);
    border-color: rgba(255, 255, 255, 0.25);
  }
</style>
