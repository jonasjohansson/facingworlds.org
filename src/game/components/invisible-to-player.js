// invisible-to-player.js — Makes entity invisible to the local player
AFRAME.registerComponent("invisible-to-player", {
  schema: {
    enabled: { type: "boolean", default: true },
  },

  init() {
    this.originalVisibility = true;
    this.isLocalPlayer = false;

    // Check if this is the local player's character
    this.checkIfLocalPlayer();

    // Listen for model loaded event
    this.el.addEventListener("model-loaded", () => {
      this.updateVisibility();
    });
  },

  checkIfLocalPlayer() {
    // Check if this character belongs to the local player
    // This assumes the local player's character has a specific ID or component
    const characterId = this.el.getAttribute("id");
    const isLocalPlayer = characterId === "local-character" || characterId === "player" || this.el.hasAttribute("local-player");

    this.isLocalPlayer = isLocalPlayer;
  },

  updateVisibility() {
    if (!this.data.enabled) return;

    if (this.isLocalPlayer) {
      // Check if we're in first-person mode (camera is active)
      const camera = this.el.sceneEl.querySelector("#cam");
      const isFirstPerson = camera && camera.getAttribute("camera").active;

      // Simply set opacity based on camera mode
      const opacity = isFirstPerson ? 0 : 1;
      this.setMaterialOpacity(opacity);
    } else {
      // Keep visible to other players
      this.setMaterialOpacity(1);
    }
  },

  setMaterialOpacity(opacity) {
    // Only affect the soldier's own meshes, not child entities
    if (this.el.id === "soldier" && this.el.object3D) {
      // Get the soldier's GLTF model directly
      const soldierModel = this.el.getObject3D("mesh");
      if (soldierModel) {
        soldierModel.traverse((child) => {
          if (child.isMesh && child.material) {
            child.material.opacity = opacity;
            child.material.transparent = opacity < 1;
          }
        });
      }
    }
  },

  tick() {
    // Continuously check camera mode for visibility updates
    this.updateVisibility();
  },

  update() {
    this.updateVisibility();
  },
});
