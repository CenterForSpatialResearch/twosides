/**
 * Data adapter for loading and transforming biomes taxonomy data
 */

/**
 * Color mapping for phylums (from original visualization)
 */
export const colorMapping = {
  "Actinobacteria": "#1385eb",
  "Bacteroidetes": "#b1f16e",
  "Candidatus_Gracilibacteria": "#eb9c13",
  "Candidatus_Melainabacteria": "#ebe013",
  "Candidatus_Saccharibacteria": "#6eeb13",
  "Chlamydiae": "#eb139c",
  "Cyanobacteria": "#4717f6",
  "Deinococcus_Thermus": "#13eb85",
  "Elusimicrobia": "#eb1357",
  "Euryarchaeota": "#eb13e0",
  "Firmicutes": "#AA55DA",
  "Fusobacteria": "#c77dff",
  "Planctomycetes": "#5f0f40",
  "Proteobacteria": "#13ebc9",
  "Spirochaetes": "#fb5607",
  "Synergistetes": "#ff006e",
  "Tenericutes": "#8338ec",
  "Unknown": "#13eb40",
  "Verrucomicrobia": "#3a86ff",
  "Other": "#cccccc"
};

/**
 * Pick text color (black or white) based on background luminance
 * @param {string} hex - Hex color code
 * @returns {string} '#0e0b16' or '#ffffff'
 */
export function pickTextColor(hex) {
  const c = hex.replace('#', '');
  const r = parseInt(c.slice(0, 2), 16) / 255;
  const g = parseInt(c.slice(2, 4), 16) / 255;
  const b = parseInt(c.slice(4, 6), 16) / 255;
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return lum > 0.5 ? '#0e0b16' : '#ffffff';
}

/**
 * Load taxonomy tree data
 * @returns {Promise<Object>} Taxonomy tree object
 */
export async function loadTaxonomyData() {
  try {
    const base = import.meta.env.BASE_URL;
    const response = await fetch(`${base}data/sgb_taxonomy_tree.json`);

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const data = await response.json();
    return data;
  } catch (error) {
    console.error('Failed to load taxonomy tree:', error);
    throw error;
  }
}

/**
 * Metadata helper keys for different field names
 */
const KEYMAP = {
  locations: ['Locations', 'Sample_Locations', 'Countries', 'SampleCountries', 'Sample Sites', 'sites', 'locations'],
  uSGB: ['uSGB', 'novel', 'Novel', 'unknownSGB', 'Unknown_SGB'],
  western: ['Westernized_Mode', 'Westernized_List', 'Westernized', 'westernized', 'Westernization']
};

/**
 * Get metadata value from possible keys
 * @param {Object} meta - Metadata object
 * @param {string[]} keys - Array of possible key names
 * @returns {*} Value or undefined
 */
function getMeta(meta, keys) {
  for (const k of keys) {
    if (meta && meta[k] != null) return meta[k];
  }
}

/**
 * Parse maybe-list value (could be array, JSON string, or comma-separated)
 * @param {*} v - Value to parse
 * @returns {Array} Array of values
 */
function parseMaybeList(v) {
  if (v == null) return [];
  if (Array.isArray(v)) return v;
  const s = String(v).trim();
  if (!s) return [];
  if (s.startsWith('[') && s.endsWith(']')) {
    try {
      const arr = JSON.parse(s);
      return Array.isArray(arr) ? arr : [String(arr)];
    } catch (_) {}
  }
  if (s.includes(',')) return s.split(',').map(x => x.trim());
  return [s];
}

/**
 * Parse western metadata (various formats)
 * @param {Object} meta - Metadata object
 * @returns {string|null} 'western', 'nonwestern', or null
 */
export function parseWestern(meta) {
  if (!meta) return null;

  const mode = (meta.Westernized_Mode ?? meta.westernized_mode ?? '').toString().toLowerCase();
  if (['yes', 'true', 'western'].includes(mode)) return 'western';
  if (['no', 'false', 'non-western', 'nonwestern'].includes(mode)) return 'nonwestern';

  const raw = getMeta(meta, ['Westernized_List', 'Westernized', 'westernized', 'Westernization']);
  const values = parseMaybeList(raw).map(x => x.toString().toLowerCase());
  if (values.some(v => ['yes', 'true', 'western'].includes(v))) return 'western';
  if (values.some(v => ['no', 'false', 'non-western', 'nonwestern'].includes(v))) return 'nonwestern';

  const scalar = (raw ?? '').toString().toLowerCase();
  if (['yes', 'true', 'western'].includes(scalar)) return 'western';
  if (['no', 'false', 'non-western', 'nonwestern'].includes(scalar)) return 'nonwestern';

  return null;
}

/**
 * Get locations from metadata
 * @param {Object} meta - Metadata object
 * @returns {string} Human-readable location string
 */
