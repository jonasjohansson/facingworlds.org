// spawn.js — the OFFLINE / pre-hello placement: drop the player onto the navmesh.
//
// A port of core/spawn.js. What changed: the navmesh is `game.navmesh` rather than a
// #navmesh entity, there is no model-loaded wait (buildWorld awaits the glTF before
// anything registered here runs), and the rig is moved through the controller's
// spawnAt() rather than by writing an attribute — which is what resets the navmesh
// clamp's polygon cache. See the "EVERY TELEPORT MUST CALL navClamp.reset()" block in
// player/controller.js.
import * as THREE from "three";

// How far above the navmesh bbox the downward raycast starts. World-anchored, so it moved
// with the x2.33552 world scale (src/shared/map-transform.js); mirrors
// GAME_CONFIG.PLAYER.SPAWN_HEIGHT_ABOVE.
const ABOVE = 18.68;
// z-fighting lift in renderer units, not a world distance — deliberately NOT scaled, and
// the reason the server's spawn y is GROUND_Y + 0.05 rather than a plain multiple of k.
const LIFT = 0.05;

// Module flag, set by the network layer the moment it applies the server's assigned
// spawn (`hello.spawn`). This placement is only the OFFLINE / pre-hello position, and
// it can lose the race: `hello` may already have put us behind our own tower. Rather
// than serialising the two (which cost every player a navmesh wait before the socket was
// even opened), the loser simply stands down.
let serverSpawnApplied = false;

export function markServerSpawnApplied() {
  serverSpawnApplied = true;
}

/** Test seam, and what a match reset would need: forget that the server has spoken. */
export function resetServerSpawnApplied() {
  serverSpawnApplied = false;
}

function meshes(root) {
  const out = [];
  root.traverse((n) => {
    if (n.isMesh) out.push(n);
  });
  return out;
}

/**
 * @param {object} game needs `game.navmesh` (the loaded glTF root) and `game.player`.
 */
export async function placePlayerOnNavmesh(game) {
  const navRoot = game.navmesh;
  const player = game.player;
  if (!navRoot || !player) return;

  const list = meshes(navRoot);
  if (!list.length) return;

  const box = new THREE.Box3().setFromObject(navRoot);
  const center = new THREE.Vector3();
  box.getCenter(center);
  const start = new THREE.Vector3(center.x, box.max.y + ABOVE, center.z);

  const ray = new THREE.Raycaster(start, new THREE.Vector3(0, -1, 0), 0, box.max.y - box.min.y + ABOVE * 2);
  const hits = ray.intersectObjects(list, true);
  if (!hits.length) {
    console.warn("[spawn] no hit on navmesh");
    return;
  }

  const hit = hits[0].point.clone();
  hit.y += LIFT;
  // The server's spawn beat us here; moving the rig now would drag the player from
  // their team base back to the middle of the map (in CTF: onto the open bridge).
  // The rig is clamped to the navmesh either way — that job belongs to
  // player/navclamp.js, driven from the controller, not to anything set here.
  if (!serverSpawnApplied) player.spawnAt(hit.x, hit.y, hit.z);

  console.log(serverSpawnApplied ? "[spawn] server spawn already applied; kept rig in place" : "[spawn] rig placed at", hit);
}

export default placePlayerOnNavmesh;
