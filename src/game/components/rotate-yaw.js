// rotate-yaw.js — Q/E rotate the rig (yaw)
AFRAME.registerComponent("rotate-yaw", {
  schema: { speed: { default: 120 } }, // deg/sec
  init() {
    this.keys = {};
    this._down = (e) => {
      this.keys[e.code] = true;
    };
    this._up = (e) => {
      this.keys[e.code] = false;
    };
    window.addEventListener("keydown", this._down);
    window.addEventListener("keyup", this._up);
  },
  remove() {
    window.removeEventListener("keydown", this._down);
    window.removeEventListener("keyup", this._up);
  },
  tick(t, dt) {
    if (!dt) return;
    let d = 0;
    const step = this.data.speed * (dt / 1000);
    if (this.keys["KeyQ"]) d += step;
    if (this.keys["KeyE"]) d -= step;
    if (d !== 0) {
      // Read the live rotation rather than a value cached at init: the rig is moved
      // by other code between presses (network.js applyLocalSpawn writes
      // rig.object3D.rotation.y on spawn and respawn), and a cached yaw would snap
      // the rig back to wherever it was pointing when this component started.
      const yaw = (this.el.getAttribute("rotation") || { y: 0 }).y || 0;
      this.el.setAttribute("rotation", `0 ${yaw + d} 0`);
    }
  },
});
