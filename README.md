# twosides

Production release for the interactive portion of *Two Sides of the Same Coin*, a double-sided visualization featuring a dataset on each side — anthromes and biomes. It was built for *Full Disclosure: The Edge of Information Design* at the Museum of Modern Art, opening September 27, 2026.

This production build (twosides-moma-v1.0.0) can be run locally using the instructions below. The most up-to-date build is also served at **[twosides.earth/moma](https://twosides.earth/moma)**.

## Serving a production build locally

Download the latest release zip from the [Releases](https://github.com/CenterForSpatialResearch/twosides/releases) page. Unzip it and serve the contents over HTTP.

Easiest: double-click `start-windows.bat` or `start-macos.command` inside the unzipped folder. It starts a server and opens the browser. The manual steps below do the same thing.

### Windows

Open PowerShell, navigate to the unzipped folder, and start a server with Python:

```powershell
cd C:\Users\you\Downloads\twosides-moma-v1.0.0   # adjust to your actual path
python -m http.server 8000
```

If Python is not installed, use Node ([nodejs.org](https://nodejs.org)):

```powershell
npx serve -l 8000
```

Then open `http://localhost:8000` in a browser.

### macOS / Linux

```bash
cd twosides-moma-v1.0.0 # adjust to your actual path
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

### Anthromes

Anthromes classify ecosystems according to sustained human interactions with them. Population, settlement, agriculture, and land use distinguish one anthrome from another.

Ellis, E.C., N. Gauthier, K. Klein Goldewijk, R. Bliege Bird, N. Boivin, S. Diaz, D. Fuller, J. Gill, J. Kaplan, N. Kingston, H. Locke, C. McMichael, D. Ranco, T. Rick, M.R. Shaw, L. Stephens, J.C. Svenning, and J.E.M. Watson. 2021. "People have shaped most of terrestrial nature for at least 12,000 years." *Proceedings of the National Academy of Sciences* 118(17): e2023483118. [https://doi.org/10.1073/pnas.2023483118](https://doi.org/10.1073/pnas.2023483118)

Klein Goldewijk, K. 2025. History Database of the Global Environment (HYDE 3.5). Utrecht University. [https://public.yoda.uu.nl/geo/UU01/F45D44.html](https://public.yoda.uu.nl/geo/UU01/F45D44.html)

### Biomes

An extensive microbiome assembly contains fragments of DNA from many communities. 9,428 samples provide views into human-associated microbial life.

Pasolli, Edoardo, Francesco Asnicar, Serena Manara, Moreno Zolfo, Nicolai Karcher, Federica Armanini, Francesco Beghini, et al. 2019. "Extensive Unexplored Human Microbiome Diversity Revealed by Over 150,000 Genomes from Metagenomes Spanning Age, Geography, and Lifestyle." *Cell* 176(3): 649–662. [https://doi.org/10.1016/j.cell.2019.01.001](https://doi.org/10.1016/j.cell.2019.01.001)

### Credits

Laura Kurgan, Dan Miller, and Adam Vosburgh. With support from the Columbia University Graduate School of Architecture, Planning and Preservation.

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
│       ├── idleReset.js       # Attract-loop guard (30s timeout)
│       ├── IdleOverlay.svelte # Timeout warning UI
│       ├── pageStage.js       # Design canvas scaling
│       └── splashCopy.js      # Shared copy for splash and interstitial
├── public/
│   ├── grid/70km/             # Binary grid profile (Git LFS)
│   ├── topojson/admin-boundaries/  # Country boundary overlays (Git LFS)
│   ├── data/                  # Biomes JSON data
│   └── fonts/
├── processing/                # Data pipeline (see processing/README.md)
├── utilities/                 # Build and release tooling
└── vite.config.js             # Multi-page build config
```

## Commands

```bash
npm install           # Install dependencies
npm run build         # Production build (outputs to dist/)
npm run preview       # Preview production build (http://localhost:4173)
```
