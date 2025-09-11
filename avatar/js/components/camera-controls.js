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
    // Find all camera entities
    this.cameras.firstPerson = document.querySelector("#cam");
    this.cameras.thirdPerson = document.querySelector("#mapcam");
    this.cameras.fixed = document.querySelector("#fixedcam");

    if (!this.cameras.firstPerson) {
      console.warn("[camera-controls] First person camera (#cam) not found");
    }
    if (!this.cameras.thirdPerson) {
      console.warn("[camera-controls] Third person camera (#mapcam) not found");
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
    this.currentMode = (this.currentMode + 1) % 3;
    this.switchCamera();

    const modeNames = ["1st Person", "3rd Person", "Fixed Overhead"];
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
    const modeNames = ["1st Person", "3rd Person", "Fixed Overhead"];

    switch (this.currentMode) {
      case 0: // 1st Person
        activeCamera = this.cameras.firstPerson;
        if (activeCamera) {
          activeCamera.setAttribute("camera", "active", true);
          // Position camera at eye level (higher up in the head)
          activeCamera.setAttribute("position", "0 1.8 0");
        }
        break;

      case 1: // 3rd Person
        activeCamera = this.cameras.thirdPerson;
        if (activeCamera) {
          activeCamera.setAttribute("camera", "active", true);
          // Configure for Unreal Tournament-style 3rd person view
          activeCamera.setAttribute("orbit-camera", {
            target: "#rig",
            radius: 6,
            minRadius: 3,
            maxRadius: 15,
            polar: 15, // Lower angle for more behind-the-character view
            azimuth: 0,
            rotateSpeed: 0.25,
            zoomSpeed: 1,
            height: 1.5, // Slightly above the character
          });
        }
        break;

      case 2: // Fixed Overhead
        activeCamera = this.cameras.fixed;
        if (activeCamera) {
          activeCamera.setAttribute("camera", "active", true);
          // Position fixed camera straight above looking down
          activeCamera.setAttribute("position", "0 40 0");
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
