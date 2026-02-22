# Data Processing Pipeline

Converts HYDE 3.5 anthrome GeoTIFF files to optimized GeoJSON/TopoJSON for D3 rendering (projection-flexible).

**Development Environment:** This project is developed on Windows using PowerShell. Python and Node.js commands work cross-platform, but file paths may need adjustment for your environment.

## Overview

Generally, the processing flow is:

- Input: GeoTIFF at `data/HYDE-3.5/baseline/anthromes_geotiff`
- `processing/1_extract_geojson.py`: resample to geojson features. Option to decrease resolution, dissolve features, sieve small features (such as islands), or simplify features. Output to `processing/geojson/` according to name in `--profile`. The contents of this folder are not tracked.
- `processing/2_generate_topojson.js`: convert to topojson features (and combine shared boundaries). Option to simplify.
- Output: TopoJSON per year for rendering at `public/topojson/`. Contents of this folder are tracked using Git LFS. Changes will not be tracked, but still, **only push data that will be used in production.**

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

## Usage

Above is all you need to get started, but below is more information on the flags in each script, and examples from the `33km` and `100km` profiles.

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
| 0.75 | 45.0' | ~83.5 km |
| 0.90 | 54.0' | ~100.2 km |

## Troubleshooting
- `ModuleNotFoundError`: `pip install rasterio shapely numpy pyshp geopy`
- `Cannot find module 'topojson-server'`: run `npm install` in `processing/`
- Files too jagged: lower `--simplify` or `--target-res` (more detail)
- Files too big: increase `--target-res`, `--simplify`, or `--quantization`

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
