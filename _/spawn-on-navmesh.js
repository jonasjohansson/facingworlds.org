// spawn-on-navmesh.js
(function () {
  const NAV = "#navmesh";
  const RIG = "#rig";
  const ABOVE = 10; // cast from ABOVE metres above the top
  const LIFT = 0.05; // nudge up to avoid z-fighting

  function whenMesh(el) {
    return new Promise((res) => {
      const m = el && el.getObject3D("mesh");
      if (m) return res(m);
      el && el.addEventListener("model-loaded", () => res(el.getObject3D("mesh")), { once: true });
    });
  }
  function collectMeshes(root) {
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

    const navMesh = await whenMesh(navEl);
    const meshes = collectMeshes(navMesh);
    if (!meshes.length) return console.warn("[spawn] navmesh has no meshes");

    const box = new THREE.Box3().setFromObject(navMesh);
    const center = new THREE.Vector3();
    box.getCenter(center);
    const start = new THREE.Vector3(center.x, box.max.y + ABOVE, center.z);

    const ray = new THREE.Raycaster(start, new THREE.Vector3(0, -1, 0), 0, box.max.y - box.min.y + ABOVE * 2);
    const hits = ray.intersectObjects(meshes, true);
    if (!hits.length) return console.warn("[spawn] no hit when raycasting onto navmesh");

    const hit = hits[0].point.clone();
    hit.y += LIFT;
    rigEl.setAttribute("position", `${hit.x} ${hit.y} ${hit.z}`);

    // small fall keeps you snapped without fighting placement
    const cur = rigEl.getAttribute("navmesh-constraint") || {};
    const height = cur.height != null ? cur.height : 0.12;
    rigEl.setAttribute("navmesh-constraint", `navmesh:${NAV}; fall: 0.5; height: ${height}`);

    console.log("[spawn] rig placed on navmesh at", hit);
  }

  if (document.readyState === "complete") place();
  else window.addEventListener("load", place);
})();
