// Shared components used by both the game and the AR page. index.html loads this file
// directly (not the root game.js), so without this import "pixelated-texture" was never
// registered even though #world uses it as an attribute.
import "../../shared/components/index.js";

// Import utility modules first
import "../utils/three-helpers.js";
import "../utils/dom-helpers.js";
import "../utils/animation-helpers.js";
import "../utils/environment.js";
import "../utils/error-handler.js";
import "../utils/performance.js";

// Import configuration
import "../config/game-config.js";

// Import component modules
import "../components/blaster.js";
import "../components/character.js";
import "../components/health.js";
import "../components/rotate-yaw.js";
import "../components/animation-pointer.js";
import "../components/animated-materials.js";
import "../components/gltf-animation-pointer.js";
import "../components/advanced-material-animation.js";
import "../components/background-music.js";
import "../components/space-environment.js";
import "../components/earth-sphere.js";
import "../components/first-person-weapon.js";
// The "CLICK TO PLAY" sign. Attached to #cam in index.html alongside look-controls,
// which is what actually takes the pointer lock; this only says so.
import "../components/pointer-lock-prompt.js";
import "../components/weapon-pickup.js";
// Capture the Flag. Registers the "ctf-flag" system + "ctf-flag-item" component; the
// system spawns both flags from the server's `ctf-init` payload, so nothing in
// index.html references it and dropping this import silently removes CTF entirely.
import "../components/ctf-flag.js";
import "../components/weapon-sway.js";
import "../components/invisible-to-player.js";
import "../components/remote-avatar.js";
import "../components/camera-tracker.js";
import "../components/highscore-display.js";
import "../components/kill-notification.js";
import "../components/name-changer.js";
// import "../components/follow-player.js"; // Using A-Frame's built-in look-at instead

// UT99 ground movement + jump. Registers "ut-controls" (a velocity provider that
// movement-controls adopts) and "ut-jump". Both are attached to the rig below, once the
// scene has loaded, so their ticks land behind movement-controls' own.
// Touch movement is owned by aframe-extras' own touch-controls, which ut-controls reads;
// the old src/game/components/screen-touch-controls.js was never imported by anything and
// moved the rig straight through the navmesh, so it has been deleted rather than wired up.
import "../components/movement/ut-movement.js";

// Import setup components
import "../components/gltf-viewer-settings.js";
import "../components/console-suppression.js";
import "../components/environment-map.js";
import "../components/quality-tier.js";
// Post-processing. bloom.js pulls the three addons in dynamically and exports a promise,
// so a failed resolution degrades to "no bloom" instead of breaking the module graph.
import "../components/lighting/bloom.js";

// Import network and spawn modules
import startNetwork from "../network/network.js";
import placePlayerOnNavmesh from "./spawn.js";

import { performanceMonitor } from "../utils/performance.js";
import { handleError } from "../utils/error-handler.js";
import { GAME_CONFIG } from "../config/game-config.js";

document.addEventListener("DOMContentLoaded", () => {
  try {
    // Start performance monitoring
    performanceMonitor.startMonitoring();

    const scene = document.querySelector("a-scene");

    // Swap the rig onto the UT99 movement model. This is done here rather than in
    // index.html because "ut" has to sit first in movement-controls' controls list to be
    // adopted ahead of keyboard-controls, and because attaching ut-jump after the scene
    // has loaded is what puts its tick after movement-controls writes the navmesh-clamped
    // position it needs to offset.
    const applyMovement = () => {
      const rig = document.querySelector("#rig");
      if (!rig) {
        console.warn("[main] No #rig found; UT99 movement not applied.");
        return;
      }
      rig.setAttribute("movement-controls", {
        speed: GAME_CONFIG.PLAYER.MOVEMENT_SPEED,
        controls: ["ut", "gamepad", "trackpad", "keyboard", "touch"],
      });
      rig.setAttribute("ut-jump", "");
    };

    // Each step is guarded on its own so a failure in one does not cost us the others —
    // in particular, a navmesh that never loads must not also mean playing alone.
    const spawn = () => {
      try {
        applyMovement();
      } catch (error) {
        handleError(error, "Game initialization (movement)");
      }

      try {
        // Connect first. The socket is the slow, remote thing and nothing local needs
        // to finish before it opens; waiting on the navmesh here delayed every join by
        // however long #navmesh took to load (and forever, if it never fired).
        startNetwork();
      } catch (error) {
        handleError(error, "Game initialization (network)");
      }

      try {
        // Then the OFFLINE / pre-hello placement, in parallel. In CTF the server owns
        // the spawn point and hands it back in `hello.spawn` (the team base behind our
        // own tower); whichever of the two lands second used to win, which could drag
        // the player from their base to the middle of the map. It is settled inside
        // spawn.js instead: applyLocalSpawn marks the server spawn as applied, and this
        // placement then leaves the rig where it is rather than being ordered around it.
        placePlayerOnNavmesh().catch((error) => handleError(error, "Game initialization (spawn placement)"));
      } catch (error) {
        handleError(error, "Game initialization (spawn placement)");
      }
    };

    if (scene.hasLoaded) spawn();
    else scene.addEventListener("loaded", spawn);
  } catch (error) {
    handleError(error, "DOM Content Loaded");
  }
});

// The "?" in the corner: click toggles the controls/credits panel (hover does it
// for mouse users via CSS). Kept out of the HUD component because it is not HUD.
{
  const credits = document.getElementById("credits-container");
  const toggle = credits && credits.querySelector(".credit-toggle");
  if (toggle) {
    toggle.addEventListener("click", () => {
      const open = credits.classList.toggle("is-open");
      toggle.setAttribute("aria-expanded", String(open));
    });
  }
}
