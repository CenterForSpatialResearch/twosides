#!/usr/bin/env python3
"""
Extract GeoJSON polygons from HYDE 3.5 GeoTIFF files.

Converts raster anthrome data to vector polygons for each year.

Usage:
    python3 1_extract_geojson.py
"""

import os
import json
from pathlib import Path
import rasterio
from rasterio.features import shapes
from shapely.geometry import shape, mapping
from shapely.ops import unary_union
import warnings

# Suppress rasterio warnings
warnings.filterwarnings('ignore', category=rasterio.errors.NotGeoreferencedWarning)

# Configuration
INPUT_DIR = Path('../data/HYDE-3.5/baseline/anthromes_geotiff')
OUTPUT_DIR = Path('geojson')

def extract_geojson_from_tif(tif_path, output_path):
    """
    Extract GeoJSON polygons from a single GeoTIFF file.

    Args:
        tif_path: Path to input GeoTIFF file
        output_path: Path to output GeoJSON file
    """
    with rasterio.open(tif_path) as src:
        # Read raster data
        image = src.read(1)

        # Extract shapes (polygons) from raster
        # shapes() returns (geometry, value) tuples
        geoms = []
        for geom, value in shapes(image, transform=src.transform):
            anthrome_code = int(value)

            # Convert to shapely geometry and add anthrome code
            poly = shape(geom)
            geoms.append({
                'type': 'Feature',
                'geometry': mapping(poly),
                'properties': {
                    'anthrome': anthrome_code
                }
            })

        # Create GeoJSON FeatureCollection
        geojson = {
            'type': 'FeatureCollection',
            'features': geoms
        }

        # Write to file
        with open(output_path, 'w') as f:
            json.dump(geojson, f, separators=(',', ':'))

        return len(geoms)

def main():
    """Process all GeoTIFF files in the input directory."""
    # Create output directory
    OUTPUT_DIR.mkdir(exist_ok=True)

    # Get all GeoTIFF files
    tif_files = sorted(INPUT_DIR.glob('anthromes*.tif'))

    if not tif_files:
        print(f"❌ No GeoTIFF files found in {INPUT_DIR}")
        return

    print(f"📁 Found {len(tif_files)} GeoTIFF files")
    print(f"🔧 Extracting polygons...\n")

    total_features = 0

    for i, tif_path in enumerate(tif_files, 1):
        # Extract year from filename (e.g., "anthromes1950AD.tif" → "1950AD")
        year = tif_path.stem.replace('anthromes', '')
        output_path = OUTPUT_DIR / f'{year}.geojson'

        try:
            feature_count = extract_geojson_from_tif(tif_path, output_path)
            total_features += feature_count

            file_size_mb = output_path.stat().st_size / (1024 * 1024)
            print(f"[{i:3d}/{len(tif_files)}] {year:12s} → {feature_count:6,d} features ({file_size_mb:6.2f} MB)")

        except Exception as e:
            print(f"[{i:3d}/{len(tif_files)}] {year:12s} → ❌ Error: {e}")

    print(f"\n✅ Extraction complete!")
    print(f"   Total features: {total_features:,}")
    print(f"   Output: {OUTPUT_DIR.absolute()}/")

if __name__ == '__main__':
    main()
