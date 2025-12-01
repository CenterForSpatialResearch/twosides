import fs from 'fs';
import path from 'path';
import * as topojson from 'topojson-server';
import * as topojsonSimplify from 'topojson-simplify';

const geojsonPath = 'processing/geojson/2017AD_test_0.5.geojson';
const topojsonPath = 'processing/geojson/2017AD_test_0.5.topojson';

console.log('Testing TopoJSON compression on 0.5 simplified GeoJSON...');

const geojson = JSON.parse(fs.readFileSync(geojsonPath, 'utf8'));
const inputSize = fs.statSync(geojsonPath).size;

// Convert to TopoJSON with high simplification
let topology = topojson.topology({ anthromes: geojson }, 1e4);
topology = topojsonSimplify.presimplify(topology);
topology = topojsonSimplify.simplify(topology, 0.5);

fs.writeFileSync(topojsonPath, JSON.stringify(topology));
const outputSize = fs.statSync(topojsonPath).size;

console.log('\n✅ TopoJSON Results:');
console.log(`   Input (GeoJSON): ${(inputSize / (1024 * 1024)).toFixed(2)} MB`);
console.log(`   Output (TopoJSON): ${(outputSize / (1024 * 1024)).toFixed(2)} MB`);
console.log(`   Compression: ${((1 - outputSize / inputSize) * 100).toFixed(1)}%`);
