/**
 * Anthrome Change Year Test Page - Rendering Engine
 *
 * Displays circular close-up views of anthrome data with change year overlays.
 * Supports multiple layouts, zoom levels, and sorting options.
 */

// Import zoom profile from constants
import { ZOOM_PROFILE } from './constants.js';

// ============================================================================
// Constants
// ============================================================================

// Using direct anthrome codes for shift calculation
// Higher code = less intensive (63 = ice, 11 = urban)
// Shift = startAnthrome - endAnthrome
// Positive shift = intensification (e.g., 63→11)
// Negative shift = cultured/less intensive (e.g., 11→63)

// ============================================================================
// State
// ============================================================================

let state = {
  sortBy: 'intensive-1900',
  zoomLevel: 12,
  columns: 6,
  changeYearDisplay: 'hover'
};

let layout = null;

// Data cache
const dataCache = {
  topojson: new Map(),
  changeYears: null,
  legend: null,
  selectedZooms: null
};

// ============================================================================
// Utility Functions
// ============================================================================

function debounce(fn, delay) {
  let timeout;
  return function(...args) {
    clearTimeout(timeout);
    timeout = setTimeout(() => fn.apply(this, args), delay);
  };
}

function formatChangeYear(yearStr) {
  if (!yearStr || yearStr === 'Unknown') return 'N/A';
  if (yearStr.includes('BC')) {
    const year = parseInt(yearStr.replace('BC', ''));
    return year >= 1000 ? `${year/1000}kBC` : `${year}BC`;
  }
  return yearStr.replace('AD', '');
}

function showLoading(text = 'Loading...') {
  const overlay = document.getElementById('loadingOverlay');
  const textEl = document.getElementById('loadingText');
  textEl.textContent = text;
  overlay.classList.add('active');
}

function hideLoading() {
  const overlay = document.getElementById('loadingOverlay');
  overlay.classList.remove('active');
}

async function fetchCached(url, cacheMap, key) {
  if (cacheMap && cacheMap.has(key)) {
    return cacheMap.get(key);
  }
  const data = await d3.json(url);
  if (cacheMap) {
    cacheMap.set(key, data);
  }
  return data;
}

// ============================================================================
// Grid Layout Calculation
// ============================================================================

function calculateGridLayout(columns) {
  const vh = window.innerHeight;
  const vw = window.innerWidth;
  const controlsHeight = 80;
  const padding = 20;
  const gap = 20;
  const infoHeight = 60;

  const availableHeight = vh - controlsHeight - (padding * 2);
  const availableWidth = vw - (padding * 2);

  // Calculate circle diameter based on columns
  const circleDiameter = (availableWidth - (gap * (columns - 1))) / columns;

  // Calculate how many complete rows fit
  const rowHeight = circleDiameter + infoHeight + gap;
  const completeRowsFit = Math.floor(availableHeight / rowHeight);

  const rows = Math.max(1, completeRowsFit);
  const totalSites = columns * rows;

  return {
    columns,
    rows,
    totalSites,
    circleDiameter,
    circleRadius: circleDiameter / 2
  };
}

// ============================================================================
// Projection & Rendering
// ============================================================================

function getScaleFromZoom(zoomLevel, circleRadius) {
  // WGS84 zoom levels: higher = more zoomed in
  // Base scale calibrated for zoom 9
  const baseScale = circleRadius * 2.5;
  const zoomFactor = Math.pow(2, zoomLevel - 9);
  return baseScale * zoomFactor;
}

// ============================================================================
// Change Year Rendering
// ============================================================================

