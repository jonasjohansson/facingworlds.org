// weapon-sway.js — natural weapon movement based on player movement.
//
// Port of the A-Frame weapon-sway component. Two things changed and nothing else did:
//
//   the movement source  was `#soldier`'s `character` component, with a rig-position-delta
//                        FALLBACK for when that component was not there. player/controller.js
//                        publishes `isMoving` and `speedMps` itself now — it is the same
//                        measurement, moved there in the port — and it is always there
//                        (the player is registered before this), so the fallback branch and
//                        its lastPosition bookkeeping are gone.
//   the rest position    was captured on the first tick, because A-Frame's init() could run
//                        before first-person-weapon had placed the entity. There is no
//                        deferred init any more: the class is CONSTRUCTED with its rest, so
//                        the `hasRestPosition` deferral, the `_pendingRest` branch and their
//                        comments are deleted. setRest(x, y, z) stays — it is what the
//                        constructor uses, and what moves the rest afterwards.
//
// It writes ONE node's position — the held node under the player's gunRoot, which every
// weapon slot hangs off. first-person-weapon.js owns each slot's own position, rotation and
// scale (they carry each weapon's PlayerViewOffset), so a dual pair sways as one piece
// exactly as two slots with identical sway settings did: the same delta on the same clock.
import { GAME_CONFIG } from "../config/game-config.js";

// The A-Frame schema's defaults, verbatim. index.html's #player-weapon overrode most of
// them; those values live at the registration site (core/main.js), the way every
// other markup value does.
const DEFAULTS = {
  enabled: true,
  // Sway settings
  swayIntensity: 0.02, // How much the weapon sways
  swaySpeed: 2.0, // How fast the sway animation is
  // Bob settings
  bobIntensity: 0.01, // How much the weapon bobs up and down
  bobSpeed: 3.0, // How fast the bob animation is
  // Movement multipliers
  walkMultiplier: 1.0, // Multiplier for walking
  runMultiplier: 1.5, // Multiplier for running
  // Speed the walk/run multipliers are measured against, m/s. Read from the rig's own
  // top speed so it tracks GAME_CONFIG.MOVEMENT.GROUND_SPEED instead of duplicating it;
  // the thresholds used to be absolute (0.1 / 0.3 m/s), which meant any movement at all
  // counted as a full sprint.
  referenceSpeed: GAME_CONFIG.MOVEMENT.GROUND_SPEED,
  // Smoothing
  smoothing: 0.1, // How smooth the movement is (lower = smoother)
};

export class WeaponSway {
  /**
   * @param {object} game the engine handle; reads game.player.isMoving / .speedMps
   * @param {THREE.Object3D} node the held node whose position this owns
   * @param {object} [opts] see DEFAULTS, plus {rest: {x, y, z}} — where the node sits when
   *   nothing is moving. Defaults to the node's current position.
   */
  constructor(game, node, opts = {}) {
    this.game = game;
    this.node = node;
    this.data = { ...DEFAULTS, ...opts };

    this.currentSway = { x: 0, y: 0 };
    this.currentBob = 0;
    this.time = 0;
    this.isMoving = false;
    this.movementSpeed = 0;

    const rest = opts.rest || node.position;
    this.originalPosition = { x: 0, y: 0, z: 0 };
    this.setRest(rest.x, rest.y, rest.z);
  }

  /**
   * Tell the sway where the weapon now rests.
   *
   * This exists because the rest position is not a constant: the held node is where the
   * whole hand sits, and anything that moves the hand — not the weapon, which carries its
   * own PlayerViewOffset on its slot — moves this. Without it the sway would keep
   * oscillating around whatever position it was built with.
   *
   * @param {number} x @param {number} y @param {number} z the new rest, in the node's own
   *   parent space.
   */
  setRest(x, y, z) {
    this.originalPosition.x = x;
    this.originalPosition.y = y;
    this.originalPosition.z = z;
    // Land on it now rather than on the next frame, so a caller that reads the node's
    // world matrix in the same frame (the muzzle projection does) sees the new place.
    this.applyMovement();
  }

  update(dt) {
    if (!this.data.enabled) return;

    // This used to run only on every other frame. That both stepped the weapon at 30 Hz,
    // which is visible at arena pace, and halved the sway clock, because the accumulator
    // below sat behind the early return — swaySpeed: 6.0 was really oscillating at 3.0.
    this.time += dt;

    const player = this.game.player;
    this.isMoving = !!(player && player.isMoving);
    this.movementSpeed = (player && player.speedMps) || 0;

    // Calculate sway and bob based on movement
    this.calculateSway();
    this.calculateBob();

    // Apply the movement to the weapon
    this.applyMovement();
  }

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
  }

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
  }

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
  }

  applyMovement() {
    // Nothing else writes this node's position — first-person-weapon owns the SLOTS under
    // it, and hands us a new rest through setRest() rather than writing position behind
    // our back.
    this.node.position.set(
      this.originalPosition.x + this.currentSway.x,
      this.originalPosition.y + this.currentSway.y + this.currentBob,
      this.originalPosition.z
    );
  }

  dispose() {
    // Back to the rest position, so whatever hangs off the node is not left mid-sway.
    const { x, y, z } = this.originalPosition;
    this.node.position.set(x, y, z);
  }
}
