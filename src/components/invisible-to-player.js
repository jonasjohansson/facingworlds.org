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
    console.log(`[invisible-to-player] Character ${characterId} is local player: ${isLocalPlayer}`);
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

      if (isFirstPerson) {
        console.log("[invisible-to-player] Hidden character in first-person mode");
      } else {
        console.log("[invisible-to-player] Shown character in bird's eye mode");
      }
    } else {
      // Keep visible to other players
      this.setMaterialOpacity(1);
    }
  },

  setMaterialOpacity(opacity) {
    // Target the soldier entity directly by ID
    const soldier = this.el.sceneEl.querySelector("#soldier");
    if (soldier && soldier.object3D) {
      console.log(`[invisible-to-player] Setting soldier materials to opacity: ${opacity}`);

      // First, ensure weapon is always visible
      const weapon = soldier.querySelector("#player-weapon");
      if (weapon && weapon.object3D) {
        weapon.object3D.traverse((child) => {
          if (child.isMesh && child.material) {
            child.material.opacity = 1;
            child.material.transparent = false;
            console.log("[invisible-to-player] Ensured weapon is visible");
          }
        });
      }

      // Then hide soldier materials (excluding weapon)
      soldier.object3D.traverse((child) => {
        if (child.isMesh && child.material) {
          // Check if this mesh belongs to the weapon by looking up the hierarchy
          let parent = child.parent;
          let isWeapon = false;
          while (parent) {
            if (parent.userData && parent.userData.entity && parent.userData.entity.id === "player-weapon") {
              isWeapon = true;
              break;
            }
            parent = parent.parent;
          }

          if (!isWeapon) {
            child.material.opacity = opacity;
            child.material.transparent = opacity < 1;
            console.log(`[invisible-to-player] Set soldier mesh opacity to ${opacity}`);
          }
        }
      });
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
