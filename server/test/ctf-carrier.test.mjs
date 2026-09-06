// ctf-carrier.test.mjs — a flag carried by SOMEONE ELSE has to ride their rig.
//
// This is the one path in ctf-flag.js that reaches outside its own system: a carried
// flag's position is not in the `flag` payload (the server sends the carrier, not the
// pose), so every frame the item asks the remote-avatars registry for the carrier's
// node and copies its world pose. Get that lookup wrong and there is no error and no
// warning — the flag simply freezes at the spot the bot picked it up, which is what an
// earlier version of remoteNode() did for every remote carrier at once.
//
// The registry is faked here rather than imported: RemoteAvatar wants a renderer, a
// GLTF loader and a network stream. What ctf-flag.js is entitled to assume of it is
// exactly what is faked — `game.systems.get("remote-avatars").get(id)` yields an object
// with a `.rig`, the node the wire pose is written onto.
import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { createEvents } from "../../src/game/engine/events.js";
import { CtfFlags } from "../../src/game/systems/ctf-flag.js";
import { FLAG_HOMES } from "../../src/shared/map-actors.js";
import { GAME_CONFIG } from "../../src/game/config/game-config.js";

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

/** One remote player, as much of RemoteAvatar as a flag ever touches. */
function fakeAvatars(game, id) {
  const rig = new THREE.Group();
  rig.name = `remote-rig-${id}`;
  // The ground-corrected child. remoteNode() must NOT return this one: it carries the
  // avatar's floor offset, which would sink the flag by that much.
  const body = new THREE.Group();
  body.name = "body";
  body.position.y = -0.42;
  rig.add(body);
  game.world.add(rig);
  game.systems.set("remote-avatars", { get: (who) => (who === id ? { rig, body } : null) });
  return { rig, body };
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

test("remoteNode hands back the carrier's rig, not its ground-corrected body", () => {
  const game = fakeGame();
  const sys = new CtfFlags(game);
  const { rig } = fakeAvatars(game, "bot-1");

  assert.equal(sys.remoteNode("bot-1"), rig);
  // Nobody by that name, and no registry at all, are both "no node" and not a throw.
  assert.equal(sys.remoteNode("nobody"), null);
  game.systems.delete("remote-avatars");
  assert.equal(sys.remoteNode("bot-1"), null);
});

test("a flag taken by a remote player follows that player's rig every frame", () => {
  const game = fakeGame();
  const sys = new CtfFlags(game);
  const { rig } = fakeAvatars(game, "bot-1");

  game.events.emit("ctf-init", { flags: [flagAt("red"), flagAt("blue")], myTeam: "red" });
  const blue = sys.flags.get("blue");

  // The server says a bot has it. The payload's position is deliberately nonsense —
  // a carried flag's pose comes from the carrier, never from the snapshot.
  game.events.emit("flag-update", {
    team: "blue",
    state: "carried",
    x: 0,
    y: 0,
    z: 0,
    carrier: "bot-1",
    isMine: false,
    myTeam: "red",
  });
  assert.equal(blue.state, "carried");
  // Someone else is carrying it, so it stays drawn (only our OWN carried flag hides).
  assert.equal(blue.group.visible, true);

  const off = GAME_CONFIG.CTF.CARRY_OFFSET;
  rig.position.set(12, 3, -8);
  rig.updateMatrixWorld(true);
  sys.update(0.016, 1000);
  assert.ok(Math.abs(blue.node.position.x - (12 + off.x)) < 1e-6);
  assert.ok(Math.abs(blue.node.position.y - (3 + off.y)) < 1e-6);
  assert.ok(Math.abs(blue.node.position.z - (-8 + off.z)) < 1e-6);

  // It MOVES. The bug this test exists for left the flag wherever it was taken.
  rig.position.set(-30, 9, 44);
  rig.rotation.y = Math.PI / 2;
  rig.updateMatrixWorld(true);
  sys.update(0.016, 1016);
  // Yawed a quarter turn, the carry offset's +z lands on +x.
  assert.ok(Math.abs(blue.node.position.x - (-30 + off.z)) < 1e-6);
  assert.ok(Math.abs(blue.node.position.y - (9 + off.y)) < 1e-6);
  assert.ok(Math.abs(blue.node.position.z - (44 - off.x)) < 1e-6);
  assert.ok(Math.abs(blue.node.rotation.y - Math.PI / 2) < 1e-6);
  assert.ok(Math.abs(blue.node.rotation.x - THREE.MathUtils.degToRad(-GAME_CONFIG.CTF.CARRY_TILT_DEG)) < 1e-9);
});
