# Facing Worlds

A browser multiplayer FPS recreating UT99's CTF-Face, built on three.js r180 (vendored
at `assets/libraries/three/`, no framework) with a WebSocket game server, plus an AR
spectator page on the same three copy. Static site, no build step: GitHub Pages serves
this repository as-is at <https://facingworlds.org>.

## HUD art

`assets/ut99/` holds four original UT99 HUD textures (Epic's; see the NOTICE
there). `GAME_CONFIG.HUD.ATLAS` switches the HUD between drawing from those
atlases exactly as `ChallengeHUD.uc` does, and the in-repo SVG/CSS recreation.

## Features

- **Multiplayer Support**: Real-time multiplayer with WebSocket networking
- **3D Environment**: Immersive 3D world with navigation mesh
- **Camera Controls**: Switch between 1st person, 3rd person, and overhead views (Press C)
- **Combat System**: Shoot bullets and hit targets
- **Character Animation**: Smooth character animations and movement
- **Health System**: Player health with visual feedback

## Project Structure

```
index.html                     # the game: one <canvas>, the import map, the credits
ar/                            # the AR spectator page (separate entry point)
marker.html                    # printable/displayable AR marker
styles.css
CNAME                          # facingworlds.org -> GitHub Pages

scripts/
├── optimize-assets.mjs        # build-time glTF optimizer (devDependency only)
├── gen-map-actors.mjs         # CTF-Face actor table  -> src/shared/map-actors.js
├── gen-nav-graph.mjs          # Epic's path network    -> server/nav-graph.js
└── gen-navmesh-surface.mjs    # the navmesh as a height field -> server/navmesh-surface.js

server/
├── server.js                  # WebSocket game server, port 8081
├── bots.js                    # server-side players with no socket
├── nav-graph.js               # GENERATED — 166 nav nodes, 592 of Epic's ReachSpecs
└── navmesh-surface.js         # GENERATED — 791 navmesh triangles + a plan index,
                               # so the server knows where the ground is

assets/                        # source media. assets/3d/ is the optimizer's INPUT
│                              # and is no longer downloaded by the browser
├── 3d/                        # original .gltf/.glb + loose PNGs (~35 MB)
├── libraries/                 # three r180 (+ addons), encantar, vendored
├── audio/  graphics/  images/  models/
assets-optimized/3d/           # what index.html actually loads (committed, 4.5 MB)

src/
├── game/
│   ├── core/main.js           # entry point: builds the world, registers the systems
│   ├── engine/                # renderer + frame loop (game.js), input, asset loading
│   ├── scene/                 # the map, its lights
│   ├── player/                # the rig: controller, navmesh clamp, view shake, spawn
│   ├── systems/               # everything that runs per frame: weapon, effects,
│   │                          # projectiles, remote avatars, pickups, CTF, bloom, ...
│   ├── hud/                   # the DOM HUD
│   ├── network/network.js     # WebSocket client
│   ├── config/game-config.js  # network URLs, health, camera, bullets
│   └── utils/
├── ar/                        # the AR page: src/ar/three/, its config, vendored loaders
└── shared/
    ├── *.js                   # GENERATED tables (map actors, weapons, effects, ...)
    └── net/                   # snapshot interpolation + spectator client
```

## Getting Started

### 1. Install

```bash
git clone <repo-url> && cd facingworlds.org
npm install                  # devDependencies: http-server, @gltf-transform/cli
npm install --prefix server  # the game server's only dependency: ws
```

No asset step is needed on a fresh clone — `assets-optimized/` is committed. Run
`npm run optimize:assets` only if you change something under `assets/3d/`.

### 2. Run both servers

They are two different processes on two different ports. This matters: they used to
collide on 8080, which made the client report ONLINE while talking to the file server.

```bash
# terminal 1 — static site on :8080
npm start                    # npx http-server . -p 8080 -c-1

# terminal 2 — WebSocket game server on :8081
node server/server.js        # or: npm start --prefix server
```

`server.js` prints `✅ ws server on :8081` when it is up.

### 3. Open

<http://localhost:8080/> — the game. `src/game/config/game-config.js` sends any host
that is not `localhost`/`127.0.0.1` to the production WebSocket server, so open it on
localhost to hit your local one.

Open a second tab to see multiplayer, or point a phone at your machine's LAN address.
Two caveats for a phone: `npm start` serves plain HTTP, and the AR page needs **HTTPS**
for camera access, so serve over TLS for that (`npx http-server . -p 8080 -c-1 -S -C
cert.pem -K key.pem`, e.g. with an `mkcert` certificate); and `LOCAL_URL` is
`ws://localhost:8081`, which on the phone means the phone itself — point it at the LAN
address to play against your desktop.

