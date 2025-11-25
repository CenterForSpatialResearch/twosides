# Data Processing Pipeline

Converts HYDE 3.5 anthrome GeoTIFF files to TopoJSON for web visualization.

## Pipeline Overview

```
GeoTIFF (raster)  →  GeoJSON (vector)  →  TopoJSON (simplified)
   577-862 KB           1-50 MB              100-500 KB
```

**Input:** 106 GeoTIFF files from HYDE 3.5 dataset
**Output:** 106 TopoJSON files for MapLibre rendering

## Prerequisites

### Python Requirements
```bash
pip install rasterio shapely
```

### Node.js Requirements
```bash
cd processing/
npm install
```

## Usage

### Step 1: Extract GeoJSON from GeoTIFF
```bash
cd processing/
python3 1_extract_geojson.py
```

**What it does:**
- Reads all `anthromes*.tif` files from `../data/HYDE-3.5/baseline/anthromes_geotiff/`
- Polygonizes raster cells into vector features
- Outputs to `processing/geojson/{year}.geojson`

**Expected output:**
```
📁 Found 106 GeoTIFF files
🔧 Extracting polygons...

[  1/106] 10000BC      →  12,456 features (  2.15 MB)
[  2/106] 9000BC       →  13,234 features (  2.34 MB)
...
✅ Extraction complete!
```

### Step 2: Generate TopoJSON
```bash
cd processing/
node 2_generate_topojson.js
```

**What it does:**
- Reads all `.geojson` files from `processing/geojson/`
- Converts to TopoJSON with topology preservation
- Applies simplification (default: 0.05) and quantization (default: 1e4)
- Outputs to `public/topojson/{year}.topojson`

**Expected output:**
```
📁 Found 106 GeoJSON files
🔧 Simplification: 0.05, Quantization: 10000

[  1/106] 10000BC       12,456 features   2.15 MB →   0.28 MB  (87.0% smaller)
[  2/106] 9000BC        13,234 features   2.34 MB →   0.31 MB  (86.8% smaller)
...
✅ TopoJSON generation complete!
```

### Optional: Custom Simplification
```bash
# More detail (larger files)
node 2_generate_topojson.js --simplification=0.01

# Less detail (smaller files)
node 2_generate_topojson.js --simplification=0.1

# Custom quantization
node 2_generate_topojson.js --quantization=1e5
```

## Output Files

**GeoJSON** (intermediate):
```
processing/geojson/
├── 10000BC.geojson
├── 9000BC.geojson
└── ...
```

**TopoJSON** (final):
```
public/topojson/
├── 10000BC.topojson
├── 9000BC.topojson
└── ...
```

## File Formats

### GeoJSON Structure
```json
{
  "type": "FeatureCollection",
  "features": [
    {
      "type": "Feature",
      "geometry": { "type": "Polygon", "coordinates": [[...]] },
      "properties": { "anthrome": 11 }
    }
  ]
}
```

### TopoJSON Structure
```json
{
  "type": "Topology",
  "objects": {
    "anthromes": { "type": "GeometryCollection", "geometries": [...] }
  },
  "arcs": [...],
  "transform": {...}
}
```

## Troubleshooting

### Python: `ModuleNotFoundError: No module named 'rasterio'`
```bash
pip install rasterio shapely
```

### Node.js: `Cannot find module 'topojson-server'`
```bash
cd processing/
npm install
```

### Empty GeoJSON files
- Check that GeoTIFF files exist in `data/HYDE-3.5/baseline/anthromes_geotiff/`
- Verify files are valid raster data (not corrupted)

### Simplification too aggressive
```bash
# Reduce simplification value for more detail
node 2_generate_topojson.js --simplification=0.01
```

## Performance Notes

- **Step 1 (Python):** ~10-30 seconds for 106 files
- **Step 2 (Node.js):** ~1-2 minutes for 106 files
- **Total pipeline:** ~2-3 minutes
- **Final size:** ~20-50 MB total for all 106 TopoJSON files

## Data Cleaning

The `geojson/` directory is gitignored (intermediate files only).
Final TopoJSON files in `public/topojson/` should be committed to the repo.
