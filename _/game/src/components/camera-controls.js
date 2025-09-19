// camera-controls.js — Camera cycling system (1st POV, 3rd person, fixed cam)
AFRAME.registerComponent("camera-controls", {
  schema: {
    // Camera modes: 0 = 1st person, 1 = 3rd person, 2 = fixed overhead
    mode: { type: "int", default: 0 },
    // Key to cycle cameras
    cycleKey: { type: "string", default: "KeyC" },
  },

  init() {
    this.cameras = {
      firstPerson: null, // #cam (1st person)
      thirdPerson: null, // #mapcam (3rd person/orbit)
      fixed: null, // #fixedcam (overhead)
    };

    this.currentMode = this.data.mode;
    this.setupCameras();
    this.setupKeyboard();

    // Set initial camera
    this.switchCamera();
  },

  setupCameras() {
    // Find camera entities (only 2 cameras now)
    this.cameras.firstPerson = document.querySelector("#cam");
    this.cameras.fixed = document.querySelector("#fixedcam");

    if (!this.cameras.firstPerson) {
      console.warn("[camera-controls] First person camera (#cam) not found");
    }
    if (!this.cameras.fixed) {
      console.warn("[camera-controls] Fixed camera (#fixedcam) not found");
    }
  },

  setupKeyboard() {
    this.onKeyDown = (event) => {
      if (event.code === this.data.cycleKey) {
        this.cycleCamera();
        event.preventDefault();
      }
    };

    document.addEventListener("keydown", this.onKeyDown);
  },

  cycleCamera() {
    this.currentMode = (this.currentMode + 1) % 2;
    this.switchCamera();

    const modeNames = ["1st Person", "Bird's Eye"];
    console.log(`[camera-controls] Switched to ${modeNames[this.currentMode]} view`);
  },

  switchCamera() {
    // Deactivate all cameras first
    Object.values(this.cameras).forEach((camera) => {
      if (camera) {
        camera.setAttribute("camera", "active", false);
      }
    });

    // Activate the current camera
    let activeCamera = null;
    const modeNames = ["1st Person", "Bird's Eye"];

    switch (this.currentMode) {
      case 0: // 1st Person
        activeCamera = this.cameras.firstPerson;
        if (activeCamera) {
          activeCamera.setAttribute("camera", "active", true);
          // Position camera at eye level (higher up in the head)
          activeCamera.setAttribute("position", "0 1.8 0");
        }
        break;

      case 1: // Bird's Eye
        activeCamera = this.cameras.fixed;
        if (activeCamera) {
          activeCamera.setAttribute("camera", "active", true);
          // Position fixed camera straight above looking down
          activeCamera.setAttribute("position", "0 60 0");
          activeCamera.setAttribute("rotation", "-90 0 0");
        }
        break;
    }

    if (!activeCamera) {
      console.warn(`[camera-controls] Camera for mode ${this.currentMode} not found`);
    } else {
      // Show camera mode indicator
      this.showCameraModeIndicator(modeNames[this.currentMode]);
    }
  },

  showCameraModeIndicator: function (modeName) {
    // Create or update camera mode indicator
    let indicator = document.querySelector("#camera-mode-indicator");
    if (!indicator) {
      indicator = document.createElement("div");
      indicator.id = "camera-mode-indicator";
      indicator.style.cssText = `
        position: fixed;
        top: 20px;
        right: 20px;
        background: rgba(0, 0, 0, 0.7);
        color: white;
        padding: 10px 15px;
        border-radius: 5px;
        font-family: Arial, sans-serif;
        font-size: 14px;
        z-index: 1000;
        pointer-events: none;
        transition: opacity 0.3s ease;
      `;
      document.body.appendChild(indicator);
    }

    indicator.textContent = `Camera: ${modeName} (Press C to cycle)`;
    indicator.style.opacity = "1";

    // Fade out after 3 seconds
    setTimeout(() => {
      if (indicator) {
        indicator.style.opacity = "0.3";
      }
    }, 3000);
  },

  remove() {
    if (this.onKeyDown) {
      document.removeEventListener("keydown", this.onKeyDown);
    }
  },
});
