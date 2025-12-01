<script>
  import Tooltip from '../Tooltip.svelte';

  let tooltipVisible = $state(false);
  let tooltipX = $state(0);
  let tooltipY = $state(0);
  let tooltipPinned = $state(false);

  const tooltipContent = `
    <div class="tip-head">
      <span class="chip" style="background: #5f0f40;"></span>
      <div>
        <div class="title">Urban</div>
        <div class="subtitle">Year 2020CE</div>
      </div>
    </div>
    <div class="summary">In <b>2020CE</b>, <b>Urban</b> accounts for <b>1,234,567</b> units (<b>12.3%</b> of the year's total).</div>
    <div class="kv">
      <div class="k">Year total</div><div>10,000,000</div>
      <div class="k">Segment value</div><div>1,234,567</div>
      <div class="k">Share</div><div>12.3%</div>
    </div>
  `;

  function handleMouseMove(e) {
    tooltipX = e.clientX;
    tooltipY = e.clientY;
    if (!tooltipPinned) {
      tooltipVisible = true;
    }
  }

  function handleMouseLeave() {
    if (!tooltipPinned) {
      tooltipVisible = false;
    }
  }

  function handleClick(e) {
    tooltipX = e.clientX;
    tooltipY = e.clientY;
    tooltipPinned = !tooltipPinned;
    tooltipVisible = tooltipPinned;
  }
</script>

<main>
  <h1>Tooltip Component Test</h1>

  <div class="test-area">
    <p>Hover over or click the boxes below to test the tooltip:</p>

    <div class="grid">
      <button
        class="test-box urban"
        onmousemove={handleMouseMove}
        onmouseleave={handleMouseLeave}
        onclick={handleClick}
      >
        Urban<br />
        <small>Hover or click</small>
      </button>

      <button
        class="test-box rural"
        onmousemove={handleMouseMove}
        onmouseleave={handleMouseLeave}
        onclick={handleClick}
      >
        Rural<br />
        <small>Hover or click</small>
      </button>

      <button
        class="test-box wild"
        onmousemove={handleMouseMove}
        onmouseleave={handleMouseLeave}
        onclick={handleClick}
      >
        Wild<br />
        <small>Hover or click</small>
      </button>
    </div>

    <p class="instructions">
      <strong>Instructions:</strong><br />
      • Hover over boxes to show tooltip<br />
      • Click to pin/unpin tooltip<br />
      • Press Escape to close pinned tooltip<br />
      • Click outside to close pinned tooltip
    </p>
  </div>

  <Tooltip
    bind:visible={tooltipVisible}
    bind:x={tooltipX}
    bind:y={tooltipY}
    bind:pinned={tooltipPinned}
    content={tooltipContent}
  />
</main>

<style>
  main {
    padding: 40px;
    max-width: 900px;
    margin: 0 auto;
  }

  h1 {
    margin-bottom: 2rem;
    color: var(--fg);
  }

  .test-area {
    background: var(--panel);
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: 14px;
    padding: 30px;
  }

  .test-area p {
    margin-bottom: 20px;
    color: var(--muted);
  }

  .grid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 20px;
    margin: 20px 0;
  }

  .test-box {
    padding: 40px 20px;
    border-radius: 12px;
    border: 2px solid rgba(255, 255, 255, 0.2);
    cursor: pointer;
    transition: transform 0.2s ease, border-color 0.2s ease;
    font-size: 18px;
    font-weight: 600;
    color: white;
  }

  .test-box:hover {
    transform: translateY(-4px);
    border-color: rgba(255, 255, 255, 0.4);
  }

  .test-box small {
    font-size: 12px;
    font-weight: 400;
    opacity: 0.7;
  }

  .urban {
    background: #5f0f40;
  }

  .rural {
    background: #75c07a;
  }

  .wild {
    background: #66cff2;
  }

  .instructions {
    margin-top: 30px;
    padding: 15px;
    background: rgba(255, 255, 255, 0.04);
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 10px;
    font-size: 14px;
    line-height: 1.6;
  }
</style>
