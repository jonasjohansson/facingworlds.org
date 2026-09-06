// ut-movement-model.js — UT99 ground acceleration, as pure arithmetic.
//
// This is the A-Frame `ut-controls` component's step()/approach() with everything that
// was not arithmetic removed: no A-Frame component, no keyboard/touch reading, no camera
// quaternion, no Vector3. The caller resolves the heading to world xz — the controller
// does it with the rig's yaw — and hands it in.
//
// SCALE, and why these numbers are what they are: a UT99 pawn is 78 UU tall and the
// soldier model measures 1.83 m, so 1 UU ~ 0.0235 m and the Pawn defaults convert as
// GroundSpeed 400 UU/s -> 9.4 m/s, AccelRate 2048 UU/s^2 -> 48 m/s^2. AIR_CONTROL is
// deliberately NOT a converted constant (UT99 ships 0.05, UT2004 ~0.35); 0.18 was swept
// in the running scene. All four live in GAME_CONFIG.MOVEMENT with the measurements.
//
// THE ONE SUBTLETY: acceleration is toward the target VELOCITY VECTOR, not along the
// input direction. That is what makes a turn and a reversal cost speed — the delta to
// (-9.4, 0) from (+9.4, 0) is 18.8 m/s long, so the velocity is dragged down through zero
// rather than being spun around at full magnitude. Steering and braking are the same
// operation, which is exactly how UT99 feels.

/**
 * @param {object} cfg
 * @param {number} cfg.groundSpeed top ground speed, m/s (MOVEMENT.GROUND_SPEED)
 * @param {number} cfg.accel how hard the commanded velocity is chased, m/s^2
 * @param {number} cfg.decel ground deceleration once input stops, m/s^2
 * @param {number} cfg.airControl fraction of `accel` available while airborne
 */
export function createUtMovement({ groundSpeed, accel, decel, airControl }) {
  // The caller reads this object every frame and never replaces it.
  const velocity = { x: 0, z: 0 };

  /** Move `velocity` toward (tx, tz) by at most `maxStep` metres per second. */
  function approach(tx, tz, maxStep) {
    const dx = tx - velocity.x;
    const dz = tz - velocity.z;
    const distance = Math.hypot(dx, dz);
    if (distance <= maxStep || distance < 1e-6) {
      velocity.x = tx;
      velocity.z = tz;
      return;
    }
    const k = maxStep / distance;
    velocity.x += dx * k;
    velocity.z += dz * k;
  }

  return {
    velocity,

    /**
     * One frame of acceleration.
     *
     * @param {number} dirX heading in WORLD x, unit-or-zero together with dirZ
     * @param {number} dirZ heading in WORLD z
     * @param {boolean} airborne mid-hop: air control instead of accel, and no braking
     * @param {number} dt seconds
     */
    step(dirX, dirZ, airborne, dt) {
      if (dirX !== 0 || dirZ !== 0) {
        const rate = airborne ? accel * airControl : accel;
        approach(dirX * groundSpeed, dirZ * groundSpeed, rate * dt);
      } else if (!airborne) {
        approach(0, 0, decel * dt);
      }
      // Airborne with no input keeps its momentum untouched — that is the committed arc.
      return velocity;
    },

    /** Spawn, respawn, teleport: start the next step from rest. */
    reset() {
      velocity.x = 0;
      velocity.z = 0;
    },
  };
}
