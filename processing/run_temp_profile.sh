#!/usr/bin/env bash
# Build one resolution profile end to end: GeoTIFF -> GeoJSON -> TopoJSON.
#
# Unlike run_batch.sh, TopoJSON lands in temp/topojson/<profile>/ instead of
# public/topojson/, so nothing here is staged for production or Git LFS.
#
# Usage:
#   ./run_temp_profile.sh 50km 0.45
#   ./run_temp_profile.sh 75km 0.675
#
# Env overrides:
#   QUANTIZATION=1e4   coordinate quantization for step 2 (matches the 33km profile)
#   KEEP_GEOJSON=1     set to 0 to delete processing/geojson/<profile> after step 2
#   FORCE=0            set to 1 to re-extract even if the GeoJSON folder is populated
#   PYTHON_BIN=...     python to use (defaults to processing/.venv, then python3)
#   YEARS_FROM=...     restrict to the years present in a reference TopoJSON folder.
#                      Defaults to ../temp/topojson/33km so output is directly
#                      comparable to the existing 33km set. Set to "all" to process
#                      every GeoTIFF (the geotiff dir carries ~50 extra annual
#                      snapshots the app's year list doesn't display).
#
# Dissolve is deliberately OFF (--skip-dissolve): per-cell polygons are required
# so anthromes stay inspectable at the cell level and keep their `i` (cellId).

set -euo pipefail
cd "$(dirname "$0")"

PROFILE="${1:-}"
TARGET_RES="${2:-}"

if [ -z "$PROFILE" ] || [ -z "$TARGET_RES" ]; then
  echo "usage: $0 <profile-name> <target-res-degrees>" >&2
  echo "  e.g. $0 50km 0.45" >&2
  echo "       $0 75km 0.675" >&2
  exit 1
fi

QUANTIZATION="${QUANTIZATION:-1e4}"
KEEP_GEOJSON="${KEEP_GEOJSON:-1}"
FORCE="${FORCE:-0}"
YEARS_FROM="${YEARS_FROM:-../temp/topojson/33km}"

GEOJSON_DIR="geojson/$PROFILE"
TOPO_DIR="../temp/topojson/$PROFILE"
TIF_DIR="../data/HYDE-3.5/baseline/anthromes_geotiff"
BOUNDARIES="../data/ne_110m_admin_0_countries/ne_110m_admin_0_countries.shp"

# --- resolve python -----------------------------------------------------------
if [ -n "${PYTHON_BIN:-}" ]; then
  PY="$PYTHON_BIN"
elif [ -x .venv/bin/python ]; then
  PY=".venv/bin/python"
else
  PY="python3"
fi

if ! "$PY" -c "import rasterio, shapely, numpy, shapefile" 2>/dev/null; then
  echo "❌ Python deps missing for '$PY' (need rasterio shapely numpy pyshp)." >&2
  echo "   Run ./setup_env.sh once, then re-run this script." >&2
  exit 1
fi

# --- preflight ----------------------------------------------------------------
if [ ! -d "$TIF_DIR" ]; then
  echo "❌ GeoTIFF input dir not found: $TIF_DIR" >&2
  exit 1
fi

TIF_COUNT=$(find "$TIF_DIR" -name 'anthromes*.tif' | wc -l | tr -d ' ')
if [ "$TIF_COUNT" -eq 0 ]; then
  echo "❌ No anthromes*.tif files in $TIF_DIR" >&2
  exit 1
fi

BOUNDARY_ARGS=()
if [ -f "$BOUNDARIES" ]; then
  BOUNDARY_ARGS=(--boundaries="$BOUNDARIES")
else
  echo "⚠️  Natural Earth shapefile not found at:"
  echo "      $BOUNDARIES"
  echo "   Cells will still get 'a' (anthrome) and 'i' (cellId), but NOT 'c' (ISO3 country),"
  echo "   which MapCanvas reads for country highlighting. Restore the .shp/.dbf and re-run"
  echo "   with FORCE=1 if you need country codes."
  echo
fi

# --- optional year filter -----------------------------------------------------
# The geotiff dir carries more years than the app displays. Rather than teach
# 1_extract_geojson.py a new flag, stage a symlink farm of just the years we want
# and point --input-dir at it.
EXTRACT_TIF_DIR="$TIF_DIR"
YEAR_NOTE="all $TIF_COUNT years"
STAGE_DIR=""

