#!/usr/bin/env python3
"""
Burn alternative country sets onto an already-built grid profile.

2b_generate_grid.py bakes exactly one country attribution — Natural Earth 110m,
ISO_A3_EH — into countries.bin and manifest.countryTable. That file has no
territories: the whole Lesser Antilles is absent, so the Caribbean draws no
country lines and none of those places is selectable.

This script adds the alternatives *alongside* the baked-in one, so they can be
compared on screen without rebuilding anything expensive. It reads the profile's
manifest.json and mask.bin and never opens a GeoTIFF, because the land mask is
the only thing from the raster that country attribution depends on — a few
seconds per profile against the two full passes over 76 GeoTIFFs that 2b costs.

Output, per profile, into <grid-dir>/<profile>/:

  countries-<set>.bin   nLand entries, one per land cell in ascending cellId
                        order — same layout as countries.bin. uint8 while the
                        table fits in 256 entries, little-endian uint16 above
                        that. Index into that set's table.
  country-sets.json     {"sets": {<set>: {file, bits, table, ...}}}

Only 50m is generated and committed. The app's other option, 110m, needs no
sidecar: countries.bin and manifest.countryTable already are the 110m set, and
a second copy could only drift from it.

The sets, and why 50m:

  110m       what 2b bakes in, and what the app has always drawn. First-order
             countries only. Can still be built here, which is what --verify
             uses to prove this script reproduces countries.bin byte for byte.
  50m        every sovereign state plus every dependency, 242 codes: the whole
             Caribbean, and it still fits in a uint8. This is what ships.
  10m        the same country concept at 10m detail, 258 codes — three past
             what a uint8 holds, so it would widen every profile's blob to
             uint16 for three entries. Kept buildable for comparison only.
  10m-units  splits France into its overseas departments, 298 codes, but also
             splits the UK into its four nations, Belgium into three regions
             and Bosnia into three. Comparison only.

ADM0_A3 rather than ISO_A3_EH for everything but the 110m baseline: it is
unique per feature in all three files, and it carries codes for Kosovo,
Somaliland and N. Cyprus, which an ISO3 join drops entirely.

Usage:
  python3 2c_generate_country_sets.py                       # every profile, 50m
  python3 2c_generate_country_sets.py --profiles=70km       # one profile
  python3 2c_generate_country_sets.py --sets=110m --no-orphan-rescue --verify
"""

import argparse
import json
import sys
from pathlib import Path

import numpy as np
from rasterio.features import rasterize
from rasterio.transform import from_origin

from country_sets import SETS, SHIPPED_GENERATED, read_features, resolve

# The set 2b_generate_grid.py bakes into every profile. It is deliberately never
# written as a sidecar — countries.bin and manifest.countryTable already are it,
# and gridSource.js reads them directly for this key. Requesting it here runs the
# burn for --verify's sake and writes nothing.
BASELINE = '110m'


def parse_args():
    p = argparse.ArgumentParser(description='Burn alternative country sets onto built grid profiles')
    p.add_argument('--grid-dir', type=Path, default=Path('../public/grid'),
                   help='Directory holding <profile>/manifest.json')
    p.add_argument('--data-dir', type=Path, default=Path('../data'),
                   help='Directory holding the Natural Earth shapefile folders')
    p.add_argument('--profiles', type=str, default='',
                   help='Comma-separated profiles; default is every one found in --grid-dir')
    p.add_argument('--sets', type=str, default=','.join(SHIPPED_GENERATED),
                   help=f'Comma-separated sets from: {", ".join(SETS)}. '
                        f'Default is what ships ({", ".join(SHIPPED_GENERATED)}); '
                        f'the 10m sets are for comparison and are not committed.')
    p.add_argument('--no-orphan-rescue', dest='orphan_rescue', action='store_false',
                   help='Skip the all_touched pass that gives sub-cell islands a cell')
    p.add_argument('--verify', action='store_true',
                   help='Check the 110m set reproduces the profile\'s countries.bin exactly')
    p.set_defaults(orphan_rescue=True)
    return p.parse_args()


# --- reading the built profile ----------------------------------------------

def read_profile(grid_dir, profile):
    """manifest, land cellIds, and the transform the profile was built on.

    land_idx is recovered from mask.bin rather than recomputed from the GeoTIFF,
    so this is by construction the same slot ordering codes.bin uses — slot j
    here is slot j there, which is what lets the output drop in beside it.
    """
    d = grid_dir / profile
    manifest = json.loads((d / 'manifest.json').read_text())

    mask_bytes = np.frombuffer((d / manifest['files']['mask']).read_bytes(), dtype=np.uint8)
    n_cells = manifest['ncols'] * manifest['nrows']
    # bitorder='big' matches how 2b packed it and how gridSource.js reads it.
    bits = np.unpackbits(mask_bytes, bitorder='big')[:n_cells]
    land_idx = np.flatnonzero(bits)

    if land_idx.size != manifest['nLand']:
        sys.exit(f'{profile}: mask has {land_idx.size} land cells, manifest says {manifest["nLand"]}')

    res = manifest['res']
    transform = from_origin(manifest['originX'], manifest['originY'], res, res)
    return manifest, land_idx, transform


# --- burning one set ---------------------------------------------------------