## Controls

**Click the page to play.** The game runs on pointer lock, so the first click hands the
mouse to the game and a "CLICK TO PLAY" sign stands in until it does; Escape gives the
mouse back. Before pointer lock was enabled you had to *drag* to look, and the left
mouse button did nothing — `first-person-weapon.js` only fires while
`document.pointerLockElement` is set, which it never was.

- **WASD**: Move
- **Mouse**: Look (pointer-locked, 0.002 rad/px)
- **Left click** or **X**: Fire
- **Space**: Jump
- **Q / E**: Turn the rig without the mouse
- **Tab**: Scores
- **Esc**: Release the mouse

## Camera Modes

1. **1st Person**: Camera inside character's head
2. **3rd Person**: Orbit camera around character (Unreal Tournament style)
3. **Overhead**: Top-down strategic view

Note that only 1st person is wired up: the `C` handler in `first-person-weapon.js` is a
guarded hook with no `swapCamera` behind it.

## Bots

Five a side by default (`BOTS_MIN_PER_TEAM`, ceiling `BOTS_MAX` 10), walking Epic's own
CTF-Face PathNode/ReachSpec network. They only exist while a human is on a team, and a
human joining pushes one off the roster. A bot is an ordinary entry in the server's
`players` map with no socket, so it goes through the same damage, flag and respawn code
a human does — see the header of `server/bots.js`.

### Where the ground is

`server/navmesh-surface.js` is the shipped navmesh baked into a height field (791
triangles plus a plan index, generated by `npm run gen:navmesh-surface`). The server had
no idea where the ground was before it existed, and two things were wrong because of it:

- **Bots waded through the rock.** Nav-graph waypoints are Epic's placements through the
  similarity fit in `src/shared/map-transform.js`, which is good to about a unit
  vertically indoors — and a bot lerped its `y` straight between them, so any slope that
  bulged in between was walked through. Two fixes, both needed: `gen-nav-graph.mjs` now
  snaps every node's `y` onto the navmesh (102 of 166 moved, median 0.44, max 1.73), and
  `bots.js` re-snaps a bot's `y` every tick. Measured over 5,145 broadcast poses
  afterwards: **99.8% within 0.10 of the surface**, worst 0.20 — against up to 0.9 *under*
  it before.
- **There was no line-of-sight test.** A flat "more than 6 units apart vertically" gate
  stood in for one. `canSee()` in `bots.js` now walks the shot and asks whether the
  ground has risen above it. Honest accounting: inside the range bots actually engage at
  (40 units, 6 of height difference) that blocks 0.7% of walkable node pairs — it is not
  why the game got less lethal, and `server/test/bots-los.test.mjs` pins both the cases
  it must catch and the two ways the rule was wrong on the way here.

### How hard they hit

Tuned against a measurement, because "more bots" and "less easy to die" pull against each
other. The test parks a motionless player on the enemy flag — the worst case, since the
bots' hit chance is highest against a stationary target — for 180 s:

| | median time alive | incoming hits/s |
| --- | ---: | ---: |
| before: 2/team, 20 dmg, accuracy 0.60, reaction 300 ms | 9.1 s | 0.36 |
| 5/team with only the damage cut (17 dmg, 0.42, 420 ms) | 5.4 s | 0.57 |
| **now: 5/team, 17 dmg, accuracy 0.26, reaction 550 ms** | **13.0 s** | **0.31** |

The middle row is the whole reason this is written down: five a side swallowed the damage
cut on its own, and shipping it there would have made the game *more* lethal while the
commit message said the opposite. 17 is the real UT99 Enforcer's `HitDamage`; a moving
player halves the hit chance again on top of the table.

One 180-second sample per row, 9–17 deaths each, so read the ordering and not the second
decimal. Re-run it before trusting a small change to any of these numbers.

`BOTS_ACCURACY` (0..1) and `BOTS_REACTION_MS` are environment knobs, so this can be
turned on a live server without a deploy. `BOTS_ENABLED=0` removes bots entirely.

## Development

### Configuration

Game settings can be modified in `src/game/config/game-config.js`:

- Network URLs (local vs production)
- Player health and movement settings
- Camera positions and angles
- Bullet physics and appearance
- Animation parameters

### Environment Detection

The game automatically detects development vs production environment:

