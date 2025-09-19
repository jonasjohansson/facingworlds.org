// Import configuration
import { AR_CONFIG } from "../config/ar-config.js";

// Import custom components
import "../components/canvas-image-source.js";
import "../components/portal.js";

// AR initialization
document.addEventListener("DOMContentLoaded", () => {
  console.log("AR Portal Demo initializing...");
  console.log("AR Portal Demo loaded with configuration:", AR_CONFIG);
});
