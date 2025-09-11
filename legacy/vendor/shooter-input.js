// /js/shooter-input.js
AFRAME.registerComponent("shooter-input", {
  init() {
    this.isDown = false;

    this._onDown = (e) => {
      if (e.button === 0) {
        this.isDown = true;
        this.el.emit("shooter:trigger", { down: true });
      }
    };
    this._onUp = (e) => {
      if (e.button === 0) {
        this.isDown = false;
        this.el.emit("shooter:trigger", { down: false });
      }
    };
    this._onContext = (e) => e.preventDefault();

    const attach = (canvas) => {
      if (!canvas) return;
      canvas.addEventListener("mousedown", this._onDown);
      window.addEventListener("mouseup", this._onUp);
      canvas.addEventListener("contextmenu", this._onContext);
      // Pointer lock quality-of-life
      canvas.addEventListener("click", () => {
        if (document.pointerLockElement !== canvas) canvas.requestPointerLock?.();
      });
    };

    const scene = this.el.sceneEl;
    if (scene.hasLoaded && scene.canvas) attach(scene.canvas);
    else scene.addEventListener("loaded", () => attach(scene.canvas), { once: true });
  },
  remove() {
    const canvas = this.el.sceneEl && this.el.sceneEl.canvas;
    if (canvas) {
      canvas.removeEventListener("mousedown", this._onDown);
      window.removeEventListener("mouseup", this._onUp);
      canvas.removeEventListener("contextmenu", this._onContext);
    }
  },
});
