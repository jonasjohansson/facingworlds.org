// pointer-lock-prompt.js — "CLICK TO PLAY", and nothing else.
//
// The game runs on pointer lock now (look-controls pointerLockEnabled on #cam in
// index.html), and pointer lock is the one FPS convention a browser cannot do for you:
// it must be requested from inside a user gesture, so there is always a moment on load,
// and again after every Escape, where the mouse does nothing. Every browser shooter
// puts the same sign up in that moment. Without it the game looks broken for the first
// few seconds — the player moves the mouse, the view does not turn, and there is no
// way to know a click is what is missing.
//
// This owns only the sign. look-controls owns the lock itself: it already listens for a
// canvas click and calls requestPointerLock, so there is nothing here to duplicate and
// no second code path that could disagree with it about when the lock is held.
//
// It hides itself while the player is dead, because the HUD is drawing its own death
// message there and two overlays stacked on the same spot is worse than neither.
AFRAME.registerComponent("pointer-lock-prompt", {
  schema: {
    enabled: { type: "boolean", default: true },
  },

  init() {
    this.el.sceneEl.addEventListener("loaded", () => this.build(), { once: true });
    if (this.el.sceneEl.hasLoaded) this.build();
  },

  build() {
    if (this.prompt) return;

    this.prompt = document.createElement("div");
    this.prompt.className = "ut-lock-prompt";
    this.prompt.setAttribute("aria-live", "polite");
    this.prompt.innerHTML =
      '<b>CLICK TO PLAY</b><span>WASD move &middot; mouse look &middot; click fire &middot; Space jump &middot; Esc release</span>';
    document.body.appendChild(this.prompt);

    this.dead = false;
    // Not a click handler of its own: the prompt is pointer-events: none in the
    // stylesheet, so the click that dismisses it goes straight through to the canvas
    // and look-controls takes the lock. One gesture, one lock, one owner.
    this._onLockChange = () => this.sync();
    this._onDeath = () => {
      this.dead = true;
      this.sync();
    };
    this._onRespawn = () => {
      this.dead = false;
      this.sync();
    };
    document.addEventListener("pointerlockchange", this._onLockChange);
    this.el.sceneEl.addEventListener("local-death", this._onDeath);
    this.el.sceneEl.addEventListener("local-respawn", this._onRespawn);
    this.sync();
  },

  sync() {
    if (!this.prompt) return;
    const show = this.data.enabled && !document.pointerLockElement && !this.dead;
    this.prompt.classList.toggle("is-visible", show);
  },

  update() {
    this.sync();
  },

  remove() {
    document.removeEventListener("pointerlockchange", this._onLockChange);
    this.el.sceneEl.removeEventListener("local-death", this._onDeath);
    this.el.sceneEl.removeEventListener("local-respawn", this._onRespawn);
    if (this.prompt && this.prompt.parentNode) this.prompt.parentNode.removeChild(this.prompt);
    this.prompt = null;
  },
});
