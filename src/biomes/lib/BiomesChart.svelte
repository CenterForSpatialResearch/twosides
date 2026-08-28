<script module>
  // Prevalence thresholds (against leaf.data.metadata; derived from the live
  // sgb_taxonomy_tree.json, 4,931 leaves). In a `module` block so App.svelte can
  // import them for its live captions — one source of truth for both the filter
  // logic here and the percentages there. "abundant"/"rare" are sample-count
  // axes; "widespread"/"concentrated" are country-count axes — don't cross them.
  export const ABUNDANT_MIN_SAMPLES = 8;       // Sample_ID_Count >= 8  (~27% of SGBs)
  export const RARE_MAX_SAMPLES = 1;           // Sample_ID_Count <= 1  (~40% of SGBs)
  export const WIDESPREAD_MIN_COUNTRIES = 4;   // Country_Count >= 4   (~25% of SGBs)
  export const CONCENTRATED_MAX_COUNTRIES = 1; // Country_Count <= 1   (~54% of SGBs)

  // ── Lifestyle-exclusivity colouring (UI Option 1) ────────────────────────────
  // A species is "non-Westernized-exclusive" when every sample it was ever
  // reconstructed from came from a non-Westernized cohort. Westernized_Count is
  // the number of DISTINCT Westernized values across the whole corpus (1 or 2),
  // and Westernized_Mode is that value when there is only one — both are true,
  // un-truncated corpus-wide figures on the tree, unlike the per-country SGB
  // rosters in sgb_edges_genome_sample_study.csv (capped at 10–20 genomes per
  // SGB, which inflates apparent exclusivity). 315 of 4,930 SGBs qualify; 95% of
  // them were unknown to science before this study.
  export const LIFESTYLE_MAGENTA = '#ff2d95'; // found only in non-Westernized populations
  export const LIFESTYLE_SHARED = '#f2eef8';  // also found in Westernized populations

  export function isNonWesternExclusive(metadata) {
    if (!metadata) return false;
    return Number(metadata.Westernized_Count) === 1 && metadata.Westernized_Mode === 'No';
  }
</script>