export function locationsFromMeta(meta, nameMap) {
  if (!meta) return '—';

  let v = meta["Country_List"];

  if (!v) {
    const possibleKeys = ['Locations', 'Sample_Locations', 'Countries', 'SampleCountries', 'Sample Sites', 'sites', 'locations'];
    for (const k of possibleKeys) {
      if (meta[k] != null) {
        v = meta[k];
        break;
      }
    }
  }
  if (!v) return 'various global sites';

  let arr = [];
  if (Array.isArray(v)) arr = v;
  else if (typeof v === 'string') {
    try {
      const parsed = JSON.parse(v);
      if (Array.isArray(parsed)) arr = parsed;
      else arr = v.split(',').map(s => s.trim());
    } catch {
      arr = v.split(',').map(s => s.trim());
    }
  }

  arr = arr.filter(Boolean);
  if (!arr.length) return 'various global sites';

  const uniq = Array.from(new Set(arr.map(s => s.trim())));
  const named = nameMap ? uniq.map(code => nameMap.get(code) || code) : uniq;

  const shown = named.slice(0, 5).join(', ');
  if (named.length > 5) {
    const remaining = named.length - 5;
    return `${shown}, and ${remaining} other global site${remaining > 1 ? 's' : ''}`;
  }
  return shown;
}

/**
 * Parse unknown SGB status
 * @param {Object} meta - Metadata object
 * @returns {string|null} 'Yes', 'No', or null
 */
export function parseUSGB(meta) {
  const v = getMeta(meta, KEYMAP.uSGB);
  if (v == null) return null;
  const s = String(v).toLowerCase();
  return (s === 'yes' || s === 'true' || s === '1' || s === 'unknown' || s === 'novel') ? 'Yes' : 'No';
}

/**
 * Get western label for display
 * @param {Object} meta - Metadata object
 * @returns {string} 'Western', 'Non-Western', or '—'
 */
export function westernLabel(meta) {
  const v = parseWestern(meta);
  if (v === 'western') return 'Western';
  if (v === 'nonwestern') return 'Non-Western';

  const mode = meta?.Westernized_Mode ?? meta?.westernized_mode ?? null;
  if (mode) return String(mode);

  const list = getMeta(meta, KEYMAP.western);
  if (list != null) return Array.isArray(list) ? list.join(', ') : String(list);

  return '—';
}

/**
 * Check if metadata indicates non-western
 * @param {Object} meta - Metadata object
 * @returns {boolean}
 */
export function isWesternNo(meta) {
  return parseWestern(meta) === 'nonwestern';
}

/**
 * Check if metadata indicates western
 * @param {Object} meta - Metadata object
 * @returns {boolean}
 */
export function isWesternYes(meta) {
  return parseWestern(meta) === 'western';
}

/**
 * Get phylum from node (depth 2 ancestor)
 * @param {Object} d - D3 hierarchy node
 * @returns {string} Phylum name
 */
export function getPhylum(d) {
  if (d?.data?.phylum) return d.data.phylum;

  const ancestor = d.ancestors().find(n => n.depth === 2);
  if (ancestor) {
    const parts = (ancestor.data.name || '').split("__");
    return parts.length > 1 ? parts[1] : (ancestor.data.name || 'Other');
  }
  return 'Other';
}

/**
 * Get pretty name from node (remove prefix)
 * @param {Object} d - D3 hierarchy node
 * @returns {string} Pretty name
 */
export function prettyName(d) {
  const raw = (d?.data?.name || '').split("__").pop();
  return raw ? raw.replace(/_/g, ' ') : '(unnamed)';
}

/**
 * Get lineage string (ancestor chain)
 * @param {Object} d - D3 hierarchy node
 * @returns {string} Lineage string like "Bacteria › Firmicutes › Bacilli"
 */
export function lineage(d) {
  return d.ancestors()
    .slice(0, -1)
    .map(a => (a.data.name || '').split('__').pop()?.replace(/_/g, ' ') || '')
    .filter(Boolean)
    .reverse()
    .join(' › ');
}

/**
 * Safe display value with fallback
 * @param {*} val - Value to display
 * @param {string} fb - Fallback (default '—')
 * @returns {string} Display value
 */
export function safe(val, fb = '—') {
  return (val !== undefined && val !== null && val !== '' ? val : fb);
}

/**
 * Get SGB label (extract SGB number or use pretty name)
 * @param {Object} d - D3 hierarchy node
 * @returns {string} SGB label
 */
export function sgbLabel(d) {
  const nm = (d?.data?.name || '').split('__').pop() || '';
  const m = nm.match(/SGB[_\s-]?(\d+)/i);
  return m ? `SGB ${m[1]}` : prettyName(d);
}

/**
 * Main function to prepare biomes data
 * @returns {Promise<Object>} Taxonomy tree and metadata
 */
export async function prepareBiomesData() {
  const taxonomyTree = await loadTaxonomyData();

  return {
    taxonomyTree
  };
}
