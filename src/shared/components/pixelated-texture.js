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
    // magFilter is what gives the retro look: it governs magnification, so texels stay
    // as hard squares up close instead of being smeared by bilinear filtering.
    texture.magFilter = THREE.NearestFilter;
    // minFilter governs MINIFICATION, and a plain NearestFilter here means no mip chain
    // at all. On the map's 4096px baseColor that shimmers badly under motion at distance,
    // and it silently disables the renderer's anisotropy: 8 (anisotropic filtering needs
    // mipmaps). Nearest within a mip level keeps the crunchy look; linear between levels
    // is what removes the shimmer.
    texture.minFilter = THREE.NearestMipmapLinearFilter;
    texture.generateMipmaps = true;
    texture.needsUpdate = true;
  },
});
