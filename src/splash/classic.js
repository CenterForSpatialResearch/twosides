// The pre-narrative splash (UI options 2+).
//
// The screen as it stood before the 8/21 narrative pass: a 10s coin flip, two
// fixed vertical side labels that are always clickable, and a pair of static
// captions per face that cross-fade with the rotation. Kept verbatim apart from
// the two changes every arrangement now shares — the fixed design canvas, and
// cross-links routed through the loading interstitial.
const URLS = { biomes: 'loading.html?side=biomes', anthromes: 'loading.html?side=anthromes' };

const PERIOD = 10000; // ms for a full 360deg turn (5s per face)

export function mountClassic(root) {
  const $ = (sel) => root.querySelector(sel);

  const coin           = $('#coin');
  const capBiomesLeft  = $('#cap-biomes-left');
  const capBiomesRight = $('#cap-biomes-right');
  const capAnthroLeft  = $('#cap-anthromes-left');
  const capAnthroRight = $('#cap-anthromes-right');
  const leftLink       = $('#leftLink');   // BIOMES
  const rightLink      = $('#rightLink');  // ANTHROMES
  const enter          = $('#enter');

  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  let currentFace = 'biomes';
  const startT = performance.now();
  let rafId = 0;

  function render(now) {
    const t = (now - startT) % PERIOD;
    const angle = (t / PERIOD) * 360;
    coin.style.transform = `rotateY(${angle}deg)`;

    const c = Math.cos(angle * Math.PI / 180); // 1 = biomes facing, -1 = anthromes
    currentFace = c >= 0 ? 'biomes' : 'anthromes';

    // Captions cross-fade with the flip (sharpened so they stay readable across
    // most of the face rather than only at the extremes).
    const sharpen = (x) => Math.min(1, Math.max(0, x) * 1.8);
    const biomesOpacity = sharpen(c);
    const anthromesOpacity = sharpen(-c);
    capBiomesLeft.style.opacity = biomesOpacity;
    capBiomesRight.style.opacity = biomesOpacity;
    capAnthroLeft.style.opacity = anthromesOpacity;
    capAnthroRight.style.opacity = anthromesOpacity;

    // Side labels fade continuously with rotation: 1 when that side is facing,
    // dropping to 0.7 at the opposite extreme.
    leftLink.style.opacity  = 0.7 + 0.3 * c;
    rightLink.style.opacity = 0.7 - 0.3 * c;

    rafId = requestAnimationFrame(render);
  }

  if (reduce) {
    // Hold on the biomes face; side labels remain fully visible.
    coin.style.transform = 'rotateY(0deg)';
    capBiomesLeft.style.opacity = 1;
    capBiomesRight.style.opacity = 1;
    capAnthroLeft.style.opacity = 0;
    capAnthroRight.style.opacity = 0;
    currentFace = 'biomes';
  } else {
    rafId = requestAnimationFrame(render);
  }

  const go = (which) => { window.location.href = URLS[which]; };

  // Click the disk / caption ring -> whichever viz is currently facing us.
  enter.addEventListener('click', () => go(currentFace));
  enter.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(currentFace); }
  });

  // Side labels always route to their own side. They are real anchors, so the
  // handler only has to stop the click reaching the disk behind them.
  leftLink.addEventListener('click', (e) => e.stopPropagation());
  rightLink.addEventListener('click', (e) => e.stopPropagation());

  return () => cancelAnimationFrame(rafId);
}
