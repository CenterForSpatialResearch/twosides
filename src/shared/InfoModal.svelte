<script>
  // The info modal both sides open from their Info control: a titled card
  // centred on the stage, with a close button, body copy and a citations
  // block. The copy is the caller's; this owns the frame and the typography.
  //
  //   title      the side's name, set in caps in the head
  //   onclose    called by the close button
  //   children   the body paragraphs
  //   citations  optional: the paragraphs under the "Citations" rule
  //
  // The paragraphs arrive as snippets, so they carry the caller's style scope
  // rather than this one — hence the :global() on everything inside .info-body.
  let { title, onclose, children, citations } = $props();
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="info-modal" aria-live="polite" onclick={(e) => e.stopPropagation()}>
  <div class="overlay-head">
    <div class="overlay-title">{title}</div>
    <button class="chevron" onclick={onclose} aria-label="Close">✕</button>
  </div>
  <div class="info-body">
    {@render children?.()}
    {#if citations}
      <div class="info-citations">
        <div class="info-citations-title">Citations</div>
        {@render citations()}
      </div>
    {/if}
  </div>
</div>

<style>
  /* Centred on the window (longer read). Percentages resolve against the
     positioned ancestor: the overlay stage (src/shared/stage.css), which is
     the window in design px. */
  .info-modal {
    position: absolute;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    width: 960px;             /* a comfortable measure at 17px, ~75 chars */
    max-width: calc(100% - 123px);
    max-height: 84%;
    display: flex;
    flex-direction: column;
    background: var(--bg);
    border: 3.8px solid rgba(255, 255, 255, 0.85);
    border-radius: 33px;
    padding: 33px 38px;
    box-shadow: var(--shadow);
    z-index: 20;
    pointer-events: auto;
    transform-origin: center center;
    animation: modal-pop-center 0.18s ease;
  }

  /* Stacked (phone): the card takes nearly the whole screen, with less of it
     spent on its own frame. */
  :global(html[data-layout="stacked"]) .info-modal {
    max-width: calc(100% - 44px);
    max-height: 90%;
    padding: 26px 28px;
    border-radius: 26px;
  }

  @keyframes modal-pop-center {
    from { transform: translate(-50%, -50%) scale(0.85); opacity: 0; }
    to   { transform: translate(-50%, -50%) scale(1); opacity: 1; }
  }

  .overlay-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    margin-bottom: 13px;
  }

  .overlay-title {
    font-size: 23px;
    font-weight: 700;
    letter-spacing: 0.04em;
  }

  .chevron {
    flex: none;
    border: 2.6px solid rgba(255, 255, 255, 0.85);
    background: var(--bg);
    color: var(--fg);
    width: 38px;
    height: 38px;
    border-radius: 50%;
    cursor: pointer;
    display: grid;
    place-items: center;
    font-size: 17px;
    font-weight: 500;
  }

  /* Mouseover: same treatment as the control circles (ControlBar.svelte). */
  @media (hover: hover) {
    .chevron {
      transition: border-color 0.18s ease, background-color 0.18s ease;
    }

    .chevron:hover {
      border-color: #fff;
      background: color-mix(in srgb, var(--bg), #fff 12%);
    }
  }

  /* The body scrolls under a fixed head when the text outgrows the box. */
  .info-body {
    flex: 1 1 auto;
    min-height: 0;
    overflow: auto;
    /* Stacked, the page behind the card scrolls too; the end of this list
       should not hand the gesture on to it. */
    overscroll-behavior: contain;
    display: grid;
    align-content: start;
    gap: 13px;
    font-size: 17px;
    line-height: 1.55;
    color: var(--muted);
  }

  .info-body :global(p) {
    margin: 0;
  }

  .info-body :global(p + p) {
    padding-top: 7.7px;
  }

  .info-body :global(strong) {
    color: #fff;
    letter-spacing: 0.02em;
  }

  .info-body :global(em) {
    color: #e7e9f1;
  }

  .info-citations {
    margin-top: 18px;
    padding-top: 13px;
    border-top: 1.3px solid rgba(255, 255, 255, 0.08);
  }

  .info-citations-title {
    font-size: 12px;
    font-weight: 400;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--muted);
    margin-bottom: 7.7px;
  }

  .info-citations :global(p) {
    font-size: 14px;
    color: var(--muted);
    line-height: 1.5;
    margin: 0 0 10px;
  }

  .info-citations :global(p:last-child) {
    margin-bottom: 0;
  }

  .info-citations :global(a) {
    color: var(--accent, #7dd3fc);
    text-decoration: none;
  }

  .info-citations :global(a:hover) {
    text-decoration: underline;
  }
</style>
