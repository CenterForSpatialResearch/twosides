#!/usr/bin/env python3
"""
Generate cell history lookup JSON from processed GeoJSON files.

Creates a mapping of cellId -> { year: anthrome } for all cells across all years,
enabling the historical bar chart visualization in the frontend.

Usage:
    python 3_generate_cell_history.py --input=geojson/33km --output=../public/data/cell-history-33km.json

Output format:
{
    "12345": { "10000BC": 62, "9000BC": 62, ..., "2025AD": 12 },
    "12346": { "10000BC": 54, "9000BC": 54, ..., "2025AD": 23 },
    ...
}
"""

import json
from pathlib import Path
import argparse
from collections import defaultdict

# Years to include in the output (matches DISPLAY_YEARS in dataAdapter.js)
DISPLAY_YEARS = [
    -10000, -9000, -8000, -7000, -6000, -5000, -4000, -3000, -2000, -1000,
    0,
    100, 200, 300, 400, 500, 600, 700, 800, 900, 1000,
    1100, 1200, 1300, 1400, 1500, 1600, 1700,
    1710, 1720, 1730, 1740, 1750, 1760, 1770, 1780, 1790,
    1800, 1810, 1820, 1830, 1840, 1850, 1860, 1870, 1880, 1890,
    1900, 1910, 1920, 1930, 1940,
    1950, 1955, 1960, 1965, 1970, 1975, 1980, 1985, 1990, 1995, 2000,
    2005, 2010, 2015, 2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025
]


def year_to_data_format(year):
    """Convert numeric year to data format string (e.g., -10000 → "10000BC", 100 → "100AD")"""
    if year < 0:
        return f"{abs(year)}BC"
    if year == 0:
        return "0AD"
    return f"{year}AD"


# Pre-compute allowed year strings
ALLOWED_YEARS = {year_to_data_format(y) for y in DISPLAY_YEARS}


def parse_args():
    parser = argparse.ArgumentParser(description='Generate cell history lookup JSON')
    parser.add_argument('--input', type=Path, required=True,
                        help='Input directory containing GeoJSON files (e.g., geojson/33km)')
    parser.add_argument('--output', type=Path, required=True,
                        help='Output JSON file path (e.g., ../public/data/cell-history-33km.json)')
    return parser.parse_args()


def main():
    args = parse_args()

    input_dir = args.input
    output_path = args.output

    # Find all GeoJSON files
    geojson_files = sorted(input_dir.glob('*.geojson'))

    if not geojson_files:
        print(f"❌ No GeoJSON files found in {input_dir}")
        return 1

    print(f"📁 Found {len(geojson_files)} GeoJSON files in {input_dir}")

    # Build cell history: { cellId: { year: anthrome } }
    cell_history = defaultdict(dict)
    processed_years = 0
    skipped_years = 0

    for i, geojson_path in enumerate(geojson_files, 1):
        year = geojson_path.stem  # e.g., "2000AD", "10000BC"

        # Only include display years
        if year not in ALLOWED_YEARS:
            skipped_years += 1
            continue

        processed_years += 1

        try:
            with open(geojson_path, 'r') as f:
                data = json.load(f)

            for feature in data.get('features', []):
                props = feature.get('properties', {})
                cell_id = props.get('i')  # Shortened property name
                anthrome = props.get('a')  # Shortened property name

                if cell_id is not None and anthrome is not None:
                    cell_history[cell_id][year] = anthrome

            print(f"[{i:3d}/{len(geojson_files)}] {year:12s} ✓")

        except Exception as e:
            print(f"[{i:3d}/{len(geojson_files)}] {year:12s} ❌ Error: {e}")

    if not cell_history:
        print("❌ No cell history data found. Make sure GeoJSON files have 'i' (cellId) property.")
        print("   Run 1_extract_geojson.py with --boundaries flag first.")
        return 1

    # Convert defaultdict to regular dict for JSON serialization
    # Also convert cellId keys to strings for JSON compatibility
    output_data = {str(k): v for k, v in cell_history.items()}

    # Write output
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with open(output_path, 'w') as f:
        json.dump(output_data, f, separators=(',', ':'))

    file_size_mb = output_path.stat().st_size / (1024 * 1024)

    print(f"\n✅ Cell history generation complete!")
    print(f"   Years processed: {processed_years} (skipped {skipped_years} non-display years)")
    print(f"   Unique cells: {len(cell_history):,}")
    print(f"   Output size: {file_size_mb:.2f} MB")
    print(f"   Output: {output_path}")

    return 0


if __name__ == '__main__':
    exit(main())
