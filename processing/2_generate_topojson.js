#!/usr/bin/env node
/**
 * Generate TopoJSON files from GeoJSON with configurable simplification.
 *
 * Converts GeoJSON polygons to TopoJSON format with topology preservation
 * and optional simplification to reduce file size.
 *
 * see processing/readme.md for usage examples
 *
 * Options (real-world meaning):
 *   --simplification  Topology simplify threshold in quantized units; higher drops
 *                     more small bends/coastline detail (0.05 keeps more detail than 0.08).
 *   --quantization    Coordinate quantization grid size; larger (e.g., 1e5) snaps
 *                     to a coarser lattice, shrinking files but removing sub-arcsecond detail.
 *   --input/--output  Source GeoJSON folder and destination TopoJSON folder per profile.
 *   --only            Comma-separated basenames (no extension) to convert, instead of
 *                     every .geojson in --input. The admin-boundary sets live in one
 *                     folder but need different --simplification values, so they are
 *                     converted in groups; see 5_smooth_boundaries.py.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import * as topojson from 'topojson-server';
import * as topojsonSimplify from 'topojson-simplify';
import { quantize as quantizeTopology } from 'topojson-client';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Parse CLI arguments
const args = process.argv.slice(2);
function getArg(name, defaultValue) {
  const raw = args.find(arg => arg.startsWith(`--${name}=`));
  return raw ? raw.split('=')[1] : defaultValue;
}

const inputDir = path.resolve(
  getArg('input', path.join(__dirname, 'geojson'))
);
const outputDir = path.resolve(
  getArg('output', path.join(__dirname, '../public/topojson'))
);
const simplification = parseFloat(getArg('simplification', '0'));
const only = getArg('only', '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const quantization = parseFloat(getArg('quantization', '1e5'));

/**
 * Convert a single GeoJSON file to TopoJSON
 */
function convertToTopojson(geojsonPath, topojsonPath) {
  // Read GeoJSON
  const geojson = JSON.parse(fs.readFileSync(geojsonPath, 'utf8'));
  const inputSize = fs.statSync(geojsonPath).size;

// Build topology (no quantization yet; we'll apply it after any simplification)
let topology = topojson.topology({ anthromes: geojson });

// Apply simplification if specified
if (simplification > 0) {
  topology = topojsonSimplify.presimplify(topology);
  topology = topojsonSimplify.simplify(topology, simplification);
}

// Apply quantization last so the output retains a transform + integer arcs
if (quantization > 0) {
  topology = quantizeTopology(topology, quantization);
}

  // Write TopoJSON
  fs.writeFileSync(topojsonPath, JSON.stringify(topology));
  const outputSize = fs.statSync(topojsonPath).size;

  return {
    inputSize,
    outputSize,
    compression: ((1 - outputSize / inputSize) * 100).toFixed(1),
    featureCount: geojson.features.length
  };
}

/**
 * Main processing function
 */
function main() {
  // Create output directory
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  // Get all GeoJSON files
  const geojsonFiles = fs.readdirSync(inputDir)
    .filter(f => f.endsWith('.geojson'))
    .filter(f => only.length === 0 || only.includes(f.replace('.geojson', '')))
    .sort();

  if (geojsonFiles.length === 0) {
    console.log(`❌ No GeoJSON files found in ${inputDir}`);
    if (only.length > 0) {
      console.log(`   --only=${only.join(',')} matched nothing there`);
    } else {
      console.log(`   Run: python3 1_extract_geojson.py first`);
    }
    return;
  }

  console.log(`📁 Found ${geojsonFiles.length} GeoJSON files`);
  console.log(`🔧 Simplification: ${simplification}, Quantization: ${quantization}\n`);

  let totalInputSize = 0;
  let totalOutputSize = 0;
  let totalFeatures = 0;

  geojsonFiles.forEach((file, i) => {
    const year = file.replace('.geojson', '');
    const geojsonPath = path.join(inputDir, file);
    const topojsonPath = path.join(outputDir, `${year}.topojson`);

    try {
      const stats = convertToTopojson(geojsonPath, topojsonPath);

      totalInputSize += stats.inputSize;
      totalOutputSize += stats.outputSize;
      totalFeatures += stats.featureCount;

      const inputMB = (stats.inputSize / (1024 * 1024)).toFixed(2);
      const outputMB = (stats.outputSize / (1024 * 1024)).toFixed(2);

      console.log(
        `[${(i + 1).toString().padStart(3)}/${geojsonFiles.length}] ${year.padEnd(12)} ` +
        `${stats.featureCount.toString().padStart(6)} features  ` +
        `${inputMB.padStart(6)} MB → ${outputMB.padStart(6)} MB  ` +
        `(${stats.compression}% smaller)`
      );
    } catch (error) {
      console.log(`[${(i + 1).toString().padStart(3)}/${geojsonFiles.length}] ${year.padEnd(12)} ❌ Error: ${error.message}`);
    }
  });

  const totalInputMB = (totalInputSize / (1024 * 1024)).toFixed(2);
  const totalOutputMB = (totalOutputSize / (1024 * 1024)).toFixed(2);
  const totalCompression = ((1 - totalOutputSize / totalInputSize) * 100).toFixed(1);

  console.log(`\n✅ TopoJSON generation complete!`);
  console.log(`   Total features: ${totalFeatures.toLocaleString()}`);
  console.log(`   Total size: ${totalInputMB} MB → ${totalOutputMB} MB (${totalCompression}% smaller)`);
  console.log(`   Output: ${outputDir}/`);
}

main();
