#!/usr/bin/env bash
# Batch runner for GeoJSON extraction + TopoJSON generation.
# Edit the COMMANDS array to swap in/out the profiles you want to process.
# Each entry is: "extract_cmd|topo_cmd" and will run sequentially.

set -euo pipefail
cd "$(dirname "$0")"

COMMANDS=(
  "python3 1_extract_geojson.py --target-res=0.30 --sieve-size=0 --simplify=0.1 --profile=33km-dissolve-smp1 | node 2_generate_topojson.js --input=geojson/33km-dissolve-smp1 --output=../public/topojson/33km-dissolve-smp1 --quantization=1e4"
  "python3 1_extract_geojson.py --target-res=0.30 --sieve-size=0 --profile=33km-dissolve-smp2 | node 2_generate_topojson.js --input=geojson/33km-dissolve-smp2 --output=../public/topojson/33km-dissolve-smp2 --simplification=0.05 --quantization=1e4"
)

for pair in "${COMMANDS[@]}"; do
  extract_cmd="${pair%%|*}"
  topo_cmd="${pair#*|}"

  echo "------------------------------------------------------------"
  echo "Running: $extract_cmd"
  eval "$extract_cmd"

  echo "Running: $topo_cmd"
  eval "$topo_cmd"
done

echo "✅ Batch complete"
