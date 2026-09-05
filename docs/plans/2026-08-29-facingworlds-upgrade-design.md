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

## Landed 2026-09-02, later — the weapons, the voice, and one thing that did not land

Six weapons now, not three. The Rocket Launcher, Ripper and Redeemer fly, every weapon
has UT99's own sound, the announcer is back, and headshots work. All of it derived from
the retail packages rather than typed — `scripts/lib/upkg.mjs` reads UE1 class defaults
and the UnrealScript source Epic shipped inside each `.u`, which turned out to be the key
that made everything else honest.

- **The numbers are Epic's.** Rocket 900 uu/s, 75 damage, 220 splash; ripper 1300, 30, six
  wall hits; Redeemer 600, 1000, 300. The falloff curve too — `Razor2Alt`'s own `BlowUp()`
  spells it as `1 - FMax(0, (dist - Victims.CollisionRadius) / radius)`, which is why
  splash measures from the edge of a collision cylinder rather than its centre.
- **The explosions are not shaders, because UT99's were not.** A rocket blast is eight
  frames over 0.7 s on a camera-facing quad; the Redeemer's is eighteen over one second.
  Both classes are `Style STY_TRANSLUCENT`, and in UE1 a translucent sprite's brightness
  IS its opacity — `WarExplosion`'s last frame is fully opaque near-black, so alpha
  blending ends the Redeemer on a black square. The procedural FireTexture smoke is
  deliberately absent: it is a cellular automaton over a palette, a few hundred bytes of
  parameters rather than an image.
- **Headshots are the one number a client has a say in.** A hitscan shot resolves on the
  client, so the server now takes the point its trace stopped at — and accepts it only if
  it lies on the ray of the shot being spent and inside the victim. A point failing either
  gets a body hit, so a flattering lie costs the liar their own bonus and nothing else.

### canSee against real walls: measured, and NOT adopted

`server/map-collision.js` gives the server all 3,240 map triangles and a 2.4 us raycast,
which is what `canSee` has wanted since it was written. It is behind `BOT_LOS=walls` and
staying there. The reasoning is in `canSee`'s own comment; the short version:

- It is **right about the mesh**. On engageable pairs the terrain rule blocks 0.7% and
  this blocks 69.7%, and 71.3% of those are a genuine wall against 0.3% grazed floor.
  Bots have been shooting through the towers.
- **The cost is not a tuning problem.** Four 120-second runs per configuration,
  interleaved, counting hits per second spent *at the post* rather than per wall-clock
  second (dying more means more time walking back, which flatters the deadlier rule):

  | | hits/s at the post | deaths |
  |---|---|---|
  | terrain rule, as shipped | 0.79 ± 0.20 | 9.5 |
  | walls + `MAX_FIGHT_DY` 30, acc 0.36, react 450 | 0.16 ± 0.33 | 2.0 |

  The spread on the second row exceeds its mean, and that IS the finding: three of its
  four runs were **exactly zero** — no bot ever found the player — and the fourth was an
  ordinary 0.65. Sharpening the aim does not help, because the problem is not how well
  bots shoot once they see you. Nothing brings them into the room. **The enemy flag
  becomes a safe place to stand.**
- **And the assets disagree.** Four of eight cases in `bots-los.test.mjs` fail, two badly:
  a defender cannot see their own flag, and two nav nodes 3.1 m apart are separated by a
  wall. `FlagBase1` is boxed in on 7 of 8 sides, the only one of 112 walkable nodes that
  is. That is the failure the height-field version was already fixed for once.

So there are **two** things to fix, not one: bots need a reason to enter a room they
cannot shoot into, and Epic's placements need reconciling with the fan mesh. A correct
rule that makes the enemy flag safe to stand on is worse to play than an incorrect one.

### A correction, and why the harness is now in the repo

An earlier version of this section said the cost *was* recoverable, at 0.47 against 0.50.
It was measured with a throwaway harness that moved its dummy locally without checking the
server had accepted the pose — and the server refuses the first hop of every life, because
`dt` is measured from the last ACCEPTED pose and a client that has never sent one gets it
clamped to about eight units. The dummy walked in its imagination and was shot wherever
the reject-limit resync dropped it, which was not the enemy flag.

`scripts/measure-lethality.mjs` now watches a second connection to confirm every step, and
throws a run away if the dummy never arrived. It lives in the repo rather than a
scratchpad for the same reason the UE1 package reader does: this is the second time
throwing the tooling away cost real work, and the first time it produced confidently wrong
numbers rather than merely absent ones.


## Landed 2026-09-03 — Epic's own level, read and then declined

The last open item said `canSee` "knows floors, not walls" and that closing it "needs the
map mesh on the server, not the navmesh". The obvious next move was to stop approximating
CTF-Face and use Epic's own level file. That now reads, in full — and it is not adopted,
for a reason worth writing down before someone tries it again.

