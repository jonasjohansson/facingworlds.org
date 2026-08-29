// remote-avatar.js — Handles position updates and animations for remote players
//
// Remote poses arrive every 50–100ms over the network. Applying them raw makes other
// players teleport, so instead we buffer incoming snapshots and render the avatar a
// fixed amount of time IN THE PAST (INTERP_DELAY). At any render frame there are then
// two snapshots bracketing the render time and we interpolate between them, which
// turns a 10–20Hz packet stream into smooth 60Hz motion.
//
// The buffering/interpolation math itself lives in src/shared/net/interpolation.js so
// the AR spectator view (pure three.js, no A-Frame) renders the same players with the
// same behaviour instead of growing a second copy that re-acquires the teleporting this
// one already fixed. This component owns only the A-Frame side: the animation mixer,
// the residual visual smoothing, and writing the result onto the rig.
import { SnapshotBuffer, lerpYaw } from "../../shared/net/interpolation.js";

// One buffer per component, so it tracks exactly one entity.
const SELF = "self";

AFRAME.registerComponent("remote-avatar", {
  schema: {
    enabled: { type: "boolean", default: true },
    // How far in the past to render, in ms. One-and-a-bit packet intervals of slack.
    delay: { type: "number", default: 100 },
    // Residual visual smoothing applied on top of the interpolation (per 16.67ms frame).
    // Absorbs the small pops caused by extrapolation and by snapshots arriving late.
    smoothing: { type: "number", default: 0.35 },
  },

  init: function () {
    this.lastPosition = { x: 0, y: 0, z: 0 };
    this.lastRotation = 0;
    this.currentSpeed = 0;

    // Target values produced by the interpolator, consumed by the visual smoothing
    this.targetPosition = { x: 0, y: 0, z: 0 };
    this.targetRotation = 0;
    this.targetSpeed = 0;

    // ---- interpolation buffer ----
    // maxExtrapolationMs matches the old inline cap (delay + 20): remote players stop
    // sending poses when they stand still, so open ended extrapolation would slide an
    // idle avatar across the map.
    this.buffer = new SnapshotBuffer({
      delayMs: this.data.delay,
      maxExtrapolationMs: this.data.delay + 20,
    });

    // Animation system for remote players
    this.mixer = null;
    this.actions = {};
    this.weights = { Idle: 1, Walk: 0, Run: 0 };
    this.target = { Idle: 1, Walk: 0, Run: 0 };
    this.clock = new AFRAME.THREE.Clock();

    // Wait for GLTF model to load
    this._onModelLoaded = () => this.setupAnimations();
    this.el.addEventListener("model-loaded", this._onModelLoaded);
  },

  update: function () {
    // Keep the buffer's timing in sync if the schema is changed at runtime
    if (!this.buffer) return;
    this.buffer.delayMs = this.data.delay;
    this.buffer.maxExtrapolationMs = this.data.delay + 20;
  },

  // Monotonic local clock — immune to wall-clock jumps mid-session
  _now: function () {
    return typeof performance !== "undefined" && performance.now ? performance.now() : Date.now();
  },

  setNetPose: function (pose) {
    if (!this.data.enabled || !pose) return;

    // The buffer validates the pose, estimates the server clock offset, carries the
    // animation block forward, and sorts late/duplicate arrivals into place. It reports
    // "snap" for the first pose and for a teleport (a respawn) — interpolating those
    // would drag the avatar across the whole map, so we place it there outright.
    if (this.buffer.push(SELF, pose, pose.t) === "snap") this._snapToLatest();
  },

  // Place the avatar exactly on the snapshot the buffer just snapped to, bypassing both
  // the interpolation and the residual smoothing.
  _snapToLatest: function () {
    const s = this.buffer.sample(SELF, this._now());
    if (!s) return;
    this.targetPosition.x = this.lastPosition.x = s.x;
    this.targetPosition.y = this.lastPosition.y = s.y;
    this.targetPosition.z = this.lastPosition.z = s.z;
    this.targetRotation = this.lastRotation = s.ry;
    this.targetSpeed = this.currentSpeed = s.speed;
    this.updateAnimationFromState(s.animation);
    this._applyToRig();
  },

  // Blend the two snapshots bracketing the render time into targetPosition et al.
  _sampleBuffer: function () {
    const s = this.buffer.sample(SELF, this._now());
    if (!s) return;
    this.targetPosition.x = s.x;
    this.targetPosition.y = s.y;
    this.targetPosition.z = s.z;
    this.targetRotation = s.ry;
    this.targetSpeed = s.speed;
    // Animation state comes from the snapshot we are leaving, so the legs match the
    // motion we are actually rendering rather than a state 100ms in the future.
    this.updateAnimationFromState(s.animation);
  },

  setupAnimations: function () {
    const mesh = this.el.getObject3D("mesh");
    if (!mesh || !mesh.animations) {
      console.warn("[remote-avatar] No animations found in model");
      return;
    }

    const clips = mesh.animations;

    // Create animation mixer
    this.mixer = new AFRAME.THREE.AnimationMixer(mesh);

    // Find animation clips (assuming standard indices)
    const idleClip = clips[0] || clips.find((c) => c.name.toLowerCase().includes("idle"));
    const walkClip = clips[3] || clips.find((c) => c.name.toLowerCase().includes("walk"));
    const runClip = clips[1] || clips.find((c) => c.name.toLowerCase().includes("run"));

    if (!idleClip || !walkClip || !runClip) {
      console.warn("[remote-avatar] Missing required animation clips");

      // Try to use any available clips as fallback
      if (clips.length > 0) {
        this.actions.Idle = this.mixer.clipAction(clips[0]);
        this.actions.Walk = clips[1] ? this.mixer.clipAction(clips[1]) : this.actions.Idle;
        this.actions.Run = clips[2] ? this.mixer.clipAction(clips[2]) : this.actions.Idle;
      } else {
        return;
      }
    } else {
      this.actions.Idle = this.mixer.clipAction(idleClip);
      this.actions.Walk = this.mixer.clipAction(walkClip);
      this.actions.Run = this.mixer.clipAction(runClip);
    }

    // Configure actions
    Object.values(this.actions).forEach((action) => {
      action.setLoop(AFRAME.THREE.LoopRepeat, Infinity);
      action.enabled = true;
      action.setEffectiveTimeScale(1);
    });

    // Start with idle
    this.actions.Idle.setEffectiveWeight(1);
    this.actions.Walk.setEffectiveWeight(0);
    this.actions.Run.setEffectiveWeight(0);

    this.actions.Idle.play();
    this.actions.Walk.play();
    this.actions.Run.play();
  },

  updateAnimationFromState: function (animationState) {
    if (!this.mixer || !this.actions.Idle) return;

    if (!animationState) {
      // No animation block was ever sent — derive one from the interpolated speed so
      // the avatar still animates instead of standing frozen while it slides around.
      const s = this.targetSpeed || 0;
      this.target = { Idle: s < 0.5 ? 1 : 0, Walk: s >= 0.5 && s < 3 ? 1 : 0, Run: s >= 3 ? 1 : 0 };
      return;
    }

    this.target = {
      Idle: animationState.idle || 0,
      Walk: animationState.walk || 0,
      Run: animationState.run || 0,
    };
  },

  _applyToRig: function () {
    const rig = this.el.parentElement;
    if (!rig || !rig.object3D) return;
    rig.object3D.position.set(this.lastPosition.x, this.lastPosition.y, this.lastPosition.z);
    rig.object3D.rotation.set(0, this.lastRotation, 0);
  },

  tick: function (time, deltaTime) {
    if (!this.data.enabled) return;

    const rig = this.el.parentElement;
    if (!rig || !rig.object3D) return;

    // Interpolate the network snapshots into this frame's target pose
    this._sampleBuffer();

    // Residual smoothing — set object3D directly (no setAttribute overhead)
    const lerp = Math.min(this.data.smoothing * (deltaTime / 16.67), 1);
    this.lastPosition.x += (this.targetPosition.x - this.lastPosition.x) * lerp;
    this.lastPosition.y += (this.targetPosition.y - this.lastPosition.y) * lerp;
    this.lastPosition.z += (this.targetPosition.z - this.lastPosition.z) * lerp;

    // Shortest-path yaw so the avatar never spins the long way round
    this.lastRotation = lerpYaw(this.lastRotation, this.targetRotation, lerp);
    this.currentSpeed += (this.targetSpeed - this.currentSpeed) * lerp;

    this._applyToRig();

    // Update animations
    if (this.mixer) {
      this.mixer.update(deltaTime / 1000);

      const fadeLerp = 1 - Math.exp((-10 * deltaTime) / 1000);
      this.blendAnimations(fadeLerp);
    }
  },

  blendAnimations: function (lerpFactor) {
    if (!this.actions.Idle) return;

    const keys = Object.keys(this.weights);
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      if (this.actions[key] && this.target[key] !== undefined) {
        this.weights[key] += (this.target[key] - this.weights[key]) * lerpFactor;
        this.actions[key].setEffectiveWeight(this.weights[key]);
      }
    }
  },

  remove: function () {
    this.el.removeEventListener("model-loaded", this._onModelLoaded);
    this.buffer.clear();
    if (this.mixer) {
      this.mixer.stopAllAction();
      const mesh = this.el.getObject3D("mesh");
      if (mesh) this.mixer.uncacheRoot(mesh);
      this.mixer = null;
    }
    this.actions = {};
  },
});
