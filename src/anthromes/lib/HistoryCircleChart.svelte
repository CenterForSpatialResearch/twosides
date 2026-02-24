<script>
  import * as d3 from 'd3';

  let { periods = [], size = 240 } = $props();

  // ── Geometry ──────────────────────────────────────────────────────────────
  const R      = $derived(size / 2 - 2);
  const outerR = $derived(R * 0.68);
  // 25% thinner ring: was 0.28R thick → now 0.21R thick
  const innerR = $derived(outerR - R * 0.21);  // ≈ R * 0.47

  // Radii for label placement
  const YEAR_TICK_LEN  = $derived(R * 0.07);           // inward tick from inner edge
  const YEAR_LABEL_R   = $derived(innerR * 0.62);       // year text inside hole
  const ANT_LEADER_R   = $derived(outerR + R * 0.04);   // leader start at outer edge
  const ANT_LABEL_R    = $derived(outerR + R * 0.22);   // anthrome text outside

  // ── Sectors ───────────────────────────────────────────────────────────────
  const sectors = $derived.by(() => {
    if (!periods?.length) return [];
    const weights    = periods.map(p => Math.sqrt(Math.max(p.duration, 1)));
    const totalWeight = weights.reduce((s, w) => s + w, 0);
    let cum = -Math.PI / 2;  // start at 9 o'clock (left), matching waffle chart
    return periods.map((p, i) => {
      const span  = (weights[i] / totalWeight) * 2 * Math.PI;
      const start = cum;
      const end   = start + span;
      cum = end;
      return {
        i,
        color: p.color,
        label: p.label,
        startYearLabel: p.startYearLabel,
        endYearLabel:   p.endYearLabel,
        startAngle: start,
        endAngle:   end,
        midAngle:   (start + end) / 2,
        span,
      };
    });
  });

  const arcGen = $derived(d3.arc().innerRadius(innerR).outerRadius(outerR));

  // ── Collision avoidance helper ─────────────────────────────────────────────
  // Iteratively push adjacent labels apart until no pair is closer than minGap.
  function pushApart(labels, minGap, maxPasses = 12) {
    const out = labels.map(l => ({ ...l }));
    for (let pass = 0; pass < maxPasses; pass++) {
      out.sort((a, b) => a.labelAngle - b.labelAngle);
      let changed = false;
      for (let i = 1; i < out.length; i++) {
        const gap = out[i].labelAngle - out[i - 1].labelAngle;
        if (gap < minGap) {
          const push = (minGap - gap) / 2;
          out[i - 1].labelAngle -= push;
          out[i].labelAngle     += push;
          changed = true;
        }
      }
      if (!changed) break;
    }
    return out;
  }

  // ── Year boundary labels (inside donut hole) ───────────────────────────────
  // One label per boundary: the start of the first sector, then each sector's end.
  const yearLabels = $derived.by(() => {
    if (!sectors.length) return [];

    const raw = [];
    // First boundary: start of chart
    raw.push({
      angle:      sectors[0].startAngle,
      text:       sectors[0].startYearLabel,
      labelAngle: sectors[0].startAngle + 0.15,  // nudge clockwise (toward first sector)
    });
    // One boundary per sector end
    sectors.forEach((s, i) => {
      raw.push({
        angle:      s.endAngle,
        text:       s.endYearLabel,
        // Nudge the last boundary rightward so first + last don't collide at top
        labelAngle: i === sectors.length - 1 ? s.endAngle - 0.15 : s.endAngle,
      });
    });

    // Minimum angular gap for year labels (in radians). Scale slightly with R.
    const minGap = R > 90 ? 0.22 : 0.28;
    return pushApart(raw, minGap);
  });

  // ── Anthrome name labels (outside ring) ────────────────────────────────────
  // Show for every sector; very thin slivers still get a label, just pushed aside.
  const anthromeLabels = $derived.by(() => {
    if (!sectors.length) return [];
    const raw = sectors.map(s => ({ ...s, labelAngle: s.midAngle }));
    const minGap = R > 90 ? 0.20 : 0.26;
    return pushApart(raw, minGap);
  });

  // ── Font sizes ─────────────────────────────────────────────────────────────
  const antFontSize  = $derived(Math.max(3, Math.round(R * 0.041)));
  const yearFontSize = $derived(Math.max(2, Math.round(R * 0.034)));