`scripts/lib/ubsp.mjs` + `scripts/build-ut-bsp.mjs` lift the BSP out of `CTF-Face.unr`:
6,749 triangles from 2,868 node polygons, with the two backdrop rooms dropped as
connected components (they sit 140+ m outside the actor box, so no threshold between 40
and 200 m changes the answer) and `PF_NotSolid`/`PF_Portal` surfaces dropped as
non-blocking. `PF_Semisolid` and `PF_FakeBackdrop` are kept: semisolid is about how the
BSP is *cut*, not whether you can walk through it, and a fake backdrop is still a wall —
you cannot rocket-jump out of CTF-Face in UT99 either.

**Epic's geometry is the better description of the level, and that was never in doubt.**
Dropping a ray from each of the 166 NavigationPoints, Epic puts 151 within 2 m of the node
at a median of 1.24 m — which is what a NavigationPoint *should* read, since a pawn's
half-height is 39 UU = 0.92 m. The fan model manages 129, with a p90 of 9.13 m and 15
nodes more than 10 m out. Fourteen of the ones it puts on the wrong storey are
InventorySpots; Epic's geometry puts **every** InventorySpot on real floor.

**It still cannot be adopted on its own,** because collision has to agree with what the
player sees, and what the player sees is the fan model. Against the *rendered* mesh at
those same points:

| | |
|---|---|
| within 0.5 m of the visible floor | 36 / 166 |
| Epic below it by >0.5 m — a rocket sinks into the ground | 95 |
| Epic above it by >0.5 m — an invisible ledge | 35 |

p25 −1.19 m, median −0.53 m, p75 +0.18 m, p95 +10.0 m. **That spread is the finding.** It
is not a constant offset a single number could absorb; it is genuine disagreement about
where the floor is, nearly everywhere rather than only in the tower interiors. The cause
is in `map-transform.js`: `WORLD_SCALE` and `OFFSET` were fitted to land Epic's *actors*
on the *fan* model, so the fit has already absorbed the difference between the two, and
Epic's geometry pushed through that same transform lands consistently wrong.

So the geometry is a package deal — render and collide from one asset, or keep both from
the other. Moving the visuals across needs the textures out of a dozen `.utx` packages and
the lightmaps UT99 bakes into the Model; without them the level renders flat and looks
*worse* than the fan model, which is the opposite of the goal. `gen-map-collision.mjs`
therefore stays on the mesh the game draws, and `scripts/data/ctf-face-bsp.json` is
committed as groundwork with nothing consuming it.

### A correction

The section above replaces an earlier verbal recommendation to "adopt Epic's BSP for
collision now, keep the fan map for rendering", which claimed the invisible-wall objection
"barely applies here". It applies squarely. That conclusion came from comparing the two
assets at ±1.5 m and ±2.0 m tolerance bands — coarse enough to hide a 0.5–1.2 m systematic
disagreement — and from a "10 nodes with nothing beneath" figure measured against the
navmesh rather than against the rendered mesh. Measured against what is actually drawn,
only 36 of 166 points agree to half a metre. **A tolerance chosen loosely enough to make
two assets look interchangeable will do exactly that.**

One real bug came out of the exercise and is worth keeping even though its caller is
reverted: `uuToScene` maps (x, y, z) -> (x, z, y), a swap with determinant −1, so it flips
handedness and **reverses the winding of every triangle**. Floor normals come out pointing
at the floor. It is silent — the geometry lands in exactly the right place and raycasts
still hit, so only whoever asks for a normal ever finds out. `lib/ubsp.mjs` documents it at
the point the loops are handed over.

## Landed 2026-09-04 — the ground, the facing, and a measurement that lied twice

Two visible bugs, and then a longer lesson about how they were checked.

**Five of 23 avatars ran sideways.** `docs/ut99-character-extraction.md` already held the
cause without drawing the consequence out of it: six UT99 meshes carry
`RotOrigin [0, 90, -90]` and are authored lying down, the bonus-pack ones carry `[0,0,0]`
and are authored standing, and the extraction "read the axis off RotOrigin and asserted it
matched the tallest axis". That fixes UP — every model measures exactly 1.830 m — and
never applies the YAW. Measured on the committed geometry as the direction the feet sit
forward of the body, six models cluster at about −162° with 44° of pose noise, and skaarj
(+78°) and warcow (+86°) sit 90° outside it. The correction goes on the MODEL, never the
rig: the rig's `rotation.y` is the player's heading and is overwritten by every pose
packet.

**Bodies waded through the map,** because "where do I stand" was answered by
`assets/3d/navmesh.gltf` while the eye looked at `assets/3d/map/`. Only 47 of 143 nav
nodes put a body within 10 cm of the drawn floor; 32 floated above it and 15 sank below,
the worst by 3.17 m. Taking the standing surface from the map mesh gives **116 of 143**
within 10 cm and 8 floating.

