// controls.js — rotate with Q/E, move with WASD (slow), camera toggles 3rd<->1st using look-controls.

AFRAME.registerComponent("character-controller", {
  schema: {
    speed: { default: 0.9 }, // m/s (tune)
    rotateSpeed: { default: 120 }, // deg/s (Q/E)
  },
  init() {
    this.keys = {};
    const r = this.el.getAttribute("rotation") || { y: 0 };
    this.yaw = r.y || 0;
    this.fw = new THREE.Vector3();
    this.rt = new THREE.Vector3();
    this._down = (e) => (this.keys[e.code] = true);
    this._up = (e) => (this.keys[e.code] = false);
    window.addEventListener("keydown", this._down);
    window.addEventListener("keyup", this._up);
  },
  remove() {
    window.removeEventListener("keydown", this._down);
    window.removeEventListener("keyup", this._up);
  },
  tick(time, dt) {
    if (!dt) return;
    const dts = dt / 1000;

    // Rotate avatar with Q/E
    let yawDelta = 0;
    if (this.keys["KeyQ"]) yawDelta -= this.data.rotateSpeed * dts;
    if (this.keys["KeyE"]) yawDelta += this.data.rotateSpeed * dts;
    if (yawDelta) {
      this.yaw += yawDelta;
      this.el.setAttribute("rotation", `0 ${this.yaw} 0`);
    }

    // Move relative to facing
    const yawRad = THREE.MathUtils.degToRad(this.yaw);
    this.fw.set(Math.sin(yawRad), 0, Math.cos(yawRad)); // forward
    this.rt.set(Math.cos(yawRad), 0, -Math.sin(yawRad)); // right

    const move = new THREE.Vector3();
    if (this.keys["KeyW"]) move.add(this.fw);
    if (this.keys["KeyS"]) move.addScaledVector(this.fw, -1);
    if (this.keys["KeyA"]) move.addScaledVector(this.rt, -1);
    if (this.keys["KeyD"]) move.add(this.rt);

    if (move.lengthSq() > 0) {
      move.normalize().multiplyScalar(this.data.speed * dts);
      const p = this.el.object3D.position;
      p.add(move); // navmesh-constraint will snap down each frame
    }
  },
});

// Camera toggle: just repositions the *built-in* camera (look-controls stays on).
AFRAME.registerComponent("camera-toggle", {
  schema: {
    third: { type: "vec3", default: { x: 0, y: 1.8, z: 3 } },
    first: { type: "vec3", default: { x: 0, y: 1.6, z: 0 } },
    lerp: { default: 0.15 },
  },
  init() {
    this.mode = "third";
    this.target = new THREE.Vector3(this.data.third.x, this.data.third.y, this.data.third.z);
    this.cam = this.el; // camera entity itself
    this.key = (e) => {
      if (e.code !== "Space") return;
      this.mode = this.mode === "third" ? "first" : "third";
      const v = this.mode === "third" ? this.data.third : this.data.first;
      this.target.set(v.x, v.y, v.z);
      // When entering first person, zero local rotation so it feels natural.
      if (this.mode === "first") this.cam.setAttribute("rotation", "0 0 0");
      console.log("[camera-toggle] mode =", this.mode);
    };
    window.addEventListener("keydown", this.key);
  },
  remove() {
    window.removeEventListener("keydown", this.key);
  },
  tick() {
    // Smoothly move camera in *local* space of rig.
    this.cam.object3D.position.lerp(this.target, this.data.lerp);
  },
});