def burn(features, shape_hw, transform, orphan_rescue):
    """Country index per grid cell, plus the table those indices point into.

    Index 0 is reserved for "no country", matching countries.bin.

    The rescue pass exists because rasterize() only claims a cell whose *centre*
    the polygon covers, and at 70km a cell is 0.63° — wider than Barbados,
    Dominica or Grenada. Those countries otherwise get no cell at all and cannot
    be selected however good the boundary file is. So anything that came out
    empty gets a second pass with all_touched=True, written only into cells the
    first pass left unassigned: a country too small to own a cell centre gets
    the cell it overlaps, and no country that won a cell fairly loses it.

    Counter-intuitively this matters more at 10m than at 50m. A generalised 50m
    outline is fatter than the true coastline and catches centres the exact 10m
    outline misses — without the rescue, moving to 10m *loses* Puerto Rico at
    70km.
    """
    table = [None]
    code_to_index = {}
    pairs = []
    for code, _name, geom in features:
        if code not in code_to_index:
            code_to_index[code] = len(table)
            table.append(code)
        pairs.append((geom, code_to_index[code]))

    dtype = 'uint8' if len(table) <= 256 else 'uint16'
    raster = rasterize(pairs, out_shape=shape_hw, transform=transform, fill=0, dtype=dtype)

    rescued = 0
    if orphan_rescue:
        present = set(np.unique(raster).tolist()) - {0}
        orphans = [(g, v) for g, v in pairs if v not in present]
        if orphans:
            extra = rasterize(orphans, out_shape=shape_hw, transform=transform,
                              fill=0, dtype=dtype, all_touched=True)
            fill_here = (raster == 0) & (extra > 0)
            raster = np.where(fill_here, extra, raster)
            rescued = len(set(np.unique(extra[fill_here]).tolist()) - {0})

    return raster, table, dtype, rescued


def main():
    args = parse_args()

    unknown = [s for s in args.sets.split(',') if s and s not in SETS]
    if unknown:
        sys.exit(f'Unknown set(s): {", ".join(unknown)}. Known: {", ".join(SETS)}')
    set_keys = [s for s in args.sets.split(',') if s]

    # resolve() exits with the download URL if a shapefile is missing, so this
    # fails before any profile work rather than partway through.
    specs = {key: resolve(args.data_dir, key) for key in set_keys}

    if args.profiles:
        profiles = [p for p in args.profiles.split(',') if p]
    else:
        profiles = sorted(d.name for d in args.grid_dir.iterdir()
                          if d.is_dir() and (d / 'manifest.json').exists())
    if not profiles:
        sys.exit(f'No built profiles under {args.grid_dir}')

    print(f'Sets:     {", ".join(set_keys)}')
    print(f'Profiles: {", ".join(profiles)}')
    print(f'Orphan rescue: {"on" if args.orphan_rescue else "off"}\n')

    # Read each shapefile once, not once per profile — 10m is 21MB of geometry.
    features = {}
    for key in set_keys:
        spec = specs[key]
        feats, skipped = read_features(spec['path'], spec['id_field'])
        features[key] = feats
        codes = len({c for c, _, _ in feats})
        print(f'  {key:10s} {len(feats):4d} features, {codes:3d} codes'
              + (f', {skipped} skipped' if skipped else ''))
    print()

    for profile in profiles:
        manifest, land_idx, transform = read_profile(args.grid_dir, profile)
        shape_hw = (manifest['nrows'], manifest['ncols'])
        out_dir = args.grid_dir / profile
        print(f'▶ {profile}  {manifest["ncols"]}x{manifest["nrows"]}, '
              f'{manifest["nLand"]:,} land cells')

        sets_out = {}
        for key in set_keys:
            spec = specs[key]
            raster, table, dtype, rescued = burn(
                features[key], shape_hw, transform, args.orphan_rescue)
            cells = raster.reshape(-1)[land_idx]

            # '<u2' rather than the platform default: gridSource.js reads this
            # with a Uint16Array, which is little-endian on every browser target,
            # so pinning it here keeps the file portable.
            with_cells = len(set(np.unique(cells).tolist()) - {0})
            name = f'countries-{key}.bin'
            if key != BASELINE:
                arr = cells.astype('<u2' if dtype == 'uint16' else 'u1')
                (out_dir / name).write_bytes(arr.tobytes())
                sets_out[key] = {
                    'label': spec['label'],
                    'note': spec['note'],
                    'source': spec['path'].parent.name,
                    'idField': spec['id_field'],
                    'file': name,
                    'bits': 16 if dtype == 'uint16' else 8,
                    'table': table,
                    'withCells': with_cells,
                    'orphanRescue': bool(args.orphan_rescue),
                }

            flag = '  ← needs uint16' if dtype == 'uint16' else ''
            note = '  (baseline — verify only, nothing written)' if key == BASELINE else flag
            print(f'   {key:10s} table={len(table):3d} ({dtype})  '
                  f'{with_cells:3d} with cells'
                  + (f', {rescued} rescued' if rescued else '') + note)

            if args.verify and key == BASELINE:
                baked = np.frombuffer(
                    (out_dir / manifest['files']['countries']).read_bytes(), dtype=np.uint8)
                if args.orphan_rescue:
                    print('              (verify: skipped — rescue changes the burn; '
                          'rerun with --no-orphan-rescue)')
                elif np.array_equal(baked, cells) and table == manifest['countryTable']:
                    print('              ✓ verify: byte-identical to countries.bin')
                else:
                    diff = int((baked != cells).sum()) if baked.size == cells.size else -1
                    sys.exit(f'   ✗ verify FAILED: {diff} cells differ from countries.bin')

        if sets_out:
            (out_dir / 'country-sets.json').write_text(json.dumps({'sets': sets_out}))
            total = sum((out_dir / s['file']).stat().st_size for s in sets_out.values())
            print(f'   wrote {len(sets_out)} set(s), {total / 1024:.0f} KB\n')
        else:
            # Only the baseline was asked for, so there is nothing to write —
            # and country-sets.json is left alone rather than emptied.
            print('   nothing to write\n')

    print('✅ Done.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
