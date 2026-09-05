# A-Frame → three.js r180 Migration — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.
> Design: `docs/plans/2026-09-06-three-migration-design.md` — read it first.

**Goal:** Run the facingworlds.org game client on the vendored three r180 module build with no A-Frame, looking, moving and shooting exactly as it does today.

**Architecture:** A new entry (`play.html` → `src/game/core/main.js` rewritten at the end) builds renderer/scene/camera/loop in `src/game/engine/`, registers plain-class systems in an explicit update order, and ports each existing component into `src/game/systems/` one file at a time. `index.html` keeps running on A-Frame until parity; the last task swaps the entry and deletes A-Frame, aframe-extras and the drop list. Wire protocol, server and bots do not change.

**Tech Stack:** three r180 (`assets/libraries/three/three.module.min.js`, import-mapped as `"three"`), `src/ar/vendor/loaders/{GLTFLoader,DRACOLoader}.js` (r182 addons, verified against r180), `assets/three-addons/postprocessing/*` (bloom), `three-pathfinding` 1.3.0 (vendored ESM), Node `node --test` for logic, Playwright headed Chromium for in-browser measurement.

---

## Ground rules for every task

- **Never run the headless shell for GPU measurement.** Playwright runs headed (`headless: false`) as in `scripts/measure-frametimes.mjs`. SwiftShader numbers are meaningless.
- **Do not `git add -A`.** Commit with explicit paths; other agents may be mid-flight in sibling files.
- **Port, don't redesign.** Every number, comment and quirk explanation in the old component is copied across unless the design doc says otherwise. If an A-Frame workaround becomes unnecessary (e.g. `#view-shake`'s reason for existing), delete the workaround *and* rewrite its comment to say what is true now.
- **Node tests must stay at 153/153**: `npm run test:server && npm test`.
- **Servers**: static on 8080 (`npm run dev`), game server on 8081 (`npm run server:tls`). Check with `lsof -nP -iTCP:8081 -sTCP:LISTEN`, never `curl` (WebSocket-only, hangs).
- **Old source is the spec.** Each port task says "read `src/game/components/X.js` in full" — do it; the plan does not repeat 14k lines.

## The port recipe (applies to every system task)

| A-Frame idiom (old) | three idiom (new) |
|---|---|
| `AFRAME.registerComponent("x", { schema, init, tick, remove })` | `export class X { constructor(game, node, opts) {…init…} update(dt, now) {…tick…} dispose() {…remove…} }`; `opts` carries what `schema` defaulted, spread over a `DEFAULTS` object |
| `AFRAME.THREE` / `window.THREE` | `import * as THREE from "three"` |
| `this.el.object3D` | `this.node` (an `Object3D`) |
| `this.el.getObject3D("mesh")` | `this.node.userData.mesh` (set by `assets.attachModel`) or the field the port gives it |
| `this.el.setObject3D("mesh", o)` | `this.node.add(o); this.node.userData.mesh = o` |
| `this.el.sceneEl` | `this.game` (`game.scene`, `game.camera`, `game.renderer`) |
| `sceneEl.emit("ev", detail)` / `sceneEl.addEventListener("ev", h)` | `game.events.emit("ev", detail)` / `game.events.on("ev", h)` — handlers still read `e.detail` |
| `el.emit("sethp", …)` on an entity | method call on the system instance (`avatar.setHp(hp)`) |
| `this.el.sceneEl.systems["ut-effects"]` | `game.systems.get("ut-effects")` |
| `document.querySelector("#rig")` / `#cam` / `#soldier` | `game.rig`, `game.camera`, `game.player.soldier` |
| `el.addEventListener("model-loaded", …)` | `await assets.attachModel(node, url)` returns the root; no event |
| `sceneEl.addEventListener("loaded", …)` | code runs after `await buildWorld()` in `main.js`; no event |
| `tick(time, deltaMs)` | `update(dtSeconds, nowMs)` — **convert every `deltaTime / 1000`** |
| `el.setAttribute("position", "x y z")` | `node.position.set(x, y, z)` |
| `el.setAttribute("visible", false)` | `node.visible = false` |
| `el.setAttribute("light", {…})` | `new THREE.PointLight(...)` etc. via `scene/lights.js` `makeLight(spec)` |
| `el.setAttribute("text", …)` + `look-at` | `makeLabelSprite(text, color)` from `systems/label.js` (canvas sprite, already how names are drawn in `remote-avatar.js` — reuse that code) |
| `el.setAttribute("geometry"/"material")` | `new THREE.Mesh(new THREE.BoxGeometry(...), new THREE.MeshStandardMaterial({...}))` |
| `entity.components["x"]` | `node.userData.systems.x` (set when a system attaches to a node) |
| `data-weapon` / `data-name` attributes on remote entities | plain fields on the `RemoteAvatar` instance |

`update()` order is fixed by the registration order in `main.js` (Task 3). A system needing another one's *result this frame* must be registered after it — write the reason as a comment at the registration site, as the old `main.js` did for `ut-jump`.

---

## Task 1: Engine core — game.js, events.js

**Files:**
- Create: `src/game/engine/game.js`
- Create: `src/game/engine/events.js`
- Test: `server/test/engine-events.test.mjs`

**Step 1: Write the failing test for the event bus**

```js
// server/test/engine-events.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { createEvents } from "../../src/game/engine/events.js";

test("emit delivers detail to listeners, like sceneEl.emit did", () => {
  const ev = createEvents();
  let got = null;
  ev.on("local-fire", (e) => (got = e.detail));
  ev.emit("local-fire", { weapon: "enforcer" });
  assert.deepEqual(got, { weapon: "enforcer" });
});

test("off removes a listener; once fires exactly once", () => {
  const ev = createEvents();
  let n = 0;
  const h = () => n++;
  ev.on("x", h);
  ev.emit("x");
  ev.off("x", h);
  ev.emit("x");
  assert.equal(n, 1);
  ev.once("y", h);
  ev.emit("y");
  ev.emit("y");
  assert.equal(n, 2);
});
```

**Step 2: Run it to verify it fails**

Run: `node --test server/test/engine-events.test.mjs`
Expected: FAIL — `Cannot find module .../src/game/engine/events.js`

**Step 3: Implement events.js**

