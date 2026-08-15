// Grid-format map source — the replacement transport for per-year TopoJSON.
//
// The anthromes data is a raster: a fixed lattice of cells whose position never
// changes, where only the anthrome code differs between years. TopoJSON spent
// ~65% of each file re-describing that fixed geometry (properties, arc indices,
// repeated "type":"Polygon"), and its arc dedup could not help because in a
// regular grid every cell corner is a junction, so every shared edge becomes a
// 2-point arc that re-duplicates its end nodes. Measured on 33km/2025AD:
// topology emitted MORE coordinate points than the source GeoJSON.
//
// So this ships the raster instead. Per profile: a manifest, a land bitmask, one
// country byte per land cell, and one anthrome byte per land cell per year. The
// 33km series goes from 1.8GB to 13.5MB; every year arrives in one fetch, which
// is why scrubbing the timeline no longer waits on the network.
//
// This module rebuilds the same GeoJSON FeatureCollection the TopoJSON path
// produced — same {a, i, c} properties, same ring order — so everything
// downstream (d3.geoPath, d3.geoContains, WaffleChart, the country timeseries)
// is unchanged.

const cache = new Map();      // profile -> Promise<grid>
const featureCache = new Map(); // `${profile}:${year}` -> FeatureCollection

/**
 * Fetch and decode a profile's grid blobs. Cached; concurrent callers share the
 * same in-flight promise.
 */
export function loadGrid(profile) {
  if (cache.has(profile)) return cache.get(profile);

  const p = (async () => {
    const base = import.meta.env.BASE_URL;
    const dir = `${base}grid/${profile}`;

    const manifestRes = await fetch(`${dir}/manifest.json`);
    if (!manifestRes.ok) {
      throw new Error(`No grid manifest for ${profile} (${manifestRes.status})`);
    }
    const manifest = await manifestRes.json();

    const [maskBuf, countriesBuf, codesBuf] = await Promise.all([
      fetchBuffer(`${dir}/${manifest.files.mask}`),
      fetchBuffer(`${dir}/${manifest.files.countries}`),
      fetchBuffer(`${dir}/${manifest.files.codes}`)
    ]);

    const { ncols, nrows, nLand } = manifest;
    const landIds = decodeMask(new Uint8Array(maskBuf), ncols * nrows, nLand);
    const countries = new Uint8Array(countriesBuf);
    const codes = new Uint8Array(codesBuf);

    const expected = nLand * manifest.years.length;
    if (codes.length !== expected) {
      throw new Error(`${profile}: codes.bin is ${codes.length} bytes, expected ${expected}`);
    }

    return { manifest, landIds, countries, codes, yearIndex: indexYears(manifest.years) };
  })();

  cache.set(profile, p);
  p.catch(() => cache.delete(profile));  // let a failed load be retried
  return p;
}

