<script>
  // The details panel's timeline, in the same pixel vocabulary the whole
  // Option 1 arrangement uses. One component serves every scale the panel can
  // show — the world, a country, a single cell — so switching between them is
  // one continuous gesture rather than a component swap.
  //
  // Two things define it:
  //
  // 1. PIXELS, not continuous columns. Each column is a stack of `rows` equal
  //    cells apportioned by largest remainder, so every column sums to exactly
  //    `rows` and a share too small to earn a cell reads as genuinely absent
  //    rather than as a sub-pixel smear.
  //
  // 2. EQUAL-COUNT TIME, not linear time. Every sampled year gets one column of
  //    identical width, exactly like the waffle ring's scaleBand. The dataset
  //    samples 10,000BC-2025 at wildly uneven intervals and nearly all of the
  //    change sits in the last century; on a linear axis that century is a
  //    hairline. Here a year's share of the width is its share of the samples —
  //    the ~13 years after 2000 are ~17% of the 76 samples, so they take ~17%
  //    of the timeline. The axis is deliberately non-linear: ticks are placed
  //    at their COLUMN, not at their date.
  //
  // Swapping datasets animates: columns drain to the baseline backwards through
  // time, then refill forwards, in whole pixels. Timing is shared with the
  // waffle ring (swapTransition.js), so when a country is picked the ring and
  // this chart perform the same motion at the same moment.
  //
  // Props:
  //   distribution  — { year: { code: fraction } }, fractions summing to ~1
  //   sourceKey     — identifies the dataset; a change triggers the swap
  //   colorMapping  — anthrome code → hex color
  //   labelMapping  — anthrome code → display label
  //   orderedCodes  — canonical code order (intensive → wild)
  //   selectedYear  — data-format year string ("2000AD") for the marker
  //   width, height — the box to fill, in design px

  import { untrack } from 'svelte';
  import {
    SWAP_MS,
    SWAP_PHASE_MS,
    phaseExtent
  } from '../../shared/swapTransition.js';

  let {
    // 'stack'  — a share-of-land distribution: { year: { code: fraction } }
    // 'ladder' — a single cell's class per year: { year: code }
    mode = 'stack',
    distribution = null,
    series = null,
    sourceKey = 'default',
    colorMapping = {},
    labelMapping = {},
    orderedCodes = [],
    // [{ name, codes }] in intensity order, most intensive first. Ladder mode
    // labels its bands from this.
    families = [],
    selectedYear = null,
    // Called with a data-format year string when a column is clicked. The
    // timeline doubles as a year scrubber, like the ring does.
    onSelectYear = null,
    width = 800,
    height = 300
  } = $props();

  const AXIS_H = 22;      // strip below the field for era ticks
  const MARKER_H = 16;    // strip above it for the selected-year callout
  const CELL_GAP = 0.9;   // inset per cell, so the field reads as pixels
  const MIN_ROWS = 8;
  const MAX_ROWS = 48;
  const LADDER_GUTTER = 152; // left strip for the ladder's band labels
  const LADDER_DIM = 0.26;   // opacity of the fill below the year's own class

  // ===== Dataset swap =====
  // The field keeps drawing the OUTGOING dataset until the midpoint, so these
  // shadow the props rather than reading them directly. The MODE is shadowed
  // too: switching a country (stack) for a cell (ladder) has to finish
  // collapsing the stack before the ladder starts growing.
  let renderedKey = $state(null);
  let renderedMode = $state('stack');
  let renderedData = $state(null);
  let phase = $state('idle');   // 'idle' | 'out' | 'in'
  let elapsed = $state(0);      // ms into the current phase
  let raf = 0;

  const incoming = $derived({
    key: sourceKey,
    mode,
    data: mode === 'ladder' ? series : distribution
  });

  $effect(() => {
    const next = incoming;
    untrack(() => {
      const settled = phase === 'idle';
      if (renderedKey === null || (settled && next.key === renderedKey)) {
        // First paint, or the same dataset handed over as a fresh object.
        renderedKey = next.key;
        renderedMode = next.mode;
        renderedData = next.data;
        return;
      }
      if (next.key === renderedKey) return;
      startSwap(next);
    });
  });

  $effect(() => () => cancelAnimationFrame(raf));

  function commit(next) {
    renderedKey = next.key;
    renderedMode = next.mode;
    renderedData = next.data;
  }

  function startSwap(next) {
    cancelAnimationFrame(raf);
    const t0 = performance.now();
    let swapped = false;
    phase = 'out';
    elapsed = 0;

    const step = (now) => {
      const e = now - t0;
      if (e >= SWAP_MS) {
        // Guard the case where a dropped frame skips the midpoint entirely.
        if (!swapped) commit(next);
        phase = 'idle';
        elapsed = 0;
        return;
      }
      if (e < SWAP_PHASE_MS) {
        phase = 'out';
        elapsed = e;
      } else {
        if (!swapped) {
          swapped = true;
          commit(next);
        }
        phase = 'in';
        elapsed = e - SWAP_PHASE_MS;
      }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
  }

  // ===== Layout =====
  const isLadder = $derived(renderedMode === 'ladder');

  const yearOrder = $derived(
    orderChronologically(Object.keys(renderedData ?? {}))
  );

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

  const fieldTop = $derived(MARKER_H);
  const fieldH = $derived(Math.max(20, height - MARKER_H - AXIS_H));
  // Ladder mode gives up a strip on the left to name its bands; stack mode has
  // nothing to name (the always-visible anthrome key below the panel carries
  // the colour legend) so it uses the full width.
  const fieldLeft = $derived(isLadder ? LADDER_GUTTER : 0);
  const fieldW = $derived(Math.max(20, width - fieldLeft));
  const cellW = $derived(yearOrder.length ? fieldW / yearOrder.length : fieldW);

  // The anthrome ladder, bottom-up: least human intervention at the base,
  // Dense Settlements at the top. Ladder mode has one row per class — the row
  // IS the value, so it cannot pick a row count for square cells the way stack
  // mode does.
  //
  // Built from `families` rather than orderedCodes so the rows line up exactly
  // with the band labels, and so codes that are not anthromes at all — "No
  // land" (70) — get no rung. A year whose class is off-ladder simply draws no
  // column, which is the honest reading.
  const ladderCodes = $derived(
    families.length
      ? families.flatMap((f) => f.codes).reverse()
      : [...orderedCodes].reverse()
  );
  const ladderIndex = $derived(new Map(ladderCodes.map((c, i) => [c, i])));

  // Stack mode picks a row count that keeps cells roughly square, then divides
  // the exact height evenly so the field fills its box top to bottom.
  const rows = $derived(
    isLadder
      ? Math.max(1, ladderCodes.length)
      : Math.max(MIN_ROWS, Math.min(MAX_ROWS, Math.round(fieldH / Math.max(1, cellW))))
  );
  const cellH = $derived(fieldH / rows);

  // One label per family, centred on the rows its member codes occupy.
  const ladderBands = $derived.by(() => {
    if (!isLadder || !families.length) return [];
    return families
      .map((fam) => {
        const idxs = fam.codes.map((c) => ladderIndex.get(c)).filter((i) => i != null);
        if (!idxs.length) return null;
        const lo = Math.min(...idxs);
        const hi = Math.max(...idxs);
        return {
          name: fam.name,
          // Row indices count up from the base, y counts down from the top.
          yMid: fieldTop + fieldH - ((lo + hi) / 2 + 0.5) * cellH,
          yTop: fieldTop + fieldH - (hi + 1) * cellH
        };
      })
      .filter(Boolean);
  });

  /**
   * Largest-remainder apportionment of `rows` cells across the anthrome codes
   * present in one year. Returned bottom-up: Wildlands (largest code) sits at
   * the base, Dense Settlements at the top, matching the paper's intensity
   * gradient and the ring's stacking order.
   */
  function allocate(dist) {
    const entries = [...orderedCodes]
      .reverse()
      .map((code) => ({ code, exact: (dist[String(code)] || 0) * rows }))
      .filter((e) => e.exact > 0);
    if (!entries.length) return [];

    entries.forEach((e) => { e.n = Math.floor(e.exact); });
    let left = rows - entries.reduce((s, e) => s + e.n, 0);
    // Hand the remainder to the largest fractional parts. Cycling by modulo
    // covers the case where every share floored to zero and there are fewer
    // entries than cells to give away.
    const byRemainder = [...entries].sort(
      (a, b) => (b.exact - Math.floor(b.exact)) - (a.exact - Math.floor(a.exact))
    );
    for (let i = 0; left > 0; i++, left--) byRemainder[i % byRemainder.length].n++;

    return entries.filter((e) => e.n > 0);
  }

  const rowY = (k) => fieldTop + fieldH - (k + 1) * cellH;

  // The full field, recomputed only when the data or the box changes — never
  // per animation frame. `cells` is ordered from the base upward, which is what
  // lets the animation reveal a column by taking a prefix of it.
  const columns = $derived.by(() => {
    if (!renderedData || !yearOrder.length || !orderedCodes.length || !rows) return [];

    return yearOrder.map((year, i) => {
      const x = fieldLeft + i * cellW;
      const cells = [];
      let head = null; // the label this column stands for, for its tooltip

      if (isLadder) {
        // One class per year: fill from the base up to that class's row. The
        // top cell is the class itself at full strength; the rows beneath are
        // each dimmed in their OWN colour, so the column reads as a slice
        // through the ladder rather than a solid bar, and its height reads
        // directly as land-use intensity.
        const code = renderedData[year];
        const top = ladderIndex.get(Number(code));
        if (top != null) {
          head = labelMapping[code] || String(code);
          for (let k = 0; k <= top; k++) {
            const rowCode = ladderCodes[k];
            cells.push({
              key: `r${k}`,
              y: rowY(k),
              color: colorMapping[rowCode] || '#666',
              opacity: k === top ? 1 : LADDER_DIM,
              label: labelMapping[rowCode] || String(rowCode)
            });
          }
        }
      } else {
        const dist = renderedData[year] || {};
        let filled = 0; // rows already placed, counting up from the base
        for (const { code, n } of allocate(dist)) {
          const color = colorMapping[code] || '#666';
          const label = labelMapping[code] || String(code);
          for (let k = 0; k < n; k++) {
            cells.push({
              key: `${code}-${filled + k}`,
              y: rowY(filled + k),
              color,
              opacity: 1,
              label
            });
          }
          filled += n;
        }
      }

      return { year, yv: yearValue(year), x, head, cells };
    });
  });

  // Mid-swap, each column shows only a prefix of its cells — a whole number of
  // pixels, so the field never renders a half-cell. Idle returns the columns
  // untouched (and the same object identities), so there is no per-frame work
  // once the swap has finished.
  const visibleColumns = $derived.by(() => {
    if (phase === 'idle') return columns;
    const n = columns.length;
    return columns.map((col, i) => {
      const keep = Math.round(phaseExtent(phase, elapsed, i, n) * col.cells.length);
      if (keep >= col.cells.length) return col;
      return { ...col, cells: col.cells.slice(0, keep) };
    });
  });

  const markerIndex = $derived(yearOrder.indexOf(selectedYear));
  const markerX = $derived(markerIndex >= 0 ? fieldLeft + markerIndex * cellW : null);

  function formatEra(y) {
    if (y == null || !Number.isFinite(y)) return '';
    if (y < 0) return `${Math.abs(y).toLocaleString()} BC`;
    if (y === 0) return '0';
    return `${y.toLocaleString()}`;
  }

  // Ticks sit at their COLUMN, since the axis is equal-count rather than linear.
  // Targets mark the eras a reader looks for; each snaps to the nearest sampled
  // year actually present.
  const TICK_TARGETS = [-10000, -1000, 0, 1000, 1700, 1900, 2000];
  const TICK_FONT_PX = 12;
  const TICK_PAD = 10;   // clear space required between two labels

  // Rough advance width for the tick face (700-weight, uppercase digits and a
  // possible " BC"). Only used to decide which labels fit, so an estimate is
  // fine — and it must not depend on measuring the DOM, since this runs before
  // the SVG is laid out.
  const labelWidth = (s) => s.length * TICK_FONT_PX * 0.62;

  const eraTicks = $derived.by(() => {
    if (!yearOrder.length) return [];
    const values = yearOrder.map(yearValue);
    const last = yearOrder.length - 1;

    const nearest = (target) => {
      let best = 0;
      for (let i = 1; i < values.length; i++) {
        if (Math.abs(values[i] - target) < Math.abs(values[best] - target)) best = i;
      }
      return best;
    };

    const anchorFor = (x) =>
      x < fieldLeft + 24 ? 'start' : x > width - 24 ? 'end' : 'middle';

    const at = (idx) => {
      const x = fieldLeft + idx * cellW + cellW / 2;
      const label = formatEra(values[idx]);
      const w = labelWidth(label);
      const anchor = anchorFor(x);
      // Span the label actually occupies, which is what has to not overlap —
      // the end labels are start/end-anchored, so their centre is a poor proxy.
      const x0 = anchor === 'start' ? x : anchor === 'end' ? x - w : x - w / 2;
      return { idx, x, label, anchor, x0, x1: x0 + w };
    };

    // Equal-count time squeezes the pre-industrial targets into very few
    // columns — 1000BC and 0AD are adjacent samples — so drop any candidate
    // that would print on top of a kept one. First and last always survive:
    // they anchor the span, so the last one wins ties against its neighbours.
    const candidates = [...new Set(TICK_TARGETS.map(nearest))].sort((a, b) => a - b);
    const first = at(0);
    const final = last > 0 ? at(last) : null;

    const kept = [first];
    for (const idx of candidates) {
      if (idx === 0 || idx === last) continue;
      const t = at(idx);
      if (t.x0 - kept[kept.length - 1].x1 < TICK_PAD) continue;
      if (final && final.x0 - t.x1 < TICK_PAD) continue;
      kept.push(t);
    }
    if (final) kept.push(final);
    return kept;
  });
</script>

<svg
  class="pixel-timeline"
  viewBox={`0 0 ${width} ${height}`}
  preserveAspectRatio="none"
  role="img"
  aria-label="Anthrome composition over time, one column per sampled year"
>
  <rect x={fieldLeft} y={fieldTop} width={fieldW} height={fieldH} class="field-bg" />

  <!-- Ladder mode only: name each family band down the left gutter, with a
       hairline at the band's upper edge so the steps are readable even where
       the column stops short of them. -->
  {#each ladderBands as band (band.name)}
    <line x1={fieldLeft} x2={width} y1={band.yTop} y2={band.yTop} class="band-rule" />
    <text x={fieldLeft - 10} y={band.yMid} class="band-label" text-anchor="end">{band.name}</text>
  {/each}

  {#each visibleColumns as col (col.year)}
    <g class="col">
      {#each col.cells as cell (cell.key)}
        <rect
          x={col.x + CELL_GAP / 2}
          y={cell.y + CELL_GAP / 2}
          width={Math.max(0.5, cellW - CELL_GAP)}
          height={Math.max(0.5, cellH - CELL_GAP)}
          fill={cell.color}
          opacity={cell.opacity}
        />
      {/each}
      <title>{formatEra(col.yv)}{col.head ? ` · ${col.head}` : ''}</title>
    </g>
  {/each}

  <!-- Click targets: one invisible bar per column, spanning the full field so
       the short columns of a low-intensity cell are as easy to hit as the tall
       ones. Drawn after the pixels so they sit on top, and keyed off `columns`
       rather than `visibleColumns` so a swap in flight doesn't drop them. -->
  {#if onSelectYear}
    {#each columns as col (col.year)}
      <rect
        class="col-hit"
        x={col.x}
        y={fieldTop}
        width={cellW}
        height={fieldH}
        role="button"
        tabindex="-1"
        aria-label={`Show ${formatEra(col.yv)}`}
        onclick={() => onSelectYear(col.year)}
      />
    {/each}
  {/if}

  <!-- Era baseline. Ticks are positioned by column index, not by date. -->
  <line x1={fieldLeft} x2={width} y1={fieldTop + fieldH} y2={fieldTop + fieldH} class="axis-line" />
  {#each eraTicks as t (t.idx)}
    <line
      x1={t.x}
      x2={t.x}
      y1={fieldTop + fieldH}
      y2={fieldTop + fieldH + 4}
      class="axis-tick"
    />
    <text
      x={t.x}
      y={fieldTop + fieldH + 16}
      class="axis-label"
      text-anchor={t.anchor}
    >{t.label}</text>
  {/each}

  <!-- Selected-year marker: brackets the column rather than drawing over it,
       so the pixels underneath stay readable. -->
  {#if markerX != null}
    <rect
      x={markerX - 1}
      y={fieldTop - 3}
      width={cellW + 2}
      height={fieldH + 6}
      class="year-marker"
    />
    <text
      x={markerX + cellW / 2}
      y={MARKER_H - 6}
      class="year-marker-label"
      text-anchor={
        markerX < fieldLeft + 30 ? 'start' : markerX > width - 30 ? 'end' : 'middle'
      }
    >{formatEra(yearValue(selectedYear))}</text>
  {/if}
</svg>

<style>
  .pixel-timeline {
    display: block;
    width: 100%;
    height: 100%;
    overflow: visible;
  }

  .field-bg {
    fill: rgba(255, 255, 255, 0.06);
  }

  .col-hit {
    fill: transparent;
    cursor: pointer;
  }

  .col-hit:hover {
    fill: rgba(255, 255, 255, 0.10);
  }

  .axis-line {
    stroke: rgba(255, 255, 255, 0.24);
    stroke-width: 0.8;
  }

  .band-rule {
    stroke: rgba(255, 255, 255, 0.16);
    stroke-width: 0.8;
    pointer-events: none;
  }

  .band-label {
    font-size: 11.5px;
    font-weight: 700;
    letter-spacing: 0.05em;
    fill: rgba(255, 255, 255, 0.66);
    text-transform: uppercase;
    dominant-baseline: middle;
    pointer-events: none;
  }

  .axis-tick {
    stroke: rgba(255, 255, 255, 0.55);
    stroke-width: 1;
  }

  /* Keep in step with TICK_FONT_PX, which sizes the overlap test above. */
  .axis-label {
    font-size: 12px;
    font-weight: 700;
    letter-spacing: 0.04em;
    fill: rgba(255, 255, 255, 0.7);
    text-transform: uppercase;
    pointer-events: none;
  }

  .year-marker {
    fill: none;
    stroke: #ffffff;
    stroke-width: 1.6;
  }

  .year-marker-label {
    font-size: 12.5px;
    font-weight: 800;
    letter-spacing: 0.04em;
    fill: #ffffff;
    text-transform: uppercase;
  }
</style>