```js
// events.js — the scene bus.
//
// A-Frame gave every component `this.el.sceneEl.emit(name, detail)` and the matching
// addEventListener; network.js, the HUD, CTF and the weapons all talk through it. This is
// the same contract on a plain EventTarget: handlers keep reading `e.detail`, so the
// listeners in the ported systems are copied across unchanged. Runs in Node too (tests).
export function createEvents() {
  const target = new EventTarget();
  return {
    emit(name, detail) {
      target.dispatchEvent(new CustomEvent(name, { detail }));
    },
    on(name, handler) {
      target.addEventListener(name, handler);
      return () => target.removeEventListener(name, handler);
    },
    once(name, handler) {
      target.addEventListener(name, handler, { once: true });
    },
    off(name, handler) {
      target.removeEventListener(name, handler);
    },
  };
}
```

**Step 4: Run the test**

Run: `node --test server/test/engine-events.test.mjs`
Expected: PASS (2 tests)

**Step 5: Implement game.js**

Renderer settings come from `<a-scene renderer=…>` in `index.html:84-93` and `src/game/components/gltf-viewer-settings.js` (read it: tone mapping ACES, exposure 1.0). Camera near is 0.05 — copy the depth-precision comment from `index.html:496-510` verbatim.

```js
// game.js — renderer, scene, camera, loop and the system registry.
//
// This is what <a-scene> used to be. Systems are plain objects with update(dt, now) and
// dispose(); they run in REGISTRATION ORDER, every frame, and that order is the contract
// A-Frame used to express implicitly through attachment sequence (see main.js).
import * as THREE from "three";
import { createEvents } from "./events.js";

export function createGame({ canvas = document.createElement("canvas"), pixelRatioCap = 2 } = {}) {
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    precision: "highp",
    powerPreference: "high-performance",
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, pixelRatioCap));
  renderer.setSize(window.innerWidth, window.innerHeight);
  // <a-scene renderer="colorManagement: true; ..."> and gltf-viewer-settings.js.
  THREE.ColorManagement.enabled = true;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  // <a-scene shadow="type: pcfsoft">
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  // renderer="sortTransparentObjects: true"
  renderer.sortObjects = true;
  // r180 has no physicallyCorrectLights flag: physical units are the only mode, which
  // is what A-Frame's `physicallyCorrectLights: true` selected. Light intensities in
  // scene/lights.js are therefore copied as-is.

  const scene = new THREE.Scene();
  // near 0.05: see the depth-precision note copied from index.html into scene/world.js.
  const camera = new THREE.PerspectiveCamera(80, window.innerWidth / window.innerHeight, 0.05, 10000);

  const events = createEvents();
  const systems = new Map(); // name -> system, insertion order = update order
  const clock = new THREE.Clock();
  let running = false;
  let renderHook = null; // bloom replaces renderer.render with a composer pass

  function onResize() {
    renderer.setSize(window.innerWidth, window.innerHeight);
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    for (const s of systems.values()) if (s.resize) s.resize(window.innerWidth, window.innerHeight);
  }
  window.addEventListener("resize", onResize);

  const game = {
    THREE,
    renderer,
    scene,
    camera,
    events,
    systems,
    // Filled by main.js as the world is built; systems reach them through `game`.
    rig: null,
    player: null,
    world: null,
    navmesh: null,

    register(name, system) {
      if (systems.has(name)) throw new Error(`system "${name}" registered twice`);
      systems.set(name, system);
      return system;
    },
    /** Attach a system to a node so peers can find it the way `el.components[x]` did. */
    attach(node, name, system) {
      (node.userData.systems ||= {})[name] = system;
      return system;
    },
    setRenderHook(fn) {
      renderHook = fn;
    },

    start() {
      if (running) return;
      running = true;
      clock.start();
      renderer.setAnimationLoop(() => {
        // Tab-throttled frames are clamped the way ut-controls clamped its own clock.
        const dt = Math.min(clock.getDelta(), 1 / 20);
        const now = performance.now();
        for (const s of systems.values()) if (s.update) s.update(dt, now);
        if (renderHook) renderHook(dt);
        else renderer.render(scene, camera);
      });
    },
    stop() {
      running = false;
      renderer.setAnimationLoop(null);
    },
    dispose() {
      game.stop();
      window.removeEventListener("resize", onResize);
      for (const s of [...systems.values()].reverse()) if (s.dispose) s.dispose();
      systems.clear();
      renderer.dispose();
    },
  };
  return game;
}
```

**Step 6: Commit**

```bash
git add src/game/engine/game.js src/game/engine/events.js server/test/engine-events.test.mjs
git commit -m "engine: createGame() and the scene event bus"
```

---

## Task 2: Assets and input

**Files:**
- Create: `src/game/engine/assets.js`
- Create: `src/game/engine/input.js`
- Test: `server/test/engine-input.test.mjs`

**Step 1: Failing test for input (the pure part)**

The touch rule is from the credits panel and `ut-movement.js:82-87`: one finger = forward (`z -= 1`), two fingers = back (`z += 1`). Keyboard diagonal normalised (UT99 has one ground speed — `ut-movement.js:66-68`).

```js
// server/test/engine-input.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { moveVectorFrom } from "../../src/game/engine/input.js";

test("WASD and arrows map to a rig-local vector, diagonals normalised", () => {
  const v = moveVectorFrom({ KeyW: true, KeyD: true }, 0);
  assert.ok(Math.abs(Math.hypot(v.x, v.z) - 1) < 1e-9);
  assert.ok(v.z < 0 && v.x > 0);
  assert.deepEqual(moveVectorFrom({ ArrowDown: true }, 0), { x: 0, z: 1 });
});

test("one finger walks forward, two fingers back, three or more do nothing", () => {
  assert.deepEqual(moveVectorFrom({}, 1), { x: 0, z: -1 });
  assert.deepEqual(moveVectorFrom({}, 2), { x: 0, z: 1 });
  assert.deepEqual(moveVectorFrom({}, 3), { x: 0, z: 0 });
});
```

**Step 2: Run it** — `node --test server/test/engine-input.test.mjs` — Expected: FAIL (module missing)

**Step 3: Implement input.js**

