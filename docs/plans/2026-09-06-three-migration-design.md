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

## Measured at parity (2026-09-06)

Both pages, one machine, one session, back to back — which is the only way any of these
numbers mean anything. The game server was default (`npm run server:tls`), so each page
was served **nine bots** (`BOTS_MIN_PER_TEAM` 5 a side, one of the ten slots ours); the
probes wait for the roster before they start recording, and the two pages were never
connected at the same time, because a second human is two fewer bots each.

    node scripts/measure-frametimes.mjs            node scripts/measure-frametimes.mjs --legacy
    node scripts/measure-weapon-motion.mjs         node scripts/measure-weapon-motion.mjs --legacy
    node scripts/pw/parity.mjs

### Frame times, 9 bots + effects (ms per frame)

| phase | play frames | play mean | play p95 | play max | index frames | index mean | index p95 | index max |
|---|---|---|---|---|---|---|---|---|
| idle | 368 | 8.3 | 9.1 | 9.4 | 369 | 8.3 | 9.3 | 9.4 |
| fire enforcer | 607 | 8.4 | 9.2 | 41.7 | 607 | 8.4 | 9.3 | 41.7 |
| fire sniper | 501 | 8.5 | 9.3 | 41.7 | 501 | 8.5 | 9.3 | 42.0 |
| fire shock | 501 | 8.5 | 9.2 | 41.6 | 503 | 8.4 | 9.2 | 33.4 |
| fire rocket | 502 | 8.5 | 9.3 | 50.1 | 501 | 8.4 | 9.3 | 41.3 |
| fire ripper | 501 | 8.5 | 9.3 | 41.7 | 501 | 8.5 | 9.3 | 41.7 |
| fire redeemer | 501 | 8.4 | 9.2 | 49.9 | 501 | 8.5 | 9.2 | 41.7 |
| dual enforcers | 592 | 8.4 | 9.3 | 50.1 | 589 | 8.5 | 9.3 | 50.6 |
| **all phases** | **5806** | **8.4** | **9.2** | **50.1** | **5807** | **8.4** | **9.3** | **50.6** |

8.4 ms mean and 9.2–9.3 ms p95 on both, against the 2026-09-05 baseline of 8.3 / 9.3 — the
same flat 120 Hz. Thirteen frames over 33 ms on each page, and as in the baseline every one
of them lands at the instant the probe took its own `page.screenshot()`; nothing is over
100 ms anywhere. Weapon switches load in three or four frames on both (the Shock Rifle and
the Rocket Launcher, the two that miss the model cache, cost one 17 ms frame each).

`renderer.info`, accumulated over 60 frames and divided (the bloom composer renders several
times a frame, so the counters have to be frozen to be read at all): **play.html 247 draw
calls, 102,583 triangles, 61 programs, 102 geometries, 178 textures**, against **index.html
278 draw calls, 102,807 triangles, 57 programs, 150 geometries, 233 textures**. The port
draws the same scene in 31 fewer calls off a third fewer geometries — one scene graph built
once from a table instead of one built out of entities.

### Weapon motion, per weapon

play.html:

| weapon | shots | cadence | gun excursion | max/frame | frames >20px | eye deepest | eye max/frame | roll max |
|---|---|---|---|---|---|---|---|---|
| enforcer | 10 | 0.26 s | 24 px | 25 px | 10 | 7.5 cm | 1.8 cm | 1.2° |
| sniper | 3 | 1.51 s | 127 px | 31 px | 6 | 14.0 cm | 2.8 cm | 1.8° |
| shock | 4 | 0.60 s | 108 px | 24 px | 6 | 8.8 cm | 1.3 cm | 1.7° |
| rocket | 3 | 1.10 s | 44 px | 13 px | 0 | 14.8 cm | 1.7 cm | 2.5° |
| ripper | 4 | 0.60 s | 48 px | 18 px | 0 | 8.8 cm | 1.4 cm | 0.7° |
| redeemer | 2 | 2.50 s | 341 px | 341 px | 2 | 15.2 cm | 1.6 cm | 2.5° |

index.html:

