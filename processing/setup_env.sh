#!/usr/bin/env bash
# One-time setup for the Python side of the processing pipeline.
#
# Homebrew's python3 is "externally managed", so a plain `pip install` fails.
# This creates a local venv at processing/.venv that run_temp_profile.sh picks
# up automatically. Node deps resolve from the repo-root node_modules already.

set -euo pipefail
cd "$(dirname "$0")"

PYTHON_BIN="${PYTHON_BIN:-python3}"

if [ ! -d .venv ]; then
  echo "Creating venv at processing/.venv (using $PYTHON_BIN)..."
  "$PYTHON_BIN" -m venv .venv
fi

./.venv/bin/python -m pip install --upgrade pip
./.venv/bin/python -m pip install rasterio shapely numpy pyshp geopy

echo
echo "Done. processing/.venv is ready."
echo "Sanity check:"
./.venv/bin/python -c "import rasterio, shapely, numpy, shapefile; print('  rasterio', rasterio.__version__, '/ shapely', shapely.__version__)"