```js
// input.js — every input source the rig reads, snapshotted once per frame.
//
// Replaces aframe-extras keyboard-controls, touch-controls and look-controls' pointer
// lock plumbing. It does NOT interpret the input: that is the player controller's job,
// so the UT acceleration model there reads one vector regardless of source.

/** Pure: keys map + active touch count -> {x, z} in rig space, length <= 1. */
export function moveVectorFrom(keys, touchCount) {
  let x = 0;
  let z = 0;
  if (keys.KeyW || keys.ArrowUp) z -= 1;
  if (keys.KeyS || keys.ArrowDown) z += 1;
  if (keys.KeyA || keys.ArrowLeft) x -= 1;
  if (keys.KeyD || keys.ArrowRight) x += 1;
  // One finger forward, two back — what the credits panel promises.
  if (touchCount === 1) z -= 1;
  else if (touchCount === 2) z += 1;
  const len = Math.hypot(x, z);
  if (len > 1) {
    x /= len;
    z /= len;
  }
  return { x, z };
}

export function createInput(canvas) {
  const keys = {};
  let touchCount = 0;
  // Look deltas accumulate between frames and are drained by the controller.
  let lookDx = 0;
  let lookDy = 0;
  let jumpPressed = false; // edge, consumed once
  let firePressed = false; // edge
  let fireHeld = false;
  const drag = { active: false, x: 0, y: 0 };

  const onKeyDown = (e) => {
    if (e.repeat) return;
    keys[e.code] = true;
    if (e.code === "Space") jumpPressed = true;
    if (e.code === "KeyX") {
      firePressed = true;
      fireHeld = true;
    }
  };
  const onKeyUp = (e) => {
    keys[e.code] = false;
    if (e.code === "KeyX") fireHeld = false;
  };
  const locked = () => document.pointerLockElement === canvas;
  const onMouseMove = (e) => {
    if (!locked()) return;
    lookDx += e.movementX;
    lookDy += e.movementY;
  };
  // Fire only while locked: otherwise the click that TAKES the lock also fires into
  // the floor (index.html's look-controls comment). Left button only.
  const onMouseDown = (e) => {
    if (e.button !== 0) return;
    if (!locked()) {
      canvas.requestPointerLock();
      return;
    }
    firePressed = true;
    fireHeld = true;
  };
  const onMouseUp = (e) => {
    if (e.button === 0) fireHeld = false;
  };
  // Touch: fingers on the canvas count as movement; a single-finger drag also looks.
  const onTouchStart = (e) => {
    touchCount = e.touches.length;
    if (touchCount === 1) {
      drag.active = true;
      drag.x = e.touches[0].clientX;
      drag.y = e.touches[0].clientY;
    }
  };
  const onTouchMove = (e) => {
    if (!drag.active || e.touches.length !== 1) return;
    lookDx += e.touches[0].clientX - drag.x;
    lookDy += e.touches[0].clientY - drag.y;
    drag.x = e.touches[0].clientX;
    drag.y = e.touches[0].clientY;
  };
  const onTouchEnd = (e) => {
    touchCount = e.touches.length;
    if (touchCount === 0) drag.active = false;
  };
  const onBlur = () => {
    for (const k in keys) keys[k] = false;
    fireHeld = false;
  };

  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);
  window.addEventListener("blur", onBlur);
  canvas.addEventListener("mousemove", onMouseMove);
  canvas.addEventListener("mousedown", onMouseDown);
  window.addEventListener("mouseup", onMouseUp);
  canvas.addEventListener("touchstart", onTouchStart, { passive: true });
  canvas.addEventListener("touchmove", onTouchMove, { passive: true });
  canvas.addEventListener("touchend", onTouchEnd);
  canvas.addEventListener("touchcancel", onTouchEnd);

  return {
    keys,
    get pointerLocked() {
      return locked();
    },
    move() {
      return moveVectorFrom(keys, touchCount);
    },
    /** Drains the look delta: pixels since the last call. */
    look(out) {
      out.x = lookDx;
      out.y = lookDy;
      lookDx = 0;
      lookDy = 0;
      return out;
    },
    consumeJump() {
      const j = jumpPressed;
      jumpPressed = false;
      return j;
    },
    consumeFirePress() {
      const f = firePressed;
      firePressed = false;
      return f;
    },
    get fireHeld() {
      return fireHeld;
    },
    /** For the touch "fire" button the HUD draws (hud-root.js). */
    pressFire(down) {
      if (down) firePressed = true;
      fireHeld = down;
    },
    dispose() {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
      canvas.removeEventListener("mousemove", onMouseMove);
      canvas.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("mouseup", onMouseUp);
      canvas.removeEventListener("touchstart", onTouchStart);
      canvas.removeEventListener("touchmove", onTouchMove);
      canvas.removeEventListener("touchend", onTouchEnd);
      canvas.removeEventListener("touchcancel", onTouchEnd);
    },
  };
}
```

Before writing this, `grep -n "KeyX\|mousedown\|fireHeld\|isFiring" src/game/components/first-person-weapon.js` and `grep -n "touch\|fire" src/game/components/hud/hud-root.js` — the weapon and the HUD currently own key/mouse/touch-fire listeners. The port of first-person-weapon (Task 9) will read `input` instead; note any extra key it handles (weapon switch keys, etc.) and add them here in the same shape (`consumeX()` edges).

**Step 4: Run test** — `node --test server/test/engine-input.test.mjs` — Expected: PASS

**Step 5: Implement assets.js**

Mirror `src/ar/three/assets.js` (read it). Same loaders, same Draco path, plus a cache keyed by URL and an `attachModel` helper that does what `gltf-model` did.

```js
// assets.js — glTF loading, one loader, one cache. What <a-assets> + gltf-model were.
import * as THREE from "three";
import { GLTFLoader } from "../../ar/vendor/loaders/GLTFLoader.js";
import { DRACOLoader } from "../../ar/vendor/loaders/DRACOLoader.js";

// index.html pointed A-Frame's gltf-model system at this decoder so nothing is fetched
// from gstatic; the AR page shares it.
const DRACO_PATH = "src/ar/vendor/draco/";

const draco = new DRACOLoader().setDecoderPath(DRACO_PATH);
const loader = new GLTFLoader().setDRACOLoader(draco);
const cache = new Map(); // url -> Promise<gltf>

/** Load once; later callers share the parsed glTF. Clone before adding to the scene. */
export function loadGltf(url) {
  if (!cache.has(url)) {
    cache.set(
      url,
      new Promise((resolve, reject) => loader.load(url, resolve, undefined, reject))
    );
  }
  return cache.get(url);
}

/**
 * gltf-model, as a function: parks a fresh instance of the model under `node`,
 * remembers it as node.userData.mesh, and returns { root, animations }.
 * Skinned models need SkeletonUtils.clone — remote avatars are morph-only, so a plain
 * clone is right here; if a skinned asset appears, import src/ar/vendor/utils/SkeletonUtils.js.
 */
export async function attachModel(node, url) {
  const gltf = await loadGltf(url);
  const root = gltf.scene.clone(true);
  if (node.userData.mesh) node.remove(node.userData.mesh);
  node.add(root);
  node.userData.mesh = root;
  return { root, animations: gltf.animations };
}

export function disposeAssets() {
  cache.clear();
  draco.dispose();
}
```

