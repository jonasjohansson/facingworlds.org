// ctf-flags.test.mjs — the client's half of Capture the Flag.
//
// The server owns every flag decision; what is testable here is the little that is
// genuinely the client's: the touch predicate that decides whether asking is even
// worth a message, the wholesale rebuild on `ctf-init`, the three states a
// `flag-update` puts a flag into, and the two stands that must land exactly on the
// level data's flag bases rather than on anything typed out by hand.
import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { createEvents } from "../../src/game/engine/events.js";
import { CtfFlags, FlagItem, flagTouchIsMeaningful } from "../../src/game/systems/ctf-flag.js";
import { FLAG_HOMES } from "../../src/shared/map-actors.js";
import { GAME_CONFIG } from "../../src/game/config/game-config.js";

test("the touch predicate filters out everything the server could only refuse", () => {
  // (myTeam, carrying, team, state) — positional, because the sweep calls this for
  // every flag on every frame and an options object there is an allocation per call.
  const m = (team, state, carrying = null) => flagTouchIsMeaningful("red", carrying, team, state);

  // No team means no match.
  assert.equal(flagTouchIsMeaningful(null, null, "blue", "home"), false);
  // A flag someone is already carrying is not touchable at all.
  assert.equal(m("blue", "carried"), false);
  // The enemy flag is worth taking — unless we already have one.
  assert.equal(m("blue", "home"), true);
  assert.equal(m("blue", "dropped"), true);
  assert.equal(m("blue", "home", "blue"), false);
  // Our own flag: dropped means return it, whatever we are holding.
  assert.equal(m("red", "dropped"), true);
  assert.equal(m("red", "dropped", "blue"), true);
  // Standing on our own flag at home is a capture only if we are holding theirs.
  assert.equal(m("red", "home"), false);
  assert.equal(m("red", "home", "blue"), true);
});

/** The parts of `game` these systems touch. No renderer, no DOM. */
function fakeGame() {
  return {
    world: new THREE.Group(),
    systems: new Map(),
    events: createEvents(),
    rig: null,
    attach(node, name, system) {
      (node.userData.systems ||= {})[name] = system;
      return system;
    },
  };
}

const flagAt = (team, over = {}) => ({
  team,
  state: "home",
  carrier: null,
  x: FLAG_HOMES[team].x,
  y: FLAG_HOMES[team].y,
  z: FLAG_HOMES[team].z,
  ...over,
});

const initDetail = (myTeam = "red") => ({
  flags: [flagAt("red"), flagAt("blue")],
  scores: { red: 0, blue: 0 },
  myTeam,
});

test("both stands stand on FLAG_HOMES, with no position typed out anywhere", () => {
  const game = fakeGame();
  const sys = new CtfFlags(game);
  for (const team of ["red", "blue"]) {
    const stand = sys.stands.get(team);
    assert.deepEqual(stand.node.position.toArray(), [FLAG_HOMES[team].x, FLAG_HOMES[team].y, FLAG_HOMES[team].z]);
  }
});

test("the flag glow sits at 0.75 of the pole, i.e. where the A-Frame page measured it", () => {
  // The reviewer of the world task measured the old page's two glows at
  // (101.180, 1.440, 5.000) and (-75.420, 1.480, -20.380). Those are the flag bases
  // plus 0.75 x POLE_HEIGHT, and they are what the port has to reproduce: the glow is
  // the only light in the scene that moves with the objective.
  const expected = { red: [101.18, 1.44, 5.0], blue: [-75.42, 1.48, -20.38] };
  for (const team of ["red", "blue"]) {
    const node = new THREE.Group();
    node.position.set(FLAG_HOMES[team].x, FLAG_HOMES[team].y, FLAG_HOMES[team].z);
    const item = new FlagItem({}, node, { team, state: "home" });
    const world = item.glow.getWorldPosition(new THREE.Vector3());
    for (let i = 0; i < 3; i++) assert.ok(Math.abs(world.toArray()[i] - expected[team][i]) < 1e-6, `${team} axis ${i}`);
    // A-Frame's light component defaults decay to 1; the intensity and distance were
    // tuned against that falloff, so all three have to travel together.
    assert.equal(item.glow.decay, 1);
    assert.equal(item.glow.intensity, 5.14);
    assert.equal(item.glow.distance, 18.68);
  }
});

test("ctf-init builds both flags at home and rebuilds wholesale on a reconnect", () => {
  const game = fakeGame();
  const sys = new CtfFlags(game);
  game.events.emit("ctf-init", initDetail("red"));

  assert.equal(sys.flags.size, 2);
  assert.equal(sys.myTeam, "red");
  // Two stands plus two flags.
  assert.equal(game.world.children.length, 4);
  assert.deepEqual(sys.flags.get("blue").node.position.toArray(), [
    FLAG_HOMES.blue.x,
    FLAG_HOMES.blue.y,
    FLAG_HOMES.blue.z,
  ]);

  const firstRed = sys.flags.get("red");
  game.events.emit("ctf-init", initDetail("blue"));
  assert.equal(sys.myTeam, "blue");
  assert.equal(sys.flags.size, 2);
  assert.notEqual(sys.flags.get("red"), firstRed);
  assert.equal(firstRed.node.parent, null);
  assert.equal(game.world.children.length, 4);
});

