// view-shake.test.mjs — the ported PlayerPawn.ViewShake, checked against Epic's arithmetic.
//
// The module takes its FRand() by injection precisely so this file can pin numbers down.
// Every expectation below is hand-computed from the UnrealScript, not recorded from a run:
// if the port drifts, these fail with a value you can trace back to a line of .uc.
import test from "node:test";
import assert from "node:assert/strict";

import {
  createViewShake,
  DEFAULT_SHAKE,
  ROLL_DECAY_UU_PER_SEC,
  ROTATION_UNITS,
} from "../../src/game/components/view-shake.js";
import { UU_TO_M } from "../../src/shared/map-transform.js";

/** FRand() that always returns the same thing, so every branch below is decidable. */
const constant = (v) => () => v;

/** A tiny LCG, for the "run it a lot and check the invariants" tests. */
function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

test("ShakeView maps seconds and UU onto ClientShake's hundredths", () => {
  const shake = createViewShake(constant(0));
  shake.shakeView(DEFAULT_SHAKE.time, DEFAULT_SHAKE.mag, DEFAULT_SHAKE.vert);

  // ClientShake(vect(300, 10, 500)) -> shakemag 300, shaketimer 0.1, maxshake 5.
  assert.equal(shake.magnitude(), 300);
  assert.equal(shake.active(), true);
  // The arming jolt is straight down at 1.1x the vertical amplitude.
  assert.equal(shake.vertUU(), -1.1 * DEFAULT_SHAKE.vert);
  assert.equal(shake.vertM(), -1.1 * DEFAULT_SHAKE.vert * UU_TO_M);
  // Nothing has ticked, so the view is still level.
  assert.equal(shake.rollUU(), 0);
});

test("a weaker shake cannot preempt a stronger one that still has time on it", () => {
  const shake = createViewShake(constant(0));
  // A long, hard shake: shakemag 800, shaketimer 0.5.
  shake.shakeView(0.5, 800, 8);
  // A pistol shot arrives: 300 < 800 AND 0.5 > 0.1, so both halves of the guard refuse it.
  shake.shakeView(DEFAULT_SHAKE.time, DEFAULT_SHAKE.mag, DEFAULT_SHAKE.vert);
  assert.equal(shake.magnitude(), 800);

  // A STRONGER one does get through, whatever the timer says.
  shake.shakeView(0.05, 1200, 10);
  assert.equal(shake.magnitude(), 1200);
});

test("consecutive shots of the same weapon re-arm the shake, as they do in UT99", () => {
  const shake = createViewShake(constant(0));
  shake.shakeView(0.1, 300, 5);
  for (let i = 0; i < 5; i++) shake.tick(1 / 60);
  // shaketimer is now ~0.017 and 0.017 <= 0.01 * 10, so the second half of the guard opens.
  shake.shakeView(0.1, 300, 5);
  assert.equal(shake.magnitude(), 300);
  assert.equal(shake.vertUU(), -1.1 * 5); // re-armed, so the down-jolt is back
});

test("the first frame steps the roll by int(10 * shakemag * min(0.1, dt))", () => {
  const shake = createViewShake(constant(0));
  shake.shakeView(DEFAULT_SHAKE.time, DEFAULT_SHAKE.mag, DEFAULT_SHAKE.vert);

  // bShakeDir starts false, so the first move is DOWNWARD in rotator units.
  // int(10 * 300 * 1/60) = int(50) = 50.
  shake.tick(1 / 60);
  assert.equal(shake.rollUU(), -50);
  assert.equal(shake.rollRad(), (-50 / ROTATION_UNITS) * Math.PI * 2);

  // verttimer was 0 on entry, so the frame re-armed the down-jolt rather than re-rolling.
  assert.equal(shake.vertUU(), -1.1 * DEFAULT_SHAKE.vert);
});

test("the step is capped at a 0.1 s dt so a frame hitch cannot fling the view", () => {
  const a = createViewShake(constant(0));
  const b = createViewShake(constant(0));
  a.shakeView(1, 300, 5);
  b.shakeView(1, 300, 5);
  a.tick(0.1);
  b.tick(5); // a five-second stall
  assert.equal(a.rollUU(), -300);
  assert.equal(b.rollUU(), -300);
});

test("the roll stays inside Epic's +/-1.3 * shakemag clamp", () => {
  const shake = createViewShake(lcg(20260905));
  const mag = 300;
  const step = Math.trunc(10 * mag * (1 / 60));
  // The clamp only fires once ViewRotation.Roll has been masked back into 0..65535, which
  // happens on the frame AFTER an excursion, so one step of overshoot is expected.
  const bound = 1.3 * mag + step;

  for (let i = 0; i < 600; i++) {
    if (i % 15 === 0) shake.shakeView(0.1, mag, 5);
    shake.tick(1 / 60);
    assert.ok(Math.abs(shake.rollUU()) <= bound, `roll ${shake.rollUU()} exceeded ${bound}`);
    assert.ok(Math.abs(shake.vertUU()) <= 1.1 * 5 + 1e-9);
  }
});

test("the roll actually oscillates rather than parking on one side", () => {
  const shake = createViewShake(lcg(7));
  let sawPositive = false;
  let sawNegative = false;
  for (let i = 0; i < 600; i++) {
    if (i % 10 === 0) shake.shakeView(0.2, 400, 6);
    shake.tick(1 / 60);
    if (shake.rollUU() > 50) sawPositive = true;
    if (shake.rollUU() < -50) sawNegative = true;
  }
  assert.ok(sawPositive && sawNegative, "roll never crossed level in both directions");
});

test("once the timer expires the roll unwinds to level and the eye stops moving", () => {
  const shake = createViewShake(lcg(99));
  shake.shakeView(DEFAULT_SHAKE.time, DEFAULT_SHAKE.mag, DEFAULT_SHAKE.vert);
  // Run the whole 0.1 s of shake out.
  for (let i = 0; i < 8; i++) shake.tick(1 / 60);
  assert.equal(shake.active(), false);

  // The vertical offset is dropped on the very first frame after the timer.
  shake.tick(1 / 60);
  assert.equal(shake.vertUU(), 0);
  assert.equal(shake.vertM(), 0);
  assert.equal(shake.magnitude(), 0);

  // ROLL_DECAY_UU_PER_SEC is sized so a full 1.3 * 300 excursion is gone in ~0.2 s.
  const framesFor200ms = Math.ceil(0.2 * 60);
  for (let i = 0; i < framesFor200ms; i++) shake.tick(1 / 60);
  assert.equal(shake.rollUU(), 0);
  assert.ok((1.3 * 300) / ROLL_DECAY_UU_PER_SEC <= 0.21);
});

test("reset() puts the view straight back to level", () => {
  const shake = createViewShake(lcg(3));
  shake.shakeView(0.5, 900, 9);
  for (let i = 0; i < 10; i++) shake.tick(1 / 60);
  shake.reset();
  assert.equal(shake.rollUU(), 0);
  assert.equal(shake.vertUU(), 0);
  assert.equal(shake.active(), false);
});

test("a zero or negative dt is a no-op rather than a rewind", () => {
  const shake = createViewShake(constant(0));
  shake.shakeView(0.1, 300, 5);
  shake.tick(1 / 60);
  const before = shake.rollUU();
  shake.tick(0);
  shake.tick(-1);
  assert.equal(shake.rollUU(), before);
});
