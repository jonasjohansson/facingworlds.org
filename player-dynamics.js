AFRAME.registerComponent("player-dynamics", {
  schema: { speed: { default: 4 } }, // m/s
  init() {
    this.keys = {};
    window.addEventListener("keydown", (e) => (this.keys[e.code] = true));
    window.addEventListener("keyup", (e) => (this.keys[e.code] = false));
    this.cam = this.el.querySelector("[camera]") || this.el;
    this.tmpF = new THREE.Vector3();
    this.tmpR = new THREE.Vector3();
    this.up = new THREE.Vector3(0, 1, 0);
  },
  tick() {
    const body = this.el.body; // Cannon body from dynamic-body
    if (!body || !this.cam) return;

    // Get camera facing (XZ only)
    this.cam.object3D.getWorldDirection(this.tmpF);
    this.tmpF.y = 0;
    this.tmpF.normalize();
    this.tmpR.copy(this.tmpF).applyAxisAngle(this.up, -Math.PI / 2); // right

    // Build desired direction from keys
    const dir = new THREE.Vector3();
    if (this.keys["KeyW"]) dir.add(this.tmpF);
    if (this.keys["KeyS"]) dir.addScaledVector(this.tmpF, -1);
    if (this.keys["KeyD"]) dir.add(this.tmpR);
    if (this.keys["KeyA"]) dir.addScaledVector(this.tmpR, -1);

    // Current vertical velocity (keep gravity)
    const vy = body.velocity.y;

    if (dir.lengthSq() > 0) {
      dir.normalize().multiplyScalar(this.data.speed);
      body.velocity.x = dir.x;
      body.velocity.z = dir.z;
    } else {
      // Stop horizontal drift
      body.velocity.x = 0;
      body.velocity.z = 0;
    }

    // Preserve vertical velocity
    body.velocity.y = vy;
  },
});
