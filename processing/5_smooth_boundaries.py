#!/usr/bin/env python3
"""
Generate smooth (non-pixelated) admin boundary GeoJSON from Natural Earth shapefile.

Unlike 4_boundaries_geojson.py, this preserves the original vector geometry
without rasterization, maintaining smooth curves suitable for overlay display.

Usage:
    python3 5_smooth_boundaries.py

Output: processing/geojson/admin-boundaries/smooth/countries.geojson
"""

import json
from pathlib import Path
import shapefile
from shapely.geometry import shape, mapping
from shapely.geometry.polygon import orient

DEFAULT_SHAPEFILE = Path('../data/ne_110m_admin_0_countries/ne_110m_admin_0_countries.shp')
OUTPUT_PATH = Path('geojson/admin-boundaries/smooth/countries-110m.geojson')


def orient_geometry(geom, sign=-1.0):
    """Orient Polygon/MultiPolygon for D3 compatibility."""
    if geom.is_empty:
        return geom
    if geom.geom_type == 'Polygon':
        return orient(geom, sign=sign)
    if geom.geom_type == 'MultiPolygon':
        return type(geom)([orient(p, sign=sign) for p in geom.geoms])
    if hasattr(geom, 'geoms'):
        return type(geom)([orient_geometry(g, sign=sign) for g in geom.geoms])
    return geom


def main():
    print("\n" + "="*60)
    print("Smooth Admin Boundaries Generator")
    print("="*60 + "\n")

    if not DEFAULT_SHAPEFILE.exists():
        print(f"ERROR: Shapefile not found at {DEFAULT_SHAPEFILE}")
        return 1

    print(f"Reading shapefile: {DEFAULT_SHAPEFILE}")

    sf = shapefile.Reader(str(DEFAULT_SHAPEFILE))
    fields = [f[0] for f in sf.fields[1:]]

    print(f"Available fields: {', '.join(fields)}\n")

    iso_idx = fields.index('ISO_A3') if 'ISO_A3' in fields else None
    name_idx = fields.index('NAME') if 'NAME' in fields else None

    if iso_idx is None:
        print("ERROR: ISO_A3 field not found!")
        return 1

    features = []

    print("Processing features...")
    for rec in sf.shapeRecords():
        geom = shape(rec.shape.__geo_interface__)
        geom = orient_geometry(geom, sign=-1.0)

        iso3 = rec.record[iso_idx]
        name = rec.record[name_idx] if name_idx is not None else 'Unknown'

        # Skip features with invalid ISO3 codes (like "-99")
        if not iso3 or iso3.startswith('-'):
            print(f"  Skipping {name} (invalid ISO3: {iso3})")
            continue

        features.append({
            'type': 'Feature',
            'geometry': mapping(geom),
            'properties': {
                'id': iso3,      # ISO3 code for lookup
                'name': name     # Display name
            }
        })

    geojson = {
        'type': 'FeatureCollection',
        'features': features
    }

    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    with open(OUTPUT_PATH, 'w') as f:
        json.dump(geojson, f, separators=(',', ':'))

    file_size_kb = OUTPUT_PATH.stat().st_size / 1024

    print(f"\n{'='*60}")
    print(f"Generated {len(features)} features")
    print(f"Output: {OUTPUT_PATH}")
    print(f"Size: {file_size_kb:.1f} KB")
    print(f"{'='*60}\n")

    print("Next steps:")
    print("  1. Convert to TopoJSON:")
    print("     node 2_generate_topojson.js \\")
    print("       --input=geojson/admin-boundaries/smooth \\")
    print("       --output=temp-smooth-topo \\")
    print("       --quantization=1e5")
    print()
    print("  2. Replace the existing file:")
    print("     copy /Y temp-smooth-topo\\countries.topojson ..\\public\\topojson\\admin-boundaries\\countries-110m.topojson")
    print("     rmdir /S /Q temp-smooth-topo")
    print()

    return 0


if __name__ == '__main__':
    exit(main())
