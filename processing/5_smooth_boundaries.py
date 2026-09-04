#!/usr/bin/env python3
"""
Generate smooth (non-pixelated) admin boundary GeoJSON from a Natural Earth shapefile.

Unlike 4_boundaries_geojson.py, this preserves the original vector geometry
without rasterization, maintaining smooth curves suitable for overlay display.

Which shapefile and which id field come from country_sets.py, so the overlay's
feature ids are guaranteed to match the codes 2c_generate_country_sets.py burns
into countries-<set>.bin. The app joins the two on that id — the highlight ring,
focus framing and tooltip all look a cell's country code up in the overlay — so
they cannot be chosen independently.

Usage:
    python3 5_smooth_boundaries.py                   # the sets that ship
    python3 5_smooth_boundaries.py --set=50m         # one
    python3 5_smooth_boundaries.py --set=10m         # a comparison set

Output: processing/geojson/admin-boundaries/smooth/countries-<set>.geojson
Then:   node 2_generate_topojson.js --input=geojson/admin-boundaries/smooth \
              --output=../public/topojson/admin-boundaries --quantization=1e5 \
              --only=countries-<set>

Both shipped overlays are committed. Regenerating 110m rewrites it with a
byte-identical file, so a no-op diff there is the expected result, not a change.
"""

import argparse
import json
from pathlib import Path

from shapely.geometry import mapping
from shapely.geometry.polygon import orient

from country_sets import SETS, SHIPPED, read_features, resolve

OUTPUT_DIR = Path('geojson/admin-boundaries/smooth')


def parse_args():
    p = argparse.ArgumentParser(description='Generate smooth admin boundary GeoJSON')
    p.add_argument('--set', dest='sets', type=str, default=','.join(SHIPPED),
                   help=f'Comma-separated sets from: {", ".join(SETS)}. '
                        f'Default is what ships ({", ".join(SHIPPED)}).')
    p.add_argument('--data-dir', type=Path, default=Path('../data'),
                   help='Directory holding the Natural Earth shapefile folders')
    p.add_argument('--output-dir', type=Path, default=OUTPUT_DIR,
                   help='Where to write the GeoJSON')
    return p.parse_args()


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
    args = parse_args()
    set_keys = [s for s in args.sets.split(',') if s]

    print('\n' + '=' * 60)
    print('Smooth Admin Boundaries Generator')
    print('=' * 60 + '\n')

    args.output_dir.mkdir(parents=True, exist_ok=True)
    simplify_for = {}

    for key in set_keys:
        spec = resolve(args.data_dir, key)
        feats, skipped = read_features(spec['path'], spec['id_field'])

        features = [{
            'type': 'Feature',
            'geometry': mapping(orient_geometry(geom)),
            'properties': {
                'id': code,    # joins to the grid's country table
                'name': name   # display name; MapCanvas backfills iso3_names from these
            }
        } for code, name, geom in feats]

        out = args.output_dir / f'countries-{key}.geojson'
        out.write_text(json.dumps(
            {'type': 'FeatureCollection', 'features': features}, separators=(',', ':')))

        simplify_for[key] = spec['simplify']
        print(f'  {key:10s} {len(features):4d} features via {spec["id_field"]:9s} '
              f'{out.stat().st_size / 1024:8.1f} KB'
              + (f'  ({skipped} skipped)' if skipped else ''))

    print(f'\nWrote {len(set_keys)} file(s) to {args.output_dir}\n')
    print('Next: convert to TopoJSON. Sets differ in how much thinning they need —')
    print('10m is 21MB of raw coastline, 110m and 50m are already coarse — so run')
    print('them in groups by --simplification:\n')
    groups = {}
    for key, s in simplify_for.items():
        groups.setdefault(s, []).append(key)
    for s, keys in sorted(groups.items()):
        print(f'  # {", ".join(keys)}')
        print(f'  node 2_generate_topojson.js \\')
        print(f'    --input={args.output_dir} --output=../public/topojson/admin-boundaries \\')
        print(f'    --quantization=1e5 --simplification={s} --only={",".join(f"countries-{k}" for k in keys)}')
    print()
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