<script>
  import { onMount, untrack } from 'svelte';
  import * as d3 from 'd3';
  import { createEventDispatcher } from 'svelte';
  import { screenToDesign, elementScale } from '../../shared/stage.svelte.js';
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
    unknownFilter = $bindable('all'), // 'all' | 'unknown' | 'known'
    westernFilter = $bindable('any'), // 'any' | 'western' | 'nonwestern'
    abundanceFilter = $bindable('any'), // 'any' | 'abundant' | 'rare'
    geoFilter = $bindable('any'),       // 'any' | 'widespread' | 'concentrated'
    bodySiteFilter = $bindable(new Set()),
    proxyKey = $bindable(null),
    studyKey = $bindable(null),
    countryIso3 = $bindable(null),
    // Overlay-annotation state — multi-species range coming from anthromes
    // (cell tooltip or SGB link). Rendered as a dismissible rail tag by the
    // App; the internal tree-dim behaviour is unchanged.
    rangeSource = $bindable(null),
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
  let maxGenomeCount = $state(1);
  let tickDenom = $state(1);

  // Cross-highlighting state
  let highlightedSGBs = $state(new Set());
  let crossHighlightActive = $state(false);

  // Country name lookup (ISO3 → display name)
  let iso3ToName = $state(new Map());

  // Constants
  const fullSize = 6400;        // base SVG dimension for full view
  const previewSize = 1200;     // smaller preview mode
  const fullMargin = 500;       // padding to keep outer rings/labels inside viewBox
  const previewMargin = 100;
  const zoomMin = 0.5;
  const zoomMax = 7.0;           // allow deeper preset zooms
  const zoomStep = 1.25;
  const anchorPx = null;         // optional explicit anchor
  const rotateStepDeg = 10;
  const resetPx = null;          // override anchor if set
  const zoomLevels = [1, 2, 7];
  const edgeMarginPx = 12;
  const geographyFilters = ['Western', 'Non-Western', 'Unknown'];
  const backgroundColor = '#0e0b16';
  const DIM_OPACITY = 0.02;
  const DIM_LABEL_OPACITY = 0.10;
  let currentTransform = d3.zoomIdentity;
  let zoomBehavior = null;
  let zoomIdx = $state(0);
  let rotationDeg = 0;
  let infoPanelEl = $state(null);
  let panelContent = $state('');
  let panelVisible = $state(false);
  const dispatch = createEventDispatcher();
  let connectorStart = $state(null);
  let connectorEnd = $state(null);
  let viewportW = $state(0);
  let viewportH = $state(0);
  let proxySgbMap = {};
  let studySgbMap = {};
  let countrySgbMap = {};
  let proxyLoaded = false;
  let studyLoaded = false;
  let countryLoaded = false;
  let cachedLeaves = null;

  // ── Canvas spin engine (Mode C) ──────────────────────────────────────────
  let vizAreaEl = $state(null);
  let canvasEl = $state(null);
  let lastMarkerX = -1, lastMarkerY = -1;  // last reported marker screen pos (leader line)
  let cctx = null;                 // 2D context
  let dpr = 1;
  let boxW = 0, boxH = 0, sBase = 0; // viewBox→css mapping (S_css/dim, plus center = box/2)
  let fgColor = '#e9e6f2';
  let geom = null;                 // { dim, radius, outerRadius, barInner, usgb*, west*, ... }
  let fullBatches = null;          // batches for all leaves (no filter)
  let keepBatches = null, dimBatches = null; // partitioned when a filter/highlight is active
  let bandList = [];               // region gradient bands (drawn on canvas): {path, color, innerR, outerR, keyNode}
  let leavesByAngle = [];          // leaves sorted by .x for center-leaf binary search
  let selectableByAngle = [];      // subset of leavesByAngle eligible for center selection
                                   // (= leavesByAngle when no filter; only kept leaves when filtered)
  let keepSet = null;              // null = no filter (everything kept)
  let selIndex = -1;               // index into selectableByAngle of the center-selected leaf
  let selLeaf = null;
  // Cached Path2D of the selected leaf's branch line (root → leaf), so the
  // per-frame highlight during a spin only rebuilds when the selection changes.
  let selLinkPath = null;
  let selLinkLeafId = null;

  // rotation / momentum
  let angVel = 0;                  // deg/frame
  let spinning = false;
  let dragging = false;
  let dragSamples = [];            // {a, t} recent pointer angles for velocity
  let lastCommittedLeafId = null;  // throttle details-panel updates

  // draw scheduling
  let dirty = false;
  let rafId = 0;
  let inMotion = false;            // true while dragging or coasting → resolution cap
  let renderTick = $state(0);      // bumped each render() so label-gate effect re-runs

  const FRICTION = 0.94;           // per-frame angular decay
  const MIN_ANGVEL = 0.05;         // deg/frame → settle
  const MOTION_DPR_CAP = 1.25;     // cap backing scale during motion (Surface hardening)
  const LIVE_COMMIT_MS = 90;       // throttle for live details-panel updates while spinning
  const FINISH_DELAY = 90;         // ms after the wheel stops before the heavy finish (full-DPR + labels)
  let lastCommitT = 0;
  let finishTimer = 0;

  function closePanel() {
    panelVisible = false;
    panelContent = '';
    connectorStart = null;
    connectorEnd = null;
    currentTooltipDatum = null;
    tooltipPinned = false;
    dispatch('detail-close');
  }

  function showPanel(html, datum) {
    panelContent = html;
    panelVisible = !!html;
    if (panelVisible) {
      // Emit the leaf's structured metadata alongside the HTML so the App
      // rail can compose graphical add-ons (mini-glyph, lineage chips, genome
      // meter, badges) without re-parsing the HTML blob.
      let meta = null;
      if (datum) {
        const ancestors = datum
          .ancestors()
          .slice(0, -1)
          .reverse()
          .map((a) => ({
            depth: a.depth,
            name: (a.data?.name || '').split('__').pop()?.replace(/_/g, ' ') || ''
          }))
          .filter((a) => a.name);
        meta = {
          metadata: datum.data?.metadata || null,
          name: datum.data?.name || null,
          phylum: getPhylum(datum),
          leafId: datum.leafId ?? null,
          ancestors,
          genomeCount: Number(datum.data?.metadata?.['#_Reconstructed_genomes']) || 0,
          maxGenomeCount,
          glyphPath: buildMiniGlyphPath(datum)
        };
      }
      dispatch('detail', { content: html, point: connectorStart, meta });
    } else {
      dispatch('detail-close');
    }
  }

  // Mini-glyph path: a radial line traced through the leaf's ancestor chain
  // (root → phylum → … → leaf) in the disk's polar coordinates, scaled into a
  // small preview radius. Shared between the tooltip HTML and the App-side
  // enriched detail card so both stay in sync visually.
  function buildMiniGlyphPath(d) {
    const chain = d.ancestors().reverse();
    const yVals = chain.map((n) => n.y);
    const yMin = Math.min(...yVals);
    const yMax = Math.max(...yVals);
    const rMin = 12, rMax = 50;
    const line = d3
      .lineRadial()
      .curve(d3.curveBundle.beta(0.85))
      .angle((n) => n.x)
      .radius((n) =>
        yMax === yMin
          ? (rMin + rMax) / 2
          : rMin + ((n.y - yMin) / (yMax - yMin)) * (rMax - rMin)
      );
    return line(chain);
  }

  function applyTransforms() {
    if (!svgElement) return;
    const g = d3.select(svgElement).select('g.zoom-container');
    g.attr('transform', `${currentTransform} rotate(${rotationDeg || 0})`);
    requestDraw(); // canvas mirrors the same transform
  }

  function clampScale(k) {
    return Math.max(zoomMin, Math.min(zoomMax, k));
  }

  function computeDefaultScale(rect) {
    // ViewBox already scales to viewport; start at natural size
    return 1;
  }

  function radiusForSize() {
    const dim = size === 'full' ? fullSize : previewSize;
    const margin = size === 'full' ? fullMargin : previewMargin;
    return dim / 2 - margin;
  }

  function outerRadiusForSize() {
    // Add space for bars and outer adornments: radius + 110 + 5% of radius
    const r = radiusForSize();
    return r * 1.05 + 110;
  }

  function anchorPoint(rect, k) {
    const base = {
      x: anchorPx ?? rect.width / 2,
      y: rect.height / 2
    };
    const dim = size === 'full' ? fullSize : previewSize;
    const radius = radiusForSize();
    const outerRadius = outerRadiusForSize();
    const baseScale = rect.width / dim;
    const rScreen = radius * baseScale * k;
    const outerScreen = outerRadius * baseScale * k;

    if (k === 1) {
      return base;
    }

    if (k === 2) {
      // Keep center on left edge, vertically centered
      return { x: 0, y: base.y };
    }

    if (k === 7) {
      // Position so the rightmost content (bars) is visible with a small margin.
      // This function works in screen px (rect), so scale the design-px margin up.
      const targetX = rect.width - outerScreen - edgeMarginPx * elementScale(svgElement, rect);
      return { x: targetX, y: base.y };
    }

    return base;
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
    const nextIdx = clampScaleIndex(zoomIdx + (dir > 0 ? 1 : -1));
    setZoomByIndex(nextIdx);
  }

  const zoomIn = () => performZoomStep(1);
  const zoomOut = () => performZoomStep(-1);

  function clampScaleIndex(idx) {
    return Math.max(0, Math.min(zoomLevels.length - 1, idx));
  }

  function emitZoomChange() {
    dispatch('zoomchange', { level: zoomLevels[zoomIdx], index: zoomIdx });
  }

  function setZoomByIndex(idx) {
    if (!svgElement) return;
    const rect = svgElement.getBoundingClientRect();
    zoomIdx = clampScaleIndex(idx);
    const k = zoomLevels[zoomIdx];
    const { x: anchorX, y: anchorY } = anchorPoint(rect, k);
    applyZoom(k, anchorX, anchorY);
    syncLabelZoom();
    emitZoomChange();
  }

  function resetView() {
    if (!svgElement) return;
    setZoomByIndex(0);
    rotationDeg = 0;
    applyTransforms();
  }

  // Expose controls for parent rail
  export function zoomInControl() { zoomIn(); }
  export function zoomOutControl() { zoomOut(); }
  export function resetControl() {
    // Full reset to page-load state: drop any URL cross-highlight, close the
    // details panel, and reset zoom + rotation. (Filters live in App.)
    clearHighlight();
    closePanel();
    resetView();
  }
  export function rotateLeftControl() { rotateBy(-rotateStepDeg); }
  export function rotateRightControl() { rotateBy(rotateStepDeg); }

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
    const margin = size === 'full' ? fullMargin : previewMargin;
    const radius = dim / 2 - margin;

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
    cachedLeaves = leaves;
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

    // Shared geometry for the canvas engine + center-leaf selection
    fgColor = resolveFg();
    const maxDepth = d3.max(root.descendants(), d => d.depth);
    const outerRadius = barInner + barMaxLength; // outer extent (for the center marker)
    geom = { dim, radius, outerRadius, barInner, barScale, maxRec,
             usgbInner, usgbOuter, westInner, westOuter, line };

    // ── SVG overlay (sparse): region bands are canvas; region labels stay SVG ──
    const labelsLayer = g.append('g').attr('class', 'region-labels');
    bandList = [];
    let arcId = 0;
    for (let depth = 2; depth <= maxDepth; depth++) {
      const dnodes = root.descendants().filter(d => d.depth === depth);
      d3.groups(dnodes, d => getPhylum(d)).forEach(([phylum, group]) => {
        if (group.length < 2) return;
        const sorted = group.sort((a, b) => a.x - b.x);
        const innerR = sorted[0].y - (radius / maxDepth) * 0.75;
        const outerR = sorted[0].y;
        const ptsOuter = sorted.map(d => [d.x, outerR]);
        const ptsInner = sorted.map(d => [d.x, innerR]).reverse();
        const pathData = d3.lineRadial()
          .curve(d3.curveCardinalClosed.tension(0.7))(ptsOuter.concat(ptsInner));

        // region band → drawn on canvas with a radial gradient
        bandList.push({
          path: new Path2D(pathData),
          color: colorMapping[phylum] || colorMapping.Other,
          innerR, outerR,
          keyNode: sorted[0]
        });

        // curved region label → SVG overlay
        const arcID = `arc-${arcId++}`;
        defs.append('path').attr('id', arcID).attr('d', d3.arc()({
          innerRadius: outerR - 12, outerRadius: outerR - 12,
          startAngle: sorted[0].x, endAngle: sorted[sorted.length - 1].x
        }));
        const labelText = labelsLayer.append('text').attr('class', 'region-label').datum(sorted[0]);
        labelText.append('textPath')
          .attr('xlink:href', `#${arcID}`)
          .attr('startOffset', '50%')
          .text(phylum.replace(/_/g, ' '));
      });
    }

    // Internal labels (SVG overlay)
    const internals = g.append('g').attr('class', 'internal-labels')
      .selectAll('text.internal-label')
      .data(root.descendants().filter(d => d.children))
      .join('text')
      .attr('class', 'internal-label')
      .attr('transform', d => `rotate(${d.x * 180 / Math.PI - 90}) translate(${d.y},0)` + (d.x >= Math.PI ? ' rotate(180)' : ''))
      .attr('dy', '0.31em')
      .attr('x', d => d.x < Math.PI ? 6 : -6)
      .attr('text-anchor', d => d.x < Math.PI ? 'start' : 'end')
      .text(d => (d.data.name || '').split('__').pop().replace(/_/g, ' '));

    // Bar axis (SVG overlay)
    const axisGroup = g.append('g').attr('class', 'bar-axis');
    axisGroup.append('line')
      .attr('x1', 0).attr('y1', barInner)
      .attr('x2', 0).attr('y2', barInner + barMaxLength)
      .attr('stroke', 'white');
    [1, 10, 100, 500].filter(v => v <= maxRec).forEach(t => {
      const y = barInner + barScale(t);
      axisGroup.append('line').attr('x1', 0).attr('y1', y).attr('x2', 8).attr('y2', y);
      axisGroup.append('text').attr('x', 10).attr('y', y).attr('dy', '.32em').text(t);
    });

    // Leaves sorted by angle → binary-search for the center-selected leaf
    leavesByAngle = leaves.slice().sort((a, b) => a.x - b.x);
    selectableByAngle = leavesByAngle; // no filter yet on (re)build

    // Build canvas Path2D batches for all leaves
    fullBatches = buildBatches(leaves);
    keepSet = null; keepBatches = null; dimBatches = null;
    lastCommittedLeafId = null;
    // geom.line coords changed — invalidate the selected-leaf path cache
    selLinkLeafId = null; selLinkPath = null;

    // Overlay selections that dim via opacity when filtered
    handles.selections = {
      internals,
      labels: d3.selectAll(labelsLayer.selectAll('text').nodes())
    };

    // untrack so this render $effect doesn't re-subscribe to filter props
    // (the dedicated filter $effect handles filter changes via scheduleFilters).
    untrack(() => {
      resizeCanvas();
      applyFiltersNow();   // partitions batches + dims overlay when a filter is active
      applyTransforms();   // overlay transform + marks canvas dirty
      syncLabelZoom();     // phylum labels only at closest zoom
      requestDraw();
      // Show the initial center leaf in the details panel (center-select is always on)
      updateSelectionFromAngle();
      commitSelectionToPanel();
      // Bump inside untrack so this render $effect doesn't subscribe to renderTick
      // (reading it here would self-trigger the effect → infinite loop). The write
      // still notifies the label-gate effect below.
      renderTick++;
    });
  }

  // Reactive label gate: re-runs on zoom change and after each render.
  $effect(() => { renderTick; zoomIdx; syncLabelZoom(); });

  // ── Canvas engine ─────────────────────────────────────────────────────────
  function resolveFg() {
    try {
      const v = getComputedStyle(svgElement).getPropertyValue('--fg').trim();
      return v || '#e9e6f2';
    } catch { return '#e9e6f2'; }
  }

  function hexToRgba(hex, a) {
    const c = (hex || '#000').replace('#', '');
    const n = c.length === 3 ? c.split('').map(x => x + x).join('') : c;
    const r = parseInt(n.slice(0, 2), 16), gg = parseInt(n.slice(2, 4), 16), bb = parseInt(n.slice(4, 6), 16);
    return `rgba(${r},${gg},${bb},${a})`;
  }

  // Build the per-leaf Path2D batches for a leaf subset (grouped by fill colour).
  function buildBatches(leafList) {
    const b = {
      sgbLine: new Path2D(),
      link: new Path2D(),
      barsByColor: new Map(),
      nodesByColor: new Map(),
      usgbWhite: new Path2D(), usgbBlack: new Path2D(),
      westWhite: new Path2D(), westBlack: new Path2D()
    };
    if (!geom) return b;
    const { barInner, barScale, usgbInner, usgbOuter, westInner, westOuter, line } = geom;
    const arc = d3.arc();
    const grp = (map, color) => { let p = map.get(color); if (!p) { p = new Path2D(); map.set(color, p); } return p; };
    for (const d of leafList) {
      const theta = d.x - Math.PI / 2;
      const cos = Math.cos(theta), sin = Math.sin(theta);
      const cnt = d.data.metadata?.["#_Reconstructed_genomes"] || 0;
      const color = colorMapping[getPhylum(d)] || colorMapping.Other;
      // sgb radial line (leaf rim → beyond the bars)
      const rOut = barInner + barScale(cnt);
      b.sgbLine.moveTo(cos * d.y, sin * d.y);
      b.sgbLine.lineTo(cos * rOut, sin * rOut);
      // bundle-curve link root → leaf
      b.link.addPath(new Path2D(line(d.ancestors().reverse())));
      // node dot
      const nx = cos * d.y, ny = sin * d.y;
      const ndp = grp(b.nodesByColor, color);
      ndp.moveTo(nx + 2.5, ny); ndp.arc(nx, ny, 2.5, 0, Math.PI * 2);
      // genome bar
      grp(b.barsByColor, color).addPath(new Path2D(arc({
        innerRadius: barInner, outerRadius: rOut, startAngle: d.x - 0.0005, endAngle: d.x + 0.0005
      })));
      // unknown ring
      (parseUSGB(d.data.metadata) === 'Yes' ? b.usgbWhite : b.usgbBlack).addPath(new Path2D(arc({
        innerRadius: usgbInner, outerRadius: usgbOuter, startAngle: d.x - 0.0005, endAngle: d.x + 0.0005
      })));
      // western ring
      (isWesternNo(d.data.metadata) ? b.westWhite : b.westBlack).addPath(new Path2D(arc({
        innerRadius: westInner, outerRadius: westOuter, startAngle: d.x - 0.0005, endAngle: d.x + 0.0005
      })));
    }
    return b;
  }

  const realDpr = () => window.devicePixelRatio || 1;

  function resizeCanvas() {
    if (!canvasEl || !vizAreaEl) return;
    // Layout px, not getBoundingClientRect() — the latter reports the
    // stage-transformed box, which would size the disk to the scaled view.
    boxW = vizAreaEl.clientWidth; boxH = vizAreaEl.clientHeight;
    const dimv = geom ? geom.dim : (size === 'full' ? fullSize : previewSize);
    sBase = Math.min(boxW, boxH) / dimv;
    dpr = inMotion ? Math.min(realDpr(), MOTION_DPR_CAP) : realDpr();
    canvasEl.style.width = boxW + 'px';
    canvasEl.style.height = boxH + 'px';
    canvasEl.width = Math.max(1, Math.round(boxW * dpr));
    canvasEl.height = Math.max(1, Math.round(boxH * dpr));
    cctx = canvasEl.getContext('2d');
    dirty = true;
  }

  // device = A·p + E ; A = dpr·sBase·k·R(rot), E = dpr·center + dpr·sBase·t
  function canvasMatrix() {
    const k = currentTransform.k || 1;
    const tx = currentTransform.x || 0, ty = currentTransform.y || 0;
    const rot = (rotationDeg || 0) * Math.PI / 180;
    const s = dpr * sBase * k;
    const cos = Math.cos(rot), sin = Math.sin(rot);
    return {
      a: s * cos, b: s * sin, c: -s * sin, d: s * cos,
      e: dpr * (boxW / 2) + dpr * sBase * tx,
      f: dpr * (boxH / 2) + dpr * sBase * ty,
      k, s
    };
  }

  function draw() {
    if (!cctx || !geom || !fullBatches) return;
    const m = canvasMatrix();
    cctx.setTransform(1, 0, 0, 1, 0, 0);
    cctx.clearRect(0, 0, canvasEl.width, canvasEl.height);
    cctx.setTransform(m.a, m.b, m.c, m.d, m.e, m.f);
    cctx.lineCap = 'round';
    cctx.lineJoin = 'round';

    const nsw = 0.5 / (sBase * (m.k || 1)); // non-scaling 0.5px stroke in user units
    const filtered = !!(keepBatches && dimBatches);
    const layer = (fn) => { if (filtered) { fn(dimBatches, DIM_OPACITY); fn(keepBatches, 1); } else fn(fullBatches, 1); };

    // 1) sgb lines (fg, α0.8)
    cctx.strokeStyle = fgColor;
    layer((b, a) => { cctx.globalAlpha = 0.8 * a; cctx.lineWidth = nsw; cctx.stroke(b.sgbLine); });

    // 2) region bands (radial gradient, canvas)
    for (const band of bandList) {
      const kept = !keepSet || keepSet.has(band.keyNode);
      cctx.globalAlpha = kept ? 1 : DIM_OPACITY;
      const grad = cctx.createRadialGradient(0, 0, band.innerR, 0, 0, band.outerR);
      grad.addColorStop(0, hexToRgba(backgroundColor, 0));
      grad.addColorStop(1, band.color);
      cctx.fillStyle = grad;
      cctx.fill(band.path);
    }

    // 3) links (fg, α0.35)
    cctx.strokeStyle = fgColor;
    layer((b, a) => { cctx.globalAlpha = 0.35 * a; cctx.lineWidth = nsw; cctx.stroke(b.link); });

    // 4) node dots (skip while moving — resolution cap)
    if (!inMotion) {
      layer((b, a) => { for (const [color, p] of b.nodesByColor) { cctx.globalAlpha = a; cctx.fillStyle = color; cctx.fill(p); } });
    }

    // 5) genome bars
    layer((b, a) => { for (const [color, p] of b.barsByColor) { cctx.globalAlpha = a; cctx.fillStyle = color; cctx.fill(p); } });

    // 6) unknown ring + separator
    layer((b, a) => {
      cctx.globalAlpha = 1 * a; cctx.fillStyle = '#fff'; cctx.fill(b.usgbWhite);
      cctx.globalAlpha = 0.5 * a; cctx.fillStyle = '#000'; cctx.fill(b.usgbBlack);
    });
    cctx.globalAlpha = 1; cctx.strokeStyle = '#fff'; cctx.lineWidth = 2;
    cctx.beginPath(); cctx.arc(0, 0, (geom.usgbInner + geom.usgbOuter) / 2, 0, Math.PI * 2); cctx.stroke();

    // 7) western ring + separator
    layer((b, a) => {
      cctx.globalAlpha = 1 * a; cctx.fillStyle = '#fff'; cctx.fill(b.westWhite);
      cctx.globalAlpha = 0.5 * a; cctx.fillStyle = '#000'; cctx.fill(b.westBlack);
    });
    cctx.globalAlpha = 1; cctx.strokeStyle = '#fff'; cctx.lineWidth = 2;
    cctx.beginPath(); cctx.arc(0, 0, (geom.westInner + geom.westOuter) / 2, 0, Math.PI * 2); cctx.stroke();

    // 8) selected-leaf emphasis. Drawn every frame (not gated on inMotion) so the
    //    selected species stays lit while the wheel spins.
    if (selLeaf) {
      const theta = selLeaf.x - Math.PI / 2;
      const cos = Math.cos(theta), sin = Math.sin(theta);
      const cnt = selLeaf.data.metadata?.["#_Reconstructed_genomes"] || 0;
      const rOut = geom.barInner + geom.barScale(cnt);
      const px = 1 / (sBase * (m.k || 1)); // one CSS px in user units

      // Full branch line (root → leaf), rebuilt only when the selection changes.
      if (selLeaf.leafId !== selLinkLeafId) {
        selLinkLeafId = selLeaf.leafId;
        selLinkPath = geom.line ? new Path2D(geom.line(selLeaf.ancestors().reverse())) : null;
      }

      // Spoke path (leaf node → bar tip), extending the branch outward.
      const spoke = new Path2D();
      spoke.moveTo(cos * selLeaf.y, sin * selLeaf.y);
      spoke.lineTo(cos * rOut, sin * rOut);

      // Line casing: a dark halo separates the highlight from the surrounding
      // pale links so the selected species reads clearly even in a dense bundle.
      cctx.globalAlpha = 1;
      cctx.strokeStyle = backgroundColor;
      cctx.lineWidth = 5 * px;
      if (selLinkPath) cctx.stroke(selLinkPath);
      cctx.stroke(spoke);

      // Bright core on top.
      cctx.strokeStyle = '#fff';
      cctx.lineWidth = 2 * px;
      if (selLinkPath) cctx.stroke(selLinkPath);
      cctx.stroke(spoke);

      // Leaf node dot with a dark ring, matching the casing treatment.
      const nx = cos * selLeaf.y, ny = sin * selLeaf.y;
      cctx.beginPath(); cctx.arc(nx, ny, 5, 0, Math.PI * 2);
      cctx.fillStyle = '#fff'; cctx.fill();
      cctx.lineWidth = 1.5 * px; cctx.strokeStyle = backgroundColor; cctx.stroke();
    }

    // 9) fixed selection marker at screen right-center (3 o'clock from disk centre)
    cctx.setTransform(1, 0, 0, 1, 0, 0);
    cctx.globalAlpha = 1;
    const cxDev = m.e, cyDev = m.f;
    const rimDev = geom.outerRadius * m.s;
    const mx = cxDev + rimDev + 10 * dpr, my = cyDev;
    cctx.fillStyle = '#fff';
    cctx.beginPath();
    cctx.moveTo(mx, my);
    cctx.lineTo(mx + 16 * dpr, my - 9 * dpr);
    cctx.lineTo(mx + 16 * dpr, my + 9 * dpr);
    cctx.closePath();
    cctx.fill();

    // Report the marker's design-space position so App can draw a leader to the
    // details panel. mx/my are device px; /dpr puts them in the canvas's own
    // design px, and screenToDesign rebases the canvas origin onto the stage.
    // (Marker is rotation-invariant, so only emit when it actually moves — zoom/pan/resize.)
    const cr = canvasEl.getBoundingClientRect();
    const origin = screenToDesign(cr.left, cr.top);
    const markX = origin.x + (mx + 16 * dpr) / dpr;
    const markY = origin.y + my / dpr;
    if (Math.abs(markX - lastMarkerX) > 0.5 || Math.abs(markY - lastMarkerY) > 0.5) {
      lastMarkerX = markX; lastMarkerY = markY;
      dispatch('marker', { x: markX, y: markY });
    }
  }

  function requestDraw() {
    dirty = true;
    if (!rafId) rafId = requestAnimationFrame(frameTick);
  }

  function frameTick() {
    rafId = 0;
    if (spinning && !dragging) {
      rotationDeg = (rotationDeg + angVel + 360) % 360;
      angVel *= FRICTION;
      if (Math.abs(angVel) < MIN_ANGVEL) { angVel = 0; spinning = false; settle(); }
      dirty = true;
    }
    if (dirty) {
      dirty = false;
      updateSelectionFromAngle();
      if (svgElement) d3.select(svgElement).select('g.zoom-container')
        .attr('transform', `${currentTransform} rotate(${rotationDeg || 0})`);
      draw();
    }
    // Live details-panel update while animating (throttled to avoid HTML thrash)
    if (spinning || dragging) {
      const now = performance.now();
      if (now - lastCommitT >= LIVE_COMMIT_MS) { lastCommitT = now; commitSelectionToPanel(); }
      rafId = requestAnimationFrame(frameTick);
    }
  }

  function settle() {
    inMotion = false;
    // Paint the final resting frame cheaply — at the current (motion) DPR and with
    // the overlay still hidden — so the last frames of the spin stay smooth.
    requestDraw();
    commitSelectionToPanel();
    // Defer the expensive finish (full-DPR re-render + label reveal/fade) until the
    // wheel is visibly at rest. Doing it inline stutters the landing frame, and a
    // brief post-stop load reads far better than jerky rotation.
    scheduleFinish();
  }

  function scheduleFinish() {
    cancelFinish();
    finishTimer = setTimeout(finishSettle, FINISH_DELAY);
  }

  function cancelFinish() {
    if (finishTimer) { clearTimeout(finishTimer); finishTimer = 0; }
  }

  function finishSettle() {
    finishTimer = 0;
    if (inMotion) return;      // a new spin/drag began during the delay — skip
    resizeCanvas();            // upgrade the backing store to full DPR
    requestDraw();             // sharp re-render now that we're at rest
    showOverlay(true, true);   // labels/axis fade in (0.5s), no longer during motion
  }

  // The overlay (region/internal labels + bar axis) is hidden during motion. On
  // settle, `fade` ramps its opacity 0→1 over 0.5s so labels don't pop in — most
  // noticeable when zoomed in, where labels are dense.
  function showOverlay(v, fade = false) {
    if (!svgElement) return;
    const g = d3.select(svgElement).select('g.zoom-container');
    if (g.empty()) return;
    g.interrupt(); // cancel any in-flight fade before re-hiding/re-showing
    if (!v) {
      g.style('display', 'none').style('opacity', null);
    } else if (fade) {
      g.style('display', null).style('opacity', 0)
        .transition().duration(500).style('opacity', 1);
    } else {
      g.style('display', null).style('opacity', null);
    }
  }

  // Phylum + internal labels only at the closest zoom — keeps them from popping on rotate.
  function syncLabelZoom() {
    if (!svgElement) return;
    const show = zoomIdx === zoomLevels.length - 1;
    const sel = d3.select(svgElement);
    sel.select('g.region-labels').style('display', show ? null : 'none');
    sel.select('g.internal-labels').style('display', show ? null : 'none');
  }

  // ── Center-leaf selection (angle math) ────────────────────────────────────
  function nearestLeafByAngle(target) {
    const arr = selectableByAngle;
    const n = arr.length;
    if (!n) return -1;
    // binary search for first .x >= target
    let lo = 0, hi = n;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid].x < target) lo = mid + 1; else hi = mid; }
    const i1 = lo % n, i0 = (lo - 1 + n) % n;
    const d1 = angDist(arr[i1].x, target), d0 = angDist(arr[i0].x, target);
    return d0 <= d1 ? i0 : i1;
  }
  function angDist(a, b) { let d = Math.abs(a - b) % (2 * Math.PI); if (d > Math.PI) d = 2 * Math.PI - d; return d; }

  function updateSelectionFromAngle() {
    if (!selectableByAngle.length) return;
    const rot = (rotationDeg || 0) * Math.PI / 180;
    // a leaf at .x is drawn toward screen angle (.x - π/2 + rot); we want that = 0 (screen right)
    let target = (Math.PI / 2 - rot) % (2 * Math.PI);
    if (target < 0) target += 2 * Math.PI;
    selIndex = nearestLeafByAngle(target);
    selLeaf = selectableByAngle[selIndex] || null;
  }

  function commitSelectionToPanel() {
    if (!selLeaf) return;
    if (selLeaf.leafId === lastCommittedLeafId) return;
    lastCommittedLeafId = selLeaf.leafId;
    selectedLeafId = selLeaf.leafId;
    connectorStart = null;
    currentTooltipDatum = selLeaf;
    showPanel(createTooltipHTML(selLeaf), selLeaf);
  }

  // ── Drag-to-spin + momentum ───────────────────────────────────────────────
  function pointerAngleDeg(ev) {
    // boxW/boxH and sBase are design px, so bring the pointer into that space
    // first rather than mixing it with the screen-space rect.
    const rect = vizAreaEl.getBoundingClientRect();
    const s = elementScale(vizAreaEl, rect);
    const px = (ev.clientX - rect.left) / s;
    const py = (ev.clientY - rect.top) / s;
    const cx = boxW / 2 + sBase * (currentTransform.x || 0);
    const cy = boxH / 2 + sBase * (currentTransform.y || 0);
    return Math.atan2(py - cy, px - cx) * 180 / Math.PI;
  }

  function onSpinPointerDown(ev) {
    if (!geom) return;
    if (ev.button != null && ev.button !== 0) return;
    dragging = true; spinning = false; angVel = 0;
    cancelFinish();  // abort any pending post-stop finish from a prior settle
    inMotion = true; resizeCanvas(); showOverlay(false);
    dragSamples = [{ a: pointerAngleDeg(ev), t: performance.now() }];
    try { vizAreaEl.setPointerCapture?.(ev.pointerId); } catch {}
    window.addEventListener('pointermove', onSpinPointerMove);
    window.addEventListener('pointerup', onSpinPointerUp, { once: true });
    requestDraw();
  }

  function onSpinPointerMove(ev) {
    if (!dragging) return;
    const a = pointerAngleDeg(ev);
    const prev = dragSamples[dragSamples.length - 1];
    let delta = a - prev.a;
    while (delta > 180) delta -= 360;
    while (delta < -180) delta += 360;
    rotationDeg = (rotationDeg + delta + 360) % 360;
    dragSamples.push({ a, t: performance.now() });
    if (dragSamples.length > 5) dragSamples.shift();
    requestDraw();
  }

  function onSpinPointerUp() {
    dragging = false;
    window.removeEventListener('pointermove', onSpinPointerMove);
    const n = dragSamples.length;
    if (n >= 2) {
      const first = dragSamples[0], last = dragSamples[n - 1];
      let dA = last.a - first.a;
      while (dA > 180) dA -= 360;
      while (dA < -180) dA += 360;
      const dT = Math.max(1, last.t - first.t);
      angVel = Math.max(-30, Math.min(30, (dA / dT) * 16)); // deg per ~16ms frame
    } else angVel = 0;
    if (Math.abs(angVel) >= MIN_ANGVEL) { spinning = true; requestDraw(); }
    else settle();
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

    // Summary text. The genome count already lives here ("includes N genomes"),
    // so the old standalone "N genomes identified" meter was redundant and is
    // dropped. The country-highlight action is an inline link right after the
    // locations, so it reads as one sentence and keeps the panel compact.
    const loc = locationsFromMeta(meta, iso3ToName);
    const sgb = sgbLabel(d);
    const recWord = rec === 1 ? 'genome' : 'genomes';
    const highlightLink = (leaf && meta?.SGB_ID)
      ? ` <a class="detail-link" data-act="highlight-countries" data-sgb="${meta.SGB_ID}">Highlight countries where this species is found →</a>`
      : '';
    const summary = `<b>${sgb}</b> includes <b>${rec.toLocaleString()}</b> ${recWord} within the <b>${phylum.replace(/_/g, ' ')}</b> phylum, identified from <b>${loc}</b>.${highlightLink}`;

    // The title / phylum / lineage / status-geo pairs are now composed
    // graphically by the App (mini-glyph, breadcrumb chips, badge row, genome
    // meter). The tooltip HTML keeps just the descriptive prose summary and
    // the cross-side "highlight countries" call-to-action.
    return `<div class="summary">${summary}</div>`;
  }

  // (Center-select drives selection now — per-mark tap handlers/hit layers were removed.)

  function clearSelected() {
    selectedLeafId = null;
  }

  // Clear any URL cross-highlight and fall back to the current filter state.
  export function clearHighlight() {
    highlightedSGBs = new Set();
    crossHighlightActive = false;
    rangeSource = null;
    applyFiltersNow();
  }

  // Filtering logic
  function leafMatchesFilters(leaf) {
    if (selectedPhyla.length > 0) {
      const ph = getPhylum(leaf);
      if (!selectedPhyla.includes(ph)) return false;
    }
    if (unknownFilter === 'unknown') {
      if (parseUSGB(leaf.data.metadata) !== 'Yes') return false;
    } else if (unknownFilter === 'known') {
      if (parseUSGB(leaf.data.metadata) !== 'No') return false;
    }
    if (westernFilter === 'western') {
      if (parseWestern(leaf.data.metadata) !== 'western') return false;
    } else if (westernFilter === 'nonwestern') {
      if (parseWestern(leaf.data.metadata) !== 'nonwestern') return false;
    }
    if (abundanceFilter === 'abundant') {
      if (Number(leaf.data.metadata?.Sample_ID_Count) < ABUNDANT_MIN_SAMPLES) return false;
    } else if (abundanceFilter === 'rare') {
      if (Number(leaf.data.metadata?.Sample_ID_Count) > RARE_MAX_SAMPLES) return false;
    }
    if (geoFilter === 'widespread') {
      if (Number(leaf.data.metadata?.Country_Count) < WIDESPREAD_MIN_COUNTRIES) return false;
    } else if (geoFilter === 'concentrated') {
      if (Number(leaf.data.metadata?.Country_Count) > CONCENTRATED_MAX_COUNTRIES) return false;
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
    // Country filter (primary_countries.json SGB set per ISO3)
    if (countryIso3) {
      const sgbIdRaw = leaf?.data?.metadata?.SGB_ID;
      const sgbId = sgbIdRaw == null ? null : Number(sgbIdRaw);
      const allowed = countrySgbMap[countryIso3] || null;
      if (allowed && (sgbId == null || !allowed.has(sgbId))) return false;
    }
    return true;
  }

  function computeKeepSet(root) {
    const anyActive =
      selectedPhyla.length > 0 ||
      unknownFilter !== 'all' ||
      westernFilter !== 'any' ||
      abundanceFilter !== 'any' ||
      geoFilter !== 'any' ||
      bodySiteFilter.size > 0 ||
      !!proxyKey ||
      !!studyKey ||
      !!countryIso3;
    if (!anyActive) return null;

    const leaves = cachedLeaves || root.leaves();
    const matchedLeaves = leaves.filter(leafMatchesFilters);
    const keep = new Set();
    matchedLeaves.forEach(l => {
      l.ancestors().forEach(a => keep.add(a));
      keep.add(l);
    });
    return keep;
  }

  let filterRaf = null;

  // Recompute keep-set → repartition canvas batches (kept vs dimmed) → dim overlay labels.
  function applyFiltersNow() {
    try {
      const { root, selections } = handles;
      if (!root || !fullBatches) return;

      const keep = computeKeepSet(root);
      applyKeepSet(keep, selections);
      // Selection is now restricted to the filter — re-snap the center leaf so a
      // previously-selected (now excluded) leaf doesn't stay highlighted.
      updateSelectionFromAngle();
      commitSelectionToPanel();
      requestDraw();
    } catch (err) {
      console.error('Failed to apply filters', err);
    }
  }

  // Shared by filters and URL cross-highlight: set the keep-set, partition batches, dim labels.
  function applyKeepSet(keep, selections = handles.selections) {
    keepSet = keep;
    if (keep === null) {
      // No filter: every leaf is selectable again.
      selectableByAngle = leavesByAngle;
      keepBatches = null; dimBatches = null;
      if (selections?.internals) selections.internals.attr('opacity', null);
      if (selections?.labels) selections.labels.attr('opacity', null);
      return;
    }
    // Restrict center selection (rotation snapping) to leaves in the filter.
    selectableByAngle = leavesByAngle.filter(l => keep.has(l));
    const leaves = cachedLeaves || handles.root.leaves();
    keepBatches = buildBatches(leaves.filter(l => keep.has(l)));
    dimBatches = buildBatches(leaves.filter(l => !keep.has(l)));
    if (selections?.internals) selections.internals.attr('opacity', d => keep.has(d) ? 1 : DIM_LABEL_OPACITY);
    if (selections?.labels) selections.labels.attr('opacity', d => keep.has(d) ? 1 : DIM_LABEL_OPACITY);
  }

  function scheduleFilters() {
    if (filterRaf) return;
    const cb = () => {
      filterRaf = null;
      applyFiltersNow();
    };
    filterRaf = requestAnimationFrame(cb);
  }

  // Handle tooltip actions
  export function handleTooltipAction(event) {
    // Match both the old <button> actions and the new inline <a class="detail-link">.
    const btn = event.target.closest('[data-act]');
    if (!btn) return;

    const act = btn.getAttribute('data-act');
    if (act === 'highlight-countries') {
      const sgbId = parseInt(btn.getAttribute('data-sgb'), 10);
      if (sgbId) {
        const base = import.meta.env.BASE_URL;
        window.location.href = `${base}loading.html?side=anthromes&highlightSGB=${sgbId}`;
      }
    }
  }


  // Handle window click (clear URL cross-highlight when tapping away from the disk/rail)
  function handleWindowClick(event) {
    const target = event.target;
    // Ignore clicks on the disk itself — center-select owns the details panel now.
    if (target.closest('.viz-area') || target.closest('#info-panel') || target.closest('.zoom-controls') || target.closest('.rail') || target.closest('.control-circles') || target.closest('.detail-modal') || target.closest('.info-modal')) return;

    // Only clear an active URL cross-highlight; the center-select panel stays.
    if (crossHighlightActive) {
      crossHighlightActive = false;
      rangeSource = null;
      const url = new URL(window.location.href);
      url.searchParams.delete('highlightSGBs');
      url.searchParams.delete('highlightSGB');
      window.history.replaceState({}, '', url);
      sessionStorage.removeItem('highlightSGBs');
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
    abundanceFilter;
    geoFilter;
    bodySiteFilter.size;
    proxyKey;
    studyKey;
    countryIso3;

    scheduleFilters();
  });

  // Lazy-load study SGB map only when a study filter is requested
  $effect(() => {
    if (!studyKey || studyLoaded) return;
    fetch(`${import.meta.env.BASE_URL}data/study_index.json`)
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

  // Lazy-load per-country SGB map from primary_countries.json when a country is
  // first selected. Falls back gracefully if the file isn't deployed yet.
  $effect(() => {
    if (!countryIso3 || countryLoaded) return;
    fetch(`${import.meta.env.BASE_URL}data/primary_countries.json`)
      .then(res => res.ok ? res.json() : null)
      .then(json => {
        if (json) {
          Object.entries(json).forEach(([iso, val]) => {
            countrySgbMap[iso] = new Set((val?.sgbs || []).map(Number));
          });
          countryLoaded = true;
          applyFiltersNow();
        }
      })
      .catch(() => {});
  });

  onMount(() => {
    // Lazy-load proxy SGB map from public JSON
    fetch(`${import.meta.env.BASE_URL}data/proxy_samples.json`)
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

    // Load ISO3 → country name lookup
    const base = import.meta.env.BASE_URL;
    fetch(`${base}data/iso3_names.json`)
      .then(res => res.ok ? res.json() : null)
      .then(json => {
        if (!json) return;
        iso3ToName = new Map(Object.entries(json));
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
      crossHighlightActive = true;

      // Wait for taxonomy tree to load using polling
      const checkTreeInterval = setInterval(() => {
        if (taxonomyTree && handles.root) {
          clearInterval(checkTreeInterval);

          // Parse comma-separated SGB IDs (or single SGB ID).
          // If sentinel 'session', read the full list from sessionStorage
          // to avoid URI Too Long errors for large countries.
          const resolvedSGBsParam = highlightSGBsParam === 'session'
            ? (sessionStorage.getItem('highlightSGBs') || '')
            : highlightSGBsParam;
          const sgbIds = resolvedSGBsParam
            ? resolvedSGBsParam.split(',').map(id => parseInt(id.trim(), 10))
            : [parseInt(highlightSGBParam, 10)];

          // Find ALL matching leaves
          const leaves = handles.root.leaves();
          const matchedLeaves = leaves.filter(leaf => {
            const sgbId = leaf?.data?.metadata?.SGB_ID;
            return sgbId && sgbIds.includes(sgbId);
          });

          if (matchedLeaves.length > 0) {
            // Keep matched leaves + ancestors visible; dim the rest (canvas + overlay).
            const keep = new Set();
            matchedLeaves.forEach(leaf => {
              keep.add(leaf);
              leaf.ancestors().forEach(a => keep.add(a));
            });
            applyKeepSet(keep);
            requestDraw();
            // Publish a dismissible tag payload up to App. `session` means
            // the arrival came from an anthromes cell tooltip (many SGBs);
            // a single numeric param means a specific SGB was pushed over.
            rangeSource = highlightSGBsParam === 'session'
              ? {
                  kind: 'cell',
                  label: matchedLeaves.length === 1
                    ? 'Cell selection'
                    : `Cell selection · ${matchedLeaves.length} species`,
                  count: matchedLeaves.length,
                  from: 'Anthromes'
                }
              : {
                  kind: 'species',
                  label: `SGB ${sgbIds[0]}`,
                  sgbId: sgbIds[0],
                  count: matchedLeaves.length,
                  from: 'Anthromes'
                };
          }
        }
      }, 100);

      // Safety timeout
      setTimeout(() => clearInterval(checkTreeInterval), 10000);
    }

    // Keep the canvas backing store matched to the viz-area size
    let ro = null;
    if (vizAreaEl && typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(() => { resizeCanvas(); requestDraw(); });
      ro.observe(vizAreaEl);
    }

    // Re-emit the marker position once the initial layout has fully settled
    // (fonts/labels/rail content load after first draw), so App's leader starts correct.
    requestAnimationFrame(() => {
      lastMarkerX = -1; lastMarkerY = -1;
      requestDraw();
    });

    // Add event listeners
    window.addEventListener('click', handleWindowClick);
    window.addEventListener('keydown', handleEscape);
    emitZoomChange();

    return () => {
      window.removeEventListener('click', handleWindowClick);
      window.removeEventListener('keydown', handleEscape);
      window.removeEventListener('pointermove', onSpinPointerMove);
      if (ro) ro.disconnect();
      if (rafId) cancelAnimationFrame(rafId);
      cancelFinish();
    };
  });
</script>

<div class="chart-container">
  <div
    class="viz-area"
    bind:this={vizAreaEl}
    onpointerdown={onSpinPointerDown}
  >
    <!-- Dense marks (canvas, roulette-spinnable). Sparse labels/axis are the SVG overlay on top. -->
    <canvas bind:this={canvasEl} class="disk-canvas"></canvas>
    <svg bind:this={svgElement} id="chart" aria-label="Radial phylogenetic tree visualization" role="img">
    </svg>
  </div>

  <!-- Info panel is emitted to parent rail overlay via detail events -->

  <!-- Filters handled via circular menu in App; inline stack hidden -->
</div>

<style>
  .chart-container {
    width: 100%;
    height: 100%;
    position: relative;
  }

  .viz-area {
    position: relative;
    width: 100%;
    height: 100%;
    overflow: visible;
    background: var(--bg);
    z-index: 1;
    padding: 0 10px;
    box-sizing: border-box;
    touch-action: none; /* let drag-to-spin own the gesture */
  }

  /* Canvas holds the ~30k dense marks; SVG overlay (labels/axis) sits on top. */
  .disk-canvas {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    z-index: 1;
    display: block;
  }

  svg {
    position: absolute;
    inset: 0;
    display: block;
    background: transparent;
    width: 100%;
    height: 100%;
    max-height: 100%;
    object-fit: contain;
    margin: 0 auto;
    z-index: 2;
    pointer-events: none; /* overlay is non-interactive; canvas/viz-area own pointers */
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

  /* Touch build: no hover cursor, no hover-only states — selection is by tap */
  :global(.hover-target) {
    cursor: pointer;
  }

  :global(.is-selected.link) {
    stroke-opacity: 1;
    stroke-width: 2;
  }

  :global(.is-selected.sgb-line) {
    stroke-width: 2;
    opacity: 1;
  }

  :global(.node.is-selected circle) {
    r: 5;
    stroke-width: 1;
  }

  :global(.bar.is-selected),
  :global(.usgb.is-selected),
  :global(.western.is-selected) {
    filter: drop-shadow(0 0 10px rgba(255, 255, 255, 0.9));
  }

  /* Detail-panel content styles (createTooltipHTML output, rendered in App .panel-content) */
:global(.biomes-tooltip .tip-header) {
  display: flex;
  align-items: flex-start;
  justify-content: flex-start;
  gap: 10.2px;
  margin-bottom: 10.2px;
}

:global(.biomes-tooltip .h-left) {
  display: flex;
  gap: 10.2px;
  align-items: center;
}

:global(.biomes-tooltip .swatch) {
  width: 15.4px;
  height: 15.4px;
    border-radius: 50%;
    border: 1.3px solid rgba(255, 255, 255, 0.45);
    margin-top: 5.1px;
  }

:global(.biomes-tooltip .title) {
  font-size: 20.5px;
  font-weight: 700;
  letter-spacing: 0.02em;
}

:global(.biomes-tooltip .title-row) {
  display: inline-flex;
  align-items: center;
  gap: 7.7px;
  min-width: 0;
}

:global(.biomes-tooltip .subtitle) {
  font-size: 15.4px;
  color: var(--muted);
  margin-top: 2.6px;
}

:global(.biomes-tooltip .title-block.two-col) {
  display: grid;
  grid-template-columns: 1fr auto;
  column-gap: 10.2px;
  row-gap: 2.6px;
  min-width: 0;
  align-items: center;
}

:global(.biomes-tooltip .title-block.two-col .title) {
  grid-column: 1 / -1;
  min-width: 0;
}

:global(.biomes-tooltip .title-block.two-col .subtitle) {
  grid-column: 1;
  grid-row: 2;
}

:global(.biomes-tooltip .title-block.two-col .lineage) {
  grid-column: 2;
  grid-row: 2;
  color: #aeb6d4;
  text-align: right;
  white-space: nowrap;
}

  :global(.biomes-tooltip .summary) {
    font-size: 16.6px;
    margin: 10.2px 0 7.7px;
  }

  :global(.biomes-tooltip .summary b) {
    font-weight: 700;
  }

  :global(.biomes-tooltip .kv) {
    display: grid;
    grid-template-columns: 1fr auto;
    gap: 7.7px 15.4px;
    margin-top: 7.7px;
    font-size: 15.4px;
    border-top: 1.3px dashed rgba(255, 255, 255, 0.12);
    padding-top: 10.2px;
  }

  :global(.biomes-tooltip .kv .k) {
    color: var(--muted);
  }

  :global(.biomes-tooltip .actions) {
    display: flex;
    justify-content: flex-end;
    gap: 10.2px;
    margin-top: 10.2px;
  }

  :global(.biomes-tooltip button) {
    pointer-events: auto;
    background: #1d1a33;
    border: 1.3px solid rgba(255, 255, 255, 0.12);
    color: var(--fg);
    border-radius: 10.2px;
    padding: 7.7px 10.2px;
    font-size: 15.4px;
    cursor: pointer;
  }

  :global(.biomes-tooltip .genome-meter) {
    display: flex;
    align-items: center;
    gap: 10.2px;
    margin-top: 7.7px;
  }

  :global(.biomes-tooltip .genome-meter .ticks) {
    display: flex;
    gap: 2.6px;
    align-items: flex-end;
    flex-wrap: nowrap;
  }

  :global(.biomes-tooltip .genome-meter .tick) {
    width: 7.7px;
    height: 15.4px;
    background: transparent;
    border: 1.3px solid rgba(255, 255, 255, 0.25);
    border-radius: 2.6px;
  }

  :global(.biomes-tooltip .genome-meter .tick.filled) {
    background: var(--tickColor, #fff);
    border-color: transparent;
  }

  :global(.biomes-tooltip .genome-meter .num) {
    font-size: 15.4px;
    color: var(--muted);
    white-space: nowrap;
  }

</style>
