// assets.js — glTF loading: one loader, one cache. What <a-assets> + gltf-model were.
import { GLTFLoader } from "../../ar/vendor/loaders/GLTFLoader.js";
import { DRACOLoader } from "../../ar/vendor/loaders/DRACOLoader.js";
import { clone as cloneSkinned } from "../../ar/vendor/utils/SkeletonUtils.js";

// The URLs <a-assets> used to hold, keyed by their old ids. Models come from
// assets-optimized/, the committed output of `npm run optimize:assets`
// (scripts/optimize-assets.mjs): 35.27 MB -> 4.48 MB. The originals under assets/3d/ are
// the INPUTS to that script and are no longer downloaded by the browser. They are .glb
// whatever the source extension, and carry EXT_texture_webp (GLTFLoader handles it
// unconditionally) and KHR_draco_mesh_compression (the decoder below). Do NOT point these
// back at assets/ without regenerating — the two trees are not interchangeable by URL.
export const ASSETS = {
  worldGltf: "assets-optimized/3d/map/FacingWorlds_tex_5.glb",
  navmeshGltf: "assets-optimized/3d/navmesh.glb",
  soldierModel: "assets-optimized/3d/Soldier.glb",
  enforcerWeapon: "assets-optimized/3d/enforcer.glb",
  // The file the old background-music component actually fetched (its schema default; the
  // markup never overrode it). <a-assets> also DECLARED the 12.7 MB "-gameplay-audio" mix
  // under the same id, but nothing ever played that one, so it is not listed here.
  backgroundMusic: "assets/audio/110-van_den_bos--foregone_destruction-i.mp3",
  fireSound: "assets/audio/fire.wav",
};

// A-Frame's gltf-model system defaulted dracoDecoderPath to the gstatic CDN, which left
// the map, gun and soldier undecodable whenever that host was blocked or offline. The
// decoder is vendored here, shared with the AR page, so nothing is fetched from a third
// party. Relative to the page, which is the site root for the game.
const DRACO_PATH = "src/ar/vendor/draco/";

const draco = new DRACOLoader().setDecoderPath(DRACO_PATH);
// Only the wasm decoder is vendored; asking for asm.js by accident would 404.
draco.setDecoderConfig({ type: "wasm" });
const loader = new GLTFLoader().setDRACOLoader(draco);
const cache = new Map(); // url -> Promise<gltf>

/** Load once; later callers share the parsed glTF. Clone before adding to the scene. */
export function loadGltf(url) {
  if (!cache.has(url)) {
    const p = loader.loadAsync(url).catch((err) => {
      cache.delete(url); // let a retry re-fetch rather than re-reject forever
      throw err;
    });
    cache.set(url, p);
  }
  return cache.get(url);
}

/**
 * gltf-model, as a function: parks a fresh instance of the model under `node`, remembers
 * it as node.userData.mesh (what getObject3D("mesh") returned), and resolves to
 * { root, animations }. Replacing a previous model removes it first, as gltf-model did.
 *
 * Morph-target models (the UT99 pawn and weapon meshes) clone correctly with
 * Object3D.clone — morph influences are copied per mesh. A SKINNED model (Soldier.glb,
 * the local body) does not: SkinnedMesh.copy shares the skeleton, so a plain clone is a
 * bind pose bound to bones nothing updates. Those go through SkeletonUtils.clone, which
 * rebuilds the skeleton against the cloned bone hierarchy.
 */
export async function attachModel(node, url) {
  const gltf = await loadGltf(url);
  const root = hasSkinnedMesh(gltf.scene) ? cloneSkinned(gltf.scene) : gltf.scene.clone(true);
  const previous = node.userData.mesh;
  if (previous) node.remove(previous);
  node.add(root);
  node.userData.mesh = root;
  return { root, animations: gltf.animations };
}

function hasSkinnedMesh(root) {
  let found = false;
  root.traverse((o) => {
    if (o.isSkinnedMesh) found = true;
  });
  return found;
}

export function disposeAssets() {
  cache.clear();
  draco.dispose();
}
