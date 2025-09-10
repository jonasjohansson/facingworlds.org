AFRAME.registerComponent("stick-to-navmesh", {
  schema: {
    navmesh: { type: "selector" }, // e.g. #navmesh
    height: { default: 0.12 }, // lift above surface
    fallMax: { default: 8 }, // max downward snap per frame (m)
    stepMax: { default: 0.35 }, // max horizontal step per frame (m)
  },
  init() {
    this.prev = new THREE.Vector3();
    this.tmp = new THREE.Vector3();
    this.down = new THREE.Vector3(0, -1, 0);
    this.ray = new THREE.Raycaster();
    this.meshes = [];
    this.ready = false;

    const navEl = this.data.navmesh;
    if (!navEl) return;
    const ensure = () => {
      const root = navEl.getObject3D("mesh");
      if (!root) return;
      root.traverse((n) => {
        if (n.isMesh) this.meshes.push(n);
      });
      this.ready = this.meshes.length > 0;
      this.prev.copy(this.el.object3D.position);
    };
    navEl.getObject3D("mesh") ? ensure() : navEl.addEventListener("model-loaded", ensure, { once: true });
  },
  tick(_, dt) {
    if (!this.ready) return;
    const pos = this.el.object3D.position;
    const dtSec = Math.max(0.001, dt / 1000);

    // 1) Clamp horizontal step size
    this.tmp.copy(pos).sub(this.prev);
    this.tmp.y = 0;
    const maxStep = this.data.stepMax; // fixed; you can also use speed*dtSec*1.2
    const len = this.tmp.length();
    if (len > maxStep) {
      this.tmp.multiplyScalar(maxStep / len);
      pos.set(this.prev.x + this.tmp.x, pos.y, this.prev.z + this.tmp.z);
    }

    // 2) Raycast straight down from a bit above current pos
    const start = new THREE.Vector3(pos.x, pos.y + 1.0, pos.z);
    this.ray.set(start, this.down);
    this.ray.far = 1.0 + this.data.fallMax;

    const hits = this.ray.intersectObjects(this.meshes, true);
    if (hits.length) {
      const y = hits[0].point.y + this.data.height;
      pos.y = y;
      this.prev.set(pos.x, pos.y, pos.z);
    } else {
      // No ground found within fallMax — gently revert horizontal move
      pos.set(this.prev.x, pos.y, this.prev.z);
    }
  },
});
