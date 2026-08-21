# Data Processing Pipeline

Converts HYDE 3.5 anthrome GeoTIFF files into a compact form the map can render (projection-flexible).

**Development Environment:** This project is developed on Windows using PowerShell. Python and Node.js commands work cross-platform, but file paths may need adjustment for your environment.

## Overview

There are two pipelines. **The grid pipeline is the one to use** — the GeoJSON/TopoJSON pipeline is kept because the boundary layers still need it and because it is the reference the grid output is verified against.

### Grid pipeline (current)

- Input: GeoTIFF at `data/HYDE-3.5/baseline/anthromes_geotiff`
- `processing/2b_generate_grid.py`: reads the GeoTIFFs **directly** and writes one small binary bundle per profile. No GeoJSON, no polygonization.
- Output: `temp/grid/<profile>/` — read at runtime by [src/anthromes/lib/gridSource.js](../src/anthromes/lib/gridSource.js).
- `processing/promote_grid.sh <profile>...`: copies a profile from `temp/grid/` to `public/grid/`, making it shipped rather than local-only.

Run it with `./run_grid_profiles.sh`. All eight profiles, all 76 years, take about a minute.

### Shipped vs local

| location | tracked | served in dev | served in prod |
|---|---|---|---|
| `public/grid/<profile>/` | yes, `.bin` via Git LFS | yes, by Vite's static handler | yes |
| `temp/grid/<profile>/` | no, gitignored | yes, via `serveTempAssets` | **no** |

Currently shipped: **100km, 75km, 70km, 60km, 50km** — 18MB total, and the five offered in the resolution picker. 33km, 25km and 10km stay in `temp/` for inspection.

A profile under `public/` behaves identically in dev and in a production build, so what you test locally is what deploys. That matters for anything running the built site — a `temp/`-only profile renders a blank map there, because `serveTempAssets` is `apply: 'serve'` and does not exist in a build.

To ship a new profile:

```bash
./run_grid_profiles.sh 60km          # generate into temp/
./promote_grid.sh 60km               # copy into public/
./promote_grid.sh --list             # see what is where
```

then drop it from `TEMP_PROFILES` in [vite.config.js](../vite.config.js) and add it to `TOPO_PROFILES` in [src/shared/topoProfile.svelte.js](../src/shared/topoProfile.svelte.js) to put it in the picker.

### Running the built site locally

```bash
npm run build && npm run preview
```

Use this rather than `npm run dev` for anything performance-sensitive — an installation, a demo, or judging render speed. `npm run dev` serves dev-mode Svelte with reactivity instrumentation and unminified code, which is dramatically slower on the data-heavy pages; the biomes page in particular takes about a minute under `dev` and a couple of seconds under `preview`. It is not a data-loading problem: the dev server serves the 16.6MB taxonomy tree in ~44ms.

### GeoJSON/TopoJSON pipeline (legacy)

- `processing/1_extract_geojson.py`: resample to geojson features. Option to decrease resolution, dissolve features, sieve small features (such as islands), or simplify features. Output to `processing/geojson/` according to name in `--profile`. The contents of this folder are not tracked.
- `processing/2_generate_topojson.js`: convert to topojson features (and combine shared boundaries). Option to simplify.
- Output: TopoJSON per year for rendering at `public/topojson/`. Contents of this folder are tracked using Git LFS. Changes will not be tracked, but still, **only push data that will be used in production.**

Still required for the admin-boundary layers (see the addendum). Steps 3–7 also still read `processing/geojson/`.

### Why the grid format replaced TopoJSON

The intuition that dissolving was the missing optimization turned out to be wrong. Measured on `33km/2025AD`:

| | |
|---|---|
| GeoJSON, 5-point ring per cell | 912,515 coordinate points |
| TopoJSON arc points | **938,797** |

Topology emitted *more* coordinates than the GeoJSON it replaced. In a regular grid every cell corner is a junction where four rings meet, so `topology()` cuts a 2-point arc at every corner, and each arc repeats the node it shares with its neighbour — the duplication removed along shared edges comes straight back at the nodes.

Worse, coordinates were only 35% of the file. The other 65% was the per-feature object table (properties 5.0MB, arc-index arrays 3.5MB, the literal string `"type":"Polygon"` 1.6MB, plus JSON structure), which topology cannot touch.

And geometry, `cellId` and `country` are byte-identical across all 76 years — verified on 5,000/5,000 sampled cells. Only the anthrome code changes, so the rest needs shipping exactly once.

The data is a raster to begin with. The grid format ships it as one, and derives each cell's rectangle arithmetically at load time.

