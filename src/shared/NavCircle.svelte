<script>
  // The bottom-corner navigation coin, shared by both apps. Each side renders it
  // with its own labels/side; the markup and styling were byte-identical apart
  // from left/right placement and the two labels, so it lives here once.
  let {
    side = 'left',            // 'left' | 'right' — which corner it docks in
    activeLabel = '',         // current app name, shown along the top arc
    linkLabel = '',           // other app name (+ arrow), shown along the bottom arc
    linkHref = '#',           // href to the other app
    linkAriaLabel = '',       // a11y label for the cross-link
    homeHref = '#'            // href for the centre home dot
  } = $props();
</script>

<div class="nav-circle nav-circle--{side}">
  <div class="nav-circle__outer">
    <svg viewBox="0 0 120 120" aria-hidden="true">
      <defs>
        <!-- upper arc (left→right across the top) -->
        <path id="nav-arc-top" d="M8 60 A52 52 0 0 1 112 60" />
        <!-- lower arc (right→left across the bottom) -->
        <path id="nav-arc-bottom" d="M112 60 A52 52 0 0 1 8 60" />
      </defs>
      <g class="nav-circle__labels" transform="rotate(45 60 60)">
        <circle class="nav-circle__ring" cx="60" cy="60" r="52" />
        <text class="nav-circle__text nav-circle__text--active">
          <textPath href="#nav-arc-top" startOffset="50%" text-anchor="middle"><tspan class="here">{activeLabel}</tspan></textPath>
        </text>
        <text class="nav-circle__text nav-circle__text--link">
          <a href={linkHref} aria-label={linkAriaLabel}>
            <textPath href="#nav-arc-bottom" startOffset="50%" text-anchor="middle">{linkLabel}</textPath>
          </a>
        </text>
      </g>
    </svg>
  </div>

  <a class="nav-circle__home" href={homeHref} aria-label="Back to home">←</a>
</div>

<style>
  .nav-circle {
    position: absolute;
    bottom: 26px;
    width: 248px;
    height: 248px;
    border-radius: 50%;
    background: var(--bg);
    border: 3.8px solid rgba(255, 255, 255, 0.85);
    box-shadow: var(--shadow);
    display: grid;
    place-items: center;
    color: var(--fg);
    text-decoration: none;
    z-index: 8;
    pointer-events: auto;
    overflow: visible;
  }

  .nav-circle--left { left: 26px; }
  .nav-circle--right { right: 26px; }

  .nav-circle__outer {
    display: grid;
    place-items: center;
    width: 220px;
    height: 220px;
    border-radius: 50%;
    text-decoration: none;
    pointer-events: auto;
  }

  .nav-circle svg {
    width: 220px;
    height: 220px;
    overflow: visible;
  }

  .nav-circle__ring {
    fill: none;
    stroke: none;
  }

  /* In SVG user units (viewBox is 120 wide), not px — scales with the svg box. */
  .nav-circle__text {
    font-size: 15px;
    font-weight: 800;
    letter-spacing: 0.02em;
    fill: rgba(255, 255, 255, 0.65);
    pointer-events: none;
  }

  .nav-circle__text--active {
    fill: #fff;
  }

  .nav-circle__text .here {
    text-decoration: underline;
  }

  .nav-circle__text--link {
    pointer-events: auto;
  }

  .nav-circle__text--link a {
    fill: inherit;
    text-decoration: none;
  }

  .nav-circle__home {
    position: absolute;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    width: 60px;
    height: 60px;
    border-radius: 50%;
    border: 1.3px solid rgba(255, 255, 255, 0.4);
    background: transparent;
    color: rgba(255, 255, 255, 0.9);
    display: grid;
    place-items: center;
    font-size: 28px;
    line-height: 1;
    font-weight: 800;
    text-decoration: none;
    pointer-events: auto;
  }
</style>