test("losing the team takes the flags down but leaves the stands standing", () => {
  const game = fakeGame();
  const sys = new CtfFlags(game);
  game.events.emit("ctf-init", initDetail("red"));
  game.events.emit("local-team", { team: null });

  assert.equal(sys.flags.size, 0);
  assert.equal(sys.carrying, null);
  assert.equal(game.world.children.length, 2); // the two stands
});

test("flag-update is the only thing that moves a flag between the three states", () => {
  const game = fakeGame();
  const sys = new CtfFlags(game);
  game.events.emit("player-join", { id: "me", isLocal: true });
  game.events.emit("ctf-init", initDetail("red"));
  const blue = sys.flags.get("blue");

  // Taken by us. The carried position in the payload is ignored — the flag rides the
  // carrier's rig instead — and our own flag is hidden because we cannot see ourselves.
  game.events.emit("flag-update", {
    team: "blue",
    state: "carried",
    x: 0,
    y: 0,
    z: 0,
    carrier: "me",
    isMine: true,
    myTeam: "red",
  });
  assert.equal(blue.state, "carried");
  assert.equal(sys.carrying, "blue");
  assert.equal(blue.group.visible, false);
  assert.deepEqual(blue.pos.toArray(), [FLAG_HOMES.blue.x, FLAG_HOMES.blue.y, FLAG_HOMES.blue.z]);

  // The rig it rides on: position plus the carry offset, yawed with the carrier.
  game.rig = new THREE.Object3D();
  game.rig.position.set(5, 2, -3);
  sys.update(0.016, 1000);
  const off = GAME_CONFIG.CTF.CARRY_OFFSET;
  assert.ok(Math.abs(blue.node.position.x - (5 + off.x)) < 1e-6);
  assert.ok(Math.abs(blue.node.position.y - (2 + off.y)) < 1e-6);
  assert.ok(Math.abs(blue.node.position.z - (-3 + off.z)) < 1e-6);

  // Dropped where we died: authoritative position, and it tips over.
  game.events.emit("flag-update", {
    team: "blue",
    state: "dropped",
    x: 11,
    y: 13,
    z: -9,
    carrier: null,
    isMine: false,
    myTeam: "red",
  });
  assert.equal(sys.carrying, null);
  assert.equal(blue.group.visible, true);
  assert.deepEqual(blue.node.position.toArray(), [11, 13, -9]);
  assert.ok(Math.abs(blue.node.rotation.x - THREE.MathUtils.degToRad(GAME_CONFIG.CTF.DROP_TILT_DEG)) < 1e-9);

  // Returned home: upright and square to the world, however the carrier was facing.
  game.events.emit("flag-update", {
    team: "blue",
    state: "home",
    x: FLAG_HOMES.blue.x,
    y: FLAG_HOMES.blue.y,
    z: FLAG_HOMES.blue.z,
    carrier: null,
    isMine: false,
    myTeam: "red",
  });
  assert.deepEqual(blue.node.rotation.toArray().slice(0, 3), [0, 0, 0]);
  assert.deepEqual(blue.pos.toArray(), [FLAG_HOMES.blue.x, FLAG_HOMES.blue.y, FLAG_HOMES.blue.z]);
});

test("the sweep asks for the enemy flag when we stand on it, and only every CLAIM_INTERVAL", () => {
  const game = fakeGame();
  const sys = new CtfFlags(game);
  const asked = [];
  game.events.on("request-flag-touch", (e) => asked.push(e.detail.team));
  game.events.emit("ctf-init", initDetail("red"));

  // No rig for the first frames of a page load.
  sys.update(0.016, 1000);
  assert.deepEqual(asked, []);

  game.rig = new THREE.Object3D();
  game.rig.position.set(FLAG_HOMES.blue.x, FLAG_HOMES.blue.y, FLAG_HOMES.blue.z);
  sys.update(0.016, 1000);
  assert.deepEqual(asked, ["blue"]);

  sys.update(0.016, 1100);
  assert.deepEqual(asked, ["blue"]);
  sys.update(0.016, 1000 + GAME_CONFIG.CTF.CLAIM_INTERVAL + 1);
  assert.deepEqual(asked, ["blue", "blue"]);

  // Standing on our OWN flag at home, holding nothing, is not an event.
  asked.length = 0;
  game.rig.position.set(FLAG_HOMES.red.x, FLAG_HOMES.red.y, FLAG_HOMES.red.z);
  sys.update(0.016, 9000);
  assert.deepEqual(asked, []);
});
