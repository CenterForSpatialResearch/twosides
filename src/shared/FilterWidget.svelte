<script>
  // Props
  let {
    position = 'bottom-left', // 'bottom-left' or 'bottom-right'
    items = [], // Array of {id, label, color}
    selectedItems = $bindable([]),
    yearRange = null, // {min, max, value: [start, end], years: [...]}
    onSelectAll = () => {},
    onClear = () => {},
    compact = false
  } = $props();

  // Constants matching original implementation
  const COLLAPSED_R = 80; // radius
  const IDEAL_EXPANDED_R = 440; // radius
  const VIEW_MARGIN = 28;

  // State
  let expanded = $state(false);
  let expandedTimestamp = $state(0);

  // Calculate max radius based on viewport
  function maxRadiusForViewport() {
    const vw = Math.max(document.documentElement.clientWidth, window.innerWidth || 0);
    const vh = Math.max(document.documentElement.clientHeight, window.innerHeight || 0);
    return Math.floor(Math.min(vw, vh) / 2) - VIEW_MARGIN;
  }

  // Computed expanded size (diameter)
  let expandedSize = $derived.by(() => {
    const maxR = maxRadiusForViewport();
    const r = Math.min(IDEAL_EXPANDED_R, maxR);
    return r * 2; // diameter
  });

  // Update timestamp when expanded changes
  $effect(() => {
    if (expanded) {
      expandedTimestamp = Date.now();
    }
  });

  // Positioning based on prop
  const positionStyles = $derived(() => {
    if (position === 'bottom-right') {
      return 'right: 24px; bottom: 24px;';
    }
    return 'left: 24px; bottom: 24px;';
  });

  // Toggle item selection
  function toggleItem(id) {
    const idx = selectedItems.indexOf(id);
    if (idx >= 0) {
      selectedItems = selectedItems.filter(i => i !== id);
    } else {
      selectedItems = [...selectedItems, id];
    }
  }

  // Handle keyboard shortcuts
  function handleKeydown(e) {
    if (e.key === 'Escape' && expanded) {
      expanded = false;
    }
  }

  // Click outside to collapse
  function handleClickOutside(e) {
    const widget = e.target.closest('#filterCircle');
    // Don't collapse if expanded within last 100ms (prevents immediate collapse on expand-click)
    if (!widget && expanded && Date.now() - expandedTimestamp > 100) {
      expanded = false;
    }
  }
</script>

<svelte:window
  onkeydown={handleKeydown}
  onclick={handleClickOutside}
/>

<div
  id="filterCircle"
  class:expanded
  class:compact
  style="{positionStyles()}; {expanded ? `width: ${expandedSize}px; height: ${expandedSize}px;` : ''}"
