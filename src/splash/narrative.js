// The 8/21 narrative splash (UI option 1).
//
// The coin turns continuously; each 20s rotation swaps in a new framing line on
// an arc outside the disk and a new half-sentence on each face, so the two sides
// complete a thought the reader only gets by watching the disk turn. Content
// swaps happen at the rotation boundary, while the fade envelope holds the text
// at zero opacity, so the change is never seen mid-word.
import { DESIGN_W } from '../shared/pageStage.js';

const URLS = { biomes: 'loading.html?side=biomes', anthromes: 'loading.html?side=anthromes' };

// Four framing one-liners, alternating top/bottom placement each rotation.
// Line 4 leaves its "microbial and planetary" tail to the in-disk dichotomy.
const OUTER_LINES = [
  { pos: 'top',    text: "Two classifications describe life at radically different scales." },
  { pos: 'bottom', text: "Both transform continuous worlds into categories that can be counted." },
  { pos: 'top',    text: "Both are global datasets assembled from many local observations." },
  { pos: 'bottom', text: "The disk moves between two scales of human life and relations",
    dichotomyOverride: { biomes: "microbial", anthromes: "planetary" } }
];

const DICHOTOMIES = [
  { biomes:    "One begins inside the human body.",
    anthromes: "The other begins with the inhabited Earth." },
  { biomes:    "One organizes microbial genomes.",
    anthromes: "The other organizes human-altered landscapes." }
];

// Font sizes shared with loading.html so the two screens read as one design.
// BASE_FONT covers one-liners / subheadlines; the title tier is a meaningful
// step up (1.55x); in-disk text is one step down.
const BASE_FONT  = 34;
const TITLE_FONT = Math.round(BASE_FONT * 1.55); // 53

const ARC_FACE = Math.PI * 400;  // in-disk dichotomy arc, r=400 viewBox units
const PERIOD   = 20000;
const FADE_MS  = 4000;

