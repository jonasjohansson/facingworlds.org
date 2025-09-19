// Pixelated texture component for retro-style rendering
AFRAME.registerComponent("pixelated-texture", {
  init: function () {
    this.el.addEventListener("model-loaded", () => {
      this.applyPixelatedFiltering();
    });
  },

  applyPixelatedFiltering: function () {
    const model = this.el.getObject3D("mesh");
    if (!model) return;

    model.traverse((child) => {
      if (child.isMesh && child.material) {
        // Handle single material
        if (child.material.map) {
          this.makeTexturePixelated(child.material.map);
        }

        // Handle material array
        if (Array.isArray(child.material)) {
          child.material.forEach((material) => {
            if (material.map) {
              this.makeTexturePixelated(material.map);
            }
          });
        }
      }
    });
  },

  makeTexturePixelated: function (texture) {
    texture.magFilter = THREE.NearestFilter;
    texture.minFilter = THREE.NearestFilter;
    texture.generateMipmaps = false;
    texture.needsUpdate = true;
  },
});
