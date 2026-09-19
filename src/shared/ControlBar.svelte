<script>
  // The rail's top tier: the row of large control circles (Info, Zoom Out,
  // Reset, Zoom In), each with an arced caption hung off one side. Both rails
  // use it; they differ only in the order of the buttons and in which side the
  // captions hang from, so both are props.
  //
  // items: [{ id, label, caption, glyph, onclick, active, disabled }]
  //   label    title + aria-label ("Zoom out")
  //   caption  the arced text, if it differs from the label ("Zoom Out")
  //   disabled leave undefined on a button that is never disabled
  //
  // The row's padding-bottom is one of the rails' deliberate asymmetries (see
  // the rail rhythm note in each App): set --ctl-pad-bottom on the rail.
  import ArcLabel from './ArcLabel.svelte';

  let {
    side = 'right',      // which side the captions hang from: 'right' (biomes) | 'left' (anthromes)
    items = [],
    size = 118,          // button diameter, design px — the rail tier's `ctl`
    captionSize = 19     // arced caption type size — the rail tier's `caption`
  } = $props();
</script>

<div class="control-circles" style={`--ctl-size:${size}px`}>
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
      <ArcLabel text={item.caption ?? item.label} {side} diameter={size} fontSize={captionSize} />
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

  .ctl-btn:disabled,
  .ctl-btn[aria-disabled="true"] {
    opacity: 0.35;
    cursor: not-allowed;
    pointer-events: none;
    filter: grayscale(0.3);
  }
</style>
