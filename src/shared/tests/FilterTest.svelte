<script>
  import FilterWidget from '../FilterWidget.svelte';

  // Mock anthrome data
  const anthromes = [
    { id: 11, label: 'Urban', color: '#5f0f40' },
    { id: 12, label: 'Dense settlements', color: '#884255' },
    { id: 21, label: 'Village, Rice', color: '#df6473' },
    { id: 22, label: 'Village, Irrigated', color: '#f99270' },
    { id: 23, label: 'Village, Rainfed', color: '#ffb46b' },
    { id: 24, label: 'Village, Pastoral', color: '#ffd46a' },
    { id: 31, label: 'Croplands, residential irrigated', color: '#75c07a' },
    { id: 32, label: 'Croplands, residential rainfed', color: '#93d697' },
    { id: 33, label: 'Croplands, populated', color: '#aee9b1' },
    { id: 41, label: 'Rangeland, residential', color: '#e9f9cd' },
    { id: 42, label: 'Rangeland, populated', color: '#ffffcc' },
    { id: 51, label: 'Semi-natural woodlands, residential', color: '#daf3fc' },
    { id: 52, label: 'Semi-natural woodlands, populated', color: '#bdeafa' },
    { id: 53, label: 'Semi-natural woodlands, remote', color: '#a0e1f7' },
    { id: 61, label: 'Wild, remote - woodlands', color: '#66cff2' },
    { id: 63, label: 'Wild, remote - ice', color: '#2cbded' }
  ];

  let selectedAnthromes = $state(anthromes.map(a => a.id));

  let yearRange = $state({
    min: 0,
    max: 100,
    value: [20, 80],
    years: Array.from({ length: 101 }, (_, i) => i)
  });

  function handleSelectAll() {
    selectedAnthromes = anthromes.map(a => a.id);
    console.log('Select All clicked');
  }

  function handleClear() {
    selectedAnthromes = [];
    console.log('Clear clicked');
  }

  $effect(() => {
    console.log('Selected anthromes:', selectedAnthromes);
    console.log('Year range:', yearRange.value);
  });
</script>

<main>
  <h1>FilterWidget Component Test</h1>

  <div class="test-area">
    <h2>Filter Widget (Bottom-Left)</h2>
    <p>Click the expand button to open the filter widget and test its features:</p>

    <ul>
      <li>✓ Expand/collapse animation</li>
      <li>✓ Anthrome selection (click items to toggle)</li>
      <li>✓ Year range slider (dual-thumb)</li>
      <li>✓ Select All / Clear buttons</li>
      <li>✓ Press Escape to close</li>
      <li>✓ Click outside to close</li>
    </ul>

    <div class="status">
      <h3>Current State:</h3>
      <p><strong>Selected anthromes:</strong> {selectedAnthromes.length} / {anthromes.length}</p>
      <p><strong>Year range:</strong> {yearRange.value[0]} - {yearRange.value[1]}</p>
      <div class="selected-colors">
        {#each anthromes.filter(a => selectedAnthromes.includes(a.id)) as anthrome}
          <span
            class="color-chip"
            style="background: {anthrome.color};"
            title={anthrome.label}
          ></span>
        {/each}
      </div>
    </div>
  </div>

  <FilterWidget
    position="bottom-left"
    items={anthromes}
    bind:selectedItems={selectedAnthromes}
    bind:yearRange
    onSelectAll={handleSelectAll}
    onClear={handleClear}
    compact={false}
  />
</main>

<style>
  main {
    padding: 40px;
    max-width: 900px;
    margin: 0 auto;
    position: relative;
    min-height: 100vh;
  }

  h1 {
    margin-bottom: 2rem;
    color: var(--fg);
  }

  h2 {
    margin-bottom: 1rem;
    color: var(--fg);
    font-size: 1.5rem;
  }

  h3 {
    margin-bottom: 0.5rem;
    color: var(--accent);
    font-size: 1.2rem;
  }

  .test-area {
    background: var(--panel);
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: 14px;
    padding: 30px;
    margin-bottom: 100px;
  }

  .test-area p {
    margin-bottom: 15px;
    color: var(--muted);
    line-height: 1.6;
  }

  .test-area ul {
    list-style: none;
    padding: 0;
    margin: 20px 0;
  }

  .test-area li {
    padding: 8px 0;
    color: var(--muted);
    font-size: 14px;
  }

  .status {
    margin-top: 30px;
    padding: 20px;
    background: rgba(255, 255, 255, 0.04);
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 10px;
  }

  .status p {
    margin: 8px 0;
    color: var(--fg);
    font-size: 14px;
  }

  .selected-colors {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-top: 15px;
  }

  .color-chip {
    width: 24px;
    height: 24px;
    border-radius: 6px;
    border: 1px solid rgba(255, 255, 255, 0.25);
    display: inline-block;
  }
</style>
