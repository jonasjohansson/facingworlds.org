// main-three.js — the game, without A-Frame. Becomes main.js at the swap.
//
// Everything that used to be an attribute on an <a-entity> is a system registered here,
// and the REGISTRATION ORDER is the frame order. A-Frame expressed that order implicitly
// through attachment sequence (the old main.js had to attach ut-jump after the scene
// loaded so its tick landed behind movement-controls'); here it is written down once.
import { createGame } from "../engine/game.js";
import { createInput } from "../engine/input.js";
import { ASSETS, loadGltf } from "../engine/assets.js";
import { buildWorld } from "../scene/world.js";
import { PlayerController } from "../player/controller.js";
import { placePlayerOnNavmesh } from "../player/spawn.js";
import { Character } from "../systems/character.js";
import { Health } from "../systems/health.js";
import { FirstPersonWeapon } from "../systems/first-person-weapon.js";
import { UtEffects } from "../systems/ut-effects.js";
import { UtProjectiles } from "../systems/ut-projectiles.js";
import { ImpactEffects } from "../systems/impact-effects.js";
import { RemoteAvatars } from "../systems/remote-avatars.js";
import { WeaponPickups } from "../systems/weapon-pickup.js";
import { CtfFlags } from "../systems/ctf-flag.js";
import { SpaceEnvironment, BaseCoronas } from "../systems/space-environment.js";
import { EarthSphere } from "../systems/earth-sphere.js";
import { BackgroundMusic } from "../systems/background-music.js";
import { Bloom } from "../systems/bloom.js";
import { Announcer } from "../systems/announcer.js";
import { HighscoreDisplay } from "../systems/highscore-display.js";
import { KillNotification } from "../systems/kill-notification.js";
import { NameChanger } from "../systems/name-changer.js";
import { startNetwork } from "../network/network.js";
import { getHud } from "../components/hud/hud-root.js";
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

  // The HUD. Still DOM, still the same module index.html uses (components/hud/hud-root.js);
  // it is only handed `game` so its CTF feed reads game.events and its shot counter finds
  // the weapon system instead of <a-scene> and #cam. Built BEFORE the systems that take a
  // reference to it (the weapon, and health when the network layer lands), because it is a
  // ref-counted singleton and the first caller is what decides which scene it is wired to.
  game.hud = getHud(game);

  // 1. World: map, navmesh, lights, env map. Awaited — everything below stands on it.
  await buildWorld(game);

  // 2..N are registered here, in THIS order:
  //   player (movement, jump/ground, look, shake) -> the local body's animation blend ->
  //   first-person weapon (sway, view anim, muzzle) -> effects (ut-effects,
  //   ut-projectiles, impact-effects) -> remote avatars -> pickups/CTF -> sky/earth
  //   camera pin -> the DOM systems (announcer, scoreboard, kill feed, name dialog) ->
  //   bloom (render hook).
  // A system that needs another's result THIS frame goes after it; say why in a comment.
  // The network layer and the local Health are in the registry but not in that order:
  // neither has an update(). They are registered for their dispose(), which is the only
  // teardown game.dispose() can reach. The socket opens below the player, where the old
  // main.js opened it, and reaches everything else by method call.

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
    The local body's idle/walk/run blend — the `character` attribute on #soldier, whose
    only settings in the markup were Soldier.glb's clip indices, which are systems/
    character.js's defaults. It is the one system with NO node of its own: the controller
    owns game.player.soldier and its yaw, and Character only drives the mixer.

    IT IS A SYSTEM RATHER THAN A CALL INSIDE THE CONTROLLER because it is not the
    player's — remote bodies run the same class from remote-avatars.js — and because it
    must read this frame's speed, which is the LAST thing the controller writes
    (updateSpeed()). Registered here, immediately below the player, it does.

    The model is async and the frame loop is not, so the system exists from this line and
    picks up the Character when the body resolves; until then it does nothing, which is
    what a body with no mesh should do. The clips come from the same cached glTF
    attachModel cloned the body out of.

    receiveShadow: FALSE, against Character's own default: controller.hideFromCamera()
    sets it that way deliberately (nothing can be seen falling on a body that is not
    drawn) and the Character constructor would otherwise walk the meshes and turn it
    back on.
  */
  const playerCharacter = {
    character: null,
    update(dt) {
      if (this.character) this.character.update(dt, game.player.speedMps);
    },
    dispose() {
      if (this.character) this.character.dispose();
      this.character = null;
      // The field below is published for network.js's pose loop; leaving a disposed
      // mixer's target object reachable through game.player would be a lie about what
      // this body is doing.
      if (game.player) game.player.character = null;
    },
  };
  game.register("player-character", playerCharacter);
  game.player.ready
    .then(async (root) => {
      if (!root) return;
      const { animations } = await loadGltf(ASSETS.soldierModel);
      playerCharacter.character = new Character(root, animations, { receiveShadow: false });
      // network.js's pose loop reads the blend targets off here to tell everyone else
      // whether this player is idling, walking or running.
      game.player.character = playerCharacter.character;
    })
    .catch((e) => handleError(e, "player character"));

  /*
    The local player's HP. `health="max:100; current:100"` on #soldier, which is where the
    floating readout hangs from — over the body, not the camera, exactly as it did (you
    see your own number by looking up, and always could).

    `local: true` is what gates the screen chrome: the HUD plate, the damage vignette and
    the death card. It is handed the HUD instance rather than fetching its own, so the
    page has one singleton and one wiring — see the getHud() call above.

    network.js reaches it as game.player.health for `hit`, `health` and `respawn`; the
    attach() makes it findable from the node the way el.components.health was.

    REGISTERED AS WELL AS ATTACHED, even though it has no update(): game.dispose() walks
    the system registry and nothing else, so an attach()-only Health would never have its
    own dispose() run — leaking the label sprite's canvas texture and, because Health
    releases the HUD ref it was handed, leaving the HUD singleton's refcount stuck at one
    for ever. A system with no update() costs the frame loop one property test.
  */
  const localHealth = new Health(game, game.player.soldier, { local: true, hud: game.hud, max: 100, current: 100 });
  game.attach(game.player.soldier, "health", localHealth);
  game.player.health = game.register("local-health", localHealth);

  /*
    THE SOCKET. Where the old main.js put it: connect FIRST, because it is the slow remote
    thing and nothing local needs to finish before it opens — waiting on the navmesh here
    delayed every join by however long it took to load (and forever, if it never did).

    Not awaited, and it does not await anything either. It needs game.rig and game.player,
    which are three lines up; the systems it talks to (remote-avatars, ut-effects,
    ut-projectiles) are registered further down this same synchronous run and are looked up
    lazily, long before a socket can deliver a message.

    Registered for its dispose() alone — it has no update(). game.dispose() then closes
    the socket, clears the 20 Hz pose interval and any pending reconnect, and drops the
    bus subscriptions; without that the client outlives the game it is reporting on.
  */
  try {
    game.register("network", startNetwork(game));
  } catch (e) {
    handleError(e, "network");
  }

  /*
    The OFFLINE / pre-hello placement, NOT awaited — as the old main.js had it. In CTF the
    server owns the spawn point and hands it back in `hello.spawn` (the team base behind
    our own tower); whichever of the two lands second used to win, which could drag the
    player from their base to the middle of the map. It is settled inside spawn.js
    instead: applyLocalSpawn marks the server spawn as applied, and this placement then
    leaves the rig where it is rather than being ordered around it.
  */
  placePlayerOnNavmesh(game).catch((e) => handleError(e, "spawn placement"));

  /*
    The gun in your hands. AFTER the player: the sway reads this frame's rig velocity
    (game.player.isMoving / speedMps) and every slot hangs off game.player.gunRoot, which
    the controller has already written this frame's shake roll and eye lift to. The three
    effect systems below go after this — they consume this frame's shots.

    The sway settings are index.html's, off #player-weapon: a very small, fast sway and no
    bob at all. They live here rather than in the component because they are markup values,
    like every other number on this page.
  */
  game.register(
    "first-person-weapon",
    new FirstPersonWeapon(game, {
      enabled: true,
      muzzleOffset: { x: 0.8, y: 0.1, z: 0 },
      sway: {
        enabled: true,
        swayIntensity: 0.001,
        swaySpeed: 6.0,
        bobIntensity: 0.0,
        bobSpeed: 0.0,
        walkMultiplier: 1.0,
        runMultiplier: 1.5,
        smoothing: 0.2,
      },
    })
  );

  /*
    What a shot LOOKS like. All three AFTER first-person-weapon, because they draw the
    shot it resolved THIS frame: fireBullet() traces, then calls
    game.systems.get("ut-effects").drawHitscanShot(...) and .ejectShell(...) inline, so an
    effect system registered above the weapon would run its decay pass for the frame
    before the effect it is decaying was spawned — one frame of a beam segment or a
    smoke puff drawn at full glow and then immediately stepped.

    Within the three the order is: ut-effects (Epic's own wall hit, beam, ring, shells) →
    ut-projectiles (the server-simulated rockets and blades) → impact-effects LAST, because
    it owns the shared teardown. game.dispose() walks the systems in REVERSE registration
    order, so ImpactEffects.dispose() runs first and pulls ut-effects' pools down with it
    through the disposer ut-effects registered — which is why UtEffects has no dispose() of
    its own. impact-effects also owns the procedural tracer/spark/decal that ut-effects
    falls back to while the extracted glTFs are still loading, and its pools must exist
    before the first shot; the constructor warms them.

    hitscan itself is NOT a system: systems/hitscan.js is a library (getWorldColliders,
    traceShot) with no update(), called by the weapon, by these effects and by network.js.
  */
  game.register("ut-effects", new UtEffects(game));
  game.register("ut-projectiles", new UtProjectiles(game));
  game.register("impact-effects", new ImpactEffects(game));

  // Other players' bodies. The hard constraint is the one below them: pickups and CTF
  // read a remote carrier's rig, so those must run after this. Whether they sit above or
  // below the weapon only decides which frame's avatar pose a shot traces against, and
  // below is where the A-Frame build had it — remote entities were attached to the scene
  // long after the camera's own components.
  game.register("remote-avatars", new RemoteAvatars(game));

  // Pickups and CTF read game.rig's position THIS frame to decide whether to ask the
  // server for a pickup or a flag touch, so they go after the player controller — and
  // after the remote avatars, because a flag carried by a remote player reads its
  // carrier's rig, which would otherwise be a frame behind.
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

  /*
    The 2D half of a match: the voice, the scoreboard, the kill feed, the name dialog.
    All four are DOM and game.events only — nothing here touches the scene graph, so
    where they sit in the frame order matters for exactly one thing: the two that read
    the keyboard must run while the keys they poll are still this frame's.

    ut-announcer keeps its old registered name because that is what it was
    (sceneEl.systems["ut-announcer"]); network.js calls the module's announce() directly,
    as it always has, and this instance only warms the audio cache.
  */
  game.register("ut-announcer", new Announcer());
  // Hold TAB. Reads game.input.keys.Tab, whose preventDefault input.js already owns.
  game.register("highscore-display", new HighscoreDisplay(game, { enabled: true, maxPlayers: 10, updateInterval: 1000 }));
  game.register("kill-notification", new KillNotification(game, { enabled: true, maxEntries: 4, displayDuration: 4000 }));
  // Press N. Reads game.input.consumePress("KeyN") — an edge, because this one toggles.
  game.register("name-changer", new NameChanger(game));

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
