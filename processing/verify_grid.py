#!/usr/bin/env python3
"""
Correctness gate for the grid format.

Rebuilds a year's FeatureCollection from the grid blobs exactly the way the
browser loader does, then diffs it against the existing pipeline output for the
same profile+year:

  --against=geojson   processing/geojson/<profile>/<year>.geojson   (exact coords)
  --against=topojson  temp|public/topojson/<profile>/<year>.topojson (quantized,
                      so ring coordinates are compared within one lattice step)

Checks cell count, the {a, i, c} properties per cellId, and ring geometry
including vertex order — a reversed ring renders as the complement of the cell
in d3, which is the one silent failure mode of this format.

Country codes are EXPECTED to differ for France and Norway: the old pipeline
reads ISO_A3, which is '-99' for both in Natural Earth 110m, while the grid
producer reads ISO_A3_EH. Those are reported as fixes, not failures.

Usage:
  python3 verify_grid.py --profile=75km --year=2025AD --against=geojson
  python3 verify_grid.py --profile=33km --year=2025AD --against=topojson
"""

import argparse
import json
import sys
from pathlib import Path

import numpy as np

# Natural Earth 110m writes '-99' into ISO_A3 for France, Norway, N. Cyprus,
# Somaliland and Kosovo. The old pipeline passed that straight through. The grid
# producer reads ISO_A3_EH, which resolves France and Norway to FRA/NOR and
# leaves the other three unassigned. Any cell whose reference value is '-99' is
# therefore a known fix, not a regression.
BAD_ISO = '-99'


def parse_args():
    p = argparse.ArgumentParser(description='Verify grid-format output against the old pipeline')
    p.add_argument('--profile', required=True)
    p.add_argument('--year', required=True)
    p.add_argument('--against', choices=['geojson', 'topojson'], default='geojson')
    p.add_argument('--grid-dir', type=Path, default=Path('../temp/grid'))
    p.add_argument('--geojson-dir', type=Path, default=Path('geojson'))
    p.add_argument('--topojson-dir', type=Path, default=Path('../temp/topojson'))
    p.add_argument('--limit', type=int, default=0,
                   help='Only compare the first N cells (0 = all)')
    return p.parse_args()


# --- the grid loader, mirroring src/anthromes/lib/gridSource.js --------------

def load_grid(grid_dir, profile):
    d = grid_dir / profile
    manifest = json.loads((d / 'manifest.json').read_text())

    mask_bits = np.unpackbits(
        np.frombuffer((d / 'mask.bin').read_bytes(), dtype=np.uint8), bitorder='big')
    n_cells = manifest['ncols'] * manifest['nrows']
    land_idx = np.flatnonzero(mask_bits[:n_cells])

    if land_idx.size != manifest['nLand']:
        sys.exit(f"mask has {land_idx.size} land cells, manifest says {manifest['nLand']}")

    countries = np.frombuffer((d / 'countries.bin').read_bytes(), dtype=np.uint8)
    codes = np.frombuffer((d / 'codes.bin').read_bytes(), dtype=np.uint8)

    expected = manifest['nLand'] * len(manifest['years'])
    if codes.size != expected:
        sys.exit(f"codes.bin is {codes.size} bytes, expected {expected}")

    return manifest, land_idx, countries, codes


def features_for_year(manifest, land_idx, countries, codes, year):
    """One rect per land cell. Ring order matches orient_geometry(sign=-1) on a
    shapely box(), which is what 1_extract_geojson.py emits:
    (maxX,minY) (minX,minY) (minX,maxY) (maxX,maxY) (maxX,minY)."""
    yi = manifest['years'].index(year)
    n = manifest['nLand']
    slab = codes[yi * n:(yi + 1) * n]

    res = manifest['res']
    ox, oy = manifest['originX'], manifest['originY']
    ncols = manifest['ncols']
    table = manifest['countryTable']

    out = []
    for j in range(n):
        code = int(slab[j])
        if code == 0:
            continue
        cell_id = int(land_idx[j])
        row, col = divmod(cell_id, ncols)
        min_x = ox + col * res
        max_x = min_x + res
        max_y = oy - row * res
        min_y = max_y - res
        out.append({
            'i': cell_id,
            'a': code,
            'c': table[int(countries[j])],
            'ring': [(max_x, min_y), (min_x, min_y), (min_x, max_y),
                     (max_x, max_y), (max_x, min_y)],
        })
    return out


# --- reference readers -------------------------------------------------------

def read_geojson(path):
    d = json.loads(path.read_text())
    out = {}
    for f in d['features']:
        p = f['properties']
        ring = [tuple(c) for c in f['geometry']['coordinates'][0]]
        out[p['i']] = {'a': p['a'], 'c': p.get('c'), 'ring': ring}
    return out


def read_topojson(path):
    """Minimal decoder: delta-decode quantized arcs, then stitch rings."""
    t = json.loads(path.read_text())
    tr = t['transform']
    sx, sy = tr['scale']
    tx, ty = tr['translate']

    arcs = []
    for arc in t['arcs']:
        x = y = 0
        pts = []
        for dx, dy in arc:
            x += dx
            y += dy
            pts.append((x * sx + tx, y * sy + ty))
        arcs.append(pts)

    def stitch(indices):
        ring = []
        for idx in indices:
            pts = arcs[~idx][::-1] if idx < 0 else arcs[idx]
            ring.extend(pts[1:] if ring else pts)
        return ring

    obj = t['objects'][next(iter(t['objects']))]
    out = {}
    for g in obj['geometries']:
        p = g.get('properties', {})
        out[p['i']] = {'a': p['a'], 'c': p.get('c'), 'ring': stitch(g['arcs'][0])}
    return out, max(abs(sx), abs(sy))


