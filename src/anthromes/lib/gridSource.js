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

const cache = new Map();      // `${profile}:${set}` -> Promise<grid>
const featureCache = new Map(); // `${profile}:${set}:${year}` -> FeatureCollection

/**
 * Fetch and decode a profile's grid blobs. Cached; concurrent callers share the
 * same in-flight promise.
 *
 * `set` selects which admin boundary set attributes the cells — see
 * shared/mapProfile.js. The mask and the codes are the same blobs for
 * every set (a cell's anthrome does not depend on who claims it), so switching
 * sets refetches only the country bytes, and the browser has usually cached the
 * other two from the profile's first load.
 */
export function loadGrid(profile, set = DEFAULT_SET) {
  const key = `${profile}:${set}`;
  if (cache.has(key)) return cache.get(key);

  const p = (async () => {
    const base = import.meta.env.BASE_URL;
    const dir = `${base}grid/${profile}`;

    const manifestRes = await fetch(`${dir}/manifest.json`);
    if (!manifestRes.ok) {
      throw new Error(`No grid manifest for ${profile} (${manifestRes.status})`);
    }
    const manifest = await manifestRes.json();
    const countrySet = await resolveCountrySet(dir, manifest, set);

    const [maskBuf, countriesBuf, codesBuf] = await Promise.all([
      fetchBuffer(`${dir}/${manifest.files.mask}`),
      fetchBuffer(`${dir}/${countrySet.file}`),
      fetchBuffer(`${dir}/${manifest.files.codes}`)
    ]);

    const { ncols, nrows, nLand } = manifest;
    const landIds = decodeMask(new Uint8Array(maskBuf), ncols * nrows, nLand);
    // uint8 while the table fits in a byte, little-endian uint16 above that —
    // written that way by 2c_generate_country_sets.py. Every browser target is
    // little-endian, so the typed array can view the buffer directly.
    const countries = countrySet.bits === 16
      ? new Uint16Array(countriesBuf)
      : new Uint8Array(countriesBuf);
    const codes = new Uint8Array(codesBuf);

    if (countries.length !== nLand) {
      throw new Error(
        `${profile}/${set}: ${countrySet.file} has ${countries.length} entries, expected ${nLand}`
      );
    }

    const expected = nLand * manifest.years.length;
    if (codes.length !== expected) {
      throw new Error(`${profile}: codes.bin is ${codes.length} bytes, expected ${expected}`);
    }

    return {
      manifest, landIds, countries, codes, countrySet,
      yearIndex: indexYears(manifest.years)
    };
  })();

  cache.set(key, p);
  p.catch(() => cache.delete(key));  // let a failed load be retried
  return p;
}

// The set baked into every profile by 2b_generate_grid.py.
const DEFAULT_SET = '110m';

const setsCache = new Map();   // dir -> Promise<sets|null>

/**
 * The active set's {key, file, bits, table}.
 *
 * country-sets.json is written by 2c_generate_country_sets.py and is gitignored,
 * so it is absent on a clean checkout. When it is missing — or when it is
 * present but does not describe the requested set — this falls back to the
 * manifest's own countries.bin/countryTable, which is the 110m set. That is what
 * keeps the experiment removable: delete the generated files and the map loads
 * exactly what it loads today, with no code change.
 */
async function resolveCountrySet(dir, manifest, set) {
  const baked = {
    key: DEFAULT_SET,
    file: manifest.files.countries,
    bits: 8,
    table: manifest.countryTable || []
  };
  if (set === DEFAULT_SET && !setsCache.has(dir)) {
    // Fast path: the shipped set needs no extra request. A cached
    // country-sets.json is still preferred below, so the four sets stay
    // comparable once the experiment is installed.
    void loadCountrySets(dir);
    return baked;
  }

  const sets = await loadCountrySets(dir);
  const entry = sets?.[set];
  if (!entry) {
    if (set !== DEFAULT_SET) {
      console.warn(
        `gridSource: country set "${set}" not built for this profile; using ${DEFAULT_SET}. ` +
        'Run processing/2c_generate_country_sets.py to generate it.'
      );
    }
    return baked;
  }
  return { key: set, file: entry.file, bits: entry.bits, table: entry.table };
}

