import "./js/checker-floor.js";
import "./js/health.js";
import "./js/shooter-input.js";
import "./js/shooter-gun.js";
import "./js/shooter-spawn.js";
import "./js/bullet.js";
import "./js/target.js";
import "./js/target-spawner.js";
import { initHUD } from "./js/hud.js";
import "./js/network.js"; // optional/no-op without server

// Simple HUD init and wire-up
initHUD();

// Helper: respawn on 'R'
window.addEventListener("keydown", (e) => {
  if (e.key.toLowerCase() === "r") {
    const player = document.getElementById("player");
    if (player && player / js / health) {
      player.components.health.respawn();
    }
  }
});
