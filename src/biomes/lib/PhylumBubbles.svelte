<script>
  // Packed-bubble replacement for the flat phylum pill row. One bubble per
  // named phylum, area proportional to that phylum's SGB count. Phyla that
  // fall through to the "Other" color in the palette are pre-aggregated into
  // one Other bubble (summed count).
  //
  // Labels wrap around the top of each bubble via SVG textPath — smaller
  // bubbles drop their label rather than crowding.
  //
  // Selection contract mirrors the old pill row: `selectedPhyla` is a flat
  // list of phylum names; clicking a bubble calls `onToggle` with either
  // { name } (single phylum) or { memberNames } (Other, expands to N phyla).

  import * as d3 from 'd3';

  let {
    bubbles = [],
    selectedPhyla = [],
    onToggle,
    pickTextColor,
    width = 0,
    height = 0,
    // Bounds are ASPIRATIONAL — d3.pack fits everything into [width, height],
    // so the actual on-screen minimum can still shrink when the container is
    // tight. These primarily compress the sqrt(count) range so the biggest
    // and smallest bubbles stay comparable.
    minRadius = 26,   // ~52px diameter — comfortable finger tap + fits label
    maxRadius = 96,   // stops one giant bubble from eating the whole section
    padding = 4,
    // Match the viz backdrop: radial gradient from transparent-at-center
    // (revealing the app bg) to phylum colour at the rim. When false, bubbles
    // fill solid with the phylum colour (the original chip look).
    gradientFill = true,
    // App background — the "black" the center fades to. Match the biomes bg.
    backgroundColor = '#0e0b16'
  } = $props();

  const LABEL_MIN_R = 20;     // below this on-screen radius, skip the label
  const LABEL_MAX_FONT = 14;
  const LABEL_MIN_FONT = 9;
  const LINE_HEIGHT_EM = 1.05;

  const nodes = $derived.by(() => {
    if (!bubbles.length || width <= 0 || height <= 0) return [];

    // Compress the raw count range: bubbles scale on sqrt(count) between
    // [minRadius, maxRadius]. Then feed pack an area (π r²) so its own
    // sqrt-based sizing lands on those target radii before the layout
    // scales everything to fit the container.
    const counts = bubbles.map((b) => Math.max(0, b.count || 0));
    const positive = counts.filter((c) => c > 0);
    const domainMin = positive.length ? Math.min(...positive) : 1;
    const domainMax = positive.length ? Math.max(...positive) : 1;
    const rScale =
      domainMax === domainMin
        ? () => (minRadius + maxRadius) / 2
        : d3.scaleSqrt().domain([domainMin, domainMax]).range([minRadius, maxRadius]);

    const root = d3
      .hierarchy({ children: bubbles })
      .sum((d) => {
        const c = Math.max(0, d.count || 0);
        return c > 0 ? Math.PI * rScale(c) ** 2 : 0;
      })
      .sort((a, b) => (b.value || 0) - (a.value || 0));
    d3.pack().size([width, height]).padding(padding)(root);
    return root.leaves();
  });

  const selectedSet = $derived(new Set(selectedPhyla));

  function bubbleActive(datum) {
    if (!selectedSet.size) return false;
    if (datum.isOther) return datum.memberNames.some((n) => selectedSet.has(n));
    return selectedSet.has(datum.name);
  }

  function fontSizeFor(r) {
    return Math.min(LABEL_MAX_FONT, Math.max(LABEL_MIN_FONT, r * 0.30));
  }

  // Break a phylum name into wrap-friendly lines that fit inside a circle of
  // radius r at the given font size. Falls back to a single truncated line if
  // even one word doesn't fit.
  function labelLines(name, r, fontSize) {
    const clean = name.replace(/_/g, ' ');
    // Approx char width for a semi-bold sans-serif at this size.
    const charW = fontSize * 0.55;
    // Available line width shrinks a bit at the top/bottom of the circle;
    // 1.55·r ≈ chord at ~55% of vertical extent — a conservative fit.
    const maxLineW = Math.max(fontSize, r * 1.55);
    const capChars = Math.max(3, Math.floor(maxLineW / charW));

    const words = clean.split(/\s+/).filter(Boolean);
    const lines = [];
    let cur = '';
    for (const w of words) {
      if (!cur.length) {
        cur = w;
      } else if ((cur + ' ' + w).length <= capChars) {
        cur = cur + ' ' + w;
      } else {
        lines.push(cur);
        cur = w;
      }
    }
    if (cur) lines.push(cur);

    // Cap total lines by vertical space: each line takes fontSize·LINE_HEIGHT_EM,
    // and we need to fit within ~1.6·r vertical chord.
    const maxLines = Math.max(1, Math.floor((r * 1.6) / (fontSize * LINE_HEIGHT_EM)));
    if (lines.length > maxLines) {
      lines.length = maxLines;
      const last = lines[maxLines - 1];
      lines[maxLines - 1] = last.length > 4 ? last.slice(0, Math.max(2, capChars - 1)) + '…' : last;
    }
    // Truncate any single line that still overflows.
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].length > capChars) {
        lines[i] = lines[i].slice(0, Math.max(2, capChars - 1)) + '…';
      }
    }
    return lines;
  }

  function handleClick(e, datum) {
    e.stopPropagation();
    onToggle?.(datum);
  }
