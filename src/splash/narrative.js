// The 8/21 narrative splash (UI option 1).
//
// Two states.
//
// IDLE: the coin turns continuously; each 20s rotation swaps in a new framing
// line on an arc outside the disk and a new half-sentence on each face, so the
// two sides complete a thought the reader only gets by watching the disk turn.
// Content swaps happen at the rotation boundary, while the fade envelope holds
// the text at zero opacity, so the change is never seen mid-word.
//
// COMMITTING: the reader has chosen a side. Rather than navigating to a
// separate loading page — which meant two page loads, a white flash between
// them, and a Back button that landed on an interstitial that immediately
// forwarded again — the splash becomes the loading screen in place. The framing
// copy crossfades to the destination's own, the chosen title holds at full
// white while the other dims and becomes LOADING, and the disk keeps turning
// until it comes to rest on the chosen face. Then one navigation, so Back
// returns here.
import { DESIGN_W } from '../shared/pageStage.js';
import {
  SIDE_COPY, BASE_FONT, TITLE_FONT, ARC_INSIDE,
  TITLE_DIM, fitToArc, buildLoadingLabel
} from '../shared/splashCopy.js';

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

const ARC_FACE = Math.PI * 400;  // in-disk dichotomy arc, r=400 viewBox units
const PERIOD   = 20000;
const FADE_MS  = 4000;

// Commit transition. The run-out is timed from how far it actually has to
// travel rather than being a fixed duration: the distance to the chosen face
// varies by up to a full turn depending on where the disk was when the reader
// clicked, and a fixed duration would make the short ones crawl and the long
// ones whip round. MIN_TOTAL_MS then holds the screen for at least as long as
// the standalone interstitial did, so the destination keeps the same head start
// on loading regardless of how the spin came out.
const MS_PER_DEG   = 11;    // ~4s for a full turn — a shade faster than ambient
const SPIN_MIN_MS  = 2600;
const SPIN_MAX_MS  = 5200;
const READ_HOLD_MS = 700;   // beat after the disk settles, before navigating
const MIN_TOTAL_MS = 5000;
const SWAP_OUT_MS  = 700;
const SWAP_IN_MS   = 800;
// Always give the disk a real run-out. Without a floor, clicking the side that
// happens to be facing forward would "stop" on an angle it was already at.
const MIN_TRAVEL_DEG = 140;

const clamp01 = (x) => Math.min(1, Math.max(0, x));
const lerp = (a, b, t) => a + (b - a) * t;
const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);
const smoothstep = (t) => t * t * (3 - 2 * t);

