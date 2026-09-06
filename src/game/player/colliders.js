// colliders.js — the map's meshes, flattened once, for raycasts against the world.
//
// A STAND-IN, ON PURPOSE. This is `getWorldColliders()` from
// src/game/components/hitscan.js, which caches the same flat list off the `#world`
// entity's object3D and invalidates it on `model-loaded`. Task 10 ports hitscan; when it
// does, that port becomes the single owner of this list and the controller's floor probe
// imports it from there instead. Until then the two exist side by side — the old one for
// index.html, this one for play.html — and this file is deleted at that point, not kept.
//
// The list is built lazily and cached forever after the first non-empty answer, exactly
// as hitscan's did: `assets.attachModel` parks the map under `game.map` once during
// buildWorld and nothing replaces it afterwards. An empty result is NOT cached, so a
// caller that runs before the glTF has landed simply gets nothing and asks again.
//
// `false` (non-recursive) is what the callers pass to intersectObjects, which is why the
// list has to be flat: every mesh in the model, not the root that contains them.

const EMPTY = [];

let cache = null;
let cacheSource = null;

/**
 * @param {object} game the engine handle; reads `game.map.userData.mesh` (what
 *   `el.getObject3D("mesh")` used to return).
 * @returns {THREE.Mesh[]} flat, cached, safe to hand straight to Raycaster.intersectObjects
 */
export function worldColliders(game) {
  const root = game.map && game.map.userData ? game.map.userData.mesh : null;
  if (!root) return EMPTY;
  if (cache && cacheSource === root) return cache;

  const meshes = [];
  root.traverse((o) => {
    if (o.isMesh && o.geometry) meshes.push(o);
  });
  if (meshes.length === 0) return EMPTY; // not loaded yet — don't cache the empty answer

  cache = meshes;
  cacheSource = root;
  return cache;
}

/** Drop the cache (a map reload, a test). */
export function invalidateWorldColliders() {
  cache = null;
  cacheSource = null;
}
