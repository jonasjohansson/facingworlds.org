// face-camera-y.js — rotate Y to face current camera yaw (with smoothing).
AFRAME.registerComponent("face-camera-y", {
  schema: { lerp: { default: 0.25 } },
  init() {
    this.cam = this.el.sceneEl.camera && this.el.sceneEl.camera.el;
  },
  tick() {
    if (!this.cam) this.cam = this.el.sceneEl.camera && this.el.sceneEl.camera.el;
    if (!this.cam) return;

    const dir = new THREE.Vector3();
    this.cam.object3D.getWorldDirection(dir);
    dir.y = 0;
    dir.normalize();

    // Desired yaw from camera forward
    const yaw = Math.atan2(dir.x, dir.z) * THREE.MathUtils.RAD2DEG;

    // Smoothly turn the character
    const cur = this.el.getAttribute("rotation") || { x: 0, y: 0, z: 0 };
    const targetY = yaw;
    const newY = THREE.MathUtils.lerpAngle(THREE.MathUtils.degToRad(cur.y), THREE.MathUtils.degToRad(targetY), this.data.lerp);
    this.el.setAttribute("rotation", `0 ${THREE.MathUtils.radToDeg(newY)} 0`);
  },
});
