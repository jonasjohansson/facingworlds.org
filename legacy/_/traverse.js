// Logs GLTF hierarchy and optionally tags meshes named with "collider"
AFRAME.registerComponent("gltf-traverser", {
  init() {
    this.el.addEventListener("model-loaded", () => {
      const root = this.el.getObject3D("mesh");
      if (!root) return;

      console.group("[GLTF Traverser] Mesh Tree");
      root.traverse((node) => {
        if (!node.isMesh) return;
        console.log("Mesh:", node.name || "(unnamed)", "| material:", node.material?.name || "(none)");
        // Example: tag meshes that include 'collider' in their name.
        if ((node.name || "").toLowerCase().includes("collider")) {
          node.userData.isCollider = true;
        }
      });
      console.groupEnd();
    });
  },
});
