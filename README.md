# Two Sides of the Same Coin

A double-sided visualization with a dataset on each face: **Biomes**, the microbial species reconstructed from the human microbiome, and **Anthromes**, twelve thousand years of human land use across the planet. The disk turns between the two.

## Biomes

**5000 Lines 5000 Species**

This visualization shows an evolution of the extensive human microbiome. It reconstructs data from the Segata Lab: 9,316 sample collections spanning 46 datasets from multiple populations and an additional cohort from Madagascar. The scientists reconstructed a catalog that greatly expands the set of 150,000 microbial genomes publicly available.

Each line represents the evolutionary pathway of a Species Level Genetic Bin (SGB), a grouping that organizes genomes based on their similarity, allowing for broader identification of species, both previously known and unknown.

**Known / Unknown:** within this study, 77% of bacteria species visualized and analyzed were previously unknown.

**Westernized / Non-Westernized:** a key finding from these data is that the human microbiome is more diverse than previously understood, especially in indigenous anthromes, which has led to calls for their preservation (see back of coin).

### Citations

Pasolli, Edoardo, Francesco Asnicar, Serena Manara, Moreno Zolfo, Nicolai Karcher, Federica Armanini, Francesco Beghini, et al. 2019. "Extensive Unexplored Human Microbiome Diversity Revealed by Over 150,000 Genomes from Metagenomes Spanning Age, Geography, and Lifestyle." *Cell* 176(3): 649–662. [https://doi.org/10.1016/j.cell.2019.01.001](https://doi.org/10.1016/j.cell.2019.01.001)

## Anthromes

**More than 65% of terrestrial nature** has been shaped, in very different ways, by people. **Anthromes** are defined as the global ecological patterns shaped by direct human interactions with ecosystems.

Visualized here is the **Anthromes Dataset** from the Anthroecology Lab. It is a "hindcast" model, projecting back in time from global population and land use data showing change over 12,025 years.

As global population increases, and urbanization accelerates, **biodiversity shrinks.** Hence, preserving "cultured" and "wild" lands is key to preserving biodiversity.

### Citations

Ellis, E.C., N. Gauthier, K. Klein Goldewijk, R. Bliege Bird, N. Boivin, S. Díaz, D. Fuller, J. Gill, J. Kaplan, N. Kingston, H. Locke, C. McMichael, D. Ranco, T. Rick, M.R. Shaw, L. Stephens, J.C. Svenning, and J.E.M. Watson. 2021. "People have shaped most of terrestrial nature for at least 12,000 years." *Proceedings of the National Academy of Sciences* 118(17): e2023483118. [https://doi.org/10.1073/pnas.2023483118](https://doi.org/10.1073/pnas.2023483118)

Klein Goldewijk, K. 2025. History Database of the Global Environment (HYDE 3.5). Utrecht University. [https://public.yoda.uu.nl/geo/UU01/F45D44.html](https://public.yoda.uu.nl/geo/UU01/F45D44.html)

## Credits

This project was completed by Laura Kurgan, Dan Miller and Adam Vosburgh at The Center for Spatial Research, Columbia University Graduate School of Architecture Planning and Preservation. Two Sides of the Same Coin was originally commissioned for the We the Bacteria: Notes Toward Biotic Architecture exhibition, 24th Milan Triennale International Exhibition, Inequalities, 2025. This project is open-source, and the repository is located [here](https://github.com/CenterForSpatialResearch/twosides).

---

## Development

### Architecture

- **Framework**: Svelte 5 with Vite (multi-page)
- **Visualization**: D3.js for radial charts and maps
- **Structure**: Two independent SPAs (`src/biomes`, `src/anthromes`) with shared UI components
- **Data**: JSON in `public/data/` and TopoJSON tiles in `public/topojson/` (Git LFS)
- **Pipeline**: Data-processing scripts in `processing/` produce the JSON/TopoJSON inputs

### Repository Structure

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

### Commands

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

### Notes

- Run `npm run dev` and use the landing page (`/`) or go directly to `/src/biomes/` or `/src/anthromes/`
- Filter controls: Click/drag to select ranges, Shift+click to extend
- Year slider: Dual-thumb control filters by time period
