#!/usr/bin/env python3
"""
Generate summary.json from HYDE 3.5 anthrome GeoTIFF files.

Reads each GeoTIFF, counts pixels for each anthrome code, and outputs
a summary JSON with counts and percentages per year.

Output format:
{
  "years": {
    "10000BC": {
      "counts": { "11": 123, "12": 456, ... },
      "total": 12345,
      "percentages": { "11": 1.0, "12": 3.7, ... }
    },
    ...
  }
}
"""

import os
import json
import re
from pathlib import Path
from collections import Counter
import argparse

import numpy as np
import rasterio

def parse_year_from_filename(filename):
    """
    Extract year string from filename like 'anthromes10000BC.tif' or 'anthromes2017AD.tif'
    Returns the year portion (e.g., '10000BC', '2017AD', '0AD')
    """
    # Match pattern: anthromes followed by number and BC/AD suffix
    match = re.search(r'anthromes(\d+)(BC|AD)\.tif$', filename, re.IGNORECASE)
    if match:
        return f"{match.group(1)}{match.group(2).upper()}"
    return None

def process_geotiff(filepath):
    """
    Read a GeoTIFF and count pixels for each anthrome code.
    Returns dict with counts, total, and percentages.
    """
    with rasterio.open(filepath) as src:
        data = src.read(1)  # Read first band

        # Flatten and remove nodata values (typically 0 or negative)
        valid_mask = data > 0
        valid_data = data[valid_mask]

        # Count occurrences of each anthrome code
        counter = Counter(valid_data.flatten())

        # Convert to regular dict with string keys
        counts = {str(int(k)): int(v) for k, v in counter.items()}
        total = sum(counts.values())

        # Calculate percentages
        percentages = {}
        if total > 0:
            percentages = {k: (v / total) * 100 for k, v in counts.items()}

        return {
            'counts': counts,
            'total': total,
            'percentages': percentages
        }

def main():
    parser = argparse.ArgumentParser(description='Generate summary.json from anthrome GeoTIFFs')
    parser.add_argument('--input-dir', type=Path,
                        default=Path('../data/HYDE-3.5/baseline/anthromes_geotiff'),
                        help='Directory containing anthrome GeoTIFFs')
    parser.add_argument('--output', type=Path,
                        default=Path('../public/data/summary.json'),
                        help='Output JSON file path')
    parser.add_argument('--verbose', '-v', action='store_true',
                        help='Print progress')
    args = parser.parse_args()

    input_dir = args.input_dir
    output_file = args.output

    if not input_dir.exists():
        print(f"ERROR: Input directory not found: {input_dir}")
        return 1

    # Find all GeoTIFF files
    tif_files = sorted(input_dir.glob('anthromes*.tif'))

    if not tif_files:
        print(f"ERROR: No anthromes*.tif files found in {input_dir}")
        return 1

    print(f"Found {len(tif_files)} GeoTIFF files")
    print(f"Output: {output_file}")
    print()

    # Process each file
    summary = {'years': {}}

    for i, tif_path in enumerate(tif_files, 1):
        year_str = parse_year_from_filename(tif_path.name)

        if not year_str:
            print(f"  [{i}/{len(tif_files)}] SKIP: {tif_path.name} (couldn't parse year)")
            continue

        if args.verbose:
            print(f"  [{i}/{len(tif_files)}] Processing: {year_str}")

        try:
            year_data = process_geotiff(tif_path)
            summary['years'][year_str] = year_data
        except Exception as e:
            print(f"  [{i}/{len(tif_files)}] ERROR: {tif_path.name} - {e}")
            continue

    # Ensure output directory exists
    output_file.parent.mkdir(parents=True, exist_ok=True)

    # Write output
    with open(output_file, 'w') as f:
        json.dump(summary, f, indent=2)

    print()
    print(f"Done! Generated summary for {len(summary['years'])} years")
    print(f"Output written to: {output_file}")

    # Print year coverage
    years = list(summary['years'].keys())
    bc_years = sorted([y for y in years if 'BC' in y], key=lambda x: -int(x.replace('BC', '')))
    ad_years = sorted([y for y in years if 'AD' in y], key=lambda x: int(x.replace('AD', '')))

    print()
    print(f"Year coverage:")
    print(f"  BC years: {len(bc_years)} ({bc_years[0] if bc_years else 'none'} to {bc_years[-1] if bc_years else 'none'})")
    print(f"  AD years: {len(ad_years)} ({ad_years[0] if ad_years else 'none'} to {ad_years[-1] if ad_years else 'none'})")

    return 0

if __name__ == '__main__':
    exit(main())
