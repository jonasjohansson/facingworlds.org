(function () {
  function whenModelReady(el, cb) {
    if (!el) return;
    const mesh = el.getObject3D("mesh");
    if (mesh) {
      cb();
      return;
    }
    el.addEventListener("model-loaded", () => cb(), { once: true });
  }

  function spawnCharacterOnTop() {
    const model = document.getElementById("model"); // your main environment
    const nav = document.querySelector(".navmesh"); // your navmesh entity
    const char = document.getElementById("character"); // your character

    if (!model || !nav || !char) {
      console.warn("[SpawnOnTop] Missing #model, .navmesh, or #character.");
      return;
    }

    // Wait for both meshes to be present (important for bbox + navmesh constraint)
    whenModelReady(model, () => {
      whenModelReady(nav, () => {
        const mesh = model.getObject3D("mesh");
        if (!mesh) return;

        // Compute bounding box of the environment
        const box = new THREE.Box3().setFromObject(mesh);
        const center = new THREE.Vector3();
        box.getCenter(center);

        // Spawn position: above the highest point
        const dropOffset = 2.0; // meters above top
        const spawnPos = { x: center.x, y: box.max.y + dropOffset, z: center.z };

        char.setAttribute("position", `${spawnPos.x} ${spawnPos.y} ${spawnPos.z}`);

        // Ensure fall distance is large enough to snap from height
        // Preserve existing height setting if present
        const current = char.getAttribute("navmesh-constraint") || {};
        const height = current.height != null ? current.height : 0;
        char.setAttribute("navmesh-constraint", `navmesh:.navmesh; fall: 200; height: ${height};`);

        console.log("[SpawnOnTop] Character spawned at", spawnPos, "and will drop to navmesh.");
      });
    });
  }

  if (document.readyState === "complete") spawnCharacterOnTop();
  else window.addEventListener("load", spawnCharacterOnTop);
})();
