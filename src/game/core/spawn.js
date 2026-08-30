// spawn.js (ES module)
import { waitForModelLoaded } from "../utils/dom-helpers.js";
import { createVector3, createRaycaster } from "../utils/three-helpers.js";

const NAV = "#navmesh";
const RIG = "#rig";
const ABOVE = 8;
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
  // The navmesh constraint below still gets applied either way.
  if (!serverSpawnApplied) rigEl.setAttribute("position", `${hit.x} ${hit.y} ${hit.z}`);

  // gentle snap so constraint doesn't fight our placement
  const cur = rigEl.getAttribute("navmesh-constraint") || {};
  const height = cur.height != null ? cur.height : 0.12;
  rigEl.setAttribute("navmesh-constraint", `navmesh:${NAV}; fall: 0.5; height: ${height}`);

  console.log(serverSpawnApplied ? "[spawn] server spawn already applied; kept rig in place" : "[spawn] rig placed at", hit);
}

export default placePlayerOnNavmesh;
