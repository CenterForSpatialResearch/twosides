#!/usr/bin/env python3
"""
Emit the grid format: HYDE anthrome GeoTIFFs -> compact per-profile binary blobs.

This replaces steps 1+2 (GeoJSON -> TopoJSON) for map rendering. It reads the
GeoTIFFs *directly* — no polygonization, no GeoJSON intermediate — because the
source is already a raster and the grid format is a raster. That is also what
makes 10km feasible at all; going through per-cell GeoJSON would materialize
tens of GB for the same information.

Why not TopoJSON (measured on temp/topojson/33km/2025AD.topojson):
  - Topology emits MORE coordinates than the source GeoJSON (938,797 arc points
    vs 912,515), because in a regular grid every cell corner is a junction, so
    every shared edge becomes a 2-point arc that re-duplicates its end nodes.
  - Coordinates are only 35% of the file. The other 65% is the per-feature
    object table, which topology cannot touch.
  - Geometry, cellId and country are byte-identical across all 76 years. Only
    the anthrome code changes, so the other three need shipping exactly once.

Output, per profile, into <output-dir>/<profile>/:

  manifest.json   grid geometry, year list, country lookup table
  mask.bin        1 bit per grid cell, row-major, MSB-first. Set = land.
  codes.bin       nLand * nYears bytes, YEAR-MAJOR: year k is at [k*nLand,
                  (k+1)*nLand), land cells in ascending cellId order.
                  One anthrome code per byte; 0 = nodata.
  countries.bin   nLand bytes, index into manifest.countryTable.

cellId = row * ncols + col, matching compute_cell_id() in 1_extract_geojson.py,
so existing cellId-keyed artifacts (anthrome-change-years-*.json, zooms-*.json)
stay valid.

Usage:
  python3 2b_generate_grid.py --profile=33km --target-res=0.30
  python3 2b_generate_grid.py --profile=10km --target-res=0      # native grid
"""

import argparse
import json
import re
import sys
from pathlib import Path

import numpy as np
import rasterio
import shapefile  # pyshp
import warnings
from rasterio.crs import CRS
from rasterio.enums import Resampling
from rasterio.features import rasterize
from rasterio.transform import from_origin
from rasterio.warp import reproject
from shapely.geometry import shape

warnings.filterwarnings('ignore', category=rasterio.errors.NotGeoreferencedWarning)

# Anthrome codes run 11-70 and never use 0, so 0 is free as the nodata sentinel
# and everything fits in a uint8. Asserted against the legend at runtime.
NODATA_CODE = 0


def parse_args():
    p = argparse.ArgumentParser(description='Generate grid-format blobs from anthrome GeoTIFFs')
    p.add_argument('--input-dir', type=Path,
                   default=Path('../data/HYDE-3.5/baseline/anthromes_geotiff'),
                   help='Directory containing anthrome GeoTIFFs')
    p.add_argument('--output-dir', type=Path, default=Path('../temp/grid'),
                   help='Base output directory (a <profile>/ subfolder is created)')
    p.add_argument('--profile', type=str, required=True,
                   help='Profile name, used as the output subfolder')
    p.add_argument('--target-res', type=float, required=True,
                   help='Target resolution in degrees; 0 keeps the native grid')
    p.add_argument('--boundaries', type=Path,
                   default=Path('../data/ne_110m_admin_0_countries/ne_110m_admin_0_countries.shp'),
                   help='Natural Earth shapefile for the country lookup')
    p.add_argument('--years-from', type=str, default='../temp/topojson/33km',
                   help='Directory whose filenames define the year list, or "all"')
    p.add_argument('--legend', type=Path, default=Path('../temp/data/anthrome-legend.json'),
                   help='Legend JSON, used to sanity-check the nodata sentinel')
    return p.parse_args()


# --- year handling -----------------------------------------------------------

_YEAR_RE = re.compile(r'^(\d+)(BC|AD)$')


def year_sort_key(year):
    """Chronological order: 10000BC < 1000BC < 0AD < 2025AD."""
    m = _YEAR_RE.match(year)
    if not m:
        return 0
    n, era = int(m.group(1)), m.group(2)
    return -n if era == 'BC' else n


