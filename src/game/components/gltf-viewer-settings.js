// GLTF Viewer Settings - Don McCurdy Environment
AFRAME.registerComponent("gltf-viewer-settings", {
  init: function () {
    const scene = this.el;
    const renderer = scene.renderer;

    // Wait for renderer to be ready
    scene.addEventListener("renderstart", () => {
      // Tone Mapping
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = -1.22;

      // Environment
      scene.environment = null; // Neutral environment

      // Punctual Lights
      renderer.useLegacyLights = false;
    });
  },
});