export function mountNarrative(root) {
  const $ = (sel) => root.querySelector(sel);

  const coin           = $('#coin');
  const labelBiomes    = $('#label-biomes');
  const labelAnthromes = $('#label-anthromes');
  const lineTop        = $('#line-top');
  const lineTopPath    = lineTop.querySelector('textPath');
  const lineBottom     = $('#line-bottom');
  const lineBottomPath = lineBottom.querySelector('textPath');
  const biomesText     = $('#biomes-text');
  const biomesPath     = biomesText.querySelector('textPath');
  const anthromesText  = $('#anthromes-text');
  const anthromesPath  = anthromesText.querySelector('textPath');
  const enter          = $('#enter');

  // Position the title arcs so their midpoint (9 o'clock for BIOMES, 3 o'clock
  // for ANTHROMES) sits halfway between the disk edge and the canvas edge.
  // Anchored to the fixed design canvas rather than the window: the page is
  // authored 1:1 against DESIGN_W and scaled by one transform, so this is a
  // constant and is measured once rather than on every resize.
  function updateTitleArcs() {
    // Layout width, so the .stage transform doesn't enter into it.
    const diskWidth = root.querySelector('.disk-area').offsetWidth;
    if (!diskWidth) return;

    // Anchor in px from disk center: (canvas half-width + disk half-width) / 2.
    // Converted to viewBox units (viewBox 1000 == diskWidth px):
    //   r_viewbox = anchor_px * 1000 / diskWidth
    //             = (vw/2 + diskWidth/2) / 2 * 1000 / diskWidth
    //             = 250 * (vw/diskWidth + 1)
    const r = Math.round(250 * (DESIGN_W / diskWidth + 1));
    const off = (r * Math.SQRT1_2).toFixed(2);
    // BIOMES: 7:30 -> 10:30 via 9 (sweep=1, short arc).
    $('#arc-title-left').setAttribute('d', `M -${off} ${off} A ${r} ${r} 0 0 1 -${off} -${off}`);
    // ANTHROMES: 1:30 -> 4:30 via 3 (sweep=1, short arc).
    $('#arc-title-right').setAttribute('d', `M ${off} -${off} A ${r} ${r} 0 0 1 ${off} ${off}`);
  }

  function sizeOuterText() {
    lineTop.setAttribute('font-size', BASE_FONT);
    lineBottom.setAttribute('font-size', BASE_FONT);
    labelBiomes.setAttribute('font-size', TITLE_FONT);
    labelAnthromes.setAttribute('font-size', TITLE_FONT);
  }

  // In-disk dichotomy — capped smaller than the one-liner tier so the hierarchy
  // reads titles > one-liners > dichotomies. Override cases (single words like
  // "microbial") get more headroom since they don't need to fit long text.
  function fitInDisk(textEl, textPath, content, isOverride) {
    textPath.textContent = content;
    const cap = isOverride
      ? Math.max(24, Math.floor(BASE_FONT * 1.0))   // single-word payoff
      : Math.max(20, Math.floor(BASE_FONT * 0.72)); // multi-word, one step down
    let lo = 18, hi = cap, best = 18;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      textEl.setAttribute('font-size', mid);
      if (textEl.getComputedTextLength() <= ARC_FACE * 0.9) { best = mid; lo = mid + 1; }
      else                                                  { hi = mid - 1; }
    }
    textEl.setAttribute('font-size', best);
  }

  function setLines(rotCount) {
    const n = OUTER_LINES.length, m = DICHOTOMIES.length;
    const line = OUTER_LINES[((rotCount % n) + n) % n];

    // Only the arc slot this line uses gets text; the other stays blank.
    lineTopPath.textContent = '';
    lineBottomPath.textContent = '';
    if (line.pos === 'top') lineTopPath.textContent = line.text;
    else                    lineBottomPath.textContent = line.text;

    const dich = line.dichotomyOverride || DICHOTOMIES[((rotCount % m) + m) % m];
    const isOverride = !!line.dichotomyOverride;
    fitInDisk(biomesText,    biomesPath,    dich.biomes,    isOverride);
    fitInDisk(anthromesText, anthromesPath, dich.anthromes, isOverride);
  }

  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  let currentFace = 'biomes';
  const startT = performance.now();
  let rafId = 0;
  let rotationsSeen = -1;

  function render(now) {
    const t = now - startT;
    const angle = (t / PERIOD) * 360;
    coin.style.transform = `rotateY(${angle}deg)`;

    const rotNum = Math.floor(t / PERIOD);
    if (rotNum !== rotationsSeen) {
      rotationsSeen = rotNum;
      setLines(rotNum);
    }

    const c = Math.cos(angle * Math.PI / 180);
    currentFace = c >= 0 ? 'biomes' : 'anthromes';

    // Titles stay readable throughout; the one whose face is showing pops to
    // full white, the other dims to low-emphasis.
    const sharpen = (x) => Math.min(1, Math.max(0, x) * 1.8);
    const DIM = 0.32;
    labelBiomes.style.opacity    = DIM + (1 - DIM) * sharpen(c);
    labelAnthromes.style.opacity = DIM + (1 - DIM) * sharpen(-c);

    // Per-rotation fade envelope. The content swap above happens at the
    // rotation boundary while this is 0, so the transition is invisible.
    const inRot = t % PERIOD;
    let raw;
    if (inRot < FADE_MS)               raw = inRot / FADE_MS;
    else if (inRot > PERIOD - FADE_MS) raw = (PERIOD - inRot) / FADE_MS;
    else                               raw = 1;
    const fade = raw * raw * (3 - 2 * raw);

    // One-liners live outside the disk, so they don't need the edge-on hide;
    // the in-disk dichotomies get it free from backface-visibility.
    lineTop.style.opacity       = fade;
    lineBottom.style.opacity    = fade;
    biomesText.style.opacity    = fade;
    anthromesText.style.opacity = fade;

    rafId = requestAnimationFrame(render);
  }

  updateTitleArcs();
  sizeOuterText();
  setLines(0);

  if (reduce) {
    coin.style.transform = 'rotateY(0deg)';
    labelBiomes.style.opacity = 1;
    labelAnthromes.style.opacity = 0.32;
    lineTop.style.opacity = 1;
    lineBottom.style.opacity = 1;
    biomesText.style.opacity = 1;
    anthromesText.style.opacity = 1;
    currentFace = 'biomes';
  } else {
    rafId = requestAnimationFrame(render);
  }

  const go = (which) => { window.location.href = URLS[which]; };
  enter.addEventListener('click', () => go(currentFace));
  enter.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(currentFace); }
  });

  // Those listeners live on nodes the controller discards when it swaps
  // arrangements, so only the frame loop needs unwinding here.
  return () => cancelAnimationFrame(rafId);
}
