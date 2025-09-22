// weapon-sway.js — Adds natural weapon movement based on player movement
AFRAME.registerComponent("weapon-sway", {
  schema: {
    enabled: { type: "boolean", default: true },
    // Sway settings
    swayIntensity: { type: "number", default: 0.02 }, // How much the weapon sways
    swaySpeed: { type: "number", default: 2.0 }, // How fast the sway animation is
    // Bob settings
    bobIntensity: { type: "number", default: 0.01 }, // How much the weapon bobs up and down
    bobSpeed: { type: "number", default: 3.0 }, // How fast the bob animation is
    // Movement multipliers
    walkMultiplier: { type: "number", default: 1.0 }, // Multiplier for walking
    runMultiplier: { type: "number", default: 1.5 }, // Multiplier for running
    // Smoothing
    smoothing: { type: "number", default: 0.1 }, // How smooth the movement is (lower = smoother)
  },

  init() {
    this.originalPosition = { x: 0, y: 0, z: 0 };
    this.currentSway = { x: 0, y: 0 };
    this.currentBob = 0;
    this.time = 0;
    this.isMoving = false;
    this.movementSpeed = 0;

    // Get the rig and soldier to track movement
    this.rig = this.el.sceneEl.querySelector("#rig");
    this.soldier = this.el.sceneEl.querySelector("#soldier");
    if (!this.rig || !this.soldier) {
      console.warn("[weapon-sway] No rig or soldier found");
      return;
    }

    // Store original position
    const pos = this.el.getAttribute("position");
    if (pos) {
      this.originalPosition = { x: pos.x, y: pos.y, z: pos.z };
    }
  },

  tick(time, deltaTime) {
    if (!this.data.enabled || !this.rig || !this.soldier) return;

    this.time += deltaTime / 1000; // Convert to seconds

    // Get movement data from character component
    const characterComponent = this.soldier.components.character;
    if (characterComponent) {
      this.isMoving = characterComponent.isMoving || false;
      this.movementSpeed = characterComponent.speedMps || 0;
    } else {
      // Fallback to manual calculation
      const currentPos = this.rig.object3D.position;
      this.velocity.x = currentPos.x - this.lastPosition.x;
      this.velocity.y = currentPos.y - this.lastPosition.y;
      this.velocity.z = currentPos.z - this.lastPosition.z;
      this.movementSpeed = Math.sqrt(this.velocity.x * this.velocity.x + this.velocity.z * this.velocity.z);
      this.isMoving = this.movementSpeed > 0.0001;
      this.lastPosition = { x: currentPos.x, y: currentPos.y, z: currentPos.z };
    }

    // Debug logging occasionally
    if (Math.random() < 0.01) {
      console.log("[weapon-sway] Movement speed:", this.movementSpeed, "Is moving:", this.isMoving);
      console.log("[weapon-sway] Current sway:", this.currentSway, "Current bob:", this.currentBob);
    }

    // Calculate sway and bob based on movement
    this.calculateSway();
    this.calculateBob();

    // Apply the movement to the weapon
    this.applyMovement();
  },

  calculateSway() {
    if (!this.isMoving) {
      // Return to center when not moving - no sway at all
      this.currentSway.x *= 0.9;
      this.currentSway.y *= 0.9;
      return;
    }

    // Calculate sway based on movement direction and speed
    const swayAmount = this.movementSpeed * this.data.swayIntensity;
    const speedMultiplier = this.getSpeedMultiplier();

    // Horizontal sway (left/right)
    const targetSwayX = Math.sin(this.time * this.data.swaySpeed) * swayAmount * speedMultiplier;
    // Vertical sway (up/down)
    const targetSwayY = Math.cos(this.time * this.data.swaySpeed * 0.7) * swayAmount * speedMultiplier * 0.5;

    // Smooth interpolation
    this.currentSway.x += (targetSwayX - this.currentSway.x) * this.data.smoothing;
    this.currentSway.y += (targetSwayY - this.currentSway.y) * this.data.smoothing;
  },

  calculateBob() {
    if (!this.isMoving) {
      // Return to center when not moving
      this.currentBob *= 0.9;
      return;
    }

    // Calculate bob based on movement speed
    const bobAmount = Math.max(this.movementSpeed * this.data.bobIntensity, 0.01); // Minimum bob when moving
    const speedMultiplier = this.getSpeedMultiplier();

    // Vertical bob (up/down movement)
    const targetBob = Math.sin(this.time * this.data.bobSpeed) * bobAmount * speedMultiplier;

    // Smooth interpolation
    this.currentBob += (targetBob - this.currentBob) * this.data.smoothing;
  },

  getSpeedMultiplier() {
    // Determine if player is running or walking based on movement speed
    // This is a simple heuristic - you might want to adjust these values
    const walkThreshold = 0.1;
    const runThreshold = 0.3;

    if (this.movementSpeed < walkThreshold) {
      return 0.5; // Very slow movement
    } else if (this.movementSpeed < runThreshold) {
      return this.data.walkMultiplier; // Walking
    } else {
      return this.data.runMultiplier; // Running
    }
  },

  applyMovement() {
    // Apply sway and bob to weapon position
    const newPosition = {
      x: this.originalPosition.x + this.currentSway.x,
      y: this.originalPosition.y + this.currentSway.y + this.currentBob,
      z: this.originalPosition.z,
    };

    this.el.setAttribute("position", `${newPosition.x} ${newPosition.y} ${newPosition.z}`);
  },

  remove() {
    // Reset to original position
    this.el.setAttribute("position", `${this.originalPosition.x} ${this.originalPosition.y} ${this.originalPosition.z}`);
  },
});
