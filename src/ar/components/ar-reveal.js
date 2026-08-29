import { AR_CONFIG } from "../config/ar-config.js";

// Entrance animation for whatever sits on the marker.
//
// encantar plays and pauses everything under <ar-root> in step with the tracker,
// so the component's own play/pause hooks are the tracking state - no need to
// listen for artargetfound here, and it stays correct if the marker is lost and
// reacquired ten times in a row.
//
// Without this the model snaps to full size on the first tracked frame, which
// reads as a glitch. A short rise-and-settle reads as the map arriving.
AFRAME.registerComponent("ar-reveal", {
  schema: {
    duration: { type: "number", default: AR_CONFIG.model.reveal.duration },
    // Resting height above the marker plane (marker space is Z-up).
    height: { type: "number", default: AR_CONFIG.model.hover },
    // How far below the resting height the model starts.
    rise: { type: "number", default: AR_CONFIG.model.reveal.rise },
  },

  init: function () {
    this.elapsed = 0;
    this.apply(0);
  },

  play: function () {
    this.elapsed = 0;
    this.apply(0);
  },

  pause: function () {
    // Hidden anyway - encantar clears the root's visibility - but reset so the
    // next acquisition starts from zero instead of mid-animation.
    this.elapsed = 0;
    this.apply(0);
  },

  tick: function (time, deltaTime) {
    if (this.elapsed >= this.data.duration) {
      return;
    }
    this.elapsed = Math.min(this.elapsed + deltaTime, this.data.duration);
    this.apply(this.elapsed / this.data.duration);
  },

  apply: function (t) {
    var eased = easeOutBack(t);
    var object = this.el.object3D;
    object.scale.setScalar(Math.max(eased, 0.0001));
    object.position.z = this.data.height - this.data.rise * (1 - easeOutCubic(t));
  },
});

// Slight overshoot on the scale so the map lands with a bit of weight.
function easeOutBack(t) {
  var c1 = 1.4;
  var c3 = c1 + 1;
  var p = t - 1;
  return 1 + c3 * p * p * p + c1 * p * p;
}

// No overshoot on the rise - a bouncing altitude looks like a tracking error.
function easeOutCubic(t) {
  var p = 1 - t;
  return 1 - p * p * p;
}