</script>

<svg
  width={size}
  height={size}
  viewBox="{-(R + 2)} {-(R + 2)} {size + 4} {size + 4}"
  class="history-circle-chart"
  aria-label="Cell anthrome history"
>
  <!-- Ghost ring -->
  <circle
    cx="0" cy="0"
    r={(outerR + innerR) / 2}
    fill="none"
    stroke="rgba(255,255,255,0.06)"
    stroke-width={outerR - innerR}
  />

  <!-- Colored sector arcs -->
  {#each sectors as s}
    <path
      d={arcGen({ startAngle: s.startAngle, endAngle: s.endAngle })}
      fill={s.color}
      opacity="0.88"
    />
  {/each}

  <!-- Boundary dividers (inner → outer) -->
  {#each sectors as s}
    <line
      x1={Math.sin(s.startAngle) * innerR}
      y1={-Math.cos(s.startAngle) * innerR}
      x2={Math.sin(s.startAngle) * outerR}
      y2={-Math.cos(s.startAngle) * outerR}
      stroke="rgba(0,0,0,0.45)"
      stroke-width="0.9"
    />
  {/each}

  <!-- ── Year labels inside hole, with tick + leader ── -->
  {#each yearLabels as y}
    {@const bx  = Math.sin(y.angle) * innerR}
    {@const by  = -Math.cos(y.angle) * innerR}
    {@const tx  = Math.sin(y.angle) * (innerR - YEAR_TICK_LEN)}
    {@const ty  = -Math.cos(y.angle) * (innerR - YEAR_TICK_LEN)}
    {@const lx  = Math.sin(y.labelAngle) * YEAR_LABEL_R}
    {@const ly  = -Math.cos(y.labelAngle) * YEAR_LABEL_R}
    <!-- Tick from inner edge inward -->
    <line x1={bx} y1={by} x2={tx} y2={ty}
      stroke="rgba(255,255,255,0.45)" stroke-width="0.9" />
    <!-- Leader from tick tip to label -->
    <line x1={tx} y1={ty} x2={lx} y2={ly}
      stroke="rgba(255,255,255,0.18)" stroke-width="0.7" />
    <text
      x={lx} y={ly}
      text-anchor="start"
      dominant-baseline="middle"
      font-size={yearFontSize}
      fill="rgba(255,255,255,0.60)"
      font-family="system-ui,-apple-system,sans-serif"
    >{y.text}</text>
  {/each}

  <!-- ── Anthrome labels outside ring, with leader ── -->
  {#each anthromeLabels as a}
    {@const mx  = Math.sin(a.midAngle) * ANT_LEADER_R}
    {@const my  = -Math.cos(a.midAngle) * ANT_LEADER_R}
    {@const lx  = Math.sin(a.labelAngle) * ANT_LABEL_R}
    {@const ly  = -Math.cos(a.labelAngle) * ANT_LABEL_R}
    {@const xdir = Math.sin(a.labelAngle)}
    {@const anchor = xdir > 0.12 ? 'start' : xdir < -0.12 ? 'end' : 'middle'}

    <line x1={mx} y1={my} x2={lx} y2={ly}
      stroke="rgba(255,255,255,0.28)" stroke-width="0.8" />
    <text
      x={lx} y={ly}
      text-anchor={anchor}
      dominant-baseline="middle"
      font-size={antFontSize}
      fill="rgba(255,255,255,0.82)"
      font-family="system-ui,-apple-system,sans-serif"
      font-weight="600"
    >{a.label}</text>
  {/each}
</svg>

<style>
  .history-circle-chart {
    display: block;
    overflow: visible;
  }
</style>