- **Development**: Uses local WebSocket server (`ws://localhost:8081`; the static server runs on 8080)
- **Production**: Uses remote server (`https://unrealfest-server.onrender.com`)

### Error Handling

The game includes comprehensive error handling:

- Network connection errors
- Model loading failures
- Spawn failures
- Performance monitoring

### Performance Monitoring

Performance metrics are logged in development mode:

- FPS monitoring
- Memory usage tracking
- Slow operation detection

## Asset Pipeline

The game ships ~35 MB of glTF assets on first load, almost all of it uncompressed
PNG. `scripts/optimize-assets.mjs` produces optimized **copies** into
`assets-optimized/` — it never writes into `assets/`, and it refuses to run if
pointed at the source tree.

```bash
npm install                 # @gltf-transform/cli, devDependency only
npm run optimize:assets     # auto codec, Draco geometry
npm run optimize:assets:dry # print the plan, write nothing
```

The browser code stays dependency-free; this is a build-time tool only.

### What it does

For each asset the game actually loads, in order:

1. `copy` — normalize to a self-contained `.glb` (pulls the map's three external PNGs in).
2. **World scale** — `FacingWorlds_tex_5.glb` and `navmesh.glb` only. See below.
3. `prune` + `dedup` — drop unused nodes/materials/accessors, merge duplicates.
4. `resize` — cap texture edge length (pistol 4096 → 2048, avatar → 1024).
5. **Texture codec, in two passes.** Colour maps are perceptual and take lossy
   compression well. Normal and ORM maps are *data* — the shader reads their
   channels as vectors and scalars, so artifacts show up as shading noise. They
   get the gentler setting.
6. **Geometry compression** — Draco by default.

Useful flags: `--world-scale=<k>`, `--codec=webp|ktx2|none`,
`--geometry=draco|meshopt|none`, `--quality` (colour, default 90),
`--data-quality` (normal/ORM, default 95), `--near-lossless`, `--out=<dir>`,
`--only=<substr>`.

### The world scale, baked in (step 2)

The fan model of CTF-Face is a faithful but *small* copy of the Unreal level: fitting
222 CTF-Face actors against the navmesh puts it at **0.010062 m per Unreal Unit**, while
the player rig is built at UT99 pawn scale, **0.0235 m/UU** (a 78 UU pawn against the
1.83 m Soldier model — see `GAME_CONFIG.MOVEMENT`). The map was therefore 43% of the size
every movement, jump and weapon number assumes: 30 m towers instead of 71 m, and an 8-second
flag run instead of 19.

`src/shared/map-transform.js` holds the correction — `WORLD_SCALE = 0.0235 / 0.010062 =
**2.33552**` — as one exported constant, and this step multiplies the map's and the
navmesh's **root node transforms** by it. For a uniform factor `k`, left-multiplying a
node's world matrix `T·R·S` by `kI` is exactly `T(k·t)·R·(k·s)`, so scaling every scene
root's translation and scale is an exact scale about the world origin whatever the
hierarchy below looks like. (The step refuses to run if a root node's transform is
animated, which would need the sampler outputs scaled too. Neither world asset has any
animations.)

**Why baked and not `scale="2.33552 2.33552 2.33552"` on `#world`?** Because
`src/ar/config/ar-config.js` documents the contract *"the game places the map at the
identity transform, so game world coordinates are IDENTICAL to map-model coordinates"*,
and `src/ar/three/players.js` drops raw server pose coordinates straight into the
map-model's node on the strength of it. An entity scale would break the AR spectator
silently — every figure 2.34x too far out, floating off the rock. Baking keeps both pages
reading the same asset. `#world` and `#navmesh` stay at identity, and they must stay equal
to each other or the player floats or sinks.

Everything else world-anchored — flag homes, spawns, pickups, map bounds, light positions
and ranges, the shadow frustum, camera heights, trace ranges — is stored already-scaled in
`server/server.js`, `index.html`, `src/game/config/game-config.js` and
`server/test/ctf.test.mjs`. **Player**-anchored values (eye height, hitbox, speeds, jump,
gravity, recoil, weapon offsets, flag and pickup prop sizes) were deliberately *not*
scaled: the player did not change size, the world did.

Resulting extents, both verified against the written `.glb`s:

| | before | after |
| --- | ---: | ---: |
| map mesh | 111.1 × 47.1 × 41.6 | **259.4 × 110.0 × 97.2** |
| navmesh | 110.2 × 30.6 × 40.8 | **257.4 × 71.5 × 95.3** |
| tower roof height | 30.42 | **71.05** |
| full diagonal | 127.4 | **298.1** |

To re-check the fit, or to revise `k`, run with `--world-scale=<k>` (and change the
constant in `src/shared/map-transform.js`, the mirrored one in `server/server.js`, and
every scaled literal). `--world-scale=1` writes the assets unscaled.

### Measured results

Run on this repo with the defaults (WebP colour q90 / data q95, Draco). Sizes are exact
bytes from `ls -l`, taken after the run that produced the committed files:

| Asset | Before | After | Saved |
| --- | ---: | ---: | ---: |
| `3d/map/FacingWorlds_tex_5.gltf` (+ `.bin` + 3 PNGs) | 14,340,882 B (13.68 MB) | 3,174,340 B (3.03 MB) | −77.9% |
| `3d/enforcer.glb` | 20,440,960 B (19.49 MB) | 556,280 B (543.2 KB) | −97.3% |
| `3d/Soldier.glb` | 2,160,468 B (2.06 MB) | 962,132 B (939.6 KB) | −55.5% |
| `3d/navmesh.gltf` | 45,132 B (44.1 KB) | 4,136 B (4.0 KB) | −90.8% |
| **Total** | **36,987,442 B (35.27 MB)** | **4,696,888 B (4.48 MB)** | **−87.3%** |

`du -sh assets-optimized` reports **4.5M**.

Two things that had to survive the pipeline, and did:

- **`Soldier.glb` clip order.** `index.html` selects animations by index
  (`character="idleIdx:0; walkIdx:3; runIdx:1"`), so a reorder would silently swap the
  avatar's animations. `gltf-transform inspect` reports the same four clips in the same
  order before and after: `Idle, Run, TPose, Walk`.
- **`navmesh.glb` topology.** 791 triangles before and after; the vertex count drops
  2,373 → 853 only because `dedup` welds vertices that were duplicated per-face.
- **Draco quantization at world scale.** Draco quantizes positions over the mesh's own
  bounding box, so scaling the world by `k` multiplies the quantization step by `k` too.
  The default 14 bits gave ±3.4 mm over the old 110-unit map; over the scaled 259-unit map
  it would give **±7.9 mm** — still sub-centimetre, but it eats most of the `0.01`-unit
  coplanarity epsilon baked into the vendored `three-pathfinding`
  (`src/game/vendor/`), which is world-anchored and did *not* scale.
  The two world assets are therefore encoded with `ceil(log2 k) = 2` extra bits of position
  precision (16-bit), giving **±2.0 mm on both the map and the navmesh** — better than the
  ±3.4 mm the unscaled map shipped with. It costs 1.2 KB on the map and 0.7 KB on the
  navmesh. The written bounding boxes match the analytically scaled ones to ≤1 mm.

### Why `enforcer.glb` was 20 MB

Not the mesh. The pistol is 19,199 vertices / 17,744 triangles = **704 KB** of
vertex data. The other **18.81 MB (96.5% of the file) is a single embedded
4096×4096 RGBA PNG albedo** — and it is the material's *only* texture (no normal,
no ORM), stored with an alpha channel the `OPAQUE` material never reads.
Resizing it to 2048 and encoding as WebP is the entire 97% saving.

