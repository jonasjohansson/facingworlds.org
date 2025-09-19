// gltf-animation-pointer.js — KHR_animation_pointer extension for A-Frame
AFRAME.registerComponent("gltf-animation-pointer", {
  schema: {
    enabled: { type: "boolean", default: true },
    autoPlay: { type: "boolean", default: true },
    loop: { type: "boolean", default: true },
    speed: { type: "number", default: 1.0 },
  },

  init() {
    this.mixer = null;
    this.actions = [];
    this.clock = new THREE.Clock();
    this.animationPointerExtension = null;

    // Wait for model to load
    this.el.addEventListener("model-loaded", () => {
      this.setupAnimationPointer();
    });
  },

  setupAnimationPointer() {
    const model = this.el.getObject3D("mesh");
    if (!model) return;

    // Check if the model has animations
    const animations = this.el.components["gltf-model"]?.data?.animations;
    if (!animations || animations.length === 0) {
      console.log("[gltf-animation-pointer] No animations found in model");
      return;
    }

    // Create animation mixer
    this.mixer = new THREE.AnimationMixer(model);

    // Set up each animation
    animations.forEach((clip, index) => {
      const action = this.mixer.clipAction(clip);
      action.setLoop(this.data.loop ? THREE.LoopRepeat : THREE.LoopOnce, Infinity);
      action.enabled = true;
      action.setEffectiveTimeScale(this.data.speed);
      action.setEffectiveWeight(0);

      if (this.data.autoPlay) {
        action.play();
      }

      this.actions.push(action);
    });

    console.log(`[gltf-animation-pointer] Loaded ${animations.length} animations`);

    // Log animation tracks for debugging
    animations.forEach((clip, index) => {
      console.log(`[gltf-animation-pointer] Animation ${index}:`, {
        name: clip.name,
        duration: clip.duration,
        tracks: clip.tracks.length,
        tracksInfo: clip.tracks.map((track) => ({
          name: track.name,
          type: track.constructor.name,
          property: track.property,
        })),
      });
    });
  },

  play() {
    if (this.actions.length > 0) {
      this.actions.forEach((action) => action.play());
    }
  },

  pause() {
    if (this.actions.length > 0) {
      this.actions.forEach((action) => action.pause());
    }
  },

  stop() {
    if (this.actions.length > 0) {
      this.actions.forEach((action) => action.stop());
    }
  },

  setWeight(index, weight) {
    if (this.actions[index]) {
      this.actions[index].setEffectiveWeight(weight);
    }
  },

  setTimeScale(index, timeScale) {
    if (this.actions[index]) {
      this.actions[index].setEffectiveTimeScale(timeScale);
    }
  },

  tick() {
    if (this.mixer && this.data.enabled) {
      const delta = this.clock.getDelta();
      this.mixer.update(delta);
    }
  },

  update() {
    // Update speed when schema changes
    if (this.actions.length > 0) {
      this.actions.forEach((action) => {
        action.setEffectiveTimeScale(this.data.speed);
      });
    }
  },
});
