// background-music.js — Background music for the game.
//
// A THREE.Audio hanging off a THREE.AudioListener on the camera, exactly as before. What
// went away with A-Frame is the waiting: the component used to listen for the entity's
// "loaded" event and then poll every 100 ms for `sceneEl.camera` to exist. Systems are
// constructed after buildWorld() with `game.camera` already built, so both are gone and
// the listener is attached straight away.
import * as THREE from "three";
import { ASSETS } from "../engine/assets.js";

const DEFAULTS = {
  enabled: true,
  volume: 0.3,
  loop: true,
  autoplay: false,
  startOnFirstBullet: true,
  // The 6 MB mix the old component actually played (see the note in engine/assets.js:
  // <a-assets> declared a different, 12.7 MB file that nothing fetched). AudioLoader
  // downloads and decodes the whole file, so the URL choice is the download size.
  musicUrl: ASSETS.backgroundMusic,
};

export class BackgroundMusic {
  constructor(game, opts = {}) {
    this.game = game;
    this.data = { ...DEFAULTS, ...opts };

    this.audio = null;
    this.audioLoader = new THREE.AudioLoader();
    this.listener = null;
    this.musicStarted = false;
    this.offBulletFired = null;

    // Listen for bullet events to start music. `sceneEl.addEventListener` is the bus now;
    // the handler still reads nothing off the event, as before.
    if (this.data.startOnFirstBullet) {
      this.offBulletFired = game.events.on("bullet-fired", () => {
        this.startMusicOnFirstBullet();
      });
    }

    this.setupMusic();
  }

  setupMusic() {
    if (!this.data.enabled) return;

    // The camera exists by construction now — no waitForCamera() poll.
    this.listener = new THREE.AudioListener();
    this.game.camera.add(this.listener);
    this.loadMusic();
  }

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

          // autoplay is false: the browser's autoplay policy leaves the shared
          // AudioContext suspended until the page has been interacted with, and neither
          // A-Frame nor three ever resumed it. The gate is therefore the first shot —
          // which is itself fired from a click or a keypress.
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
  }

  startMusicOnFirstBullet() {
    if (this.musicStarted || !this.audio) return;

    this.musicStarted = true;
    this.audio.play();
    console.log("[background-music] Music started on first bullet!");
  }

  createAmbientSound() {
    // Create a simple ambient drone as fallback
    try {
      this.fallbackContext = new (window.AudioContext || window.webkitAudioContext)();

      if (this.fallbackContext.state === "suspended") {
        this.fallbackContext.resume();
      }

      this.fallbackOscillator = this.fallbackContext.createOscillator();
      const gainNode = this.fallbackContext.createGain();

      this.fallbackOscillator.connect(gainNode);
      gainNode.connect(this.fallbackContext.destination);

      this.fallbackOscillator.frequency.setValueAtTime(60, this.fallbackContext.currentTime);
      this.fallbackOscillator.type = "sine";

      gainNode.gain.setValueAtTime(0.1, this.fallbackContext.currentTime);

      this.fallbackOscillator.start(this.fallbackContext.currentTime);
      console.log("[background-music] Playing ambient fallback sound");
    } catch (error) {
      console.warn("[background-music] Fallback sound failed:", error);
    }
  }

  play() {
    if (this.audio && this.data.enabled) {
      this.audio.play();
    }
  }

  pause() {
    if (this.audio) {
      this.audio.pause();
    }
  }

  stop() {
    if (this.audio) {
      this.audio.stop();
    }
  }

  /** What the component's update(oldData) hook did when volume or loop was re-set. */
  setOptions(opts = {}) {
    Object.assign(this.data, opts);
    if (this.audio) {
      this.audio.setVolume(this.data.volume);
      this.audio.setLoop(this.data.loop);
    }
  }

  dispose() {
    if (this.offBulletFired) this.offBulletFired();
    if (this.audio) {
      this.audio.stop();
    }
    if (this.listener && this.listener.parent) {
      this.listener.parent.remove(this.listener);
    }
    if (this.fallbackOscillator) {
      this.fallbackOscillator.stop();
    }
    if (this.fallbackContext) {
      this.fallbackContext.close();
    }
  }
}
