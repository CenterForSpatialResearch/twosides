/**
 * Data adapter for loading and transforming anthrome data
 */

/**
 * Load JSON data files
 */
export async function loadData() {
  const [summaryResponse, legendResponse] = await Promise.all([
    fetch('/data/summary.json', { cache: 'no-cache' }),
    fetch('/data/anthrome-legend.json', { cache: 'no-cache' })
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
    const { year, isBC } = parseYearString(yearStr);

    // Include all BC years
    if (isBC) return true;

    // Include all AD years before 1950
    if (year < 1950) return true;

    // From 1950 onwards, include every 5 years
    return year % 5 === 0;
  });
}

/**
 * Parse a year string like "10000BC" or "2017AD"
 * @param {string} yearStr - Year string to parse
 * @returns {{ year: number, isBC: boolean, original: string }}
 */
export function parseYearString(yearStr) {
  const isBC = yearStr.endsWith('BC');
  const year = parseInt(yearStr.replace(/[^\d]/g, ''), 10);

  return {
    year,
    isBC,
    original: yearStr
  };
}

/**
 * Sort years chronologically (BC to AD, oldest to newest)
 * @param {string[]} years - Array of year strings
 * @returns {string[]} Sorted array
 */
export function sortYears(years) {
  return [...years].sort((a, b) => {
    const { year: yearA, isBC: isBCA } = parseYearString(a);
    const { year: yearB, isBC: isBCB } = parseYearString(b);

    // Both BC: larger number = older (10000BC < 1000BC)
    if (isBCA && isBCB) return yearB - yearA;

    // Both AD: normal sort
    if (!isBCA && !isBCB) return yearA - yearB;

    // BC comes before AD
    return isBCA ? -1 : 1;
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
