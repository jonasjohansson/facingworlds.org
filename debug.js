// debug.js
AFRAME.registerComponent("debug-material", {
  schema: { color: { default: "#00ff88" }, opacity: { default: 0.6 }, wire: { default: true } },
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
      console.log("[debug-material] applied to", this.el.id || this.el);
    });
  },
});

// Press G to toggle navmesh visibility.
(function () {
  function onKey(e) {
    if (e.code !== "KeyG") return;
    const nav = document.querySelector("#navmesh");
    if (!nav) return;
    nav.setAttribute("visible", !nav.getAttribute("visible"));
  }
  window.addEventListener("keydown", onKey);
})();
