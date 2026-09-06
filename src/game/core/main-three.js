// main-three.js — the game, without A-Frame. Becomes main.js at the swap.
//
// Everything that used to be an attribute on an <a-entity> is a system registered here,
// and the REGISTRATION ORDER is the frame order. A-Frame expressed that order implicitly
// through attachment sequence (the old main.js had to attach ut-jump after the scene
// loaded so its tick landed behind movement-controls'); here it is written down once.
import { createGame } from "../engine/game.js";
import { createInput } from "../engine/input.js";
import { buildWorld } from "../scene/world.js";
import { PlayerController } from "../player/controller.js";
import { placePlayerOnNavmesh } from "../player/spawn.js";
import { WeaponPickups } from "../systems/weapon-pickup.js";
import { CtfFlags } from "../systems/ctf-flag.js";
import { SpaceEnvironment, BaseCoronas } from "../systems/space-environment.js";
import { EarthSphere } from "../systems/earth-sphere.js";
import { BackgroundMusic } from "../systems/background-music.js";
import { Bloom } from "../systems/bloom.js";
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

  /*
    The player. FIRST of the per-frame systems, because it is what moves the camera:
    everything below reads the camera's world pose (the sky pins itself to it, the sway
    reads this frame's rig velocity, the weapon hangs off gunRoot). In A-Frame this order
    was expressed by attaching ut-jump only after the scene had loaded, so its tick landed
    behind movement-controls'; here the whole player is one update() in one file.

    It takes over game.camera: the constructor re-parents it under the rig's head node.
    Nothing else may re-parent or rotate it — the shake writes the camera's own local
    transform, which is the reason index.html's #view-shake node no longer exists.
  */
  // No options: every number the controller runs on is a GAME_CONFIG.MOVEMENT default
  // inside it, exactly as the A-Frame schema defaults were, and the entry point has
  // nothing to override. Passing MOVEMENT through here would only be a second spelling
  // of the same values that could drift.
  game.player = game.register("player", new PlayerController(game));
  game.rig = game.player.rig;
  game.scene.add(game.rig);

  /*
    The OFFLINE / pre-hello placement, NOT awaited — as the old main.js had it. In CTF the
    server owns the spawn point and hands it back in `hello.spawn` (the team base behind
    our own tower); whichever of the two lands second used to win, which could drag the
    player from their base to the middle of the map. It is settled inside spawn.js
    instead: applyLocalSpawn marks the server spawn as applied, and this placement then
    leaves the rig where it is rather than being ordered around it.
  */
  placePlayerOnNavmesh(game).catch((e) => handleError(e, "spawn placement"));

  // Pickups and CTF read game.rig's position THIS frame to decide whether to ask the
  // server for a pickup or a flag touch, so they go after the player controller. They
  // go before the remote avatars because a carried flag reads its carrier's node, and a
  // remote rig moved after this would drag the flag a frame behind it.
  game.register("weapon-pickup", new WeaponPickups(game));
  game.register("ctf-flag", new CtfFlags(game));

  /*
    Sky: the CTF-Face skybox, the planet in it, and the coronas on the towers.

    The signature of the original map is a slowly ROTATING star skybox (lifted from the
    ending of Unreal) with galaxies and a moon in it, spinning to mirror the asteroid's
    drift. Note which way round that is: the sky turns, the level does not. Both
    space-environment and earth-sphere pin their content to the camera and turn it about
    one shared axis at one shared rate (SKY_ROTATION_DEG_PER_SEC in
    space-environment.js), so the backdrop moves as a single piece with no parallax.

    THAT PIN IS WHY THEY GO HERE, near the end: they read the camera's world position
    (and the coronas its distance to each tower), so they must run after everything that
    moves the camera — the player controller, the jump/ground offset and the view shake,
    all three of which are the one `player` system registered above. The weapons and
    effects still to be ported also go above these, not below.

    space-environment also OWNS scene.background: scene/world.js paints the same #000006
    early so nothing flashes, and this overwrites it with the same value.
  */
  game.register(
    "space-environment",
    // 200 stars was a black screen with specks in it. 1400, with 45% of them pulled into
    // a galactic band, gives the sky something to read against as it drifts.
    new SpaceEnvironment(game, {
      enabled: true,
      starCount: 1400,
      bandFraction: 0.45,
      galaxyCount: 4,
      moonEnabled: true,
      rotationSpeed: 0.3,
      asteroidCount: 0,
      nebulaEnabled: false,
      backgroundColor: "#000006",
    })
  );

  game.register(
    "earth-sphere",
    /*
      Earth Sphere (Distant Planet). `offset` is direction+distance from the camera, so
      the apparent size is size/|offset| ~ 22 degrees of arc - the same on-screen framing
      as the old distance:100/size:60, but pushed far enough out (506 units) that the map,
      whose longest span is 259 units, can never intersect it.

      DELIBERATELY NOT SCALED with the rest of the world. The sphere is re-pinned to the
      camera every frame (earth-sphere.js), so its apparent size is size/|offset| and is
      scale-invariant; only clearance matters, and its surface still sits 316 units from
      the camera against map geometry that reaches at most ~260. Scaling it would push the
      planet to 1182 units, where the depth resolution the `near: 0.05` note in
      engine/game.js is derived from (~1.7 units) stops comfortably clearing the cloud
      shell - i.e. it would bring back the flicker that comment exists to explain.

      sunDirection is a DIRECTION, not a position, so it stays 70 95 -100 even though the
      key light's position (which it mirrors, so the planet is lit from where the scene is
      lit) scaled to 163.49 221.87 -233.55. Same ray, different length. If you retarget the
      key light, change this to match its direction, not its coordinates.
    */
    new EarthSphere(game, {
      enabled: true,
      offset: { x: 390, y: 120, z: -300 },
      size: 190,
      rotationSpeed: 0.005,
      atmosphereColor: "#4db2ff",
      atmosphereIntensity: 0.8,
      nightLightColor: "#ffb45a",
      nightLightIntensity: 2.6,
      sunDirection: { x: 70, y: 95, z: -100 },
    })
  );

  game.register(
    "base-coronas",
    // UT99 coronas: additive glow billboards on the outside midsections of both bases,
    // with NO light source behind them - in UT99 a Corona actor is pure screen candy.
    // Default positions are measured off the loaded map, not guessed; see BaseCoronas in
    // systems/space-environment.js.
    new BaseCoronas(game, { enabled: true, size: 11.68, blueColor: "#4aa6ff", redColor: "#ff4530" })
  );

  // Not a per-frame system (no update()), but it wants the camera to hang its
  // AudioListener on, and it starts on the first shot.
  game.register(
    "background-music",
    new BackgroundMusic(game, { enabled: true, volume: 0.8, loop: true, autoplay: false, startOnFirstBullet: true })
  );

  // Bloom LAST: it owns the render hook (game.setRenderHook replaces the loop's
  // renderer.render with composer.render), and it pulls its settings from quality-tier's
  // bloomSettings getter — null on the low tier, which leaves the hook unset and the page
  // rendering un-bloomed. The three postprocessing addons are imported dynamically inside
  // the constructor so a failed resolution degrades to "no bloom" instead of taking this
  // module graph down; `bloom.ready` is the promise that says which way it went.
  game.register("bloom", new Bloom(game));

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
