<script>
  // Dev-branch tooling. Always on, deliberately NOT styled to match the piece —
  // it should read as an engineering overlay, not part of the work.
  //
  // Mount inside .viewport but OUTSIDE .stage so it never gets scaled.
  import { onMount } from 'svelte';
  import { DESIGN_W, DESIGN_H, stageScale, getStageEl, screenToDesign } from './stage.svelte.js';
  import { uiOption, cycleUiOption, uiOptionLabel, UI_OPTION_COUNT } from './uiOption.svelte.js';
  import { topoProfile, cycleTopoProfile, DEFAULT_TOPO_PROFILE, hasProfileInfo, profileSizes } from './topoProfile.svelte.js';

  // Only the anthromes side has a map, so only it opts into the resolution
  // toggle. Biomes leaves it off.
  let { showMapResolution = false } = $props();

  const LENS_W = 420;
  const LENS_H = 280;
  const CLONE_INTERVAL = 150;  // ms; cloning the stage is not cheap, so throttle it

  let vw = $state(0);
  let vh = $state(0);
  let dpr = $state(1);

  let lensOn = $state(false);
  let collapsed = $state(false);
  let lensHostEl = $state(null);
  let cursor = $state({ x: 0, y: 0, seen: false });

  const scale = $derived(stageScale());
  const pct = $derived(Math.round(scale * 100));
  // Magnification the lens gives relative to the current on-screen view.
  const lensZoom = $derived(scale > 0 ? Math.round(100 / scale) : 100);
  // Design-space point under the cursor; the lens centers on this.
  const designPt = $derived(screenToDesign(cursor.x, cursor.y));

  // Centered on the cursor (the lens has pointer-events:none, so it can sit over
  // the pointer), clamped into the viewport so it stays fully readable at edges.
  const lensLeft = $derived(
    Math.max(8, Math.min(cursor.x - LENS_W / 2, vw - LENS_W - 8))
  );
  const lensTop = $derived(
    Math.max(8, Math.min(cursor.y - LENS_H / 2, vh - LENS_H - 8))
  );

  function readViewport() {
    vw = window.innerWidth;
    vh = window.innerHeight;
    dpr = window.devicePixelRatio || 1;
  }

  function onPointerMove(e) {
    cursor = { x: e.clientX, y: e.clientY, seen: true };
  }

  onMount(() => {
    readViewport();
    window.addEventListener('resize', readViewport);
    window.addEventListener('pointermove', onPointerMove, { passive: true });
    return () => {
      window.removeEventListener('resize', readViewport);
      window.removeEventListener('pointermove', onPointerMove);
    };
  });

  // Pure blue in the letterbox bars whenever we are not on the target display.
  // At exactly 3:2 there are no bars, so this never shows on the Surface.
  $effect(() => {
    document.documentElement.style.setProperty(
      '--letterbox-bg',
      scale < 0.9999 ? '#0000FF' : 'var(--bg)'
    );
  });

  /**
   * Rebuild the lens contents from a live clone of the stage.
   *
   * cloneNode does NOT copy canvas bitmaps — a naive clone leaves the map and
   * waffle blank — so every canvas is repainted from its live source. The
   * backing stores are already at layoutWidth * dpr, i.e. more detail than the
   * scaled-down view shows, so this is a true 1:1 read with no re-render.
   *
   * Known dev-tool limitation: the clone duplicates element ids, so SVG url(#id)
   * and href="#id" references inside it resolve against the original stage. That
   * is visually identical here because the originals are still present.
   */
  function rebuildClone() {
    const stage = getStageEl();
    if (!stage || !lensHostEl) return;

    const clone = stage.cloneNode(true);
    // Drop the .stage class so the clone can't be picked up by `.stage` lookups
    // elsewhere, and restate what that class provided. Rendered at scale(1) —
    // true target pixels are the whole point.
    clone.classList.remove('stage');
    clone.style.cssText =
      `position:absolute; top:0; left:0; width:${DESIGN_W}px; height:${DESIGN_H}px;` +
      'background:var(--bg); overflow:hidden; transform:none; margin:0;';

    const src = stage.querySelectorAll('canvas');
    const dst = clone.querySelectorAll('canvas');
    for (let i = 0; i < src.length && i < dst.length; i++) {
      const s = src[i];
      const d = dst[i];
      if (!s.width || !s.height) continue;
      d.width = s.width;
      d.height = s.height;
      try {
        d.getContext('2d')?.drawImage(s, 0, 0);
      } catch {
        // Non-2d or tainted canvas — leave it blank rather than break the HUD.
      }
    }

    lensHostEl.replaceChildren(clone);
  }

  // Content is refreshed on a timer; the lens itself follows the cursor every
  // frame via a transform, so motion stays smooth even though the clone lags.
  $effect(() => {
    if (!lensOn || !lensHostEl) return;
    rebuildClone();
    const id = setInterval(rebuildClone, CLONE_INTERVAL);
    return () => clearInterval(id);
  });
