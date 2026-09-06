// pixelated-texture.js — retro texture filtering for the UT99 art.
//
// Was `pixelated-texture`, an A-Frame component on #world that waited for `model-loaded`
// and then walked the mesh. There is no event to wait for now: assets.attachModel resolves
// with the root, so this is a plain function the caller runs on it.
import * as THREE from "three";

/**
 * magFilter is what gives the retro look: it governs magnification, so texels stay
 * as hard squares up close instead of being smeared by bilinear filtering.
 */
function makeTexturePixelated(texture) {
  texture.magFilter = THREE.NearestFilter;
  // minFilter governs MINIFICATION, and a plain NearestFilter here means no mip chain
  // at all. On the map's 4096px baseColor that shimmers badly under motion at distance,
  // and it silently disables the renderer's anisotropy: 8 (anisotropic filtering needs
  // mipmaps). Nearest within a mip level keeps the crunchy look; linear between levels
  // is what removes the shimmer.
  texture.minFilter = THREE.NearestMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.needsUpdate = true;
}

/** Apply nearest-neighbour magnification to every baseColor map under `root`. */
export function pixelate(root) {
  if (!root) return;
  root.traverse((child) => {
    if (!child.isMesh || !child.material) return;
    // The old component tested `child.material.map` before checking whether material was
    // an array — and on an array that reads Array.prototype.map, a function, which it
    // then set filter properties on. Normalising first does what it meant to do.
    const materials = Array.isArray(child.material) ? child.material : [child.material];
    for (const material of materials) {
      if (material && material.map) makeTexturePixelated(material.map);
    }
  });
}
