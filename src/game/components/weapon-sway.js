// weapon-sway.js — Adds natural weapon movement based on player movement
import { GAME_CONFIG } from "../config/game-config.js";

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
    // Speed the walk/run multipliers are measured against, m/s. Read from the rig's own
    // top speed so it tracks GAME_CONFIG.MOVEMENT.GROUND_SPEED instead of duplicating it;
    // the thresholds used to be absolute (0.1 / 0.3 m/s), which meant any movement at all
    // counted as a full sprint.
    referenceSpeed: { type: "number", default: GAME_CONFIG.MOVEMENT.GROUND_SPEED },
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

    // For fallback movement detection (when character component unavailable)
    this.velocity = { x: 0, y: 0, z: 0 };
    this.lastPosition = { x: 0, y: 0, z: 0 };

    // Get the rig and soldier to track movement
    this.rig = this.el.sceneEl.querySelector("#rig");
    this.soldier = this.el.sceneEl.querySelector("#soldier");
    if (!this.rig || !this.soldier) {
      console.warn("[weapon-sway] No rig or soldier found");
      return;
    }

    // Snapshot rig position for fallback velocity calculation
    const rigPos = this.rig.object3D.position;
    this.lastPosition = { x: rigPos.x, y: rigPos.y, z: rigPos.z };

    // Rest position is captured on the first tick rather than here: first-person-weapon
    // also writes the weapon's position during setup, and reading it at init could catch
    // the pre-setup value.
    this.hasRestPosition = false;
  },

  captureRestPosition() {
    const pos = this.el.object3D.position;
    this.originalPosition = { x: pos.x, y: pos.y, z: pos.z };
    this.hasRestPosition = true;
  },

  tick(time, deltaTime) {
    if (!this.data.enabled || !this.rig || !this.soldier) return;

    if (!this.hasRestPosition) this.captureRestPosition();

    // This used to run only on every other frame. That both stepped the weapon at 30 Hz,
    // which is visible at arena pace, and halved the sway clock, because the accumulator
    // below sat behind the early return — swaySpeed: 6.0 was really oscillating at 3.0.
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
      // Mutated in place: this runs every frame, and a fresh object literal here was a
      // per-frame allocation on the fallback path.
      this.lastPosition.x = currentPos.x;
      this.lastPosition.y = currentPos.y;
      this.lastPosition.z = currentPos.z;
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
    // Fractions of the rig's top speed rather than absolute m/s, so the weapon reads the
    // same whatever GAME_CONFIG.MOVEMENT.GROUND_SPEED is set to.
    const normalized = this.movementSpeed / Math.max(this.data.referenceSpeed, 0.001);

    if (normalized < 0.1) {
      return 0.5; // Very slow movement
    } else if (normalized < 0.55) {
      return this.data.walkMultiplier; // Walking
    } else {
      return this.data.runMultiplier; // Running
    }
  },

  applyMovement() {
    // Written straight to object3D: this runs every frame, and setAttribute would parse a
    // freshly built string and push a component update each time. first-person-weapon only
    // touches the weapon's rotation, so the position is ours alone.
    this.el.object3D.position.set(
      this.originalPosition.x + this.currentSway.x,
      this.originalPosition.y + this.currentSway.y + this.currentBob,
      this.originalPosition.z
    );
  },

  remove() {
    // Reset to original position
    if (!this.hasRestPosition) return;
    const { x, y, z } = this.originalPosition;
    this.el.object3D.position.set(x, y, z);
    this.el.setAttribute("position", `${x} ${y} ${z}`);
  },
});
