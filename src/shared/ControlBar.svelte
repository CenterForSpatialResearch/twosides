<script>
  // The control circles (Info, Zoom Out, Reset, Zoom In). Two forms:
  //
  //   variant="arc"   the rail's top tier: a row of large circles, each with an
  //                   arced caption hung off one side. Both rails use it; they
  //                   differ only in the order of the buttons and in which side
  //                   the captions hang from, so both are props.
  //   variant="flat"  the stacked (phone) layout's top bar, above the disk:
  //                   smaller circles, each with an upright caption set
  //                   vertically beside it — no textPath — and led by a Back
  //                   link (backHref), which stands in for the nav coin there.
  //
  // items: [{ id, label, caption, glyph, onclick, active, disabled }]
  //   label    title + aria-label ("Zoom out")
  //   caption  the caption text, if it differs from the label ("Zoom Out")
  //   disabled leave undefined on a button that is never disabled
  //
  // The arc row's padding-bottom is one of the rails' deliberate asymmetries
  // (see the rail rhythm note in each App): set --ctl-pad-bottom on the rail.
  import ArcLabel from './ArcLabel.svelte';

  let {
    variant = 'arc',
    side = 'right',      // which side the captions hang from: 'right' (biomes) | 'left' (anthromes)
    items = [],
    backHref = null,     // flat only: where Back goes
    size = 118,          // button diameter, design px — the rail tier's `ctl`
    captionSize = 19     // caption type size — the rail tier's `caption`
  } = $props();
</script>

<div
  class="control-circles"
  class:control-circles--flat={variant === 'flat'}
  data-side={side}
  style={`--ctl-size:${size}px; --ctl-caption:${captionSize}px`}
>
  {#if variant === 'flat' && backHref}
    <div class="ctl-slot">
      <a class="ctl-btn" href={backHref} title="Back" aria-label="Back to home">←</a>
      <span class="ctl-caption" aria-hidden="true">Back</span>
    </div>
  {/if}
  {#each items as item (item.id)}
    <div class="ctl-slot">
      <button
        class="ctl-btn"
        class:active={item.active}
        title={item.label}
        aria-label={item.label}
        onclick={item.onclick}
        disabled={item.disabled}
        aria-disabled={item.disabled}
      >{item.glyph}</button>
      {#if variant === 'flat'}
        <span class="ctl-caption" aria-hidden="true">{item.caption ?? item.label}</span>
      {:else}
        <ArcLabel text={item.caption ?? item.label} {side} diameter={size} fontSize={captionSize} />
      {/if}
    </div>
  {/each}
</div>

<style>
  /* The row spans the rail's full content width, evenly distributed, so the
     controls read as one measure with the menu items below them. */
  .control-circles {
    flex: 0 0 auto;
    display: flex;
    flex-wrap: nowrap;
    gap: 0;
    align-items: center;
    justify-content: space-between;
    padding-bottom: var(--ctl-pad-bottom, 4px);
  }

  /* Positioning context for ArcLabel, which paints centred on the button and
     overflows it. */
  .ctl-slot {
    position: relative;
    flex: 0 0 auto;
    display: grid;
    place-items: center;
  }

  /* 118px on the display this was drawn for: the largest of the rail's circle
     tiers. The diameter comes from the `size` prop, which ArcLabel is handed
     too, so the caption's arc always hugs the button. The glyph and the ring
     are fractions of it, so they step down with it (44px and 3.8px at 118). */
  .ctl-btn {
    width: var(--ctl-size);
    height: var(--ctl-size);
    border-radius: 50%;
    background: var(--bg);
    border: calc(var(--ctl-size) * 3.8 / 118) solid rgba(255, 255, 255, 0.85);
    color: var(--fg);
    font-weight: 500;
    font-size: calc(var(--ctl-size) * 44 / 118);
    cursor: pointer;
    display: grid;
    place-items: center;
    box-shadow: var(--shadow);
  }

  .ctl-btn.active {
    background: #fff;
    color: var(--bg);
    border-color: #fff;
  }

  .ctl-btn:active {
    transform: scale(0.95);
  }

  /* Mouseover, the rail's one treatment: the ring goes to full white, as
     .country-circle:hover .ring does, over a slight lift of the fill. Behind
     (hover: hover) so a tap on a touchscreen never leaves a button wearing it.
     The pressed and .active looks are untouched. */
  @media (hover: hover) {
    .ctl-btn {
      transition: border-color 0.18s ease, background-color 0.18s ease;
    }

    .ctl-btn:hover:not(.active) {
      border-color: #fff;
      background: color-mix(in srgb, var(--bg), #fff 12%);
    }
  }

  /* Flat: the stacked layout's top bar. The slot is circle + caption side by
     side; the caption is set vertically so five of them fit a phone's width,
     reading down on the right of its circle and up on the left, the way the
     arced captions face. */
  .control-circles--flat {
    padding: 0;
  }

  .control-circles--flat .ctl-slot {
    display: flex;
    align-items: center;
    gap: 5px;
  }

  .control-circles--flat[data-side="left"] .ctl-slot {
    flex-direction: row-reverse;
  }

  .control-circles--flat .ctl-btn {
    text-decoration: none;
    line-height: 1;
  }

  .ctl-caption {
    writing-mode: vertical-rl;
    font-size: var(--ctl-caption);
    font-weight: 500;
    line-height: 1;
    letter-spacing: 0.04em;
    white-space: nowrap;
    color: var(--fg);
    user-select: none;
  }

  .control-circles--flat[data-side="left"] .ctl-caption {
    transform: rotate(180deg);
  }

  .ctl-btn:disabled,
  .ctl-btn[aria-disabled="true"] {
    opacity: 0.35;
    cursor: not-allowed;
    pointer-events: none;
    filter: grayscale(0.3);
  }
</style>
