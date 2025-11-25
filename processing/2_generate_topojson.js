#!/usr/bin/env node
/**
 * Generate TopoJSON files from GeoJSON with configurable simplification.
 *
 * Converts GeoJSON polygons to TopoJSON format with topology preservation
 * and optional simplification to reduce file size.
 *
 * Usage:
 *   node 2_generate_topojson.js [--simplification=0.05] [--quantization=1e4]
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import * as topojson from 'topojson-server';
import * as topojsonSimplify from 'topojson-simplify';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Configuration
const INPUT_DIR = path.join(__dirname, 'geojson');
const OUTPUT_DIR = path.join(__dirname, '../public/topojson');

// Parse CLI arguments
const args = process.argv.slice(2);
const simplification = parseFloat(
  args.find(arg => arg.startsWith('--simplification='))?.split('=')[1] || '0.05'
);
const quantization = parseFloat(
  args.find(arg => arg.startsWith('--quantization='))?.split('=')[1] || '1e4'
);

/**
 * Convert a single GeoJSON file to TopoJSON
 */
function convertToTopojson(geojsonPath, topojsonPath) {
  // Read GeoJSON
  const geojson = JSON.parse(fs.readFileSync(geojsonPath, 'utf8'));
  const inputSize = fs.statSync(geojsonPath).size;

  // Convert to TopoJSON
  let topology = topojson.topology({ anthromes: geojson }, quantization);

  // Apply simplification if specified
  if (simplification > 0) {
    topology = topojsonSimplify.presimplify(topology);
    topology = topojsonSimplify.simplify(topology, simplification);
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
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  // Get all GeoJSON files
  const geojsonFiles = fs.readdirSync(INPUT_DIR)
    .filter(f => f.endsWith('.geojson'))
    .sort();

  if (geojsonFiles.length === 0) {
    console.log(`❌ No GeoJSON files found in ${INPUT_DIR}`);
    console.log(`   Run: python3 1_extract_geojson.py first`);
    return;
  }

  console.log(`📁 Found ${geojsonFiles.length} GeoJSON files`);
  console.log(`🔧 Simplification: ${simplification}, Quantization: ${quantization}\n`);

  let totalInputSize = 0;
  let totalOutputSize = 0;
  let totalFeatures = 0;

  geojsonFiles.forEach((file, i) => {
    const year = file.replace('.geojson', '');
    const geojsonPath = path.join(INPUT_DIR, file);
    const topojsonPath = path.join(OUTPUT_DIR, `${year}.topojson`);

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
  console.log(`   Output: ${OUTPUT_DIR}/`);
}

main();
