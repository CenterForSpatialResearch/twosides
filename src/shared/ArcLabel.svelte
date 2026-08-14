<script>
  // Arced caption for a control circle (Reset / Zoom In / Zoom Out / Info).
  //
  // The text baseline sits on a circle concentric with the button but a little
  // wider, so every letter's bottom is tangent to that arc and the glyphs grow
  // OUTWARD, away from the button. Mount inside a position:relative wrapper
  // that also holds the button; this paints centred on it and never takes
  // pointer events, so the button's own hit area is untouched.
  //
  // Direction: the guide circle is drawn clockwise starting at 12 o'clock, so
  // arc length 0% = top, 25% = 3 o'clock, 75% = 9 o'clock. Because SVG puts a
  // glyph's ascender 90deg counter-clockwise of the path direction, a clockwise
  // circle always yields outward-facing letters. That makes a right-side label
  // read top-to-bottom and a left-side label read bottom-to-top — mirror images
  // of each other, which is what pairs the biomes rail (right) with the
  // anthromes rail (left).
  //
  // Alignment: labels are NOT centred on the circle. Every label's lower
  // terminus is pinned to the same height — a quarter of the circle's height up
  // from its bottom — and the word runs upward from there. So the four captions
  // in a rail start on one line regardless of length, instead of each being
  // centred and therefore starting somewhere different.
  //
  // A quarter of the height (2r) above the bottom (y = +r) is y = +r/2, which
  // on the guide circle is 120deg clockwise from the top on the right side and
  // 240deg on the left — i.e. 1/3 and 2/3 of the way round. Anchoring 'end'
  // there on the right (the word reads down INTO the anchor) and 'start' on the
  // left (the word reads up OUT of it) puts both lower termini at that height.

  let {
    text,
    side = 'right',      // 'right' (biomes rail) | 'left' (anthromes rail)
    diameter = 118,      // the button's diameter, in design px
    gap = 11,            // clearance between the button's outer ring and the baseline
    fontSize = 19
  } = $props();

  // Instance-unique id: <textPath href> needs one, and several of these are on
  // screen at once. A module-level counter is enough — ids only have to be
  // unique within the document.
  const uid = `arc-label-${nextId()}`;

  const baselineR = $derived(diameter / 2 + gap);
  // Half-extent of the SVG box: the baseline plus one full em of ascender room
  // (letters grow outward from the baseline) plus a couple of px of slack.
  const half = $derived(baselineR + fontSize + 3);
  // Clockwise circle from 12 o'clock: two half-arcs, sweep-flag 1.
  const guide = $derived(
    `M 0,${-baselineR}` +
    ` A ${baselineR},${baselineR} 0 1,1 0,${baselineR}` +
    ` A ${baselineR},${baselineR} 0 1,1 0,${-baselineR}`
  );
  // 1/3 and 2/3 round the guide circle — see the alignment note above.
  const startOffset = $derived(side === 'left' ? '66.667%' : '33.333%');
  const textAnchor = $derived(side === 'left' ? 'start' : 'end');
</script>

<script module>
  let counter = 0;
  function nextId() {
    return ++counter;
  }
</script>

<svg
  class="arc-label"
  viewBox={`${-half} ${-half} ${half * 2} ${half * 2}`}
  style={`width:${half * 2}px; height:${half * 2}px;`}
  aria-hidden="true"
>
  <defs>
    <path id={uid} d={guide} fill="none" />
  </defs>
  <text style={`font-size:${fontSize}px`}>
    <textPath href={`#${uid}`} startOffset={startOffset} text-anchor={textAnchor}>
      {text}
    </textPath>
  </text>
</svg>

<style>
  .arc-label {
    position: absolute;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    pointer-events: none;
    overflow: visible;
    z-index: 1;
  }

  .arc-label text {
    fill: #fff;
    font-weight: 600;
    letter-spacing: 0.03em;
  }
</style>