Getting a floor out of a *visual* mesh needs two filters, and the second is not optional.
Level-enough takes 3,240 triangles to 1,402 — but this mesh's winding is not trustworthy
(`gen-map-collision.mjs` raycasts it two-sided for that reason), so a normal cannot tell a
floor from a **ceiling**. What separates them is the space above: cast up, keep only what
has a pawn's height of clear air, 1,402 → 1,041. Not a delicate threshold — 1.2 m keeps
1,063 and 2.2 m keeps 1,007.

**Occlusion stays on the navmesh,** which was learned by breaking it. Moving that across
too made the ridge between the towers stop blocking a flag-to-flag shot — the most obvious
occluder on the map. Along that line the map-derived surface answers at one sample point
in ten: the ridge flanks are steeper than the walkable filter, so they are dropped, and a
height field with holes cannot report that the ground came up. So the map answers "what am
I standing on" and the navmesh answers "did the ground rise between us", and
`standHeightsAt()` exists so that split is visible in the API rather than implicit.

### The measurement lied twice, in opposite directions

Re-running the lethality harness after the surface change gave 0.386 hits/s against a
shipped baseline of 0.79. **That was reported as a regression. It was not one.** The
baseline had been measured on a different day, and this harness interleaves its
configurations *because* absolute rates drift with whatever else the machine is doing —
so cross-session is the one comparison it cannot support.

Then it was reported as exonerated, on a `groundRisesAbove` comparison that agreed on
595 of 595 pairs. **That was not a result either.** `groundRisesAbove(x, z, limit)` takes
three arguments and the test passed six, so both builds computed the same nonsense and
agreed perfectly about it.

A back-to-back control run then showed 0.964 against 0.386 and looked decisive. It was the
first mistake again in better clothes: minutes apart on one machine is not interleaved.

`scripts/measure-lethality.mjs` now takes `SURFACE_A`/`SURFACE_B` and interleaves two
builds of a generated file the way it interleaves configurations, restoring the tracked
file on exit. Run that way at n=5 the two surfaces are **0.697 ± 0.364 against
0.739 ± 0.274** — indistinguishable, with the new one marginally ahead.

The number worth keeping is the spread: **one build scored between 0.422 and 1.330 hits/s
within a single interleaved session.** Threefold, same code, twenty minutes apart. A mean
of three samples from that carries almost no information, which is why two separate
careful-looking comparisons both produced confident nonsense.

What survived scrutiny, and is now measured with the right function signature: `canSee`
agrees 47.5% against 47.6% over 3,744 engageable pairs (8 flips), coverage loses 141
points and gains 57 of 16,130, and the new surface is *smoother* along a bot's path
(median step 0.001 m against 0.055 m). Nothing in the mechanism ever supported a halving.

## Landed 2026-09-05 — three invented firing systems, replaced with Epic's

Everything a shot did on screen was made up here. Reading UnrealScript instead produced
three separate replacements, and one of them is a straight deletion.

**There is no aim recoil in UT99.** `GAME_CONFIG.WEAPON.RECOIL_PITCH/YAW` pushed the
camera up and sideways on every shot with a partial recovery, and `KICK_PITCH/KICK_ROLL`
rotated the weapon model to fake a snap. Neither exists in the engine: firing never touches
`ViewRotation.Pitch` or `.Yaw`, so **the crosshair does not move when you fire**. What a
weapon calls is `PlayerPawn.ShakeView(time, RollMag, vertMag)` — a cosmetic ROLL of the
view plus a vertical jolt of the eye, both decaying on their own, neither affecting where
the trace goes. Ported verbatim in `src/game/components/view-shake.js`, integer UE1 rotator
and all (65536 units to a turn, the roll hunted between a random 0.5x–1.5x reversal
threshold and hard-clamped at 1.3x the magnitude, plus a 3·dt chance per frame of flipping
direction for no reason). Ten `node:test` cases in `server/test/view-shake.test.mjs` pin
the arithmetic with an injected `FRand()`. The one thing not Epic's is the unwind after the
timer runs out: a flat linear decay sized so a full excursion at the default magnitude is
gone in ~0.2 s.

**Applying that roll took a new node in the markup, and the reason is worth writing down.**
UE1 draws the view weapon with the player's whole `ViewRotation` applied to it, roll
included — so a rolling view carries the gun with it and the gun looks *nailed to the
screen* while the world tilts. Reproducing that needs the roll on two transforms, not one:
the `PerspectiveCamera` (`el.getObject3D("camera")`, so the world moves) and a new
`#view-shake` entity that parents the gun (so the gun cancels it out). It cannot go on
`#cam` itself: **look-controls rewrites `#cam`'s rotation every frame** from its own
pitch/yaw objects, and **ut-jump owns `#cam`'s `position.y`** — the camera is a direct
child of the rig and the hop is applied to the rig's children, caching their rest heights.
Either would have eaten the shake, and the second could have baked it in permanently.