function loadCountrySets(dir) {
  let p = setsCache.get(dir);
  if (!p) {
    p = fetch(`${dir}/country-sets.json`)
      .then((res) => (res.ok ? res.json() : null))
      .then((json) => json?.sets ?? null)
      .catch(() => null);
    setsCache.set(dir, p);
  }
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
  // The set belongs in the key: properties.c is the country this cell belongs
  // to, and that is the one thing here that changes when the set does.
  const key = `${grid.manifest.profile}:${grid.countrySet.key}:${year}`;
  const hit = featureCache.get(key);
  if (hit) return hit;

  const { manifest, landIds, countries, codes } = grid;
  const yi = grid.yearIndex.get(year);
  if (yi === undefined) throw new Error(`${year} not in ${manifest.profile} manifest`);

  const countryTable = grid.countrySet.table;
  const { nLand, res, originX, originY, ncols } = manifest;
  const offset = yi * nLand;
  const features = [];

  for (let j = 0; j < nLand; j++) {
    const code = codes[offset + j];
    if (code === 0) continue;            // nodata in this year

    const cellId = landIds[j];
    const row = (cellId / ncols) | 0;
    const col = cellId - row * ncols;

    // Canonical boundary expressions — see lngAt/latAt.
    const minX = originX + col * res;
    const maxX = originX + (col + 1) * res;
    const maxY = originY - row * res;
    const minY = originY - (row + 1) * res;

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

// Longest horizontal run emitted as a single rectangle. Splitting long runs
// bounds how wrong a quad can be if it straddles a projection discontinuity,
// and costs almost nothing — runs are rarely near this long.
const MAX_RUN_COLS = 64;

/**
 * Horizontal runs of same-code cells, grouped by anthrome code.
 *
 * Adjacent cells in a row sharing an anthrome value are one rectangle, which is
 * how 182,503 cells at 33km become ~55,000 rectangles. Combined with projecting
 * corners directly rather than streaming each cell through d3.geoPath, this is
 * the difference between ~430ms and ~40ms of JS per draw.
 *
 * Returns Map<code, Int32Array> where each run is 3 consecutive ints:
 * row, colStart, colEnd (inclusive). Cached per profile+year.
 */
export function runsForYear(grid, year) {
  const key = `${grid.manifest.profile}:${year}`;
  const hit = runCache.get(key);
  if (hit) return hit;

  const { manifest, landIds, codes } = grid;
  const yi = grid.yearIndex.get(year);
  if (yi === undefined) throw new Error(`${year} not in ${manifest.profile} manifest`);

  const { nLand, ncols } = manifest;
  const offset = yi * nLand;
  const buckets = new Map();          // code -> number[]

  let curCode = 0, curRow = -1, curStart = -1, curEnd = -1;

  const flush = () => {
    if (curCode === 0) return;
    let b = buckets.get(curCode);
    if (!b) buckets.set(curCode, (b = []));
    b.push(curRow, curStart, curEnd);
  };

  // landIds is ascending cellId, and cellId = row*ncols + col, so this walk is
  // already in row-major order — runs fall out of a single pass.
  for (let j = 0; j < nLand; j++) {
    const code = codes[offset + j];
    if (code === 0) continue;

    const cellId = landIds[j];
    const row = (cellId / ncols) | 0;
    const col = cellId - row * ncols;

    const continues = code === curCode && row === curRow && col === curEnd + 1 &&
      (curEnd - curStart + 1) < MAX_RUN_COLS;

    if (continues) {
      curEnd = col;
    } else {
      flush();
      curCode = code; curRow = row; curStart = col; curEnd = col;
    }
  }
  flush();

  const out = new Map();
  for (const [code, arr] of buckets) out.set(code, Int32Array.from(arr));
  runCache.set(key, out);
  return out;
}

const runCache = new Map();

/**
 * The lng/lat corners of a run, as [west, east, north, south].
 * Runs cover columns colStart..colEnd inclusive on the given row.
 */
export function runBounds(grid, row, colStart, colEnd) {
  const { res, originX, originY } = grid.manifest;
  return [
    lngAt(originX, res, colStart),
    lngAt(originX, res, colEnd + 1),
    latAt(originY, res, row),
    latAt(originY, res, row + 1)
  ];
}

// Every lattice boundary must come from ONE expression. Deriving a cell's south
// edge as `north - res` while the row below derives its north edge as
// `originY - (row+1)*res` gives two values that differ by an ULP, so the shared
// boundary projects to two nearly-identical points and leaves a hairline seam.
// Same story horizontally with `minX + res`.
function lngAt(originX, res, col) { return originX + col * res; }
function latAt(originY, res, row) { return originY - row * res; }

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

/**
 * ISO3 -> index into manifest.countryTable, which is what countries.bin stores.
 * Entry 0 is null: ocean, ice, and the handful of land cells Natural Earth
 * leaves unattributed. Built once per grid.
 */
// Memoised off to the side, like indexCache below, rather than onto the grid
// object. These caches used to be `grid._isoIndex` etc., which threw
// state_unsafe_mutation the moment a $derived called distributionForCountry:
// App holds the grid in $state, so Svelte proxies it and a cache write became a
// reactive mutation inside a derived. That aborted the whole reactive flush,
// which took the country highlight and applyFocusFraming down with it.
// WeakMaps keep the function pure from Svelte's point of view and still drop
// with the grid.
const isoIndexCache = new WeakMap();
const countryCellsCache = new WeakMap();
const countryDistCache = new WeakMap();

function isoIndex(grid) {
  const hit = isoIndexCache.get(grid);
  if (hit) return hit;
  const map = new Map();
  const table = countryTableOf(grid);
  for (let i = 0; i < table.length; i++) {
    if (table[i]) map.set(table[i], i);
  }
  isoIndexCache.set(grid, map);
  return map;
}

/**
 * The active set's country table. Every read of it goes through here so that
 * nothing is left reaching for manifest.countryTable, which describes only the
 * baked-in 110m set and would silently mis-name every cell under another one.
 */
export function countryTableOf(grid) {
  return grid?.countrySet?.table ?? grid?.manifest?.countryTable ?? [];
}

/**
 * countryTable index -> the slots in countries.bin/codes.bin that belong to it.
 *
 * One O(nLand) counting pass, ~1ms at 83k cells, so every country after the
 * first is just a walk over its own slots instead of the whole world.
 */
function cellsByCountry(grid) {
  const hit = countryCellsCache.get(grid);
  if (hit) return hit;

  const { countries } = grid;
  // Sized from the table, not a hardcoded 256: the 10m sets need 258 and 298
  // entries, and a fixed 256 would drop every country past the byte boundary
  // (and overrun on the counting pass).
  const nCodes = countryTableOf(grid).length;
  const counts = new Uint32Array(nCodes);
  for (let j = 0; j < countries.length; j++) counts[countries[j]] += 1;

  const out = new Map();
  for (let c = 1; c < nCodes; c++) {
    if (counts[c]) out.set(c, new Uint32Array(counts[c]));
  }
  const cursor = new Uint32Array(nCodes);
  for (let j = 0; j < countries.length; j++) {
    const c = countries[j];
    if (c === 0) continue;
    out.get(c)[cursor[c]++] = j;
  }

  countryCellsCache.set(grid, out);
  return out;
}

/**
 * A country's anthrome composition in every year — the country analogue of
 * historyForCell, and another strided read across codes.bin.
 *
 * Returns the same { cell_totals, distribution } shape that
 * public/data/country-anthrome-timeseries.json carried, so WaffleChart,
 * PixelTimeline and CountryTimeseriesBar all take it unchanged. Verified to
 * reproduce that file exactly at 100km — 608 country-years, zero differences —
 * which is what licensed deleting it.
 *
 * Doing this at runtime rather than in the pipeline fixes three things the
 * precomputed file got wrong: it covered only the 8 primary countries, it was
 * built at 100km regardless of the resolution actually being drawn, and it came
 * from the ISO_A3 join that drops France and Norway (see 5_smooth_boundaries.py
 * and 2b_generate_grid.py, which reads ISO_A3_EH instead).
 *
 * Measured 3ms for Russia (the largest) at 100km, 5ms at 50km. Staying
 * synchronous is what lets the callers remain $derived, which in turn is what
 * keeps the ring's swap animation inside a single tick.
 *
 * Returns null for an ISO3 with no land in this grid.
 */
export function distributionForCountry(grid, iso3) {
  if (!grid || !iso3) return null;

  let memo = countryDistCache.get(grid);
  if (!memo) {
    memo = new Map();
    countryDistCache.set(grid, memo);
  }
  if (memo.has(iso3)) return memo.get(iso3);

  const ci = isoIndex(grid).get(iso3);
  const slots = ci == null ? null : cellsByCountry(grid).get(ci);
  if (!slots || slots.length === 0) {
    memo.set(iso3, null);
    return null;
  }

  const { manifest, codes } = grid;
  const { nLand, years } = manifest;
  const cellTotals = {};
  const distribution = {};
  const tally = new Uint32Array(256);

  for (let y = 0; y < years.length; y++) {
    tally.fill(0);
    const base = y * nLand;
    let total = 0;
    // Code 0 means "no anthrome for this cell in this year" — the same skip
    // historyForCell makes, and why cell_totals moves between years.
    for (let k = 0; k < slots.length; k++) {
      const code = codes[base + slots[k]];
      if (code !== 0) {
        tally[code] += 1;
        total += 1;
      }
    }

    const label = years[y];
    cellTotals[label] = total;
    const dist = {};
    if (total > 0) {
      for (let code = 1; code < 256; code++) {
        // String keys: WaffleChart reads dist[String(code)].
        if (tally[code]) dist[String(code)] = +(tally[code] / total).toFixed(6);
      }
    }
    distribution[label] = dist;
  }

  const result = { cell_totals: cellTotals, distribution };
  memo.set(iso3, result);
  return result;
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
    const maxX = originX + (col + 1) * res;
    const maxY = originY - row * res;
    const minY = originY - (row + 1) * res;

    if (!isLand(row - 1, col)) segments.push([[minX, maxY], [maxX, maxY]]);
    if (!isLand(row + 1, col)) segments.push([[minX, minY], [maxX, minY]]);
    if (!isLand(row, col - 1)) segments.push([[minX, minY], [minX, maxY]]);
    if (!isLand(row, col + 1)) segments.push([[maxX, minY], [maxX, maxY]]);
  }

  grid._mesh = { type: 'MultiLineString', coordinates: segments };
  return grid._mesh;
}
