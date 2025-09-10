// spawn.js
(function () {
  const NAV = "#navmesh",
    RIG = "#rig";
  const ABOVE = 8,
    LIFT = 0.05;

  function meshReady(el) {
    return new Promise((res) => {
      const m = el && el.getObject3D("mesh");
      if (m) return res(m);
      el && el.addEventListener("model-loaded", () => res(el.getObject3D("mesh")), { once: true });
    });
  }
  function meshes(root) {
    const out = [];
    root.traverse((n) => {
      if (n.isMesh) out.push(n);
    });
    return out;
  }

  async function place() {
    const navEl = document.querySelector(NAV);
    const rigEl = document.querySelector(RIG);
    if (!navEl || !rigEl) return;

    const navMesh = await meshReady(navEl);
    const list = meshes(navMesh);
    if (!list.length) return;

    const box = new THREE.Box3().setFromObject(navMesh);
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
    rigEl.setAttribute("position", `${hit.x} ${hit.y} ${hit.z}`);

    // gentle snap so constraint doesn’t fight our placement
    const cur = rigEl.getAttribute("navmesh-constraint") || {};
    const height = cur.height != null ? cur.height : 0.12;
    rigEl.setAttribute("navmesh-constraint", `navmesh:${NAV}; fall: 0.5; height: ${height}`);

    console.log("[spawn] rig placed at", hit);
  }

  if (document.readyState === "complete") place();
  else window.addEventListener("load", place);
})();
