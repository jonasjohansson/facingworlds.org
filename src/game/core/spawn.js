// spawn.js (ES module)
import { waitForModelLoaded } from "../utils/dom-helpers.js";
import { createVector3, createRaycaster } from "../utils/three-helpers.js";

const NAV = "#navmesh";
const RIG = "#rig";
// How far above the navmesh bbox the downward raycast starts. World-anchored, so it moved
// with the x2.33552 world scale (src/shared/map-transform.js); mirrors
// GAME_CONFIG.PLAYER.SPAWN_HEIGHT_ABOVE.
const ABOVE = 18.68;
// z-fighting lift in renderer units, not a world distance — deliberately NOT scaled, and
// the reason the server's spawn y is GROUND_Y + 0.05 rather than a plain multiple of k.
const LIFT = 0.05;

// Module flag, set by the network layer the moment it applies the server's assigned
// spawn (`hello.spawn`). This placement is only the OFFLINE / pre-hello position, and
// it is async — the navmesh raycast can easily resolve after `hello` has already put
// us behind our own tower. Rather than serialising the two (which cost every player a
// navmesh wait before the socket was even opened), the loser simply stands down.
let serverSpawnApplied = false;

export function markServerSpawnApplied() {
  serverSpawnApplied = true;
}

function meshReady(el) {
  return waitForModelLoaded(el);
}

function meshes(root) {
  const out = [];
  root.traverse((n) => {
    if (n.isMesh) out.push(n);
  });
  return out;
}

export async function placePlayerOnNavmesh() {
  const navEl = document.querySelector(NAV);
  const rigEl = document.querySelector(RIG);
  if (!navEl || !rigEl) return;

  const navMesh = await meshReady(navEl);
  const list = meshes(navMesh);
  if (!list.length) return;

  const box = new THREE.Box3().setFromObject(navMesh);
  const center = createVector3();
  box.getCenter(center);
  const start = createVector3(center.x, box.max.y + ABOVE, center.z);

  const ray = createRaycaster(start, createVector3(0, -1, 0), 0, box.max.y - box.min.y + ABOVE * 2);
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
  // aframe-extras' `movement-controls constrainToNavMesh` on #rig plus `nav-mesh`
  // on #navmesh (index.html), not to anything set here.
  if (!serverSpawnApplied) rigEl.setAttribute("position", `${hit.x} ${hit.y} ${hit.z}`);

  console.log(serverSpawnApplied ? "[spawn] server spawn already applied; kept rig in place" : "[spawn] rig placed at", hit);
}

export default placePlayerOnNavmesh;
