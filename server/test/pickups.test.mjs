// pickups.test.mjs — the client's pickup set, pinned.
//
// The pickups are the server's, and the client's only jobs are (a) knowing which model
// to draw for every type the server can send and (b) hiding/showing/asking on the three
// events it gets. Both are cheap to get wrong silently: a type with no model entry falls
// through to the Enforcer fallback and puts a floating pistol where a Redeemer should
// be, and an availability bug leaves a taken item standing there for everyone.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import * as THREE from "three";
import { createEvents } from "../../src/game/engine/events.js";
import { WeaponPickups, PICKUP_MODELS, pickupModelUrl } from "../../src/game/systems/weapon-pickup.js";
import { GAME_CONFIG } from "../../src/game/config/game-config.js";

// PICKUP_TYPE in server/server.js, written out by hand rather than imported: importing
// server.js starts a WebSocket server. A row added there has to be added HERE too before
// the test can hold the client's model table to it.
const SERVER_PICKUP_TYPES = [
  "health", // the eight MedBoxes; drawn from primitives, not a model
  "armor",
  "udamage",
  "health-big",
  "weapon-sniper",
  "weapon-shock",
  "weapon-rocket",
  "weapon-ripper",
  "weapon-redeemer",
  "ammo-bullet",
  "ammo-rocket",
  "ammo-shock",
];

test("every pickup type the server can send has a visual", () => {
  for (const type of SERVER_PICKUP_TYPES) {
    if (type === "health") continue; // built by hand in buildHealthVisual()
    assert.ok(PICKUP_MODELS[type], `no model for pickup type "${type}"`);
  }
  // And nothing extra: an entry the server never sends is dead weight.
  assert.deepEqual(
    Object.keys(PICKUP_MODELS).sort(),
    SERVER_PICKUP_TYPES.filter((t) => t !== "health").sort()
  );
});

test("the model URL is the assets/3d/pickups layout, and every file is on disk", () => {
  assert.equal(pickupModelUrl("weapon-redeemer"), "assets/3d/pickups/WarheadLauncher/WarheadLauncher.gltf");
  // Unknown types fall through to the Enforcer fallback rather than a broken URL.
  assert.equal(pickupModelUrl("dual-enforcer"), null);
  for (const type of Object.keys(PICKUP_MODELS)) {
    assert.ok(existsSync(pickupModelUrl(type)), `missing model file for "${type}"`);
  }
});

/** The parts of `game` these systems touch. No renderer, no DOM. */
function fakeGame() {
  const game = {
    world: new THREE.Group(),
    systems: new Map(),
    events: createEvents(),
    rig: null,
    attach(node, name, system) {
      (node.userData.systems ||= {})[name] = system;
      return system;
    },
  };
  return game;
}

// `health` is the one type with no glTF behind it, so a Node test can build the whole
// system without a network fetch.
const medbox = (id, x) => ({ id, type: "health", x, y: 1, z: 0, available: true });

test("pickups-init replaces the whole set; taken/respawn toggle one item", () => {
  const game = fakeGame();
  const sys = new WeaponPickups(game);

  game.events.emit("pickups-init", { pickups: [medbox("a", 0), medbox("b", 10), medbox("c", 20)] });
  assert.equal(sys.items.size, 3);
  assert.equal(game.world.children.length, 3);

  game.events.emit("pickup-taken", { id: "b" });
  assert.equal(sys.items.get("b").available, false);
  assert.equal(sys.items.get("b").node.visible, false);

  game.events.emit("pickup-respawn", { id: "b" });
  assert.equal(sys.items.get("b").available, true);
  assert.equal(sys.items.get("b").node.visible, true);

  // A reconnect sends the whole list again: the old nodes must leave the scene.
  game.events.emit("pickups-init", { pickups: [medbox("a", 0)] });
  assert.equal(sys.items.size, 1);
  assert.equal(game.world.children.length, 1);
});

test("an item that arrives taken is invisible from the first frame", () => {
  const game = fakeGame();
  const sys = new WeaponPickups(game);
  game.events.emit("pickups-init", { pickups: [{ ...medbox("a", 0), available: false }] });
  assert.equal(sys.items.get("a").node.visible, false);
});

test("the sweep asks only for an available item inside the radius, and only every CLAIM_INTERVAL", () => {
  const game = fakeGame();
  const sys = new WeaponPickups(game);
  const asked = [];
  game.events.on("request-pickup", (e) => asked.push(e.detail.id));

  game.events.emit("pickups-init", { pickups: [medbox("near", 0), medbox("far", 40)] });

  // No rig yet — the player controller registers after the world is built, so this is
  // the state of every page for its first frames.
  sys.update(0.016, 1000);
  assert.deepEqual(asked, []);

  game.rig = new THREE.Object3D();
  game.rig.position.set(0, 1, 0);
  sys.update(0.016, 1000);
  assert.deepEqual(asked, ["near"]);

  // Inside the interval: silence.
  sys.update(0.016, 1100);
  assert.deepEqual(asked, ["near"]);
  sys.update(0.016, 1000 + GAME_CONFIG.PICKUP.CLAIM_INTERVAL + 1);
  assert.deepEqual(asked, ["near", "near"]);

  // Taken items are not asked for again.
  game.events.emit("pickup-taken", { id: "near" });
  sys.update(0.016, 5000);
  assert.deepEqual(asked, ["near", "near"]);
});

test("items spin and bob about the position the server gave them", () => {
  const game = fakeGame();
  const sys = new WeaponPickups(game);
  game.events.emit("pickups-init", { pickups: [medbox("a", 0)] });
  const item = sys.items.get("a");

  assert.equal(item.baseY, 1);
  const y0 = item.node.position.y;
  sys.update(0.5, 100);
  assert.notEqual(item.node.position.y, y0);
  assert.ok(Math.abs(item.node.position.y - 1) <= GAME_CONFIG.PICKUP.BOB_HEIGHT + 1e-9);
  assert.ok(Math.abs(item.node.rotation.y - GAME_CONFIG.PICKUP.SPIN_SPEED * 0.5) < 1e-9);
});