Manifest of asset URLs: copy every `<a-asset-item id=… src=…>` from `index.html:166-204` into `export const ASSETS = { worldGltf: "...", navmeshGltf: "...", soldierModel: "...", enforcerWeapon: "...", ... }` in `assets.js`, keyed by the old ids in camelCase, with the `assets-optimized/` comment from the markup carried over.

**Step 6: Commit**

```bash
git add src/game/engine/assets.js src/game/engine/input.js server/test/engine-input.test.mjs
git commit -m "engine: assets (gltf-model as a function) and input snapshot"
```

---

## Task 3: The new entry — play.html and the system registry order

**Files:**
- Create: `play.html`
- Create: `src/game/core/main-three.js` (renamed to `main.js` in Task 16)
- Create: `src/game/scene/world.js` (skeleton; filled in Task 4)

**Step 1: play.html**

Copy `index.html`, then:
- delete lines 25-26 (A-Frame scripts) and the `three-aframe` import map; replace with
  ```html
  <script type="importmap">
    { "imports": { "three": "./assets/libraries/three/three.module.min.js" } }
  </script>
  ```
  (r180 is split into `three.module.min.js` + `three.core.min.js`; the min build resolves its sibling relatively — same as `ar/index.html`.)
- delete the whole `<a-scene>…</a-scene>` block (lines 84-611) **but keep** the `#credits-container` div (it is plain DOM) and move it to `<body>`.
- add `<canvas id="game"></canvas>` as the first child of `<body>`; in `styles.css` add `#game { position: fixed; inset: 0; width: 100%; height: 100%; display: block; }` if the A-Frame canvas rule does not already cover it (check `grep -n canvas styles.css`).
- module script → `src/game/core/main-three.js`.

**Step 2: main-three.js — the registry order is the design**

```js
// main-three.js — the game, without A-Frame. Becomes main.js at the swap (Task 16).
import "../../shared/components/index.js"; // still registers nothing after Task 4 — removed then
import { createGame } from "../engine/game.js";
import { createInput } from "../engine/input.js";
import { buildWorld } from "../scene/world.js";
import { GAME_CONFIG } from "../config/game-config.js";
import { handleError } from "../utils/error-handler.js";
import { performanceMonitor } from "../utils/performance.js";

async function boot() {
  performanceMonitor.startMonitoring();
  const canvas = document.getElementById("game");
  const game = createGame({ canvas });
  const input = createInput(canvas);
  game.input = input;

  // A handle for the Playwright probes and the console. Everything else is
  // module-scoped, exactly as window.__arTable is for the AR page.
  window.__fw = game;

  // 1. World: map, navmesh, lights, sky, env map. Awaited: everything below stands on it.
  await buildWorld(game);

  // 2..N registered here in Tasks 4-14, in THIS order. The order is load-bearing:
  //   input -> player (movement, jump/ground, look, shake) -> weapon (sway, view anim,
  //   muzzle) -> hitscan/projectiles -> effects -> pickups/CTF -> remote avatars ->
  //   sky/earth camera pin -> bloom/render.
  // A system that needs another's result THIS frame goes after it; say why in a comment.

  game.start();
}

document.addEventListener("DOMContentLoaded", () => boot().catch((e) => handleError(e, "boot")));

// The "?" in the corner — copied verbatim from main.js's tail.
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
```

**Step 3: world.js skeleton**

```js
import * as THREE from "three";
export async function buildWorld(game) {
  game.scene.background = new THREE.Color(0x000006);
  game.world = new THREE.Group();
  game.scene.add(game.world);
}
```

**Step 4: Verify it renders a black page with no console errors**

Run: `npm run dev` (if not already up), then in a browser open `http://localhost:8080/play.html`; DevTools console must show no errors and `__fw.renderer.info.render.frame` must be increasing.

**Step 5: Commit**

```bash
git add play.html src/game/core/main-three.js src/game/scene/world.js styles.css
git commit -m "play.html: the three.js entry, empty scene, fixed system order"
```

---

## Task 4: World — map, navmesh, lights, shadow, pixelated-texture, gltf-animation-pointer, env map

**Files:**
- Create: `src/game/scene/lights.js`
- Modify: `src/game/scene/world.js`
- Create: `src/game/systems/environment-map.js` (port of `components/environment-map.js`)
- Create: `src/game/systems/pixelated-texture.js` (port of `shared/components/pixelated-texture.js` — a function `pixelate(root)`)
- Create: `src/game/systems/gltf-animation-pointer.js` (port)
- Create: `src/game/systems/quality-tier.js` (port)
- Test: `server/test/scene-lights.test.mjs`

**Step 1: lights.js — the 19 lights as data, with a test that pins their count and totals**

Extract every `<a-entity light="…" position="…">` from `index.html` (lines 205-425, excluding the commented-out ones) into:

```js
export const LIGHTS = [
  { type: "hemisphere", color: "#ffd9ab", groundColor: "#1d2a4a", intensity: 0.75, position: [9.14829, 14.08152, 0] },
  // ... one row per live <a-entity light=…>, in markup order, with the markup's
  // explanatory comment above each group (the "Flat fill" note, the team-colour notes).
];
```

Then

```js
export function makeLight(spec) {
  let light;
  switch (spec.type) {
    case "hemisphere": light = new THREE.HemisphereLight(spec.color, spec.groundColor, spec.intensity); break;
    case "point": light = new THREE.PointLight(spec.color, spec.intensity, spec.distance ?? 0, spec.decay ?? 2); break;
    case "spot": ...; case "directional": ...; case "ambient": ...
  }
  if (spec.position) light.position.set(...spec.position);
  if (spec.castShadow) { light.castShadow = true; /* copy shadow map size / bias from the markup if present */ }
  return light;
}
```