**The gun animates now, and the Enforcer was the one weapon that could not.** UE1 view
weapons are baked vertex animations — `PlayAnim('Shoot', 0.81)`, `LoopAnim('Sway', 0.2)`
with a 4% chance of a one-shot `'Twiddle'` at each loop end, `'Select'` on bring-up with
the class's `SelectSound`. They arrive as glTF morph-target clips (82 targets on the
Enforcer) and are driven through `THREE.AnimationMixer` in
`src/game/components/view-weapon-anim.js`, one mixer per drawn gun. Transitions are hard
cuts on purpose: `PlayAnim` replaces the running sequence outright, and the snap between
Sway and Shoot is a lot of why UT99 weapons read as fast. The Enforcer's exclusion was
structural — `setWeapon()` returned early because `spec.model` is null (it has no floor
pickup) and index.html put the static *pickup* mesh in your hands. All six now go through
one `refitWeapons()` → `dressSlot()` path, and the slots are permanent entities whose
`gltf-model` changes, so a weapon you have held before comes back without a reload.

`'Down'` is deliberately **not** played, and the manifest's clip is deliberately unused:
A-Frame's `gltf-model` detaches the outgoing mesh synchronously inside the same
`setAttribute`, so the pose would have zero frames to be seen in — and holding the new
weapon back behind an animation would be a visible lie about what the server already thinks
you are shooting.

**Handedness, and why the rifles are drawn inside-out.** UT99 puts the single Enforcer in
the LEFT hand (AutoML is a left-hand mesh) and the five rifles on the right — but the
rifles are *also* authored as left-hand meshes, because UE1 mirrors the view weapon for a
right-handed player. Drawing them where UT99 draws them therefore means `scale.x =
-MODEL_SCALE`, which inverts triangle winding. three.js compensates on its own — the
renderer reads the determinant of `matrixWorld` and swaps the front face — so the
`THREE.DoubleSide` applied to mirrored guns is belt and braces, not what keeps them
visible; remove it and nothing should change. The barrel-tip child is stored
**unmirrored**: it inherits the negative scale, so a point at +x lands at -x, which is
already where the mirrored tip is. Negating it as well would put the muzzle on the wrong
side of the gun. Dual Enforcers use two different meshes (AutoMR on the right, AutoML on
the left), each with its own mixer, and only the gun that actually fired animates.

