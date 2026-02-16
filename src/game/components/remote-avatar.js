// remote-avatar.js — Handles position updates and animations for remote players
AFRAME.registerComponent("remote-avatar", {
  schema: {
    enabled: { type: "boolean", default: true },
  },

  init: function () {
    this.lastPosition = { x: 0, y: 0, z: 0 };
    this.lastRotation = 0;
    this.currentSpeed = 0;
    this.lerpSpeed = 0.2; // Smooth interpolation speed
    this._firstPose = true; // Snap to first pose instead of lerping from origin

    // Target values for smooth interpolation
    this.targetPosition = { x: 0, y: 0, z: 0 };
    this.targetRotation = 0;
    this.targetSpeed = 0;

    // Animation system for remote players
    this.mixer = null;
    this.actions = {};
    this.weights = { Idle: 1, Walk: 0, Run: 0 };
    this.target = { Idle: 1, Walk: 0, Run: 0 };
    this.clock = new AFRAME.THREE.Clock();

    // Wait for GLTF model to load
    this.el.addEventListener("model-loaded", () => {
      this.setupAnimations();
    });
  },

  setNetPose: function (pose) {
    if (!this.data.enabled || !pose) return;

    const { x, y, z, ry, animation } = pose;

    // Snap position and rotation together on first pose
    if (this._firstPose) {
      if (x !== undefined && y !== undefined && z !== undefined) {
        this.targetPosition = { x, y, z };
        this.lastPosition = { x, y, z };
      }
      if (ry !== undefined) {
        this.targetRotation = ry;
        this.lastRotation = ry;
      }
      this._firstPose = false;
    } else {
      if (x !== undefined && y !== undefined && z !== undefined) {
        this.targetPosition = { x, y, z };
      }
      if (ry !== undefined) {
        this.targetRotation = ry;
      }
    }

    // Update animation state directly
    if (animation) {
      this.updateAnimationFromState(animation);
    }
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

    this.target = {
      Idle: animationState.idle || 0,
      Walk: animationState.walk || 0,
      Run: animationState.run || 0,
    };
  },

  tick: function (time, deltaTime) {
    if (!this.data.enabled) return;

    const rig = this.el.parentElement;
    if (!rig || !rig.object3D) return;

    // Smooth position interpolation — set object3D directly (no setAttribute overhead)
    const posLerp = Math.min(this.lerpSpeed * (deltaTime / 16.67), 1);
    this.lastPosition.x += (this.targetPosition.x - this.lastPosition.x) * posLerp;
    this.lastPosition.y += (this.targetPosition.y - this.lastPosition.y) * posLerp;
    this.lastPosition.z += (this.targetPosition.z - this.lastPosition.z) * posLerp;

    rig.object3D.position.set(this.lastPosition.x, this.lastPosition.y, this.lastPosition.z);

    // Smooth rotation interpolation with angle wrapping
    let rotDiff = this.targetRotation - this.lastRotation;
    // Wrap to [-PI, PI] so we always take the short path
    while (rotDiff > Math.PI) rotDiff -= 2 * Math.PI;
    while (rotDiff < -Math.PI) rotDiff += 2 * Math.PI;
    const rotLerp = Math.min(this.lerpSpeed * (deltaTime / 16.67), 1);
    this.lastRotation += rotDiff * rotLerp;

    rig.object3D.rotation.set(0, this.lastRotation, 0);

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
    if (this.mixer) {
      this.mixer.stopAllAction();
    }
  },
});