# --- comparison --------------------------------------------------------------

def _open(ring):
    """Drop the repeated closing vertex."""
    return ring[:-1] if len(ring) > 1 and ring[0] == ring[-1] else list(ring)


def _rotate_canonical(pts):
    """Rotate to start at the lowest vertex, preserving direction.

    TopoJSON stitches each ring from arcs, so the ring begins at whichever
    corner a junction fell on — the same rectangle can come back rotated. That
    is invisible to d3, so it must not count as a mismatch. Direction is NOT
    normalized away: a reversed ring makes d3 fill the complement of the cell,
    which is the failure this check exists to catch.
    """
    k = min(range(len(pts)), key=lambda i: pts[i])
    return pts[k:] + pts[:k]


def _winding(pts):
    """Sign of the shoelace sum; +1 and -1 are opposite orientations."""
    s = sum((pts[i][0] - pts[i - 1][0]) * (pts[i][1] + pts[i - 1][1])
            for i in range(len(pts)))
    return 1 if s >= 0 else -1


def rings_match(a, b, tol):
    """Same rectangle and same winding, ignoring which corner it starts at."""
    pa, pb = _open(a), _open(b)
    if len(pa) != len(pb):
        return False
    if _winding(pa) != _winding(pb):
        return False
    ra, rb = _rotate_canonical(pa), _rotate_canonical(pb)
    return all(abs(p[0] - q[0]) <= tol and abs(p[1] - q[1]) <= tol
               for p, q in zip(ra, rb))


def main():
    args = parse_args()

    manifest, land_idx, countries, codes = load_grid(args.grid_dir, args.profile)
    if args.year not in manifest['years']:
        sys.exit(f"{args.year} not in manifest ({len(manifest['years'])} years)")

    mine = features_for_year(manifest, land_idx, countries, codes, args.year)
    mine_by_id = {f['i']: f for f in mine}

    if args.against == 'geojson':
        path = args.geojson_dir / args.profile / f'{args.year}.geojson'
        if not path.exists():
            sys.exit(f"No reference GeoJSON at {path}")
        ref = read_geojson(path)
        tol = 1e-9
    else:
        path = args.topojson_dir / args.profile / f'{args.year}.topojson'
        if not path.exists():
            alt = Path('../public/topojson') / args.profile / f'{args.year}.topojson'
            if not alt.exists():
                sys.exit(f"No reference TopoJSON at {path}")
            path = alt
        ref, tol = read_topojson(path)

    print(f"profile {args.profile}  year {args.year}  vs {args.against}: {path}")
    print(f"  grid cells: {len(mine_by_id):,}   reference cells: {len(ref):,}   tol {tol:g}")

    only_mine = set(mine_by_id) - set(ref)
    only_ref = set(ref) - set(mine_by_id)
    fails = []

    if only_mine:
        fails.append(f"{len(only_mine)} cellId(s) only in grid, e.g. {sorted(only_mine)[:5]}")
    if only_ref:
        fails.append(f"{len(only_ref)} cellId(s) only in reference, e.g. {sorted(only_ref)[:5]}")

    shared = sorted(set(mine_by_id) & set(ref))
    if args.limit:
        shared = shared[:args.limit]

    bad_a = bad_c = bad_ring = 0
    iso_resolved = iso_nulled = 0
    examples = []

    for cid in shared:
        m, r = mine_by_id[cid], ref[cid]
        if m['a'] != r['a']:
            bad_a += 1
            if len(examples) < 5:
                examples.append(f"    cell {cid}: anthrome {m['a']} vs {r['a']}")
        if m['c'] != r.get('c'):
            if r.get('c') == BAD_ISO:
                # Known fix: '-99' either resolves to a real code or to null.
                if m['c'] is None:
                    iso_nulled += 1
                else:
                    iso_resolved += 1
            else:
                bad_c += 1
                if len(examples) < 5:
                    examples.append(f"    cell {cid}: country {m['c']!r} vs {r.get('c')!r}")
        if not rings_match(m['ring'], r['ring'], tol):
            bad_ring += 1
            if len(examples) < 5:
                examples.append(f"    cell {cid}: ring {m['ring'][:2]} vs {r['ring'][:2]}")

    print(f"  compared {len(shared):,} shared cells")
    print(f"    anthrome mismatches : {bad_a}")
    print(f"    country  mismatches : {bad_c}")
    print(f"    ring     mismatches : {bad_ring}")
    if iso_resolved or iso_nulled:
        print(f"    ISO3 '-99' fixes    : {iso_resolved:,} resolved to a real code, "
              f"{iso_nulled:,} to null  ← expected")

    for e in examples:
        print(e)
    for f in fails:
        print(f"    ✗ {f}")

    if fails or bad_a or bad_c or bad_ring:
        print("\n❌ MISMATCH")
        return 1
    print("\n✅ grid output matches the reference")
    return 0


if __name__ == '__main__':
    sys.exit(main())
