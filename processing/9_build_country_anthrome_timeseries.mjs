#!/usr/bin/env node
// OBSOLETE as of the runtime-distribution change. The app no longer fetches
// this file: src/anthromes/lib/gridSource.js computes the same numbers on
// demand from the grid blobs it already has in memory, which covers all 174
// countries instead of 8, tracks whichever resolution is actually being drawn
// instead of hardcoding 100km, and picks up France and Norway (this script
// reads public/topojson/100km/, whose `c` property comes from the ISO_A3 join
// that sets them to -99). distributionForCountry was verified to reproduce
// this script's output exactly at 100km before the file was removed.
//
// Kept for provenance — it is where the { cell_totals, distribution } shape
// comes from. Running it will write a file nothing loads.
//
// Build public/data/country-anthrome-timeseries.json — for each of the 8 primary
// countries and each DISPLAY_YEAR, the fraction of that country's 100 km cells
// in each anthrome class. Feeds the anthromes callout when a country is picked.
//
// Reads: public/topojson/100km/{YEAR}.topojson (already LFS-resolved)
// Uses cell counts (grid is regular enough within a single country that
// year-over-year proportions are correct without area weighting).
//
// Output shape:
// {
//   "SWE": {
//     "cell_totals": { "10000BC": 100, ..., "2025AD": 100 },
//     "distribution": {
//       "10000BC": { "62": 0.78, "63": 0.22 },
//       ...
//     }
//   }, ...
// }

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO = path.resolve(__dirname, '..');
const TOPO_DIR = path.join(REPO, 'public', 'topojson', '100km');
const OUT_PATH = path.join(REPO, 'public', 'data', 'country-anthrome-timeseries.json');

const PRIMARY_ISO3 = new Set(['SWE', 'GBR', 'USA', 'CHN', 'MDG', 'FJI', 'PER', 'TZA']);

// Must match DISPLAY_YEARS in src/anthromes/lib/dataAdapter.js
const DISPLAY_YEARS = [
  -10000, -9000, -8000, -7000, -6000, -5000, -4000, -3000, -2000, -1000,
  0,
  100, 200, 300, 400, 500, 600, 700, 800, 900, 1000,
  1100, 1200, 1300, 1400, 1500, 1600, 1700,
  1710, 1720, 1730, 1740, 1750, 1760, 1770, 1780, 1790,
  1800, 1810, 1820, 1830, 1840, 1850, 1860, 1870, 1880, 1890,
  1900, 1910, 1920, 1930, 1940,
  1950, 1955, 1960, 1965, 1970, 1975, 1980, 1985, 1990, 1995, 2000,
  2005, 2010, 2015, 2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025
];

const yearToFile = (y) => (y < 0 ? `${Math.abs(y)}BC` : y === 0 ? '0AD' : `${y}AD`);

const out = {};
for (const iso of PRIMARY_ISO3) out[iso] = { cell_totals: {}, distribution: {} };

let processed = 0;
let missing = 0;
for (const y of DISPLAY_YEARS) {
  const label = yearToFile(y);
  const file = path.join(TOPO_DIR, `${label}.topojson`);
  if (!fs.existsSync(file)) {
    console.warn(`⚠ missing ${label}.topojson`);
    missing += 1;
    continue;
  }
  const tj = JSON.parse(fs.readFileSync(file, 'utf-8'));
  const objName = Object.keys(tj.objects)[0];
  const geoms = tj.objects[objName].geometries || [];

  // Tally: perCountry[iso][anthromeCode] += 1
  const perCountry = new Map();
  for (const iso of PRIMARY_ISO3) perCountry.set(iso, new Map());

  for (const g of geoms) {
    const p = g.properties;
    if (!p) continue;
    const iso = p.c;
    if (!PRIMARY_ISO3.has(iso)) continue;
    const code = p.a;
    if (code == null) continue;
    const bucket = perCountry.get(iso);
    bucket.set(code, (bucket.get(code) || 0) + 1);
  }

  for (const iso of PRIMARY_ISO3) {
    const bucket = perCountry.get(iso);
    let total = 0;
    for (const n of bucket.values()) total += n;
    out[iso].cell_totals[label] = total;
    if (total === 0) {
      out[iso].distribution[label] = {};
      continue;
    }
    const dist = {};
    for (const [code, n] of bucket) dist[String(code)] = +(n / total).toFixed(6);
    out[iso].distribution[label] = dist;
  }
  processed += 1;
}

fs.writeFileSync(OUT_PATH, JSON.stringify(out));
const sizeKb = (fs.statSync(OUT_PATH).size / 1024).toFixed(1);
console.log(`✓ Wrote ${OUT_PATH} (${sizeKb} kB)`);
console.log(`  years processed: ${processed}  missing: ${missing}`);

// Quick sanity: print SWE 2000AD and 10000BC
for (const iso of ['SWE', 'PER', 'FJI']) {
  const early = out[iso].distribution['10000BC'] || {};
  const late = out[iso].distribution['2000AD'] || {};
  console.log(`  ${iso} 10000BC total=${out[iso].cell_totals['10000BC']}  codes=${JSON.stringify(early)}`);
  console.log(`  ${iso} 2000AD  total=${out[iso].cell_totals['2000AD']}   codes=${JSON.stringify(late)}`);
}
