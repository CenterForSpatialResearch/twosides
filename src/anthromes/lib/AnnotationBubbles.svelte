<script>
  import { onMount } from 'svelte';

  let { size = 'full' } = $props();

  // ── Constants ─────────────────────────────────────────────────────────────
  const FONT_SIZE  = 11;    // px — matches tooltip body text
  const TEXT_W     = 138;   // px — max text width inside circle
  const BUBBLE_PAD = 28;    // extra diameter added to text diagonal
  const MARGIN     = 16;    // min gap between bubble edges
  const EDGE_PAD   = 6;     // left-edge safety inset
  const CHART_GAP  = 22;    // min distance from waffle circle
  const TOP_END    = 0.44;  // top group zone end (fraction of h)
  const BTM_START  = 0.56;  // bottom group zone start (fraction of h)
  // Hard cap so bubbles stay in left-side whitespace even at extreme corners.
  const LEFT_FRAC  = 0.48;

  // ── State ─────────────────────────────────────────────────────────────────
  let containerEl = $state(null);
  let containerW  = $state(0);
  let containerH  = $state(0);
  let bubbles     = $state([]);
  let sizes       = $state([]);  // circle diameter per bubble (px)

  // ── Measure text height to derive circle diameter ─────────────────────────
  // Appends a hidden div to body, reads offsetHeight, then removes it.
  function measureDiam(text) {
    const div = document.createElement('div');
    div.style.cssText = `
      position: fixed;
      top: -9999px;
      left: -9999px;
      visibility: hidden;
      pointer-events: none;
      font-size: ${FONT_SIZE}px;
      line-height: 1.5;
      font-family: system-ui, -apple-system, sans-serif;
      max-width: ${TEXT_W}px;
      width: ${TEXT_W}px;
      text-align: center;
    `;
    div.textContent = text;
    document.body.appendChild(div);
    const h = div.offsetHeight;
    document.body.removeChild(div);
    // Minimum circle diameter that contains a TEXT_W × h rectangle, plus padding
    return Math.ceil(Math.sqrt(TEXT_W ** 2 + h ** 2)) + BUBBLE_PAD;
  }

  // ── Helpers ───────────────────────────────────────────────────────────────
  const PHI = 0.6180339887;
  function organic01(seed) {
    const t = (seed * PHI) % 1;
    return t < 0 ? t + 1 : t;
  }

  function clamp(v, min, max) {
    return Math.max(min, Math.min(max, v));
  }

  // Match WaffleChart's render radius so bubbles can avoid the circle envelope.
  function chartRadiusPx(w, h, mode) {
    const isPreview = mode === 'preview';
    const dim = isPreview ? 1200 : 7000;
    const outerMargin = isPreview ? 150 : 200;
    const radius = dim / 2 - outerMargin;
    return (Math.min(w, h) / dim) * radius;
  }

  // Max allowed bubble-center x at a given y that stays left of the chart circle.
  function maxCxForBubble(y, d, w, h, chartR) {
    const r = d / 2;
    const minCx = r + EDGE_PAD;
    const stripMaxCx = w * LEFT_FRAC - r - EDGE_PAD;

    if (stripMaxCx <= minCx) return minCx;

    const cx = w / 2;
    const cy = h / 2;
    const expanded = chartR + r + CHART_GAP;
    const dy = y - cy;

    if (Math.abs(dy) >= expanded) {
      return stripMaxCx;
    }

    const xAtEnvelope = cx - Math.sqrt(Math.max(0, expanded * expanded - dy * dy));
    return Math.max(minCx, Math.min(stripMaxCx, xAtEnvelope - 1));
  }

  function pairBoundsAtY(d1, d2, y, w, h, chartR) {
    const r1 = d1 / 2;
    const r2 = d2 / 2;
    const minSep = r1 + MARGIN + r2;

    const min1 = r1 + EDGE_PAD;
    const min2 = r2 + EDGE_PAD;
    const max1 = maxCxForBubble(y, d1, w, h, chartR);
    const max2 = maxCxForBubble(y, d2, w, h, chartR);

    // Feasible if there exists x1 in [min1,max1], x2 in [min2,max2] with x2 - x1 >= minSep.
    const ok = max2 - min1 >= minSep;
    return { ok, minSep, min1, min2, max1, max2 };
  }

  // Edge-biased pattern:
  // 5 items => [1,2], [3], [4,5]
  // 4 items => [1,2], [3,4]
  // 3 items => [1,2], [3]
  function buildPreferredRows(localCount) {
    const rows = [];
    let i = 0;
    let remaining = localCount;

    if (remaining >= 2) {
      rows.push([i, i + 1]);
      i += 2;
      remaining -= 2;
    }

    while (remaining > 2) {
      rows.push([i]);
      i += 1;
      remaining -= 1;
    }

    if (remaining === 2) {
      rows.push([i, i + 1]);
    } else if (remaining === 1) {
      rows.push([i]);
    }

    return rows;
  }

  // ── Layout calculation ────────────────────────────────────────────────────
  // Top and bottom groups, with edge-biased row patterns.
  function calcPositions(diams, w, h, mode) {
    if (!diams.length || w <= 0 || h <= 0) return [];

    const n     = diams.length;
    const topN  = Math.ceil(n / 2);
    const chartR = chartRadiusPx(w, h, mode);

    const pos = [];
    placeGroup(diams.slice(0, topN), [0, h * TOP_END], w, h, chartR, pos, 0);
    placeGroup(diams.slice(topN), [h * BTM_START, h], w, h, chartR, pos, topN);
    return pos;
  }

  function calcRowLayout(rows, diams, yMin, yMax, isTopZone) {
    const rowHeights = rows.map(row => Math.max(...row.map(i => diams[i])));
    const stackH = rowHeights.reduce((s, d) => s + d, 0) + (rows.length - 1) * MARGIN;
    const rangeH = yMax - yMin;
    const freeH = Math.max(0, rangeH - stackH);
    // Bias stacks toward the outer corners instead of dead center.
    const startBias = isTopZone ? 0.28 : 0.72;
    let rowTop = yMin + freeH * startBias;
    rowTop = clamp(rowTop, yMin, Math.max(yMin, yMax - stackH));

    const out = [];
    for (let r = 0; r < rows.length; r++) {
      const rowH = rowHeights[r];
      const y = clamp(rowTop + rowH / 2, yMin + rowH / 2, yMax - rowH / 2);
      out.push({ row: rows[r], rowH, y });
      rowTop += rowH + MARGIN;
    }
    return out;
  }

  function spreadPairAtY(d1, d2, y, w, h, chartR, seed) {
    const b = pairBoundsAtY(d1, d2, y, w, h, chartR);
    let x1 = b.min1;
    let x2 = b.max2;

    if (!b.ok) {
      // Not enough width for a true spread; place as safely as possible.
      x1 = clamp(b.min1, b.min1, b.max1);
      x2 = clamp(Math.max(b.min2, x1 + b.minSep), b.min2, b.max2);
      if (x2 - x1 < b.minSep) {
        x1 = clamp(Math.min(b.max1, x2 - b.minSep), b.min1, b.max1);
      }
      return { x1, x2, ok: false };
    }

    // Organic jitter while keeping left item left and right item right.
    const jLeft = 0.03 + organic01(seed * 1.31) * 0.12;
    const jRight = 0.03 + organic01(seed * 2.07) * 0.12;
    x1 = b.min1 + Math.max(0, b.max1 - b.min1) * jLeft;
    x2 = b.max2 - Math.max(0, b.max2 - b.min2) * jRight;

    // Enforce minimum separation.
    if (x2 - x1 < b.minSep) {
      const need = b.minSep - (x2 - x1);
      x1 = clamp(x1 - need / 2, b.min1, b.max1);
      x2 = clamp(x2 + need / 2, b.min2, b.max2);
    }
    if (x2 - x1 < b.minSep) {
      x2 = clamp(b.max2, b.min2, b.max2);
      x1 = clamp(x2 - b.minSep, b.min1, b.max1);
    }

    return { x1, x2, ok: true };
  }

  function placeGroup(diams, [yMin, yMax], w, h, chartR, out, offset) {
    const n = diams.length;
    if (!n) return;

    const isTopZone = yMax <= h / 2;
    let rows = buildPreferredRows(n);

    // Validate that pair-rows fit at their actual y; split to singles if needed.
    for (let pass = 0; pass < 3; pass++) {
      const layout = calcRowLayout(rows, diams, yMin, yMax, isTopZone);
      let changed = false;
      const nextRows = [];

      for (const rowInfo of layout) {
        const row = rowInfo.row;
        if (row.length === 2) {
          const d1 = diams[row[0]];
          const d2 = diams[row[1]];
          const b = pairBoundsAtY(d1, d2, rowInfo.y, w, h, chartR);
          if (!b.ok) {
            nextRows.push([row[0]], [row[1]]);
            changed = true;
            continue;
          }
        }
        nextRows.push(row);
      }

      rows = nextRows;
      if (!changed) break;
    }

    const layout = calcRowLayout(rows, diams, yMin, yMax, isTopZone);
    for (let r = 0; r < layout.length; r++) {
      const row = layout[r].row;
      const y = layout[r].y;

      if (row.length === 1) {
        const idx = row[0];
        const d = diams[idx];
        const minCx = d / 2 + EDGE_PAD;
        const maxCx = maxCxForBubble(y, d, w, h, chartR);
        const base = isTopZone ? 0.30 : 0.33;
        const jitter = (organic01(offset + idx * 1.91 + r * 0.73) - 0.5) * 0.18;
        const t = clamp(base + jitter, 0.16, 0.55);
        const x = minCx + Math.max(0, maxCx - minCx) * t;
        out.push({ x, y });
      } else {
        const i1 = row[0];
        const i2 = row[1];
        const d1 = diams[i1];
        const d2 = diams[i2];
        const placed = spreadPairAtY(d1, d2, y, w, h, chartR, offset + i1 + r * 0.87);
        const x1 = placed.x1;
        const x2 = placed.x2;

        out.push({ x: x1, y });
        out.push({ x: x2, y });
      }
    }
  }

  // ── Derived positions ─────────────────────────────────────────────────────
  const positions = $derived.by(() => calcPositions(sizes, containerW, containerH, size));

  // ── Measure when bubbles load ─────────────────────────────────────────────
  $effect(() => {
    const list = bubbles;
    if (!list.length) { sizes = []; return; }
    sizes = list.map(b => measureDiam(b.text));
  });

  // ── Lifecycle ─────────────────────────────────────────────────────────────
  onMount(() => {
    const ro = new ResizeObserver(([entry]) => {
      containerW = entry.contentRect.width;
      containerH = entry.contentRect.height;
    });
    if (containerEl) ro.observe(containerEl);

    const base = import.meta.env.BASE_URL;
    fetch(`${base}data/annotations.json`)
      .then(r => r.json())
      .then(d => { bubbles = d.sort((a, b) => a.order - b.order); })
      .catch(err => console.warn('AnnotationBubbles: failed to load annotations.json', err));

    return () => ro.disconnect();
  });
