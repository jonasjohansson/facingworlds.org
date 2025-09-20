// screen-touch-controls.js — Custom touch controls with screen-based movement
console.log("[screen-touch-controls] Component script loaded");

AFRAME.registerComponent("screen-touch-controls", {
  schema: {
    enabled: { type: "boolean", default: true },
  },

  init() {
    console.log("[screen-touch-controls] Component init called, enabled:", this.data.enabled);

    if (!this.data.enabled) {
      console.log("[screen-touch-controls] Component disabled, exiting");
      return;
    }

    this.isTouchDevice = "ontouchstart" in window || navigator.maxTouchPoints > 0;
    console.log("[screen-touch-controls] Touch device detected:", this.isTouchDevice);
    console.log("[screen-touch-controls] ontouchstart in window:", "ontouchstart" in window);
    console.log("[screen-touch-controls] navigator.maxTouchPoints:", navigator.maxTouchPoints);

    if (!this.isTouchDevice) {
      console.log("[screen-touch-controls] Not a touch device, exiting");
      return;
    }

    this.isMovingForward = false;
    this.isMovingBackward = false;
    this.isTouching = false;

    // Get the movement-controls component from the rig
    this.rig = this.el.sceneEl.querySelector("#rig");
    if (!this.rig) {
      console.warn("[screen-touch-controls] Rig not found");
      return;
    }

    console.log("[screen-touch-controls] Component initialized successfully");
    this.setupTouchEvents();
  },

  setupTouchEvents() {
    console.log("[screen-touch-controls] Setting up touch events");

    // Add touch events for movement only - don't interfere with look-controls
    document.addEventListener(
      "touchstart",
      (e) => {
        // Only handle single touch for movement
        if (e.touches.length === 1) {
          const screenHeight = window.innerHeight;
          const touchY = e.touches[0].clientY;

          console.log("[screen-touch-controls] Touch start detected:", touchY, "Screen height:", screenHeight);

          // Determine if touch is in top or bottom half of screen
          if (touchY < screenHeight / 2) {
            // Top half - move forward
            this.isMovingForward = true;
            this.isMovingBackward = false;
            console.log("[screen-touch-controls] Moving forward");
          } else {
            // Bottom half - move backward
            this.isMovingBackward = true;
            this.isMovingForward = false;
            console.log("[screen-touch-controls] Moving backward");
          }

          this.isTouching = true;

          // Don't prevent default - let look-controls handle the touch
          // e.preventDefault();
          // e.stopPropagation();
        }
      },
      { passive: true } // Make it passive so look-controls can work
    );

    // Add touchmove for continuous movement while dragging
    document.addEventListener(
      "touchmove",
      (e) => {
        if (e.touches.length === 1 && this.isTouching) {
          const screenHeight = window.innerHeight;
          const touchY = e.touches[0].clientY;

          // Update movement direction based on current touch position
          if (touchY < screenHeight / 2) {
            // Top half - move forward
            this.isMovingForward = true;
            this.isMovingBackward = false;
          } else {
            // Bottom half - move backward
            this.isMovingBackward = true;
            this.isMovingForward = false;
          }
        }
      },
      { passive: true } // Make it passive so look-controls can work
    );

    document.addEventListener(
      "touchend",
      (e) => {
        console.log("[screen-touch-controls] Touch end detected");
        this.stopMovement();
      },
      { passive: true } // Make it passive so look-controls can work
    );

    document.addEventListener(
      "touchcancel",
      (e) => {
        console.log("[screen-touch-controls] Touch cancel detected");
        this.stopMovement();
      },
      { passive: true } // Make it passive so look-controls can work
    );
  },

  stopMovement() {
    this.isTouching = false;
    this.isMovingForward = false;
    this.isMovingBackward = false;
    console.log("[screen-touch-controls] Stopped moving");
  },

  tick() {
    if (!this.isTouching || !this.rig) {
      if (this.isTouching && !this.rig) {
        console.log("[screen-touch-controls] TICK: isTouching but no rig");
      }
      return;
    }

    if (this.isMovingForward || this.isMovingBackward) {
      console.log("[screen-touch-controls] TICK: Moving - Forward:", this.isMovingForward, "Backward:", this.isMovingBackward);

      // Simple direct movement - just move forward/backward based on camera direction
      const camera = this.el.sceneEl.querySelector("#cam");
      const cameraRotation = camera ? camera.getAttribute("rotation") : { y: 0 };

      // Use camera's Y rotation (yaw) for movement direction
      const rotationY = cameraRotation.y || 0;
      const radians = THREE.MathUtils.degToRad(rotationY);

      // Calculate forward direction
      const forwardX = Math.sin(radians);
      const forwardZ = Math.cos(radians);

      // Apply movement (forward or backward)
      const direction = this.isMovingForward ? -1 : 1; // Negative for forward in A-Frame
      const moveX = forwardX * direction * 0.1;
      const moveZ = forwardZ * direction * 0.1;

      // Direct position update - simple and working
      const currentPosition = this.rig.getAttribute("position");
      this.rig.setAttribute("position", {
        x: currentPosition.x + moveX,
        y: currentPosition.y,
        z: currentPosition.z + moveZ,
      });
    }
  },
});