**The muzzle flash was a 3D object pretending to be a 2D one.** `Engine.Weapon.
RenderOverlays` draws `Canvas.DrawIcon(MFTexture, MuzzleScale)` in Style 3 — a screen-space
icon where black is transparent — and **only the Enforcer and the Sniper Rifle have one at
all**. The procedural quad, its canvas texture and the `PointLight` beside it are gone;
what replaced the light is `PlayerPawn.ClientInstantFlash`, the engine fog that tints the
whole view for a frame (the Enforcer's is −0.2 at a warm 0.325/0.225/0.095). Both are DOM
overlays owned by `hud-root.js` (`muzzleFlash()`, `instantFlash()`).

They are body children rather than children of `.ut-hud`, which is not a stylistic choice:
`.ut-hud` is `position: fixed; z-index: 900` and therefore a **stacking context**, and
`mix-blend-mode` cannot see out of one. A `screen` blend inside it would composite against
the HUD's own transparent background, and the muzzle texture's black field — the part that
is supposed to disappear — would have stayed black. At `z-index: 899` they also land in
UE1's own draw order, under the HUD.

**Two things the extraction had wrong, both found by rendering the meshes and looking.**
None of the six view weapons had ever been seen: the Enforcer pointed sideways and the
five rifles pointed at the player's face, and every numeric check passed because the
checks only asked whether the long axis was Z, never which way along it. The first cause
is that **frame 0 of a UE1 view mesh is not its resting pose** — every one of them opens
with its `Select` sequence, so `frame(0)` is a gun mid-swing, and `Rifle2m`'s long axis
at frame 0 is not even the same axis as at rest. The second is that **`RotOrigin` is
applied as the inverse**: `FRotationMatrix`'s rows are the rotated frame's axes, so mesh
→ actor is `Mᵀv`. With both fixed, Epic's own rotators orient all six correctly — the
Redeemer's three-axis one included — and this was checked against animation the meshes
carry rather than by eye: a fired gun recoils along −X and a holstered one drops along −Z
on all six. Orientation is now baked into the glTFs (barrel −Z) and `rotationDeg` is zero.

Separately, **every held-weapon skin had been decoded through the wrong palette**. UE1
names palettes `Palette<N>` per texture group, `Botpack.u` holds four `Palette75`s, and
`utex.mjs` looked them up by name and took the first. The Enforcer's flash came out
lightning green (the BoltHit group), the guns posterised, and the byte-exact umodel check
could not see it because its reference texture's palette name is unique. Properties now
keep the raw object reference and the palette is resolved through it. See
`docs/ut99-character-extraction.md` for both.

The one deviation: UT99 positions the icon at a fixed screen fraction (`FlashY`/`FlashO`)
tied to handedness bookkeeping this build does not have, so the slot's own barrel tip is
projected from world space instead. The flash sits where the barrel is, and tracks it
through sway, the shake and the hand swap.

## Landed 2026-09-05, later — "some of the weapons still feel yank", measured

Jonas's report after the firing-feel work landed, and the first time this project has
had a browser it could drive: Playwright (headed, real GPU) with two probes that are now
`scripts/measure-frametimes.mjs` and `scripts/measure-weapon-motion.mjs`.

**It was not the frame rate.** Every phase — idle, a burst on each weapon, a weapon switch,
dual Enforcers — ran at a flat 8.3 ms (120 Hz) with p95 9.3 ms. The only frames over 33 ms
were exactly two per phase and landed at the instants the probe took its own screenshots.
Weapon switches loaded in three or four frames. So the yank was **motion**, and the second
probe measured it: per frame, the morphed mesh's barrel tip and centroid projected to the
screen, the morph frame showing, the camera's roll and height. The Sniper Rifle was the
reference — 7 px per frame, no restarts — and four things were not like it:

1. **The Enforcer cut its own fire clip on every shot.** `Shoot` runs 0.41 s and the
   cadence is 0.25 s, so the gun snapped back to frame 0 mid-recoil each shot — 73 px, six
   times in seven shots. Worse, `Shoot` and `shot2` had been shipped as a random pair when
   UnrealScript is explicit: `PlayFiring` plays `Shoot`, `PlayRepeatFiring` plays `shot2`
   for every shot after the first while the trigger stays down, and the fire state refires
   only after `FinishAnim`. All three are now in: `anims.fireRepeat`, a burst counter on
   the trigger, and `fireClipBusy()` holding the cadence until the clip is out. Excursion
   went from 69 px with a 73 px snap to a 16 px slide kick with none — which is what
   `shot2` is.
2. **The Redeemer twitched six times a second.** Its `Idle` had been emitted at an invented
   rate of 1.0 "so the weapon would not look dead"; five frames at 30 fps loop every 0.17 s,
   and each wrap was a 201 px jump. `TournamentWeapon.PlayIdleAnim` is empty and
   `WarheadLauncher` does not override it: UT99 plays no idle. Removed. Dead in the hand is
   the reference.
3. **Every clip started with a hard cut.** `PlayAnim`/`LoopAnim`'s third argument is a
   tween — 0.02–0.05 s into a fire clip, 0.1–0.5 s into an idle — and every call site
   passes one except the Redeemer's `PlayAnim('Fire', 0.3)`. The Shock Rifle's entry into
   `Fire1` was a 95 px snap; with the tween carried per clip in the manifest and played as
   a three.js crossfade it is 19 px per frame over the same 95 px of travel. The Redeemer's
   201 px cut into its kicked-up tube is Epic's, tween 0, and stays. Finished one-shots now
   hold their last frame (`clampWhenFinished`) as UE1 does, and the idle tweens from it.
4. **The eye was teleporting.** `ShakeVert` had been written straight to the camera — a
   10 cm (Enforcer) to 21 cm (Sniper) drop in one frame. `PlayerPawn.UpdateEyeHeight`
   never does that: it moves `EyeHeight` toward `BaseEyeHeight + ShakeVert` by
   `min(1, 10·dt)` per frame, a 0.1 s lag against a jolt armed for 0.1 s. Ported; the eye
   now glides 1–2.5 cm per frame to the same 7–14 cm depth.

Two smaller things the probe turned up on the way: `setDual(true)` threw in
`weapon-sway.setRest` because the second slot's component had not run `init()` yet (A-Frame
defers it to load; the rest is now parked and picked up), and the cadence gate's
`Math.max(1, rate)` had quietly made the Sniper Rifle and Redeemer one-per-second guns.

