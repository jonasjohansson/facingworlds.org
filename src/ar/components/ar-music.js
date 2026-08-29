import { AR_CONFIG } from "../config/ar-config.js";

// Soundtrack for the AR experience. Goes on <a-scene>.
//
// The old music-trigger started playback on the model's "model-loaded" event,
// which fires as soon as the glTF finishes downloading - so the music played
// while the user was still hunting for the sticker, and kept playing after they
// looked away. encantar emits artargetfound / artargetlost on the scene; those
// are the events that actually mean "the marker is on screen".
//
// The track is fetched lazily: nothing is downloaded until the AR session is
// live, which keeps a multi-megabyte MP3 off the critical path on a phone that
// is already pulling down the map textures.
AFRAME.registerComponent("ar-music", {
  schema: {
    src: { type: "string", default: AR_CONFIG.audio.src },
    volume: { type: "number", default: AR_CONFIG.audio.volume },
    fade: { type: "number", default: AR_CONFIG.audio.fade },
  },

  init: function () {
    var audio = new Audio();
    audio.loop = true;
    audio.preload = "none";
    audio.volume = 0;
    audio.src = this.data.src;
    this.audio = audio;

    this.fadeTimer = null;
    this.tracked = false;
    this.unlockHandler = null;

    this.onSessionReady = this.warm.bind(this);
    this.onTargetFound = this.start.bind(this);
    this.onTargetLost = this.stop.bind(this);
    this.onSessionEnded = this.stop.bind(this);

    this.el.addEventListener("arready", this.onSessionReady);
    this.el.addEventListener("artargetfound", this.onTargetFound);
    this.el.addEventListener("artargetlost", this.onTargetLost);
    this.el.addEventListener("arsessionended", this.onSessionEnded);
  },

  // Start buffering once the camera is live, so the track is ready by the time
  // the user finds the marker.
  warm: function () {
    this.audio.preload = "auto";
    this.audio.load();
  },

  start: function () {
    var self = this;
    this.tracked = true;

    var attempt = this.audio.play();
    if (attempt && attempt.catch) {
      attempt.catch(function () {
        // Mobile browsers refuse audio without a gesture. Camera permission is
        // not always one, so arm a single tap and retry there.
        self.armGestureUnlock();
      });
    }

    this.fadeTo(this.data.volume);
  },

  stop: function () {
    var self = this;
    this.tracked = false;
    this.fadeTo(0, function () {
      self.audio.pause();
    });
  },

  armGestureUnlock: function () {
    if (this.unlockHandler) {
      return;
    }

    var self = this;
    this.unlockHandler = function () {
      document.removeEventListener("pointerdown", self.unlockHandler);
      self.unlockHandler = null;
      if (self.tracked) {
        self.audio.play().catch(function (error) {
          console.warn("[ar-music] playback blocked:", error);
        });
      }
    };
    document.addEventListener("pointerdown", this.unlockHandler);
  },

  // Linear ramp on a 50 ms timer. Cheap, and it keeps the track from slamming in
  // and out every time tracking flickers.
  fadeTo: function (target, done) {
    var self = this;
    var step = 50;

    if (this.fadeTimer) {
      clearInterval(this.fadeTimer);
      this.fadeTimer = null;
    }

    if (this.data.fade <= 0) {
      this.audio.volume = target;
      if (done) {
        done();
      }
      return;
    }

    var delta = (target - this.audio.volume) / (this.data.fade / step);
    this.fadeTimer = setInterval(function () {
      var next = self.audio.volume + delta;
      var arrived = delta >= 0 ? next >= target : next <= target;

      self.audio.volume = Math.min(1, Math.max(0, arrived ? target : next));
      if (!arrived) {
        return;
      }

      clearInterval(self.fadeTimer);
      self.fadeTimer = null;
      if (done) {
        done();
      }
    }, step);
  },

  remove: function () {
    this.el.removeEventListener("arready", this.onSessionReady);
    this.el.removeEventListener("artargetfound", this.onTargetFound);
    this.el.removeEventListener("artargetlost", this.onTargetLost);
    this.el.removeEventListener("arsessionended", this.onSessionEnded);

    if (this.unlockHandler) {
      document.removeEventListener("pointerdown", this.unlockHandler);
      this.unlockHandler = null;
    }
    if (this.fadeTimer) {
      clearInterval(this.fadeTimer);
      this.fadeTimer = null;
    }

    this.audio.pause();
    this.audio.removeAttribute("src");
    this.audio = null;
  },
});
