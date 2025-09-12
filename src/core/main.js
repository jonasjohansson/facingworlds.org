// Import utility modules first
import "../utils/three-helpers.js";
import "../utils/dom-helpers.js";
import "../utils/animation-helpers.js";
import "../utils/environment.js";
import "../utils/error-handler.js";
import "../utils/performance.js";

// Import configuration
import "../config/game-config.js";

// Import system modules
import "../systems/checker.js";

// Import component modules
import "../components/bullet.js";
import "../components/blaster.js";
import "../components/character.js";
import "../components/health.js";
import "../components/remote-avatar.js";
import "../components/camera-controls.js";
import "../components/rotate-yaw.js";
import "../components/animation-pointer.js";
import "../components/animated-materials.js";
import "../components/animated-curtain.js";
import "../components/gltf-animation-pointer.js";
import "../components/advanced-material-animation.js";
import "../components/bullet-audio.js";
import "../components/background-music.js";
import "../components/space-environment.js";
import "../components/gui-controls.js";

// Import network and spawn modules
import startNetwork from "../network/network.js";
import placePlayerOnNavmesh from "./spawn.js";

import { performanceMonitor } from "../utils/performance.js";
import { handleError } from "../utils/error-handler.js";
import { GAME_CONFIG } from "../config/game-config.js";

document.addEventListener("DOMContentLoaded", () => {
  try {
    // Start performance monitoring
    performanceMonitor.startMonitoring();

    const scene = document.querySelector("a-scene");
    const spawn = () => {
      try {
        // place player rig onto the navmesh center
        placePlayerOnNavmesh();
        // start networking after scene + soldier exist
        startNetwork();
      } catch (error) {
        handleError(error, "Game initialization");
      }
    };

    if (scene.hasLoaded) spawn();
    else scene.addEventListener("loaded", spawn);
  } catch (error) {
    handleError(error, "DOM Content Loaded");
  }
});
