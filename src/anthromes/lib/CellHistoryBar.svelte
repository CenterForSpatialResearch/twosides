<script>
  // Horizontal replacement for HistoryCircleChart. For a single cell, plot
  // its anthrome transitions across time as a linear timeline: oldest year
  // on the left, most recent on the right. Segments are colored by anthrome
  // class and span the years each period covers.
  //
  // Shares its time axis with CountryTimeseriesBar so the two callouts read
  // as the same species of chart.
  //
  // Props:
  //   periods       — output of MapCanvas.processHistoryData
  //   selectedYear  — data-format year string ("2000AD") for the marker
  //   width, height — layout box (design px)

  let {
    periods = [],
    selectedYear = null,
    width = 340,
    height = 90
  } = $props();

  const PAD_L = 4;
  const PAD_R = 4;
  const TRACK_TOP = 22;      // room for anthrome name labels above
  const TRACK_H = 42;         // colored segment height
  const AXIS_Y = TRACK_TOP + TRACK_H + 4;

  const timeRange = $derived.by(() => {
    if (!periods.length) return { minYear: -10000, maxYear: 2025 };
    return {
      minYear: periods[0].startYear,
      maxYear: periods[periods.length - 1].endYear
    };
  });

  function xForYear(y) {
    const { minYear, maxYear } = timeRange;
    const span = Math.max(1, maxYear - minYear);
    const px = (y - minYear) / span;
    return PAD_L + px * (width - PAD_L - PAD_R);
  }

  const segments = $derived.by(() => {
    if (!periods.length) return [];
    return periods.map((p, i) => {
      const x0 = xForYear(p.startYear);
      const x1 = xForYear(p.endYear);
      const w = Math.max(1, x1 - x0);
      return {
        i,
        x: x0,
        w,
        color: p.color,
        label: p.label,
        startYearLabel: p.startYearLabel,
        endYearLabel: p.endYearLabel,
        startYear: p.startYear,
        endYear: p.endYear
      };
    });
  });

  function yearToSigned(label) {
    if (!label) return null;
    if (label.endsWith('BC')) return -parseInt(label, 10);
    if (label.endsWith('AD')) return parseInt(label, 10);
    return null;
  }

  const markerX = $derived.by(() => {
    const y = yearToSigned(selectedYear);
    if (y == null) return null;
    return xForYear(y);
  });

  function formatEra(y) {
    if (y == null) return '';
    if (y < 0) return `${Math.abs(y).toLocaleString()} BC`;
    if (y === 0) return '0';
    return `${y.toLocaleString()}`;
  }

  // Sparse era ticks — always show min, 0 (if in range), and max.
  const eraTicks = $derived.by(() => {
    const { minYear, maxYear } = timeRange;
    const set = new Set([minYear, maxYear]);
    if (minYear < 0 && maxYear > 0) set.add(0);
    // Add one midpoint each side of 0 if the span is broad enough.
    if (maxYear - minYear >= 1000) {
      set.add(Math.round((minYear + 0) / 2));
      set.add(Math.round((maxYear + 0) / 2));
    }
    return Array.from(set)
      .filter((y) => y >= minYear && y <= maxYear)
      .sort((a, b) => a - b)
      .map((y) => ({ y, x: xForYear(y), label: formatEra(y) }));
  });

  // Anthrome names rendered on segments where there's room. Sqrt-based
  // threshold so narrow later slivers still get labeled if they're distinct.
  const LABEL_MIN_W = 34;
</script>

<svg
  class="cell-history-bar"
  viewBox={`0 0 ${width} ${height}`}
  preserveAspectRatio="none"
  aria-label="Cell history over time"
>
  <!-- Background track -->
  <rect
    x={PAD_L}
    y={TRACK_TOP}
    width={width - PAD_L - PAD_R}
    height={TRACK_H}
    class="track-bg"
  />

  <!-- Colored period segments -->
  {#each segments as s (s.i)}
    <rect
      x={s.x}
      y={TRACK_TOP}
      width={s.w}
      height={TRACK_H}
      fill={s.color}
      class="segment"
    >
      <title>{s.label} · {s.startYearLabel} → {s.endYearLabel}</title>
    </rect>
  {/each}

  <!-- Boundary tick marks between segments -->
  {#each segments as s, i (s.i)}
    {#if i > 0}
      <line
        x1={s.x}
        x2={s.x}
        y1={TRACK_TOP - 2}
        y2={TRACK_TOP + TRACK_H + 2}
        class="boundary"
      />
    {/if}
  {/each}

  <!-- Anthrome-name annotations above wide-enough segments -->
  {#each segments as s (s.i)}
    {#if s.w >= LABEL_MIN_W}
      <text
        x={s.x + s.w / 2}
        y={TRACK_TOP - 6}
        class="segment-label"
        text-anchor="middle"
      >{s.label}</text>
    {/if}
  {/each}

  <!-- Era baseline + ticks -->
  <line
    x1={PAD_L}
    x2={width - PAD_R}
    y1={AXIS_Y}
    y2={AXIS_Y}
    class="axis-line"
  />
  {#each eraTicks as t (t.y)}
    <line
      x1={t.x}
      x2={t.x}
      y1={AXIS_Y}
      y2={AXIS_Y + 4}
      class="axis-tick"
    />
    <text
      x={t.x}
      y={AXIS_Y + 15}
      class="axis-label"
      text-anchor={
        t.x < PAD_L + 20
          ? 'start'
          : t.x > width - PAD_R - 20
          ? 'end'
          : 'middle'
      }
    >{t.label}</text>
  {/each}

  <!-- Selected-year marker -->
  {#if markerX != null}
    <line
      x1={markerX}
      x2={markerX}
      y1={TRACK_TOP - 8}
      y2={AXIS_Y + 6}
      class="year-marker"
    />
    <text
      x={markerX}
      y={TRACK_TOP - 12}
      class="year-marker-label"
      text-anchor={
        markerX < PAD_L + 30
          ? 'start'
          : markerX > width - PAD_R - 30
          ? 'end'
          : 'middle'
      }
    >{formatEra(yearToSigned(selectedYear))}</text>
  {/if}
</svg>

<style>
  .cell-history-bar {
    display: block;
    width: 100%;
    height: auto;
    overflow: visible;
  }

  .track-bg {
    fill: rgba(255, 255, 255, 0.06);
  }

  .segment {
    stroke: rgba(0, 0, 0, 0.28);
    stroke-width: 0.6;
  }

  .boundary {
    stroke: rgba(0, 0, 0, 0.55);
    stroke-width: 0.9;
  }

  .segment-label {
    font-size: 9px;
    font-weight: 700;
    letter-spacing: 0.02em;
    fill: rgba(255, 255, 255, 0.82);
    pointer-events: none;
  }

  .axis-line {
    stroke: rgba(255, 255, 255, 0.24);
    stroke-width: 0.8;
  }

  .axis-tick {
    stroke: rgba(255, 255, 255, 0.55);
    stroke-width: 1;
  }

  .axis-label {
    font-size: 9px;
    font-weight: 700;
    letter-spacing: 0.04em;
    fill: rgba(255, 255, 255, 0.7);
    text-transform: uppercase;
    pointer-events: none;
  }

  .year-marker {
    stroke: #ffffff;
    stroke-width: 2;
    stroke-linecap: round;
    filter: drop-shadow(0 0 3px rgba(255, 255, 255, 0.55));
  }

  .year-marker-label {
    font-size: 10px;
    font-weight: 800;
    letter-spacing: 0.04em;
    fill: #ffffff;
    text-transform: uppercase;
  }
</style>
