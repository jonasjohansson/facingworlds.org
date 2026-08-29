import { AR_CONFIG } from "../config/ar-config.js";

// Entrance animation for whatever sits on the marker.
//
// Without this the model snaps to full size on the first tracked frame, which reads as
// a glitch. A short rise-and-settle reads as the map arriving.
//
// reset() is called on every marker acquisition, so losing and reacquiring the print
// ten times in a row replays the entrance ten times and never leaves the model
// stranded mid-animation.
export class Reveal {
  constructor(target, onProgress) {
    this.target = target;
    this.onProgress = onProgress || null;
    this.duration = AR_CONFIG.model.reveal.duration;
    this.height = AR_CONFIG.model.hover;
    this.rise = AR_CONFIG.model.reveal.rise;
    this.elapsed = 0;
    this.apply(0);
  }

  reset() {
    this.elapsed = 0;
    this.apply(0);
  }

  /** @param {number} deltaMs */
  update(deltaMs) {
    if (this.elapsed >= this.duration) {
      return;
    }
    this.elapsed = Math.min(this.elapsed + deltaMs, this.duration);
    this.apply(this.elapsed / this.duration);
  }

  apply(t) {
    // Marker space is Z-up, so the entrance is along Z.
    this.target.scale.setScalar(Math.max(easeOutBack(t), 0.0001));
    this.target.position.z = this.height - this.rise * (1 - easeOutCubic(t));
    if (this.onProgress) {
      this.onProgress(t);
    }
  }
}

// Slight overshoot on the scale so the map lands with a bit of weight.
function easeOutBack(t) {
  const c1 = 1.4;
  const c3 = c1 + 1;
  const p = t - 1;
  return 1 + c3 * p * p * p + c1 * p * p;
}

// No overshoot on the rise - a bouncing altitude looks like a tracking error.
function easeOutCubic(t) {
  const p = 1 - t;
  return 1 - p * p * p;
}
