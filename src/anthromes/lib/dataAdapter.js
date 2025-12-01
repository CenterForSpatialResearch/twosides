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
 * Filter years based on the rule:
 * - All years before 1950
 * - Every 5 years from 1950 onwards
 *
 * @param {string[]} allYears - Array of year strings (e.g., ["10000BC", "9000BC", ..., "2017AD"])
 * @returns {string[]} Filtered array of years
 */
export function filterYears(allYears) {
  return allYears.filter(yearStr => {
    const { year, isBCE } = parseYearString(yearStr);

    // Include all BCE years
    if (isBCE) return true;

    // Include all CE/AD years before 1950
    if (year < 1950) return true;

    // From 1950 onwards, include every 5 years
    return year % 5 === 0;
  });
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
