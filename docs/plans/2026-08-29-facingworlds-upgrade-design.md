# Facing Worlds — Major Upgrade Design

**Drafted:** 2026-08-26 · **Scheduled to start:** Saturday 2026-08-29
**Status:** Phases 0, 1, 3 (partial) and 5 (partial) landed across three agent workflows on
2026-08-29, plus AR rebuilt as a live spectator table. Phase 2 (movement) and Phase 4 (CTF) not
started. Nothing committed yet. See "Landed" at the end.

## Goal

Move facingworlds.org from a client-authoritative A-Frame deathmatch demo toward a
faithful UT99 CTF-Face experience: the look of the original map, UT99 movement feel,
UT99 combat feel, and actual CTF gameplay.

## Decisions Made

| Question | Decision |
|---|---|
| Fidelity target | All four: map look, movement feel, combat feel, CTF mode |
| Platform | Desktop-first; mobile auto-detected and degraded |
| Netcode | Full server-authoritative rewrite |
| Weapons | Enforcer only, made to feel right (hitscan) |
| Hosting | Fly.io (see rationale below) |

## Current State — Findings from the 2026-08-26 audit

Read before changing anything; these are the facts the plan is built on.

### Rendering
- A-Frame 1.6.0 → Three.js r164 underneath. Already WebGL2. **Not** renderer-limited;
  a Babylon.js port was considered and rejected (full rewrite of ~5,200 lines across
  44 component files for no visual gain).
- `src/game/components/gltf-viewer-settings.js:11` sets `renderer.toneMappingExposure = -1.22`.
  Negative exposure is a pre-ACES multiplier — almost certainly a typo for `1.22`.
  **UNVERIFIED**: A-Frame's renderer system may overwrite this after `renderstart`.
  Must be confirmed in-browser before claiming a fix.
- `gltf-viewer-settings.js:14` sets `scene.environment = null`. The map ships
  `FacingWorlds_occlusionRoughnessMetallic_1001.png`, i.e. metallic-roughness PBR.
  Metals have no diffuse term — with no IBL they render near-black and read as grey
  plastic. **This is the single largest visual defect.** `assets/graphics/blaubeuren_night_4k.exr`
  is already in the repo, unused.
- `index.html:117` — `antialias: false; precision: low`. mediump fragment shaders
  cause banding across 13 lights.
- `src/game/components/lighting/bloom.js` is **dead code**: never imported in
  `src/game/core/main.js`, no `bloom` attribute on `<a-scene>`, and it references
  `EffectComposer` / `RenderPass` / `UnrealBloomPass` / `OutputPass` as bare globals
  with no import — it would throw on init.
- Shadows are requested but impossible: `src/game/network/network.js:373` sets
  `shadow: "cast:true; receive:true"` on remote avatars, but every light in
  `index.html` has `castShadow:false`, and both spots have `shadowCameraFov: 0`
  (degenerate shadow camera).

### Combat
- Bullets are slow projectiles (70 u/s spheres, `GAME_CONFIG.BULLET.SPEED`) with
  client-side sphere-vs-sphere collision and **no world geometry check** — they pass
  through walls. UT99's Enforcer is hitscan.
- **Double-fire bug**: `first-person-weapon.js` `fireBullet()` both appends a local
  bullet entity *and* emits `local-fire` to the network layer. Every shot spawns twice.
- Hit detection is client-authoritative. `server/server.js` accepts `clientHit` on
  trust and applies a flat 20 damage. Any client can send it.

### Networking
- No interpolation on remote players. Poses arrive every 50–100ms
  (`POSE_UPDATE_INTERVAL`, both client and server) and are applied raw → teleporting.
- **No reconnect.** `network.js:219` `ws.onclose` logs and stops. A dropped
  connection ends the session.
- `setScore` is trivially spoofable (accepts any value ≤ current+1).

### Assets
- `assets/3d/enforcer.glb` is **20 MB** for a pistol.
- Map textures are 14 MB of uncompressed PNG. `assets/graphics/` is 101 MB total.
- No Draco, no meshopt, no KTX2 anywhere.
- **Key enabling fact:** `assets/3d/map/FacingWorlds_tex_5.bin` is only **220 KB** —
  all the geometry. The 14 MB is entirely textures, which a server doesn't need.

## Architecture

### Server-side collision is tractable

