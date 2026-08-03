#!/usr/bin/env node
// Build public/data/primary_countries.json — curated 8-country dataset that
// drives the country-first filter on both the biomes and anthromes sides.
//
// Sources:
//   public/data/country_index.json               — samples/studies/sgbs per ISO3
//   public/data/iso3_names.json                  — display names
//   public/data/sgb_context.json                 — per-SGB uSGB status
//   public/data/cohort_index.json                — sub-cohort ids by country
//   public/data/country_index_centroids.geojson  — centroids
//   public/topojson/admin-boundaries/countries-110m.topojson — bbox per country
//
// Output: public/data/primary_countries.json

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { feature } from 'topojson-client';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO = path.resolve(__dirname, '..');
const DATA = path.join(REPO, 'public', 'data');
const TOPO = path.join(REPO, 'public', 'topojson');

const PRIMARY_ISO3 = ['SWE', 'GBR', 'USA', 'CHN', 'MDG', 'FJI', 'PER', 'TZA'];

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf-8'));

const countryIndex = readJson(path.join(DATA, 'country_index.json'));
const iso3Names = readJson(path.join(DATA, 'iso3_names.json'));
const sgbContext = readJson(path.join(DATA, 'sgb_context.json'));
const cohortIndex = readJson(path.join(DATA, 'cohort_index.json'));
const centroidsFC = readJson(path.join(DATA, 'country_index_centroids.geojson'));
const adminTopo = readJson(path.join(TOPO, 'admin-boundaries', 'countries-110m.topojson'));

const centroidByIso = new Map(
  centroidsFC.features
    .filter((f) => f?.properties?.ISO3 && f?.geometry?.coordinates)
    .map((f) => [f.properties.ISO3, f.geometry.coordinates])
);

// Sub-cohort roll-up (empty for USA/CHN/GBR/SWE; present for MDG/FJI/PER/TZA)
const subCohortsByIso = new Map();
for (const [cid, row] of Object.entries(cohortIndex)) {
  const iso = row?.country_iso3;
  if (!iso) continue;
  if (!subCohortsByIso.has(iso)) subCohortsByIso.set(iso, []);
  subCohortsByIso.get(iso).push(cid);
}

// Decode admin boundaries once and pull each country's feature bbox
const adminObj = adminTopo.objects[Object.keys(adminTopo.objects)[0]];
const adminFC = feature(adminTopo, adminObj);
const bboxByIso = new Map();
for (const f of adminFC.features) {
  const iso = f?.id || f?.properties?.id || f?.properties?.ISO_A3;
  if (!iso) continue;
  bboxByIso.set(iso, computeBbox(f.geometry));
}

function computeBbox(geom) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const visit = (coords) => {
    if (typeof coords[0] === 'number') {
      const [x, y] = coords;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
      return;
    }
    for (const c of coords) visit(c);
  };
  visit(geom.coordinates);
  return [minX, minY, maxX, maxY];
}

function countKnowledgeStatus(sgbs) {
  let known = 0, unknown = 0, missing = 0;
  for (const sgb of sgbs) {
    const ctx = sgbContext[String(sgb)] || sgbContext[sgb];
    const status = ctx?.knowledge_status?.uSGB;
    if (status === 'Yes') unknown += 1;
    else if (status === 'No') known += 1;
    else missing += 1;
  }
  return { known, unknown, missing };
}

const out = {};
for (const iso of PRIMARY_ISO3) {
  const src = countryIndex[iso];
  if (!src) {
    console.warn(`⚠ ${iso} missing from country_index.json`);
    continue;
  }
  const sgbs = src.sgbs || [];
  const centroid = centroidByIso.get(iso) || null;
  const bbox = bboxByIso.get(iso) || null;

  out[iso] = {
    iso3: iso,
    label: iso3Names[iso] || iso,
    samples_total: src.samples_total ?? 0,
    studies: src.studies || [],
    sub_cohort_ids: subCohortsByIso.get(iso) || [],
    sgbs,
    westernized_counts: src.westernized_counts || {},
    unknown_counts: countKnowledgeStatus(sgbs),
    body_sites: src.body_sites || [],
    centroid,
    bbox
  };

  if (!centroid) console.warn(`⚠ ${iso} missing centroid`);
  if (!bbox) console.warn(`⚠ ${iso} missing bbox`);
}

const outPath = path.join(DATA, 'primary_countries.json');
fs.writeFileSync(outPath, JSON.stringify(out, null, 2));

console.log(`✓ Wrote ${outPath}`);
for (const [iso, row] of Object.entries(out)) {
  const u = row.unknown_counts;
  const w = row.westernized_counts;
  console.log(
    `  ${iso} ${row.label.padEnd(22)}  samples=${String(row.samples_total).padStart(5)}  ` +
      `sgbs=${String(row.sgbs.length).padStart(4)}  unk=${u.unknown}/${u.unknown + u.known}  ` +
      `west=${w.Yes || 0}/${(w.Yes || 0) + (w.No || 0)}  ` +
      `sub=${row.sub_cohort_ids.length}  bbox=${row.bbox ? '✓' : '✗'}`
  );
}
