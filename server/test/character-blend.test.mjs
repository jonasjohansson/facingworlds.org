// character-blend.test.mjs — speed in, idle/walk/run out.
//
// The one decision in systems/character.js that needs no renderer: where a body stops
// standing and starts walking, and where a walk becomes a run. It was written out twice
// before the port — once in the `character` component's tick and once in
// remote-avatar.js's "no animation block on the wire" fallback — and the two copies did
// not agree: the fallback started a run at 3 m/s, 32% of a run, where everything else
// (server/bots.js, the component) used 53% of GROUND_SPEED. That is the bug these guard.
//
// The thresholds are DERIVED from GAME_CONFIG.MOVEMENT.GROUND_SPEED rather than written
// here, so raising the rig's top speed moves them and cannot silently leave the run blend
// pinned on — which is what the hardcoded 1.6/3.2 pair did before 2026-08.
import test from "node:test";
import assert from "node:assert/strict";
import { BLEND, blendTargets } from "../../src/game/systems/character.js";
import { GAME_CONFIG } from "../../src/game/config/game-config.js";

test("the thresholds follow GROUND_SPEED, not a literal", () => {
  const ground = GAME_CONFIG.MOVEMENT.GROUND_SPEED;
  assert.equal(BLEND.RUN_SPEED, ground);
  assert.equal(BLEND.WALK_SPEED, ground * 0.5);
  assert.equal(BLEND.RUN_THRESHOLD, ground * 0.53);
  // Not derived: the noise floor of a single frame's position delta at arena pace. Below
  // it the walk blend used to flicker on while the body stood still.
  assert.equal(BLEND.MOVE_THRESHOLD, 0.2);
});

test("standing still is pure idle, and stays idle inside the noise floor", () => {
  assert.deepEqual(blendTargets(0), { Idle: 1, Walk: 0, Run: 0 });
  assert.deepEqual(blendTargets(0.19), { Idle: 1, Walk: 0, Run: 0 });
  // A negative speed is not a thing, but a subtraction that went the wrong way is.
  assert.deepEqual(blendTargets(-5), { Idle: 1, Walk: 0, Run: 0 });
});

test("above the move threshold it walks, above 53% of a run it runs", () => {
  assert.deepEqual(blendTargets(0.5), { Idle: 0, Walk: 1, Run: 0 });
  assert.deepEqual(blendTargets(BLEND.RUN_THRESHOLD - 0.01), { Idle: 0, Walk: 1, Run: 0 });
  assert.deepEqual(blendTargets(BLEND.RUN_THRESHOLD + 0.01), { Idle: 0, Walk: 0, Run: 1 });
  // Full pace: 9.4 m/s is a run, not the walk the old remote fallback's 3 m/s test would
  // still have called one had the numbers ever been the other way round.
  assert.deepEqual(blendTargets(GAME_CONFIG.MOVEMENT.GROUND_SPEED), { Idle: 0, Walk: 0, Run: 1 });
});

test("exactly one channel is ever on, and they always sum to 1", () => {
  for (let s = 0; s <= 12; s += 0.1) {
    const w = blendTargets(s);
    const on = [w.Idle, w.Walk, w.Run].filter((v) => v === 1);
    assert.equal(on.length, 1, `speed ${s.toFixed(1)} lit ${on.length} channels`);
    assert.equal(w.Idle + w.Walk + w.Run, 1);
  }
});

test("it writes into the caller's object — this runs per frame, per body", () => {
  const out = { Idle: 1, Walk: 0, Run: 0 };
  const same = blendTargets(9.4, out);
  assert.equal(same, out, "returns the object it was given, allocating nothing");
  assert.deepEqual(out, { Idle: 0, Walk: 0, Run: 1 });
});
