// bots-los.test.mjs — the bot line-of-sight rule, against real CTF-Face geometry.
//
// canSee() is a pure function of the baked navmesh (server/navmesh-surface.js), so this
// suite needs no server, no sockets and no clock: it asks the same questions a bot asks
// and checks the answers against places on the map whose shape is known.
//
// It exists because the rule was WRONG TWICE in ways that reading it did not reveal, and
// both mistakes were silent — a line-of-sight test that never blocks and one that blocks
// a defender from seeing their own flag look identical from the outside. Every case
// below is one of those two failures, or the property that would have caught them.
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { canSee } = require("../bots.js");
const surf = require("../navmesh-surface.js");
const { NODES, WALKABLE_MAIN } = require("../nav-graph.js");
const { FLAG_HOMES, TOWER_ROOFS } = require("../map-actors.js");

// The eye and chest heights bots.js fires between.
const EYE = 1.4;
const AIM = 1.0;
const look = (a, b) => canSee(a, a.y + EYE, b, b.y + AIM);

const walkable = NODES.filter((n) => WALKABLE_MAIN.has(n.id));
const byName = (name) => {
  const n = NODES.find((m) => m.name === name);
  assert.ok(n, `no nav node called ${name}`);
  return n;
};

test("the ridge between the towers blocks a shot from one flag base to the other", () => {
  // The single most obvious occluder on CTF-Face, and the case the first version of this
  // rule got wrong: it asked for the surface NEAREST the shot line inside a 4-unit
  // window, the ridge stands ~14 above a shot between the two bases, so the answer came
  // back "no data" and the test passed everything.
  assert.equal(look(FLAG_HOMES.red, FLAG_HOMES.blue), false);
  assert.equal(look(FLAG_HOMES.blue, FLAG_HOMES.red), false);

  // ...and it is the ridge doing it, not distance or a missing mesh. Somewhere along the
  // line there is walkable surface well above the shot.
  const a = FLAG_HOMES.red;
  const b = FLAG_HOMES.blue;
  let highest = -Infinity;
  for (let i = 1; i < 20; i++) {
    const t = i / 20;
    for (const h of surf.heightsAt(a.x + (b.x - a.x) * t, a.z + (b.z - a.z) * t)) {
      highest = Math.max(highest, h);
    }
  }
  assert.ok(highest > a.y + 10, `nothing on the flag-to-flag line stands 10 above it (highest ${highest})`);
});

test("a deck overhead does not block a shot across the room under it", () => {
  // The second failure. Asking for the LOWEST surface fixed the ridge and then broke
  // this: the fan navmesh has holes in the tower floors, so at some samples the only
  // surface underneath is the deck two storeys up and a shot across an alcove read as a
  // shot into a hillside.
  //
  // Every walkable node that stands on the lowest of several stacked surfaces is a node
  // with something overhead. None of them may lose a shot at a neighbour on their own
  // floor.
  const underADeck = walkable.filter((n) => {
    const h = surf.heightsAt(n.x, n.z);
    return h.length > 1 && Math.min(...h) < n.y + 1.5;
  });
  assert.ok(underADeck.length >= 5, `only ${underADeck.length} nav nodes have anything overhead — is this the right map?`);

  let checked = 0;
  for (const n of underADeck) {
    for (const m of walkable) {
      if (m.id === n.id) continue;
      if (Math.abs(m.y - n.y) > 2) continue; // same floor
      const d = Math.hypot(m.x - n.x, m.z - n.z);
      if (d > 8) continue; // same room
      checked++;
      assert.equal(look(n, m), true, `${n.name} (y ${n.y}) cannot see ${m.name} (y ${m.y}) ${d.toFixed(1)} away, on the same floor`);
    }
  }
  assert.ok(checked > 0, "found no same-floor neighbours to check");
});

test("a defender at their own flag can see the flag", () => {
  // The concrete case the lowest-surface version broke, called out by name because it is
  // the one that would have been noticed as "the bots do not defend" rather than as a
  // geometry bug.
  for (const team of ["red", "blue"]) {
    const home = FLAG_HOMES[team];
    const near = walkable
      .filter((n) => Math.abs(n.y - home.y) < 2)
      .map((n) => ({ n, d: Math.hypot(n.x - home.x, n.z - home.z) }))
      .filter((r) => r.d > 1 && r.d < 12)
      .sort((a, b) => a.d - b.d)
      .slice(0, 5);
    assert.ok(near.length, `no walkable nav node within 12 of the ${team} flag`);
    for (const { n, d } of near) {
      assert.equal(look(n, home), true, `${n.name} cannot see the ${team} flag from ${d.toFixed(1)} away`);
    }
  }
});

