// player.js

// Q/E rotate the rig (yaw)
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
    if (this.keys["KeyQ"]) d -= step;
    if (this.keys["KeyE"]) d += step;
    if (d !== 0) {
      this.yaw += d;
      this.el.setAttribute("rotation", `0 ${this.yaw} 0`);
    }
  },
});

// Space toggles 3rd <-> 1st *only when this camera is active*
AFRAME.registerComponent("camera-toggle", {
  schema: {
    third: { type: "vec3", default: { x: 0, y: 1.8, z: 3 } },
    first: { type: "vec3", default: { x: 0, y: 1.6, z: 0 } },
    lerp: { default: 0.15 },
  },
  init() {
    this.mode = "third";
    this.target = new THREE.Vector3(this.data.third.x, this.data.third.y, this.data.third.z);
    this.cam = this.el;
    this.key = (e) => {
      if (e.code !== "Space") return;
      const camActive = (this.cam.getAttribute("camera") || {}).active !== false;
      if (!camActive) return; // ignore when mapcam is active
      this.mode = this.mode === "third" ? "first" : "third";
      const v = this.mode === "third" ? this.data.third : this.data.first;
      this.target.set(v.x, v.y, v.z);
      if (this.mode === "first") this.cam.setAttribute("rotation", "0 0 0");
      console.log("[camera-toggle] mode =", this.mode);
    };
    window.addEventListener("keydown", this.key);
  },
  remove() {
    window.removeEventListener("keydown", this.key);
  },
  tick() {
    this.cam.object3D.position.lerp(this.target, this.data.lerp);
  },
});

// camera-manager: M toggles player cam <-> fixed overhead cam
AFRAME.registerComponent("camera-manager", {
  init() {
    const ensure = () => {
      this.playerCam = document.querySelector("#cam");
      this.fixedCam = document.querySelector("#fixedcam");
    };
    ensure();

    this.key = (e) => {
      if (e.code !== "KeyM") return;
      if (!this.playerCam || !this.fixedCam) ensure();

      const playerActive = (this.playerCam.getAttribute("camera") || {}).active !== false;

      if (playerActive) {
        // switch to fixed overhead cam
        this.playerCam.setAttribute("camera", "active", false);
        this.playerCam.setAttribute("look-controls", "pointerLockEnabled", false);
        this.fixedCam.setAttribute("camera", "active", true);
        console.log("[camera-manager] fixed overhead view");
      } else {
        // switch back to player cam
        this.fixedCam.setAttribute("camera", "active", false);
        this.playerCam.setAttribute("camera", "active", true);
        this.playerCam.setAttribute("look-controls", "pointerLockEnabled", true);
        console.log("[camera-manager] player view");
      }
    };

    window.addEventListener("keydown", this.key);
  },
  remove() {
    window.removeEventListener("keydown", this.key);
  },
});