### Codec trade-off

| | Download | GPU memory | App-side wiring |
| --- | --- | --- | --- |
| **WebP** (default) | small | **unchanged** — decoded to RGBA on upload | **none** |
| **KTX2/Basis** | small | small — stays block-compressed | transcoder required |

WebP is the default because three.js's `GLTFLoader` reads `EXT_texture_webp`
natively, so the optimized files load with **zero code changes**. It shrinks the
download but not VRAM: the map's three 2048² textures still cost ~22 MB each on
the GPU.

KTX2 fixes the VRAM side but needs the `ktx` binary from KTX-Software at build
time (`brew install ktx`); the script auto-detects it and falls back to WebP when
it is missing. It was **not** installed in this environment, so **the KTX2 path
is implemented but unverified** — the numbers above are all from the WebP path.

### Wiring (done)

The game loads the optimized copies. The manifest is `ASSETS` in
`src/game/engine/assets.js`:

| key | src |
| --- | --- |
| `worldGltf` | `assets-optimized/3d/map/FacingWorlds_tex_5.glb` |
| `navmeshGltf` | `assets-optimized/3d/navmesh.glb` |
| `soldierModel` | `assets-optimized/3d/Soldier.glb` |
| `enforcerWeapon` | `assets-optimized/3d/enforcer.glb` |

