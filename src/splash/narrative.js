// The 8/21 narrative splash (UI options 1-6: final ui, the three splash
// trials, country-from-map and the narrative pass). The final ui and the trials
// swap in their own sequence — see VARIANTS below; everything else here is
// shared.
//
// Two states.
//
// IDLE: the coin turns continuously; each 20s rotation swaps in a new framing
// line above or below the disk and a new half-sentence beside each title, so
// the two sides complete a thought the reader only gets by watching the disk
// turn. Each side's half-sentence follows its title's emphasis: bright while
// that face is forward, dim while it is turned away.
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
  SIDE_COPY, BASE_FONT, TITLE_FONT, ENTER_FONT, TITLE_RING_R,
  TITLE_DIM, TITLE_AWAY, fitToArc, buildLoadingLabel
} from '../shared/splashCopy.js';

// Two framing one-liners, the first above the disk and the second below. Each
// is completed by the dichotomy at the same index: the sides name themselves
// ("Biomes begin…", "Anthromes begin…") so the pair reads as one sentence
// whichever face is forward.
const OUTER_LINES = [
  { pos: 'top',    text: "Two classifications describe life at radically different scales." },
  { pos: 'bottom', text: "Both transform continuous worlds into categories that can be counted." }
];

const DICHOTOMIES = [
  { biomes:    "Biomes begin inside the human body.",
    anthromes: "Anthromes begin with the inhabited Earth." },
  { biomes:    "Biomes organize microbial genomes.",
    anthromes: "Anthromes organize human-altered landscapes." }
];

// Where the copy sits, in viewBox units (the disk's radius is 500). Three
// concentric rings outside the disk: the dichotomies just past its edge on the
// left and right, the framing lines above and below (r=760, in index.html),
// and the titles furthest out with a "select to enter" hint just inside them
// (both set from the canvas in updateTitleArcs).
const ARC_SUB_R = 615;
const ARC_SUB   = (Math.PI / 2) * ARC_SUB_R;  // each dichotomy gets a quarter turn
const ENTER_GAP = 58;                         // hint radius = title radius − this
const PERIOD   = 20000;
const FADE_MS  = 4000;

// Where the turn begins. Not 0 — at 0 the biomes face is already square to the
// screen, so the emphasis is at its peak on the first frame and has nowhere to
// go but down: the screen opens on biomes and hands over to anthromes within
// five seconds, before the reader has finished the framing line. A quarter turn
// earlier the disk starts edge on with the biomes face just coming round, so
// biomes brightens into its half of the turn and holds it for the full half.
// This is also the rotation boundary — content swaps land here, a full 360
// later — so a new framing line and a new pair of dichotomies always arrive as
// the biomes face comes into view.
const START_ANGLE = -90;

// Commit transition. The disk comes to rest on the side that was chosen, square
// to the screen: biomes at 0 degrees, anthromes at 180. Those are also the only
// two angles at which it reads as a circle at all — at 90 and 270 it is edge on,
// a line, and that is where one face gives way to the other.
//
// It would be cheaper to stop at whichever of the two came round first, since
// by then the photographs have faded and both faces are the same dark disk. But
// the reader has just named a side, and stopping on the other one is a thing
// they can follow even when the two look alike. So the run-out always lands on
// the side that was asked for, and what varies is how far it has to go: click a
// side just after it turned square and the disk goes most of the way round;
// click one just as it is coming up and it barely moves. Both are correct, and
// the short ones are not worth a wasted turn to disguise.
//
// The run-out is timed from that distance. A fixed duration would make the short
// ones crawl and the long ones whip round. MIN_TOTAL_MS then holds the screen
// for at least as long as the standalone interstitial did, so the destination
// keeps the same head start on loading regardless of how the spin came out.
const MS_PER_DEG   = 13;
const SPIN_MIN_MS  = 1600;  // also the floor on the crossfade, which scales off it
const SPIN_MAX_MS  = 5000;
const READ_HOLD_MS = 700;   // beat after the disk settles, before navigating
const MIN_TOTAL_MS = 5000;
// The crossfade is scaled to the spin, so the photograph is always fully gone
// and the definitions fully up by the time the disk comes to rest.
const SWAP_OUT_FRAC = 0.35;
const SWAP_IN_FRAC  = 0.40;

