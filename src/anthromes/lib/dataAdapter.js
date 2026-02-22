/**
 * Data adapter for loading and transforming anthrome data
 */

/**
 * Load JSON data files
 */
export async function loadData() {
  const base = import.meta.env.BASE_URL;
  const [summaryResponse, legendResponse] = await Promise.all([
    fetch(`${base}data/summary.json`, { cache: 'no-cache' }),
    fetch(`${base}data/anthrome-legend.json`, { cache: 'no-cache' })
  ]);

  const ensureOk = (res, label) => {
    if (!res.ok) {
      throw new Error(`Failed to load ${label} (status ${res.status})`);
    }
  };

  ensureOk(summaryResponse, 'summary.json');
  ensureOk(legendResponse, 'anthrome-legend.json');

  const summary = await summaryResponse.json();
  const legend = await legendResponse.json();

  return { summary, legend };
}

/**
 * Explicit list of years to display in the visualization.
 * Format: negative = BCE, 0 = 0AD, positive = CE/AD
 *
 * Coverage:
 * - Millennial: 10000BCE - 1000BCE (10 years)
 * - Centennial: 0AD - 1700AD (18 years)
 * - Decadal: 1710 - 1940 (24 years)
 * - 5-year: 1950 - 2000 (11 years)
 * - Annual: 2005 - 2025 (11 years, with 5-year gaps early)
 *
 * Total: 74 years displayed
 */
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

/**
 * Convert numeric year to data format string (e.g., -10000 → "10000BC", 100 → "100AD")
 */
function yearToDataFormat(year) {
  if (year < 0) return `${Math.abs(year)}BC`;
  if (year === 0) return '0AD';
  return `${year}AD`;
}

// Pre-compute the set of allowed year strings for fast lookup
const ALLOWED_YEARS_SET = new Set(DISPLAY_YEARS.map(yearToDataFormat));

/**
 * Filter years to only include those in the DISPLAY_YEARS list.
 *
 * @param {string[]} allYears - Array of year strings (e.g., ["10000BC", "9000BC", ..., "2025AD"])
 * @returns {string[]} Filtered array of years
 */
export function filterYears(allYears) {
  return allYears.filter(yearStr => ALLOWED_YEARS_SET.has(yearStr));
}

/**
 * Parse a year string like "10000BC" or "2017AD" (or already formatted BCE/CE)
 * @param {string} yearStr - Year string to parse
 * @returns {{ year: number, isBCE: boolean, original: string }}
 */
export function parseYearString(yearStr) {
  const isBCE = /(BCE?|BC)$/.test(yearStr);
  const year = parseInt(yearStr.replace(/[^\d]/g, ''), 10);

  return {
    year,
    isBCE,
    original: yearStr
  };
}

/**
 * Convert a data year label to a display label (BC → BCE, AD → CE)
 * @param {string} yearStr
 * @returns {string}
 */
export function formatYearLabel(yearStr) {
  if (!yearStr) return '';
  if (yearStr.endsWith('BCE') || yearStr.endsWith('CE')) return yearStr;
  if (yearStr.endsWith('BC')) return yearStr.replace(/BC$/, 'BCE');
  if (yearStr.endsWith('AD')) return yearStr.replace(/AD$/, 'CE');
  return yearStr;
}

/**
 * Sort years chronologically (BCE to CE/AD, oldest to newest)
 * @param {string[]} years - Array of year strings
 * @returns {string[]} Sorted array
 */
export function sortYears(years) {
  return [...years].sort((a, b) => {
    const { year: yearA, isBCE: isBCEA } = parseYearString(a);
    const { year: yearB, isBCE: isBCEB } = parseYearString(b);

    // Both BCE: larger number = older (10000BCE < 1000BCE)
    if (isBCEA && isBCEB) return yearB - yearA;

    // Both CE: normal sort
    if (!isBCEA && !isBCEB) return yearA - yearB;

    // BCE comes before CE
    return isBCEA ? -1 : 1;
  });
}

/**
 * Get ordered list of anthrome codes based on legend
 * @param {Object} legend - Legend object with anthrome codes as keys
 * @returns {number[]} Sorted array of anthrome codes
 */
export function getOrderedAnthromesCodes(legend) {
  return Object.keys(legend)
    .map(code => parseInt(code, 10))
    .sort((a, b) => a - b);
}

/**
 * Transform raw data into chart-ready format
 * @param {Object} summary - Summary data with years and counts
 * @param {Object} legend - Legend with anthrome info
 * @returns {Object} Transformed data ready for visualization
 */
export function transformData(summary, legend) {
  const allYears = Object.keys(summary.years);
  const sortedYears = sortYears(allYears);
  const filteredYears = filterYears(sortedYears);
  const orderedCodes = getOrderedAnthromesCodes(legend);

  // Create data array for each year
  const data = filteredYears.map(yearStr => {
    const yearData = summary.years[yearStr];

    return {
      year: yearStr,
      counts: yearData.counts,
      total: yearData.total,
      percentages: yearData.percentages
    };
  });

  // Create color mapping
  const colorMapping = {};
  orderedCodes.forEach(code => {
    if (legend[code]) {
      colorMapping[code] = legend[code].color;
    }
  });

  // Create label mapping
  const labelMapping = {};
  orderedCodes.forEach(code => {
    if (legend[code]) {
      labelMapping[code] = legend[code].label;
    }
  });

  return {
    data,
    years: filteredYears,
    allYears: sortedYears,
    orderedCodes,
    colorMapping,
    labelMapping,
    legend
  };
}

/**
 * Main function to load and prepare all data
 * @returns {Promise<Object>} Transformed data ready for visualization
 */
export async function prepareAnthromesData() {
  const { summary, legend } = await loadData();
  return transformData(summary, legend);
}
