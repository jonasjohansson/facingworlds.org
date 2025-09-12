// bullet-audio.js — Spatial audio for bullet shots
AFRAME.registerComponent("bullet-audio", {
  schema: {
    enabled: { type: "boolean", default: true },
    volume: { type: "number", default: 0.5 },
    maxDistance: { type: "number", default: 50 },
    rolloffFactor: { type: "number", default: 1 },
    soundUrl: { type: "string", default: "src/audio/fire.wav" },
  },

  init() {
    this.audioLoader = new THREE.AudioLoader();
    this.sound = null;
    this.listener = null;

    // Create audio context
    this.audioContext = new (window.AudioContext || window.webkitAudioContext)();

    // Wait for model to load
    this.el.addEventListener("model-loaded", () => {
      this.setupAudio();
    });
  },

  setupAudio() {
    if (!this.data.enabled) return;

    // Wait for camera to be available
    this.waitForCamera(() => {
      this.loadAudio();
    });
  },

  waitForCamera(callback) {
    const checkCamera = () => {
      const camera = this.el.sceneEl.camera;
      if (camera && camera.el) {
        this.listener = new THREE.AudioListener();
        camera.el.object3D.add(this.listener);
        callback();
      } else {
        // Retry after a short delay
        setTimeout(checkCamera, 100);
      }
    };
    checkCamera();
  },

  loadAudio() {
    // Load bullet sound
    this.audioLoader.load(
      this.data.soundUrl,
      (buffer) => {
        if (this.listener) {
          this.sound = new THREE.PositionalAudio(this.listener);
          this.sound.setBuffer(buffer);
          this.sound.setRefDistance(1);
          this.sound.setMaxDistance(this.data.maxDistance);
          this.sound.setRolloffFactor(this.data.rolloffFactor);
          this.sound.setVolume(this.data.volume);

          this.el.object3D.add(this.sound);
          console.log("[bullet-audio] Audio loaded and ready");
        } else {
          console.warn("[bullet-audio] No audio listener available, using fallback");
          this.createFallbackSound();
        }
      },
      undefined,
      (error) => {
        console.warn("[bullet-audio] Failed to load audio:", error);
        // Fallback to a simple beep sound
        this.createFallbackSound();
      }
    );
  },

  createFallbackSound() {
    // Create a simple beep sound as fallback
    try {
      const audioContext = new (window.AudioContext || window.webkitAudioContext)();

      if (audioContext.state === "suspended") {
        audioContext.resume();
      }

      const oscillator = audioContext.createOscillator();
      const gainNode = audioContext.createGain();

      oscillator.connect(gainNode);
      gainNode.connect(audioContext.destination);

      oscillator.frequency.setValueAtTime(800, audioContext.currentTime);
      oscillator.type = "square";

      gainNode.gain.setValueAtTime(0.3, audioContext.currentTime);
      gainNode.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + 0.1);

      oscillator.start(audioContext.currentTime);
      oscillator.stop(audioContext.currentTime + 0.1);
    } catch (error) {
      console.warn("[bullet-audio] Fallback sound failed:", error);
    }
  },

  play() {
    if (this.sound && this.data.enabled) {
      this.sound.play();
    }
  },

  stop() {
    if (this.sound) {
      this.sound.stop();
    }
  },

  update() {
    if (this.sound) {
      this.sound.setVolume(this.data.volume);
      this.sound.setMaxDistance(this.data.maxDistance);
      this.sound.setRolloffFactor(this.data.rolloffFactor);
    }
  },
});
