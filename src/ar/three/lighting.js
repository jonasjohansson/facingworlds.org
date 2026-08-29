import * as THREE from "three";
import { AR_CONFIG } from "../config/ar-config.js";

// Lighting rig for the AR scene.
//
// EXACTLY TWO real lights, and this time that claim is checkable. The A-Frame version
// of this rig said "two lights" in its own comment while the scene actually ran four,
// because A-Frame injects an ambient and a shadow-casting directional into every scene
// and only withdraws them when its `light` *component* registers a user light - which
// raw THREE lights attached with setObject3D never do. There is no A-Frame here, so
// the scene contains what this function puts in it and nothing else. If you add a
// third light, change this comment.
//
//  1. A directional key that casts the grounding shadow. In AR the model has to look
//     like it is sitting under the viewer's own ceiling light, so the key is
//     warm-white, mostly overhead (+Z in marker space) and raked to one side.
//  2. A hemisphere fill standing in for the room: cool light from above, warm bounce
//     off whatever surface the print is lying on.
//
// Plus an image-based environment, which is not a light but does most of the work: the
// map ships metallic-roughness materials, and metals have no diffuse term, so with
// scene.environment left null every metal surface renders near-black.
//
// The lights are parented to the marker root on purpose. The key direction then stays
// fixed relative to the print instead of swinging around as the tracker matrix changes.

const TONE_MAPPING = {
  no: THREE.NoToneMapping,
  linear: THREE.LinearToneMapping,
  reinhard: THREE.ReinhardToneMapping,
  cineon: THREE.CineonToneMapping,
  ACESFilmic: THREE.ACESFilmicToneMapping,
};

/**
 * @param {THREE.Scene} scene
 * @param {THREE.Object3D} root marker-space root
 * @param {THREE.WebGLRenderer} renderer
 * @returns {{ dispose: () => void }}
 */
export function createLighting(scene, root, renderer) {
  const cfg = AR_CONFIG.lighting;
  const shadowCfg = AR_CONFIG.shadow;

  // --- Tone mapping -------------------------------------------------------------
  const mode = TONE_MAPPING[cfg.toneMapping];
  if (mode === undefined) {
    console.warn("[ar-lighting] unknown tone mapping:", cfg.toneMapping);
  } else {
    renderer.toneMapping = mode;
    renderer.toneMappingExposure = cfg.exposure;
  }

  // --- Light 1 of 2: key --------------------------------------------------------
  const key = new THREE.DirectionalLight(new THREE.Color(cfg.key.color), cfg.key.intensity);
  key.position.set(cfg.key.position.x, cfg.key.position.y, cfg.key.position.z);
  key.castShadow = true;

  // The target has to be a real node under the marker root, otherwise three falls back
  // to a detached target at the world origin and the light direction swings around as
  // the tracker matrix changes.
  key.target.position.set(0, 0, 0);
  root.add(key.target);
  root.add(key);

  const extent = shadowCfg.extent;
  key.shadow.camera.left = -extent;
  key.shadow.camera.right = extent;
  key.shadow.camera.top = extent;
  key.shadow.camera.bottom = -extent;
  key.shadow.camera.near = 0.1;
  key.shadow.camera.far = 12;
  key.shadow.mapSize.set(shadowCfg.mapSize, shadowCfg.mapSize);
  // normalBias beats a plain depth bias here: it kills acne on the map's many grazing
  // surfaces without peter-panning the contact shadow off the print.
  key.shadow.bias = -0.0004;
  key.shadow.normalBias = 0.01;
  key.shadow.camera.updateProjectionMatrix();

  // --- Light 2 of 2: fill -------------------------------------------------------
  const fill = new THREE.HemisphereLight(new THREE.Color(cfg.fill.sky), new THREE.Color(cfg.fill.ground), cfg.fill.intensity);
  fill.position.set(0, 0, 1);
  root.add(fill);

  // --- Environment --------------------------------------------------------------
  let envTarget = null;
  let released = false;

  scene.environmentIntensity = cfg.envIntensity;

  const applyEnvironment = (texture) => {
    if (released) {
      texture.dispose();
      return;
    }

    const pmrem = new THREE.PMREMGenerator(renderer);
    pmrem.compileEquirectangularShader();
    const target = pmrem.fromEquirectangular(texture);
    pmrem.dispose();
    texture.dispose();

    if (envTarget) {
      envTarget.dispose();
    }
    envTarget = target;
    scene.environment = target.texture;
    scene.environmentIntensity = cfg.envIntensity;
  };

  if (!cfg.envMap || preferLightweightEnvironment()) {
    applyEnvironment(proceduralRoomTexture());
  } else {
    new THREE.TextureLoader().load(
      cfg.envMap,
      (texture) => {
        texture.mapping = THREE.EquirectangularReflectionMapping;
        texture.colorSpace = THREE.SRGBColorSpace;
        applyEnvironment(texture);
      },
      undefined,
      () => {
        console.warn("[ar-lighting] env map failed to load, using procedural room");
        applyEnvironment(proceduralRoomTexture());
      }
    );
  }

  return {
    dispose() {
      released = true;
      root.remove(key.target);
      root.remove(key);
      root.remove(fill);
      key.shadow.dispose();
      key.dispose();
      fill.dispose();
      if (envTarget) {
        if (scene.environment === envTarget.texture) {
          scene.environment = null;
        }
        envTarget.dispose();
        envTarget = null;
      }
    },
  };
}

// A multi-megabyte equirect is a lot to ask of a phone that is also streaming camera
// frames. On a metered or memory-poor device, synthesise the environment instead:
// 64x32 pixels, no network, and PMREM smooths it out anyway.
function preferLightweightEnvironment() {
  const connection = navigator.connection;
  if (connection && connection.saveData) {
    return true;
  }
  return typeof navigator.deviceMemory === "number" && navigator.deviceMemory <= 2;
}

function proceduralRoomTexture() {
  const canvas = document.createElement("canvas");
  canvas.width = 64;
  canvas.height = 32;

  const ctx = canvas.getContext("2d");
  const gradient = ctx.createLinearGradient(0, 0, 0, canvas.height);
  gradient.addColorStop(0.0, "#fff4e6"); // ceiling / lamp
  gradient.addColorStop(0.45, "#9db0c6"); // walls
  gradient.addColorStop(0.55, "#5d5a54"); // horizon
  gradient.addColorStop(1.0, "#2e2b27"); // floor
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const texture = new THREE.CanvasTexture(canvas);
  texture.mapping = THREE.EquirectangularReflectionMapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}
