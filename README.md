# twosides

Production release for the interactive portion of *Two Sides of the Same Coin*, a double-sided visualization featuring a dataset on each side — anthromes and biomes. It was built for *Full Disclosure: The Edge of Information Design* at the Museum of Modern Art, opening September 27, 2026.

This production build (twosides-moma-v1.0.1) can be run locally using the instructions below. The most up-to-date build is also served at **[twosides.earth/moma](https://twosides.earth/moma)**.

## Serving a production build locally

Download the latest release zip from the [Releases](https://github.com/CenterForSpatialResearch/twosides/releases) page. Unzip it and serve the contents over HTTP.

Easiest: double-click `start-windows.bat` or `start-macos.command` inside the unzipped folder. It starts a server and opens the browser. The manual steps below do the same thing.

### Windows

Open PowerShell, navigate to the unzipped folder, and start a server with Python:

```powershell
cd C:\Users\you\Downloads\twosides-moma-v1.0.1   # adjust to your actual path
python -m http.server 8000
```

If Python is not installed, use Node ([nodejs.org](https://nodejs.org)):

```powershell
npx serve -l 8000
```

Then open `http://localhost:8000` in a browser.

### macOS / Linux

```bash
cd twosides-moma-v1.0.1 # adjust to your actual path
python3 -m http.server 8000
```

Then open `http://localhost:8000` in a browser.

### Building from source

If you need to build from the repository rather than a release:

```bash
git clone https://github.com/CenterForSpatialResearch/twosides.git
cd twosides
git checkout moma
git lfs pull          # required — without this the grid data files are empty pointers
npm install
npm run build         # outputs to dist/
npm run preview       # serves the build at http://localhost:4173
```

## About

### Biomes

**5000 Lines 5000 Species**

This visualization shows an evolution of the extensive human microbiome. It reconstructs data from the Segata Lab: 9,316 sample collections spanning 46 datasets from multiple populations and an additional cohort from Madagascar. The scientists reconstructed a catalog that greatly expands the set of 150,000 microbial genomes publicly available.

Each line represents the evolutionary pathway of a Species Level Genetic Bin (SGB), a grouping that organizes genomes based on their similarity, allowing for broader identification of species, both previously known and unknown.

**Known / Unknown:** within this study, 77% of bacteria species visualized and analyzed were previously unknown.

**Westernized / Non-Westernized:** a key finding from these data is that the human microbiome is more diverse than previously understood, especially in indigenous anthromes, which has led to calls for their preservation (see back of coin).

#### Citations

Pasolli, Edoardo, Francesco Asnicar, Serena Manara, Moreno Zolfo, Nicolai Karcher, Federica Armanini, Francesco Beghini, et al. 2019. "Extensive Unexplored Human Microbiome Diversity Revealed by Over 150,000 Genomes from Metagenomes Spanning Age, Geography, and Lifestyle." *Cell* 176(3): 649–662. [https://doi.org/10.1016/j.cell.2019.01.001](https://doi.org/10.1016/j.cell.2019.01.001)

### Anthromes

**More than 65% of terrestrial nature** has been shaped, in very different ways, by people. **Anthromes** are defined as the global ecological patterns shaped by direct human interactions with ecosystems.

Visualized here is the **Anthromes Dataset** from the Anthroecology Lab. It is a "hindcast" model, projecting back in time from global population and land use data showing change over 12,025 years.

As global population increases, and urbanization accelerates, **biodiversity shrinks.** Hence, preserving "cultured" and "wild" lands is key to preserving biodiversity.

#### Citations

Ellis, E.C., N. Gauthier, K. Klein Goldewijk, R. Bliege Bird, N. Boivin, S. Díaz, D. Fuller, J. Gill, J. Kaplan, N. Kingston, H. Locke, C. McMichael, D. Ranco, T. Rick, M.R. Shaw, L. Stephens, J.C. Svenning, and J.E.M. Watson. 2021. "People have shaped most of terrestrial nature for at least 12,000 years." *Proceedings of the National Academy of Sciences* 118(17): e2023483118. [https://doi.org/10.1073/pnas.2023483118](https://doi.org/10.1073/pnas.2023483118)

Klein Goldewijk, K. 2025. History Database of the Global Environment (HYDE 3.5). Utrecht University. [https://public.yoda.uu.nl/geo/UU01/F45D44.html](https://public.yoda.uu.nl/geo/UU01/F45D44.html)

### Credits

This project was completed by Laura Kurgan, Dan Miller and Adam Vosburgh at The Center for Spatial Research, Columbia University Graduate School of Architecture Planning and Preservation. Two Sides of the Same Coin was originally commissioned for the We the Bacteria: Notes Toward Biotic Architecture exhibition, 24th Milan Triennale International Exhibition, Inequalities, 2025. This project is open-source, and the repository is located [here](https://github.com/CenterForSpatialResearch/twosides).

## Repository structure

```
twosides/
├── index.html                 # Splash (rotating disk, commit transition)
├── loading.html               # Cross-side interstitial
├── src/
│   ├── splash/                # Splash behavior (narrative.js)
│   ├── anthromes/             # Anthromes SPA
│   │   ├── App.svelte
│   │   └── lib/               # MapCanvas, WaffleChart, gridSource, timelines
│   ├── biomes/                # Biomes SPA
│   │   ├── App.svelte
│   │   └── lib/               # BiomesChart, dataAdapter
│   └── shared/                # Shared components and state
│       ├── mapProfile.js      # Pinned resolution (70km) and country set (50m)
│       ├── pageStage.js       # Design canvas scaling
│       └── splashCopy.js      # Shared copy for splash and interstitial
├── public/
│   ├── grid/70km/             # Binary grid profile (Git LFS)
│   ├── topojson/admin-boundaries/  # Country boundary overlays (Git LFS)
│   ├── data/                  # Biomes JSON data
│   └── fonts/
├── processing/                # Data pipeline (see processing/README.md)
└── vite.config.js             # Multi-page build config
```

## Local Development Commands

```bash
npm install           # Install dependencies
npm run build         # Production build (outputs to dist/)
npm run preview       # Preview production build (http://localhost:4173)
```
