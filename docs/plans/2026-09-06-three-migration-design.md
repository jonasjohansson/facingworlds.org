# Facing Worlds — Leaving A-Frame for plain three.js

**Drafted:** 2026-09-06 · **Status:** approved, not started

## Goal

Remove A-Frame (1.6.0, bundling its own three r164) and aframe-extras from the game page,
and run the client on the vendored three r180 module build the AR page already uses. No
gameplay, netcode, asset or server change; the game must look, move and shoot exactly as it
does today, then be easier to keep improving.

## Why

The engine underneath was never the problem — three.js carried every piece of this month's
work (vertex-animation mixers, morph clips, raycasts, pooled effects, the Points shock beam).
A-Frame supplied the scaffold and four stock behaviours, and each of them leaked:

- `look-controls` rewrites the camera rotation every frame → the view shake needed a second
  `#view-shake` node to survive.
- `movement-controls constrainToNavMesh` needs the rig *on* the polygon → jump and floor
  correction had to be applied to the rig's children and sent separately on the wire.
- Component `init()` waits for the entity to load → `setRest` threw on the second Enforcer.
- `model-loaded` bubbles to parents → the body rebuilt its mixer six times per spawn.
- The `PerspectiveCamera` object itself is never rotated → every camera-facing sprite drew
  edge-on until `getWorldQuaternion`.
- three pinned to r164 by A-Frame's bundle, while `ar/` runs r180.

Babylon.js was considered again and rejected: a full rewrite of ~40 components, the network
glue and the AR page for no gain on the work that matters (BSP collision, navmesh, effects),
all of which is asset and rule work, not engine work.

## Decisions

| Question | Decision |
|---|---|
| Strategy | Parallel build under a new entry; `index.html` stays playable until parity; then one swap commit deletes A-Frame. Same shape as `ar/index.html` vs `ar/aframe.html`. |
| three version | Vendored r180 (`assets/libraries/three/three.module.min.js`), shared with the AR page via the `"three"` import map. One copy on the site. |
| Navmesh clamp | `three-pathfinding` used directly (the library aframe-extras wraps), vendored as an ES module. |
| Wire protocol | Unchanged. Rig y stays the navmesh y; the hop stays a separate `visualOffset`. Server and bots untouched. |
| Scene description | Markup → data tables in JS with the same values (lights, static entities, asset URLs). The tuned lighting stays identical. |
| Component model | Plain classes with `update(dt, now)` / `dispose()`, registered in an explicit order. No schemas, no DOM entities. Nodes are `Object3D`s. One `EventTarget` bus replaces `sceneEl.emit`. |
| HUD | Untouched — it is DOM already (`hud-root.js`). |
| Not ported (deleted) | `blaster.js`, `follow-player.js`, `advanced-material-animation.js`, `console-suppression.js`, `gltf-viewer-settings.js` (becomes renderer config), `three-aframe.js` shim, `ar/aframe.html`, `src/ar/components/`, `assets/libraries/aframe/`, `assets/libraries/aframe-extras.min.js`. |

## Inventory (2026-09-06)

47 registered components/systems across 45 files, ~13.7k lines of client JS. Stock
A-Frame behaviours actually used: `camera`, `look-controls`, `movement-controls` +
`nav-mesh` + `touch-controls`/`keyboard`/`gamepad` (aframe-extras), `gltf-model` (4 in
markup, 4 via setAttribute), `light` (19 in markup, 5 via setAttribute), `shadow`, `text` +
`look-at` (health label), `geometry`/`material` (fallback gun). Everything else is a three.js
body with an A-Frame `init/tick` wrapper.

## Architecture

```
src/game/
  engine/
    game.js          createGame(): renderer, scene, camera, resize, loop, system registry
    assets.js        GLTFLoader + DRACOLoader (src/ar/vendor/draco/), one cache, same URLs
    events.js        the scene bus (EventTarget)
    input.js         keyboard state, pointer lock, touch, gamepad snapshot
  scene/
    lights.js        the 19 lights, as data — values copied from index.html verbatim
    world.js         map + navmesh + flag stands + static entities
  player/
    controller.js    look + UT movement + navmesh clamp + jump/groundToFloor + shake + camera
  systems/           ported components, one file each, same names as today
  network/, config/, utils/  unchanged where possible
  core/main.js       new entry: createGame → build scene → register systems → start
```

