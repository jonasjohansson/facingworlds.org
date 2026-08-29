// AR entry point.
//
// ar/index.html is pure Three.js: no A-Frame, no shared A-Frame components. Everything
// it needs hangs off this one module, which the page loads with type="module" so the
// import map in its <head> resolves the bare "three" specifier for the whole graph.
//
// The previous A-Frame page is preserved at ar/aframe.html and loads
// src/ar/core/main.js directly, so it does not depend on this file at all.
import "./src/ar/three/main.js";
