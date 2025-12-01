#!/usr/bin/env python3
"""
Extract GeoJSON polygons from HYDE 3.5 GeoTIFF files with resampling/dissolve.

Converts raster anthrome data to vector polygons for each year, with options to
resample the raster first (to cut vertex counts), dissolve by anthrome code, and
apply configurable simplification.

see processing/readme.md for usage examples

Options (real-world meaning):
    --target-res   Degrees per pixel for resampling (mode). Larger = coarser grid
                   before polygonizing, which merges nearby cells; 0 keeps native.
    --simplify     Degrees for topology-preserving simplify after dissolve.
                   Roughly: 0.1° ≈ 11 km at equator, 0.3° ≈ 33 km; higher removes
                   small wiggles/peninsulas.
    --sieve-size   Minimum raster component size in pixels before polygonization.
                   Higher values drop small islands/fragments (e.g., 8 removes blobs
                   smaller than ~8 cells).
    --skip-dissolve Keep individual cell polygons (no merging by anthrome code);
                    best if you need per-cell cartogram-style outputs; larger files.
    --profile      Folder name under processing/geojson for outputs.
"""

import os
import json
from pathlib import Path
import argparse
import numpy as np
import rasterio
from rasterio.features import shapes
from rasterio.features import sieve
from rasterio.enums import Resampling
from rasterio.transform import from_origin
from rasterio.warp import reproject
from rasterio.crs import CRS
from shapely.geometry import shape, mapping
from shapely.geometry.polygon import orient
from shapely.ops import unary_union
import warnings

# Suppress rasterio warnings
warnings.filterwarnings('ignore', category=rasterio.errors.NotGeoreferencedWarning)

def parse_args():
    parser = argparse.ArgumentParser(description='Extract/dissolve anthrome GeoJSON from GeoTIFFs')
    parser.add_argument('--input-dir', type=Path, default=Path('../data/HYDE-3.5/baseline/anthromes_geotiff'),
                        help='Directory containing anthrome GeoTIFFs')
    parser.add_argument('--output-dir', type=Path, default=Path('geojson'),
                        help='Base output directory for GeoJSON')
    parser.add_argument('--profile', type=str, default='default',
                        help='Profile name (used as subfolder under output-dir)')
    parser.add_argument('--target-res', type=float, default=0,
                        help='Target resolution in degrees for resampling (0 to keep native)')
    parser.add_argument('--simplify', type=float, default=0,
                        help='Simplification tolerance in degrees after dissolve (0 to disable)')
    parser.add_argument('--sieve-size', type=int, default=0,
                        help='Minimum object size (in pixels) to retain during sieve (0 to skip)')
    parser.add_argument('--skip-dissolve', action='store_true',
                        help='Keep individual cell polygons (no dissolve by anthrome code)')
    return parser.parse_args()

def orient_geometry(geom, sign=-1.0):
    """
    Safely orient Polygon/MultiPolygon (and collections) without assuming .exterior exists.
    Keeps non-surface geometries unchanged.
    """
    if geom.is_empty:
        return geom
    if geom.geom_type == 'Polygon':
        return orient(geom, sign=sign)
    if geom.geom_type == 'MultiPolygon':
        return type(geom)([orient(p, sign=sign) for p in geom.geoms])
    if hasattr(geom, 'geoms'):
        return type(geom)([orient_geometry(g, sign=sign) for g in geom.geoms])
    return geom

def resample_categorical(src, target_res):
    """Resample categorical raster to target resolution using mode resampling."""
    if target_res is None or target_res <= 0:
        return src.read(1), src.transform

    src_crs = src.crs or CRS.from_epsg(4326)

    bounds = src.bounds
    dst_width = int(np.ceil((bounds.right - bounds.left) / target_res))
    dst_height = int(np.ceil((bounds.top - bounds.bottom) / target_res))
    dst_transform = from_origin(bounds.left, bounds.top, target_res, target_res)

    destination = np.empty((dst_height, dst_width), dtype=src.dtypes[0])

    reproject(
        source=rasterio.band(src, 1),
        destination=destination,
        src_transform=src.transform,
        src_crs=src_crs,
        dst_transform=dst_transform,
        dst_crs=src_crs,
        resampling=Resampling.mode,
    )

    return destination, dst_transform

