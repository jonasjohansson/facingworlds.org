// game.js — renderer, scene, camera, loop and the system registry.
//
// This is what <a-scene> used to be. Systems are plain objects with update(dt, now) and
// dispose(); they run in REGISTRATION ORDER, every frame, and that order is the contract
// A-Frame used to express implicitly through attachment sequence (see the old main.js, where
// each registration says what it depends on).
import * as THREE from "three";
import { createEvents } from "./events.js";

// A-Frame's camera default. Nothing in the old scene overrode it.
const FOV_DEG = 80;
// near 0.05: A-Frame's 0.005 default wrecked depth precision at range — the Earth's
// cloud shell (0.95 units above the surface, ~500 units out) flickered because both
// landed in one depth bucket. 0.05 gives ~0.30 units of resolution there. It cannot go
// much higher: the view weapon's nearest vertex is 0.325 units from the camera.
// Measured in the running scene, not guessed. (From the old index.html.)
const NEAR = 0.05;
const FAR = 10000;
// Tab-throttled frames are clamped the way ut-controls clamped its own clock.
const MAX_DT = 1 / 20;

export function createGame({ canvas, pixelRatioCap = 2 } = {}) {
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    precision: "highp",
    powerPreference: "high-performance",
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, pixelRatioCap));
  renderer.setSize(window.innerWidth, window.innerHeight);
  // <a-scene renderer="colorManagement: true"> and gltf-viewer-settings.js (ACES, 1.0).
  THREE.ColorManagement.enabled = true;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  // <a-scene shadow="type: pcfsoft">
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  // renderer="sortTransparentObjects: true"
  renderer.sortObjects = true;
  // r180 has no physicallyCorrectLights flag: physical units are the only mode, which is
  // what A-Frame's `physicallyCorrectLights: true` selected. Light intensities in
  // scene/lights.js are therefore copied as-is.

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(FOV_DEG, window.innerWidth / window.innerHeight, NEAR, FAR);

  const events = createEvents();
  const systems = new Map(); // name -> system; insertion order IS update order
  const clock = new THREE.Clock();
  let running = false;
  let renderHook = null; // bloom replaces renderer.render with its composer pass

  function onResize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    for (const s of systems.values()) if (s.resize) s.resize(w, h);
  }
  window.addEventListener("resize", onResize);

  const game = {
    THREE,
    renderer,
    scene,
    camera,
    events,
    systems,
    // Filled in by main.js as the world is built; systems reach them through `game`.
    input: null,
    rig: null,
    player: null,
    world: null,
    map: null,
    navmesh: null,
    navClamp: null,

    register(name, system) {
      if (systems.has(name)) throw new Error(`system "${name}" registered twice`);
      systems.set(name, system);
      return system;
    },
    /** Attach a system to a node so peers can find it the way `el.components[x]` did. */
    attach(node, name, system) {
      (node.userData.systems ||= {})[name] = system;
      return system;
    },
    setRenderHook(fn) {
      renderHook = fn;
    },

    start() {
      if (running) return;
      running = true;
      clock.start();
      renderer.setAnimationLoop(() => {
        const dt = Math.min(clock.getDelta(), MAX_DT);
        const now = performance.now();
        for (const s of systems.values()) if (s.update) s.update(dt, now);
        if (renderHook) renderHook(dt);
        else renderer.render(scene, camera);
      });
    },
    stop() {
      running = false;
      renderer.setAnimationLoop(null);
    },
    dispose() {
      game.stop();
      window.removeEventListener("resize", onResize);
      for (const s of [...systems.values()].reverse()) if (s.dispose) s.dispose();
      systems.clear();
      renderer.dispose();
    },
  };
  return game;
}
