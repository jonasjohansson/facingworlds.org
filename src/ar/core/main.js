// Import configuration
import { AR_CONFIG } from "../config/ar-config.js";

// Presentation components used by ar/aframe.html, the A-Frame fallback page.
//
// ar/index.html is pure Three.js now and does not go through A-Frame at all - its
// entry point is ../ar.js -> ../three/main.js. This module is what the fallback
// loads, so it must keep registering the A-Frame flavour of these components.
//
// ar-spin is gone on purpose: rotating the model destroys the illusion that it is a
// real object resting on the print, which is the entire point of walking around it.
import "../components/ar-lighting.js";
import "../components/ar-shadow-catcher.js";
import "../components/ar-model-fit.js";
import "../components/ar-reveal.js";
import "../components/ar-music.js";

// Optional components. Not attached by the current scene, but registered so the
// portal presentation can be dropped back in from markup alone.
import "../components/portal.js";
import "../components/canvas-image-source.js";

// AR initialization
document.addEventListener("DOMContentLoaded", () => {
  console.log("Facing Worlds AR initializing with configuration:", AR_CONFIG);
});
