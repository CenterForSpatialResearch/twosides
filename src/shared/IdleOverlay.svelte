<script>
  // The last-chance notice before the idle watch navigates home. Any input
  // cancels it — see initIdleReset, which owns the timers and toggles `show`.
  //
  // Absolutely positioned, never fixed: it lives inside .stage, which is a
  // scaled transform, and position:fixed inside a transformed ancestor anchors
  // to that ancestor anyway — but at unscaled px, so the type would come out
  // the wrong size. See the note in shared/styles.css.
  let { show = false } = $props();
</script>

<div class="idle-overlay" class:on={show} aria-live="polite" aria-hidden={!show}>
  <p class="idle-text">Returning to the start</p>
</div>

<style>
  .idle-overlay {
    position: absolute;
    inset: 0;
    z-index: 9000;
    display: grid;
    place-items: center;
    background: rgba(14, 11, 22, 0.82);
    opacity: 0;
    pointer-events: none;
    /* Matches WARN_MS so the fade completes exactly as the page turns over. */
    transition: opacity 3s linear;
  }

  .idle-overlay.on {
    opacity: 1;
  }

  .idle-text {
    margin: 0;
    font-size: 54px;
    font-weight: 600;
    letter-spacing: 0.01em;
    color: var(--fg);
  }
</style>
