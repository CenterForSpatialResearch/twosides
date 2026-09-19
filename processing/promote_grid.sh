#!/usr/bin/env bash
# Promote generated grid profiles from temp/ into public/, i.e. from "generated
# locally" to "shipped".
#
#   temp/grid/<profile>/    scratch output of 2b_generate_grid.py, gitignored
#   public/grid/<profile>/  shipped, tracked in Git LFS, served in dev AND prod
#
# Profiles under public/ are served identically by the dev server and by a
# production build, so what you test locally is what deploys. Profiles left in
# temp/ are dev-only, via the serve-temp-assets middleware in vite.config.js.
#
# Usage:
#   ./promote_grid.sh 100km 75km 70km 60km 50km
#   ./promote_grid.sh --list          # show what is where
#
# After promoting, remove the profile from TEMP_PROFILES in vite.config.js so
# dev reads it from public/ too, and add it to TOPO_PROFILES in
# src/shared/topoProfile.svelte.js if it should appear in the picker.

set -euo pipefail
cd "$(dirname "$0")"

SRC_ROOT="../temp/grid"
DST_ROOT="../public/grid"

if [ "${1:-}" = "--list" ] || [ $# -eq 0 ]; then
  echo "generated (temp/grid):"
  [ -d "$SRC_ROOT" ] && du -sh "$SRC_ROOT"/* 2>/dev/null | sed 's|../temp/grid/|  |' || echo "  (none)"
  echo "shipped (public/grid):"
  [ -d "$DST_ROOT" ] && du -sh "$DST_ROOT"/* 2>/dev/null | sed 's|../public/grid/|  |' || echo "  (none)"
  [ $# -eq 0 ] && { echo; echo "usage: $0 <profile>..."; exit 1; }
  exit 0
fi

total=0
for profile in "$@"; do
  src="$SRC_ROOT/$profile"
  dst="$DST_ROOT/$profile"

  if [ ! -d "$src" ]; then
    echo "❌ $profile: not generated. Run ./run_grid_profiles.sh $profile" >&2
    exit 1
  fi
  for f in manifest.json mask.bin codes.bin countries.bin; do
    if [ ! -f "$src/$f" ]; then
      echo "❌ $profile: missing $f — regenerate it" >&2
      exit 1
    fi
  done

  mkdir -p "$dst"
  cp "$src"/manifest.json "$src"/mask.bin "$src"/codes.bin "$src"/countries.bin "$dst"/
  size=$(du -sk "$dst" | cut -f1)
  total=$((total + size))
  echo "✅ $profile -> public/grid/$profile ($(du -sh "$dst" | cut -f1))"
done

echo
echo "public/grid total: $(( total / 1024 )) MB"
echo
echo "These are Git LFS tracked (see .gitattributes). Verify before committing:"
echo "  git add public/grid && git lfs ls-files | head"