</script>

<div
  class="ab-layer"
  bind:this={containerEl}
  style="--ab-font-size: {FONT_SIZE}px; --ab-text-w: {TEXT_W}px;"
>
  {#each bubbles as b, i (b.order)}
    {#if sizes[i] && positions[i]}
      {@const d = sizes[i]}
      {@const p = positions[i]}
      <div
        class="ab-bubble"
        style="width:{d}px; height:{d}px; left:{p.x - d/2}px; top:{p.y - d/2}px;"
      >
        <p class="ab-text">{b.text}</p>
      </div>
    {/if}
  {/each}
</div>

<style>
  /* Transparent full-area layer — pointer events pass through except on bubbles */
  .ab-layer {
    position: absolute;
    inset: 0;
    pointer-events: none;
    overflow: visible;
    z-index: 3;
  }

  .ab-bubble {
    position: absolute;
    border-radius: 50%;
    background: #000;
    border: 1.5px solid #fff;
    display: flex;
    align-items: center;
    justify-content: center;
    pointer-events: auto;
    /* Subtle depth */
    box-shadow:
      0 0 0 3px rgba(0, 0, 0, 0.4),
      0 4px 24px rgba(0, 0, 0, 0.5);
  }

  .ab-text {
    margin: 0;
    max-width: var(--ab-text-w);
    font-size: var(--ab-font-size);
    line-height: 1.5;
    color: #fff;
    text-align: center;
    font-family: system-ui, -apple-system, sans-serif;
  }
</style>
