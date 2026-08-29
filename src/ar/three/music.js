import { AR_CONFIG } from "../config/ar-config.js";

// Soundtrack for the AR experience.
//
// Playback is tied to the tracker, not to model load: the old behaviour started the
// music as soon as the glTF finished downloading, so it played while the user was
// still hunting for the sticker and kept playing after they looked away.
//
// The track is fetched lazily - nothing is downloaded until the AR session is live,
// which keeps a multi-megabyte MP3 off the critical path on a phone that is already
// pulling down the map.
export function createMusic() {
  const cfg = AR_CONFIG.audio;

  const audio = new Audio();
  audio.loop = true;
  audio.preload = "none";
  audio.volume = 0;
  audio.src = cfg.src;

  let fadeTimer = null;
  let tracked = false;
  let unlockHandler = null;

  // Linear ramp on a 50 ms timer. Cheap, and it keeps the track from slamming in and
  // out every time tracking flickers.
  const fadeTo = (target, done) => {
    const step = 50;

    if (fadeTimer) {
      clearInterval(fadeTimer);
      fadeTimer = null;
    }

    if (cfg.fade <= 0) {
      audio.volume = target;
      if (done) done();
      return;
    }

    const delta = (target - audio.volume) / (cfg.fade / step);
    fadeTimer = setInterval(() => {
      const next = audio.volume + delta;
      const arrived = delta >= 0 ? next >= target : next <= target;

      audio.volume = Math.min(1, Math.max(0, arrived ? target : next));
      if (!arrived) {
        return;
      }

      clearInterval(fadeTimer);
      fadeTimer = null;
      if (done) done();
    }, step);
  };

  // Mobile browsers refuse audio without a gesture. Camera permission is not always
  // one, so arm a single tap and retry there.
  const armGestureUnlock = () => {
    if (unlockHandler) {
      return;
    }
    unlockHandler = () => {
      document.removeEventListener("pointerdown", unlockHandler);
      unlockHandler = null;
      if (tracked) {
        audio.play().catch((error) => console.warn("[ar-music] playback blocked:", error));
      }
    };
    document.addEventListener("pointerdown", unlockHandler);
  };

  return {
    // Start buffering once the camera is live, so the track is ready by the time the
    // user finds the marker.
    warm() {
      audio.preload = "auto";
      audio.load();
    },

    start() {
      tracked = true;
      const attempt = audio.play();
      if (attempt && attempt.catch) {
        attempt.catch(armGestureUnlock);
      }
      fadeTo(cfg.volume);
    },

    stop() {
      tracked = false;
      fadeTo(0, () => audio.pause());
    },

    dispose() {
      if (unlockHandler) {
        document.removeEventListener("pointerdown", unlockHandler);
        unlockHandler = null;
      }
      if (fadeTimer) {
        clearInterval(fadeTimer);
        fadeTimer = null;
      }
      audio.pause();
      audio.removeAttribute("src");
    },
  };
}
