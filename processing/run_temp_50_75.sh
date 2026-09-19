#!/usr/bin/env bash
# Build the 50km and 75km profiles into temp/topojson/.
#
#   0.45°  ≈ 50.1 km/cell at the equator
#   0.675° ≈ 75.1 km/cell at the equator
#
# Runs 75km first — it's the smaller, faster output, so you get something to look
# at before the 50km pass finishes.
#
# Usage:
#   ./run_temp_50_75.sh          # both
#   ./run_temp_50_75.sh 75km     # just one
#
# All env overrides from run_temp_profile.sh apply here too (QUANTIZATION,
# KEEP_GEOJSON, FORCE, PYTHON_BIN).

set -euo pipefail
cd "$(dirname "$0")"

WHICH="${1:-all}"

run_75km() { ./run_temp_profile.sh 75km 0.675; }
run_50km() { ./run_temp_profile.sh 50km 0.45; }

case "$WHICH" in
  75km) run_75km ;;
  50km) run_50km ;;
  all)  run_75km; echo; run_50km ;;
  *)    echo "usage: $0 [50km|75km|all]" >&2; exit 1 ;;
esac

echo
echo "============================================================"
echo "Output sizes:"
du -sh ../temp/topojson/* 2>/dev/null || true
