# Facing Worlds

A browser multiplayer FPS recreating UT99's CTF-Face, built on A-Frame 1.6 (three r164)
with a WebSocket game server, plus an AR spectator page. Static site, no build step:
GitHub Pages serves this repository as-is at <https://facingworlds.org>.

## Features

- **Multiplayer Support**: Real-time multiplayer with WebSocket networking
- **3D Environment**: Immersive 3D world with navigation mesh
- **Camera Controls**: Switch between 1st person, 3rd person, and overhead views (Press C)
- **Combat System**: Shoot bullets and hit targets
- **Character Animation**: Smooth character animations and movement
- **Health System**: Player health with visual feedback

## Project Structure

```
index.html                     # the game: scene graph, lights, asset manifest
ar/                            # the AR spectator page (separate entry point)
marker.html                    # printable/displayable AR marker
styles.css
CNAME                          # facingworlds.org -> GitHub Pages

scripts/
└── optimize-assets.mjs        # build-time glTF optimizer (devDependency only)

server/
└── server.js                  # WebSocket game server, port 8081

assets/                        # source media. assets/3d/ is the optimizer's INPUT
│                              # and is no longer downloaded by the browser
├── 3d/                        # original .gltf/.glb + loose PNGs (~35 MB)
├── libraries/                 # A-Frame + aframe-extras, vendored
├── audio/  graphics/  images/  models/
assets-optimized/3d/           # what index.html actually loads (committed, 4.5 MB)

src/
├── game/
│   ├── core/main.js           # entry point
│   ├── network/network.js     # WebSocket client, remote avatars
│   ├── config/game-config.js  # network URLs, health, camera, bullets
│   ├── components/            # A-Frame components: hitscan, health, character,
│   │                          # first-person-weapon, quality-tier, lighting/, HUD
│   └── utils/
├── ar/                        # AR-only components, config and entry point
└── shared/
    ├── components/            # used by both pages
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

- **WASD**: Move character
- **Mouse**: Look around (1st person) / Orbit camera (3rd person)
- **X**: Shoot
- **C**: Cycle camera modes (1st person → 3rd person → overhead)

## Camera Modes

1. **1st Person**: Camera inside character's head
2. **3rd Person**: Orbit camera around character (Unreal Tournament style)
3. **Overhead**: Top-down strategic view

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
2. `prune` + `dedup` — drop unused nodes/materials/accessors, merge duplicates.
3. `resize` — cap texture edge length (pistol 4096 → 2048, avatar → 1024).
4. **Texture codec, in two passes.** Colour maps are perceptual and take lossy
   compression well. Normal and ORM maps are *data* — the shader reads their
   channels as vectors and scalars, so artifacts show up as shading noise. They
   get the gentler setting.
5. **Geometry compression** — Draco by default.

Useful flags: `--codec=webp|ktx2|none`, `--geometry=draco|meshopt|none`,
`--quality` (colour, default 90), `--data-quality` (normal/ORM, default 95),
`--near-lossless`, `--out=<dir>`, `--only=<substr>`.

### Measured results

Run on this repo with the defaults (WebP colour q90 / data q95, Draco). Sizes are exact
bytes from `ls -l`, taken after the run that produced the committed files:

| Asset | Before | After | Saved |
| --- | ---: | ---: | ---: |
| `3d/map/FacingWorlds_tex_5.gltf` (+ `.bin` + 3 PNGs) | 14,340,882 B (13.68 MB) | 3,173,168 B (3.03 MB) | −77.9% |
| `3d/enforcer.glb` | 20,440,960 B (19.49 MB) | 556,280 B (543.2 KB) | −97.3% |
| `3d/Soldier.glb` | 2,160,468 B (2.06 MB) | 962,132 B (939.6 KB) | −55.5% |
| `3d/navmesh.gltf` | 45,132 B (44.1 KB) | 3,384 B (3.3 KB) | −92.5% |
| **Total** | **36,987,442 B (35.27 MB)** | **4,694,964 B (4.48 MB)** | **−87.3%** |

`du -sh assets-optimized` reports **4.5M**.

Two things that had to survive the pipeline, and did:

- **`Soldier.glb` clip order.** `index.html` selects animations by index
  (`character="idleIdx:0; walkIdx:3; runIdx:1"`), so a reorder would silently swap the
  avatar's animations. `gltf-transform inspect` reports the same four clips in the same
  order before and after: `Idle, Run, TPose, Walk`.
- **`navmesh.glb` topology.** 791 triangles before and after; the vertex count drops
  2,373 → 853 only because `dedup` welds vertices that were duplicated per-face. Draco's
  default 14-bit position quantization moves the bounding box by ~3 mm over a ~110-unit
  map, which is far below anything `movement-controls` can resolve.

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

`index.html` loads the optimized copies. Concretely:

| `<a-asset-item>` | src |
| --- | --- |
| `#world-gltf` | `assets-optimized/3d/map/FacingWorlds_tex_5.glb` |
| `#navmesh-gltf` | `assets-optimized/3d/navmesh.glb` |
| `#soldier-model` | `assets-optimized/3d/Soldier.glb` |
| `#enforcer-weapon` | `assets-optimized/3d/enforcer.glb` |

