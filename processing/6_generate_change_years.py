#!/usr/bin/env python3
"""
Generate anthrome change years lookup table.

For each cell, determines the year when it became its current (2025AD) anthrome value
by walking backwards through historical data.

Usage:
    python3 6_generate_change_years.py \
        --cell-history=../public/data/cell-history-100km.json \
        --output=../public/data/anthrome-change-years-100km.json

    python3 6_generate_change_years.py \
        --cell-history=utilities/cell-history-33km.json \
        --output=../public/data/anthrome-change-years-33km.json
"""

import json
import argparse
from pathlib import Path


def parse_year_string(year_str):
    """
    Parse year string into sortable tuple.

    Args:
        year_str: Year string like "10000BC", "1950AD", "2025AD"

    Returns:
        Tuple (is_ce, year_num) for sorting
        - BCE years: (False, year) where higher year = older
        - CE years: (True, year) where higher year = newer
    """
    if year_str.endswith("BC"):
        year_num = int(year_str.replace("BC", ""))
        return (False, -year_num)  # Negate so 10000BC < 1000BC when sorting
    elif year_str.endswith("AD"):
        year_num = int(year_str.replace("AD", ""))
        return (True, year_num)
    else:
        raise ValueError(f"Invalid year format: {year_str}")


def generate_change_years(cell_history):
    """
    Generate change year lookup for all cells.

    Args:
        cell_history: Dict of {cellId: {year: anthrome_code}}

    Returns:
        Dict of {cellId: change_year_str}
    """
    change_years = {}

    # Get all years and sort them chronologically
    sample_cell = next(iter(cell_history.values()))
    all_years = list(sample_cell.keys())
    all_years.sort(key=parse_year_string)

    current_year = "2025AD"

    for cell_id, year_data in cell_history.items():
        current_anthrome = year_data.get(current_year)

        if current_anthrome is None:
            # Cell doesn't have data for 2025
            change_years[cell_id] = "Unknown"
            continue

        # Walk backwards through years to find when it changed to current value
        change_year = all_years[0]  # Default to earliest year (10000BC)

        for i in range(len(all_years) - 1, -1, -1):
            year = all_years[i]
            anthrome = year_data.get(year)

            if anthrome is None:
                continue

            if anthrome != current_anthrome:
                # Found the last year it was different
                # Change year is the next year forward
                if i + 1 < len(all_years):
                    change_year = all_years[i + 1]
                else:
                    # It changed in or after the last year
                    change_year = year
                break
        else:
            # Cell has been this anthrome since earliest record
            change_year = all_years[0]

        change_years[cell_id] = change_year

    return change_years


def main():
    parser = argparse.ArgumentParser(
        description="Generate anthrome change years from cell history"
    )
    parser.add_argument(
        "--cell-history",
        required=True,
        help="Path to cell-history JSON file (input)",
    )
    parser.add_argument(
        "--output", required=True, help="Path to output change years JSON file"
    )

    args = parser.parse_args()

    # Load cell history
    print(f"Loading cell history from {args.cell_history}...")
    with open(args.cell_history, "r", encoding="utf-8") as f:
        cell_history = json.load(f)

    print(f"Processing {len(cell_history)} cells...")

    # Generate change years
    change_years = generate_change_years(cell_history)

    # Write output
    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)

    print(f"Writing change years to {args.output}...")
    with open(args.output, "w", encoding="utf-8") as f:
        json.dump(change_years, f, separators=(",", ":"))

    print(f"Successfully generated {len(change_years)} change year entries")

    # Print sample for verification
    print("\nSample entries:")
    for i, (cell_id, change_year) in enumerate(list(change_years.items())[:5]):
        print(f"  Cell {cell_id}: {change_year}")


if __name__ == "__main__":
    main()
