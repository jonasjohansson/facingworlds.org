// screen-touch-controls.js — Custom touch controls with screen-based movement
AFRAME.registerComponent("screen-touch-controls", {
  schema: {
    enabled: { type: "boolean", default: true },
  },

  init() {
    if (!this.data.enabled) return;

    this.isTouchDevice = "ontouchstart" in window || navigator.maxTouchPoints > 0;
    if (!this.isTouchDevice) return;

    this.isMovingForward = false;
    this.isMovingBackward = false;
    this.isTouching = false;

    // Get the movement-controls component from the rig
    this.rig = this.el.sceneEl.querySelector("#rig");
    if (!this.rig) {
      console.warn("[screen-touch-controls] Rig not found");
      return;
    }

    this.setupTouchEvents();
  },

  setupTouchEvents() {
    // Add touch events for movement only - don't interfere with look-controls
    document.addEventListener(
      "touchstart",
      (e) => {
        // Only handle single touch for movement
        if (e.touches.length === 1) {
          const screenHeight = window.innerHeight;
          const touchY = e.touches[0].clientY;

          if (touchY < screenHeight / 2) {
            this.isMovingForward = true;
            this.isMovingBackward = false;
          } else {
            this.isMovingBackward = true;
            this.isMovingForward = false;
          }

          this.isTouching = true;
        }
      },
      { passive: true }
    );

    document.addEventListener(
      "touchmove",
      (e) => {
        if (e.touches.length === 1 && this.isTouching) {
          const screenHeight = window.innerHeight;
          const touchY = e.touches[0].clientY;

          if (touchY < screenHeight / 2) {
            this.isMovingForward = true;
            this.isMovingBackward = false;
          } else {
            this.isMovingBackward = true;
            this.isMovingForward = false;
          }
        }
      },
      { passive: true }
    );

    document.addEventListener(
      "touchend",
      () => {
        this.stopMovement();
      },
      { passive: true }
    );

    document.addEventListener(
      "touchcancel",
      () => {
        this.stopMovement();
      },
      { passive: true }
    );
  },

  stopMovement() {
    this.isTouching = false;
    this.isMovingForward = false;
    this.isMovingBackward = false;
  },

  tick() {
    if (!this.isTouching || !this.rig) return;

    if (this.isMovingForward || this.isMovingBackward) {
      const camera = this.el.sceneEl.querySelector("#cam");
      const cameraRotation = camera ? camera.getAttribute("rotation") : { y: 0 };

      const rotationY = cameraRotation.y || 0;
      const radians = THREE.MathUtils.degToRad(rotationY);

      const forwardX = Math.sin(radians);
      const forwardZ = Math.cos(radians);

      const direction = this.isMovingForward ? -1 : 1;
      const moveX = forwardX * direction * 0.1;
      const moveZ = forwardZ * direction * 0.1;

      const currentPosition = this.rig.getAttribute("position");
      this.rig.setAttribute("position", {
        x: currentPosition.x + moveX,
        y: currentPosition.y,
        z: currentPosition.z + moveZ,
      });
    }
  },
});