| weapon | shots | cadence | gun excursion | max/frame | frames >20px | eye deepest | eye max/frame | roll max |
|---|---|---|---|---|---|---|---|---|
| enforcer | 10 | 0.25 s | 24 px | 25 px | 9 | 7.5 cm | 0.9 cm | 1.2° |
| sniper | 3 | 1.50 s | 127 px | 30 px | 2 | 14.0 cm | 2.4 cm | 2.9° |
| shock | 4 | 0.60 s | 108 px | 24 px | 8 | 8.8 cm | 1.9 cm | 1.8° |
| rocket | 3 | 1.10 s | 44 px | 12 px | 0 | 14.0 cm | 2.5 cm | 2.5° |
| ripper | 4 | 0.61 s | 48 px | 19 px | 0 | 8.8 cm | 1.6 cm | 0.7° |
| redeemer | 2 | 2.50 s | 341 px | 341 px | 2 | 15.1 cm | 1.6 cm | 2.5° |

Excursion, cadence and shot count agree weapon for weapon. The Redeemer's 341 px is Epic's
own hard cut into its kicked-up tube (`PlayAnim('Fire', 0.3)`, tween 0) and is on both.

### Walk, jump and floor

| walk yaw 45°, 3000 ms | play.html | index.html |
|---|---|---|
| mean ground speed (m/s) | 9.42 | 9.29 |
| best 500 ms window (m/s) | 9.28 | 9.29 |
| max y step per frame (m) | 0.016 | 0.018 |
| standing hop baseline (m) | −0.494 | −0.493 |
| jump peak over baseline (m) | 1.474 | 1.473 |
| time to peak (ms) | 364 | 366 |
| back to standing (ms) | 723 | 726 |
| camera above drawn floor (m) | 1.400 | 1.400 |
| yaw 45° / 90° / 315° heading alignment | 0.999 / 0.908 / 0.999 | 0.999 / 0.907 / 0.999 |

Both pages are teleported to the same point to be measured: each one is seated by the
server on one of its own team's PlayerStarts, a hundred metres apart and on whichever side
had room. The 90° heading is deflected to 0.908 on **both** — that is CTF-Face's rock
sliding the navmesh clamp along it, not a controller difference.

`node scripts/pw/parity.mjs` — walk, effects, avatars and multiplayer in one browser —
reports **48 checks, 48 passed**, including the two-client test where play.html and
index.html join the same server in the same browser and each sees the other by name.

### The honest residual

There is none that survives a second run. The one gap the first pass showed was the Sniper
Rifle: play.html 127 px of excursion with a 32 px worst frame against index.html's 80 px
and 18 px. A second pass put index.html at 127 px and 30 px — the same numbers — so what
that first sample measured was the Sniper's own spread, not the port: its three-shot burst
lands somewhere different in the `Sway` loop each run (and `Twiddle` fires on 4% of loop
ends), which moves the excursion by about 1.6x on either page. Everything else is inside
what two runs of the same page differ by: means equal to 0.1 ms, jump arc to 1 mm and 3 ms,
floor contact to the millimetre, cadence to 10 ms. The two real differences are both in the
port's favour and neither is a feel change — 31 fewer draw calls and 48 fewer geometries.
The frame-time p95 is 9.2 vs 9.3 ms, which is one sorted sample apart and should be read as
equal.

Two probe assumptions had to be retired to get a stable run, and both are consequences of
Task 13 rather than of anything measured here. `scripts/pw/walk.mjs` checked play.html's
spawn against the offline navmesh placement; play.html now has a network layer, so the
server seats it like any other client and the check is against the PlayerStart the server
named. And standing still in the middle of Face for half a second with nine bots on the map
is a way to get shot: a respawn is a hundred-metre teleport that arrives in a sample as a
heading walked wrong, and `setHp(0)` written by hand can be overwritten by an incoming
`health` before the HUD has redrawn. Both are now detected and the sample retaken.

## Behaviour changes found on the way

Things the port does differently from the A-Frame build, found while sweeping the ported
files. Everything here is deliberate or already shipped; none of it is a parity regression.

