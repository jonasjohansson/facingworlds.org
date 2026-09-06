// world.js — the static scene: map, navmesh, lights, sky. What the <a-scene> markup was.
import * as THREE from "three";
import { ASSETS, attachModel } from "../engine/assets.js";
import { LIGHTS, makeLight } from "./lights.js";
import { EnvironmentMap } from "../systems/environment-map.js";
import { GltfAnimationPointer } from "../systems/gltf-animation-pointer.js";
import { ANISOTROPY, detectTier, QualityTier } from "../systems/quality-tier.js";
import { pixelate } from "../systems/pixelated-texture.js";
import { createNavClamp, mergeNavmesh } from "../player/navclamp.js";

// space-environment's backgroundColor; the sky itself is registered later (Task 5).
const BACKGROUND = 0x000006;

export async function buildWorld(game) {
  const { scene } = game;
  scene.background = new THREE.Color(BACKGROUND);
  game.world = new THREE.Group();
  game.world.name = "world-root";
  scene.add(game.world);

  // The fourteen live lights from the A-Frame markup, at their tuned values. Directional and
  // spot lights carry a `.target` Object3D whose world matrix three reads for the aim
  // direction — it has to be in the graph, so it joins the same group.
  const lights = new THREE.Group();
  lights.name = "map-lights";
  for (const spec of LIGHTS) {
    const light = makeLight(spec);
    lights.add(light);
    if (light.target) lights.add(light.target);
  }
  scene.add(lights);

  /*
    TEXTURE FILTERING HAS TO BE DECIDED BEFORE THE FIRST attachModel. The QualityTier
    system is registered at the bottom of this function because it reads the key light by
    name and the env map by registration — but the global it sets,
    THREE.Texture.DEFAULT_ANISOTROPY, is only read by the Texture CONSTRUCTOR, so it
    reaches nothing GLTFLoader has already built. Detecting the tier here (the same pure
    function QualityTier itself calls, so the two can never disagree) and handing the
    value to pixelate() is what keeps the map's textures at the tier's anisotropy instead
    of a stale 1. Any future loader that runs before the register() call below needs the
    same treatment.
  */
  const anisotropy = ANISOTROPY[detectTier()];

  /*
    World + NavMesh.

    BOTH STAY AT THE IDENTITY TRANSFORM. The x2.33552 world scale that brings CTF-Face
    up to UT99 pawn scale is baked into the two .glb files by
    scripts/optimize-assets.mjs, not applied here. src/ar/config/ar-config.js documents
    a "game world coordinates are IDENTICAL to map-model coordinates" contract and
    src/ar/three/players.js drops raw server poses straight into the map-model node on
    the strength of it; a scale here would break that silently. See
    src/shared/map-transform.js. If the map and the navmesh ever stop matching each
    other exactly, the player floats or sinks.
  */
  const mapNode = new THREE.Group();
  mapNode.name = "world";
  const { root: mapRoot, animations } = await attachModel(mapNode, ASSETS.worldGltf);
  // shadow="cast: true; receive: true". In A-Frame the `shadow` COMPONENT was also what
  // switched renderer.shadowMap on at all (light="castShadow: true" alone did nothing);
  // engine/game.js owns that flag now, so this is purely about the map being both the
  // caster and — the part that was easy to forget — the surface everything lands on.
  mapRoot.traverse((o) => {
    if (o.isMesh) {
      o.castShadow = true;
      o.receiveShadow = true;
    }
  });
  pixelate(mapRoot, { anisotropy });
  game.world.add(mapNode);
  game.map = mapNode;
  game.register(
    "gltf-animation-pointer",
    new GltfAnimationPointer(game, mapRoot, animations, { enabled: true, autoPlay: true, speed: 1.0 })
  );

  // Navmesh: loaded, hidden, kept for the player clamp and the spawn raycast. The
  // aframe-extras' `nav-mesh` component fed movement-controls; player/navclamp.js
  // takes the geometry off this root instead.
  const navNode = new THREE.Group();
  navNode.name = "navmesh";
  const { root: navRoot } = await attachModel(navNode, ASSETS.navmeshGltf);
  navNode.visible = false;
  game.world.add(navNode);
  game.navmesh = navRoot;
  // One world-space triangle soup for three-pathfinding, built once. The clamp caches
  // which polygon the rig is on, so player/controller.js must reset() it on every spawn.
  game.navClamp = createNavClamp(mergeNavmesh(navRoot));

  // Image-based lighting. Registered before quality-tier, which turns its intensity down
  // on the low tier the moment it comes up.
  game.register(
    "environment-map",
    new EnvironmentMap(game, { src: "assets/graphics/space_environment_2k.png", intensity: 1.0, background: false })
  );
  // Last in the world build: it reads the key light by name and the env map by
  // registration, so both have to exist first.
  game.register("quality-tier", new QualityTier(game));
}
