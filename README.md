# twosides

Interactive visualizations of biomes and anthromes data.

## Architecture

- **Framework**: Svelte 5 with Vite
- **Visualization**: D3.js for radial charts and (planned) map rendering
- **Structure**: Two independent SPAs (biomes, anthromes) with shared styling
- **Data**: JSON files in `public/data/` loaded at runtime

## Repository Structure

```
twosides/
├── public/
│   ├── data/              # JSON data files (biomes taxonomy, anthrome summaries)
│   └── index.html         # Landing page
├── src/
│   ├── biomes/            # Biomes visualization
│   │   ├── App.svelte     # Main component with filter UI
│   │   └── lib/           # BiomesChart, dataAdapter
│   ├── anthromes/         # Anthromes visualization
│   │   ├── App.svelte     # Main component with filter UI
│   │   └── lib/           # WaffleChart, dataAdapter
│   └── shared/            # Shared components
├── biomes.html            # Biomes entry point
├── anthromes.html         # Anthromes entry point
└── vite.config.js         # Multi-page build config
```

## Commands

```bash
# Install dependencies
npm install

# Development server (http://localhost:5173)
npm run dev

# Production build (outputs to dist/)
npm run build

# Preview production build
npm run preview
```

## Development

- Navigate to `/biomes.html` or `/anthromes.html` in dev mode
- Filter controls: Click/drag to select ranges, Shift+click to extend
- Year slider: Dual-thumb control filters by time period
