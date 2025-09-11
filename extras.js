// Smooth camera follow that stays behind the target
AFRAME.registerComponent("cam-follow", {
  schema: {
    target: { type: "selector" },
    distance: { type: "number", default: 6 },
    height: { type: "number", default: 1.8 },
    lerp: { type: "number", default: 0.08 },
  },
  init() {
    this._v = new AFRAME.THREE.Vector3();
  },
  tick() {
    if (!this.data.target) return;
    const tgt = this.data.target.object3D;
    if (!tgt) return;
    const cam = this.el.object3D;

    // desired position = behind the target, along its forward (-Z)
    const forward = new AFRAME.THREE.Vector3(0, 0, -1).applyQuaternion(tgt.quaternion);
    const desired = this._v.copy(tgt.position).addScaledVector(forward, -this.data.distance);
    desired.y = tgt.position.y + this.data.height;

    cam.position.lerp(desired, this.data.lerp);
    cam.lookAt(tgt.position.x, tgt.position.y + this.data.height * 0.3, tgt.position.z);
  },
});

// Procedural checkered floor using a CanvasTexture
AFRAME.registerComponent("checker-floor", {
  schema: {
    squares: { type: "int", default: 16 },
    color1: { type: "color", default: "#808080" },
    color2: { type: "color", default: "#505050" },
    normal: { type: "boolean", default: false }, // set true if you plan to add a normal later
  },
  init() {
    const THREE = AFRAME.THREE;
    const size = 512,
      s = this.data.squares;
    const c = document.createElement("canvas");
    c.width = c.height = size;
    const ctx = c.getContext("2d");

    // draw checker
    const step = size / s;
    for (let y = 0; y < s; y++) {
      for (let x = 0; x < s; x++) {
        ctx.fillStyle = (x + y) & 1 ? this.data.color1 : this.data.color2;
        ctx.fillRect(x * step, y * step, step, step);
      }
    }

    const tex = new THREE.CanvasTexture(c);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    // Repeat so each square is ~1 unit on a 200x200 plane (tweak as you like)
    tex.repeat.set(1, 1);

    this.el.addEventListener("model-loaded", () => this.apply(tex));
    // if already has mesh:
    this.apply(tex);
  },
  apply(tex) {
    const obj = this.el.getObject3D("mesh");
    if (!obj) return;
    obj.traverse((m) => {
      if (m.isMesh) {
        m.material = new AFRAME.THREE.MeshStandardMaterial({
          map: tex,
          color: 0xffffff,
          metalness: 0,
          roughness: 1,
        });
        m.material.needsUpdate = true;
      }
    });
  },
});
