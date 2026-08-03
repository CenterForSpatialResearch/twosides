<script>
  // Horizontal replacement for CountryTimeseriesChart's radial layout.
  // For a single country, plot its anthrome-class composition across time as
  // a horizontal stacked-column chart: each year is a vertical column filled
  // bottom-up by anthrome share (Wildlands at the base → Dense Settlements
  // at the top, following the paper's intensity gradient).
  //
  // Shares its time axis with CellHistoryBar so cell and country callouts
  // read as the same species of chart.
  //
  // Props:
  //   data          — { cell_totals: { year: N }, distribution: { year: {code: frac} } }
  //   colorMapping  — anthrome code → hex color
  //   labelMapping  — anthrome code → display label
  //   orderedCodes  — canonical stack order (intensive → wild)
  //   selectedYear  — data-format year string ("2000AD") for the marker
  //   width, height — layout box (design px)

  let {
    data,
    colorMapping = {},
    labelMapping = {},
    orderedCodes = [],
    selectedYear = null,
    width = 340,
    height = 160
  } = $props();

  const PAD_L = 4;
  const PAD_R = 4;
  const TRACK_TOP = 18;      // room for era labels above? no — labels below
  const TRACK_H = 108;
  const AXIS_Y = TRACK_TOP + TRACK_H + 4;

  const yearOrder = $derived(orderChronologically(Object.keys(data?.distribution ?? {})));

  function orderChronologically(keys) {
    return keys
      .map((k) => ({ k, v: yearValue(k) }))
      .filter((r) => Number.isFinite(r.v))
      .sort((a, b) => a.v - b.v)
      .map((r) => r.k);
  }

  function yearValue(label) {
    if (!label) return NaN;
    if (label.endsWith('BC')) return -parseInt(label, 10);
    if (label.endsWith('AD')) return parseInt(label, 10);
    return NaN;
  }

  const timeRange = $derived.by(() => {
    if (!yearOrder.length) return { minYear: -10000, maxYear: 2025 };
    return {
      minYear: yearValue(yearOrder[0]),
      maxYear: yearValue(yearOrder[yearOrder.length - 1])
    };
  });

  function xForYear(y) {
    const { minYear, maxYear } = timeRange;
    const span = Math.max(1, maxYear - minYear);
    const px = (y - minYear) / span;
    return PAD_L + px * (width - PAD_L - PAD_R);
  }

  const columns = $derived.by(() => {
    if (!yearOrder.length || !orderedCodes.length) return [];
    const out = [];
    for (let i = 0; i < yearOrder.length; i++) {
      const y = yearOrder[i];
      const yv = yearValue(y);
      const nextV = i < yearOrder.length - 1 ? yearValue(yearOrder[i + 1]) : yv;
      const prevV = i > 0 ? yearValue(yearOrder[i - 1]) : yv;
      // Column spans halfway to neighbors on each side.
      const x0 = xForYear(yv - (yv - prevV) / 2);
      const x1 = xForYear(yv + (nextV - yv) / 2);
      const w = Math.max(0.5, x1 - x0);

      const dist = data.distribution[y] || {};
      // Bottom-up stack in intensity-gradient order: Wildlands (largest code)
      // at the bottom, Dense Settlements (smallest code) at the top.
      const reversed = [...orderedCodes].reverse();
      const stack = [];
      let cum = 0;
      for (const code of reversed) {
        const frac = dist[String(code)] || 0;
        if (frac <= 0) continue;
        const bottom = TRACK_TOP + TRACK_H - cum * TRACK_H;
        const h = frac * TRACK_H;
        stack.push({
          code,
          color: colorMapping[code] || '#666',
          y: bottom - h,
          h,
          frac
        });
        cum += frac;
      }
      out.push({ year: y, yv, x: x0, w, stack });
    }
    return out;
  });

  const markerX = $derived.by(() => {
    const y = yearValue(selectedYear);
    if (!Number.isFinite(y)) return null;
    return xForYear(y);
  });

  function formatEra(y) {
    if (y == null) return '';
    if (y < 0) return `${Math.abs(y).toLocaleString()} BC`;
    if (y === 0) return '0';
    return `${y.toLocaleString()}`;
  }

  const eraTicks = $derived.by(() => {
    const { minYear, maxYear } = timeRange;
    const set = new Set([minYear, maxYear]);
    if (minYear < 0 && maxYear > 0) set.add(0);
    if (maxYear - minYear >= 1000) {
      set.add(Math.round((minYear + 0) / 2));
      set.add(Math.round((maxYear + 0) / 2));
    }
    return Array.from(set)
      .filter((y) => y >= minYear && y <= maxYear)
      .sort((a, b) => a - b)
      .map((y) => ({ y, x: xForYear(y), label: formatEra(y) }));
  });

  // Family annotations: right-edge callouts for the anthrome families that
  // appear in the country's most-recent year. Grouped by family (Dense
  // Settlements, Villages, Croplands, Rangelands, Cultured, Wildlands) so
  // the chart reads as "which anthromes has this country grown into."
  const FAMILY_ORDER = [
    { name: 'Dense Settlements', codes: [11, 12] },
    { name: 'Villages', codes: [21, 22, 23, 24] },
    { name: 'Croplands', codes: [31, 32, 33, 34] },
    { name: 'Rangelands', codes: [41, 42, 43] },
    { name: 'Cultured', codes: [51, 52, 53, 54] },
    { name: 'Wildlands', codes: [61, 62, 63] }
  ];

  const familyAnnotations = $derived.by(() => {
    if (!yearOrder.length) return [];
    const lastYear = yearOrder[yearOrder.length - 1];
    const dist = data?.distribution?.[lastYear] || {};
    // Family share = sum of member codes at the last year.
    const shares = FAMILY_ORDER.map((fam) => {
      const share = fam.codes.reduce((s, c) => s + (dist[String(c)] || 0), 0);
      return { name: fam.name, share };
    });
    // Return only families that have any presence, ordered by their center-
    // of-mass y in the stack (top-to-bottom on screen).
    let cum = 0;
    const positioned = [];
    // Walk reversed so we compute y from the bottom just like the columns.
    const reversed = [...FAMILY_ORDER].reverse();
    for (const fam of reversed) {
      const share = fam.codes.reduce((s, c) => s + (dist[String(c)] || 0), 0);
      if (share > 0.005) {
        const centerFrac = cum + share / 2;
        const y = TRACK_TOP + TRACK_H - centerFrac * TRACK_H;
        positioned.push({ name: fam.name, share, y });
      }
      cum += share;
    }
    return positioned;
  });