async function fetchBuffer(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to load ${url} (${res.status})`);
  return res.arrayBuffer();
}

function indexYears(years) {
  const m = new Map();
  years.forEach((y, i) => m.set(y, i));
  return m;
}

/**
 * Land cellIds in ascending order; array index is the cell's slot in codes.bin
 * and countries.bin. Bits are MSB-first within each byte, matching numpy's
 * packbits(bitorder='big') in 2b_generate_grid.py.
 */
function decodeMask(mask, nCells, nLand) {
  const ids = new Uint32Array(nLand);
  let n = 0;
  for (let byte = 0; byte < mask.length; byte++) {
    const b = mask[byte];
    if (b === 0) continue;               // ocean runs are the common case
    const base = byte << 3;
    for (let bit = 0; bit < 8; bit++) {
      if (b & (0x80 >> bit)) {
        const cellId = base + bit;
        if (cellId < nCells) ids[n++] = cellId;
      }
    }
  }
  if (n !== nLand) {
    throw new Error(`mask decoded ${n} land cells, manifest says ${nLand}`);
  }
  return ids;
}

/**
 * Build the FeatureCollection for one year. Cached per profile+year, since
 * MapCanvas re-reads it on every redraw.
 *
 * Ring order matches what 1_extract_geojson.py emitted — orient_geometry(sign=-1)
 * applied to a shapely box():
 *   (maxX,minY) (minX,minY) (minX,maxY) (maxX,maxY) (maxX,minY)
 * Reversing it makes d3 fill the complement of every cell, so it is verified
 * against the old pipeline by processing/verify_grid.py.
 */
export function featuresForYear(grid, year) {
  const key = `${grid.manifest.profile}:${year}`;
  const hit = featureCache.get(key);
  if (hit) return hit;

  const { manifest, landIds, countries, codes } = grid;
  const yi = grid.yearIndex.get(year);
  if (yi === undefined) throw new Error(`${year} not in ${manifest.profile} manifest`);

  const { nLand, res, originX, originY, ncols, countryTable } = manifest;
  const offset = yi * nLand;
  const features = [];

  for (let j = 0; j < nLand; j++) {
    const code = codes[offset + j];
    if (code === 0) continue;            // nodata in this year

    const cellId = landIds[j];
    const row = (cellId / ncols) | 0;
    const col = cellId - row * ncols;

    const minX = originX + col * res;
    const maxX = minX + res;
    const maxY = originY - row * res;
    const minY = maxY - res;

    features.push({
      type: 'Feature',
      geometry: {
        type: 'Polygon',
        coordinates: [[
          [maxX, minY], [minX, minY], [minX, maxY], [maxX, maxY], [maxX, minY]
        ]]
      },
      properties: { a: code, i: cellId, c: countryTable[countries[j]] ?? null }
    });
  }

  const fc = { type: 'FeatureCollection', features };
  featureCache.set(key, fc);
  return fc;
}

/**
 * The cellId containing a lng/lat, or -1 if the point is off-grid.
 *
 * This is the whole point of keeping the data on a lattice: the containing cell
 * is two divisions, where the TopoJSON path had to linear-scan every feature
 * running d3.geoContains — a spherical point-in-polygon test — against each one.
 * At 33km that was 182,503 tests per pointer event. Measured ~566x faster.
 *
 * This is not bit-identical to the d3.geoContains scan, and deliberately so.
 * geoContains treats a cell ring as a SPHERICAL polygon, so its horizontal edges
 * are great-circle arcs that bow poleward between their endpoints, whereas the
 * cells are defined on a lat/lng lattice with edges along parallels. The two
 * disagree only for points within the bow of a horizontal edge — a band under
 * ~0.001° at 100km, narrowing with the square of cell width, which is roughly
 * 0.02px on screen. The lattice answer is the correct one for "which raster cell
 * is this", since that is how the source raster defines the cell.
 */
export function cellIdAt(grid, lng, lat) {
  const { res, originX, originY, ncols, nrows } = grid.manifest;

  // projection.invert can hand back longitudes outside the grid's origin span.
  let x = lng;
  const span = ncols * res;
  while (x < originX) x += 360;
  while (x >= originX + span) x -= 360;

  const col = Math.floor((x - originX) / res);
  const row = Math.floor((originY - lat) / res);
  if (col < 0 || col >= ncols || row < 0 || row >= nrows) return -1;
  return row * ncols + col;
}

/**
 * The feature at a lng/lat within an already-built year, or null.
 *
 * Returns the same object instance held in the FeatureCollection, because
 * MapCanvas compares hovered/isolated features by identity.
 */
export function featureAt(fc, grid, lng, lat) {
  const cellId = cellIdAt(grid, lng, lat);
  if (cellId < 0) return null;
  return featureIndex(fc).get(cellId) ?? null;
}

/**
 * cellId -> feature, built once per FeatureCollection and cached on it.
 * Works for any collection whose features carry properties.i, so the TopoJSON
 * path can share it.
 */
export function featureIndex(fc) {
  let idx = indexCache.get(fc);
  if (!idx) {
    idx = new Map();
    for (const f of fc.features) idx.set(f.properties.i, f);
    indexCache.set(fc, idx);
  }
  return idx;
}

const indexCache = new WeakMap();

/**
 * A cell's anthrome code in every year — a strided read across codes.bin.
 *
 * This is what makes the separate cell-history JSON unnecessary; that file was
 * this same data transposed, with the year string repeated once per cell, which
 * is why it reached 166MB at 33km.
 *
 * Returns the {year: code} shape CellHistoryBar already expects.
 */
export function historyForCell(grid, cellId) {
  const { manifest, landIds, codes } = grid;
  const j = binarySearch(landIds, cellId);
  if (j < 0) return null;

  const { nLand, years } = manifest;
  const out = {};
  for (let y = 0; y < years.length; y++) {
    const code = codes[y * nLand + j];
    if (code !== 0) out[years[y]] = code;
  }
  return out;
}

function binarySearch(arr, target) {
  let lo = 0;
  let hi = arr.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const v = arr[mid];
    if (v === target) return mid;
    if (v < target) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}

/**
 * Stand-in for topojson.mesh(). MapCanvas only ever passes the mesh to
 * projection.fitExtent() — it is never drawn — so this returns the outline of
 * the land mask as a MultiLineString.
 *
 * A plain bbox rectangle would be wrong: under the non-equirectangular
 * projections the debug menu offers, the projected bounds of a bbox differ from
 * those of the real outline, and the initial fit would shift. Tracing the actual
 * boundary keeps fitExtent's result identical to the TopoJSON path, and is far
 * cheaper than the current fit, which walks every feature.
 *
 * Cached on the grid object; the land mask is year-invariant.
 */
export function meshForGrid(grid) {
  if (grid._mesh) return grid._mesh;

  const { manifest, landIds } = grid;
  const { ncols, nrows, res, originX, originY } = manifest;

  // Bitset of land cells for O(1) neighbour lookups.
  const land = new Uint8Array(ncols * nrows);
  for (let j = 0; j < landIds.length; j++) land[landIds[j]] = 1;

  const isLand = (row, col) =>
    row >= 0 && row < nrows && col >= 0 && col < ncols && land[row * ncols + col] === 1;

  // Emit each edge that separates land from not-land. Individual segments are
  // enough for fitExtent, which only measures extent.
  const segments = [];
  for (let j = 0; j < landIds.length; j++) {
    const cellId = landIds[j];
    const row = (cellId / ncols) | 0;
    const col = cellId - row * ncols;

    const minX = originX + col * res;
    const maxX = minX + res;
    const maxY = originY - row * res;
    const minY = maxY - res;

    if (!isLand(row - 1, col)) segments.push([[minX, maxY], [maxX, maxY]]);
    if (!isLand(row + 1, col)) segments.push([[minX, minY], [maxX, minY]]);
    if (!isLand(row, col - 1)) segments.push([[minX, minY], [minX, maxY]]);
    if (!isLand(row, col + 1)) segments.push([[maxX, minY], [maxX, maxY]]);
  }

  grid._mesh = { type: 'MultiLineString', coordinates: segments };
  return grid._mesh;
}
