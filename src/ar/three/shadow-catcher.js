import * as THREE from "three";
import { AR_CONFIG } from "../config/ar-config.js";

// Grounding shadow for the AR model. Sits at the origin of the marker root, i.e. flat
// on the printed marker (marker space is Z-up, the print lies in the XY plane).
//
// Two layers, because a cast shadow alone does not sell an object resting on a table:
//
//  1. A THREE.ShadowMaterial plane. Invisible except where the key light is blocked, so
//     it darkens the camera feed exactly under the towers and nowhere else. This is what
//     makes the model look like it is in the room instead of pasted onto it.
//  2. A soft radial "contact" blob painted straight under the model. Real objects
//     hovering above a surface have an ambient-occlusion darkening that a single
//     directional shadow cannot produce, and it costs one 128px canvas texture.
//
// Both are unlit with depth-write off, so the cost is a couple of transparent quads.

/**
 * @returns {{ group: THREE.Group, setReveal: (t: number) => void, dispose: () => void }}
 */
export function createShadowCatcher() {
  const cfg = AR_CONFIG.shadow;
  const group = new THREE.Group();

  const catcherGeometry = new THREE.PlaneGeometry(cfg.size, cfg.size);
  const catcherMaterial = new THREE.ShadowMaterial({
    opacity: cfg.opacity,
    transparent: true,
    depthWrite: false,
  });
  const catcher = new THREE.Mesh(catcherGeometry, catcherMaterial);
  catcher.receiveShadow = true;
  catcher.renderOrder = 1;
  group.add(catcher);

  let blob = null;
  let blobTexture = null;
  if (cfg.blobSize > 0 && cfg.blobOpacity > 0) {
    blobTexture = buildBlobTexture();
    const blobGeometry = new THREE.PlaneGeometry(cfg.blobSize, cfg.blobSize);
    const blobMaterial = new THREE.MeshBasicMaterial({
      map: blobTexture,
      transparent: true,
      opacity: cfg.blobOpacity,
      depthWrite: false,
    });
    blob = new THREE.Mesh(blobGeometry, blobMaterial);
    // Lifted a hair so it never z-fights the catcher.
    blob.position.z = 0.002;
    blob.renderOrder = 2;
    group.add(blob);
  }

  const setReveal = (t) => {
    const p = 1 - t;
    const eased = 1 - p * p * p;
    catcher.material.opacity = cfg.opacity * eased;
    if (blob) {
      blob.material.opacity = cfg.blobOpacity * eased;
    }
  };

  setReveal(0);

  return {
    group,
    setReveal,
    dispose() {
      catcherGeometry.dispose();
      catcherMaterial.dispose();
      if (blob) {
        blob.geometry.dispose();
        blob.material.dispose();
      }
      if (blobTexture) {
        blobTexture.dispose();
      }
      group.clear();
    },
  };
}

function buildBlobTexture() {
  const canvas = document.createElement("canvas");
  canvas.width = 128;
  canvas.height = 128;

  const ctx = canvas.getContext("2d");
  const gradient = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  gradient.addColorStop(0.0, "rgba(0, 0, 0, 1)");
  gradient.addColorStop(0.45, "rgba(0, 0, 0, 0.55)");
  gradient.addColorStop(1.0, "rgba(0, 0, 0, 0)");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 128, 128);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}
