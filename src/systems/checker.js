AFRAME.registerComponent("checker-floor", {
  schema: {
    squares: { type: "int", default: 16 },
    color1: { type: "color", default: "#808080" },
    color2: { type: "color", default: "#505050" },
  },
  init() {
    const THREE = AFRAME.THREE,
      size = 512,
      s = this.data.squares;
    const c = document.createElement("canvas");
    c.width = c.height = size;
    const ctx = c.getContext("2d");
    const step = size / s;
    for (let y = 0; y < s; y++)
      for (let x = 0; x < s; x++) {
        ctx.fillStyle = (x + y) & 1 ? this.data.color1 : this.data.color2;
        ctx.fillRect(x * step, y * step, step, step);
      }
    const tex = new THREE.CanvasTexture(c);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    const obj = this.el.getObject3D("mesh");
    if (!obj) {
      this.el.addEventListener("model-loaded", () => this.apply(tex));
      return;
    }
    this.apply(tex);
  },
  apply(tex) {
    const obj = this.el.getObject3D("mesh");
    if (!obj) return;
    obj.traverse((m) => {
      if (m.isMesh) {
        m.material = new AFRAME.THREE.MeshStandardMaterial({ map: tex, color: 0xffffff, roughness: 1, metalness: 0 });
        m.material.needsUpdate = true;
      }
    });
  },
});
