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
    insideTop: 'An extensive microbiome assembly contains fragments of DNA from many communities.',
    insideBottom: '9,428 samples provide views into human-associated microbial life.',
    path: 'src/biomes/'
  },
  anthromes: {
    title: 'ANTHROMES',
    titlePos: 'right',
    subhead: 'MODELING 12,025 YEARS OF LAND USE',
    insideTop: 'Anthromes classify ecosystems according to sustained human interactions with them.',
    insideBottom: 'Population, settlement, agriculture, and land use distinguish one anthrome from another.',
    path: 'src/anthromes/'
  }
};

// BASE_FONT covers one-liners and subheadlines; the title tier is a meaningful
// step up (1.55x); text inside the disk is one step down and is auto-fitted to
// its arc, with this as the ceiling.
export const BASE_FONT  = 34;
export const TITLE_FONT = Math.round(BASE_FONT * 1.55); // 53
export const INSIDE_CAP = Math.floor(BASE_FONT * 0.72); // 24

// Radius of the in-disk definition arcs, in viewBox units. Wider than the
// splash's own dichotomy arc (r=400) because the definitions are long enough
// that the extra arc length is what keeps them above the 16px floor.
export const ARC_INSIDE_R = 440;
export const ARC_INSIDE   = Math.PI * ARC_INSIDE_R;

// The dimmed state a title takes when the other side is the one being entered.
// Same value the splash uses for the face that is turned away, so "not this
// one" reads identically whether the disk is spinning or committing.
export const TITLE_DIM = 0.32;

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