Because map geometry is 220 KB and the navmesh is 45 KB, the server can load both
headless, build a BVH with `three-mesh-bvh`, and answer real queries:
- *Did this shot hit a wall before it hit a player?* (hitscan validation)
- *Is this position inside the navmesh?* (movement validation)

Without this, "server-authoritative" is a slogan — you'd still be trusting the client
about walls.

### One simulation, two runners

Movement physics must live in a **plain JS module with no A-Frame and no DOM**,
imported by both browser and Node server:

```
src/shared/sim/
  movement.js    ← step(state, input, dt, collision) → newState.  Pure function.
  collision.js   ← BVH queries. Identical both sides.
  constants.js   ← UT99 tuning values.
```

- Client runs it every frame for **prediction** (no input lag).
- Server runs the identical function over the input stream for **authority**.
- On disagreement the server wins; client **reconciles** — rewind to last acked
  server state, replay unacked inputs.

Consequence: `movement-controls` and `nav-mesh` from aframe-extras get **replaced**,
not tuned. A-Frame stays as scene graph + component system; the other ~40 components
and all rendering/asset loading are kept.

Because the sim is pure functions, it is actually unit-testable — unlike the current
DOM-coupled components. Get it under test from day one; prediction/reconciliation bugs
surface as rubber-banding that is miserable to debug otherwise.

## Hosting: Fly.io

Render's free tier cold-starts after inactivity — first player waits ~30s.

**Chosen: Fly.io.** Real VMs, so Node + `ws` + `three-mesh-bvh` + glTF parsing run
unchanged. `shared-cpu-1x` 256 MB ≈ $2/mo. Explicit regions. No invocation limits
fighting a 60Hz tick loop. Downside: outbound bandwidth billed; scale-to-zero
reintroduces a (seconds-long) cold start.

**Considered and deferred: Cloudflare Durable Objects.** Architecturally a better
fit — a DO is a single-threaded stateful actor, which is exactly what an authoritative
match server is; one DO = one match. Economics are unusually good: outgoing WebSocket
messages are **free** (incoming billed 20:1), and hibernation means an empty server
costs nothing. Workers Paid is $5/mo including 1M requests + 400,000 GB-s; one DO
running continuously for a month is ~332,000 GB-s, inside the allowance.

Rejected for now because it's the **Workers runtime, not Node**: no `ws`
(use `WebSocketPair`), no `fs`, no `GLTFLoader` off disk. Phase 1 would need the BVH
precomputed offline and shipped serialized (`three-mesh-bvh` supports this natively).
Also, the docs publish no minimum alarm interval, so a 60Hz alarm-driven tick is
unconfirmed — you'd likely `setInterval` inside a non-hibernating DO during a match.
Good migration target once game logic is stable.

## Phases

### Phase 0 — Visual quick wins  (~half a day, independent of everything else)
1. Verify whether `toneMappingExposure = -1.22` is actually live; fix if so.
2. Load `blaubeuren_night_4k.exr` as `scene.environment` via PMREMGenerator. **Biggest win.**
3. Wire up `bloom.js` — add the missing imports, import it in `main.js`, add the
   attribute to `<a-scene>`.
4. Enable one shadow-casting light; fix the `shadowCameraFov: 0` spots.
5. Raise `precision` off `low` on desktop; keep low on detected mobile.

Capture before/after screenshots to confirm the payoff is real.

### Phase 1 — Shared collision foundation
glTF loading in Node, `three-mesh-bvh` over map + navmesh, `src/shared/sim/` skeleton.
Ships nothing visible. Everything after depends on it.

### Phase 2 — UT-style movement
Custom controller on the shared sim. Prediction + reconciliation. Dodge on double-tap,
high ground speed, low friction.

Real values from `Engine/Pawn.uc` (verify against https://github.com/UT-BT/UT99 —
`TournamentPlayer` overrides some): `GroundSpeed 400`, `JumpZ 350`, `AirControl 0.05`,
`AirSpeed 400`, `AccelRate 2048`.

**Correction:** an earlier draft of this document said `AirControl 0.35`. That is the
**UT2004** value, not UT99 — UT99 uses **0.05**, i.e. almost no mid-air steering. That
difference is most of why UT99 feels committed and UT2004 feels floaty.

A UT99 player is 78 UU and ~1.8 m, so 1 UU ≈ 2.3 cm and `GroundSpeed 400` ≈ **9 m/s**.
The game currently runs `movement-controls="speed: 0.4"` — dramatically slower. Measure the
map model's real bounds before converting anything.