| profile | cells | TopoJSON, 76 years | grid, 76 years |
|---|---|---|---|
| 100km | 22,192 | ~209 MB | **2.1 MB** |
| 75km | 38,234 | ~381 MB | 3.1 MB |
| 50km | 83,183 | — | 6.3 MB |
| 33km | 182,503 | ~1.8 GB | 14 MB |
| 25km | 319,973 | — | 25 MB |
| 10km | 2,215,829 | ~22 GB (infeasible) | 164 MB |

The per-cell history files are also subsumed: `cell-history-33km.json` was 166MB of this same data transposed, with the year string repeated once per cell. `historyForCell()` reads it out of the codes blob instead.

## Setup

### Required Files

Files used in processing pipeline are not tracked, but can be found [here](https://drive.google.com/drive/folders/1MhXSyV_r2wA3LeSslNq8d0JRCELBBtpP?usp=drive_link). In this folder are two subdirectories that can be copied to the project root:

`/data/HYDE-3.5`: The entire `baseline` scenario hosted [here](https://geo.public.data.uu.nl/vault-hyde/hyde35_c9_apr2025%5B1749214444%5D/original/). The result is output to `/anthromes-geotiff`. The result folder is all you need to run the next processing steps.

`/processing/geojson`: geojsons processed from the extracted geotiffs according to the instructions below from a resolution of 10km to 55km. There are also two variants for the 33km resolution that "dissolve" the features - combining individual cells with a shared `anthromes` value into one larger feature. In my testing, dissolving features would lead to reduced geojsons, but any gains would subsequently vanish when converted to topojson compared to not-dissolved geojsons at the same resolution. Also, because the resulting polygons were so complex, render time increased drastically.

### Python Requirements

**Windows (PowerShell):**
```powershell
pip install rasterio shapely numpy pyshp geopy
```

**Linux/macOS:**
```bash
pip install rasterio shapely numpy pyshp geopy
```

### Node.js Requirements

**Windows (PowerShell):**
```powershell
cd processing
npm install
```

**Linux/macOS:**
```bash
cd processing/
npm install
```

## Usage — grid pipeline

```bash
cd processing/
./setup_env.sh              # once — creates processing/.venv

./run_grid_profiles.sh      # all six profiles into temp/grid/
./run_grid_profiles.sh 33km 10km    # or a named subset
```

Env overrides: `PYTHON_BIN`, and `YEARS_FROM` (a directory whose filenames define the year list, default `../temp/topojson/33km`; `all` uses every GeoTIFF — the folder carries the full annual 1951–2024 series, ~128 years, against the 76 the app displays).

To run one profile directly:

```bash
python3 2b_generate_grid.py --profile=25km --target-res=0.225
python3 2b_generate_grid.py --profile=10km --target-res=0     # 0 = native grid, no resampling
```

### Output format

Four files in `temp/grid/<profile>/`:

| file | contents |
|---|---|
| `manifest.json` | `res`, `originX/Y`, `ncols/nrows`, `nLand`, `years[]`, `countryTable[]` |
| `mask.bin` | 1 bit per grid cell, row-major, MSB-first. Set = land. |
| `codes.bin` | `nLand * nYears` bytes, **year-major**: year *k* at `[k*nLand, (k+1)*nLand)`, land cells in ascending cellId order. One anthrome code per byte; `0` = nodata. |
| `countries.bin` | `nLand` bytes, index into `manifest.countryTable`. |

`cellId = row * ncols + col`, matching `compute_cell_id()` in `1_extract_geojson.py`, so `anthrome-change-years-*.json` and the `zooms-*.json` files stay valid.

Anthrome codes run 11–70 and never use 0, which is what makes 0 safe as the nodata sentinel; the script asserts this against the legend.

### Verifying

`verify_grid.py` rebuilds a year from the blobs exactly as the browser does and diffs it against the old pipeline:

```bash
python3 verify_grid.py --profile=75km --year=2025AD --against=geojson   # exact coords
python3 verify_grid.py --profile=33km --year=2025AD --against=topojson  # quantized, compared within one lattice step
```

It checks cell count, `{a, i, c}` per cellId, and ring geometry **including winding** — a reversed ring makes d3 fill the complement of every cell, which is this format's one silent failure mode.

Two differences are expected and reported rather than failed:

- **ISO3 fixes.** The grid producer reads `ISO_A3_EH`; the old pipeline reads `ISO_A3`, which Natural Earth 110m sets to `-99` for France, Norway, N. Cyprus, Somaliland and Kosovo. France and Norway now resolve correctly; the other three have no ISO3 in either field and become `null`.
- **Ring rotation.** TopoJSON stitches rings from arcs, so a ring may start at a different corner. Same rectangle, invisible to d3.

### Country lookup

`2b_generate_grid.py` burns country indices with a single `rasterize()` call over the target grid, once per profile. `1_extract_geojson.py` instead does a per-cell point-in-polygon lookup for every cell of every year — at 10km that would be 2.2M tests × 76 years.

## Usage — legacy GeoJSON/TopoJSON pipeline

Below is more information on the flags in each script, and examples from the `33km` and `100km` profiles.

### Step 1: Extract + Dissolve GeoJSON
```bash
cd processing/
# 100km profile (main viz)
python3 1_extract_geojson.py --target-res=0.90 --sieve-size=0 --skip-dissolve --profile=100km --boundaries=../data/ne_110m_admin_0_countries/ne_110m_admin_0_countries.shp

# 33km profile (change test page + zoom candidates)
python3 1_extract_geojson.py --target-res=0.30 --sieve-size=0 --skip-dissolve --profile=33km --boundaries=../data/ne_110m_admin_0_countries/ne_110m_admin_0_countries.shp
```

Customization Flags (GeoJSON extract):
- `--target-res`: resamples the 5-arc-minute native grid (~0.0833° ≈ 9–10 km at the equator) to a coarser grid before polygonizing. Examples: `0.1` ≈ 11 km cells; `0.25` ≈ 28 km cells; `0.5` ≈ 55 km cells; `0.75` ≈ 83 km cells. Larger values merge nearby cells and cut feature counts; `0` keeps native resolution (largest output).
  - Resampling uses **mode** (majority) so each coarser cell takes the anthrome value that occurs most within its footprint. When multiple fine cells map into a coarse cell, the most frequent anthrome wins; ties fall back to the source order.
- `--simplify`: topology-preserving simplification tolerance in degrees after dissolve. Can leave gaps between features, only use with dissolve.
- `--sieve-size`: drops raster components smaller than N pixels before polygonization. At `--target-res=0.5`, a single pixel is ~3,000 km² at the equator; `--sieve-size=8` would drop clusters smaller than ~24,000 km² (removes tiny islands/slivers).
- `--skip-dissolve`: keeps per-cell polygons (no merge by anthrome). **Required** if you intend to generate cell history (Step 3) — dissolved features lose the individual cell IDs needed for the history lookup.
- `--profile`: output folder name under `processing/geojson/` (also used in Topo step).
- `--boundaries`: path to Natural Earth shapefile for country lookup. When provided, adds `cellId` (deterministic grid position ID) and `country` (ISO3 code) to each feature. Required for historical visualization and country-based crosswalk.

### Step 2: Generate TopoJSON
```bash
cd processing/
# 100km profile (main viz)
node 2_generate_topojson.js --input=geojson/100km --output=../public/topojson/100km --simplification=0 --quantization=1e3

# 33km profile (change test page + zoom candidates)
node 2_generate_topojson.js --input=geojson/33km --output=../public/topojson/33km --simplification=0 --quantization=1e4
```

Customization Flags (TopoJSON generate):
- `--input` / `--output`: choose source GeoJSON folder and destination TopoJSON folder (typically mirrors the profile name).
- `--simplification`: topology simplification threshold applied after quantization. Recommend not using this, usually causes winding in polygons.
- `--quantization`: snaps coordinates to an evenly spaced grid; grid step = 360° / quantization. Examples: `1e5` → 0.0036° (~400 m at the equator); `1e6` → 0.00036° (~40 m). Larger values shrink files but coarsen precision; smaller retains precision with larger files.

### Step 3: Generate Cell History
```bash
cd processing/

# 100km (used by main map viz at runtime)
python3 3_generate_cell_history.py --input=geojson/100km --output=../public/data/cell-history-100km.json

# 33km (used only by processing scripts, stored in utilities/ and not committed)
python3 3_generate_cell_history.py --input=geojson/33km --output=utilities/cell-history-33km.json
```

Generates a JSON lookup file mapping each cell to its anthrome values across all displayed years (74 years from 10000BC to 2025AD). This powers the historical bar chart visualization when a user clicks on a cell.

**Requirements**: GeoJSON files must have been generated with `--boundaries` flag to include `cellId` property.

**Output format**:
```json
{
  "12345": { "10000BC": 62, "9000BC": 62, ..., "2025AD": 12 },
  "12346": { "10000BC": 54, ..., "2025AD": 23 }
}
```

### Step 4: Generate Change Years (33km only)
```bash
cd processing/
python3 6_generate_change_years.py \
  --cell-history=utilities/cell-history-33km.json \
  --output=../public/data/anthrome-change-years-33km.json
```

For each cell, determines the year when it became its current (2025AD) anthrome value by walking backwards through historical data. Used to display change year labels on the zoom circles in the anthrome change test page.

### Step 5: Generate Zoom Candidates
```bash
cd processing/

# Recommended: 15x15 grid, 100 min cells, 12 cores, 2° sampling (fast, land-only, ~2-3 min)
python3 7_generate_zoom_candidates.py --cell-history=utilities/cell-history-33km.json --topojson=../public/topojson/33km/2025AD.topojson --output-dir=../public/data --top-n=20 --grid-size=15 --min-cells=100 --processes=12 --grid-step=2.0

# Higher accuracy: 1° sampling grid (slower but more thorough, ~8-10 min)
python3 7_generate_zoom_candidates.py --cell-history=utilities/cell-history-33km.json --topojson=../public/topojson/33km/2025AD.topojson --output-dir=../public/data --top-n=20 --grid-size=15 --min-cells=100 --processes=12 --grid-step=1.0
```

Automatically generates optimal zoom locations for the anthrome change test page by analyzing anthrome shifts across the globe. Uses a grid-based approach with K-means clustering for geographic diversity to ensure globally distributed sites.

**Output Files** (in `public/data/`):
- `zooms-intensive-since-1900.json` — Top N locations with largest intensive shifts since 1900
- `zooms-cultured-since-1900.json` — Top N locations with largest cultured shifts since 1900
- `zooms-intensive-since-2000.json` — Top N locations with largest intensive shifts since 2000
- `zooms-cultured-since-2000.json` — Top N locations with largest cultured shifts since 2000

**Parameters**:

| Parameter | Default | Description |
|-----------|---------|-------------|
| `--cell-history` | Required | Path to cell history JSON (`utilities/cell-history-33km.json`) |
| `--topojson` | Required | Path to TopoJSON for cell positions (`33km/2025AD.topojson`) |
| `--output-dir` | Required | Output directory for JSON files |
| `--top-n` | 10 | Number of top locations per category |
| `--grid-size` | 15 | Size of analysis grid (15 = 15×15 = 225 cells, ~495km × 495km) |
| `--resolution` | 33.0 | Cell resolution in kilometers |
| `--min-cells` | 100 | Minimum land cells required in grid (filters ocean points) |
| `--processes` | Auto | Number of parallel processes (default: CPU count) |
| `--grid-step` | 2.0 | Sample grid spacing in degrees (2° ≈ 16,200 points, 1° ≈ 64,800) |

**How It Works**:
1. Scans the globe at regular grid intervals (default every 2°)
2. At each point, extracts a 15×15 grid of cells and skips any point with fewer than 100 land cells
3. Calculates average anthrome shift (`startAnthrome - endAnthrome`) across all land cells
4. Clusters all valid results into N geographic clusters using K-means, takes the best site per cluster
5. Reverse geocodes each result to a human-readable place name via Nominatim (requires `geopy`)

## Example Profiles

Run commands from `processing/`. Each profile writes to its own directories so you can A/B test:

| Profile | Extract command (GeoJSON) | Topo command (TopoJSON) | Notes |
|---------|---------------------------|-------------------------|-------|
| `33km` | `python3 1_extract_geojson.py --target-res=0.30 --sieve-size=0 --skip-dissolve --profile=33km --boundaries=../data/ne_110m_admin_0_countries/ne_110m_admin_0_countries.shp` | `node 2_generate_topojson.js --input=geojson/33km --output=../public/topojson/33km --simplification=0 --quantization=1e4` | Used by anthrome change test page |
| `100km` | `python3 1_extract_geojson.py --target-res=0.90 --sieve-size=0 --skip-dissolve --profile=100km --boundaries=../data/ne_110m_admin_0_countries/ne_110m_admin_0_countries.shp` | `node 2_generate_topojson.js --input=geojson/100km --output=../public/topojson/100km --simplification=0 --quantization=1e3` | Used by main anthromes viz |

### Target Resolution Reference (equator)
| target-res (°) | arc minutes | approx km/cell |
|----------------|-------------|----------------|
| 0.30 | 18.0' | ~33.4 km |
| 0.45 | 27.0' | ~50.1 km |
| 0.60 | 36.0' | ~66.8 km |
| 0.675 | 40.5' | ~75.1 km |
| 0.75 | 45.0' | ~83.5 km |
| 0.90 | 54.0' | ~100.2 km |

### Scratch Profiles (output to `temp/`)

**For map data, use `./run_grid_profiles.sh` instead** — it is faster, produces ~100x smaller output, and needs no GeoJSON intermediate. This runner remains for generating the `processing/geojson/` folder that steps 3–7 read, and for producing TopoJSON to verify grid output against.

It chains Step 1 and Step 2, always with `--skip-dissolve` so cells stay individually addressable.

```bash
cd processing/
./setup_env.sh                  # once — creates processing/.venv with rasterio et al.

./run_temp_50_75.sh             # both profiles
./run_temp_50_75.sh 75km        # or just one

# arbitrary resolution:
./run_temp_profile.sh 60km 0.54
```

TopoJSON lands in `temp/topojson/<profile>/`; intermediate GeoJSON stays in `processing/geojson/<profile>/` (Step 3 needs it).

⚠️ Step 1 skips extraction when the GeoJSON folder is already populated. If that folder holds output from an older run with different settings, the result is silently wrong — pass `FORCE=1`.

By default the runner only processes the years present in `temp/topojson/33km/`, so profiles are directly comparable. The GeoTIFF folder holds 128 years — the full annual series from 1951–2024 — while the display set is 76. Set `YEARS_FROM=all` to process everything, or point it at another reference folder.

Env overrides: `QUANTIZATION` (default `1e4`, matching 33km), `KEEP_GEOJSON=0` to drop the intermediates, `FORCE=1` to re-extract, `YEARS_FROM` as above, `PYTHON_BIN` to pick an interpreter.

## Troubleshooting
- `ModuleNotFoundError`: run `./setup_env.sh`, or `pip install rasterio shapely numpy pyshp geopy`
- `Cannot find module 'topojson-server'`: run `npm install` in `processing/`
- Files too jagged: lower `--simplify` or `--target-res` (more detail)
- Files too big: increase `--target-res`, `--simplify`, or `--quantization`

Grid pipeline:
- **Map blank on a grid profile**: that profile hasn't been generated. Run `./run_grid_profiles.sh <profile>`. `temp/` is gitignored, so a fresh clone has none of them.
- **Every cell renders inverted / the map looks like a negative**: ring winding is reversed. Run `verify_grid.py`; it checks winding explicitly.
- **`codes.bin is N bytes, expected M`**: the manifest and blobs are from different runs. Regenerate the profile.
- **Land set varies between years**: the producer warns and takes the union, so cells absent in some years read as 0 there. Not expected with HYDE, but it will say so rather than silently misalign.

---

## Addendum: Admin Boundaries

Two boundary types are available. The app switches between them via `USE_PIXEL_BOUNDARIES` in [src/anthromes/lib/constants.js](../src/anthromes/lib/constants.js). **Currently `USE_PIXEL_BOUNDARIES = false`**, so only the smooth boundaries (`countries-110m.topojson`) are used in production.

### Smooth Boundaries (currently active)

Natural Earth vector boundaries, preserved as smooth curves. Generated by `5_smooth_boundaries.py`:

```bash
cd processing/
python3 5_smooth_boundaries.py
node 2_generate_topojson.js \
  --input=geojson/admin-boundaries/smooth \
  --output=../public/topojson/admin-boundaries \
  --quantization=1e5
```

**Output**: `public/topojson/admin-boundaries/countries-110m.topojson`

**Source data**: Natural Earth 110m Admin-0 Countries shapefile at `data/ne_110m_admin_0_countries/`.

### Grid-Snapped Boundaries (inactive)

Grid-snapped country boundaries that align with anthrome cell boundaries. Generated by rasterizing Natural Earth vector boundaries to the same grid resolution as the anthromes data, then re-vectorizing. Creates "stair-step" boundaries at the grid resolution — intentional for alignment with anthrome cells.

```bash
cd processing/
# 33km
python3 4_boundaries_geojson.py --profile=33km --target-res=0.30
node 2_generate_topojson.js --input=geojson/admin-boundaries/33km --output=../public/topojson/admin-boundaries/33km --quantization=1e4

# 100km
python3 4_boundaries_geojson.py --profile=100km --target-res=0.90
node 2_generate_topojson.js --input=geojson/admin-boundaries/100km --output=../public/topojson/admin-boundaries/100km --quantization=1e4
```

To activate, set `USE_PIXEL_BOUNDARIES = true` in `src/anthromes/lib/constants.js`.
