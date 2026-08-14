// Shared timing for the "swap one dataset for another" transition, so the
// waffle ring and the details-panel pixel timeline move as one gesture rather
// than two loosely-similar animations.
//
// The grammar, wherever it is used:
//   OUT — the outgoing marks collapse toward their base, staggered BACKWARDS
//         through time (most recent year leaves first).
//   IN  — the incoming marks grow back out from that base, staggered FORWARDS
//         through time (earliest year arrives first).
//
// The two phases do not overlap: at the midpoint the chart is empty. That is
// deliberate — the swap should read as a wipe through time, not a crossfade.

export const SWAP_MS = 1000;
export const SWAP_PHASE_MS = SWAP_MS / 2;
/** How far apart the first and last year start moving, within one phase. */
export const SWAP_STAGGER_MS = 260;
/** One mark's own run. Stagger + run must fill the phase exactly. */
export const SWAP_SEG_MS = SWAP_PHASE_MS - SWAP_STAGGER_MS;

/**
 * Delay before item `index` of `count` starts moving, in ms.
 * `reverse` walks the stagger from the end of the list to the start.
 */
export function staggerDelay(index, count, { reverse = false } = {}) {
  const span = Math.max(1, count - 1);
  const k = reverse ? (span - index) / span : index / span;
  return k * SWAP_STAGGER_MS;
}

const easeCubicIn = (t) => t * t * t;
const easeCubicOut = (t) => 1 - Math.pow(1 - t, 3);

/**
 * Extent multiplier (0..1) for item `index` at `elapsed` ms into a phase.
 * 1 = at full size, 0 = fully collapsed onto its base.
 *
 * Callers that drive their own frame loop (the pixel timeline) use this
 * directly; callers using d3 transitions (the waffle ring) use the constants
 * above to configure delay/duration and let d3 interpolate.
 */
export function phaseExtent(phase, elapsed, index, count) {
  const delay = staggerDelay(index, count, { reverse: phase === 'out' });
  const t = Math.max(0, Math.min(1, (elapsed - delay) / SWAP_SEG_MS));
  return phase === 'out' ? 1 - easeCubicIn(t) : easeCubicOut(t);
}