Watch: A-Frame `light` default `decay` is 2 and `distance` 0 — check each markup row for explicit values; A-Frame's `light="type: directional"` uses `rotation` to aim (target at origin along −Z rotated) — replicate with `light.target`. If a light has a `target` in markup, replicate it.

Test (`server/test/scene-lights.test.mjs`): `LIGHTS.length === 19` and a snapshot of `[type, intensity]` pairs — so no light is dropped by accident in later edits.

**Step 2: world.js**

```js
export async function buildWorld(game) {
  const { scene } = game;
  scene.background = new THREE.Color(0x000006);
  game.world = new THREE.Group(); scene.add(game.world);

  // Lights — all 19, from the same values index.html carried.
  const lights = new THREE.Group(); lights.name = "map-lights";
  for (const spec of LIGHTS) lights.add(makeLight(spec));
  scene.add(lights);

  // Map. shadow="cast: true; receive: true", gltf-animation-pointer, pixelated-texture.
  const mapNode = new THREE.Group(); mapNode.name = "world";
  const { root: mapRoot, animations } = await attachModel(mapNode, ASSETS.worldGltf);
  mapRoot.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  pixelate(mapRoot);
  game.world.add(mapNode);
  game.register("gltf-animation-pointer", new GltfAnimationPointer(game, mapRoot, animations, { speed: 1.0 }));

  // Navmesh: loaded, hidden, kept for the player clamp and the spawn raycast.
  const navNode = new THREE.Group(); navNode.name = "navmesh";
  const { root: navRoot } = await attachModel(navNode, ASSETS.navmeshGltf);
  navNode.visible = false;
  game.world.add(navNode);
  game.navmesh = navRoot;

  game.register("environment-map", new EnvironmentMap(game, { src: "assets/graphics/space_environment_2k.png", intensity: 1.0, background: false }));
  game.register("quality-tier", new QualityTier(game));
}
```

Ports in this task follow the recipe. `environment-map.js` uses PMREM — check `grep -n "PMREM\|sceneEl.object3D.environment" src/game/components/environment-map.js` and write to `game.scene.environment`. `quality-tier.js` writes `data-quality-tier` on the scene element — make it `document.body.dataset.qualityTier` and check `styles.css` for the selector (`grep -n quality-tier styles.css`) and update it.

**Step 3: Verify — screenshot compare against index.html**

Write `scripts/pw/screenshot-both.mjs` (Playwright, headed): open `index.html` and `play.html` at 1280×720, wait 6 s, `page.screenshot` both to the scratchpad, print paths. Look at them side by side (Read tool renders PNGs). Lighting, exposure and the map must match; the player/sky are not there yet on `play.html`, so compare the map only. Fix light params until they match.

**Step 4: Commit**

```bash
git add src/game/scene/lights.js src/game/scene/world.js src/game/systems/environment-map.js src/game/systems/pixelated-texture.js src/game/systems/gltf-animation-pointer.js src/game/systems/quality-tier.js server/test/scene-lights.test.mjs scripts/pw/screenshot-both.mjs
git commit -m "world: map, navmesh, the 19 lights, env map and quality tier on three"
```

---

## Task 5: Sky — space-environment, earth-sphere, base-coronas, background-music

**Files:**
- Create: `src/game/systems/space-environment.js` (port; includes `base-coronas`, which lives in the same old file)
- Create: `src/game/systems/earth-sphere.js` (port)
- Create: `src/game/systems/background-music.js` (port)
- Modify: `src/game/core/main-three.js` (register)

Read `space-environment.js` (581 lines) and `earth-sphere.js` (377) in full. Both pin their content to the camera every tick and share `SKY_ROTATION_DEG_PER_SEC`; the camera is `game.camera` (world position via `getWorldPosition`, since the camera will be a child of the rig). Register them **after** the player systems (they follow the camera) — put them at the end of the registry before bloom, with the comment from `index.html:95-105`.

Options come from the markup: `starCount:1400; bandFraction:0.45; galaxyCount:4; moonEnabled:true; rotationSpeed:0.3; asteroidCount:0; nebulaEnabled:false; backgroundColor:#000006` and `offset:390 120 -300; size:190; rotationSpeed:0.005; atmosphereColor:#4db2ff; atmosphereIntensity:0.8; nightLightColor:#ffb45a; nightLightIntensity:2.6; sunDirection:70 95 -100`, coronas `size:11.68; blueColor:#4aa6ff; redColor:#ff4530`. Carry the markup comments (sunDirection is a direction; the planet is deliberately not world-scaled) into the option objects.

`background-music.js`: `startOnFirstBullet` listened to `bullet-fired` on the scene — `game.events.on("bullet-fired", …)`. Keep volume 0.8, loop.

Verify: screenshot compare again; the sky and Earth must be in the same place at t≈6 s (both rotate — compare against a fresh `index.html` load at the same wait).

Commit: `git commit -m "sky: stars, Earth, coronas and music on three"` with explicit paths.

---

## Task 6: Bloom

**Files:**
- Create: `src/game/systems/bloom.js` (port of `components/lighting/bloom.js`)
- Delete (at Task 16, not now): `src/game/components/lighting/three-aframe.js`

Read `bloom.js` (478 lines). It dynamically imports `assets/three-addons/postprocessing/{EffectComposer,RenderPass,UnrealBloomPass,OutputPass}.js`, which import `"three"` — now resolved to r180 by the import map. **Verify the addons match r180**: `grep -n "import" assets/three-addons/postprocessing/UnrealBloomPass.js assets/three-addons/postprocessing/OutputPass.js assets/three-addons/shaders/*.js | grep -v "\./"` and check each imported symbol exists in `assets/libraries/three/three.module.js`'s export list (line 18251). If one is missing, replace that addon file with the r180 version (`npm pack three@0.180.0` in the scratchpad, copy from `examples/jsm/`).

The system: `constructor(game, opts)` builds composer + passes at the same strength/radius/threshold and quality-tier gating as before, calls `game.setRenderHook((dt) => composer.render(dt))`, `resize(w, h)` → `composer.setSize`. Registered **last**.

Verify: screenshot compare — the coronas' glow must match. Commit.

---

## Task 7: Vendor three-pathfinding and write the navmesh clamp

**Files:**
- Create: `src/game/vendor/three-pathfinding.module.js`
- Create: `src/game/player/navclamp.js`
- Test: `server/test/navclamp.test.mjs`

