// map-collision.test.mjs — what is in the way.
//
// server/map-collision.js is the first thing on this server that knows about WALLS.
// navmesh-surface.js answers "what am I standing on" and deliberately keeps only level
// ground; this keeps all 3,240 map triangles, because a rocket has to stop at a tower.
//
// The cases below are the ones that would catch it being subtly wrong: a raycast that
// silently returns null looks exactly like open space, and a projectile system built on
// that flies through the level without a single error.
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const mc = require("../map-collision.js");
const surf = require("../navmesh-surface.js");
const { NODES } = require("../nav-graph.js");
const { FLAG_HOMES } = require("../map-actors.js");

const EYE = 1.4;

test("casting down onto the floor agrees with the surface the server stands bodies on", () => {
  // Two independent readings of the same level: navmesh-surface built from the navmesh
  // plus a patch, this built from the map mesh. From just above the floor there is
  // nothing that could be in between, so they have to agree.
  let checked = 0;
  let close = 0;
  let worst = 0;
  for (const n of NODES) {
    const ground = surf.surfaceNear(n.x, n.z, n.y, 4.0);
    if (ground === null) continue;
    const hit = mc.raycast(n.x, ground + 0.5, n.z, 0, -1, 0, 6);
    checked++;
    if (!hit) continue;
    const d = Math.abs(hit.y - ground);
    if (d <= 0.5) close++;
    else worst = Math.max(worst, d);
  }
  assert.ok(checked > 100, `only ${checked} nodes had ground to check against`);
  assert.ok(
    close / checked > 0.85,
    `only ${close} of ${checked} down-casts landed within 0.5 of the walkable surface`,
  );
  // The stragglers are places surfaceNear answered from the body's footprint rather than
  // directly underfoot, so a ray at the exact point can legitimately be a little off.
  assert.ok(worst < 3, `worst disagreement ${worst.toFixed(2)} is too large to be a footprint`);
});

test("the towers are solid", () => {
  // The whole shape of CTF-Face: you cannot shoot from one flag to the other.
  const a = FLAG_HOMES.red;
  const b = FLAG_HOMES.blue;
  assert.equal(
    mc.blocked(a.x, a.y + EYE, a.z, b.x, b.y + EYE, b.z),
    true,
    "a shot from one flag base to the other should not get through",
  );
});

test("open ground is open", () => {
  // Two adjacent waypoints on the same stretch of ramp. If this reads as blocked the
  // raycast is hitting the floor the shot is travelling over.
  const a = NODES.find((n) => n.name === "PathNode9");
  const b = NODES.find((n) => n.name === "PathNode10");
  assert.equal(mc.blocked(a.x, a.y + EYE, a.z, b.x, b.y + EYE, b.z), false);
});

test("a ray reports the surface it hit, not just that it hit", () => {
  // A bouncing projectile needs the normal, and a normal that is not unit length would
  // send it off at the wrong angle rather than fail.
  const n = NODES.find((x) => x.cls === "PlayerStart");
  const ground = surf.surfaceNear(n.x, n.z, n.y, 4.0);
  const hit = mc.raycast(n.x, ground + 2, n.z, 0, -1, 0, 8);
  assert.notEqual(hit, null, "nothing under a PlayerStart");
  assert.ok(Math.abs(Math.hypot(hit.nx, hit.ny, hit.nz) - 1) < 1e-6, "normal is not unit length");
  assert.ok(hit.ny > 0.5, `the floor's normal should point up, got ny=${hit.ny}`);
  assert.ok(hit.t > 0 && hit.t <= 8, `t=${hit.t} outside the distance asked for`);
});

test("a ray that reaches nothing returns null rather than a far-away hit", () => {
  // Straight up from the middle of the map, above everything.
  assert.equal(mc.raycast(0, mc.BOUNDS.maxY + 10, 0, 0, 1, 0, 100), null);
});

test("it is fast enough to run per projectile per tick", () => {
  // A rocket is one raycast per step and there can be a dozen in the air; bots would add
  // more if canSee ever moves onto this. A regression here is a stutter, not an error.
  const pairs = [];
  for (let i = 0; i < 2000; i++) {
    pairs.push([NODES[i % NODES.length], NODES[(i * 7) % NODES.length]]);
  }
  const started = process.hrtime.bigint();
  for (const [a, b] of pairs) mc.blocked(a.x, a.y + EYE, a.z, b.x, b.y + EYE, b.z);
  const perCall = Number(process.hrtime.bigint() - started) / 1e3 / pairs.length;
  assert.ok(perCall < 50, `${perCall.toFixed(1)}us per raycast is too slow`);
});