**And the placement stopped being fitted.** With screenshots finally available, the two
by-eye constants (`OFFSET_SCALE`, the markup's 0.2/−0.3/−0.5) were tested against
`Engine.Inventory.CalcDrawOffset`, which puts the weapon's origin at `PlayerViewOffset`
from the eye. Read with the `0.9/FOVAngle` factor UnrealScript shows (a hundredth of a UU)
the eye ends up inside every mesh — screenshotted, it does. Read as plain Unreal Units and
scaled by the same factor as the mesh, all six land where UT99 has them: Enforcer low left,
rifles low right with the receiver's side showing and the barrel on the crosshair, within a
few centimetres of what had been fitted. That is what ships. `MODEL_SCALE` survives only
as a uniform factor about the eye — it moves nothing on screen and exists for the 0.05 m
near plane.

## Landed 2026-09-05, evening — what a shot LOOKS like, once it lands

Three effects in this build were invented rather than read, and one of them was a lie about
where a shot already was. All three are Epic's now, out of a new generated
`src/shared/effects.js` (BotPack/UnrealShare, extracted alongside this work) and drawn by a
new `src/game/components/ut-effects.js`.

**The Shock Rifle had a tracer and a spark. It has neither.** `ShockRifle.SpawnEffect`
spawns a chain of `ShockBeam` segments from the muzzle to the hit, one every 135 UU
(3.17 m), and each segment spawns the NEXT one 0.05 s later — so the beam visibly GROWS
toward the target rather than appearing whole, and a long shot across Face takes most of a
second to arrive. Every segment lives 0.27 s, rolls about its own length at 95.9 rad/s, and
fades with `ScaleGlow`. At the far end a `ut_RingExplosion5` plays its 'Explo' morph
sequence once at AnimRate 0.35 — 0.37 m across to 4.7 m in 0.86 s — with a pooled PointLight
for `ShockExplo`.

The thing that would have been got wrong by reading the mesh instead of the actor: **a
ShockBeam segment is not a mesh at all**. `bParticles` is true, and a UE1 particle actor
never draws its triangles — the renderer draws each of the mesh's forty VERTICES as a
camera-facing `jenergy2` sprite. Shockbm's 76 faces exist only to hold those forty points in
place. Drawn as triangles it is a solid metal rod; drawn as points it is the fizzing dashed
streak the Shock Rifle actually has. It is a `THREE.Points` over the contract's
`particles.pointsM`, one draw call for forty sprites, and the sprite is the glTF's own
texture.

**The Enforcer and Sniper Rifle now do UT_WallHit.** A `BulletImpact` mesh flat against the
surface for 67 ms (its Hit sequence is one frame at 30 fps), one `UT_SpriteSmokePuff` — a
camera-facing quad playing one of four random 8-frame sheets at 0.05 s a frame, drifting up
at 1.18 m/s for 1.5 s — Rand(N) `UT_Spark` billboards under gravity, a real `Pock` decal,
and Epic's four-way sound roll: ricochet at Pitch 0.5–1.5, impact1, impact2, or, one time in
four, NOTHING. The silence is Epic's; it is what keeps a held trigger from becoming a
machine-gun of identical ricochets, and it looks exactly like a bug. `UT_HeavyWallHitEffect`
(the Sniper) rolls a different table with no silence in it, so the odds are read from the
contract rather than written in the renderer. Both guns eject a `UT_ShellCase`, at Epic's
forward/right/up velocity ranges, bouncing at most three times.

**Three deliberate deviations, all in the code:**

1. The Enforcer and Sniper Rifle KEEP their tracer. UT99 draws none — the shot is instant
   and there is nothing to see between muzzle and wall — but UT99 also has a 2D muzzle flash
   filling a third of the screen, and in this build a missed Enforcer shot at 40 m is
   otherwise completely invisible. It is the readability tax. The Shock Rifle has none,
   because its beam IS the tracer and Epic's is better than the invented one.
2. Chips are not drawn. The contract carries UT99's physics for them but names a mesh
   (`ChipM`) the extraction does not ship. A chip is a debris slot that draws nothing, and
   the count is still spent on it, because `UT_WallHit` spends a spark to get one and
   removing the roll would be inventing a livelier wall hit than UT99 has.
3. The shell case is the ONE place the generated table is overruled. It says
   `blend: "additive"`, which comes from `gen-effects.mjs`'s `style === 3 || unlitMaterials`
   rule; the shell is only the second of those. `UT_ShellCase` extends `Debris`, whose Style
   is `STY_Normal`, and its Style is not carried in the extraction at all. Unlit is not
   translucent: drawn additively a brass case is a glowing smear with no depth.

**A remote player's shot no longer flies.** `network.js` used to answer a `fire` message by
spawning a `bullet` entity that TRAVELLED from the muzzle at 70 m/s and drew a tracer when
it arrived. UT99 has no such thing — a hitscan shot lands the frame it is fired — and the
ball was both wrong and a lie about where the shot already was. The same trace is now run
locally on the receiving client and drawn instantly through the same entry point the local
player's own shot uses, with the shooter's own weapon deciding whether that is a beam and a
ring or a tracer and a wall hit, and the report attenuated by distance. `bullet.js` is
deleted.

**Two bugs the browser found.** First, the sprites faced the wrong way. A-Frame hangs the
`THREE.PerspectiveCamera` off the `<a-entity camera>` and never rotates the camera itself —
look-controls writes the pitch to that entity and the yaw to the rig above it — so
`camera.quaternion` is the IDENTITY no matter where the player is looking. Copying it onto a
billboard aims it at world −Z, and a 1.5 m smoke puff drew as a thin vertical smear that
grew and shrank as you turned. It took a screenshot to see; `getWorldQuaternion` is the fix.
(`ut-projectiles.js` copies the same local quaternion onto its blast quads and has the same
latent bug — not touched here.) Second, `gravityMPerSec2` in the contract is UE1's SIGNED
acceleration, −22.325, not a magnitude, so it is added rather than subtracted; the first
version sent every spark and every shell case into the ceiling.

Frame times, measured with `scripts/measure-frametimes.mjs` on the same machine and the same
run shape as the 2026-09-05 morning session: a flat 8.4–8.6 ms mean and 9.2–9.3 ms p95
through every phase, unchanged from before the effects landed, with every frame over 33 ms
landing at the instant the probe took its own `page.screenshot()`. Nothing here allocates
per shot: the pools are fixed (96 beam segments, 40 sparks, 24 pocks, 8 smoke puffs, 8
impacts, 6 shells, 4 rings), halved on mobile, sized from `GAME_CONFIG.EFFECTS`, and every
model and texture is loaded once and cloned into them.

The contract is read defensively throughout — dynamic import inside a try, every field
through a reader that takes a list of candidate names and Epic's own fallback — so a missing
or half-regenerated `src/shared/effects.js` costs the procedural effect for that shot rather
than the shot. `server/test/ut-effects.test.mjs` covers the arithmetic (the beam chain, the
sound roll including its silent quarter, the distance falloff) and the shape of the committed
contract: that every asset it names is on disk, that the fields the renderer reads are the
ones the generator writes, that the beam's spacing really is 135 UU through THIS build's
scale, that gravity is signed, and that the models are longest along the forward axis they
declare.

## Landed 2026-09-05, late — the gun in their hand, and what happens when they pull the trigger

Two things a UT99 `TournamentPlayer` does that a remote avatar here has never done: carry
its weapon, and change pose when it fires. Until tonight every other player on the map ran
around empty-handed, and the only evidence anyone was shooting was the tracer that appeared
out of their chest.

**The weapon in the hand.** `weapon(id).third` — produced this evening alongside this work —
is a glTF already in the CHARACTER's frame: same axes as the body (forward −Z, up +Y), feet
at y = 0, sitting where the pawn holds it. So `remote-avatar` hangs it on as a plain child
entity of the model at the identity transform, and there is no fitting, no scale factor and
no measurement anywhere in the client. It is a child of the MODEL and not of the rig for the
reason `modelYaw` is: the rig's `rotation.y` is overwritten from the wire on every pose, so
anything written there is erased by the next packet. `network.js` puts the weapon on the rig
as `data-weapon` at spawn (from `publicPlayer`, so a player who armed themselves before we
connected is drawn with the right gun) and the component keeps it current from the
`player-loadout` broadcast the HUD and the fire sounds already read — the gun in the hand
therefore cannot disagree with the gun that made the noise. Slots are reused across changes,
so a weapon you have held before comes back with no download.

Dual Enforcers get a second slot, the same file with `scale.x = -1`. That is how
`first-person-weapon.js` mirrors its left hand and it is the only way to reflect a mesh —
rotating it 180° points the gun backwards. three.js swaps the front face on its own for a
negative determinant, so the winding is free; the `DoubleSide` in `_onWeaponLoaded` is belt
and braces.

**The firing pose, which is not an additive animation.** UT99 does not blend a fire onto a
run. It ships a SECOND COMPLETE SET of locomotion sequences authored with the weapon
levelled, suffixed FR, and `PlayFiring` writes `AnimSequence = 'RunSMFR'` straight over
`'RunSM'` at the frame it had reached; a pawn standing still gets `PlayRecoil`, an 8-frame
one-shot, instead. So the new `Fire` / `WalkFire` / `RunFire` clips are NOT a fourth blend
weight here. They are ALTERNATES that the existing Idle/Walk/Run weights drive: each
channel's weight is split between its plain clip and its twin by one crossfade
(`REMOTE_FIRE.CROSSFADE`, 0.05 s), so the three channels still sum to one however far
through a swap the body is, and the existing blending is untouched.

`remote-fire-state.js` is the timing, pulled out as a pure module so it can be tested
without a browser (`server/test/remote-fire-state.test.mjs`, 9 cases). The trigger being
DOWN is not on the wire — only discrete shots are — so both poses are held for 500 ms after
the last one rather than edge-triggered. That is two Enforcer shots' worth of cadence, so a
burst reads as one continuous firing pose instead of flickering back to the idle between
rounds, and it is also about the length of `PlayRecoil` itself (8 frames at 15 fps = 533 ms),
so the recoil finishes at roughly the moment the hold lets go of it.

**The one thing that needed real care.** three.js does not advance a zero-weight action's
time. The FR twin is therefore FROZEN wherever it was last left — often most of a stride out
of phase — and fading it in naively makes the legs skip, which is exactly what UT99 does not
do: the engine writes `AnimSequence` and leaves `AnimFrame` alone. `_syncVariantPhase` copies
the normalised time across between a clip and its twin, but only while the crossfade is
parked at one end; writing `time` mid-fade would yank the clip that is already visible.

`network.js` emits ONE scene event, `remote-fire {id, weapon}`, for both ways a shot reaches
this client: the `fire` message a hitscan weapon sends, and the `projectile` message the
server sends for the three that fly (whose shooter is `owner`, not `id` — `id` is the
projectile's own). A rocket therefore raises the arms exactly as a bullet does. The held mesh
plays its own sequence too where it has one: only the Enforcer's AutoHand (`Shoot`, and
`shot2` for a follow-up inside 400 ms, UT99's own test) and the Shock's, which `LoopAnim`s
while the trigger is down and is put down when the hold lapses — this client's only "trigger
up".

**Measured in the running scene**, with bots fighting: every bot carries
`assets/3d/thirdperson/enforcer/enforcer.gltf` with its mesh loaded and its mixer built. A
Skaarj photographed mid-sprint at the instant of a `remote-fire` shows `Run` 0.676 /
`RunFire` 0.324 mid-crossfade, arm levelled, tracer leaving the raised hand. A standing SGirl
goes from arms-folded to both arms thrown up and out — `Fire` at 0.945, `Idle` at 0.055 —
and 800 ms later is back at `Idle` 1.0 with every twin at zero, so nothing sticks. Bots do
fire standing, but rarely: 11 of 621 shots over 45 s, which is why the recoil was easiest to
photograph by emitting the same scene event `network.js` emits. Frame times unchanged at
8.3–8.5 ms mean, 9.0–9.2 ms p95 through all 25 phases of `scripts/measure-frametimes.mjs`.

**Everything degrades.** A character glTF with only Idle/Walk/Run animates exactly as it did
before; a weapon with no `third` block leaves the hands empty; a `third` with no `anims`
simply does not animate the gun. Nothing here throws if the tables are half-regenerated.

### Open

**The held mesh is centred on the body's midline, not in a hand.** `third.bboxM` for the
Enforcer is x −0.0329 … +0.0329 — symmetric about x = 0 — and y 0.839 … 1.049, hip height on
a 1.833 m pawn. On screen the gun floats at the pelvis rather than sitting in the right hand,
and it does not move when the arms do, because a UT99 character is vertex-animated and has no
bone to parent to. This is the asset's placement, not the client's: the client parents at the
identity transform exactly as the contract says. Two consequences worth naming — the second
Enforcer mirrors onto almost exactly the first, since a mirror across x = 0 of something
centred on x = 0 goes nowhere; and no offset should be fudged into `remote-avatar.js` to
compensate, because it would have to be unpicked when the extraction is corrected.

**The AR spectator table gets the gun but not the swaps.** `src/ar/three/players.js` clones
the same held mesh onto each figure at the character's own scale, foot offset and model yaw,
untinted and with no mixer — a figure a few dozen pixels tall has no readable recoil. It
reads `weapon` off `publicPlayer`, which the spectator socket relays on `hello`, `join`,
`spawn` and `respawn`, so the gun is right at join and right again after every death; a
pickup taken mid-life does not show until that player next respawns. Relaying `loadout` would
fix it and belongs in `src/shared/net/spectator-client.js`. This path is UNVERIFIED in a
browser: the table only builds figures inside a live AR session, and on desktop it loads no
character models at all, so there was nothing to photograph. The page itself loads clean.

**Where the gun actually goes: UE1's weapon triangle.** The first extraction put every
third-person weapon at the pawn's actor origin, and in a render on the soldier all six sat
at the hip with the hands raised above them. Fitting the grip to the fist under every way
of applying `Mesh.Origin` got no closer than 49 cm. What closed it was the three *special
vertices* every pawn mesh carries — `umesh.mjs` had reported them from the start, no face
references them — which bracket the gun hand: one a hand's width above the fist, one below,
one out along the aim. That is UE1's carried-weapon attachment, and it is **per frame**. It
now ships as an empty node `weaponAnchor` in every character glTF with translation and
rotation tracks on all six clips, keyed on the same times as the morph weights, so the body's
own mixer moves it; `remote-avatar.js` places the held slot on it every frame (the dual
pair's second gun mirrored across the body's X), and the AR table parents the gun under it
outright. The base-pose hand is 85 cm from the sprinting Soldier's swung hand — measured
again in the game as 36–90 cm of slot travel per running bot, matching each model's own
amplitude — so the static offset (`weaponOffset()`, kept as the fallback) was never going to
be enough. The third-person glTFs lost their nominal lift and are about the weapon's own
origin; the anchor supplies the position. One incidental fix: the weapon child's
`model-loaded` bubbled into the body's handler and rebuilt its mixer six times a spawn.
