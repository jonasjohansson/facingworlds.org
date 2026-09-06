// remote-fire-state.test.mjs — the two decisions a remote avatar makes when somebody shoots.
//
// The state machine is pure and lives in the client tree (src/game/systems/), but it is
// the one piece of the remote fire animation that can be checked without a browser: given
// a clock, the last shot and whether the body is moving, does the pawn get UT99's standing
// PlayRecoil or its *FR locomotion swap, and for how long?
//
// What these guard, in order of how easy each was to get wrong:
//   - the two poses are MUTUALLY EXCLUSIVE. UT99 never plays a recoil over a run.
//   - the hold is measured from the LAST shot, so a burst is one continuous firing pose.
//   - "never fired" is not "fired at time 0" — an avatar that has not shot must not spend
//     its first half second holding a rifle up.
import test from "node:test";
import assert from "node:assert/strict";
import {
  FIRE_HOLD_MS,
  FIRE_REPEAT_MS,
  fireState,
  pickFireClip,
} from "../../src/game/systems/remote-fire-state.js";

test("a standing pawn gets the recoil, a moving one gets the locomotion swap", () => {
  const standing = fireState(1000, 1000, false);
  assert.equal(standing.firing, true);
  assert.equal(standing.recoil, true);
  assert.equal(standing.locomotion, false);

  const running = fireState(1000, 1000, true);
  assert.equal(running.firing, true);
  assert.equal(running.recoil, false);
  assert.equal(running.locomotion, true);
});

test("the pose is held for FIRE_HOLD_MS after the last shot and then let go", () => {
  const shot = 5000;
  assert.equal(fireState(shot + FIRE_HOLD_MS - 1, shot, true).firing, true);
  assert.equal(fireState(shot + FIRE_HOLD_MS, shot, true).firing, false);
  assert.equal(fireState(shot + 10000, shot, true).firing, false);
});

test("a burst extends the hold rather than restarting a flicker", () => {
  // Enforcer cadence: 4 shots a second, so 250 ms apart — inside the hold, which is the
  // whole point. Sample between two shots and the pose is still on.
  const first = 1000;
  const second = 1250;
  assert.equal(fireState(1249, first, true).firing, true, "still up when the next shot lands");
  assert.equal(fireState(1600, first, true).firing, false, "the first shot alone would have ended");
  assert.equal(fireState(1600, second, true).firing, true, "the second shot carries it");
});

test("a pawn that has never fired is not firing", () => {
  assert.equal(fireState(1000, 0, false).firing, false);
  assert.equal(fireState(1000, undefined, false).firing, false);
  assert.equal(fireState(1000, NaN, false).firing, false);
});

test("a shot stamped in the future is ignored rather than held for ever", () => {
  assert.equal(fireState(1000, 9000, false).firing, false);
});

test("the body being moving is what flips recoil to locomotion mid-hold", () => {
  // A pawn that fires standing and then runs: the recoil must hand over to the FR
  // locomotion without a gap, which is the same `firing` window read two ways.
  const shot = 2000;
  const stopped = fireState(shot + 100, shot, false);
  const started = fireState(shot + 200, shot, true);
  assert.deepEqual(
    [stopped.recoil, stopped.locomotion, started.recoil, started.locomotion],
    [true, false, false, true]
  );
});

test("pickFireClip degrades to nothing when the weapon has no anims", () => {
  assert.equal(pickFireClip(null, Infinity), null);
  assert.equal(pickFireClip({}, Infinity), null);
  assert.equal(pickFireClip({ fire: [] }, Infinity), null);
});

test("pickFireClip takes the repeat sequence only for a follow-up shot", () => {
  const anims = { fire: [{ clip: "Shoot", rate: 0.81 }], fireRepeat: { clip: "shot2", rate: 1 } };
  assert.equal(pickFireClip(anims, Infinity).clip, "Shoot", "first shot");
  assert.equal(pickFireClip(anims, FIRE_REPEAT_MS - 1).clip, "shot2", "inside the burst");
  assert.equal(pickFireClip(anims, FIRE_REPEAT_MS).clip, "Shoot", "the burst has lapsed");
});

test("pickFireClip picks among several fire sequences", () => {
  const anims = { fire: [{ clip: "A" }, { clip: "B" }] };
  assert.equal(pickFireClip(anims, Infinity, () => 0).clip, "A");
  assert.equal(pickFireClip(anims, Infinity, () => 0.99).clip, "B");
  // A random() that returns exactly 1 (or anything out of range) must still index.
  assert.ok(pickFireClip(anims, Infinity, () => 1));
});
