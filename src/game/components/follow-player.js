// follow-player.js - Fixed spy camera that follows player around
AFRAME.registerComponent("follow-player", {
  schema: {
    enabled: { type: "boolean", default: true },
    height: { type: "number", default: 30 },
    offset: { type: "vec3", default: { x: 0, y: 0, z: 0 } },
  },

  init() {
    this.player = null;
    this.setupPlayer();
  },

  setupPlayer() {
    this.player = this.el.sceneEl.querySelector("#rig");
    if (!this.player) {
      console.warn("[follow-player] Player rig not found");
    }
  },

  tick() {
    if (!this.data.enabled || !this.player) return;

    const playerPos = this.player.getAttribute("position");
    if (playerPos) {
      // Keep camera at fixed position (don't move it)
      const cameraPos = this.el.getAttribute("position");

      // Calculate direction from camera to player
      const dx = playerPos.x - cameraPos.x;
      const dy = playerPos.y - cameraPos.y;
      const dz = playerPos.z - cameraPos.z;

      // Calculate yaw rotation (horizontal pan)
      const yaw = Math.atan2(dx, dz) * (180 / Math.PI);

      // Calculate pitch rotation (vertical tilt)
      const pitch = Math.atan2(-dy, Math.sqrt(dx * dx + dz * dz)) * (180 / Math.PI);

      // Clamp pitch to reasonable range (between -90 and 0 degrees)
      const clampedPitch = Math.max(-90, Math.min(0, pitch));

      // Set rotation to track player (security camera style)
      this.el.setAttribute("rotation", {
        x: clampedPitch, // Tilt to look at player
        y: yaw, // Pan to look at player
        z: 0, // No roll
      });
    }
  },
});
