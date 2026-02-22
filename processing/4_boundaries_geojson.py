#!/usr/bin/env python3
"""
Generate grid-snapped admin boundary GeoJSON from Natural Earth shapefile.

Rasterizes country boundaries to the same grid as anthrome data, then
re-vectorizes to create boundaries that align perfectly with anthrome cells.

This produces "blocky" boundaries at the anthrome resolution, which is useful
for visual alignment but may lose detail at coarse resolutions.

Usage:
    python 4_boundaries_geojson.py --profile=10km --target-res=0.20
    python 4_boundaries_geojson.py --profile=50km --target-res=0.45

Output: processing/geojson/admin-boundaries/{profile}/countries.geojson
"""

import json
from pathlib import Path
import argparse
import numpy as np
import rasterio
from rasterio.features import shapes, rasterize
from rasterio.transform import from_origin
import shapefile  # pyshp - pure Python, no GDAL needed
from shapely.geometry import shape, mapping
from shapely.geometry.polygon import orient
import warnings

warnings.filterwarnings('ignore', category=rasterio.errors.NotGeoreferencedWarning)

# Default paths
DEFAULT_SHAPEFILE = Path('../data/ne_110m_admin_0_countries/ne_110m_admin_0_countries.shp')
DEFAULT_OUTPUT_DIR = Path('geojson/admin-boundaries')

# World bounds in WGS84
WORLD_BOUNDS = (-180, -90, 180, 90)


def parse_args():
    parser = argparse.ArgumentParser(
        description='Generate grid-snapped admin boundary GeoJSON'
    )
    parser.add_argument(
        '--input', type=Path, default=DEFAULT_SHAPEFILE,
        help='Input shapefile path'
    )
    parser.add_argument(
        '--output-dir', type=Path, default=DEFAULT_OUTPUT_DIR,
        help='Base output directory for GeoJSON'
    )
    parser.add_argument(
        '--profile', type=str, required=True,
        help='Profile name (used as subfolder, e.g., "10km", "50km")'
    )
    parser.add_argument(
        '--target-res', type=float, required=True,
        help='Target resolution in degrees (e.g., 0.20 for ~22km, 0.45 for ~50km)'
    )
    parser.add_argument(
        '--id-field', type=str, default='ISO_A3',
        help='Shapefile field to use as country identifier'
    )
    parser.add_argument(
        '--name-field', type=str, default='NAME',
        help='Shapefile field to use as country name'
    )
    return parser.parse_args()


