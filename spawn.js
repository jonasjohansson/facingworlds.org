function ensureRig() {
  const scene = document.querySelector("a-scene");
  if (!scene) return null;

  let rig = scene.querySelector("#rig");
  if (!rig) {
    rig = document.createElement("a-entity");
    rig.id = "rig";
    rig.setAttribute("movement-controls", "speed: 3");
    rig.setAttribute("look-controls", "");

    const cam = document.createElement("a-entity");
    cam.setAttribute("camera", "");
    cam.setAttribute("position", "0 1.6 0");
    rig.appendChild(cam);

    scene.appendChild(rig);
  }
  return rig;
}

// Spawn rig above the map once the model is ready, so you’re not stuck inside it.
function placeRigAboveMap() {
  const rig = ensureRig();
  const map = document.querySelector("#mapRoot");
  if (!rig || !map) return;

  const root = map.getObject3D("mesh");
  if (!root) return;

  const box = new THREE.Box3().setFromObject(root);
  const spawn = { x: 0, y: box.max.y + 1.8, z: 0 }; // 1.8m above highest point
  rig.setAttribute("position", `${spawn.x} ${spawn.y} ${spawn.z}`);
  rig.setAttribute("position", `0 ${box.max.y + 2.0} 0`);
  console.log("[Spawn] Rig placed at", spawn);
}

window.addEventListener("load", () => {
  ensureRig();
  const map = document.querySelector("#mapRoot");
  if (map) {
    map.addEventListener("model-loaded", () => setTimeout(placeRigAboveMap, 0));
  } else {
    // Fallback spawn if mapRoot id differs
    const rig = ensureRig();
    if (rig) rig.setAttribute("position", "0 2 0");
  }
});