**Era decision (2026-08-29):** the user prefers the **UT2004** look and feel over UT99, and
stated the priority as "as long as the ui and feel is on top" — quality over period accuracy.
Air control should be tuned by feel between 0.05 and 0.35 rather than pinned to either, and the
HUD may take UT2003/2004's richer direction.

### Phase 3 — Combat
Enforcer becomes hitscan. Client fires a trace for instant feedback; server re-runs it
against the BVH with **lag compensation** (rewind other players to where they were on
the shooter's screen). Server owns damage. `clientHit` is deleted. Removes the
double-fire bug for free — no projectile entity remains.

### Phase 4 — CTF
Teams, two flags at the tower tops, carry/drop/return/capture state machine, team
spawns, team-coloured avatars. All server-owned — easy *because* phases 1–3 built the
authoritative state.

### Phase 5 — Full visual pass
Shadow tuning, post stack beyond bloom, and the asset pipeline:
`gltf-transform optimize` with Draco + KTX2. The 20 MB `enforcer.glb` should drop ~95%.
Also: redo the lighting *design* — 13 hand-tuned point lights is not a lighting setup,
and no post-processing rescues that.

## Risks

- **Phases 2–3 are the hard part.** Prediction/reconciliation bugs are subtle.
- **Map scale is unmeasured.** All UT99 movement constants depend on it.
- **Phase 0 item 1 is unverified.** Do not claim it as a fix until observed in-browser.
- Fly.io tick-rate vs. cost: 60Hz server physics for N players may need more than the
  cheapest instance. Consider a lower server tick with client interpolation covering it.

## Next Step

Start with Phase 0 — it is independent of every other decision, cheap, and settles the
exposure question by observation rather than speculation.


---

## Landed 2026-08-29 (uncommitted)

Three multi-agent workflows. Highlights, and the things that bit:

- **The exposure bug was real.** `toneMappingExposure = -1.22` did survive `renderstart`. Also
  `toneMapping: ACESFilmicToneMapping` in the `<a-scene>` attribute was never a value A-Frame's
  schema accepts, so it was silently ignored too.
- **`physicallyCorrectLights` was the hidden one.** It had been dropped from `index.html` with a
  comment claiming it was a no-op on r164. A-Frame 1.6.0 reads it as
  `useLegacyLights = !physicallyCorrectLights`, so removing it *enabled* legacy lights,
  multiplying every punctual light by π while leaving `scene.environment` unscaled — drowning the
  env-map fix. Restored. Every punctual light is now π dimmer; rebalance intensities rather than
  reverting the flag.
- **The 20 MB pistol:** 19.72 MB (96.5%) was a single 4096×4096 RGBA PNG albedo carrying an alpha
  channel its OPAQUE material never reads. The mesh is 721 KB. `assets/3d` went 35 MB → 4.5 MB.
- **WS port collision:** the game server was on 8080, the same port `npm start` serves static on,
  so a dev client was connecting to an unrelated WebSocket and reporting ONLINE. Moved to 8081.
- **AR is now pure Three.js** (`AFRAME === undefined` on the page), with the working A-Frame
  version preserved at `ar/aframe.html`. Spectator mode proven live: 27/27 assertions; the
  spectator receives poses and never appears in the player list or highscore.

### Open risks

- **`gstatic.com` is now a hard runtime dependency for the game page.** The optimized assets are
  Draco-compressed and A-Frame fetches its decoder from Google's CDN. Offline or on a blocked
  network, no model decodes and the scene renders empty. Fix: vendor the browser Draco build and
  set `dracoDecoderPath`. The AR page is unaffected — it vendors its own decoder.
- **Production runs old code.** `wss://unrealfest-server.onrender.com` responds in 0.2 s warm, but
  the free tier spins down and the first connection after idle times out on a cold boot.
  `?spectate=1` there returns `spectator=false`, so on production an AR viewer would join as a
  real, motionless, shootable player. Deploy before pointing AR at production.
- **An intermittent black-region artifact** in the game page is unresolved. Disabling bloom removes
  it, but that also makes rendering single-pass, so it does not distinguish a real WebGL defect
  from a compositor/capture race. Two genuine bugs were found and fixed while chasing it — a stale
  `bloomPass.resolution` across resize, and fractional render targets caused by a
  `devicePixelRatio` of 1.7999999523 — but neither was the cause.
- **Nothing is committed.** 57 files across three workflows sit in the working tree.

## Landed 2026-08-30

- **Draco vendored** (`2e2dbe8`): decoder served from `src/ar/vendor/draco/`; zero third-party requests.
- **Capture the Flag** (`58def08`): server-authoritative flags, teams, team spawns, 23 wire-level tests. The pose loop now carries the `ut-jump` hop, verified as a 1.47 m arc on the wire.
- **HUD from source** (`8224c04`): `docs/reference/ut99-hud-exact-spec.md` is derived from `ChallengeHUD.uc` / `ChallengeCTFHUD.uc` and the `HudElements1` atlas of a retail install (kept outside the repo). The screenshot-based spec is superseded.
- **True scale** (`eea4815`): the fan map was 42.8% of pawn scale. `WORLD_SCALE = 2.33552` is baked into the optimized glbs; flags, all 20 spawns and pickups come from the real `CTF-Face.unr` actors via `src/shared/map-transform.js`. Flags stand at the tower feet as in the original; the roofs hold the dual-Enforcer pedestals where UT99 has Body Armor.

Open: shadow texel density halved with the scale (2048 map over ±165 m — consider a cascaded or tighter fitted frustum); AR page should show flags and team colours; the frag box shows kills, not a scoreboard-derived score; the doll's damage markers have no hit direction.

## Landed 2026-08-30, evening

- **AR spectator shows the match** (`9e6d267`): team-tinted figures, both flags through home/carried/dropped, score line + roster; name labels half size, tap toggles them.
- **Bots** (`28e19cb`): server-side players on the real CTF-Face PathNode/ReachSpec network (592 of Epic's edges, A* verified), UT99 CTF brain, beatable aim, fill to 2/team yielding to humans. Confirmed live on production: Tamerlane, Sarena, Kane, Baird joined an empty server.
- **Field fixes** (same commit): remote facing includes camera yaw; the grey box gun was a destructive 5 s fallback racing a slow Draco decode; in-game team tint off; through-wall reports measured to be interpolation lag, tracing verified solid from three angles.

## Landed 2026-09-01

Five field reports from one session, all of them reproduced before being fixed.

- **Bots waded through the rock.** The cause was written down in
  `src/shared/map-transform.js` all along — "anything that has to sit exactly on a
  walkable surface should snap y to the surface it belongs to" — and nothing did.
  Measured against the shipped navmesh: 24 of the 115 walkable nav nodes sat more than
  0.3 *under* the floor and 25 more than 0.5 above it, and a bot lerped straight between
  them on top of that. New `server/navmesh-surface.js` (791 triangles + a plan index,
  generated) gives the server a ground; `gen-nav-graph.mjs` snaps node `y` (102 of 166
  moved, median 0.44); `bots.js` re-snaps every tick. After: **99.8% of 5,145 broadcast
  poses within 0.10 of the surface**, worst 0.20.
- **The grey box gun was back, and this was the other cause.** Not the Draco race fixed
  in `28e19cb`. `health.js` disables `first-person-weapon` on death, `update()` called
  `removeWeapon()`, and that did `removeChild(#player-weapon)` — deleting index.html's
  weapon, with its measured scale and its `#weapon-muzzle` child, permanently. Respawn
  found nothing and built the primitive fallback. **Every player was holding a box from
  their first death onwards.** It now hides the markup weapon and only tears down a
  fallback it built itself.
- **The mouse dragged the world around** because `look-controls` was left at A-Frame's
  `pointerLockEnabled: false`, which only turns the camera while a button is held. That
  also meant the left mouse button had never fired a shot: the mousedown handler gates on
  `document.pointerLockElement`, which was never set. Both fixed by one attribute, plus a
  CLICK TO PLAY sign for the moment before the lock is taken.
- **Pickups jumped off their pedestals from nine metres.** `PICKUP_RADIUS` had been
  multiplied by WORLD_SCALE to 7.01 (+2.5 slack). It is a body touching an item and
  neither changed size when the map did; UT99's own is about 1.03 units. Now 1.6 + 1.0.
  The floating Enforcer was also drawn 1.08 m long — bigger than the avatar's arm — and
  is now 0.63 m and canted.
- **Lethality, and the trap in it.** 20 damage was a number nothing justified; UT99's
  Enforcer is 17. But the roster also went 2/team -> 5/team, and *that alone made the game
  more lethal than before*: a motionless player on the enemy flag went from 9.1 s median
  alive to 5.4 s. Only after dropping accuracy 0.60 -> 0.26 and reaction 300 -> 550 ms did
  it land at **13.0 s**, with 0.31 incoming hits/s against the old 0.36. The lesson is the
  measurement: "less damage per shot" read as "less lethal" and was the opposite.

Also: `canSee()` gives bots a real terrain line-of-sight test, and it was wrong twice
before it was right — first inert (asking for the surface *nearest* the ray inside a
4-unit window, while the ridge stands 15 above a shot), then over-blocking (asking for the
*lowest* surface, which the fan navmesh's floor holes turned into a wall between a
defender and their own flag). `server/test/bots-los.test.mjs` pins both failures.
Honest scope: inside the range bots engage at, it changes 0.7% of pairs. It is not what
made the game less lethal, and it is documented as not being that.

### Open

- **The browser side is unverified.** The pointer lock, the weapon fix, the pickup sizes
  and the CLICK TO PLAY sign are all reasoned and syntax-checked but were never seen
  running: Chrome's process tree was killed mid-session by an over-broad
  `kill $(lsof -ti tcp:8081)` — `lsof` matches the *client* socket too, and Chrome had one
  open to the game server. Restart Chrome and look before believing any of it.
- **`canSee` knows floors, not walls,** and does not see a floor between two storeys
  either. `MAX_FIGHT_DY` is still what keeps tower storeys apart, which is why that gate
  survives. Closing either needs the map mesh on the server, not the navmesh.
- The 12 nav nodes with no navmesh under them (the fan model has no lift platforms) keep
  their fitted `y`, and a bot standing there keeps its interpolated height — 1,234 of
  ~6,400 sampled poses were over such a hole.

## Landed 2026-09-02 — the navmesh

The last open item from 2026-09-01 said 12 nav nodes had no navmesh under them and that
"the fan model has no lift platforms". Half of that was true. The other half was a bug in
our own code, and it had been throwing away geometry we already shipped.

- **The patch layer was asking a plan question about a stacked map.** A map triangle was
  dropped as redundant when the navmesh had *something* at each of its corners — any
  height at all. CTF-Face is two towers: a lift-shaft floor 14 units up sits directly over
  the outdoor terrain, and the red flag deck sits 72 units over it. So every storey inside
  both towers was discarded as "already covered" by ground it was nowhere near. Comparing
  the triangle's own height instead took the patch from 891 triangles to 1,280, and with
  it **10 more pickups off their collision origin and onto a floor** (26 snapped → 36).
- **A body is not a point.** Both meshes have pinholes narrower than a pawn. `surfaceNear`
  now probes the rim of the player's own footprint — `HITBOX.RADIUS`, read out of
  `game-config.js` so the ground test and the hitscan capsule agree how wide a body is —
  before it answers "no ground". Three more pickups placed (36 → 39), and the last bare
  spot on the walkable corridor closed.
- **Honest scope: the first fix changed nothing bots can reach.** Measured on Epic's own
  graph, walk-edge coverage went 10.1% → 6.2% ungrounded, but flooding the graph from the
  PlayerStarts *without* lift, teleporter or translocator edges — the routes `aStar`
  refuses — shows why: the tower interiors are not reachable on foot. Bots never went
  there. **Humans do**, and the pickups are theirs. On the corridor bots actually walk the
  number moved only with the footprint probe: **1.77% → 0.95%**, and the count of nav
  nodes with no floor under them that a bot can reach went **1 → 0**.
- **What is left is not ours to fix.** 43 of the 166 nav nodes had no ground under them
  before this; 23 still do. Eleven of those are `LiftExit`, `Teleporter` and
  `translocdest`, which are *supposed* to hang over a shaft or an arc — a lift's floor is
  the moving platform, and the static mesh has none. The other twelve are tower-interior
  item and defence spots the fan map simply does not build. Exactly one sits over a
  surface the map mesh has and the patch layer rejects, and it is an 80° face nobody could
  stand on; **zero have a level floor the patch layer is missing.** That last one is the
  property worth re-checking if any of this looks wrong later.

`server/test/navmesh-surface.test.mjs` pins all of it: that every bot-reachable waypoint
has ground, that the tower tops have a floor while the navmesh alone still does not, that
the footprint probe cannot cross a storey, and that ground directly underfoot always beats
the rim. The safety claim in the generated header — that the 4.0 window both callers pass
is narrower than the 6.07 two stacked surfaces ever come to each other — is now read out
of `bots.js` and `server.js` at generation time and **throws** if someone widens either.
