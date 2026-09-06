// world.js — the static scene: map, navmesh, lights, sky. What the <a-scene> markup was.
import * as THREE from "three";

// space-environment's backgroundColor; the sky itself is registered later (Task 5).
const BACKGROUND = 0x000006;

export async function buildWorld(game) {
  game.scene.background = new THREE.Color(BACKGROUND);
  game.world = new THREE.Group();
  game.world.name = "world-root";
  game.scene.add(game.world);
}
