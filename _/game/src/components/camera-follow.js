// camera-follow.js — Keeps camera synchronized with soldier position and rotation
AFRAME.registerComponent("camera-follow", {
  schema: {
    target: { type: "selector", default: "#soldier" },
    offset: { type: "vec3", default: "0 2.0 0" },
    followRotation: { type: "boolean", default: true },
  },

  init() {
    this.targetEl = this.data.target;
    this.offset = new THREE.Vector3().copy(this.data.offset);
  },

  tick() {
    if (!this.targetEl || !this.targetEl.object3D) return;

    // Get target world position
    const targetWorldPos = new THREE.Vector3();
    this.targetEl.object3D.getWorldPosition(targetWorldPos);

    // Set camera position to target position + offset
    this.el.object3D.position.copy(this.offset);
    this.el.object3D.position.add(targetWorldPos);

    // Follow target rotation if enabled
    if (this.data.followRotation) {
      this.el.object3D.quaternion.copy(this.targetEl.object3D.quaternion);
    }
  },
});
