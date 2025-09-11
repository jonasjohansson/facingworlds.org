// Make the GLTF a static mesh collider (after it loads)
AFRAME.registerComponent("map-colliders", {
  init() {
    this.el.addEventListener("model-loaded", () => {
      this.el.setAttribute("static-body", "shape: mesh");
      console.log("[Physics] static-body mesh added to map");
    });
  },
});

// Attach an explicit capsule to the rig so it doesn't try FIT.ALL
function enablePlayerPhysics() {
  const rig = document.querySelector("#rig");
  if (!rig) return;

  // Remove any previous body that may have been added without shape info
  rig.removeAttribute("kinematic-body");

  // Give the rig a capsule with manual dimensions (no auto-fit)
  rig.setAttribute("kinematic-body", "shape: capsule; radius: 0.35; height: 1.6");
  console.log("[Physics] kinematic-body capsule added to rig");
}
window.addEventListener("load", () => setTimeout(enablePlayerPhysics, 0));
