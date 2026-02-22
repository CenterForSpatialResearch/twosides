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
    --boundaries   Path to Natural Earth shapefile for country lookup (optional).
                   When provided, adds 'country' (ISO3) and 'cellId' to each feature.
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
from shapely.geometry import shape, mapping, Point, box
from shapely.geometry.polygon import orient
from shapely.ops import unary_union
from shapely import STRtree
import shapefile  # pyshp
import warnings

# Suppress rasterio warnings
warnings.filterwarnings('ignore', category=rasterio.errors.NotGeoreferencedWarning)

# Global for country lookup (loaded once)
_country_index = None
_country_geoms = None
_country_codes = None

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
    parser.add_argument('--boundaries', type=Path, default=None,
                        help='Path to Natural Earth shapefile for country lookup (adds cellId and country)')
    return parser.parse_args()


def load_country_boundaries(shp_path):
    """
    Load Natural Earth shapefile and build spatial index for country lookup.
    Returns (STRtree index, list of geometries, list of ISO3 codes).
    """
    global _country_index, _country_geoms, _country_codes

    if _country_index is not None:
        return _country_index, _country_geoms, _country_codes

    print(f"   Loading country boundaries from {shp_path}...")
    sf = shapefile.Reader(str(shp_path))
    fields = [f[0] for f in sf.fields[1:]]

    # Find ISO_A3 field
    iso_idx = fields.index('ISO_A3') if 'ISO_A3' in fields else None
    if iso_idx is None:
        print("   Warning: ISO_A3 field not found, country lookup disabled")
        return None, None, None

    geoms = []
    codes = []

    for rec in sf.shapeRecords():
        geom = shape(rec.shape.__geo_interface__)
        iso3 = rec.record[iso_idx] if iso_idx is not None else None
        if geom.is_valid and iso3:
            geoms.append(geom)
            codes.append(iso3)

    _country_geoms = geoms
    _country_codes = codes
    _country_index = STRtree(geoms)

    print(f"   Loaded {len(geoms)} country polygons")
    return _country_index, _country_geoms, _country_codes


def compute_cell_id(centroid, transform, num_cols):
    """
    Compute deterministic cell ID from centroid coordinates and grid transform.
    cellId = row * num_cols + col
    """
    origin_x = transform.c  # left edge
    origin_y = transform.f  # top edge
    pixel_width = transform.a
    pixel_height = -transform.e  # negative because y decreases downward

    col = int((centroid.x - origin_x) / pixel_width)
    row = int((origin_y - centroid.y) / pixel_height)

    return row * num_cols + col


def lookup_country(centroid, index, geoms, codes):
    """
    Look up country ISO3 code for a point using spatial index.
    Returns ISO3 code or None if not found.
    """
    if index is None:
        return None

    # Query spatial index for candidates
    candidates = index.query(centroid)

    for i in candidates:
        if geoms[i].contains(centroid):
            return codes[i]

    return None

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

def extract_geojson_from_tif(tif_path, output_path, target_res, simplify_tol, sieve_size, skip_dissolve,
                             country_index=None, country_geoms=None, country_codes=None):
    """
    Extract GeoJSON polygons from a single GeoTIFF file with optimization.

    Dissolves adjacent grid cells with the same anthrome value into unified polygons
    to dramatically reduce file size and feature count.

    Args:
        tif_path: Path to input GeoTIFF file
        output_path: Path to output GeoJSON file
        country_index: Optional STRtree for country lookup
        country_geoms: Optional list of country geometries
        country_codes: Optional list of ISO3 codes
    """
    from collections import defaultdict

    with rasterio.open(tif_path) as src:
        # Read raster data (optionally resample first)
        image, transform = resample_categorical(src, target_res)

        # Compute grid dimensions for cellId calculation
        num_rows, num_cols = image.shape

        # Drop very small slivers before polygonization (optional)
        if sieve_size and sieve_size > 0:
            image = sieve(image, size=sieve_size, connectivity=8)

        # Determine nodata value (skip only true nodata, keep all anthrome codes)
        nodata_value = src.nodata if src.nodata is not None else -1

        features = []

        if skip_dissolve:
            # Create individual cell polygons by iterating through the grid
            # This guarantees each cell is its own polygon (no merging of same-value neighbors)
            origin_x = transform.c  # left edge
            origin_y = transform.f  # top edge
            pixel_width = transform.a
            pixel_height = -transform.e  # positive value (y decreases downward)

            for row in range(num_rows):
                for col in range(num_cols):
                    anthrome_code = int(image[row, col])

                    if anthrome_code == nodata_value:
                        continue

                    # Compute cell bounds
                    min_x = origin_x + col * pixel_width
                    max_x = min_x + pixel_width
                    max_y = origin_y - row * pixel_height
                    min_y = max_y - pixel_height

                    # Create box polygon for this cell
                    geom_shape = box(min_x, min_y, max_x, max_y)

                    # Normalize winding so D3 interprets polygons, not complements
                    geom_shape = orient_geometry(geom_shape, sign=-1.0)

                    # Compute cellId
                    cell_id = row * num_cols + col

                    # Build properties (shortened names for file size reduction)
                    props = {'a': anthrome_code, 'i': cell_id}

                    # Add country if boundary data available
                    if country_index is not None:
                        centroid_x = (min_x + max_x) / 2
                        centroid_y = (min_y + max_y) / 2
                        country = lookup_country(Point(centroid_x, centroid_y), country_index, country_geoms, country_codes)
                        props['c'] = country  # may be None for ocean cells

                    features.append({
                        'type': 'Feature',
                        'geometry': mapping(geom_shape),
                        'properties': props
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
                        'a': anthrome_code
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

    # Load country boundaries if provided
    country_index, country_geoms, country_codes = None, None, None
    if args.boundaries:
        if args.boundaries.exists():
            country_index, country_geoms, country_codes = load_country_boundaries(args.boundaries)
            if country_index:
                print(f"   Country lookup: enabled")
            else:
                print(f"   Country lookup: failed to load")
        else:
            print(f"   ⚠️  Boundaries file not found: {args.boundaries}")

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
                country_index=country_index,
                country_geoms=country_geoms,
                country_codes=country_codes,
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
