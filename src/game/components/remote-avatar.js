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

    // Animation thresholds (lowered for easier triggering)
    this.moveThreshold = 0.01; // Lower threshold for walk
    this.runThreshold = 0.5; // Lower threshold for run

    // Wait for GLTF model to load
    this.el.addEventListener("model-loaded", () => {
      this.setupAnimations();
    });
  },

  setNetPose: function (pose) {
    if (!this.data.enabled || !pose) return;

    const { x, y, z, ry, animation } = pose;

    // console.log(`[remote-avatar] Updating pose:`, pose); // Reduced logging

    // Set target values for smooth interpolation
    if (x !== undefined && y !== undefined && z !== undefined) {
      this.targetPosition = { x, y, z };
    }

    if (ry !== undefined) {
      this.targetRotation = ry;
    }

    // Update animation state directly
    if (animation) {
      if (Math.random() < 0.01) {
        // Log 1% of the time to reduce spam
        console.log("[remote-avatar] Received animation:", animation);
        console.log("[remote-avatar] Current target before update:", this.target);
      }
      this.updateAnimationFromState(animation);
      if (Math.random() < 0.01) {
        console.log("[remote-avatar] Target after update:", this.target);
      }
    } else {
      if (Math.random() < 0.01) {
        // Log 1% of the time to reduce spam
        console.log("[remote-avatar] No animation data in pose");
      }
    }
  },

  setupAnimations: function () {
    const mesh = this.el.getObject3D("mesh");
    if (!mesh || !mesh.animations) {
      console.warn("[remote-avatar] No animations found in model");
      return;
    }

    const clips = mesh.animations;
    console.log(
      "[remote-avatar] Found animations:",
      clips.map((c) => c.name)
    );

    // Create animation mixer
    this.mixer = new AFRAME.THREE.AnimationMixer(mesh);

    // Find animation clips (assuming standard indices)
    const idleClip = clips[0] || clips.find((c) => c.name.toLowerCase().includes("idle"));
    const walkClip = clips[3] || clips.find((c) => c.name.toLowerCase().includes("walk"));
    const runClip = clips[1] || clips.find((c) => c.name.toLowerCase().includes("run"));

    if (!idleClip || !walkClip || !runClip) {
      console.warn("[remote-avatar] Missing required animation clips");
      console.log(
        "Available clips:",
        clips.map((c) => ({ name: c.name, duration: c.duration }))
      );

      // Try to use any available clips as fallback
      if (clips.length > 0) {
        console.log("[remote-avatar] Using fallback animation setup");
        this.actions.Idle = this.mixer.clipAction(clips[0]);
        this.actions.Walk = clips[1] ? this.mixer.clipAction(clips[1]) : this.actions.Idle;
        this.actions.Run = clips[2] ? this.mixer.clipAction(clips[2]) : this.actions.Idle;
      } else {
        return;
      }
    } else {
      // Create actions with found clips
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

    console.log("[remote-avatar] Animation system initialized");
  },

  updateAnimationFromState: function (animationState) {
    if (!this.mixer || !this.actions.Idle) {
      return;
    }

    // Set target animation state directly from network
    this.target = {
      Idle: animationState.idle || 0,
      Walk: animationState.walk || 0,
      Run: animationState.run || 0,
    };

    // console.log(`[remote-avatar] Setting animation target:`, this.target); // Reduced logging
  },

  tick: function (time, deltaTime) {
    if (!this.data.enabled) return;

    const rig = this.el.parentElement;
    if (!rig) return;

    // Smooth position interpolation
    const posLerp = Math.min(this.lerpSpeed * (deltaTime / 16.67), 1); // Normalize to 60fps
    this.lastPosition.x += (this.targetPosition.x - this.lastPosition.x) * posLerp;
    this.lastPosition.y += (this.targetPosition.y - this.lastPosition.y) * posLerp;
    this.lastPosition.z += (this.targetPosition.z - this.lastPosition.z) * posLerp;

    rig.setAttribute("position", `${this.lastPosition.x.toFixed(3)} ${this.lastPosition.y.toFixed(3)} ${this.lastPosition.z.toFixed(3)}`);

    // Smooth rotation interpolation
    const rotLerp = Math.min(this.lerpSpeed * (deltaTime / 16.67), 1);
    this.lastRotation += (this.targetRotation - this.lastRotation) * rotLerp;
    rig.setAttribute("rotation", `0 ${(this.lastRotation * (180 / Math.PI)).toFixed(1)} 0`);

    // Update animations
    if (this.mixer) {
      this.mixer.update(deltaTime / 1000); // Convert to seconds

      // Blend animations smoothly
      const fadeLerp = 1 - Math.exp((-10 * deltaTime) / 1000); // 10 per second
      this.blendAnimations(fadeLerp);
    }
  },

  blendAnimations: function (lerpFactor) {
    if (!this.actions.Idle) return;

    // Blend weights towards target
    Object.keys(this.weights).forEach((key) => {
      if (this.actions[key] && this.target.hasOwnProperty(key)) {
        this.weights[key] += (this.target[key] - this.weights[key]) * lerpFactor;
        this.actions[key].setEffectiveWeight(this.weights[key]);
      }
    });
  },

  remove: function () {
    // Cleanup if needed
  },
});