`#player-weapon` (the first-person pistol) now resolves through `#enforcer-weapon`
instead of carrying its own raw URL, so the entity and the preloader cannot drift onto
different paths. This is *not* a download saving: A-Frame sets `THREE.Cache.enabled` and
`<a-asset-item>` caches by exact URL string, so the raw-URL form was already served from
cache — measured as one network request either way.

Nothing under `src/game/` hardcodes an asset path — components resolve models through
those `#id` selectors — so `index.html` was the only game file that had to change. The AR
page is separate and does hardcode paths (`src/ar/config/ar-config.js`, `ar/index.html`,
`ar/aframe.html`); see the note at the end of this section.

**Why these are committed rather than generated at deploy time.** GitHub Pages serves
the repo as-is; there is no build step. Anything not committed does not exist in
production, so a gitignored `assets-optimized/` would mean the deployed site either
breaks or silently falls back to the 35 MB originals — the saving would never actually
ship, which is the state this replaces. A runtime probe-and-fall-back was the
alternative and is worse here: it costs a round trip before the first byte of the map
on *every* load, `<a-asset-item>` starts fetching at parse time so intercepting it means
hand-rolling A-Frame's asset system, and the only failure it guards against is the one
committing eliminates. 4.5 MB of tracked binaries against the 35 MB of originals already
in the repo is not a meaningful cost. A fresh clone therefore works with no asset step:
`npm install` is only needed to *re-run* the optimizer.

The originals under `assets/3d/` stay in the repo, byte-identical. They are the
optimizer's input; the game page no longer downloads them.

**The AR page is not covered by the table above.** `ar/index.html` and `ar/aframe.html`
still point their `<a-asset-item>` at `../assets/3d/map/FacingWorlds_tex_5.gltf` — the
14.3 MB original — and `src/ar/config/ar-config.js` carries its own candidate list. AR is
the page people open on a phone over mobile data, so it is where the saving matters most.
Switching it means changing the extension too (`.gltf` → `.glb`), and a pure-Three.js AR
page must wire its own `DRACOLoader`: A-Frame's automatic `dracoDecoderPath` default does
not apply outside A-Frame.

### glTF extensions the optimized files use

Both are handled with **zero app-side wiring**, but for different reasons:

- **`EXT_texture_webp`** — three r164's `GLTFLoader` registers
  `GLTFTextureWebPExtension` unconditionally in its constructor, alongside the KHR
  extensions. Confirmed by reading the three copy A-Frame bundles
  (`assets/libraries/aframe/aframe.min.js`): the loader constructor contains an
  unconditional `this.register(parser => new <webp-extension>(parser))`, and the class
  it registers carries the `detectSupport()` probe that loads a 1×1 WebP data URI. It is
  not gated on a flag or a plugin. WebP has been supported in every current browser
  since 2020.
- **`KHR_draco_mesh_compression`** — A-Frame 1.6's `gltf-model` *system* schema defaults
  `dracoDecoderPath` to `https://www.gstatic.com/draco/versioned/decoders/1.5.6/` and
  builds a `DRACOLoader` from it on init. Also confirmed by reading the bundle.

#### Draco decoder: the one runtime dependency this adds

All four optimized files are Draco-compressed, and the decoder is fetched from
**gstatic.com at runtime**. If that host is unreachable — offline demo, locked-down
network — *no model decodes* and the scene is empty. Everything else on the page loads
from local files, so this is the only third-party runtime dependency the game has.

Two ways out, both fine:

- **Vendor the decoder** (preferred for offline/event use): copy `draco_decoder.js`,
  `draco_decoder.wasm` and `draco_wasm_wrapper.js` from the `draco3d` package into e.g.
  `assets/libraries/draco/`, then on `<a-scene>`:

  ```html
  <a-scene gltf-model="dracoDecoderPath: assets/libraries/draco/">
  ```

- **Drop Draco**: `npm run optimize:assets -- --geometry=none`. Measured cost of doing
  so is **+1.18 MB** (4.48 MB → 5.66 MB total, still −83.9%), in exchange for having no
  external runtime dependency at all.

Draco is kept on by default because it is the larger win and A-Frame wires it with no
configuration; the trade is documented here so it is a choice rather than a surprise.

#### If you switch codecs

Neither of these is in use today; both would need wiring that WebP does not.

- **KTX2 only** — `basisTranscoderPath` defaults to `""`, which disables the loader. It
  needs the Basis transcoder (`basis_transcoder.js` + `.wasm`) vendored into
  `assets/libraries/`, then on `<a-scene>`:

  ```html
  <a-scene gltf-model="basisTranscoderPath: assets/libraries/basis/">
  ```

- **Meshopt only** — same shape, via `meshoptDecoderPath` (also defaults to `""`).

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