**Step 1: Vendor**

```bash
cd "$SCRATCHPAD" && npm pack three-pathfinding@1.3.0 && tar xzf three-pathfinding-1.3.0.tgz
cp package/dist/three-pathfinding.module.js "$REPO/src/game/vendor/three-pathfinding.module.js"
head -5 "$REPO/src/game/vendor/three-pathfinding.module.js"   # must import from "three"
```
Add a `src/game/vendor/README.md` line: version, source, why (aframe-extras bundled this; the clamp needs it directly).

**Step 2: Failing test**

three-pathfinding runs in Node (it only needs `three`). Add `"three": "^0.180.0"` as a **devDependency** so tests can import it (`npm i -D three@0.180.0`), and in `server/test/navclamp.test.mjs` build a two-triangle flat navmesh `BufferGeometry` at y=0 spanning x,z ∈ [0,10]:

```js
test("clampStep keeps a step inside the mesh and returns the polygon's y", () => {
  const clamp = createNavClamp(flatGeometry(10));
  const out = clamp.step({ x: 5, y: 0, z: 5 }, { x: 5, y: 0, z: 15 }, { x: 0, y: 0, z: 0 });
  assert.ok(out.z <= 10 + 1e-6, "clamped to the edge");
  assert.ok(Math.abs(out.y) < 1e-6);
});
test("a start OFF the mesh is snapped to the closest node first, so the rig never gets stuck", () => { ... });
```

**Step 3: Implement navclamp.js**

```js
import { Pathfinding } from "../vendor/three-pathfinding.module.js";
// aframe-extras' nav-mesh + movement-controls constrainToNavMesh, without the rig having
// to BE on the polygon: we track the group node ourselves and re-acquire it when lost,
// which is what let ut-jump's hop live on the rig's children (see player/controller.js).
export function createNavClamp(geometry, zone = "level") {
  const pf = new Pathfinding();
  pf.setZoneData(zone, Pathfinding.createZone(geometry));
  let group = null;
  let node = null;
  return {
    step(from, to, out) {
      if (group === null) group = pf.getGroup(zone, from, true);
      if (!node) node = pf.getClosestNode(from, zone, group, true);
      node = pf.clampStep(from, to, node, zone, group, out);
      return out;
    },
    reset() { group = null; node = null; },
    heightAt(p) { ... getClosestNode + project onto its plane ... },
  };
}
```
The navmesh glTF has several meshes — merge them (`src/ar/vendor/utils/BufferGeometryUtils.js` `mergeGeometries`) with world transforms applied (`geometry.applyMatrix4(mesh.matrixWorld)`) before `createZone`. Do this in `world.js` once the navmesh loads: `game.navClamp = createNavClamp(mergedNavGeometry)`.

**Step 4: Run tests; commit** — `git commit -m "player: navmesh clamp on three-pathfinding directly"`.

---

## Task 8: Player controller — look, UT movement, jump/ground, shake, spawn

**Files:**
- Create: `src/game/player/controller.js`
- Create: `src/game/player/spawn.js` (port of `core/spawn.js`)
- Move: `src/game/components/view-shake.js` → `src/game/player/view-shake.js` (pure; test already exists at `server/test/view-shake.test.mjs` — update its import path)
- Modify: `src/game/core/main-three.js`
- Test: `server/test/ut-movement-model.test.mjs`

**Step 1: Extract the pure movement model and test it**

From `ut-movement.js:39-165` lift `step(dt)` / `approach()` into a pure module `src/game/player/ut-movement-model.js`:

```js
export function createUtMovement({ groundSpeed, accel, decel, airControl }) {
  const velocity = { x: 0, z: 0 };
  return {
    velocity,
    /** dir: unit heading in WORLD xz (or zero), airborne: bool. Mutates velocity. */
    step(dir, airborne, dt) { /* the old step() body, minus the quaternion maths, on {x,z} */ },
  };
}
```
Test: from rest, holding forward for 1 s at `MOVEMENT.ACCEL` reaches `min(GROUND_SPEED, ACCEL)`; releasing decelerates to 0 within `GROUND_SPEED/DECEL` s; airborne with no input keeps momentum exactly; airborne with input uses `accel*airControl`. Values from `GAME_CONFIG.MOVEMENT` (`src/game/config/game-config.js:47+`).

**Step 2: controller.js**

Read `ut-movement.js` in full (372 lines; the WHY-THE-HOP-IS-NOT-ON-THE-RIG block at line 165+ and `groundToFloor` at ~line 293) and `index.html:476-580`.

```js
export class PlayerController {
  constructor(game, opts) {
    // Scene graph, as index.html had it:
    //   rig (navmesh-clamped xz + y)      <- the WIRE position, unchanged
    //     hop            (ut-jump's hop + groundToFloor offset — children only, see below)
    //       soldier      (own body, invisible to self: layer 1, camera.layers excludes it)
    //       head         (y = eye height 1.4; yaw lives on the rig, pitch here)
    //         camera     (roll + eyeVert from view-shake written straight on the camera)
    //         gunRoot    (gets the SAME roll + eyeVert, so the gun stays nailed to the screen)
    ...
  }
  update(dt) {
    // 1. look: yaw/pitch from input.look() at 0.002 rad/px (A-Frame look-controls' rate),
    //    pitch clamped ±PI/2, drag on touch uses the same factor.
    // 2. movement: heading = yaw quaternion applied to input.move(); model.step(...)
    // 3. clamp: navClamp.step(rig.position, rig.position + v*dt, out) -> rig.position
    //    (y from the polygon — the rig y is the navmesh y, as the server expects)
    // 4. jump + ground: the old ut-jump body (hop arc, GRAVITY, land/jump events), then
    //    groundToFloor(dt) raycast against getWorldColliders() with the FLOOR_BELOW/ABOVE
    //    window and 25/s lerp -> hop.position.y = hopHeight + groundOffset
    // 5. shake: viewShake.update(dt); camera.rotation.z = roll; camera.position.y = eyeVert;
    //    gunRoot.rotation.z = roll; gunRoot.position.y = eyeVert.
  }
  visualOffset() { return this.hop.position.y; }   // network.js sends this as the hop
  get airborne() {...}
}
```

`getWorldColliders` comes from `hitscan.js` (Task 10) — until then, import a stub that returns `[game.world]`. Note `hitscan.js` currently caches colliders from the DOM; the port (Task 10) reads `game.world`.

