// Copy and type scale for the two "entering a side" screens: the splash's
// commit transition (src/splash/narrative.js) and the cross-link interstitial
// (loading.html). They show the same words at the same sizes on the same arcs,
// so they read as one screen rather than two — which only holds if there is one
// copy of the values.

export const SIDE_COPY = {
  biomes: {
    title: 'BIOMES',
    // Which title arc this side owns. The other arc carries LOADING.
    titlePos: 'left',
    subhead: '5000 LINES 5000 SPECIES',
    path: 'src/biomes/'
  },
  anthromes: {
    title: 'ANTHROMES',
    titlePos: 'right',
    subhead: 'MODELING 12,025 YEARS OF LAND USE',
    path: 'src/anthromes/'
  }
};

// BASE_FONT covers one-liners and subheadlines; the title tier is a meaningful
// step up (1.8x); the splash's dichotomies sit one step down and are
// auto-fitted to their arcs, with INSIDE_CAP as the floor of that ceiling; the
// "select to enter" hint under each title is the smallest tier.
export const BASE_FONT  = 34;
export const TITLE_FONT = Math.round(BASE_FONT * 1.8);  // 61
export const INSIDE_CAP = Math.floor(BASE_FONT * 0.72); // 24
export const ENTER_FONT = Math.round(BASE_FONT * 0.6);  // 20

/** Where a side lives, under whatever base path the build is served from. */
export function sideHref(side) {
  return import.meta.env.BASE_URL + SIDE_COPY[side].path;
}

/**
 * The type scale for a splash variant (splashVariant() in pageStage.js).
 *
 * 'full' is the constants above. 'compact' is a phone: held upright the
 * composition is fitted by its width, sideways by a very short height, and
 * either way the scale is around 0.2, where the full sizes render at 4-12 CSS
 * px. Every tier goes up by COMPACT_TYPE — as far as the titles can go before
 * their ring outgrows an upright phone — and the two tiers that were still
 * unreadable get more:
 *   enter   the smallest tier, doubled instead
 *   subCap / subSpan   the dichotomies. SVG text cannot wrap, so a dichotomy
 *           is as large as its arc is long: fitToArc() shrinks it to fit. On a
 *           quarter turn at r=615 that tops out around 9 CSS px however high
 *           the cap, so compact widens the arc (nothing else sits at that
 *           radius) and lifts the cap to let the text use it. If that is still
 *           too small by eye, the next lever is two concentric arcs, each
 *           carrying half the sentence — which needs a break point per string
 *           in DICHOTOMIES (narrative.js).
 */
const COMPACT_TYPE = 1.45;
export function splashType(variant = 'full') {
  if (variant !== 'compact') {
    return {
      base: BASE_FONT, title: TITLE_FONT, enter: ENTER_FONT, frame: 42,
      subCap: BASE_FONT, subSpan: Math.PI / 2
    };
  }
  const up = (v) => Math.round(v * COMPACT_TYPE);
  return {
    base: up(BASE_FONT), title: up(TITLE_FONT), enter: ENTER_FONT * 2, frame: up(42),
    subCap: 64, subSpan: (150 * Math.PI) / 180
  };
}

// Title ring radius, in viewBox units (the disk's radius is 500), for the
// final ui's splash (and the trials) and loading.html, so the cross-link
// interstitial lands its titles where the splash's commit state left them. The
// framing line across the top of the splash rides this ring; its ascenders
// reach ~r+25, i.e. ~860 design px above centre: ~140px clear of the top edge
// of the 2000px canvas. The older passes' splash anchors its titles to the
// canvas instead (~1083).
export const TITLE_RING_R = 930;

// The dimmed state a title takes when the other side is the one being entered
// (LOADING, on both this screen and loading.html).
export const TITLE_DIM = 0.32;

// The dim the splash gives the side whose face is turned away while the disk
// spins — and its dichotomy and enter hint with it. Deeper than TITLE_DIM so
// the side in rotation carries the screen.
export const TITLE_AWAY = 0.2;

/**
 * Fit `content` to an arc by binary search on font-size.
 *
 * SVG has no text wrapping, so the only fit control is size. Callers pass the
 * arc length they must stay inside; `slack` reserves a little of it so the text
 * never runs right up to the ends of the path.
 */
export function fitToArc(textEl, textPath, content, arcLen, { min = 16, max = INSIDE_CAP, slack = 0.92 } = {}) {
  textPath.textContent = content;
  let lo = min, hi = max, best = min;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    textEl.setAttribute('font-size', mid);
    if (textEl.getComputedTextLength() <= arcLen * slack) { best = mid; lo = mid + 1; }
    else                                                  { hi = mid - 1; }
  }
  textEl.setAttribute('font-size', best);
  return best;
}

/**
 * Build "LOADING" followed by three dots as separate <tspan>s, and return a
 * ticker that pulses their opacity.
 *
 * The dots always occupy their slot and only opacity changes, so the word never
 * shifts along the arc as the ellipsis animates — measured once at full width
 * and never resized.
 */
export function buildLoadingLabel(pathEl) {
  const NS = 'http://www.w3.org/2000/svg';
  pathEl.textContent = '';
  pathEl.appendChild(document.createTextNode('LOADING'));
  const dots = [];
  for (let i = 0; i < 3; i++) {
    const t = document.createElementNS(NS, 'tspan');
    t.setAttribute('class', 'dot off');
    t.textContent = '.';
    pathEl.appendChild(t);
    dots.push(t);
  }
  let phase = 0;
  return function tick() {
    phase = (phase + 1) % 4;
    // Dots come on one at a time; when phase wraps to 0 they all dim.
    for (let i = 0; i < 3; i++) {
      dots[i].setAttribute('class', 'dot ' + (phase >= i + 1 ? 'on' : 'off'));
    }
  };
}
