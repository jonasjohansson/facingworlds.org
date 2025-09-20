// camera-tracker.js - Simple camera tracking using Three.js lookAt
AFRAME.registerComponent("camera-tracker", {
  schema: {
    target: { type: "selector", default: "#rig" },
    enabled: { type: "boolean", default: true },
  },

  init() {
    this.target = null;
    this.setupTarget();
  },

  setupTarget() {
    this.target = this.data.target;
    if (!this.target) {
      console.warn("[camera-tracker] Target not found:", this.data.target);
    }
  },

  tick() {
    if (!this.data.enabled || !this.target) return;

    // Use world positions instead of attribute positions
    const targetWorldPos = this.target.object3D.getWorldPosition(new THREE.Vector3());
    const cameraWorldPos = this.el.object3D.getWorldPosition(new THREE.Vector3());

    // Calculate direction from camera to target
    const dx = targetWorldPos.x - cameraWorldPos.x;
    const dy = targetWorldPos.y - cameraWorldPos.y;
    const dz = targetWorldPos.z - cameraWorldPos.z;

    // Debug logging
    console.log("[camera-tracker] Camera world pos:", cameraWorldPos);
    console.log("[camera-tracker] Target world pos:", targetWorldPos);
    console.log("[camera-tracker] Direction:", { dx, dy, dz });

    // Calculate yaw rotation (horizontal) - invert to look AT the target
    const yaw = Math.atan2(-dx, -dz) * (180 / Math.PI);

    // Calculate pitch rotation (vertical) - invert to look AT the target
    const distance = Math.sqrt(dx * dx + dz * dz);
    let pitch = Math.atan2(dy, distance) * (180 / Math.PI);

    // Limit pitch to between -80 and 80 degrees to avoid extreme angles
    pitch = Math.max(-80, Math.min(80, pitch));

    console.log("[camera-tracker] Calculated rotation:", { pitch, yaw });

    // Set rotation to look at target
    this.el.setAttribute("rotation", {
      x: pitch,
      y: yaw,
      z: 0,
    });
  },
});