**Update order** (explicit, replacing A-Frame's attachment order): input → player movement →
jump/ground → look → view shake → first-person weapon (sway, view anim, muzzle) → hitscan &
projectiles → effects → pickups/CTF → remote avatars → sky/earth camera pin → bloom/render.

**Renderer config** (from `<a-scene renderer=…>` and `gltf-viewer-settings`): ACES filmic,
exposure 1.0, PCFSoft shadow map, colour management on, antialias, anisotropy 8, sorted
transparents, camera near 0.05. r180 has no `physicallyCorrectLights` flag — physical light
units are the default, which is what A-Frame's `physicallyCorrectLights: true` selected.

**Player controller** lifts the UT acceleration maths from `ut-controls` unchanged, reads
input from `engine/input.js` (one finger forward / two back on touch, as today), clamps with
`three-pathfinding` `clampStep` on the navmesh glTF's geometry, applies `ut-jump`'s hop and
`groundToFloor` as a child offset of the rig, drives yaw/pitch at 0.002 rad/px under pointer
lock, and writes roll + eye lift from `view-shake` to the camera and the gun node alike.

**Remote entities**: `network.spawnRemote` stops building `<a-entity>` + `setAttribute` and
calls a factory that returns an `Object3D` with a `RemoteAvatar` system instance attached;
`data-*` attributes become plain fields.

**Health label**: A-Frame `text` → the canvas-sprite label already used for names.

**Debug handle**: `window.__fw = { game, scene, camera, rig, systems }` so the Playwright
probes and the console reach the same objects they used to reach through `#rig`/`#cam`.

## Migration order

1. Engine core + world: renderer, loop, assets, map, navmesh (hidden), lights, env map,
   quality tier, sky, earth, coronas, pixelated-texture, gltf-animation-pointer, bloom.
   Milestone: the map renders identically on the new entry (screenshot compare).
2. Player: controller, spawn, view-shake; walk the whole map. Milestone: Playwright
   frame-time and ground probes match today's numbers.
3. Weapons and effects: first-person weapon, sway, view anim, hitscan, ut-effects,
   ut-projectiles, impact-effects, weapon-pickup. Milestone: weapon-motion probe matches.
4. Multiplayer: network, remote avatars, character, health, CTF, announcer, highscore,
   kill notifications, background music, name changer. Milestone: play against bots.
5. Swap: new entry becomes `index.html`; delete the A-Frame files and the drop list;
   update README, docs and package.json (`description`, `keywords`).

Steps 1–4 land as commits on `main` behind the new entry (`play.html`), so `index.html`
keeps working throughout. Work is split across Opus agents by subsystem with disjoint file
ownership, integration and the engine core done in the main session.

## Verification

- 153 Node tests unchanged (server, shared, effects, view-shake, remote-fire-state).
- Playwright probes (`scripts/measure-frametimes.mjs`, `scripts/measure-weapon-motion.mjs`,
  the scratchpad ground/anchor probes) re-pointed at `window.__fw` and re-baselined against
  today's numbers (~8.3 ms frames with 9 bots; the weapon-motion table in the 2026-08-29
  design doc's "Landed" section).
- Parity checklist verified by Jonas in the browser before the swap: lighting/exposure match,
  movement speed and jump arc, floor contact, weapon rest positions (Enforcer left), fire
  animations and shake, shock beam, wall hits, pickups, CTF flags, bots, scoreboard, touch
  controls on a phone, AR page unaffected.

## Risks

- **r164 → r180 differences**: light units (see above), `outputColorSpace` defaults, addon
  paths (`assets/three-addons/` must match r180 — verify against `src/ar/vendor/`).
- **Touch and gamepad**: aframe-extras owned these; the port re-implements only what the
  credits panel promises (one finger forward, two back, drag to look, tap to fire).
- **Hidden reliance on A-Frame lifecycle**: any component that waited on `loaded` or
  `model-loaded` ordering must get an explicit await in the new entry. Step milestones and the
  probes are there to catch it.
