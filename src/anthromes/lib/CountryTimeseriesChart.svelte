<script>
  // Country-scale companion to HistoryCircleChart. For a single country, plot
  // its anthrome-class composition across time as a radial stacked area:
  // each timestep is an angular slice; within a slice, class fractions stack
  // from the center outward to a full-radius (100%). Colors follow the shared
  // legend so the chart reads at a glance as land-use change over 12,025 years.
  //
  // Props:
  //   data           — { cell_totals: { year: N }, distribution: { year: {code: frac} } }
  //   colorMapping   — anthrome code → hex color
  //   labelMapping   — anthrome code → display label
  //   orderedCodes   — canonical stack order (intensive → wild)
  //   size           — pixel diameter

  let {
    data,
    colorMapping = {},
    labelMapping = {},
    orderedCodes = [],
    size = 240,
    // Currently-focused year string (e.g., "2000AD"). If present and in the
    // series, draw a coordinated radial marker line at its angular slice so
    // the inset and the main disk stay in sync.
    selectedYear = null
  } = $props();

  // Chronological year list from the distribution keys.
  const yearOrder = $derived(orderChronologically(Object.keys(data?.distribution ?? {})));

  const TAU = Math.PI * 2;
  const START_ANGLE = -Math.PI / 2; // 12 o'clock

  const layout = $derived.by(() => {
    const s = size;
    const outerR = s / 2 - 4;
    const innerR = s * 0.14; // reserve a hole for a label
    return { s, outerR, innerR };
  });

  const slices = $derived.by(() => {
    if (!yearOrder.length || !orderedCodes.length) return [];
    const { outerR, innerR } = layout;
    const stackDepth = outerR - innerR;
    const stepAngle = TAU / yearOrder.length;
    const out = [];
    for (let i = 0; i < yearOrder.length; i++) {
      const y = yearOrder[i];
      const a0 = START_ANGLE + i * stepAngle;
      const a1 = a0 + stepAngle;
      const dist = data.distribution[y] || {};
      let cum = 0;
      for (const code of orderedCodes) {
        const frac = dist[String(code)] || 0;
        if (frac <= 0) continue;
        const r0 = innerR + cum * stackDepth;
        const r1 = innerR + (cum + frac) * stackDepth;
        out.push({
          d: annularSector(a0, a1, r0, r1),
          fill: colorMapping[code] || '#666',
          code,
          year: y,
          frac
        });
        cum += frac;
      }
    }
    return out;
  });

  // Era markers around the outside — first, midpoint, last, plus 0 AD if
  // present. Kept sparse so labels don't crowd small charts.
  // Radial marker at the currently-selected year — line from inner hole out
   // to just past the outer edge at that year's slice angular midpoint.
  const yearMarker = $derived.by(() => {
    if (!selectedYear || !yearOrder.length) return null;
    const i = yearOrder.indexOf(selectedYear);
    if (i < 0) return null;
    const { outerR, innerR } = layout;
    const stepAngle = TAU / yearOrder.length;
    const a = START_ANGLE + (i + 0.5) * stepAngle;
    const cos = Math.cos(a);
    const sin = Math.sin(a);
    return {
      x1: innerR * cos,
      y1: innerR * sin,
      x2: (outerR + 6) * cos,
      y2: (outerR + 6) * sin,
      labelX: (outerR + 14) * cos,
      labelY: (outerR + 14) * sin,
      anchor: cos > 0.35 ? 'start' : cos < -0.35 ? 'end' : 'middle',
      baseline: sin > 0.35 ? 'hanging' : sin < -0.35 ? 'baseline' : 'middle',
      label: formatEraLabel(selectedYear)
    };
  });

  const eraTicks = $derived.by(() => {
    if (!yearOrder.length) return [];
    const { outerR } = layout;
    const stepAngle = TAU / yearOrder.length;
    const marks = [];
    const idxs = new Set([0, Math.floor(yearOrder.length / 2), yearOrder.length - 1]);
    const zeroIdx = yearOrder.indexOf('0AD');
    if (zeroIdx > 0) idxs.add(zeroIdx);
    for (const i of Array.from(idxs).sort((a, b) => a - b)) {
      const a = START_ANGLE + (i + 0.5) * stepAngle;
      const rx = Math.cos(a);
      const ry = Math.sin(a);
      marks.push({
        x: (outerR + 8) * rx,
        y: (outerR + 8) * ry,
        anchor: rx > 0.35 ? 'start' : rx < -0.35 ? 'end' : 'middle',
        baseline: ry > 0.35 ? 'hanging' : ry < -0.35 ? 'baseline' : 'middle',
        label: formatEraLabel(yearOrder[i])
      });
    }
    return marks;
  });

  function annularSector(a0, a1, r0, r1) {
    // Two arcs: outer ccw + inner cw, joined by radial edges. Clockwise sweep
    // matches how the year ring around the waffle reads on the other side.
    const largeArc = a1 - a0 > Math.PI ? 1 : 0;
    const cos0 = Math.cos(a0), sin0 = Math.sin(a0);
    const cos1 = Math.cos(a1), sin1 = Math.sin(a1);
    const p0 = [r0 * cos0, r0 * sin0];
    const p1 = [r1 * cos0, r1 * sin0];
    const p2 = [r1 * cos1, r1 * sin1];
    const p3 = [r0 * cos1, r0 * sin1];
    return (
      `M ${p0[0]} ${p0[1]} ` +
      `L ${p1[0]} ${p1[1]} ` +
      `A ${r1} ${r1} 0 ${largeArc} 1 ${p2[0]} ${p2[1]} ` +
      `L ${p3[0]} ${p3[1]} ` +
      `A ${r0} ${r0} 0 ${largeArc} 0 ${p0[0]} ${p0[1]} Z`
    );
  }

  function orderChronologically(keys) {
    // Sort year labels like "10000BC" ... "0AD" ... "2025AD" chronologically.
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

  function formatEraLabel(label) {
    if (!label) return '';
    const v = yearValue(label);
    if (v < 0) return `${Math.abs(v)} BC`;
    if (v === 0) return '0';
    return `${v}`;
  }
</script>

<div class="cts-wrap" style="--cts-size: {size}px;">
  <svg viewBox="{-size / 2} {-size / 2} {size} {size}" aria-hidden="true">
    {#each slices as s (s.year + '-' + s.code)}
      <path d={s.d} fill={s.fill}>
        <title>{formatEraLabel(s.year)} · {labelMapping[s.code] || s.code} · {Math.round(s.frac * 100)}%</title>
      </path>
    {/each}
    <circle class="hole" r={layout.innerR - 1} />
    {#each eraTicks as t (t.label)}
      <text
        class="era-label"
        x={t.x}
        y={t.y}
        text-anchor={t.anchor}
        dominant-baseline={t.baseline}
      >{t.label}</text>
    {/each}
    {#if yearMarker}
      <line
        class="year-marker"
        x1={yearMarker.x1}
        y1={yearMarker.y1}
        x2={yearMarker.x2}
        y2={yearMarker.y2}
      />
      <text
        class="year-marker-label"
        x={yearMarker.labelX}
        y={yearMarker.labelY}
        text-anchor={yearMarker.anchor}
        dominant-baseline={yearMarker.baseline}
      >{yearMarker.label}</text>
    {/if}
  </svg>
</div>

<style>
  .cts-wrap {
    width: var(--cts-size);
    height: var(--cts-size);
    display: block;
    margin: 0 auto;
  }

  .cts-wrap svg {
    width: 100%;
    height: 100%;
    overflow: visible;
  }

  .hole {
    fill: var(--bg, #0e0b16);
    stroke: rgba(255, 255, 255, 0.16);
    stroke-width: 0.6;
  }

  .era-label {
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.04em;
    fill: rgba(255, 255, 255, 0.72);
    text-transform: uppercase;
    pointer-events: none;
  }

  .year-marker {
    stroke: #ffffff;
    stroke-width: 2;
    stroke-linecap: round;
    filter: drop-shadow(0 0 3px rgba(255, 255, 255, 0.55));
    pointer-events: none;
  }

  .year-marker-label {
    font-size: 11px;
    font-weight: 800;
    letter-spacing: 0.04em;
    fill: #ffffff;
    text-transform: uppercase;
    pointer-events: none;
  }
</style>
