# Data Processing Pipeline

Converts HYDE 3.5 anthrome GeoTIFF files to optimized GeoJSON/TopoJSON for D3 rendering (projection-flexible).

## Pipeline Overview

```
GeoTIFF (raster)
  → optional resample (mode) to coarser grid
  → dissolve by anthrome code + simplify
  → GeoJSON per year
  → TopoJSON per year (quantize + simplify)
```

**Input:** 106 GeoTIFF files from HYDE 3.5 dataset  
**Output:** One or more optimized TopoJSON sets (by profile) for map rendering

## Prerequisites

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


## Used Profiles

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