Nothing else under `src/game/` hardcodes a model path. The AR page has its own list
(`src/ar/config/ar-config.js`), optimized first with the original as a fallback.

**Why these are committed rather than generated at deploy time.** GitHub Pages serves
the repo as-is; there is no build step. Anything not committed does not exist in
production, so a gitignored `assets-optimized/` would mean the deployed site either
breaks or silently falls back to the 35 MB originals — the saving would never actually
ship, which is the state this replaces. A runtime probe-and-fall-back was the
alternative and is worse here: it costs a round trip before the first byte of the map
on *every* load, and the only failure it guards against is the one committing
eliminates. 4.5 MB of tracked binaries against the 35 MB of originals already
in the repo is not a meaningful cost. A fresh clone therefore works with no asset step:
`npm install` is only needed to *re-run* the optimizer.

The originals under `assets/3d/` stay in the repo, byte-identical. They are the
optimizer's input; the game page no longer downloads them.

### glTF extensions the optimized files use

- **`EXT_texture_webp`** — three's `GLTFLoader` registers `GLTFTextureWebPExtension`
  unconditionally in its constructor, alongside the KHR extensions. WebP has been
  supported in every current browser since 2020.
- **`KHR_draco_mesh_compression`** — both pages build a `DRACOLoader` on the vendored
  wasm decoder at `src/ar/vendor/draco/` (`src/game/engine/assets.js`,
  `src/ar/three/assets.js`). Nothing is fetched from a CDN at runtime.

**Drop Draco** with `npm run optimize:assets -- --geometry=none`. Measured cost of doing
so is **+1.18 MB** (4.48 MB → 5.66 MB total, still −83.9%).

#### If you switch codecs

Neither of these is in use today; both would need wiring that WebP does not.

- **KTX2 only** — needs the Basis transcoder (`basis_transcoder.js` + `.wasm`) vendored
  and a `KTX2Loader` set on the `GLTFLoader` in `src/game/engine/assets.js`.
- **Meshopt only** — same shape, via `setMeshoptDecoder`.

### Unreferenced assets

**139 MiB of the 200 MiB of media under `assets/`** is not referenced by
`index.html`, `src/`, or `ar/`. It is downloaded by nobody, but it is in the repo
and in every clone. Deleting is a bigger win than compressing:

| File | Size |
| --- | ---: |
| `graphics/blaubeuren_night_4k.exr` | 29.3 MiB |
| `graphics/earth_ocean_8192.png` | 23.0 MiB |
| `graphics/land_ocean_ice_8192 (1).png` | 23.0 MiB |
| `graphics/gebco_08_rev_elev_21600x10800.png` | 17.6 MiB |
| `models/klp.glb` | 16.9 MiB |
| `images/tracker{,2,3,4}.png` + `Artboard 1.png` | 23.5 MiB |

The AR code uses `images/tracker.jpg` (0.57 MiB), not the 4.7 MiB PNGs.
`assets/models/FacingWorlds_tex_4.*` is a near-duplicate of the map in
`assets/3d/map/`. Nothing here is touched by the script — it is a deletion
decision, not a compression one.

### Not covered by this script

Audio. `index.html` references the 12.1 MiB
`audio/…-foregone_destruction-i-gameplay-audio.mp3` while
`src/game/components/background-music.js` points at a *different* 5.8 MiB file —
both ship, for ~18 MiB of music on a map that needs one track. Re-encoding at a
sane bitrate (or streaming rather than preloading) is the single biggest
remaining first-load win after the glTF work above, and it needs a different tool
(`ffmpeg`), not `gltf-transform`.

## Deployment

The site is a static site with no build step. GitHub Pages serves the repository
contents directly (see `CNAME`), so **whatever the browser loads must be committed** —
that is why `assets-optimized/` is tracked rather than ignored.

1. **Assets** — if anything under `assets/3d/` changed, re-run `npm run optimize:assets`
   and commit the regenerated `assets-optimized/` files. Nothing else regenerates them.
2. **Game server** — `server/` is deployed separately (Render). `PRODUCTION_URL` in
   `src/game/config/game-config.js` points at it; the server reads `PORT` from the
   environment there, falling back to 8081 locally.
3. **Push** — Pages picks up the commit. There is no CI step to run.

## Browser Support

- Modern browsers with WebGL support
- WebSocket support required
- ES6 modules support required
- WebP decoding required — the optimized models carry `EXT_texture_webp`
  (universal in current browsers since 2020)

## License

MIT License