def resolve_years(input_dir, years_from):
    """Year list, chronologically ordered, intersected with available GeoTIFFs."""
    available = {p.stem.replace('anthromes', '') for p in input_dir.glob('anthromes*.tif')}
    if not available:
        sys.exit(f"No anthromes*.tif found in {input_dir}")

    if years_from == 'all':
        wanted = available
    else:
        ref = Path(years_from)
        if not ref.is_dir():
            print(f"   years-from {ref} not found; using all {len(available)} GeoTIFF years")
            wanted = available
        else:
            wanted = {p.stem for p in ref.glob('*.topojson')}
            missing = wanted - available
            if missing:
                print(f"   ⚠️  {len(missing)} reference year(s) have no GeoTIFF: "
                      f"{', '.join(sorted(missing, key=year_sort_key))}")
            wanted &= available

    return sorted(wanted, key=year_sort_key)


# --- raster ------------------------------------------------------------------

def resample_categorical(src, target_res):
    """Mode-resample to target_res. Lifted from 1_extract_geojson.py so the two
    pipelines land cells on exactly the same grid."""
    if target_res is None or target_res <= 0:
        return src.read(1), src.transform

    src_crs = src.crs or CRS.from_epsg(4326)
    b = src.bounds
    dst_width = int(np.ceil((b.right - b.left) / target_res))
    dst_height = int(np.ceil((b.top - b.bottom) / target_res))
    dst_transform = from_origin(b.left, b.top, target_res, target_res)

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


def read_year(input_dir, year, target_res):
    with rasterio.open(input_dir / f'anthromes{year}.tif') as src:
        image, transform = resample_categorical(src, target_res)
        nodata = src.nodata if src.nodata is not None else -1
        return image, transform, nodata


# --- countries ---------------------------------------------------------------

def build_country_raster(shp_path, shape_hw, transform):
    """Burn one country index per grid cell in a single rasterize() call.

    1_extract_geojson.py does a per-cell STRtree point lookup instead, which at
    10km would be 2.2M point-in-polygon tests per year. This is one pass, once.

    Reads ISO_A3_EH rather than ISO_A3: the 110m shapefile carries '-99' in
    ISO_A3 for France, Norway, N. Cyprus, Somaliland and Kosovo. ISO_A3_EH has
    the real codes for France and Norway; the other three have no ISO3 in either
    field and are left unassigned.
    """
    if not shp_path.exists():
        print(f"   ⚠️  Boundaries not found at {shp_path} — country codes will be null")
        return np.zeros(shape_hw, dtype=np.uint8), [None]

    sf = shapefile.Reader(str(shp_path))
    fields = [f[0] for f in sf.fields[1:]]
    if 'ISO_A3_EH' in fields:
        iso_idx = fields.index('ISO_A3_EH')
    elif 'ISO_A3' in fields:
        print("   ⚠️  ISO_A3_EH missing; falling back to ISO_A3 (France/Norway will be -99)")
        iso_idx = fields.index('ISO_A3')
    else:
        print("   ⚠️  No ISO3 field — country codes will be null")
        return np.zeros(shape_hw, dtype=np.uint8), [None]

    # Index 0 is reserved for "no country".
    table = [None]
    code_to_index = {}
    shapes_and_values = []
    skipped = []

    for rec in sf.shapeRecords():
        iso3 = rec.record[iso_idx]
        if not iso3 or iso3 == '-99':
            skipped.append(rec.record[fields.index('NAME')] if 'NAME' in fields else '?')
            continue
        geom = shape(rec.shape.__geo_interface__)
        if not geom.is_valid:
            continue
        if iso3 not in code_to_index:
            code_to_index[iso3] = len(table)
            table.append(iso3)
        shapes_and_values.append((geom, code_to_index[iso3]))

    if len(table) > 256:
        sys.exit(f"Country table has {len(table)} entries; does not fit in uint8")

    raster = rasterize(
        shapes_and_values,
        out_shape=shape_hw,
        transform=transform,
        fill=0,
        dtype='uint8',
    )
    print(f"   Countries: {len(table) - 1} codes burned"
          + (f"; {len(skipped)} left unassigned ({', '.join(skipped)})" if skipped else ""))
    return raster, table


# --- main --------------------------------------------------------------------