</script>

<div class="hud" class:collapsed>
  <button
    class="hud-collapse"
    title={collapsed ? 'Expand dev HUD' : 'Collapse dev HUD'}
    aria-label={collapsed ? 'Expand dev HUD' : 'Collapse dev HUD'}
    onclick={() => (collapsed = !collapsed)}
  >{collapsed ? '▶' : '◀'}</button>
  {#if !collapsed}
    <div class="hud-body">
      <div class="hud-row">UI SCALE: {pct}%&nbsp;&nbsp;(of target)</div>
      <div class="hud-row">VIEWPORT: {vw} &times; {vh}</div>
      <div class="hud-row">TARGET:&nbsp;&nbsp; {DESIGN_W} &times; {DESIGN_H}</div>
      <div class="hud-row">DPR:&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; {dpr.toFixed(2)}</div>
      <button class="hud-btn" class:on={lensOn} onclick={() => (lensOn = !lensOn)}>
        {lensOn ? '■' : '□'} 1:1 LENS
      </button>
      <button
        class="hud-btn"
        class:on={uiOption() !== 1}
        onclick={cycleUiOption}
      >
        UI OPTION: {uiOption()}/{UI_OPTION_COUNT} &middot; {uiOptionLabel()}
      </button>
      {#if showMapResolution}
        <button
          class="hud-btn"
          class:on={topoProfile() !== DEFAULT_TOPO_PROFILE}
          title={hasProfileInfo(topoProfile())
            ? `${profileSizes(topoProfile())}, fetched once`
            : 'Map tile resolution'}
          onclick={cycleTopoProfile}
        >
          MAP RES: {topoProfile()}
        </button>
      {/if}
    </div>
  {/if}
</div>

{#if lensOn && cursor.seen}
  <div class="lens" style="left:{lensLeft}px; top:{lensTop}px; width:{LENS_W}px; height:{LENS_H}px;">
    <div class="lens-clip">
      <div
        class="lens-host"
        bind:this={lensHostEl}
        style="width:{DESIGN_W}px; height:{DESIGN_H}px;
               transform: translate({LENS_W / 2 - designPt.x}px, {LENS_H / 2 - designPt.y}px);"
      ></div>
    </div>
    <div class="lens-label">1:1 TARGET ({lensZoom}%)</div>
  </div>
{/if}

<style>
  .hud {
    position: fixed;
    left: 0;
    bottom: 0;
    z-index: 100000;
    display: flex;
    align-items: stretch;
    gap: 6px;
    background: #000;
    color: #fff;
    border: 1px solid #0000ff;
    padding: 6px 8px;
    font-family: ui-monospace, monospace;
    font-size: 11px;
    line-height: 1.45;
    white-space: pre;
    user-select: none;
  }

  .hud.collapsed {
    padding: 4px 5px;
  }

  /* Left-edge collapse arrow */
  .hud-collapse {
    flex: 0 0 auto;
    align-self: stretch;
    background: transparent;
    color: #fff;
    border: none;
    border-right: 1px solid #0000ff;
    padding: 0 6px 0 2px;
    font-family: ui-monospace, monospace;
    font-size: 11px;
    cursor: pointer;
  }

  .hud.collapsed .hud-collapse {
    border-right: none;
    padding: 0 2px;
  }

  .hud-body {
    display: flex;
    flex-direction: column;
  }

  .hud-row {
    letter-spacing: 0.02em;
  }

  .hud-btn {
    display: block;
    width: 100%;
    margin-top: 5px;
    padding: 3px 6px;
    background: #000;
    color: #fff;
    border: 1px solid #fff;
    border-radius: 0;
    font-family: ui-monospace, monospace;
    font-size: 11px;
    text-align: left;
    cursor: pointer;
  }

  .hud-btn.on {
    background: #0000ff;
  }

  .lens {
    position: fixed;
    z-index: 99999;
    border: 1px solid #0000ff;
    background: #000;
    pointer-events: none;
  }

  .lens-clip {
    position: absolute;
    inset: 0;
    overflow: hidden;
  }

  .lens-host {
    position: absolute;
    top: 0;
    left: 0;
    transform-origin: 0 0;
  }

  .lens-label {
    position: absolute;
    left: 0;
    bottom: 0;
    background: #0000ff;
    color: #fff;
    padding: 1px 5px;
    font-family: ui-monospace, monospace;
    font-size: 10px;
    letter-spacing: 0.04em;
  }
</style>