def orient_geometry(geom, sign=-1.0):
    """
    Orient Polygon/MultiPolygon for D3 compatibility.
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


def read_shapefile(shp_path, id_field, name_field):
    """
    Read shapefile using pyshp and return list of (geometry, code) tuples.
    Also builds a mapping of numeric code to country info.
    """
    countries = []
    code_to_info = {}

    sf = shapefile.Reader(str(shp_path))
    fields = [f[0] for f in sf.fields[1:]]  # Skip DeletionFlag

    print(f"   Fields: {fields}")
    print(f"   Features: {len(sf)}")

    # Find field indices
    id_idx = fields.index(id_field) if id_field in fields else None
    name_idx = fields.index(name_field) if name_field in fields else None

    if id_idx is None:
        print(f"   Warning: '{id_field}' not found, using index as ID")
    if name_idx is None:
        print(f"   Warning: '{name_field}' not found, using 'Unknown'")

    for idx, shp_record in enumerate(sf.shapeRecords(), start=1):
        # Convert pyshp shape to shapely geometry
        geom = shape(shp_record.shape.__geo_interface__)
        record = shp_record.record

        country_id = record[id_idx] if id_idx is not None else f'UNK_{idx}'
        country_name = record[name_idx] if name_idx is not None else 'Unknown'

        # Use sequential numeric code for rasterization
        code = idx
        code_to_info[code] = {
            'id': country_id,
            'name': country_name
        }

        countries.append((geom, code))

    return countries, code_to_info


def rasterize_countries(countries, target_res):
    """
    Rasterize country polygons to a global grid at the target resolution.
    Returns the raster array and transform.
    """
    left, bottom, right, top = WORLD_BOUNDS

    width = int(np.ceil((right - left) / target_res))
    height = int(np.ceil((top - bottom) / target_res))

    transform = from_origin(left, top, target_res, target_res)

    print(f"   Raster size: {width} x {height} pixels")
    print(f"   Resolution: {target_res}° (~{target_res * 111:.1f} km at equator)")

    # Create list of (geometry, value) for rasterization
    shapes_to_rasterize = [(mapping(geom), code) for geom, code in countries]

    # Rasterize with all_touched=False for cleaner boundaries
    raster = rasterize(
        shapes_to_rasterize,
        out_shape=(height, width),
        transform=transform,
        fill=0,  # nodata
        dtype=np.int16,
        all_touched=False
    )

    return raster, transform


def vectorize_raster(raster, transform, code_to_info):
    """
    Convert rasterized countries back to vector polygons.
    Returns GeoJSON features.
    """
    features = []

    for geom_dict, value in shapes(raster, transform=transform):
        code = int(value)

        # Skip nodata (0)
        if code == 0:
            continue

        info = code_to_info.get(code, {'id': 'UNK', 'name': 'Unknown'})

        geom = shape(geom_dict)
        geom = orient_geometry(geom, sign=-1.0)

        features.append({
            'type': 'Feature',
            'geometry': mapping(geom),
            'properties': {
                'id': info['id'],
                'name': info['name']
            }
        })

    return features


def main():
    args = parse_args()

    input_path = args.input
    output_dir = args.output_dir / args.profile
    output_path = output_dir / 'countries.geojson'

    print(f"\n{'='*60}")
    print("Grid-Snapped Admin Boundaries Generator")
    print(f"{'='*60}\n")

    # Check input exists
    if not input_path.exists():
        print(f"ERROR: Shapefile not found: {input_path}")
        return 1

    print(f"Input:  {input_path}")
    print(f"Output: {output_path}")
    print(f"Profile: {args.profile}")
    print(f"Resolution: {args.target_res}°\n")

    # Step 1: Read shapefile
    print("Step 1: Reading shapefile...")
    countries, code_to_info = read_shapefile(
        input_path, args.id_field, args.name_field
    )
    print(f"   Loaded {len(countries)} countries\n")

    # Step 2: Rasterize
    print("Step 2: Rasterizing to grid...")
    raster, transform = rasterize_countries(countries, args.target_res)
    unique_codes = len(np.unique(raster)) - 1  # subtract nodata
    print(f"   Countries in raster: {unique_codes}\n")

    # Step 3: Vectorize
    print("Step 3: Vectorizing back to polygons...")
    features = vectorize_raster(raster, transform, code_to_info)
    print(f"   Generated {len(features)} features\n")

    # Step 4: Write GeoJSON
    print("Step 4: Writing GeoJSON...")
    output_dir.mkdir(parents=True, exist_ok=True)

    geojson = {
        'type': 'FeatureCollection',
        'features': features
    }

    with open(output_path, 'w') as f:
        json.dump(geojson, f, separators=(',', ':'))

    file_size_kb = output_path.stat().st_size / 1024
    print(f"   Size: {file_size_kb:.1f} KB\n")

    print(f"{'='*60}")
    print("Done!")
    print(f"{'='*60}\n")
    print(f"Next step: Convert to TopoJSON with:")
    print(f"  node 2_generate_topojson.js \\")
    print(f"    --input=geojson/admin-boundaries/{args.profile} \\")
    print(f"    --output=../public/topojson/admin-boundaries/{args.profile} \\")
    print(f"    --quantization=1e4\n")

    return 0


if __name__ == '__main__':
    exit(main())