def main():
    args = parse_args()

    if args.legend.exists():
        legend = json.load(open(args.legend))
        codes = {int(k) for k in legend}
        if NODATA_CODE in codes:
            sys.exit(f"Legend uses code {NODATA_CODE}; it cannot be the nodata sentinel")
        if max(codes) > 255:
            sys.exit(f"Legend has code {max(codes)} > 255; uint8 is not enough")

    years = resolve_years(args.input_dir, args.years_from)
    if not years:
        sys.exit("No years to process")

    out_dir = args.output_dir / args.profile
    out_dir.mkdir(parents=True, exist_ok=True)

    print(f"📁 profile {args.profile}  |  target-res {args.target_res or 'native'}°  "
          f"|  {len(years)} years")
    print(f"   Output: {out_dir}")

    # --- pass 1: grid geometry + land mask ---------------------------------
    # The mask is the union of land across every year, so a cell that is nodata
    # in some years still gets a stable slot. The 75km data says the land set is
    # constant, but this must not assume it.
    print("\n▶ Pass 1/2: land mask")
    image, transform, nodata = read_year(args.input_dir, years[0], args.target_res)
    nrows, ncols = image.shape
    land = image != nodata
    varied = []

    for i, year in enumerate(years[1:], 2):
        img, _, nd = read_year(args.input_dir, year, args.target_res)
        if img.shape != (nrows, ncols):
            sys.exit(f"{year}: grid {img.shape} != {(nrows, ncols)} from {years[0]}")
        this_land = img != nd
        if not np.array_equal(this_land, land):
            varied.append(year)
        land |= this_land
        if i % 20 == 0 or i == len(years):
            print(f"   [{i:3d}/{len(years)}] {year}")

    if varied:
        print(f"   ⚠️  land set varies in {len(varied)} year(s): "
              f"{', '.join(varied[:8])}{' …' if len(varied) > 8 else ''}")
        print("      Using the union; those cells read as 0 in the years they are absent.")

    land_flat = land.reshape(-1)
    land_idx = np.flatnonzero(land_flat)          # land slot j -> cellId
    n_land = int(land_idx.size)
    print(f"   grid {ncols}x{nrows} = {nrows * ncols:,} cells, {n_land:,} land")

    # --- countries ---------------------------------------------------------
    print("\n▶ Countries")
    country_raster, country_table = build_country_raster(
        args.boundaries, (nrows, ncols), transform)
    countries = country_raster.reshape(-1)[land_idx].astype(np.uint8)

    # --- pass 2: codes ------------------------------------------------------
    print("\n▶ Pass 2/2: codes")
    codes_path = out_dir / 'codes.bin'
    with open(codes_path, 'wb') as fh:
        for i, year in enumerate(years, 1):
            img, _, nd = read_year(args.input_dir, year, args.target_res)
            flat = img.reshape(-1)
            row = flat[land_idx]
            row = np.where(row == nd, NODATA_CODE, row).astype(np.uint8)
            fh.write(row.tobytes())
            if i % 20 == 0 or i == len(years):
                print(f"   [{i:3d}/{len(years)}] {year}")

    # --- write the rest -----------------------------------------------------
    # bitorder='big' so JS reads bit j as byte[j>>3] & (0x80 >> (j&7)).
    (out_dir / 'mask.bin').write_bytes(np.packbits(land_flat, bitorder='big').tobytes())
    (out_dir / 'countries.bin').write_bytes(countries.tobytes())

    res = args.target_res if args.target_res and args.target_res > 0 else abs(transform.a)
    manifest = {
        'version': 1,
        'profile': args.profile,
        'res': res,
        'originX': transform.c,
        'originY': transform.f,
        'ncols': int(ncols),
        'nrows': int(nrows),
        'nLand': n_land,
        'years': years,
        'countryTable': country_table,
        'files': {'mask': 'mask.bin', 'codes': 'codes.bin', 'countries': 'countries.bin'},
    }
    (out_dir / 'manifest.json').write_text(json.dumps(manifest))

    total = sum(p.stat().st_size for p in out_dir.iterdir())
    print(f"\n✅ {args.profile}: {total / 1048576:.1f} MB total "
          f"({codes_path.stat().st_size / 1048576:.1f} MB codes, {len(years)} years)")


if __name__ == '__main__':
    main()
