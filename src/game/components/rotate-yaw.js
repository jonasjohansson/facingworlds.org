// rotate-yaw.js — Q/E rotate the rig (yaw)
AFRAME.registerComponent("rotate-yaw", {
  schema: { speed: { default: 120 } }, // deg/sec
  init() {
    this.keys = {};
    this.yaw = (this.el.getAttribute("rotation") || { y: 0 }).y || 0;
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
      this.yaw += d;
      this.el.setAttribute("rotation", `0 ${this.yaw} 0`);
    }
  },
});