function renderChangeYears(ctx, path, features, changeYears, layout, mode) {
  if (mode !== 'direct') return;

  // Dynamic font size based on circle size (halved)
  const fontSize = Math.max(4, Math.min(6, layout.circleDiameter / 100));
  ctx.font = `${fontSize}px sans-serif`;
  ctx.fillStyle = '#fff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.strokeStyle = '#000';
  ctx.lineWidth = 3;

  features.forEach(feature => {
    const cellId = feature.properties.i;
    const changeYear = changeYears[cellId] || 'N/A';

    // Get centroid of feature
    const centroid = path.centroid(feature);
    if (!centroid || !isFinite(centroid[0]) || !isFinite(centroid[1])) return;

    // Only render if within circle bounds
    const dx = centroid[0] - layout.circleRadius;
    const dy = centroid[1] - layout.circleRadius;
    if (Math.sqrt(dx*dx + dy*dy) > layout.circleRadius) return;

    const displayYear = formatChangeYear(changeYear);

    // Stroke for readability
    ctx.strokeText(displayYear, centroid[0], centroid[1]);
    ctx.fillText(displayYear, centroid[0], centroid[1]);
  });
}

function setupHoverTooltip(canvas, features, changeYears, projection, layout) {
  let tooltip = document.querySelector('.change-year-tooltip');
  if (!tooltip) {
    tooltip = document.createElement('div');
    tooltip.className = 'change-year-tooltip';
    tooltip.style.display = 'none';
    document.body.appendChild(tooltip);
  }

  canvas.addEventListener('mousemove', (e) => {
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const x = (e.clientX - rect.left) / rect.width * layout.circleDiameter;
    const y = (e.clientY - rect.top) / rect.height * layout.circleDiameter;

    // Convert canvas coords to geo coords
    const lonlat = projection.invert([x, y]);
    if (!lonlat) {
      tooltip.style.display = 'none';
      return;
    }

    // Find feature at this location
    const feature = features.find(f => d3.geoContains(f, lonlat));

    if (feature) {
      const cellId = feature.properties.i;
      const changeYear = changeYears[cellId] || 'Unknown';
      const anthrome = feature.properties.a;
      const legend = dataCache.legend[anthrome];

      tooltip.innerHTML = `
        <div><strong>${legend?.label || 'Unknown'}</strong></div>
        <div>Changed: ${changeYear}</div>
      `;
      tooltip.style.display = 'block';
      tooltip.style.left = `${e.pageX + 10}px`;
      tooltip.style.top = `${e.pageY + 10}px`;
    } else {
      tooltip.style.display = 'none';
    }
  });

  canvas.addEventListener('mouseleave', () => {
    tooltip.style.display = 'none';
  });
}

// ============================================================================
// Individual Circle Renderer
// ============================================================================

async function renderZoomCircle(container, location, zoomLevel, layout, options) {
  // Setup canvas
  const canvas = document.createElement('canvas');
  const dpr = window.devicePixelRatio || 1;
  canvas.width = layout.circleDiameter * dpr;
  canvas.height = layout.circleDiameter * dpr;
  canvas.style.width = `${layout.circleDiameter}px`;
  canvas.style.height = `${layout.circleDiameter}px`;

  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);

  // Setup projection
  const projection = d3.geoAzimuthalEquidistant()
    .center([location.lon, location.lat])
    .scale(getScaleFromZoom(zoomLevel, layout.circleRadius))
    .translate([layout.circleRadius, layout.circleRadius]);

  const path = d3.geoPath(projection, ctx);

  // Load data
  const [topoData, changeYears, legend] = await Promise.all([
    fetchCached(`/topojson/${ZOOM_PROFILE}/2025AD.topojson`, dataCache.topojson, '2025AD'),
    dataCache.changeYears || fetchCached(`/data/anthrome-change-years-${ZOOM_PROFILE}.json`, null, null).then(data => {
      dataCache.changeYears = data;
      return data;
    }),
    dataCache.legend || fetchCached('/data/anthrome-legend.json', null, null).then(data => {
      dataCache.legend = data;
      return data;
    })
  ]);

  const features = topojson.feature(topoData, topoData.objects.anthromes).features;

  // Render anthromes
  features.forEach(feature => {
    const anthrome = feature.properties.a;
    const color = legend[anthrome]?.color || '#ccc';

    ctx.fillStyle = color;
    ctx.beginPath();
    path(feature);
    ctx.fill();
  });

  // Render change years if enabled
  if (options.showChangeYear) {
    renderChangeYears(ctx, path, features, changeYears, layout, options.displayMode);
  }

  // Apply circular mask
  ctx.globalCompositeOperation = 'destination-in';
  ctx.fillStyle = '#000';
  ctx.beginPath();
  ctx.arc(layout.circleRadius, layout.circleRadius, layout.circleRadius, 0, 2 * Math.PI);
  ctx.fill();
  ctx.globalCompositeOperation = 'source-over';

  // Add to container
  container.appendChild(canvas);

  // Setup hover tooltip if using hover display mode
  if (options.showChangeYear && options.displayMode === 'hover') {
    setupHoverTooltip(canvas, features, changeYears, projection, layout);
  }
}

