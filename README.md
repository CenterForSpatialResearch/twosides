# twosides

Interactive visualizations of biomes and anthromes data.

## Development Environment

This project is developed on Windows using PowerShell. All command examples use PowerShell syntax unless otherwise noted. Bash alternatives are provided where applicable.

## Architecture

- **Framework**: Svelte 5 with Vite (multi-page)
- **Visualization**: D3.js for radial charts and maps
- **Structure**: Two independent SPAs (`src/biomes`, `src/anthromes`) with shared UI components
- **Data**: JSON in `public/data/` and TopoJSON tiles in `public/topojson/` (Git LFS)
- **Pipeline**: Data-processing scripts in `processing/` produce the JSON/TopoJSON inputs

## Repository Structure

```
twosides/
├── public/
│   ├── data/              # JSON data files (biomes taxonomy, anthrome summaries)
│   ├── topojson/          # Map tiles (tracked via Git LFS)
│   ├── fonts/             # Web fonts
│   └── index.html         # Landing page
├── src/
│   ├── biomes/            # Biomes visualization
│   │   ├── App.svelte     # Main component with filter UI
│   │   └── lib/           # BiomesChart, dataAdapter
│   ├── anthromes/         # Anthromes visualization
│   │   ├── App.svelte     # Main component with filter UI
│   │   └── lib/           # WaffleChart, dataAdapter
│   └── shared/            # Shared components
├── processing/            # Data pipeline for GeoTIFF → GeoJSON/TopoJSON
├── archive/               # Legacy assets and prototypes (includes old biomes/anthromes D3 pages)
└── vite.config.js         # Multi-page build config
```

## Commands

```powershell
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

- Run `npm run dev` and use the landing page (`/`) or go directly to `/src/biomes/` or `/src/anthromes/`
- Filter controls: Click/drag to select ranges, Shift+click to extend
- Year slider: Dual-thumb control filters by time period
