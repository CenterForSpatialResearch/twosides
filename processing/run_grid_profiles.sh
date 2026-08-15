#!/usr/bin/env bash
# Build grid-format blobs for every profile into temp/grid/.
#
# Unlike run_temp_profile.sh this does NOT touch processing/geojson/ — the grid
# producer reads the GeoTIFFs directly. Nothing here depends on step 1 or 2.
#
# Usage:
#   ./run_grid_profiles.sh              # all six
#   ./run_grid_profiles.sh 33km 10km    # named subset
#
# Env overrides:
#   PYTHON_BIN=...   python to use (defaults to processing/.venv, then python3)
#   YEARS_FROM=...   dir whose filenames define the year list, or "all"
#                    (default ../temp/topojson/33km, i.e. the app's 76 years)

set -euo pipefail
cd "$(dirname "$0")"

# Equator-approximate km per cell; 10km is the native HYDE grid (0.0833° ≈ 9.3km),
# passed as 0 so the producer skips resampling entirely.
PROFILES=(
  "100km:0.90"
  "75km:0.675"
  "50km:0.45"
  "33km:0.30"
  "25km:0.225"
  "10km:0"
)

YEARS_FROM="${YEARS_FROM:-../temp/topojson/33km}"

if [ -n "${PYTHON_BIN:-}" ]; then
  PY="$PYTHON_BIN"
elif [ -x .venv/bin/python ]; then
  PY=".venv/bin/python"
else
  PY="python3"
fi

if ! "$PY" -c "import rasterio, numpy, shapefile" 2>/dev/null; then
  echo "❌ Python deps missing for '$PY'. Run ./setup_env.sh once." >&2
  exit 1
fi

# Named subset, or everything.
WANTED=("$@")
run_one() {
  local name="${1%%:*}" res="${1#*:}"
  if [ "${#WANTED[@]}" -gt 0 ]; then
    local hit=0
    for w in "${WANTED[@]}"; do [ "$w" = "$name" ] && hit=1; done
    [ "$hit" -eq 1 ] || return 0
  fi
  echo "------------------------------------------------------------"
  "$PY" 2b_generate_grid.py --profile="$name" --target-res="$res" --years-from="$YEARS_FROM"
  echo
}

for p in "${PROFILES[@]}"; do run_one "$p"; done

echo "============================================================"
du -sh ../temp/grid/* 2>/dev/null || true
echo
echo "Verify a profile against the old pipeline:"
echo "  $PY verify_grid.py --profile=75km --year=2025AD --against=geojson"
echo "  $PY verify_grid.py --profile=33km --year=2025AD --against=topojson"
