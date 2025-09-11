// Import utility modules first
import "./utils/three-helpers.js";
import "./utils/dom-helpers.js";
import "./utils/animation-helpers.js";

// Import system modules
import "./systems/checker.js";
import "./systems/targets.js";

// Import component modules
import "./components/bullet.js";
import "./components/blaster.js";
import "./components/character.js";
import "./components/health.js";
import "./components/remote-avatar.js";
import "./components/camera-controls.js";

// Import network and spawn modules
import startNetwork from "./network/network.js";
import placePlayerOnNavmesh from "../spawn.js";

document.addEventListener("DOMContentLoaded", () => {
  const scene = document.querySelector("a-scene");
  const spawn = () => {
    // make sure targets.js is loaded BEFORE this runs
    scene.systems["target-spawner"].spawnRandom(25, { radiusMin: 6, radiusMax: 18 });
    // place player rig onto the navmesh center
    placePlayerOnNavmesh();
    // start networking after scene + soldier exist
    startNetwork();
  };
  if (scene.hasLoaded) spawn();
  else scene.addEventListener("loaded", spawn);
});
