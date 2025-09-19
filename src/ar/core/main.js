// Import modern module loader
import { moduleLoader } from "./module-loader.js";

// Import configuration
import { AR_CONFIG } from "../config/ar-config.js";

// Import custom components
import "../components/canvas-image-source.js";
import "../components/portal.js";

// Modern async initialization
document.addEventListener("DOMContentLoaded", async () => {
  console.log("AR Portal Demo initializing...");

  try {
    // Load all external libraries using modern ES6 approach
    const success = await moduleLoader.loadAll();

    if (success) {
      console.log("AR Portal Demo loaded with configuration:", AR_CONFIG);
      console.log("All modules loaded successfully using modern ES6 approach");
    } else {
      console.error("Failed to load some modules");
    }
  } catch (error) {
    console.error("Error during initialization:", error);
  }
});