**#view-shake is gone.** The camera's rotation and position are ours now; nothing rewrites them. Say so where the node used to be justified (the controller header comment).

**Step 3: spawn.js**: port `core/spawn.js`: raycast down from `ABOVE` onto `game.navmesh` meshes, set `rig.position`, `+LIFT`; keep `markServerSpawnApplied()` and its comment.

**Step 4: Register** in `main-three.js`: `game.player = game.register("player", new PlayerController(game, {...GAME_CONFIG.MOVEMENT}))`; `game.rig = game.player.rig`; `game.scene.add(game.rig)`; then `placePlayerOnNavmesh(game)`.

**Step 5: Verify with Playwright**

Write `scripts/pw/walk.mjs`: open `play.html`, `page.keyboard.down("KeyW")` for 3 s, sample `__fw.rig.position` each 100 ms via `page.evaluate`, assert speed → `GROUND_SPEED` (9.4 m/s) within 5% and that y never changes by more than 0.35 m between samples on flat ground; press Space and check `__fw.player.visualOffset()` rises and returns to 0 within 1 s. Also run the existing `scratchpad/pw/localfloor.mjs` logic against `play.html` (re-point its selectors to `__fw`).

**Step 6: Run the Node tests; commit.**

---

## Task 9: First-person weapon — sway, view anim, muzzle, HUD hookup

**Files:**
- Create: `src/game/systems/first-person-weapon.js` (port, 1402 lines — the biggest one)
- Create: `src/game/systems/weapon-sway.js` (port)
- Move: `src/game/components/view-weapon-anim.js` → `src/game/systems/view-weapon-anim.js` (only change: `import * as THREE from "three"` replaces the `window.AFRAME` line, and the "A-Frame's gltf-model detaches" comment becomes "dressSlot swaps the mesh in the same call")
- Modify: `src/game/components/hud/hud-root.js` (only its 4 A-Frame touch points: `grep -nE "sceneEl|querySelector\(\"#|AFRAME" src/game/components/hud/hud-root.js`)