test("nothing blocks at point-blank range", () => {
  // A blanket guard on the failure mode both broken versions shared: a rule that says
  // rock is in the way of two bodies standing next to each other is wrong about the map,
  // whatever it is right about elsewhere.
  let pairs = 0;
  for (let i = 0; i < walkable.length; i++) {
    for (let j = i + 1; j < walkable.length; j++) {
      const a = walkable[i];
      const b = walkable[j];
      if (Math.abs(a.y - b.y) > 2) continue;
      if (Math.hypot(a.x - b.x, a.z - b.z) > 6) continue;
      pairs++;
      assert.equal(look(a, b), true, `${a.name} cannot see ${b.name}, ${Math.hypot(a.x - b.x, a.z - b.z).toFixed(1)} away`);
    }
  }
  assert.ok(pairs > 30, `only ${pairs} nav-node pairs under 6 apart — is this the right map?`);
});

test("sight is symmetric between two points at the same height", () => {
  // Not a map fact, a rule fact: canSee walks from `from` to `to`, and a sampling scheme
  // that leaned on one end would make a duel depend on who shot first.
  let tested = 0;
  for (let i = 0; i < walkable.length; i++) {
    for (let j = i + 1; j < walkable.length; j++) {
      const a = walkable[i];
      const b = walkable[j];
      if (Math.hypot(a.x - b.x, a.z - b.z) > 40) continue;
      tested++;
      const h = 1.2;
      assert.equal(canSee(a, a.y + h, b, b.y + h), canSee(b, b.y + h, a, a.y + h), `${a.name} <-> ${b.name} disagree`);
    }
  }
  assert.ok(tested > 500, `only ${tested} pairs tested`);
});

test("the rule blocks something, and not most things", () => {
  // The property that would have caught version one on its own. A line-of-sight test
  // that never fires is indistinguishable from not having one, and one that fires
  // everywhere makes bots blind. Both bounds are deliberately wide: this pins the shape
  // of the answer, not a tuning.
  //
  // The pairs are the ones a bot can actually engage — inside SIGHT and MAX_FIGHT_DY
  // from bots.js — because that is the only population the rule is ever asked about.
  const SIGHT = 40;
  const MAX_FIGHT_DY = 6;
  let n = 0;
  let blocked = 0;
  for (let i = 0; i < walkable.length; i++) {
    for (let j = i + 1; j < walkable.length; j++) {
      const a = walkable[i];
      const b = walkable[j];
      if (Math.abs(a.y - b.y) > MAX_FIGHT_DY) continue;
      if (Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) > SIGHT) continue;
      n++;
      if (!look(a, b)) blocked++;
    }
  }
  assert.ok(n > 1000, `only ${n} engageable pairs`);
  assert.ok(blocked > 0, "the line-of-sight test blocks nothing at all — it is inert");
  assert.ok(blocked < n * 0.15, `${blocked} of ${n} engageable pairs blocked (${((100 * blocked) / n).toFixed(1)}%) — bots are nearly blind`);
});

test("the tower roofs see across themselves", () => {
  // Two snipers on one deck, 71 units up with the whole map below them. The ground far
  // underneath must not read as terrain in the way.
  for (const team of ["red", "blue"]) {
    const c = TOWER_ROOFS[team];
    const a = { x: c.x - 6, y: c.y, z: c.z };
    const b = { x: c.x + 6, y: c.y, z: c.z };
    assert.equal(look(a, b), true, `the ${team} roof does not see across itself`);
  }
});

test("the generated navmesh supports the rule that reads it", () => {
  // scripts/gen-navmesh-surface.mjs refuses to write a file whose numbers do not, but
  // the check belongs here too: the generated file is committed, and a hand-edit or a
  // bad merge would not go through the generator.
  assert.ok(
    surf.MIN_OVERHEAD_RISE > surf.MAX_TERRAIN_RISE,
    `terrain rises ${surf.MAX_TERRAIN_RISE} but the lowest overhead surface is only ${surf.MIN_OVERHEAD_RISE} up — ` +
      "there is no height that tells rock from a roof on this mesh"
  );
  assert.ok(
    surf.LOS_MAX_RISE > surf.MAX_TERRAIN_RISE && surf.LOS_MAX_RISE < surf.MIN_OVERHEAD_RISE,
    `LOS_MAX_RISE ${surf.LOS_MAX_RISE} is outside (${surf.MAX_TERRAIN_RISE}, ${surf.MIN_OVERHEAD_RISE})`
  );
});