def extract_geojson_from_tif(tif_path, output_path, target_res, simplify_tol, sieve_size, skip_dissolve):
    """
    Extract GeoJSON polygons from a single GeoTIFF file with optimization.

    Dissolves adjacent grid cells with the same anthrome value into unified polygons
    to dramatically reduce file size and feature count.

    Args:
        tif_path: Path to input GeoTIFF file
        output_path: Path to output GeoJSON file
    """
    from collections import defaultdict

    with rasterio.open(tif_path) as src:
        # Read raster data (optionally resample first)
        image, transform = resample_categorical(src, target_res)

        # Drop very small slivers before polygonization (optional)
        if sieve_size and sieve_size > 0:
            image = sieve(image, size=sieve_size, connectivity=8)

        # Determine nodata value (skip only true nodata, keep all anthrome codes)
        nodata_value = src.nodata if src.nodata is not None else -1

        features = []

        if skip_dissolve:
            # Keep individual cell polygons (optionally simplify each cell)
            for geom, value in shapes(image, transform=transform):
                anthrome_code = int(value)

                if anthrome_code == nodata_value:
                    continue

                geom_shape = shape(geom)
                if simplify_tol and simplify_tol > 0:
                    geom_shape = geom_shape.simplify(simplify_tol, preserve_topology=True)

                # Normalize winding so D3 interprets polygons, not complements
                geom_shape = orient_geometry(geom_shape, sign=-1.0)

                features.append({
                    'type': 'Feature',
                    'geometry': mapping(geom_shape),
                    'properties': {
                        'anthrome': anthrome_code
                    }
                })
        else:
            # Group geometries by anthrome value
            grouped = defaultdict(list)
            for geom, value in shapes(image, transform=transform):
                anthrome_code = int(value)

                # Skip only nodata; keep all anthrome classes
                if anthrome_code == nodata_value:
                    continue

                # Convert to shapely geometry and group by anthrome code
                grouped[anthrome_code].append(shape(geom))

            # Dissolve each group into a single multi-polygon
            for anthrome_code, geom_list in sorted(grouped.items()):
                # Merge all polygons with the same anthrome value
                dissolved = unary_union(geom_list)

                # Simplify geometry to reduce vertex count
                if simplify_tol and simplify_tol > 0:
                    simplified = dissolved.simplify(simplify_tol, preserve_topology=True)
                else:
                    simplified = dissolved

                # Normalize winding (outer rings clockwise) for consistency with D3
                simplified = orient_geometry(simplified, sign=-1.0)

                features.append({
                    'type': 'Feature',
                    'geometry': mapping(simplified),
                    'properties': {
                        'anthrome': anthrome_code
                    }
                })

        # Create GeoJSON FeatureCollection
        geojson = {
            'type': 'FeatureCollection',
            'features': features
        }

        # Write to file
        output_path.parent.mkdir(parents=True, exist_ok=True)
        with open(output_path, 'w') as f:
            json.dump(geojson, f, separators=(',', ':'))

        return len(features)

def main():
    """Process all GeoTIFF files in the input directory."""
    args = parse_args()

    input_dir = args.input_dir
    output_dir = args.output_dir / args.profile

    # Get all GeoTIFF files
    tif_files = sorted(input_dir.glob('anthromes*.tif'))

    if not tif_files:
        print(f"❌ No GeoTIFF files found in {input_dir}")
        return

    print(f"📁 Found {len(tif_files)} GeoTIFF files in {input_dir}")
    print(f"🔧 Profile: {args.profile}")
    if args.target_res and args.target_res > 0:
        print(f"   Resample to: {args.target_res}° (mode)")
    else:
        print("   Resample: native resolution")
    print(f"   Dissolve: {'off (per-cell polygons)' if args.skip_dissolve else 'on (merge by anthrome code)'}")
    if args.simplify and args.simplify > 0:
        print(f"   Simplify: {args.simplify}°")
    else:
        print("   Simplify: off")
    if args.sieve_size and args.sieve_size > 0:
        print(f"   Sieve: drop components smaller than {args.sieve_size} px")
    print(f"   Output: {output_dir}\n")

    total_features = 0

    for i, tif_path in enumerate(tif_files, 1):
        # Extract year from filename (e.g., "anthromes1950AD.tif" → "1950AD")
        year = tif_path.stem.replace('anthromes', '')
        output_path = output_dir / f'{year}.geojson'

        try:
            feature_count = extract_geojson_from_tif(
                tif_path,
                output_path,
                target_res=args.target_res,
                simplify_tol=args.simplify,
                sieve_size=args.sieve_size,
                skip_dissolve=args.skip_dissolve,
            )
            total_features += feature_count

            file_size_mb = output_path.stat().st_size / (1024 * 1024)
            print(f"[{i:3d}/{len(tif_files)}] {year:12s} → {feature_count:6,d} features ({file_size_mb:6.2f} MB)")

        except Exception as e:
            print(f"[{i:3d}/{len(tif_files)}] {year:12s} → ❌ Error: {e}")

    print(f"\n✅ Extraction complete!")
    print(f"   Total features: {total_features:,}")
    print(f"   Output: {output_dir.absolute()}/")

if __name__ == '__main__':
    main()