// ============================================================================
// Sorting
// ============================================================================

async function sortLocations(mode, count, zoomLevel) {
  let locations = [];

  if (mode === 'selected') {
    // Load curated selected sites and sort alphabetically
    const selectedZooms = dataCache.selectedZooms || await fetchCached('/data/zooms-selected.json', null, null).then(data => {
      dataCache.selectedZooms = data;
      return data;
    });

    locations = selectedZooms
      .sort((a, b) => a.title.localeCompare(b.title))
      .slice(0, count);
  }
  else if (mode.startsWith('intensive') || mode.startsWith('cultured')) {
    // Load data-driven zoom candidates
    showLoading(`Loading ${mode} candidates...`);

    const isIntensive = mode.startsWith('intensive');
    const startYear = mode.endsWith('1900') ? '1900' : '2000';

    const filename = isIntensive
      ? `/data/zooms-intensive-since-${startYear}.json`
      : `/data/zooms-cultured-since-${startYear}.json`;

    const zoomCandidates = await fetchCached(filename, null, null);

    locations = zoomCandidates.slice(0, count);
  }

  return locations;
}

// ============================================================================
// Main Render Function
// ============================================================================

async function render() {
  try {
    showLoading('Rendering...');

    // Calculate layout
    layout = calculateGridLayout(state.columns);

    // Update CSS variables
    document.documentElement.style.setProperty('--columns', state.columns);

    // Get sorted locations
    const locations = await sortLocations(state.sortBy, layout.totalSites, state.zoomLevel);

    // Clear grid
    const grid = document.getElementById('zoomGrid');
    grid.innerHTML = '';

    // Render each zoom circle
    for (const location of locations) {
      const wrapper = document.createElement('div');
      wrapper.className = 'zoom-wrapper';

      const circle = document.createElement('div');
      circle.className = 'zoom-circle';

      const info = document.createElement('div');
      info.className = 'zoom-info';
      info.innerHTML = `
        <h3>${location.title}</h3>
        <p>${location.description}</p>
        ${location.shift !== undefined ? `<p class="shift">Shift: ${location.shift.toFixed(3)}</p>` : ''}
      `;

      wrapper.appendChild(circle);
      wrapper.appendChild(info);
      grid.appendChild(wrapper);

      // Render zoom view
      await renderZoomCircle(circle, location, state.zoomLevel, layout, {
        showChangeYear: true,
        displayMode: state.changeYearDisplay
      });
    }

    hideLoading();
  } catch (error) {
    console.error('Render error:', error);
    hideLoading();
    alert('Error rendering: ' + error.message);
  }
}

// ============================================================================
// Event Handlers
// ============================================================================

async function handleSortChange(e) {
  state.sortBy = e.target.value;
  await render();
}

async function handleZoomChange(e) {
  state.zoomLevel = parseInt(e.target.value);
  await render();
}

async function handleColumnsChange(e) {
  state.columns = parseInt(e.target.value);
  await render();
}

async function handleDisplayModeChange(e) {
  state.changeYearDisplay = e.target.value;
  await render();
}

async function handleResize() {
  await render();
}

// ============================================================================
// Initialization
// ============================================================================

async function init() {
  // Setup event listeners
  document.getElementById('sortBy').addEventListener('change', handleSortChange);
  document.getElementById('zoomLevel').addEventListener('change', handleZoomChange);
  document.getElementById('columns').addEventListener('change', handleColumnsChange);
  document.getElementById('changeYearDisplay').addEventListener('change', handleDisplayModeChange);

  window.addEventListener('resize', debounce(handleResize, 300));

  // Initial render
  await render();
}

// Start
init();