export function mountNarrative(root) {
  const $ = (sel) => root.querySelector(sel);

  const coin           = $('#coin');
  const labelBiomes    = $('#label-biomes');
  const labelAnthromes = $('#label-anthromes');
  const labelBiomesP    = labelBiomes.querySelector('textPath');
  const labelAnthromesP = labelAnthromes.querySelector('textPath');
  const lineTop        = $('#line-top');
  const lineTopPath    = lineTop.querySelector('textPath');
  const lineBottom     = $('#line-bottom');
  const lineBottomPath = lineBottom.querySelector('textPath');
  const biomesText     = $('#biomes-text');
  const biomesPath     = biomesText.querySelector('textPath');
  const anthromesText  = $('#anthromes-text');
  const anthromesPath  = anthromesText.querySelector('textPath');
  const enter          = $('#enter');

  // Per-face definition lines, empty until a side is chosen.
  const defs = {
    biomes: {
      top: $('#def-top-biomes'), bot: $('#def-bot-biomes'),
      topP: $('#def-top-biomes').querySelector('textPath'),
      botP: $('#def-bot-biomes').querySelector('textPath')
    },
    anthromes: {
      top: $('#def-top-anthromes'), bot: $('#def-bot-anthromes'),
      topP: $('#def-top-anthromes').querySelector('textPath'),
      botP: $('#def-bot-anthromes').querySelector('textPath')
    }
  };
  const titles = { biomes: labelBiomes, anthromes: labelAnthromes };
  const titlePaths = { biomes: labelBiomesP, anthromes: labelAnthromesP };

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
    const dLeft  = `M -${off} ${off} A ${r} ${r} 0 0 1 -${off} -${off}`;
    // ANTHROMES: 1:30 -> 4:30 via 3 (sweep=1, short arc).
    const dRight = `M ${off} -${off} A ${r} ${r} 0 0 1 ${off} ${off}`;
    $('#arc-title-left').setAttribute('d', dLeft);
    $('#arc-title-right').setAttribute('d', dRight);
    // The click bands ride the same arcs.
    $('#hit-biomes').setAttribute('d', dLeft);
    $('#hit-anthromes').setAttribute('d', dRight);
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
    const cap = isOverride
      ? Math.max(24, Math.floor(BASE_FONT * 1.0))   // single-word payoff
      : Math.max(20, Math.floor(BASE_FONT * 0.72)); // multi-word, one step down
    fitToArc(textEl, textPath, content, ARC_FACE, { min: 18, max: cap, slack: 0.9 });
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
  let currentAngle = 0;
  const startT = performance.now();
  let rafId = 0;
  let rotationsSeen = -1;

  // --- Commit state ---------------------------------------------------------
  let mode = 'idle';
  let side = null;
  let commitT0 = 0;
  let commitA0 = 0;
  let commitTravel = 0;
  let spinMs = SPIN_MIN_MS;
  let swapped = false;
  let dotTimer = 0;
  let navTimer = 0;
  let titleFrom = { biomes: 1, anthromes: 1 };

  function commit(which) {
    if (mode !== 'idle') return;
    mode = 'committing';
    side = which;
    const d = SIDE_COPY[which];

    // Warm the destination while the transition plays. Both are idle-priority
    // hints: they let the browser cache the target HTML without executing it,
    // which running it in a hidden iframe would do (and which caused resource
    // contention and racing double-fetches when that was tried).
    const link = document.createElement('link');
    link.rel = 'prefetch';
    link.href = d.path;
    link.as = 'document';
    document.head.appendChild(link);
    fetch(d.path, { credentials: 'same-origin' }).catch(() => {});

    // Come to rest with the chosen side facing forward: 0deg shows biomes,
    // 180deg anthromes. Take the next such angle at least MIN_TRAVEL_DEG ahead.
    const facing = which === 'biomes' ? 0 : 180;
    const floor = currentAngle + MIN_TRAVEL_DEG;
    commitA0 = currentAngle;
    commitTravel = (floor + (((facing - floor) % 360) + 360) % 360) - currentAngle;
    spinMs = Math.min(SPIN_MAX_MS, Math.max(SPIN_MIN_MS, commitTravel * MS_PER_DEG));

    titleFrom = {
      biomes: parseFloat(labelBiomes.style.opacity || '1'),
      anthromes: parseFloat(labelAnthromes.style.opacity || '1')
    };

    commitT0 = performance.now();
    if (reduce) {
      // No run-out to watch: sit on the chosen face and let the crossfade alone
      // carry the transition.
      commitTravel = ((facing - currentAngle) % 360 + 360) % 360;
      coin.style.transform = `rotateY(${currentAngle + commitTravel}deg)`;
    }

    const settle = reduce ? SWAP_OUT_MS + SWAP_IN_MS : spinMs;
    const total = Math.max(MIN_TOTAL_MS, settle + READ_HOLD_MS);
    navTimer = setTimeout(() => {
      if (dotTimer) clearInterval(dotTimer);
      // href, not replace: this screen stays in the history stack, so Back from
      // the visualization returns to the splash.
      window.location.href = d.path;
    }, total);
  }

  // One-time content swap, run while everything that is changing sits at zero
  // opacity so none of it is seen mid-change.
  function swapToDestination() {
    const d = SIDE_COPY[side];
    const other = side === 'biomes' ? 'anthromes' : 'biomes';

    // The chosen title holds its own name; the other becomes LOADING.
    const tick = buildLoadingLabel(titlePaths[other]);
    dotTimer = setInterval(tick, 450);

    // Destination subheadline takes the bottom arc — the slot loading.html
    // uses — in that screen's uppercase treatment.
    lineTopPath.textContent = '';
    lineBottomPath.textContent = d.subhead;
    lineBottom.setAttribute('class', 'subhead');
    lineBottom.setAttribute('font-size', BASE_FONT);

    // The dichotomies gave the two sides a half-sentence each; now only the
    // chosen side speaks, so the other face is left empty.
    biomesPath.textContent = '';
    anthromesPath.textContent = '';

    const f = defs[side];
    // Match both lines to the smaller of the two so the hierarchy reads
    // uniformly rather than one definition outranking the other.
    const fTop = fitToArc(f.top, f.topP, d.insideTop, ARC_INSIDE);
    const fBot = fitToArc(f.bot, f.botP, d.insideBottom, ARC_INSIDE);
    const size = Math.min(fTop, fBot);
    f.top.setAttribute('font-size', size);
    f.bot.setAttribute('font-size', size);
  }

  function paintCommit(ct) {
    if (!swapped && ct >= SWAP_OUT_MS) {
      swapped = true;
      swapToDestination();
    }

    const out = 1 - clamp01(ct / SWAP_OUT_MS);
    const inn = smoothstep(clamp01((ct - SWAP_OUT_MS) / SWAP_IN_MS));
    const other = side === 'biomes' ? 'anthromes' : 'biomes';

    // Chosen title eases up to full white and stays there.
    titles[side].style.opacity = lerp(titleFrom[side], 1, smoothstep(clamp01(ct / (SWAP_OUT_MS + SWAP_IN_MS))));
    // The other fades out, becomes LOADING at the swap, and comes back at the
    // same dim the splash gives a face that is turned away.
    titles[other].style.opacity = swapped ? TITLE_DIM * inn : titleFrom[other] * out;

    // Framing line out, destination subheadline in — same arc slot either way.
    lineTop.style.opacity    = swapped ? 0 : out;
    lineBottom.style.opacity = swapped ? inn : out;

    // Dichotomies out, definitions in on the chosen face only.
    biomesText.style.opacity    = swapped ? 0 : out;
    anthromesText.style.opacity = swapped ? 0 : out;
    defs[side].top.style.opacity = swapped ? inn : 0;
    defs[side].bot.style.opacity = swapped ? inn : 0;
  }

  function render(now) {
    if (mode === 'committing') {
      const ct = now - commitT0;
      if (!reduce) {
        currentAngle = commitA0 + commitTravel * easeOutCubic(clamp01(ct / spinMs));
        coin.style.transform = `rotateY(${currentAngle}deg)`;
      }
      paintCommit(ct);
      rafId = requestAnimationFrame(render);
      return;
    }

    const t = now - startT;
    currentAngle = (t / PERIOD) * 360;
    coin.style.transform = `rotateY(${currentAngle}deg)`;

    const rotNum = Math.floor(t / PERIOD);
    if (rotNum !== rotationsSeen) {
      rotationsSeen = rotNum;
      setLines(rotNum);
    }

    const c = Math.cos(currentAngle * Math.PI / 180);
    currentFace = c >= 0 ? 'biomes' : 'anthromes';

    // Titles stay readable throughout; the one whose face is showing pops to
    // full white, the other dims to low-emphasis.
    const sharpen = (x) => Math.min(1, Math.max(0, x) * 1.8);
    labelBiomes.style.opacity    = TITLE_DIM + (1 - TITLE_DIM) * sharpen(c);
    labelAnthromes.style.opacity = TITLE_DIM + (1 - TITLE_DIM) * sharpen(-c);

    // Per-rotation fade envelope. The content swap above happens at the
    // rotation boundary while this is 0, so the transition is invisible.
    const inRot = t % PERIOD;
    let raw;
    if (inRot < FADE_MS)               raw = inRot / FADE_MS;
    else if (inRot > PERIOD - FADE_MS) raw = (PERIOD - inRot) / FADE_MS;
    else                               raw = 1;
    const fade = smoothstep(raw);

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
    labelAnthromes.style.opacity = TITLE_DIM;
    lineTop.style.opacity = 1;
    lineBottom.style.opacity = 1;
    biomesText.style.opacity = 1;
    anthromesText.style.opacity = 1;
    currentFace = 'biomes';
    currentAngle = 0;
    // Still needs a frame loop: it is what drives the commit transition.
    rafId = requestAnimationFrame(render);
  } else {
    rafId = requestAnimationFrame(render);
  }

  // The disk enters whichever side is facing; each title enters its own side
  // regardless of which face is forward.
  enter.addEventListener('click', () => commit(currentFace));
  enter.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); commit(currentFace); }
  });
  for (const which of ['biomes', 'anthromes']) {
    $(`#hit-${which}`).addEventListener('click', () => commit(which));
  }

  // Those listeners live on nodes the controller discards when it swaps
  // arrangements; the timers and the frame loop do not, so they unwind here.
  return () => {
    cancelAnimationFrame(rafId);
    if (dotTimer) clearInterval(dotTimer);
    if (navTimer) clearTimeout(navTimer);
  };
}
