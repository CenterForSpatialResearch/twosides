# Data Processing Pipeline

Converts HYDE 3.5 anthrome GeoTIFF files to optimized GeoJSON/TopoJSON for D3 rendering (projection-flexible). 

## Overview

Generally, the processing flow is:

Input: GeoTIFF at `data/HYDE-3.5/baseline/anthromes_geotiff`
  → `processing/1_extract_geojson.py`: resample to geojson features. Option to decrease resolution, dissolve features, sieve small features (such as islands), or simplify features. output to `processing/geojson/` according to name in `--profile`. The contents of this folder are not tracked.
  → `processing/2_generate_topojson.js`: convert to topojson features (and combine share boundaries). Option to simplify. 
→ Output: TopoJSON per year for rendering at `/Users/akv2118-admin/Documents/GitHub/twosides/public/topojson`. **Contents of this folder are tracked using Git LFS, only push what is necessary.**

### Testing

You can compare multiple profiles at public/test-anthromes-d3.html. This includes stats of load and render times. By default, all of the profiles included in the below "Required Files" section are included. Add or edit profiles under the `const profiles = [` array.

*note*: in production in the anthromes viz: the load and render times are slightly longer than in the test page. The load times come from having to wait for the waffle chart to load, and the render times come from the overhead of clipping the boundary of the map to the inside of the waffle chart. This has been optimized pretty hard, but potentially could be improved upon.

## Setup

### Required Files

Files used in processing pipeline are not tracked, but can be found [here](https://drive.google.com/open?id=15qKjOuMAIivtimwi3568i6LhuqeRompI&usp=drive_fs). In this folder are two subdirectories that can be copied to the project root:

`/data/HYDE-3.5`: The entire `baseline` scenario hosted [here](https://geo.public.data.uu.nl/vault-hyde/hyde35_c9_apr2025%5B1749214444%5D/original/). The result is output to `/anthromes-geotiff`. The result folder is all you need to run the next processing steps. 

`/processing/geojson`: geojsons processed from the extracted geotiffs according to the instructiosn below from a resolution of 10km to 55km. There are also two variants for the 33km resolution that "dissolve" the features - combining individual cells with a shared `anthromes` value into one larger feature. In my testing, dissolving features would lead to reduced geojsons, but any gains would subsequently vanish when converted to topojson compared to not-dissolved geojsons at the same resolution. Also, because the resulting polygons were so complexed, render time increased drastically. 

### Python Requirements
```bash
pip install rasterio shapely numpy
```

### Node.js Requirements
```bash
cd processing/
npm install
```

## Usage

Above is all you need to get started, but below is more information on the flags in each script, and examples from the `10km`, `33km` and `50km` profiles available above.

### Step 1: Extract + Dissolve GeoJSON
```bash
cd processing/
# Default (r025-s20)
python3 1_extract_geojson.py

# Custom example
python3 1_extract_geojson.py --target-res=0.25 --simplify=0.15 --sieve-size=8 --profile=mytest
```

Customization Flags (GeoJSON extract):
- `--target-res`: resamples the 5-arc-minute native grid (~0.0833° ≈ 9–10 km at the equator) to a coarser grid before polygonizing. Examples: `0.1` ≈ 11 km cells; `0.25` ≈ 28 km cells; `0.5` ≈ 55 km cells; `0.75` ≈ 83 km cells. Larger values merge nearby cells and cut feature counts; `0` keeps native resolution (largest output).
  - Resampling uses **mode** (majority) so each coarser cell takes the anthrome value that occurs most within its footprint. When multiple fine cells map into a coarse cell, the most frequent anthrome wins; ties fall back to the source order.
- `--simplify`: topology-preserving simplification tolerance in degrees after dissolve. Can leave gaps between features, only use with dissolve.
- `--sieve-size`: drops raster components smaller than N pixels before polygonization. At `--target-res=0.5`, a single pixel is ~3,000 km² at the equator; `--sieve-size=8` would drop clusters smaller than ~24,000 km² (removes tiny islands/slivers).
- `--skip-dissolve`: keeps per-cell polygons (no merge by anthrome). Omitting it dissolves by anthrome code, yielding far fewer, larger polygons. Dissolve can siginificantly drop files size, but will lead to higher render times.
- `--profile`: output folder name under `processing/geojson/` (also used in Topo step).

### Step 2: Generate TopoJSON
```bash
cd processing/
# Default (paired with r025-s20)
node 2_generate_topojson.js --input=processing/geojson/r025-s20 --output=public/topojson/r025-s20

# Custom example
node 2_generate_topojson.js --input=processing/geojson/mytest --output=public/topojson/mytest --simplification=0.06 --quantization=1e5
```

Customization Flags (TopoJSON generate):
- `--input` / `--output`: choose source GeoJSON folder and destination TopoJSON folder (typically mirrors the profile name).
- `--simplification`: topology simplification threshold applied after quantization. Recommend not using this, usually causes winding in polygons.
- `--quantization`: snaps coordinates to an evenly spaced grid; grid step = 360° / quantization. Examples: `1e5` → 0.0036° (~400 m at the equator); `1e6` → 0.00036° (~40 m). Larger values shrink files but coarsen precision; smaller retains precision with larger files.


## Example of Used Profiles

Run commands from `processing/`. Each profile writes to its own directories so you can A/B test:

| Profile | Extract command (GeoJSON) | Topo command (TopoJSON) | Notes |
|---------|---------------------------|-------------------------|-------|
| `10km` | `python3 1_extract_geojson.py --target-res=0.20 --sieve-size=0 --skip-dissolve --profile=10km` | `node 2_generate_topojson.js --input=geojson/10km --output=../public/topojson/10km --simplification=0 --quantization=1e4` | Original (10km) Resolution
| `33km` | `python3 1_extract_geojson.py --target-res=0.30 --sieve-size=0 --skip-dissolve --profile=33km` | `node 2_generate_topojson.js --input=geojson/33km --output=../public/topojson/33km --simplification=0 --quantization=1e4` | Resample to 33km grid, balance between resolution and performance
| `50km` | `python3 1_extract_geojson.py --target-res=0.45 --sieve-size=0 --skip-dissolve --profile=50km` | `node 2_generate_topojson.js --input=geojson/50km --output=../public/topojson/50km --simplification=0 --quantization=1e4` | Resample to 50km grid, high performance

Tip: `--profile` is just a folder name; adjust numbers as needed. Use `--target-res=0` (or omit) to keep native resolution. 
Warning: For light per-cell/dissolved sets (`r025_light`, `r02_light-dissolve`), keep TopoJSON simplification ≤0.08. At 0.1 the topo simplifier can flip ring winding, yielding globe-sized polygons in D3.

### Target Resolution Reference (equator)
| target-res (°) | arc minutes | approx km/cell |
|----------------|-------------|----------------|
| 0.15 | 9.0'  | ~16.7 km |
| 0.20 | 12.0' | ~22.3 km |
| 0.25 | 15.0' | ~27.8 km |
| 0.30 | 18.0' | ~33.4 km |
| 0.35 | 21.0' | ~39.0 km |
| 0.40 | 24.0' | ~44.5 km |
| 0.45 | 27.0' | ~50.1 km |
| 0.50 | 30.0' | ~55.7 km |

## Troubleshooting
- `ModuleNotFoundError`: `pip install rasterio shapely numpy`
- `Cannot find module 'topojson-server'`: run `npm install` in `processing/`
- Files too jagged: lower `--simplify` or `--target-res` (more detail)
- Files too big: increase `--target-res`, `--simplify`, or `--quantization`