Read `first-person-weapon.js` completely before starting. Key contract changes:
- The weapon root is `game.player.gunRoot`; slots are `Object3D`s created by the system (`_ensureSlot(i)`), each with `attachModel(slot, url)` replacing `setAttribute("gltf-model")` and the `model-loaded` listener → `await`. `el.__slotAnim` → `slot.userData.anim`.
- `dressSlot`, `refitWeapons`, `setSlotMuzzle`, `fireFeel`, the cadence gate (`minInterval`, `fireClipBusy`, `_burstShots`), `setWeapon`, `setDual` — copied intact. The Playwright probe `scripts/measure-weapon-motion.mjs` calls `setWeapon`, `setDual`, `fireBullet` and reads `primaryEl.getObject3D("mesh")` / `__slotAnim` — keep the method names and expose `primarySlot` so Task 15 can re-point the probe with a one-line change.
- Input: `input.consumeFirePress()` / `input.fireHeld` replace the key/mouse listeners; `input.pointerLocked` replaces `document.pointerLockElement` checks.
- The fallback gun built with `geometry`/`material` attributes (`first-person-weapon.js:1101-1126`) → four `THREE.Mesh`es with `MeshStandardMaterial`, same dims/colours.
- `weapon-sway`: `setRest` no longer needs `_pendingRest` (no deferred init) — delete that branch and its comment; the class is constructed with the rest position. Reads `game.player.isMoving` / `speedMps` (add those getters to the controller from `character.js`'s definitions) instead of `soldier.components.character`.
- `view-shake` is driven by the controller now (Task 8); the weapon calls `game.player.shake(spec)` where it called `this.shake.shake(...)`.
- HUD: `hud-root.js` is DOM; it touches the scene only for `sceneEl` events → `game.events`, and for the touch fire button → `game.input.pressFire(down)`. Pass `game` into `createHud(game)`.

Register **after** `player`: the sway reads this frame's rig velocity and the shake roll.

Verify: `scripts/measure-weapon-motion.mjs` re-pointed at `play.html` (Task 15 does the permanent re-point; for now copy it to `scratchpad/pw/motion-three.mjs` with `__fw.systems.get("first-person-weapon")` in place of `__comp()`). The per-weapon max-step table must match the 2026-09-05 baseline in the design doc's Landed section within noise. Commit.

---

## Task 10: Hitscan, effects, projectiles, impact effects

**Files:**
- Create: `src/game/systems/hitscan.js`, `ut-effects.js`, `ut-projectiles.js`, `impact-effects.js` (ports)

Read each in full. `hitscan.js` `getWorldColliders()` currently collects meshes from `#world` (and excludes the player's own body) — it becomes `game.world` traversal, cached, with remote avatars' hit volumes registered via `game.systems.get("remote-avatars")`. Export `getWorldColliders` from the module for the controller's `groundToFloor` (Task 8's stub goes away).

`ut-effects.js` (1550) is already pooled three.js; its A-Frame touches are `sceneEl.object3D` → `game.scene`, `camera` lookups → `game.camera` with `getWorldQuaternion`, and `this.el.sceneEl.systems[...]` → `game.systems.get(...)`. `impact-effects.js` `spawnDecal` / `registerEffectDisposer` unchanged.

Register after `first-person-weapon` (they consume this frame's shots), before pickups.

Verify: `scratchpad/pw/feel.mjs`-style probe — fire the Enforcer at a wall 10× and count `__fw.systems.get("ut-effects")` pool activity; shock beam draws 40 particles; shells eject. Screenshot a wall hit. Commit.

---

## Task 11: Pickups and CTF

**Files:**
- Create: `src/game/systems/weapon-pickup.js`, `src/game/systems/ctf-flag.js` (ports of the two systems + their per-item components as inner classes)

Both spawn entities from server payloads (`pickups-init`, `ctf-init`) via `document.createElement("a-entity")` + `setAttribute`. Replace with node factories: `new THREE.Group()` + `attachModel` + the item class attached via `game.attach(node, "weapon-pickup-item", item)`. Flag stands place themselves from `FLAG_HOMES` (`src/shared/map-actors.js`) — keep the comment from `index.html:452-468`. `request-pickup` / `request-flag-touch` go out over `game.events` as before; proximity checks read `game.rig.position`.

Verify against the running server: pickups appear, taking one fires `request-pickup`, flag stands lit at both bases. Commit.

---

## Task 12: Remote avatars, character, health, labels

**Files:**
- Create: `src/game/systems/remote-avatar.js` (port, 940 lines), `src/game/systems/character.js`, `src/game/systems/health.js`, `src/game/systems/label.js`
- Keep: `src/game/components/remote-fire-state.js` → move to `src/game/systems/` (pure; fix its test import path)

`remote-avatar.js`: `_onModelLoaded` and its bubbling guard go away — `attachModel` returns the root, and the weapon slots are separate `attachModel` calls that never touch the body's mixer. **Delete the guard and rewrite the comment** to say why it is no longer needed. `_followWeaponAnchor`, `_groundToFloor`, `_weaponSlots`, dual mirroring — intact. `character.js` (idle/walk/run blend by speed) is used by the local soldier too — the controller owns the local instance.

`health.js`: the `text` + `look-at` label → `label.js` `makeLabelSprite(text, color)` (extract the canvas-sprite name label code from `remote-avatar.js`'s label drawing so both use one function). `el.emit("sethp")` → `avatar.setHp(hp)`; network.js (Task 13) calls it.

Verify: with the bots running, 9 avatars walk on the floor, face their heading, hold guns at the fist (`scratchpad/pw/anchor.mjs` re-pointed), labels readable. Commit.

---

## Task 13: Network, announcer, scoreboard, kill feed, name changer

**Files:**
- Modify: `src/game/network/network.js` (43 A-Frame touch points — see the grep in the design session; every `document.querySelector("#rig")` → `game.rig`, `rig.components["ut-jump"].visualOffset()` → `game.player.visualOffset()`, `spawnRemote` → `game.systems.get("remote-avatars").spawn(p)` returning the instance, `targetEntity.emit("sethp")` → `.setHp()`, `scene.emit` → `game.events.emit`, `setAttribute("position")` → `position.set`)
- Create: `src/game/systems/announcer.js`, `highscore-display.js`, `kill-notification.js`, `name-changer.js` (ports; all DOM + events)
- `startNetwork(game)` takes the game; export unchanged otherwise.

Do this as a careful edit of `network.js` in place (it stays where it is), not a rewrite: the protocol handling is the most tested code on the client. After editing, `grep -nE "AFRAME|querySelector\(\"#(rig|cam|soldier)|setAttribute|components\[" src/game/network/network.js` must return nothing.

Verify: join the running 8081 server from `play.html`, see bots, get shot, respawn, scoreboard (Tab), kill feed, announcer, change name. Then open `index.html` in a second tab and confirm the two clients see each other (the protocol did not change). Commit.

---

## Task 14: Pointer-lock prompt, invisible-to-player, rotate-yaw, camera-tracker

**Files:**
- Create: `src/game/systems/pointer-lock-prompt.js` (port; DOM overlay reading `game.input.pointerLocked`)
- Fold `invisible-to-player` into the controller: soldier meshes on layer 1, `camera.layers.disable(1)`; shadows still cast (check `castShadow` on the layered meshes — three culls layers per camera, shadow cameras see all layers by default).
- `rotate-yaw`, `camera-tracker`: read them; if their only job is what the controller already does (yaw on the rig, camera world pose for other systems), delete rather than port and note it in the commit message.

Commit.

---

## Task 15: Probes and baselines

**Files:**
- Modify: `scripts/measure-frametimes.mjs`, `scripts/measure-weapon-motion.mjs` — target `play.html`, `window.__fw.systems.get("first-person-weapon")` in place of `__comp()`, `c.primarySlot.userData.mesh` / `.anim` in place of `primaryEl.getObject3D("mesh")` / `__slotAnim`.
- Create: `scripts/pw/parity.mjs` — runs walk (Task 8), fire/effects (Task 10), avatars (Task 12) checks in one go and prints a table.

Run both probes on `play.html` and `index.html` (the old selectors can stay behind a `--legacy` flag until Task 16) and paste both tables into the design doc under a new "Measured at parity" section. Frame time target: ≤ today's 8.3 ms with 9 bots. Commit.

---

## Task 16: The swap — and deleting A-Frame

Only after Jonas has run the parity checklist in the design doc in a real browser (desktop + a phone for touch) and said go.

**Files:**
- `git mv play.html index.html` (after `git rm index.html`); `git mv src/game/core/main-three.js src/game/core/main.js`; fix the script src in the new `index.html`.
- Delete: `assets/libraries/aframe/`, `assets/libraries/aframe-extras.min.js`, `src/game/components/lighting/three-aframe.js`, `src/game/components/**` (everything now ported or dropped — verify each file with `git grep -l "<name>" src play.html` before removing), `src/shared/components/`, `src/game/utils/three-helpers.js` (AFRAME.THREE wrappers), `src/game/utils/dom-helpers.js` if only `waitForModelLoaded` remains, `ar/aframe.html`, `src/ar/components/`, `src/ar/core/main.js` if it only served the fallback (check `ar/index.html`'s script src first).
- Modify: `package.json` (`description`, `keywords`, `"test"` script to include the new tests), `README.md` (stack section), `docs/ut99-character-extraction.md` if it mentions A-Frame loading, `docs/plans/2026-08-29-facingworlds-upgrade-design.md` "Landed" section (one row: A-Frame removed).
- The `--legacy` flags from Task 15 go.

Verify: `git grep -in "aframe" -- ':!docs' ':!*.md'` returns nothing; `npm run test:server && npm test` 153+ pass; all `npm run gen:*:check` pass; open `/` and `/ar/` — both work; frame-time probe once more.

Commit: `git commit -m "Leave A-Frame: the game runs on three r180"`.

Log to the wiki (`~/GitHub/org/jonasjohansson/skynet/wiki/logs/2026-09-06.md`, facingworlds row) and update `wiki/projects/` for facingworlds if its status text mentions A-Frame.

---

## Parallelisation notes (for the session running this)

Tasks 1–3 are sequential and small — do them in the main session. After Task 4's `buildWorld` exists, Tasks 5, 6, 7 are independent (sky / bloom / navclamp) and can go to three Opus agents with disjoint files. Task 8 needs 7. Tasks 9 and 10 need 8; 11 and 12 need 4 and the recipe only; 13 needs 9–12. Keep one agent per task and integrate in the main session; never two agents in the same file.