// --- Stepped sequences (final ui, and trials splash-1/2/3) -------------------
//
// Alternatives to the sequence above, run on the same disk and timing. Each is
// a list of steps measured in degrees of turn; a step's copy swaps in at its
// start and fades on its own envelope, and the list loops. Every boundary is a
// multiple of 180 from START_ANGLE, so every swap lands with the disk edge on.
//
//   frame: which framing line (OUTER_LINES, by pos) sits on the title ring
//   frames: both framing lines, each keyed to the degree into the step at which
//          it fades in; they hold together and fade out with the step
//   flat:  both titles (and their enter hints) hold full white for the step
//          instead of following the face — see flatness()
//   dich:  which DICHOTOMIES pair sits on the inner ring beside the titles
//   sentences: the two framing lines stand in the titles' place, biomes' line
//          on the left and anthromes' on the right, and the titles fade out
//          for the step and come back at the next boundary
//
// In the trials the framing lines leave r=760 for the titles' own ring, which
// has to come in from the canvas-anchored radius (1083) for a line across the
// top of the disk to clear the canvas edge.
const VARIANTS = {
  // splash-1, refined: the top line opens the turn and the bottom one joins it
  // halfway, so the sentence pair builds rather than replacing itself; both
  // titles hold full white while it does. Then a turn of "…organize…" with the
  // usual emphasis. Two turns.
  final: [
    { deg: 360, frames: { top: 0, bottom: 180 }, flat: true },
    { deg: 360, dich: 1 }
  ],
  // Top line for the first half turn, bottom line for the second, then a turn
  // of "…organize…". Two turns.
  'splash-1': [
    { deg: 180, frame: 'top' },
    { deg: 180, frame: 'bottom' },
    { deg: 360, dich: 1 }
  ],
  // As splash-1, with a turn of "…begin…" before "…organize…". Three turns.
  'splash-2': [
    { deg: 180, frame: 'top' },
    { deg: 180, frame: 'bottom' },
    { deg: 360, dich: 0 },
    { deg: 360, dich: 1 }
  ],
  // A turn with the framing lines in the titles' place, then the titles and
  // "…organize…". Two turns.
  'splash-3': [
    { deg: 360, sentences: true },
    { deg: 360, dich: 1 }
  ]
};
// Title ring radius for the stepped sequences (see TITLE_RING_R).
const RING_R = TITLE_RING_R;
// The bottom line reads upright, so its letters hang INWARD from the baseline
// where the titles' and the top line's stand outward from it. Pushing its
// baseline out by a cap height puts its letters in the same band as theirs.
// splash-1/2's framing lines, a step up from the final ui's BASE_FONT now that
// they sit on the outer ring rather than between the dichotomies and titles.
const FRAME_FONT = 42;
const BOTTOM_LIFT = Math.round(FRAME_FONT * 0.7);
// The trials' dichotomy cap: BASE_FONT, so the dichotomies and the
// subheadline that replaces them on commit share one size. Still fitted to
// the quarter turn, so a long pair would shrink rather than run off its arc.
const TRIAL_SUB_CAP = BASE_FONT;
// A framing line that shares a step with the other one fades on a half turn's
// envelope, as it did when each line had a half-turn step of its own.
const FRAME_FADE_MS = FADE_MS / 2;
// How long the titles take to leave or regain a flat step's full white, spent
// inside the neighbouring step. Leaving: the flat turn ends edge on with the
// biomes face coming round, so biomes is rising to full emphasis as the ramp
// lets go of it and only anthromes visibly dims. Returning: the mirror image.
// Squared, so it holds near white early and neither title dips on the way.
const FLAT_RAMP_MS = 2000;

