// navmesh-surface.test.mjs — the ground the server stands bodies on.
//
// surfaceNear() answers "what am I standing on", and every bot's height and every
// pickup's height comes from it. It has been wrong in two different ways, both silent:
//
//   1. THE TOWERS HAD NO FLOORS. The map-mesh patch layer decided a triangle was
//      redundant by asking whether the navmesh had anything at that x/z — a question
//      about the footprint, not the height. CTF-Face is stacked, so every storey inside
//      both towers was discarded as "already covered" by outdoor terrain up to 72 units
//      below it. Every pickup inside a tower then sat at its collision origin, because
//      the server could find no floor to put it on: the boot line read 26 of 56 snapped
//      to a surface before this, and 39 after it and the footprint probe together.
//
//   2. A BODY WAS TREATED AS A POINT. Both meshes have pinholes narrower than a pawn.
//      One of them is on the ramp at PathNode7, which was the only place on the corridor
//      bots can actually reach where a bot had no ground at all.
//
// Neither showed up as a crash or a failing assertion; they showed up as items in the
// floor and a bot dead-reckoning its height down a ramp. The cases below are those two
// failures and the properties that would have caught them.
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const surf = require("../navmesh-surface.js");
const { NODES, ADJACENCY, REACH_FLAGS } = require("../nav-graph.js");

// The window server/bots.js and server/server.js both pass.
const WINDOW = 4.0;

// The corridor bots can actually reach: flood Epic's graph from the PlayerStarts the
// way aStar does, which is to say without lifts, teleporters or translocator arcs.
// Nodes behind those are places a bot never goes, so bare ground there is not a defect.
function reachable() {
  const starts = NODES.filter((n) => n.cls === "PlayerStart").map((n) => n.id);
  const seen = new Set(starts);
  const queue = [...starts];
  while (queue.length) {
    for (const e of ADJACENCY[queue.shift()] || []) {
      if (e.flags & REACH_FLAGS.SPECIAL) continue;
      if (seen.has(e.to)) continue;
      seen.add(e.to);
      queue.push(e.to);
    }
  }
  return seen;
}

test("every waypoint a bot can walk to has ground under it", () => {
  const walkable = reachable();
  const bare = NODES.filter(
    (n) => walkable.has(n.id) && surf.surfaceNear(n.x, n.z, n.y, WINDOW) === null,
  );
  assert.deepEqual(
    bare.map((n) => n.name),
    [],
    "a bot routed through these would fall back to dead-reckoning its height",
  );
});

test("the towers have floors, not just outdoor terrain far below them", () => {
  // InventorySpot132 is an item spot on the red tower's flag deck, 71.72 up. It needs
  // both fixes at once, which is why it is the case worth pinning: the deck triangles
  // reach the patch layer only because redundancy is judged by height, and they are
  // reached only because the probe has a body's width — the one thing directly beneath
  // this spot is an 80-degree face that is not floor.
  const deck = NODES.find((n) => n.name === "InventorySpot132");
  const navmesh = surf.heightsAt(deck.x, deck.z);
  assert.ok(navmesh.length > 0, "the navmesh is expected to have something at this x/z");
  assert.ok(
    navmesh.every((y) => Math.abs(y - deck.y) > 30),
    `everything the navmesh has here is meant to be a different storey; got ${navmesh}`,
  );
  // At the window the server really passes, a body up here stands on the deck — not on
  // the ground 72 units below, and not nowhere.
  const ground = surf.surfaceNear(deck.x, deck.z, deck.y, WINDOW);
  assert.notEqual(ground, null, "the tower deck has no floor under it");
  assert.ok(
    Math.abs(ground - deck.y) <= WINDOW,
    `deck came back ${ground} for a body at ${deck.y}`,
  );
});

test("a pinhole narrower than a body is not a hole", () => {
  // InventorySpot140. The triangles stop at exactly its x/z while the ground runs on
  // every side of it, so a body of nonzero width is standing on something even though a
  // point query finds nothing.
  //
  // This used to be PathNode7, on the ramp down from the red tower. That hole was in the
  // NAVMESH, and the navmesh is no longer the surface bodies stand on — the map mesh is,
  // and it has ground at PathNode7. The case did not stop being worth testing, it just
  // moved: two nav nodes still sit over a pinhole, and this is one of them.
  const n = NODES.find((n) => n.name === "InventorySpot140");
  assert.ok(n, "InventorySpot140 is missing from the nav graph");
  assert.equal(
    surf.standHeightsAt(n.x, n.z).length,
    0,
    "the standing surface is expected to have nothing at this exact point — that is the case being tested",
  );
  const ground = surf.surfaceNear(n.x, n.z, n.y, WINDOW);
  assert.notEqual(ground, null, "a body of nonzero width is standing on something here");
  assert.ok(
    Math.abs(ground - n.y) <= WINDOW,
    `footprint answer ${ground} is outside the window asked for around ${n.y}`,
  );
});
test("no answer is ever further away than the window the caller asked for", () => {
  // The bound every caller relies on, checked over points that fall in holes as well as
  // points that do not — the footprint probe added a second way to answer and it has to
  // obey the same limit as the first.
  let answered = 0;
  for (const n of NODES) {
    for (const [dx, dz] of [[0, 0], [1.5, 0], [0, 1.5], [-1.5, -1.5]]) {
      const g = surf.surfaceNear(n.x + dx, n.z + dz, n.y, WINDOW);
      if (g === null) continue;
      answered++;
      assert.ok(
        Math.abs(g - n.y) <= WINDOW,
        `${n.name}+(${dx},${dz}) got ${g} for a body at ${n.y}, outside the ${WINDOW} asked for`,
      );
    }
  }
  assert.ok(answered > 0, "nothing was answered; the test proved nothing");
});

test("the window callers pass is inside the map's own tightest storey gap", () => {
  // Why neither the direct query nor the footprint probe can hand a body the floor
  // above: the widest either will look is narrower than the closest two stacked surfaces
  // on this map ever come to each other. MIN_STOREY_GAP is measured at generation time,
  // so a future map that brought two floors closer together fails here instead of the
  // server quietly starting to stand people on the wrong storey. The generator refuses
  // to write the file at all in that case; this is the same claim from the outside.
  assert.ok(
    WINDOW < surf.MIN_STOREY_GAP,
    `callers pass a ${WINDOW} window but two surfaces come within ${surf.MIN_STOREY_GAP}`,
  );
});

test("ground directly underfoot always wins over the footprint rim", () => {
  // The rim is a fallback, never a vote. Where the surface answers underfoot, that stands.
  //
  // Asked of standHeightsAt, not heightsAt. surfaceNear reads the MAP mesh and heightsAt
  // reports the NAVMESH, and since the two disagree — which is why they were split —
  // comparing surfaceNear against heightsAt tests neither thing. It failed exactly that
  // way at InventorySpot145, where the two meshes are 0.23 m apart.
  for (const n of NODES) {
    const direct = surf.standHeightsAt(n.x, n.z);
    if (!direct.length) continue;
    const nearest = direct.reduce((a, b) => (Math.abs(b - n.y) < Math.abs(a - n.y) ? b : a));
    if (Math.abs(nearest - n.y) > WINDOW) continue; // out of window: the rim may answer
    assert.equal(
      surf.surfaceNear(n.x, n.z, n.y, WINDOW),
      nearest,
      `${n.name} took a rim answer over the surface directly beneath it`,
    );
  }
});
