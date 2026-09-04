"""
The country sets, shared by 2c_generate_country_sets.py and 5_smooth_boundaries.py.

Both scripts have to agree on the id field, because the app joins them on it: the
grid's countryTable holds the code a cell belongs to, and the boundary overlay's
feature `id` is what the highlight ring, focus framing and tooltip look up. Pick
ADM0_A3 in one and ISO_A3_EH in the other and every dependency silently stops
resolving. So the choice lives here once.

ADM0_A3 rather than ISO_A3_EH for everything but the 110m baseline: it is unique
per feature in all three files, and it carries codes for Kosovo, Somaliland and
N. Cyprus, which an ISO3 join drops entirely.

The 10m sets stay here because the README's comparison table cites them and
should be reproducible, but they are not built by default and not committed —
50m carries the whole Caribbean and still fits in a uint8, which is the whole
reason to prefer it. See SHIPPED below.
"""

from pathlib import Path

import shapefile  # pyshp
from shapely.geometry import shape

# `simplify` is the default topology-simplify threshold in square degrees for
# that set's geometry — 10m is 21MB of raw coastline and needs thinning, 110m
# and 50m do not. Verified not to drop any Caribbean island at these values.
SETS = {
    '110m': {
        'shp': 'ne_110m_admin_0_countries/ne_110m_admin_0_countries.shp',
        'id_field': 'ISO_A3_EH',
        'label': 'NE 110m countries',
        'note': 'baseline — no territories',
        'simplify': 0.0,
    },
    '50m': {
        'shp': 'ne_50m_admin_0_countries/ne_50m_admin_0_countries.shp',
        'id_field': 'ADM0_A3',
        'label': 'NE 50m countries',
        'note': 'countries + dependencies',
        'simplify': 0.0,
    },
    '10m': {
        'shp': 'ne_10m_admin_0_countries/ne_10m_admin_0_countries.shp',
        'id_field': 'ADM0_A3',
        'label': 'NE 10m countries',
        'note': 'countries + dependencies, 10m detail',
        'simplify': 1e-3,
    },
    '10m-units': {
        'shp': 'ne_10m_admin_0_map_units/ne_10m_admin_0_map_units.shp',
        'id_field': 'GU_A3',
        'label': 'NE 10m map units',
        'note': 'splits France into its overseas departments',
        'simplify': 1e-3,
    },
}


# What the app offers and what a default pipeline run builds. The 110m baseline
# is already baked into every profile by 2b_generate_grid.py, so only 50m needs
# generating — see SHIPPED_GENERATED.
SHIPPED = ['110m', '50m']

# The subset of SHIPPED that 2c/5 actually have to produce. 110m is excluded
# because countries.bin and manifest.countryTable already are the 110m set; a
# sidecar for it would only be a second copy that could drift.
SHIPPED_GENERATED = ['50m']


def resolve(data_dir, key):
    """The set's spec with an absolute shapefile path, or exit with how to get it."""
    if key not in SETS:
        raise SystemExit(f'Unknown set "{key}". Known: {", ".join(SETS)}')
    spec = dict(SETS[key])
    spec['path'] = Path(data_dir) / spec['shp']
    if not spec['path'].exists():
        raise SystemExit(
            f'Set "{key}" needs {spec["path"]}\n'
            f'  Download it from https://naciscdn.org/naturalearth/ and unzip into {data_dir}/'
        )
    return spec


def read_features(shp_path, id_field, name_field='NAME'):
    """(code, name, geometry) per feature, in shapefile order.

    The order matters: it is what assigns country-table indices in
    2c_generate_country_sets.py, and reproducing it is what lets that script's
    --verify compare against a countries.bin that 2b wrote. The two skips below
    are 2b_generate_grid.py's, kept identical for the same reason.
    """
    sf = shapefile.Reader(str(shp_path))
    fields = [f[0] for f in sf.fields[1:]]
    if id_field not in fields:
        raise SystemExit(f'{Path(shp_path).name}: no {id_field} field (has {len(fields)} fields)')
    id_idx = fields.index(id_field)
    name_idx = fields.index(name_field) if name_field in fields else None

    out = []
    skipped = 0
    for rec in sf.shapeRecords():
        code = rec.record[id_idx]
        if not code or code == '-99':
            skipped += 1
            continue
        geom = shape(rec.shape.__geo_interface__)
        if not geom.is_valid:
            skipped += 1
            continue
        name = rec.record[name_idx] if name_idx is not None else 'Unknown'
        out.append((code, name, geom))
    return out, skipped