- **The shot leaves the shaken eye.** `fireBullet()` traces from `game.camera`'s world
  position, which carries the view shake's vertical jolt; the old code read the un-shaken
  camera ENTITY. Up to ~14 cm of origin per shot (the Sniper's `vert: 8` jolt, smoothed —
  ~6 cm for the Enforcer). A fix, not a regression: the eye is where the crosshair projects
  from, so the trace and the crosshair now agree.
- **The hp number over other players is readable.** The old A-Frame `text` label was drawn
  nearly edge-on by the `look-at` leak — a measured 15 mm wide, i.e. effectively invisible.
  The canvas sprite faces the camera, so the number is legible for the first time. Whether
  to KEEP it is a design call (a `showNames`-style one-liner on `RemoteAvatar` would hide
  it), not a port question.
- **The N name-change dialog is live for the first time.** `components/name-changer.js` was
  imported by `core/main.js` but never attached to an entity in `index.html`, so it never
  ran. `main-three.js` registers `NameChanger` as a system, so N opens the dialog.
- **Remote shots drawn locally pass through the local body.** `bodies()` holds only remote
  avatars, so a tracer drawn for someone else's shot at you does not stop on you. Visual
  only — the server owns damage and never consulted this list.
- **Touch look is back at A-Frame's rate, and pitches.** `engine/input.js` pre-scales a
  touch drag to look-controls' PI-radians-per-canvas-WIDTH; the first port fed raw pixels
  through the mouse rate, which was 3.9x slower on a 400 px phone. Pitch is new (A-Frame's
  touch path had none) and takes the mouse's sign.
- **The key light casts no visible shadow — in EITHER build.** Its frustum is a 330x330
  ortho box over 933 units of depth with `shadowBias: -0.0007`, copied across verbatim; at
  that depth range and bias nothing in the scene resolves a shadow on either page. Pre-
  existing, not introduced here. Tightening to +/-20, near 300, far 400, bias 0 makes
  shadows appear; NOT done, because parity is the bar for this migration.
- **Plan erratum.** `getWorldColliders` traverses `game.map` (its `userData.mesh`), not
  `game.world` as the plan says. `game.world` also holds the hidden navmesh, the pickups
  and the flags, none of which a shot should stop on.
- **The shell-casing pool is 6.** `GAME_CONFIG.EFFECTS.UT_MAX_SHELLS` is 6, which sustained
  fire runs dry — ~12 is what it wants. Left at 6: it is the old BUDGET value and parity is
  the bar.
- **The player is clamped on every frame; the bots' paths are not the player's.** Measured
  2026-09-06 by walking all 224 walkable edges of the bots' graph (`server/nav-graph.js`)
  in both builds from the same start, same heading, bots off: 186 edges reach the same
  distance to within a metre; on 17 the new build gets further (the blue- and red-base
  island seams `navclamp.js` bridges and the old cache could not cross); on 21 it stops
  short. Every one of those 21 starts from a point that is NOT on a navmesh polygon
  (checked with `getClosestNode(…, checkPolygon: true)`), where aframe-extras' empty
  polygon cache ran the rig UNCLAMPED after the teleport — through the hole, until it hit a
  polygon. All 20 server spawn points ARE on polygons, so that free run never happened in
  play; it was only ever the probe's teleport. In-game the two builds stop at the same
  holes. "Bots run where I can't" is the fan navmesh: 110 of the 224 edges cross a plan
  hole of a metre or more in it (both bases' interiors, the lift shafts, the bridge
  approach), and the bots get through because they are snapped to the DRAWN floor
  (`server/navmesh-surface.js`) rather than clamped to the navmesh. Pre-existing on
  `main`; the fix is a navmesh built from the drawn floor, not a clamp change.

## Risks

- **r164 → r180 differences**: light units (see above), `outputColorSpace` defaults, addon
  paths (`assets/three-addons/` must match r180 — verify against `src/ar/vendor/`).
- **Touch and gamepad**: aframe-extras owned these; the port re-implements only what the
  credits panel promises (one finger forward, two back, drag to look, tap to fire).
- **Hidden reliance on A-Frame lifecycle**: any component that waited on `loaded` or
  `model-loaded` ordering must get an explicit await in the new entry. Step milestones and the
  probes are there to catch it.
