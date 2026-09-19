<script>
  import { onMount } from 'svelte';
  import { DESIGN_W, DESIGN_H } from './stage.svelte.js';

  // Props
  let {
    visible = $bindable(false),
    x = $bindable(0),
    y = $bindable(0),
    content = '',
    pinned = $bindable(false),
    onClose = () => {},
    onAction = null
  } = $props();

  // Refs
  let tooltipEl = $state(null);

  // Computed position with auto-adjustment
  let finalX = $state(0);
  let finalY = $state(0);

  // Reposition whenever x, y, or visibility changes
  $effect(() => {
    if (!visible || !tooltipEl) return;

    const pad = 14;
    // Layout px — getBoundingClientRect() would report the stage-scaled box.
    const tw = tooltipEl.offsetWidth;
    const th = tooltipEl.offsetHeight;

    // Start with cursor position
    let nx = x + pad;
    let ny = y - pad - th;

    // If tooltip would go above viewport, position below cursor
    if (ny < 8) {
      ny = y + pad;
    }

    // Keep within the design canvas — x/y are design px, and the tooltip is
    // rendered inside .stage, so window dimensions are the wrong bounds here.
    nx = Math.min(Math.max(8, nx), DESIGN_W - tw - 8);
    ny = Math.min(Math.max(8, ny), DESIGN_H - th - 8);

    finalX = nx;
    finalY = ny;
  });

  // Handle escape key
  function handleKeydown(e) {
    if (e.key === 'Escape' && visible) {
      visible = false;
      pinned = false;
      onClose();
    }
  }

  // Track when pinned was set to avoid immediate close
  let pinnedTimestamp = $state(0);

  // Update timestamp when pinned changes
  $effect(() => {
    if (pinned) {
      pinnedTimestamp = Date.now();
    }
  });

  // Click away handler
  function handleClickOutside(e) {
    // Don't close if pinned within last 100ms (prevents immediate close on pin-click)
    if (tooltipEl && !tooltipEl.contains(e.target) && visible && pinned) {
      if (Date.now() - pinnedTimestamp > 100) {
        visible = false;
        pinned = false;
        onClose();
      }
    }
  }

  onMount(() => {
    document.addEventListener('keydown', handleKeydown);
    // Use capture phase to ensure we can check timing
    document.addEventListener('click', handleClickOutside, true);

    return () => {
      document.removeEventListener('keydown', handleKeydown);
      document.removeEventListener('click', handleClickOutside, true);
    };
  });
</script>

{#if visible}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    bind:this={tooltipEl}
    class="tooltip"
    class:pinned
    style="left: {finalX}px; top: {finalY}px;"
    role="dialog"
    aria-live="polite"
    onclick={onAction}
  >
    {@html content}
  </div>
{/if}

<style>
  .tooltip {
    position: absolute;
    pointer-events: none;
    z-index: 100000;
    background: #111827;
    color: #f9fafb;
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: 12px;
    box-shadow: 0 10px 30px rgba(0, 0, 0, 0.35);
    max-width: 380px;
    min-width: 240px;
    padding: 12px 14px;
    line-height: 1.45;
  }

  .tooltip.pinned {
    pointer-events: auto;
  }

  /* Tooltip content styles */
  :global(.tooltip .title) {
    font-size: 16px;
    font-weight: 700;
    margin-bottom: 4px;
  }

  :global(.tooltip .subtitle) {
    font-size: 12px;
    color: #cbd5e1;
    margin-bottom: 8px;
  }

  :global(.tooltip .summary b) {
    font-weight: 700;
  }

  :global(.tooltip .kv) {
    display: grid;
    grid-template-columns: 1fr auto;
    gap: 6px 10px;
    margin-top: 10px;
    font-size: 12px;
    border-top: 1px dashed rgba(255, 255, 255, 0.14);
    padding-top: 8px;
  }

  :global(.tooltip .kv .k) {
    color: #94a3b8;
  }

  :global(.tooltip .tip-head) {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 8px;
  }

  :global(.tooltip .chip) {
    width: 14px;
    height: 14px;
    border-radius: 4px;
    border: 1px solid rgba(255, 255, 255, 0.35);
    flex: 0 0 auto;
  }

  :global(.tooltip .glyph) {
    margin-top: 10px;
    padding: 8px;
    border-radius: 10px;
    background: rgba(255, 255, 255, 0.04);
    border: 1px solid rgba(255, 255, 255, 0.12);
  }

  :global(.tooltip .glyph .cap) {
    display: flex;
    align-items: center;
    justify-content: space-between;
    font-size: 11px;
    color: #cbd5e1;
    margin-bottom: 6px;
  }

  :global(.tooltip .actions) {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin-top: 10px;
    padding-top: 8px;
    border-top: 1px dashed rgba(255, 255, 255, 0.14);
  }

  :global(.tooltip .actions button) {
    pointer-events: auto;
    background: rgba(255, 255, 255, 0.08);
    border: 1px solid rgba(255, 255, 255, 0.16);
    color: #f9fafb;
    border-radius: 8px;
    padding: 7px 10px;
    font-size: 12px;
    cursor: pointer;
    text-align: left;
    transition: background 0.15s ease, border-color 0.15s ease;
  }

  :global(.tooltip .actions button:hover) {
    background: rgba(255, 255, 255, 0.12);
    border-color: rgba(255, 255, 255, 0.25);
  }
</style>
