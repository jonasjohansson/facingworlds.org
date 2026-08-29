import * as THREE from "three";

// Normalise a loaded glTF to a known size and pivot, and report the transform used.
//
// The Facing Worlds map is authored at UT scale (roughly 111 x 47 x 42 units) and its
// root node carries a baked translation, so a hardcoded scale is a magic number that
// breaks the moment the export changes. This measures the model instead and fits it to
// a footprint expressed in marker units.
//
// The returned { scale, offset } is not decoration - it is the contract the live
// spectator table is built on. Player poses arrive in game world coordinates, the game
// places the same glTF at the identity transform (see #world in index.html), so
// applying exactly this scale and offset to a pose puts a player on the map they are
// actually standing on. Anything else and they float.

const SCRATCH_TO_LOCAL = new THREE.Matrix4();
const SCRATCH_CHILD = new THREE.Matrix4();
const SCRATCH_BOX = new THREE.Box3();

/**
 * Measure a model and produce the transform that fits it to `size`.
 *
 * @param {THREE.Object3D} model the glTF scene, untouched
 * @param {object} options
 * @param {number} options.size target footprint (longest horizontal axis), parent units
 * @param {string} [options.up] which model axis is up; the map is authored "y"
 * @returns {{ scale: number, offset: THREE.Vector3, size: THREE.Vector3 } | null}
 */
export function measureFit(model, options) {
  const up = options.up || "y";
  const box = localBounds(model);
  if (box.isEmpty()) {
    return null;
  }

  const size = new THREE.Vector3();
  const center = new THREE.Vector3();
  box.getSize(size);
  box.getCenter(center);

  const footprint = up === "y" ? Math.max(size.x, size.z) : Math.max(size.x, size.y);
  if (footprint <= 0) {
    return null;
  }

  // Pull the model onto its own centre horizontally and drop its base to zero
  // vertically, so the parent can place the base with a plain position.
  const offset = new THREE.Vector3(-center.x, -center.y, -center.z);
  if (up === "y") {
    offset.y = -box.min.y;
  } else {
    offset.z = -box.min.z;
  }

  return { scale: options.size / footprint, offset, size };
}

// Union of every child geometry's bounding box, expressed in `root`'s local space.
// THREE.Box3.setFromObject would give world space, which is useless here because the
// tracker matrix above us changes every frame.
function localBounds(root) {
  const box = new THREE.Box3();

  root.updateWorldMatrix(true, true);
  SCRATCH_TO_LOCAL.copy(root.matrixWorld).invert();

  root.traverse((node) => {
    if (!node.isMesh || !node.geometry) {
      return;
    }
    if (!node.geometry.boundingBox) {
      node.geometry.computeBoundingBox();
    }
    SCRATCH_CHILD.multiplyMatrices(SCRATCH_TO_LOCAL, node.matrixWorld);
    SCRATCH_BOX.copy(node.geometry.boundingBox).applyMatrix4(SCRATCH_CHILD);
    box.union(SCRATCH_BOX);
  });

  return box;
}

// three leaves texture anisotropy at 1. In AR the map is nearly always seen at a
// grazing angle, which is the one case where that is clearly visible, so bump it -
// clamped to the device's real limit rather than assumed.
export function sharpenTextures(model, renderer, requested) {
  if (!renderer || requested <= 1) {
    return;
  }

  const anisotropy = Math.min(requested, renderer.capabilities.getMaxAnisotropy());
  const slots = ["map", "normalMap", "roughnessMap", "metalnessMap", "aoMap"];

  model.traverse((node) => {
    if (!node.isMesh || !node.material) {
      return;
    }
    const materials = Array.isArray(node.material) ? node.material : [node.material];
    for (const material of materials) {
      for (const slot of slots) {
        const texture = material[slot];
        if (texture && texture.anisotropy !== anisotropy) {
          texture.anisotropy = anisotropy;
          texture.needsUpdate = true;
        }
      }
    }
  });
}
