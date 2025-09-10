AFRAME.registerComponent("ammo-player", {
  schema: { speed: { default: 4 } },
  init() {
    this.keys = {};
    window.addEventListener("keydown", (e) => (this.keys[e.code] = true));
    window.addEventListener("keyup", (e) => (this.keys[e.code] = false));

    this.cam = this.el.querySelector("[camera]") || this.el;
    this.up = new THREE.Vector3(0, 1, 0);
    this.fwd = new THREE.Vector3();
    this.right = new THREE.Vector3();

    this.el.addEventListener("body-loaded", () => {
      const body = this.el.body; // Ammo btRigidBody
      if (!body) return;
      // lock rotation so you don't tip over
      body.setAngularFactor(new Ammo.btVector3(0, 0, 0));
    });
  },
  tick() {
    const body = this.el.body;
    if (!body || !this.cam) return;

    // camera directions on XZ
    this.cam.object3D.getWorldDirection(this.fwd);
    this.fwd.y = 0;
    this.fwd.normalize();
    this.right.copy(this.fwd).applyAxisAngle(this.up, -Math.PI / 2);

    const dir = new THREE.Vector3();
    if (this.keys["KeyW"]) dir.add(this.fwd);
    if (this.keys["KeyS"]) dir.addScaledVector(this.fwd, -1);
    if (this.keys["KeyD"]) dir.add(this.right);
    if (this.keys["KeyA"]) dir.addScaledVector(this.right, -1);

    // keep current vertical velocity (gravity)
    const v = body.getLinearVelocity();
    const vy = v.y();

    let vx = 0,
      vz = 0;
    if (dir.lengthSq() > 0) {
      dir.normalize().multiplyScalar(this.data.speed);
      vx = dir.x;
      vz = dir.z;
    }
    body.setLinearVelocity(new Ammo.btVector3(vx, vy, vz));
    Ammo.destroy(v);
  },
});
