// character.js — Animation-only follower for a navmesh-driven rig.
// Put movement-controls (with constrainToNavMesh) on the parent rig.
// The character entity stays at (0,0,0) under the rig and only animates & faces motion.
import { GAME_CONFIG } from "../config/game-config.js";
import { createVector3, createQuaternion, createClock } from "../utils/three-helpers.js";
import { setupAnimationMixer, blendAnimations, normalizeWeights, updateTimeScale } from "../utils/animation-helpers.js";

// Blend references derived from the rig's actual top speed rather than repeated as
// literals. The comments used to claim these matched GAME_CONFIG.MOVEMENT while the
// numbers were hardcoded, so raising GROUND_SPEED would have silently left the run blend
// pinned on again.
const RUN_SPEED = GAME_CONFIG.MOVEMENT.GROUND_SPEED;
const WALK_SPEED = RUN_SPEED * 0.5;
const RUN_THRESHOLD = RUN_SPEED * 0.53; // where the run blend takes over

AFRAME.registerComponent("character", {
  schema: {
    // GLTF animation clip indices
    idleIdx: { type: "int", default: 0 },
    walkIdx: { type: "int", default: 3 },
    runIdx: { type: "int", default: 1 },

    // Reference speeds (used for cadence + run threshold). Read from GAME_CONFIG.MOVEMENT
    // above; the old 1.6 / 3.2 pair was written for a much slower rig and left the run
    // blend pinned at 1.0 with the cadence clamped out.
    walkSpeed: { type: "number", default: WALK_SPEED }, // m/s
    runSpeed: { type: "number", default: RUN_SPEED }, // m/s

    // Animation cadence tuning. runCycleMps is deliberately below runSpeed: the run clip
    // is not authored for a 9.4 m/s stride, so at full pace it plays about 1.55x to keep
    // the feet roughly with the ground instead of skating.
    walkCycleMps: { type: "number", default: 3.2 },
    runCycleMps: { type: "number", default: 6.0 },
    minTimeScale: { type: "number", default: 0.6 },
    maxTimeScale: { type: "number", default: 1.7 },

    // Facing trim (rarely needed)
    yawOffsetDeg: { type: "number", default: 0 },

    // Blend responsiveness (per-second; higher = snappier)
    fadeLerp: { type: "number", default: 10.0 },

    // Speed smoothing (per-second)
    smoothSpeedLerp: { type: "number", default: 8.0 },

    // Thresholds. At arena pace 0.05 m/s is inside the noise floor of a single frame's
    // position delta, so the walk blend used to flicker on while standing still.
    moveThreshold: { type: "number", default: 0.2 }, // start walking above this
    runThreshold: { type: "number", default: RUN_THRESHOLD }, // switch to run above this
  },

  _updateCadence() {
    const { minTimeScale, maxTimeScale, walkCycleMps, runCycleMps } = this.data;
    const wantsRun = this.target.Run > this.target.Walk;
    const ref = wantsRun ? runCycleMps : walkCycleMps;
    updateTimeScale(this.actions, this.speedMps, ref, minTimeScale, maxTimeScale);
  },

  init() {
    const T = (this.THREE = AFRAME.THREE);

    // parent rig must have movement-controls
    this.rig = this.el.closest("[movement-controls]");
    if (!this.rig) {
      console.warn("[character] No parent rig with movement-controls found. Component will idle.");
    }

    // Keep the character glued under the rig
    this.el.object3D.position.set(0, 0, 0);

    // Anim state
    this.mixer = null;
    this.actions = { Idle: null, Walk: null, Run: null };
    this.weights = { Idle: 1, Walk: 0, Run: 0 };
    this.target = { Idle: 1, Walk: 0, Run: 0 };

    // Timing & math
    this.clock = createClock();
    this.up = createVector3(0, 1, 0);
    this.targetQuat = createQuaternion();

    // Speed calc (world space)
    this.prev = createVector3();
    this.curr = createVector3();
    this.speedMps = 0;
    this.rawSpeed = 0;

    // Movement direction for facing
    this.velocity = createVector3();
    this.targetQuat = createQuaternion();
    this.currentQuat = createQuaternion();

    // Facing trim to world -Z
    this.facingFix = 0;

    // Movement state
    this.isMoving = false;
    this.isRunning = false;

    // NOTE: there used to be a listener for a "movement" event here. movement-controls
    // emits "moved", so it never fired once. tick() derives speed from the rig's world
    // position anyway, which stays correct when input stops, so the listener is gone
    // rather than renamed.

    // Setup once model is ready
    this.el.addEventListener("model-loaded", (e) => {
      const mesh = this.el.getObject3D("mesh") || e.detail.model;
      if (!mesh) return;

      // cast/receive shadows
      mesh.traverse((o) => {
        if (o.isMesh) {
          o.castShadow = true;
          o.receiveShadow = true;
        }
      });

      // facing fix (optional)
      const qWorld = createQuaternion();
      this.el.object3D.getWorldQuaternion(qWorld);
      const fwd = createVector3(0, 0, -1).applyQuaternion(qWorld);
      const autoAngle = -Math.atan2(fwd.x, fwd.z);
      const manualTrim = (this.data.yawOffsetDeg * Math.PI) / 180;
      this.facingFix = autoAngle + manualTrim;

      // animations
      const clips = mesh.animations || [];
      const get = (i) => clips[i] || null;
      const idle = get(this.data.idleIdx),
        walk = get(this.data.walkIdx),
        run = get(this.data.runIdx);
      if (!idle || !walk || !run) {
        console.warn(
          "[character] Missing clips. Found:",
          clips.map((c) => c && c.name)
        );
        return;
      }

      const { mixer, actions } = setupAnimationMixer(mesh, [idle, walk, run]);
      this.mixer = mixer;
      this.actions.Idle = actions[idle.name] || actions.clip_0;
      this.actions.Walk = actions[walk.name] || actions.clip_1;
      this.actions.Run = actions[run.name] || actions.clip_2;

      // seed previous rig position
      if (this.rig) this.rig.object3D.getWorldPosition(this.prev);
    });
  },

  tick() {
    if (!this.mixer || !this.rig) return;

    let dt = this.clock.getDelta();
    if (!isFinite(dt) || dt <= 0) return;
    dt = Math.min(dt, 1 / 20); // cap 50ms

    // Keep character glued to the rig's origin horizontally. The Y is deliberately left
    // alone: ut-jump raises the rig's children to fake the hop (the rig itself has to stay
    // on the navmesh, see ut-movement.js), and pinning y here every frame would flatten it.
    this.el.object3D.position.x = 0;
    this.el.object3D.position.z = 0;

    // Get current rig position for movement direction calculation
    this.rig.object3D.getWorldPosition(this.curr);

    // Calculate velocity (movement direction) for character facing
    this.velocity.subVectors(this.curr, this.prev);

    // Horizontal only. Walking a slope changes the rig's height, and folding that into the
    // measured speed would nudge the walk/run blend on gradient rather than on pace.
    const speed = Math.hypot(this.velocity.x, this.velocity.z);

    // Convert to meters per second (speed was calculated per frame)
    const speedMps = dt > 0 ? speed / dt : 0;

    // Always use position-based detection as ground truth.
    // Movement events may stop firing when input stops, leaving isMoving stuck.
    this.isMoving = speedMps > this.data.moveThreshold;
    this.isRunning = speedMps > this.data.runThreshold;

    // Update animation state based on movement
    this.target.Idle = this.isMoving ? 0 : 1;
    this.target.Walk = this.isMoving && !this.isRunning ? 1 : 0;
    this.target.Run = this.isRunning ? 1 : 0;

    // Blend weights (frame-rate independent)
    const damp = 1 - Math.exp(-this.data.fadeLerp * dt);
    blendAnimations(this.actions, this.weights, this.target, damp);
    normalizeWeights(this.weights);

    // Update smoothed speed for cadence calculation
    this.rawSpeed = speedMps;

    // Calculate movement direction and face that direction
    if (this.isMoving) {
      // Only rotate if there's significant movement
      if (this.velocity.lengthSq() > 0.001) {
        // Calculate target rotation based on movement direction
        const angle = Math.atan2(this.velocity.x, this.velocity.z) + this.facingFix;
        this.targetQuat.setFromAxisAngle(this.up, angle);

        // Don't rotate the soldier - let the rig handle rotation
        // this.currentQuat.slerp(this.targetQuat, 0.1);
        // this.el.object3D.quaternion.copy(this.currentQuat);
      }
    }

    // Update previous position
    this.prev.copy(this.curr);

    // Cadence + smoothed speed for events/UI
    const spDamp = 1 - Math.exp(-this.data.smoothSpeedLerp * dt);
    this.speedMps += (this.rawSpeed - this.speedMps) * spDamp;
    this._updateCadence();
    this.el.emit("speed", {
      mps: this.speedMps,
      normalized: Math.min(1, this.speedMps / Math.max(this.data.runSpeed, 0.001)),
      running: this.isRunning,
      dt,
    });

    // Advance animation
    this.mixer.update(dt);
  },
});