</script>

<svg
  class="phylum-bubbles"
  viewBox="0 0 {width || 1} {height || 1}"
  preserveAspectRatio="xMidYMid meet"
  aria-label="Phylum distribution — bubble size is number of species"
>
  {#if gradientFill}
    <defs>
      {#each nodes as n, i (n.data.name)}
        {@const color = n.data.color || '#cccccc'}
        <!-- objectBoundingBox lets one gradient shape work for any bubble
             size; per-bubble def gives each phylum its own colour stop. -->
        <radialGradient id={`pb-grad-${i}`} cx="0.5" cy="0.5" r="0.5">
          <stop offset="0%" stop-color={backgroundColor} stop-opacity="0" />
          <stop offset="55%" stop-color={color} stop-opacity="0.55" />
          <stop offset="100%" stop-color={color} stop-opacity="1" />
        </radialGradient>
      {/each}
    </defs>
  {/if}

  {#each nodes as n, i (n.data.name)}
    {@const d = n.data}
    {@const active = bubbleActive(d)}
    {@const dimmed = selectedSet.size > 0 && !active}
    {@const color = d.color || '#cccccc'}
    {@const fontSize = fontSizeFor(n.r)}
    {@const lines = n.r >= LABEL_MIN_R ? labelLines(d.name, n.r, fontSize) : []}
    <!-- In gradient mode the label sits over the dark centre — force a bright
         fill for contrast. In solid mode fall back to the luminance picker. -->
    {@const textFill = gradientFill
      ? '#f6f7fb'
      : (pickTextColor ? pickTextColor(color) : '#0e0b16')}
    {@const yStart = n.y - ((lines.length - 1) * fontSize * LINE_HEIGHT_EM) / 2}
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <g
      class="bubble"
      class:active
      class:dimmed
      data-idx={i}
      data-name={d.name}
      onclick={(e) => handleClick(e, d)}
    >
      <circle
        cx={n.x}
        cy={n.y}
        r={n.r}
        fill={gradientFill ? `url(#pb-grad-${i})` : color}
        class="bubble-fill"
      >
        <title>{d.name.replace(/_/g, ' ')} — {d.count?.toLocaleString?.() ?? d.count} species{d.isOther ? ` (${d.memberNames.length} phyla)` : ''}</title>
      </circle>
      {#if lines.length}
        <text
          class="bubble-label"
          class:on-dark={gradientFill}
          x={n.x}
          y={yStart}
          font-size={fontSize}
          fill={textFill}
          text-anchor="middle"
          dominant-baseline="middle"
        >
          {#each lines as line, li (li)}
            <tspan x={n.x} dy={li === 0 ? 0 : fontSize * LINE_HEIGHT_EM}>{line}</tspan>
          {/each}
        </text>
      {/if}
    </g>
  {/each}
</svg>

<style>
  .phylum-bubbles {
    width: 100%;
    height: 100%;
    display: block;
    overflow: visible;
    user-select: none;
  }

  .bubble {
    cursor: pointer;
    transition: opacity 0.18s ease;
  }

  .bubble-fill {
    stroke: none;
    transition: stroke 0.15s ease;
  }

  .bubble.dimmed {
    opacity: 0.35;
  }

  .bubble:hover .bubble-fill {
    stroke: rgba(255, 255, 255, 0.35);
    stroke-width: 1.4;
  }

  .bubble.active .bubble-fill {
    stroke: #ffffff;
    stroke-width: 2;
  }

  .bubble-label {
    font-weight: 700;
    letter-spacing: 0.02em;
    pointer-events: none;
  }

  /* On the dark-centre gradient variant, add a subtle glow so labels sit
     crisp against the near-black hole even when the phylum colour is warm. */
  .bubble-label.on-dark {
    paint-order: stroke fill;
    stroke: rgba(0, 0, 0, 0.55);
    stroke-width: 0.6;
    stroke-linejoin: round;
  }
</style>