const clamp01 = (x) => Math.min(1, Math.max(0, x));
const lerp = (a, b, t) => a + (b - a) * t;
const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);
const smoothstep = (t) => t * t * (3 - 2 * t);

export function mountNarrative(root, { variant = null } = {}) {
  const $ = (sel) => root.querySelector(sel);
  const steps = VARIANTS[variant] ?? null;

  const coin           = $('#coin');
  const labelBiomes    = $('#label-biomes');
  const labelAnthromes = $('#label-anthromes');
  const labelBiomesP    = labelBiomes.querySelector('textPath');
  const labelAnthromesP = labelAnthromes.querySelector('textPath');
  const lineTop        = $('#line-top');
  const lineTopPath    = lineTop.querySelector('textPath');
  const lineBottom     = $('#line-bottom');
  const lineBottomPath = lineBottom.querySelector('textPath');
  const subBiomes      = $('#sub-biomes');
  const subBiomesP     = subBiomes.querySelector('textPath');
  const subAnthromes   = $('#sub-anthromes');
  const subAnthromesP  = subAnthromes.querySelector('textPath');
  const enterBiomes    = $('#enter-biomes');
  const enterAnthromes = $('#enter-anthromes');
  const enter          = $('#enter');
  const frameTop       = $('#frame-top');
  const frameTopP      = frameTop.querySelector('textPath');
  const frameBottom    = $('#frame-bottom');
  const frameBottomP   = frameBottom.querySelector('textPath');
  const sentBiomes     = $('#sent-biomes');
  const sentAnthromes  = $('#sent-anthromes');
  // The two photographs and the scrims over them. They fade out on commit; what
  // is left is the plain bordered dark disk that loading.html shows, which is
  // also what frees the run-out from having to land on a particular face.
  const faceArt = [
    ...root.querySelectorAll('.face img'),
    ...root.querySelectorAll('.face-dim')
  ];

  const titles = { biomes: labelBiomes, anthromes: labelAnthromes };
  const titlePaths = { biomes: labelBiomesP, anthromes: labelAnthromesP };
  const subs  = { biomes: subBiomes, anthromes: subAnthromes };
  const hints = { biomes: enterBiomes, anthromes: enterAnthromes };
  const sents = { biomes: sentBiomes, anthromes: sentAnthromes };
  const SIDES = ['biomes', 'anthromes'];

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
    const r = steps ? RING_R : Math.round(250 * (DESIGN_W / diskWidth + 1));
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
    // "select to enter" on a slightly smaller ring, under each title.
    const re = r - ENTER_GAP;
    const offE = (re * Math.SQRT1_2).toFixed(2);
    $('#arc-enter-left').setAttribute('d',  `M -${offE} ${offE} A ${re} ${re} 0 0 1 -${offE} -${offE}`);
    $('#arc-enter-right').setAttribute('d', `M ${offE} -${offE} A ${re} ${re} 0 0 1 ${offE} ${offE}`);

    if (!steps) return;
    // Framing lines on the same ring: across the top 9 -> 12 -> 3, ascenders
    // out; across the bottom 9 -> 6 -> 3, upright, lifted (see BOTTOM_LIFT).
    const rb = r + BOTTOM_LIFT;
    $('#arc-frame-top').setAttribute('d',    `M -${r} 0 A ${r} ${r} 0 0 1 ${r} 0`);
    $('#arc-frame-bottom').setAttribute('d', `M -${rb} 0 A ${rb} ${rb} 0 0 0 ${rb} 0`);
    // splash-3's sentences: the titles' arcs widened to a half turn, since a
    // sentence at title size runs well past a quarter. 6 -> 9 -> 12 and
    // 12 -> 3 -> 6.
    $('#arc-sent-left').setAttribute('d',  `M 0 ${r} A ${r} ${r} 0 0 1 0 -${r}`);
    $('#arc-sent-right').setAttribute('d', `M 0 -${r} A ${r} ${r} 0 0 1 0 ${r}`);
  }

  function sizeOuterText() {
    lineTop.setAttribute('font-size', BASE_FONT);
    lineBottom.setAttribute('font-size', BASE_FONT);
    frameTop.setAttribute('font-size', FRAME_FONT);
    frameBottom.setAttribute('font-size', FRAME_FONT);
    labelBiomes.setAttribute('font-size', TITLE_FONT);
    labelAnthromes.setAttribute('font-size', TITLE_FONT);
    enterBiomes.setAttribute('font-size', ENTER_FONT);
    enterAnthromes.setAttribute('font-size', ENTER_FONT);
  }

  // Dichotomy — capped a step under the one-liner tier so the hierarchy reads
  // titles > one-liners > dichotomies, and fitted to its quarter turn.
  function fitSub(textEl, textPath, content) {
    const cap = steps ? TRIAL_SUB_CAP : Math.round(BASE_FONT * 0.85);
    fitToArc(textEl, textPath, content, ARC_SUB, { min: 18, max: cap, slack: 0.9 });
  }

  function setLines(rotCount) {
    const n = OUTER_LINES.length, m = DICHOTOMIES.length;
    const line = OUTER_LINES[((rotCount % n) + n) % n];

    // Only the arc slot this line uses gets text; the other stays blank.
    lineTopPath.textContent = '';
    lineBottomPath.textContent = '';
    if (line.pos === 'top') lineTopPath.textContent = line.text;
    else                    lineBottomPath.textContent = line.text;

    const dich = DICHOTOMIES[((rotCount % m) + m) % m];
    fitSub(subBiomes,    subBiomesP,    dich.biomes);
    fitSub(subAnthromes, subAnthromesP, dich.anthromes);
  }

  // Trial sequences. Everything a step does not use is left blank, so the
  // frame loop can set every opacity unconditionally.
  function applyStep(step) {
    frameTopP.textContent = '';
    frameBottomP.textContent = '';
    const framePaths = { top: frameTopP, bottom: frameBottomP };
    for (const pos of step.frames ? Object.keys(step.frames) : step.frame ? [step.frame] : []) {
      framePaths[pos].textContent = OUTER_LINES.find((l) => l.pos === pos).text;
    }

    for (const k of SIDES) sents[k].querySelector('textPath').textContent = '';
    if (step.sentences) {
      // Same arc length both sides, so fit both and share the smaller size;
      // at title size both already fit, so in practice this is TITLE_FONT.
      const arc = Math.PI * RING_R;
      const a = fitToArc(sentBiomes, sentBiomes.querySelector('textPath'), OUTER_LINES[0].text, arc, { min: 24, max: TITLE_FONT, slack: 0.92 });
      const b = fitToArc(sentAnthromes, sentAnthromes.querySelector('textPath'), OUTER_LINES[1].text, arc, { min: 24, max: TITLE_FONT, slack: 0.92 });
      sentBiomes.setAttribute('font-size', Math.min(a, b));
      sentAnthromes.setAttribute('font-size', Math.min(a, b));
    }

    subBiomesP.textContent = '';
    subAnthromesP.textContent = '';
    if (step.dich != null) {
      const dich = DICHOTOMIES[step.dich];
      fitSub(subBiomes,    subBiomesP,    dich.biomes);
      fitSub(subAnthromes, subAnthromesP, dich.anthromes);
    }
  }

  const stepMs = steps ? steps.map((st) => (st.deg / 360) * PERIOD) : [];
  const cycleMs = stepMs.reduce((a, b) => a + b, 0);
  let stepSeen = -1;

  // Which step `t` falls in, how far into it, and that step's fade envelope.
  // Half-turn steps get a proportionally shorter fade, so they hold full
  // opacity for the same share of their time as a full turn does.
  function locateStep(t) {
    const cycle = Math.floor(t / cycleMs);
    let local = t - cycle * cycleMs;
    let i = 0;
    while (i < stepMs.length - 1 && local >= stepMs[i]) { local -= stepMs[i]; i++; }
    const len = stepMs[i];
    const fadeMs = FADE_MS * (len / PERIOD);
    let raw;
    if (local < fadeMs)            raw = local / fadeMs;
    else if (local > len - fadeMs) raw = (len - local) / fadeMs;
    else                           raw = 1;
    // The index keeps counting across cycles so a one-step list still swaps.
    return { key: cycle * stepMs.length + i, i, local, len, step: steps[i], fade: smoothstep(clamp01(raw)) };
  }

  // A `frames` line's own envelope: in from its entry degree, out with the
  // step's end, on FRAME_FADE_MS either way.
  function frameFade({ step, local, len }, pos) {
    const entryMs = (step.frames[pos] / 360) * PERIOD;
    if (local < entryMs) return 0;
    const raw = Math.min((local - entryMs) / FRAME_FADE_MS, (len - local) / FRAME_FADE_MS);
    return smoothstep(clamp01(raw));
  }

  // How far the titles are pulled from their emphasis toward full white: 1 for
  // a flat step, ramping to and from 0 at the edges of a step next to one.
  function flatness({ i, local, len }) {
    if (steps[i].flat) return 1;
    const n = steps.length;
    let w = 0;
    if (steps[(i - 1 + n) % n].flat) w = Math.max(w, 1 - clamp01(local / FLAT_RAMP_MS) ** 2);
    if (steps[(i + 1) % n].flat)     w = Math.max(w, 1 - clamp01((len - local) / FLAT_RAMP_MS) ** 2);
    return w;
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
  let swapOutMs = 0;
  let swapInMs = 0;
  let swapped = false;
  let dotTimer = 0;
  let navTimer = 0;
  let titleFrom = { biomes: 1, anthromes: 1 };
  let subFrom   = { biomes: 1, anthromes: 1 };
  let hintFrom  = { biomes: 1, anthromes: 1 };
  let sentFrom  = { biomes: 0, anthromes: 0 };
  let frameFrom = { top: 0, bottom: 0 };

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

    // Forward to the next angle at which the chosen side is square to the
    // screen. Never more than one turn, and no floor: a small move is the
    // honest answer when the side asked for is already coming up.
    const facing = which === 'biomes' ? 0 : 180;
    commitA0 = currentAngle;
    commitTravel = (((facing - currentAngle) % 360) + 360) % 360;
    spinMs = Math.min(SPIN_MAX_MS, Math.max(SPIN_MIN_MS, commitTravel * MS_PER_DEG));
    swapOutMs = spinMs * SWAP_OUT_FRAC;
    swapInMs  = spinMs * SWAP_IN_FRAC;

    const opacityOf = (el) => parseFloat(el.style.opacity || '1');
    titleFrom = { biomes: opacityOf(labelBiomes), anthromes: opacityOf(labelAnthromes) };
    subFrom   = { biomes: opacityOf(subBiomes),   anthromes: opacityOf(subAnthromes) };
    hintFrom  = { biomes: opacityOf(enterBiomes), anthromes: opacityOf(enterAnthromes) };
    sentFrom  = { biomes: opacityOf(sentBiomes),  anthromes: opacityOf(sentAnthromes) };
    frameFrom = { top: opacityOf(frameTop),       bottom: opacityOf(frameBottom) };

    commitT0 = performance.now();
    if (reduce) {
      // No run-out to watch, so the crossfade alone carries the transition and
      // sets its own pace.
      swapOutMs = 700;
      swapInMs = 800;
    }

    const settle = reduce ? swapOutMs + swapInMs : spinMs;
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

    // The dichotomies gave the two sides a half-sentence each; from here the
    // title and subheadline carry the entering screen on their own.
    subBiomesP.textContent = '';
    subAnthromesP.textContent = '';
  }

  function paintCommit(ct) {
    if (!swapped && ct >= swapOutMs) {
      swapped = true;
      swapToDestination();
    }

    const out = 1 - clamp01(ct / swapOutMs);
    const inn = smoothstep(clamp01((ct - swapOutMs) / swapInMs));
    const other = side === 'biomes' ? 'anthromes' : 'biomes';

    // The photographs go with the framing copy, leaving the bordered dark disk
    // the cross-link interstitial shows.
    for (const el of faceArt) el.style.opacity = swapped ? 0 : out;

    // Chosen title eases up to full white and stays there. If splash-3 had a
    // sentence in its place, the title waits for the sentence to clear rather
    // than printing over it. The sentence elements carry an opacity in every
    // sequence (or none, which reads as 1), so only one with text counts —
    // testing opacity alone blanked the chosen title on every commit.
    const sentWasUp = SIDES.some((k) => sentFrom[k] > 0.01 && sents[k].textContent);
    titles[side].style.opacity = sentWasUp
      ? (swapped ? inn : 0)
      : lerp(titleFrom[side], 1, smoothstep(clamp01(ct / (swapOutMs + swapInMs))));
    // The other fades out, becomes LOADING at the swap, and comes back at the
    // same dim the splash gives a face that is turned away.
    titles[other].style.opacity = swapped ? TITLE_DIM * inn : titleFrom[other] * out;

    // Framing line out, destination subheadline in — same arc slot either way.
    lineTop.style.opacity    = swapped ? 0 : out;
    lineBottom.style.opacity = swapped ? inn : out;

    // Dichotomies and enter hints out with the framing copy, each from
    // wherever the spin had left it; nothing comes back in their place.
    for (const k of SIDES) {
      subs[k].style.opacity  = swapped ? 0 : subFrom[k] * out;
      hints[k].style.opacity = swapped ? 0 : hintFrom[k] * out;
      sents[k].style.opacity = swapped ? 0 : sentFrom[k] * out;
    }
    frameTop.style.opacity    = swapped ? 0 : frameFrom.top * out;
    frameBottom.style.opacity = swapped ? 0 : frameFrom.bottom * out;
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
    currentAngle = START_ANGLE + (t / PERIOD) * 360;
    coin.style.transform = `rotateY(${currentAngle}deg)`;

    const located = steps ? locateStep(t) : null;
    if (located) {
      if (located.key !== stepSeen) {
        stepSeen = located.key;
        applyStep(located.step);
      }
    } else {
      const rotNum = Math.floor(t / PERIOD);
      if (rotNum !== rotationsSeen) {
        rotationsSeen = rotNum;
        setLines(rotNum);
      }
    }

    const c = Math.cos(currentAngle * Math.PI / 180);
    currentFace = c >= 0 ? 'biomes' : 'anthromes';

    // Titles stay readable throughout; the one whose face is showing pops to
    // full white, the other dims to low-emphasis. The enter hint under each
    // title follows it exactly.
    const sharpen = (x) => Math.min(1, Math.max(0, x) * 1.8);
    const emphasis = {
      biomes:    TITLE_AWAY + (1 - TITLE_AWAY) * sharpen(c),
      anthromes: TITLE_AWAY + (1 - TITLE_AWAY) * sharpen(-c)
    };
    for (const k of SIDES) {
      titles[k].style.opacity = emphasis[k];
      hints[k].style.opacity  = emphasis[k];
    }

    if (located) {
      // Stepped sequences: every piece of copy the step uses rides the step's
      // envelope; the side-bound pieces also take their side's emphasis, as the
      // dichotomies always have. A flat step lifts the titles and hints to full
      // white. splash-3's titles give way to the sentences for their step and
      // return on the envelope of the next.
      const { step, fade } = located;
      frameTop.style.opacity    = step.frames ? frameFade(located, 'top')    : fade;
      frameBottom.style.opacity = step.frames ? frameFade(located, 'bottom') : fade;
      const w = flatness(located);
      for (const k of SIDES) {
        if (w > 0) {
          titles[k].style.opacity = lerp(emphasis[k], 1, w);
          hints[k].style.opacity  = lerp(emphasis[k], 1, w);
        }
        subs[k].style.opacity = emphasis[k] * fade;
        sents[k].style.opacity = emphasis[k] * fade;
        if (variant === 'splash-3') titles[k].style.opacity = step.sentences ? 0 : emphasis[k] * fade;
      }
      lineTop.style.opacity = 0;
      lineBottom.style.opacity = 0;
      rafId = requestAnimationFrame(render);
      return;
    }

    // Per-rotation fade envelope. The content swap above happens at the
    // rotation boundary while this is 0, so the transition is invisible.
    const inRot = t % PERIOD;
    let raw;
    if (inRot < FADE_MS)               raw = inRot / FADE_MS;
    else if (inRot > PERIOD - FADE_MS) raw = (PERIOD - inRot) / FADE_MS;
    else                               raw = 1;
    const fade = smoothstep(raw);

    // The framing line and both dichotomies share the envelope; each
    // dichotomy is also scaled by its own side's emphasis, so it brightens and
    // dims with the title beside it.
    lineTop.style.opacity    = fade;
    lineBottom.style.opacity = fade;
    for (const k of SIDES) subs[k].style.opacity = emphasis[k] * fade;

    rafId = requestAnimationFrame(render);
  }

  updateTitleArcs();
  sizeOuterText();
  if (steps) {
    // The trials never use the r=760 lines until commit; blank them so the
    // final ui's first line doesn't sit under the first step.
    lineTopPath.textContent = '';
    lineBottomPath.textContent = '';
    for (const el of [frameTop, frameBottom, sentBiomes, sentAnthromes]) el.style.opacity = 0;
  } else {
    setLines(0);
  }

  if (reduce && steps) {
    // No turn to pace a sequence by: hold the one step that shows the titles
    // alongside a pair of dichotomies, with both framing lines up for all but
    // splash-3.
    applyStep(steps[steps.length - 1]);
    if (variant !== 'splash-3') {
      frameTopP.textContent = OUTER_LINES[0].text;
      frameBottomP.textContent = OUTER_LINES[1].text;
      frameTop.style.opacity = 1;
      frameBottom.style.opacity = 1;
    }
    coin.style.transform = 'rotateY(0deg)';
    labelBiomes.style.opacity = 1;
    labelAnthromes.style.opacity = TITLE_AWAY;
    enterBiomes.style.opacity = 1;
    enterAnthromes.style.opacity = TITLE_AWAY;
    subBiomes.style.opacity = 1;
    subAnthromes.style.opacity = TITLE_AWAY;
    rafId = requestAnimationFrame(render);
  } else if (reduce) {
    coin.style.transform = 'rotateY(0deg)';
    labelBiomes.style.opacity = 1;
    labelAnthromes.style.opacity = TITLE_AWAY;
    enterBiomes.style.opacity = 1;
    enterAnthromes.style.opacity = TITLE_AWAY;
    lineTop.style.opacity = 1;
    lineBottom.style.opacity = 1;
    subBiomes.style.opacity = 1;
    subAnthromes.style.opacity = TITLE_AWAY;
    currentFace = 'biomes';
    currentAngle = 0;
    // Still needs a frame loop: it is what drives the commit transition.
    rafId = requestAnimationFrame(render);
  } else {
    // Place the disk at the start angle before the first frame, or the markup's
    // rotateY(0) would flash one frame of the biomes face square to the screen
    // before the turn picks it up edge on.
    currentAngle = START_ANGLE;
    coin.style.transform = `rotateY(${START_ANGLE}deg)`;
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
