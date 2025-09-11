// animation-pointer.js — KHR_animation_pointer support for A-Frame
AFRAME.registerComponent("animation-pointer", {
  schema: {
    enabled: { type: "boolean", default: true },
    autoPlay: { type: "boolean", default: true },
    loop: { type: "boolean", default: true },
  },

  init() {
    this.mixer = null;
    this.actions = [];
    this.clock = new THREE.Clock();

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
      console.log("[animation-pointer] No animations found in model");
      return;
    }

    // Create animation mixer
    this.mixer = new THREE.AnimationMixer(model);

    // Set up each animation
    animations.forEach((clip, index) => {
      const action = this.mixer.clipAction(clip);
      action.setLoop(this.data.loop ? THREE.LoopRepeat : THREE.LoopOnce, Infinity);
      action.enabled = true;
      action.setEffectiveTimeScale(1);
      action.setEffectiveWeight(0);

      if (this.data.autoPlay) {
        action.play();
      }

      this.actions.push(action);
    });

    console.log(`[animation-pointer] Loaded ${animations.length} animations`);
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
});
