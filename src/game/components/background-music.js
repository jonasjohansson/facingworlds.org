// background-music.js — Background music for the game
AFRAME.registerComponent("background-music", {
  schema: {
    enabled: { type: "boolean", default: true },
    volume: { type: "number", default: 0.3 },
    loop: { type: "boolean", default: true },
    autoplay: { type: "boolean", default: false },
    startOnFirstBullet: { type: "boolean", default: true },
    musicUrl: { type: "string", default: "assets/audio/110-van_den_bos--foregone_destruction-i.mp3" },
  },

  init() {
    this.audio = null;
    this.audioLoader = new THREE.AudioLoader();
    this.listener = null;
    this.musicStarted = false;

    // Wait for scene to load
    this.el.addEventListener("loaded", () => {
      this.setupMusic();
    });

    // Listen for bullet events to start music
    if (this.data.startOnFirstBullet) {
      this.el.sceneEl.addEventListener("bullet-fired", () => {
        this.startMusicOnFirstBullet();
      });
    }
  },

  setupMusic() {
    if (!this.data.enabled) return;

    // Wait for camera to be available
    this.waitForCamera(() => {
      this.loadMusic();
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

  loadMusic() {
    // Load background music
    this.audioLoader.load(
      this.data.musicUrl,
      (buffer) => {
        if (this.listener) {
          this.audio = new THREE.Audio(this.listener);
          this.audio.setBuffer(buffer);
          this.audio.setLoop(this.data.loop);
          this.audio.setVolume(this.data.volume);

          if (this.data.autoplay) {
            this.audio.play();
          }

          console.log("[background-music] Music loaded and ready");
        } else {
          console.warn("[background-music] No audio listener available, using fallback");
          this.createAmbientSound();
        }
      },
      undefined,
      (error) => {
        console.warn("[background-music] Failed to load music:", error);
        // Create a simple ambient sound as fallback
        this.createAmbientSound();
      }
    );
  },

  startMusicOnFirstBullet() {
    if (this.musicStarted || !this.audio) return;

    this.musicStarted = true;
    this.audio.play();
    console.log("[background-music] Music started on first bullet!");
  },

  createAmbientSound() {
    // Create a simple ambient drone as fallback
    try {
      const audioContext = new (window.AudioContext || window.webkitAudioContext)();

      if (audioContext.state === "suspended") {
        audioContext.resume();
      }

      const oscillator = audioContext.createOscillator();
      const gainNode = audioContext.createGain();

      oscillator.connect(gainNode);
      gainNode.connect(audioContext.destination);

      oscillator.frequency.setValueAtTime(60, audioContext.currentTime);
      oscillator.type = "sine";

      gainNode.gain.setValueAtTime(0.1, audioContext.currentTime);

      oscillator.start(audioContext.currentTime);
      console.log("[background-music] Playing ambient fallback sound");
    } catch (error) {
      console.warn("[background-music] Fallback sound failed:", error);
    }
  },

  play() {
    if (this.audio && this.data.enabled) {
      this.audio.play();
    }
  },

  pause() {
    if (this.audio) {
      this.audio.pause();
    }
  },

  stop() {
    if (this.audio) {
      this.audio.stop();
    }
  },

  update() {
    if (this.audio) {
      this.audio.setVolume(this.data.volume);
      this.audio.setLoop(this.data.loop);
    }
  },
});
