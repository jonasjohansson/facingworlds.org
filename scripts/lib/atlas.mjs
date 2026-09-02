// atlas.mjs — how a frame sequence is laid out on one sheet.
//
// Two things need to agree about this: the build that composes the sheet and the weapon
// table that tells the client how to read it. One function, imported by both, so they
// cannot drift.
//
// Roughly 2:1 rather than square, because that is the shape that wastes the fewest cells
// for the counts UT99 actually uses — 8 frames become 4x2 with nothing spare, 18 become
// 6x3 with nothing spare.
export function gridFor(frames) {
  const cols = Math.ceil(Math.sqrt(frames * 2));
  const rows = Math.ceil(frames / cols);
  return { cols, rows };
}
