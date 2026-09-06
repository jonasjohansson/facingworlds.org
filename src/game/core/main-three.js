// main-three.js — the game, without A-Frame. Becomes main.js at the swap.
//
// Everything that used to be an attribute on an <a-entity> is a system registered here,
// and the REGISTRATION ORDER is the frame order. A-Frame expressed that order implicitly
// through attachment sequence (the old main.js had to attach ut-jump after the scene
// loaded so its tick landed behind movement-controls'); here it is written down once.
import { createGame } from "../engine/game.js";
import { createInput } from "../engine/input.js";
import { buildWorld } from "../scene/world.js";
import { handleError } from "../utils/error-handler.js";
import { performanceMonitor } from "../utils/performance.js";

async function boot() {
  performanceMonitor.startMonitoring();
  const canvas = document.getElementById("game");
  const game = createGame({ canvas });
  game.input = createInput(canvas);

  // A handle for the Playwright probes and the console. Everything else is
  // module-scoped, exactly as window.__arTable is for the AR page.
  window.__fw = game;

  // 1. World: map, navmesh, lights, env map. Awaited — everything below stands on it.
  await buildWorld(game);

  // 2..N are registered here as they are ported, in THIS order:
  //   player (movement, jump/ground, look, shake) -> first-person weapon (sway, view
  //   anim, muzzle) -> hitscan/projectiles -> effects -> pickups/CTF -> remote avatars
  //   -> sky/earth camera pin -> bloom (render hook).
  // A system that needs another's result THIS frame goes after it; say why in a comment.

  game.start();
}

document.addEventListener("DOMContentLoaded", () => boot().catch((e) => handleError(e, "boot")));

// The "?" in the corner: click toggles the controls/credits panel (hover does it for
// mouse users via CSS). Kept out of the HUD component because it is not HUD.
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