</script>

<svg
  class="country-timeseries-bar"
  viewBox={`0 0 ${width} ${height}`}
  preserveAspectRatio="none"
  aria-label="Country anthrome composition over time"
>
  <!-- Background track -->
  <rect
    x={PAD_L}
    y={TRACK_TOP}
    width={width - PAD_L - PAD_R}
    height={TRACK_H}
    class="track-bg"
  />

  <!-- Stacked columns, one per year -->
  {#each columns as col (col.year)}
    {#each col.stack as seg (col.year + '-' + seg.code)}
      <rect
        x={col.x}
        y={seg.y}
        width={col.w + 0.5}
        height={seg.h}
        fill={seg.color}
      >
        <title>{formatEra(col.yv)} · {labelMapping[seg.code] || seg.code} · {Math.round(seg.frac * 100)}%</title>
      </rect>
    {/each}
  {/each}

  <!-- Right-edge family annotations (only families present in the most recent year) -->
  {#each familyAnnotations as f (f.name)}
    <text
      x={width - PAD_R + 2}
      y={f.y}
      class="family-label"
      text-anchor="start"
      dominant-baseline="middle"
    >{f.name}</text>
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
      y1={TRACK_TOP - 6}
      y2={AXIS_Y + 6}
      class="year-marker"
    />
    <text
      x={markerX}
      y={TRACK_TOP - 10}
      class="year-marker-label"
      text-anchor={
        markerX < PAD_L + 30
          ? 'start'
          : markerX > width - PAD_R - 30
          ? 'end'
          : 'middle'
      }
    >{formatEra(yearValue(selectedYear))}</text>
  {/if}
</svg>

<style>
  .country-timeseries-bar {
    display: block;
    width: 100%;
    height: auto;
    overflow: visible;
  }

  .track-bg {
    fill: rgba(255, 255, 255, 0.06);
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

  .family-label {
    font-size: 9px;
    font-weight: 700;
    letter-spacing: 0.02em;
    fill: rgba(255, 255, 255, 0.75);
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
