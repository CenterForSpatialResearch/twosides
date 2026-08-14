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
  // Alignment: labels are NOT centred on the circle. Both sides anchor the
  // START of the word — so the captions in a rail begin on one line regardless
  // of length — a quarter of the circle's height in from the near edge, and the
  // word runs away from there in its natural reading direction.
  //
  // Because reading direction is opposite on the two sides, so is the anchor:
  //   left  (anthromes) — reads bottom-to-top, so it starts at the BOTTOM, a
  //                       quarter of the height up from there: y = +r/2, which
  //                       is 240deg clockwise from the top (2/3 round).
  //   right (biomes)    — reads top-to-bottom, so it starts at the TOP, a
  //                       quarter of the height down from there: y = -r/2,
  //                       which is 60deg clockwise from the top (1/6 round).
  // Anchoring the right side at the bottom instead would put the word's END on
  // the shared line and leave its start floating, which read as misaligned.

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
  // 2/3 and 1/6 round the guide circle — see the alignment note above. Both
  // sides anchor the word's start.
  const startOffset = $derived(side === 'left' ? '66.667%' : '16.667%');
  const textAnchor = 'start';
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
