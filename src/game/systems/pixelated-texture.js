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

/**
 * Apply nearest-neighbour magnification to every baseColor map under `root`, and — when
 * `anisotropy` is given — the tier's anisotropic filtering to every texture under it.
 *
 * WHY ANISOTROPY IS PASSED IN RATHER THAN LEFT TO THE RENDERER. A texture reads
 * THREE.Texture.DEFAULT_ANISOTROPY once, in its CONSTRUCTOR. systems/quality-tier.js sets
 * that global, but it is registered at the END of buildWorld (it needs the key light and
 * the env map to exist), by which point GLTFLoader has long since constructed the map's
 * textures — they would keep anisotropy 1 forever while everything loaded afterwards got
 * 8. So scene/world.js reads the tier with `detectTier()` before its first attachModel and
 * hands the value here. Anything else that loads textures before quality-tier is
 * registered has to do the same.
 */
export function pixelate(root, { anisotropy } = {}) {
  if (!root) return;
  root.traverse((child) => {
    if (!child.isMesh || !child.material) return;
    // The old component tested `child.material.map` before checking whether material was
    // an array — and on an array that reads Array.prototype.map, a function, which it
    // then set filter properties on. Normalising first does what it meant to do.
    const materials = Array.isArray(child.material) ? child.material : [child.material];
    for (const material of materials) {
      if (!material) continue;
      if (material.map) makeTexturePixelated(material.map);
      if (typeof anisotropy !== "number") continue;
      // Every slot, not just baseColor: the normal and occlusionRoughnessMetallic maps
      // are sampled at the same grazing angles as the albedo and shimmer the same way.
      for (const value of Object.values(material)) {
        if (value && value.isTexture && value.anisotropy !== anisotropy) {
          value.anisotropy = anisotropy;
          value.needsUpdate = true;
        }
      }
    }
  });
}
