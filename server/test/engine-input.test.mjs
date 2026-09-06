import test from "node:test";
import assert from "node:assert/strict";
import { moveVectorFrom } from "../../src/game/engine/input.js";

test("WASD and arrows map to a rig-local vector, diagonals normalised", () => {
  const v = moveVectorFrom({ KeyW: true, KeyD: true }, 0);
  assert.ok(Math.abs(Math.hypot(v.x, v.z) - 1) < 1e-9, "unit length on a diagonal");
  assert.ok(v.z < 0 && v.x > 0);
  assert.deepEqual(moveVectorFrom({ ArrowDown: true }, 0), { x: 0, z: 1 });
  assert.deepEqual(moveVectorFrom({ KeyA: true, KeyD: true }, 0), { x: 0, z: 0 });
});

test("one finger walks forward, two fingers back, three or more do nothing", () => {
  assert.deepEqual(moveVectorFrom({}, 1), { x: 0, z: -1 });
  assert.deepEqual(moveVectorFrom({}, 2), { x: 0, z: 1 });
  assert.deepEqual(moveVectorFrom({}, 3), { x: 0, z: 0 });
});