>
  <!-- Ring SVG decoration -->
  <svg id="ringSvg" viewBox="0 0 200 200">
    <circle class="filter-ring" cx="100" cy="100" r="96" />
    {#if !expanded}
      <text class="filter-caption" x="100" y="100" text-anchor="middle">
        FILTER
      </text>
    {/if}
  </svg>

  <div class="content">
    <!-- Collapsed State -->
    {#if !expanded}
      <div class="fc-collapsed">
        <span class="label">Filter</span>
        <button
          class="chev"
          onclick={() => expanded = true}
          aria-label="Expand filter"
        >
          ▼
        </button>
      </div>
    {/if}

    <!-- Expanded State -->
    {#if expanded}
      <div class="fc-expanded">
        <div class="sections">
          <!-- Header -->
          <div class="fc-head">
            <span class="fc-title">Filters</span>
            <div class="actions">
              <button class="btn" onclick={onSelectAll}>All</button>
              <button class="btn" onclick={onClear}>Clear</button>
              <button class="chevron" onclick={() => expanded = false} aria-label="Collapse">
                ▲
              </button>
            </div>
          </div>

          <!-- Legend/Picker Grid -->
          {#if items.length > 0}
            <div class="section">
              <h3>Categories</h3>
              <div class="legend-grid" id="legendGrid">
                {#each items as item (item.id)}
                  <button
                    class="legend-item"
                    class:selected={selectedItems.includes(item.id)}
                    onclick={() => toggleItem(item.id)}
                  >
                    <span class="sw" style="background: {item.color};"></span>
                    <span class="lbl">{item.label}</span>
                  </button>
                {/each}
              </div>
            </div>
          {/if}

          <!-- Year Range Slider (if provided) -->
          {#if yearRange}
            <div class="section">
              <h3>Year Range</h3>
              <div class="year-range">
                <div class="yr-track">
                  <div
                    class="yr-fill"
                    style="left: {((yearRange.value[0] - yearRange.min) / (yearRange.max - yearRange.min)) * 100}%;
                           width: {((yearRange.value[1] - yearRange.value[0]) / (yearRange.max - yearRange.min)) * 100}%;"
                  ></div>
                </div>
                <input
                  type="range"
                  class="yr-input"
                  min={yearRange.min}
                  max={yearRange.max}
                  bind:value={yearRange.value[0]}
                  aria-label="Start year"
                />
                <input
                  type="range"
                  class="yr-input"
                  min={yearRange.min}
                  max={yearRange.max}
                  bind:value={yearRange.value[1]}
                  aria-label="End year"
                />
                <div class="yr-pills">
                  <span class="pill">{yearRange.value[0]}</span>
                  <span class="pill">{yearRange.value[1]}</span>
                </div>
              </div>
            </div>
          {/if}
        </div>
      </div>
    {/if}
  </div>
</div>

<style>
  #filterCircle {
    position: fixed;
    width: 160px;
    height: 160px;
    z-index: 999;
    transition: width 0.28s ease, height 0.28s ease, transform 0.28s ease, box-shadow 0.2s ease;
    transform-origin: bottom left;
    pointer-events: auto;
  }

  #ringSvg {
    position: absolute;
    inset: 0;
    overflow: visible;
    pointer-events: none;
    z-index: 2;
  }

  .filter-ring {
    fill: none;
    stroke: #fff;
    stroke-width: 3px;
  }

  .filter-caption {
    fill: #cfd3e0;
    font-size: 11px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    dominant-baseline: middle;
  }

  .content {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 50%;
    background: transparent;
    box-shadow: 0 10px 30px rgba(0, 0, 0, 0.35);
    padding: 18px;
    z-index: 1;
  }

  #filterCircle.expanded .content {
    background: var(--panel);
  }

  /* Collapsed */
  .fc-collapsed {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .fc-collapsed .label {
    font-size: 12px;
    font-weight: 800;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--muted);
  }

  .fc-collapsed .chev,
  .chevron {
    border: 1px solid rgba(255, 255, 255, 0.18);
    background: rgba(255, 255, 255, 0.06);
    color: var(--fg);
    width: 34px;
    height: 28px;
    border-radius: 10px;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .fc-collapsed .chev:hover,
  .chevron:hover {
    background: rgba(255, 255, 255, 0.12);
  }

  /* Expanded */
  .fc-expanded {
    display: none;
    width: 100%;
    height: 100%;
  }

  #filterCircle.expanded .fc-expanded {
    display: flex;
  }

  #filterCircle.expanded .fc-collapsed {
    display: none;
  }

  .sections {
    margin: auto;
    width: 86%;
    height: 86%;
    display: flex;
    flex-direction: column;
    gap: 10px;
    align-items: center;
    justify-content: center;
    text-align: center;
    overflow-y: auto;
  }

  .fc-head {
    width: 100%;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }

  .fc-title {
    font-size: 10px;
    color: var(--muted);
    letter-spacing: 0.14em;
    text-transform: uppercase;
  }

  .actions {
    display: flex;
    gap: 8px;
  }

  .btn {
    font-size: 10px;
    font-weight: 800;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    cursor: pointer;
    padding: 6px 9px;
    border-radius: 10px;
    border: 1px solid rgba(255, 255, 255, 0.18);
    background: rgba(255, 255, 255, 0.06);
    color: var(--fg);
  }

  .btn:hover {
    background: rgba(255, 255, 255, 0.12);
  }

  .section {
    width: 100%;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 6px;
  }

  .section h3 {
    margin: 0;
    font-size: 10px;
    color: var(--muted);
    letter-spacing: 0.14em;
    text-transform: uppercase;
  }

  /* Legend Grid */
  .legend-grid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 6px 10px;
    width: 100%;
    user-select: none;
  }

  .legend-item {
    display: flex;
    align-items: center;
    gap: 6px;
    justify-content: flex-start;
    padding: 5px 7px;
    border-radius: 10px;
    background: rgba(255, 255, 255, 0.04);
    border: 1px solid rgba(255, 255, 255, 0.12);
    cursor: pointer;
    transition: transform 0.08s ease, background 0.15s ease, border-color 0.15s ease, opacity 0.15s ease;
    opacity: 0.55;
  }

  .legend-item:hover {
    transform: translateY(-1px);
    opacity: 0.95;
  }

  .legend-item.selected {
    opacity: 1;
    background: rgba(255, 255, 255, 0.09);
    border-color: rgba(255, 255, 255, 0.35);
    box-shadow: 0 0 0 2px rgba(255, 255, 255, 0.08) inset;
  }

  .legend-item .sw {
    width: 12px;
    height: 12px;
    border-radius: 4px;
    border: 1px solid rgba(255, 255, 255, 0.25);
    flex: 0 0 auto;
  }

  .legend-item .lbl {
    font-size: 11px;
    line-height: 1.2;
    text-align: left;
  }

  /* Year Range Slider */
  .year-range {
    width: 100%;
    position: relative;
    padding-top: 10px;
  }

  .yr-track {
    position: relative;
    height: 8px;
    border-radius: 6px;
    background: linear-gradient(90deg, rgba(255, 255, 255, 0.15), rgba(255, 255, 255, 0.15));
    overflow: hidden;
    margin: 4px 0 10px;
  }

  .yr-fill {
    position: absolute;
    top: 0;
    height: 100%;
    border-radius: 6px;
    background: linear-gradient(90deg, rgba(255, 255, 255, 0.6), rgba(255, 255, 255, 0.9));
  }

  .yr-input {
    position: absolute;
    left: 0;
    right: 0;
    top: -6px;
    height: 20px;
    pointer-events: none;
    -webkit-appearance: none;
    background: none;
    margin: 0;
  }

  .yr-input::-webkit-slider-thumb {
    -webkit-appearance: none;
    appearance: none;
    pointer-events: auto;
    width: 16px;
    height: 16px;
    border-radius: 50%;
    background: #fff;
    border: 2px solid #0e0b16;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.35);
    cursor: pointer;
  }

  .yr-input::-moz-range-thumb {
    pointer-events: auto;
    width: 16px;
    height: 16px;
    border-radius: 50%;
    background: #fff;
    border: 2px solid #0e0b16;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.35);
    cursor: pointer;
  }

  .yr-input::-webkit-slider-runnable-track {
    height: 8px;
    background: transparent;
  }

  .yr-input::-moz-range-track {
    height: 8px;
    background: transparent;
  }

  .yr-pills {
    display: flex;
    justify-content: space-between;
    font-size: 10px;
    color: var(--muted);
    margin-top: 2px;
  }

  .pill {
    padding: 3px 6px;
    border-radius: 8px;
    border: 1px solid rgba(255, 255, 255, 0.18);
    background: rgba(255, 255, 255, 0.06);
    color: var(--fg);
  }

  /* Compact mode */
  #filterCircle.compact .sections {
    width: 84%;
    height: 84%;
    gap: 8px;
  }

  #filterCircle.compact .section h3 {
    font-size: 9px;
    letter-spacing: 0.16em;
  }

  #filterCircle.compact .btn {
    font-size: 9px;
    padding: 5px 8px;
  }

  #filterCircle.compact .legend-item .lbl {
    font-size: 10px;
  }
</style>
