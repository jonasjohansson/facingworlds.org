// ut-movement-model.test.mjs — the UT99 acceleration model, lifted out of the A-Frame
// component and pinned to the numbers in GAME_CONFIG.MOVEMENT.
//
// This is the arithmetic that used to live in ut-controls' step()/approach() (see
// src/game/components/movement/ut-movement.js). It is worth testing on its own because
// every claim in the config's comment block — "0.183 s to 95% of top speed", "0.15 s from
// full speed to a standstill", "a reversal bleeds 9.4 -> 3.1 m/s" — is a claim about
// exactly these four lines, and nothing in the browser can assert them.
import test from "node:test";
import assert from "node:assert/strict";
import { createUtMovement } from "../../src/game/player/ut-movement-model.js";
import { GAME_CONFIG } from "../../src/game/config/game-config.js";

const M = GAME_CONFIG.MOVEMENT;
const cfg = {
  groundSpeed: M.GROUND_SPEED,
  accel: M.ACCEL,
  decel: M.DECEL,
  airControl: M.AIR_CONTROL,
};

const DT = 1 / 60;
const speed = (v) => Math.hypot(v.x, v.z);

/** Run `seconds` of frames at 60 Hz with a fixed heading. */
function run(model, dirX, dirZ, airborne, seconds, dt = DT) {
  const frames = Math.round(seconds / dt);
  for (let i = 0; i < frames; i++) model.step(dirX, dirZ, airborne, dt);
  return model.velocity;
}

test("from rest, holding forward for 1 s reaches min(groundSpeed, accel * 1)", () => {
  const model = createUtMovement(cfg);
  const v = run(model, 0, -1, false, 1);
  assert.equal(speed(v) <= M.GROUND_SPEED + 1e-9, true, "never overshoots the ground speed");
  assert.ok(Math.abs(speed(v) - Math.min(M.GROUND_SPEED, M.ACCEL * 1)) < 1e-9);
  // Forward is -Z, exactly as the input vector is handed in: no sideways drift.
  assert.ok(Math.abs(v.x) < 1e-12);
  assert.ok(v.z < 0);
});

test("the ramp is accel-limited: 0.183 s to 95% of top speed, as the config claims", () => {
  const model = createUtMovement(cfg);
  let t = 0;
  while (speed(model.velocity) < 0.95 * M.GROUND_SPEED && t < 2) {
    model.step(0, -1, false, DT);
    t += DT;
  }
  assert.ok(t > 0.15 && t < 0.21, `95% reached at ${t.toFixed(3)} s`);
});

test("releasing the keys decelerates to a dead stop within groundSpeed / decel seconds", () => {
  const model = createUtMovement(cfg);
  run(model, 0, -1, false, 1);
  assert.ok(Math.abs(speed(model.velocity) - M.GROUND_SPEED) < 1e-9);

  const stopTime = M.GROUND_SPEED / M.DECEL;
  // One frame of slack: the deceleration is applied in 1/60 s steps, so the exact
  // crossing lands inside a frame rather than on its boundary.
  run(model, 0, 0, false, stopTime + DT);
  assert.equal(speed(model.velocity), 0);

  // And not appreciably sooner: at half the stopping time there is still speed left.
  const m2 = createUtMovement(cfg);
  run(m2, 0, -1, false, 1);
  run(m2, 0, 0, false, stopTime / 2);
  assert.ok(speed(m2.velocity) > 0.3 * M.GROUND_SPEED);
});

test("airborne with no input keeps the momentum EXACTLY — the committed arc", () => {
  const model = createUtMovement(cfg);
  run(model, 0, -1, false, 1);
  const before = { x: model.velocity.x, z: model.velocity.z };
  run(model, 0, 0, true, 0.72); // a whole UT99 hop
  assert.equal(model.velocity.x, before.x);
  assert.equal(model.velocity.z, before.z);
});

test("airborne with input steers at accel * airControl, not accel", () => {
  const air = createUtMovement(cfg);
  air.step(0, -1, true, DT);
  assert.ok(Math.abs(speed(air.velocity) - M.ACCEL * M.AIR_CONTROL * DT) < 1e-9);

  const ground = createUtMovement(cfg);
  ground.step(0, -1, false, DT);
  assert.ok(Math.abs(speed(ground.velocity) - M.ACCEL * DT) < 1e-9);
});

test("a reversal decelerates through zero — the approach is toward the target VECTOR", () => {
  const model = createUtMovement(cfg);
  run(model, 1, 0, false, 1); // full speed along +X
  assert.ok(Math.abs(model.velocity.x - M.GROUND_SPEED) < 1e-9);

  // Hold the opposite direction. The velocity must pass through zero rather than flip.
  let sawZeroCrossing = false;
  let previous = model.velocity.x;
  for (let i = 0; i < 60; i++) {
    model.step(-1, 0, false, DT);
    const settled = Math.abs(model.velocity.x + M.GROUND_SPEED) < 1e-9;
    assert.ok(settled || model.velocity.x < previous, "monotonically bleeding off, never flipping");
    if (previous > 0 && model.velocity.x <= 0) sawZeroCrossing = true;
    // Reversing along one axis never introduces a sideways component.
    assert.ok(Math.abs(model.velocity.z) < 1e-12);
    previous = model.velocity.x;
  }
  assert.ok(sawZeroCrossing);
  assert.ok(Math.abs(model.velocity.x + M.GROUND_SPEED) < 1e-9, "and settles at full speed the other way");
});

test("an airborne reversal bleeds 9.4 -> ~3.1 m/s over a hop, the AIR_CONTROL 0.18 row", () => {
  const model = createUtMovement(cfg);
  run(model, 0, -1, false, 1);
  run(model, 0, 1, true, 0.72);
  const v = model.velocity;
  // Still travelling the way the takeoff pointed, at about a third of the speed.
  assert.ok(v.z < 0, "the jump was not cancelled mid-air");
  assert.ok(speed(v) > 2.5 && speed(v) < 3.7, `bled to ${speed(v).toFixed(2)} m/s`);
});

test("a diagonal heading is one ground speed, not 1.41x", () => {
  const model = createUtMovement(cfg);
  const s = Math.SQRT1_2;
  run(model, s, -s, false, 1);
  assert.ok(Math.abs(speed(model.velocity) - M.GROUND_SPEED) < 1e-9);
});

test("velocity is the model's own object: the caller reads it, never reassigns it", () => {
  const model = createUtMovement(cfg);
  const v = model.velocity;
  model.step(1, 0, false, DT);
  assert.equal(model.velocity, v);
  assert.ok(v.x > 0);
});