if [ "$YEARS_FROM" != "all" ] && [ -d "$YEARS_FROM" ]; then
  STAGE_DIR=".tif-subset/$PROFILE"
  rm -rf "$STAGE_DIR"
  mkdir -p "$STAGE_DIR"

  WANT=0
  FOUND=0
  MISSING=()
  for topo in "$YEARS_FROM"/*.topojson; do
    [ -e "$topo" ] || continue
    year=$(basename "$topo" .topojson)
    WANT=$((WANT + 1))
    src="$TIF_DIR/anthromes${year}.tif"
    if [ -f "$src" ]; then
      ln -s "$(cd "$(dirname "$src")" && pwd)/$(basename "$src")" "$STAGE_DIR/anthromes${year}.tif"
      FOUND=$((FOUND + 1))
    else
      MISSING+=("$year")
    fi
  done

  if [ "$FOUND" -eq 0 ]; then
    echo "⚠️  YEARS_FROM=$YEARS_FROM matched no GeoTIFFs — falling back to all years."
    rm -rf "$STAGE_DIR"
    STAGE_DIR=""
  else
    EXTRACT_TIF_DIR="$STAGE_DIR"
    YEAR_NOTE="$FOUND of $TIF_COUNT (matched to $YEARS_FROM)"
    if [ "${#MISSING[@]}" -gt 0 ]; then
      echo "⚠️  ${#MISSING[@]} reference year(s) have no GeoTIFF: ${MISSING[*]}"
      echo
    fi
  fi
elif [ "$YEARS_FROM" != "all" ]; then
  echo "ℹ YEARS_FROM=$YEARS_FROM not found — processing all years."
  echo
fi

cleanup_stage() {
  [ -n "$STAGE_DIR" ] || return 0
  rm -rf "$STAGE_DIR"
  rmdir .tif-subset 2>/dev/null || true
}
trap cleanup_stage EXIT

echo "============================================================"
echo " profile        : $PROFILE"
echo " target-res     : ${TARGET_RES}°"
echo " source tifs    : $YEAR_NOTE"
echo "                  ($TIF_DIR)"
echo " geojson (temp) : $GEOJSON_DIR"
echo " topojson out   : $TOPO_DIR"
echo " quantization   : $QUANTIZATION"
echo " dissolve       : off (per-cell polygons)"
echo "============================================================"
echo

# --- step 1: GeoTIFF -> GeoJSON ----------------------------------------------
EXISTING=0
if [ -d "$GEOJSON_DIR" ]; then
  EXISTING=$(find "$GEOJSON_DIR" -name '*.geojson' | wc -l | tr -d ' ')
fi

if [ "$EXISTING" -gt 0 ] && [ "$FORCE" != "1" ]; then
  echo "▶ Step 1 skipped: $EXISTING GeoJSON files already in $GEOJSON_DIR (FORCE=1 to redo)."
else
  echo "▶ Step 1: extracting GeoJSON..."
  "$PY" 1_extract_geojson.py \
    --input-dir="$EXTRACT_TIF_DIR" \
    --target-res="$TARGET_RES" \
    --sieve-size=0 \
    --skip-dissolve \
    --profile="$PROFILE" \
    "${BOUNDARY_ARGS[@]}"
fi
echo

# --- step 2: GeoJSON -> TopoJSON ---------------------------------------------
echo "▶ Step 2: generating TopoJSON..."
mkdir -p "$TOPO_DIR"
node 2_generate_topojson.js \
  --input="$GEOJSON_DIR" \
  --output="$TOPO_DIR" \
  --simplification=0 \
  --quantization="$QUANTIZATION"
echo

# --- cleanup + report ---------------------------------------------------------
if [ "$KEEP_GEOJSON" = "0" ]; then
  echo "▶ Removing intermediate GeoJSON ($GEOJSON_DIR)..."
  rm -rf "$GEOJSON_DIR"
else
  echo "ℹ Intermediate GeoJSON kept at $GEOJSON_DIR"
  echo "  (step 3, 3_generate_cell_history.py, reads this folder — delete it manually"
  echo "   or re-run with KEEP_GEOJSON=0 when you're done with it)"
fi

echo
echo "✅ $PROFILE complete"
du -sh "$TOPO_DIR"
