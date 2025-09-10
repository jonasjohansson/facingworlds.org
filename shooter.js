AFRAME.registerComponent("bullet", {
  schema: {
    velocity: { type: "vec3" },
    ttl: { type: "number", default: 3000 },
  },
  init() {
    this.startTime = 0;
  },
  play() {
    this.startTime = performance.now();
  },
  tick(time, dt) {
    const o = this.el.object3D,
      v = this.data.velocity,
      dtSec = dt / 1000;
    o.position.x += v.x * dtSec;
    o.position.y += v.y * dtSec;
    o.position.z += v.z * dtSec;
    if (time - this.startTime > this.data.ttl) this.el.remove();
  },
});

AFRAME.registerComponent("shooter", {
  schema: { speed: { default: 6 } },
  init() {
    this.keydown = (e) => {
      if (e.code === "Space") this.shoot();
    };
    window.addEventListener("keydown", this.keydown);
  },
  remove() {
    window.removeEventListener("keydown", this.keydown);
  },
  shoot() {
    const cam = this.el.querySelector("[camera]");
    if (!cam) return;
    const dir = new THREE.Vector3(),
      pos = new THREE.Vector3();
    cam.object3D.getWorldDirection(dir);
    cam.object3D.getWorldPosition(pos);
    pos.add(dir.clone().multiplyScalar(1.5));

    const bullet = document.createElement("a-sphere");
    bullet.setAttribute("radius", 0.35);
    bullet.setAttribute("material", "shader: flat; color: red");
    bullet.setAttribute("position", `${pos.x} ${pos.y} ${pos.z}`);

    const vel = dir.multiplyScalar(this.data.speed);
    bullet.setAttribute("bullet", { velocity: { x: vel.x, y: vel.y, z: vel.z }, ttl: 3000 });
    this.el.sceneEl.appendChild(bullet);
  },
});
