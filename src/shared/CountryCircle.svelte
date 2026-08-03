<script>
  // A picker chip shaped like a small globe. The chosen country is drawn as a
  // bright silhouette on an orthographic hemisphere centered at its own centroid;
  // neighboring countries fade into the background.
  //
  // Props:
  //   iso3          — ISO3 code
  //   label         — display label under the circle
  //   feature       — GeoJSON feature for this country (from decoded boundaries)
  //   size          — rendered pixel size of the circle (default 84)
  //   selected      — boolean, drives the ring highlight
  //   dimmed        — boolean, dulls the circle when another country is chosen
  //   onclick       — click handler; receives no args, parent knows the iso3

  import * as d3 from 'd3';

  let {
    iso3,
    label,
    feature,
    size = 84,
    selected = false,
    dimmed = false,
    onclick,
    // Ring stroke widths (in SVG user units, viewBox is 120).
    ringStroke = 3.2,
    ringStrokeSelected = 4.6,
    labelFontSize = 16   // px; scales with the picker section's CSS font-size unit
  } = $props();

  const VIEW = 120;
  const R = VIEW / 2 - 2;

  const projection = $derived.by(() => {
    if (!feature) return null;
    const [cx, cy] = d3.geoCentroid(feature);
    return d3
      .geoOrthographic()
      .rotate([-cx, -cy])
      .translate([VIEW / 2, VIEW / 2])
      .scale(R)
      .clipAngle(90);
  });

  const path = $derived(projection ? d3.geoPath(projection) : null);
  const spherePath = $derived(path ? path({ type: 'Sphere' }) : '');
  const graticulePath = $derived.by(() => {
    if (!path) return '';
    const g = d3.geoGraticule().step([20, 20]);
    return path(g());
  });

  const highlightPath = $derived(path && feature ? path(feature) : '');
</script>

<button
  type="button"
  class="country-circle"
  class:selected
  class:dimmed
  style="--cc-size: {size}px; --cc-label-font: {labelFontSize}px;"
  aria-pressed={selected}
  aria-label={selected ? `${label} — selected` : `Select ${label}`}
  {onclick}
>
  <svg viewBox="0 0 {VIEW} {VIEW}" aria-hidden="true">
    <defs>
      <clipPath id="cc-clip-{iso3}">
        <circle cx={VIEW / 2} cy={VIEW / 2} r={R} />
      </clipPath>
    </defs>
    <g clip-path="url(#cc-clip-{iso3})">
      <path class="water" d={spherePath} />
      <path class="graticule" d={graticulePath} />
      {#if highlightPath}
        <path class="highlight" d={highlightPath} />
      {/if}
    </g>
    <circle
      class="ring"
      cx={VIEW / 2}
      cy={VIEW / 2}
      r={R}
      stroke-width={selected ? ringStrokeSelected : ringStroke}
    />
  </svg>
  {#if label}
    <span class="cc-label">{label}</span>
  {/if}
</button>

<style>
  .country-circle {
    --cc-size: 84px;
    display: inline-flex;
    flex-direction: column;
    align-items: center;
    gap: 6px;
    background: transparent;
    border: none;
    padding: 0;
    color: var(--fg);
    cursor: pointer;
    transition: opacity 0.18s ease, transform 0.18s ease;
    font-family: inherit;
  }

  .country-circle svg {
    width: var(--cc-size);
    height: var(--cc-size);
    display: block;
    overflow: visible;
  }

  .water {
    fill: rgba(255, 255, 255, 0.04);
  }

  .graticule {
    fill: none;
    stroke: rgba(255, 255, 255, 0.05);
    stroke-width: 0.5;
  }

  .ctx {
    fill: rgba(255, 255, 255, 0.14);
    stroke: rgba(255, 255, 255, 0.05);
    stroke-width: 0.4;
  }

  .highlight {
    fill: #ffffff;
    stroke: #ffffff;
    stroke-width: 0.5;
    stroke-linejoin: round;
    filter: drop-shadow(0 0 2px rgba(255, 255, 255, 0.45));
  }

  .ring {
    fill: none;
    stroke: rgba(255, 255, 255, 0.85);
    transition: stroke 0.18s ease;
  }

  .country-circle:hover .ring {
    stroke: #ffffff;
  }

  .country-circle.selected .ring {
    stroke: #ffffff;
  }

  .country-circle.selected .water {
    fill: rgba(255, 255, 255, 0.09);
  }

  .country-circle.dimmed {
    opacity: 0.4;
  }

  .country-circle.dimmed:hover {
    opacity: 0.7;
  }

  .cc-label {
    font-size: var(--cc-label-font, 16px);
    font-weight: 800;
    letter-spacing: 0.03em;
    text-transform: uppercase;
    color: var(--fg);
    text-align: center;
    line-height: 1.15;
    opacity: 0.9;
    white-space: nowrap;
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .country-circle.selected .cc-label {
    opacity: 1;
  }
</style>
