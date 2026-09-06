// AR entry point.
//
// ar/index.html is pure Three.js: no A-Frame, no shared A-Frame components. Everything
// it needs hangs off this one module, which the page loads with type="module" so the
// import map in its <head> resolves the bare "three" specifier for the whole graph.
import "./src/ar/three/main.js";
