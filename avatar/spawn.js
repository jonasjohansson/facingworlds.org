// spawn.js (ES module)
import { waitForModelLoaded } from "./js/utils/dom-helpers.js";
import { createVector3, createRaycaster } from "./js/utils/three-helpers.js";

const NAV = "#navmesh";
const RIG = "#rig";
const ABOVE = 8;
const LIFT = 0.05;

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
  rigEl.setAttribute("position", `${hit.x} ${hit.y} ${hit.z}`);

  // gentle snap so constraint doesn't fight our placement
  const cur = rigEl.getAttribute("navmesh-constraint") || {};
  const height = cur.height != null ? cur.height : 0.12;
  rigEl.setAttribute("navmesh-constraint", `navmesh:${NAV}; fall: 0.5; height: ${height}`);

  console.log("[spawn] rig placed at", hit);
}

export default placePlayerOnNavmesh;
