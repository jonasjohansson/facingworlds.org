// character.js — Animation-only follower for a navmesh-driven rig.
// Put movement-controls + navmesh-constraint on the parent rig.
// The character entity stays at (0,0,0) under the rig and only animates & faces motion.
import { createVector3, createQuaternion, createClock } from "../utils/three-helpers.js";
import { setupAnimationMixer, blendAnimations, normalizeWeights, updateTimeScale } from "../utils/animation-helpers.js";

AFRAME.registerComponent("character", {
  schema: {
    // GLTF animation clip indices
    idleIdx: { type: "int", default: 0 },
    walkIdx: { type: "int", default: 3 },
    runIdx: { type: "int", default: 1 },

    // Reference speeds (used for cadence + run threshold)
    walkSpeed: { type: "number", default: 1.6 }, // m/s
    runSpeed: { type: "number", default: 3.2 }, // m/s

    // Animation cadence tuning
    walkCycleMps: { type: "number", default: 1.6 },
    runCycleMps: { type: "number", default: 3.2 },
    minTimeScale: { type: "number", default: 0.6 },
    maxTimeScale: { type: "number", default: 1.8 },

    // Facing trim (rarely needed)
    yawOffsetDeg: { type: "number", default: 0 },

    // Blend responsiveness (per-second; higher = snappier)
    fadeLerp: { type: "number", default: 10.0 },

    // Speed smoothing (per-second)
    smoothSpeedLerp: { type: "number", default: 8.0 },

    // Thresholds
    moveThreshold: { type: "number", default: 0.05 }, // start walking above this
    runThreshold: { type: "number", default: 2.4 }, // switch to run above this
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

    // Facing trim to world -Z
    this.facingFix = 0;

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

  _updateCadence() {
    const { minTimeScale, maxTimeScale, walkCycleMps, runCycleMps } = this.data;
    const wantsRun = this.target.Run > this.target.Walk;
    const ref = wantsRun ? runCycleMps : walkCycleMps;
    updateTimeScale(this.actions, this.speedMps, ref, minTimeScale, maxTimeScale);
  },

  tick() {
    if (!this.mixer || !this.rig) return;

    let dt = this.clock.getDelta();
    if (!isFinite(dt) || dt <= 0) return;
    dt = Math.min(dt, 1 / 20); // cap 50ms

    // Measure rig displacement (world space)
    this.rig.object3D.getWorldPosition(this.curr);
    const dx = this.curr.x - this.prev.x;
    const dz = this.curr.z - this.prev.z;
    const speed = dt > 0 ? Math.sqrt(dx * dx + dz * dz) / dt : 0;

    // Decide state
    const moving = speed > this.data.moveThreshold;
    const running = speed > this.data.runThreshold;

    this.target.Idle = moving ? 0 : 1;
    this.target.Walk = moving && !running ? 1 : 0;
    this.target.Run = running ? 1 : 0;

    // Blend weights (frame-rate independent)
    const damp = 1 - Math.exp(-this.data.fadeLerp * dt);
    blendAnimations(this.actions, this.weights, this.target, damp);
    normalizeWeights(this.weights);

    // Face travel direction (only for local player, not remote avatars)
    if (speed > 0.01 && !this.el.hasAttribute("remote-avatar")) {
      const angle = Math.atan2(dx, dz) + this.facingFix;
      this.targetQuat.setFromAxisAngle(createVector3(0, 1, 0), angle);

      // Only rotate the character, not the rig (rig contains camera and controls)
      this.el.object3D.quaternion.slerp(this.targetQuat, 1 - Math.exp(-8 * dt));
    }

    // Keep character glued to rig origin
    this.el.object3D.position.set(0, 0, 0);

    // Cadence + smoothed speed for events/UI
    this.rawSpeed = speed;
    const spDamp = 1 - Math.exp(-this.data.smoothSpeedLerp * dt);
    this.speedMps += (this.rawSpeed - this.speedMps) * spDamp;
    this._updateCadence();
    this.el.emit("speed", {
      mps: this.speedMps,
      normalized: Math.min(1, this.speedMps / Math.max(this.data.runSpeed, 0.001)),
      running,
      dt,
    });

    // Advance and store prev
    this.mixer.update(dt);
    this.prev.copy(this.curr);
  },
});
