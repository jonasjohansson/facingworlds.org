import * as THREE from "three";
import { AR_CONFIG } from "../config/ar-config.js";
import { createGLTFLoader, loadFirstAvailable, disposeModel, disposeLoaders } from "./assets.js";
import { measureFit, sharpenTextures } from "./model-fit.js";
import { createLighting } from "./lighting.js";
import { createShadowCatcher } from "./shadow-catcher.js";
import { Reveal } from "./reveal.js";
import { SpectatorTable } from "./players.js";

// Everything that goes on the marker, and nothing about the AR session.
//
// Split out from main.js so it can be built against any { scene, root, camera,
// renderer } - which is exactly what the encantar plugin's ARSystem is, and also what
// a test harness can hand it on a machine with no camera.
//
// SCENE GRAPH, and the reason it is shaped this way:
//
//   root                   marker space, Z-up, the print spans ~2 units
//    +- shadowCatcher      flat on the print
//    +- stage              rotation.x = +PI/2, so the map's Y-up becomes marker Z-up;
//       |                  the reveal animation drives this node's scale and height
//       +- fit             scale = measured fit scale
//          +- world        position = measured centring offset
//             +- map       the glTF, untouched, at the identity
//             +- players   live figures, at raw game-world coordinates
//
// `world` is GAME WORLD SPACE. The game places this same glTF at the identity (see
// #world in index.html), so a pose from the server is written into `world` verbatim and
// lands on the map. Nothing is hardcoded: the scale and offset are measured from the
// glTF's own bounds by model-fit.js, so a re-export moves the figures with the map.

/**
 * @param {{scene: THREE.Scene, root: THREE.Object3D, camera: THREE.Camera, renderer: THREE.WebGLRenderer}} ar
 * @param {object} [options]
 * @param {string|null} [options.spectatorUrl] null to skip the live connection
 * @param {(state: string, count: number) => void} [options.onSpectatorStatus]
 */
export async function buildScene(ar, options = {}) {
  const renderer = ar.renderer;

  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const lighting = createLighting(ar.scene, ar.root, renderer);

  const shadowCatcher = createShadowCatcher();
  ar.root.add(shadowCatcher.group);

  // Marker space is Z-up; the map is authored Y-up.
  const stage = new THREE.Group();
  stage.rotation.x = Math.PI / 2;
  ar.root.add(stage);

  const fit = new THREE.Group();
  stage.add(fit);

  const world = new THREE.Group();
  // Hidden until the map has been measured. `fit` is still at scale 1 and `world` at
  // the origin until then, so anything parented here would render at raw game scale -
  // a 1.75-unit player standing on a 2.2-unit marker, i.e. a capsule taller than the
  // whole table. The connection is opened before the download finishes on purpose, so
  // this window is real.
  world.visible = false;
  fit.add(world);

  const reveal = new Reveal(stage, (t) => shadowCatcher.setReveal(t));

  // The table is wired before the map downloads, so a player who is already connected
  // appears the instant the marker is found rather than after the glTF lands.
  const table = new SpectatorTable(world);
  if (options.onSpectatorStatus) {
    table.onStatusChange = options.onSpectatorStatus;
  }
  if (options.spectatorUrl) {
    table.connect(options.spectatorUrl);
  }

  const built = {
    stage,
    world,
    reveal,
    shadowCatcher,
    lighting,
    table,
    map: null,
    fit: null,
    dispose() {
      table.dispose();
      if (built.map) {
        built.map.removeFromParent();
        disposeModel(built.map);
        built.map = null;
      }
      shadowCatcher.group.removeFromParent();
      shadowCatcher.dispose();
      lighting.dispose();
      stage.removeFromParent();
      disposeLoaders();
    },
  };

  const loader = createGLTFLoader();
  let gltf;
  try {
    gltf = await loadFirstAvailable(loader, AR_CONFIG.assets.map, "map");
  } catch (error) {
    // A missing map is not a dead page: tracking, lighting and the shadow catcher still
    // work. Figures stay hidden - without the map there is no measured fit, so there is
    // no scale at which a player figure means anything. Degraded, but honest.
    console.error("[ar] map failed to load; continuing without it", error);
    built.error = "Map assets could not be loaded.";
    return built;
  }

  const map = gltf.scene;
  const fitResult = measureFit(map, { size: AR_CONFIG.model.size, up: "y" });
  if (!fitResult) {
    console.error("[ar] map has no measurable bounds; not placing it");
    disposeModel(map);
    built.error = "Map assets could not be measured.";
    return built;
  }

  fit.scale.setScalar(fitResult.scale);
  world.position.copy(fitResult.offset);
  // Game world space is now real: figures can be shown.
  world.visible = true;

  map.traverse((node) => {
    if (node.isMesh) {
      node.castShadow = true;
      node.receiveShadow = true;
      // The map is a single mesh that is wholly on screen whenever the marker is
      // tracked, so per-object frustum culling is pure overhead.
      node.frustumCulled = false;
    }
  });
  sharpenTextures(map, renderer, AR_CONFIG.model.anisotropy);

  world.add(map);
  built.map = map;
  built.fit = fitResult;

  console.info(
    `[ar] map fitted: scale=${fitResult.scale.toFixed(6)} bounds=${fitResult.size
      .toArray()
      .map((n) => n.toFixed(1))
      .join(" x ")}`
  );

  precompile(ar);

  return built;
}

// Compile shaders up front. Otherwise the first tracked frame - the one where the user
// is holding the phone still, deciding whether this works - is the frame that pays for
// every program in the map.
//
// compile() gathers lights with traverseVisible, and the encantar plugin keeps the
// marker origin hidden until a target is found, so the lights would be missed and the
// programs rebuilt on that first frame anyway. Reveal the origin for the duration of
// the call; the plugin rewrites its visibility every frame regardless.
function precompile(ar) {
  const origin = ar.root.parent;
  const wasVisible = origin ? origin.visible : false;
  if (origin) {
    origin.visible = true;
  }
  try {
    ar.renderer.compile(ar.scene, ar.camera);
  } catch (error) {
    console.warn("[ar] shader precompile skipped:", error && error.message);
  }
  if (origin) {
    origin.visible = wasVisible;
  }
}
