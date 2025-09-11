AFRAME.registerComponent("navmesh-debug", {
  schema: { color: { default: "#00ff88" }, opacity: { default: 0.5 }, wire: { default: true } },
  init() {
    this.el.addEventListener("model-loaded", () => {
      const root = this.el.getObject3D("mesh");
      if (!root) return;
      const mat = new THREE.MeshBasicMaterial({
        color: new THREE.Color(this.data.color),
        wireframe: this.data.wire,
        transparent: true,
        opacity: this.data.opacity,
        side: THREE.DoubleSide,
        depthWrite: false,
      });
      root.traverse((n) => {
        if (n.isMesh) n.material = mat;
      });
      console.log("[navmesh-debug] applied");
    });
  },
});
