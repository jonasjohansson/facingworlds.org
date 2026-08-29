import { GLTFLoader } from "../vendor/loaders/GLTFLoader.js";
import { DRACOLoader } from "../vendor/loaders/DRACOLoader.js";
import { AR_CONFIG } from "../config/ar-config.js";

// glTF loading for the pure-Three.js AR page.
//
// A-Frame used to supply GLTFLoader out of its bundled three; without A-Frame there is
// no loader in the repo at all, so both it and DRACOLoader are vendored under
// src/ar/vendor/ (three r182 addons against the r180 build in assets/libraries/three -
// every symbol they import was checked against that build).
//
// Draco is needed because assets-optimized/ is written by scripts/optimize-assets.mjs
// with KHR_draco_mesh_compression *required*. The decoder is fetched lazily by
// DRACOLoader, so the plain .gltf fallback never pays the ~250 KB.

let dracoLoader = null;

/**
 * Build the shared glTF loader. One instance for the whole page: DRACOLoader spins up
 * web workers, and a second loader would spin up a second pool.
 *
 * @param {THREE.LoadingManager} [manager]
 * @returns {GLTFLoader}
 */
export function createGLTFLoader(manager) {
  const loader = new GLTFLoader(manager);

  if (!dracoLoader) {
    dracoLoader = new DRACOLoader(manager);
    dracoLoader.setDecoderPath(AR_CONFIG.assets.dracoDecoder);
    // Explicitly wasm. encantar itself cannot run without WebAssembly (speedy-vision
    // is a wasm module), so the 512 KB asm.js decoder would be dead weight and is not
    // vendored - asking for it by accident would 404.
    dracoLoader.setDecoderConfig({ type: "wasm" });
  }
  loader.setDRACOLoader(dracoLoader);

  return loader;
}

/**
 * Try each URL in order and resolve with the first that loads.
 *
 * assets-optimized/ is gitignored, so on a fresh clone the optimized map is simply not
 * there. That must degrade to the original glTF rather than to a blank AR page.
 *
 * @param {GLTFLoader} loader
 * @param {string[]} urls best first
 * @param {string} label for logging
 * @returns {Promise<object>} the GLTF result
 */
export async function loadFirstAvailable(loader, urls, label) {
  let lastError = null;

  for (const url of urls) {
    try {
      const gltf = await loader.loadAsync(url);
      console.info(`[ar] ${label}: loaded ${url}`);
      return gltf;
    } catch (error) {
      lastError = error;
      console.warn(`[ar] ${label}: ${url} failed (${error && error.message}), trying next`);
    }
  }

  throw lastError || new Error(`[ar] ${label}: no source could be loaded`);
}

/**
 * Release a loaded glTF scene. three does not walk the graph for you, and this page
 * can outlive several marker acquisitions.
 *
 * @param {THREE.Object3D} root
 */
export function disposeModel(root) {
  const seenMaterials = new Set();
  const seenTextures = new Set();

  root.traverse((node) => {
    if (!node.isMesh) {
      return;
    }
    if (node.geometry) {
      node.geometry.dispose();
    }
    const materials = Array.isArray(node.material) ? node.material : [node.material];
    for (const material of materials) {
      if (!material || seenMaterials.has(material)) {
        continue;
      }
      seenMaterials.add(material);
      for (const key of Object.keys(material)) {
        const value = material[key];
        if (value && value.isTexture && !seenTextures.has(value)) {
          seenTextures.add(value);
          value.dispose();
        }
      }
      material.dispose();
    }
  });
}

/** Free the shared Draco worker pool. Called when the session ends. */
export function disposeLoaders() {
  if (dracoLoader) {
    dracoLoader.dispose();
    dracoLoader = null;
  }
}
