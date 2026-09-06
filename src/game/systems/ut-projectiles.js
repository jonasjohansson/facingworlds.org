// ut-projectiles.js — drawing the three UT99 weapons that fly, and their blasts.
//
// The SERVER owns where a projectile is and what it hits (server/projectiles.js). This
// file only draws: it is told where something was launched, where it bounced and where it
// ended, and dead-reckons the rest so the wire carries three small messages per shot
// instead of a position twenty times a second.
//
// ---------------------------------------------------------------------------
// WHY THERE IS NO SHADER HERE
// ---------------------------------------------------------------------------
// Because UT99 did not have one. A rocket blast is a camera-facing quad playing eight
// frames over 0.7 s, and the frames are ordinary bitmaps out of the package — see
// scripts/build-ut-projectiles.mjs, which composes them into one sheet.
//
// The one thing that is easy to get wrong is the BLEND. Both explosion classes are Style
// STY_TRANSLUCENT, and in UE1 a translucent sprite's brightness IS its opacity: black is
// invisible. WarExplosion's last frame is a fully opaque near-black one, so alpha-blending
// the sheet ends the Redeemer on a black square hanging in the air. Additive is not a
// stylistic preference, it is what the asset was authored for.
//
// The procedural FireTexture smoke trails are deliberately absent. Those are a cellular
// automaton over a palette rather than an image — a few hundred bytes of parameters — and
// reproducing them is the "very complex shader" this was explicitly scoped away from.
//
// ---------------------------------------------------------------------------
// WHAT THE PORT OFF A-FRAME CHANGED (src/game/components/ut-projectiles.js)
// ---------------------------------------------------------------------------
//   sceneEl.object3D        game.scene.
//   sceneEl.camera          game.camera, still read through getWorldQuaternion — see
//                           updateProjectiles.
//   new THREE.GLTFLoader()  engine/assets.js `loadGltf`, one loader and one cache.
//   tick(t, dtMs)           update(dt, now) in seconds. `explosion.lifeMs` is the only
//                           millisecond quantity in the file and stays in milliseconds
//                           (it comes off the weapon manifest), so the frame clock keeps
//                           its `dt * 1000`.
//   registerSystem          `export class UtProjectiles`, whose methods are what network.js
//                           calls: spawn / bounce / remove / clear.
import * as THREE from "three";
import { WEAPONS, PICKUP_SOUND } from "../../shared/weapons.js";
import { loadGltf } from "../engine/assets.js";

const MAX_LIVE = 24;
const MAX_BLASTS = 12;

const state = {
  game: null,
  root: null,
  models: new Map(), // kind -> Object3D to clone
  loading: new Map(),
  atlases: new Map(), // kind -> THREE.Texture
  live: new Map(), // server id -> { obj, dx, dy, dz, speed, kind, spin }
  blasts: [], // pooled quads
  blastIdx: 0,
};

/** Every weapon that has a projectile, keyed by the projectile's own name. */
const BY_KIND = new Map(
  Object.values(WEAPONS)
    .filter((w) => w.projectile)
    .map((w) => [w.projectile.type, w])
);

function ensureRoot(game) {
  if (state.root && state.game === game) return state.root;
  const root = new THREE.Group();
  root.name = "ut-projectiles";
  root.frustumCulled = false;
  game.scene.add(root);
  state.game = game;
  state.root = root;
  return root;
}

function camera() {
  return state.game ? state.game.camera : null;
}

// ---------------------------------------------------------------------------
// models
// ---------------------------------------------------------------------------

function loadModel(kind) {
  if (state.models.has(kind) || state.loading.has(kind)) return;
  const w = BY_KIND.get(kind);
  if (!w) return;
  const p = loadGltf(w.projectile.model)
    .then((gltf) => {
      const obj = gltf.scene;
      obj.traverse((n) => {
        if (n.isMesh) {
          n.frustumCulled = false;
          n.castShadow = false;
          n.receiveShadow = false;
        }
      });
      state.models.set(kind, obj);
      state.loading.delete(kind);
      return obj;
    })
    .catch((err) => {
      console.warn(`[ut-projectiles] could not load ${kind}:`, err);
      state.loading.delete(kind);
      return null;
    });
  state.loading.set(kind, p);
}

/** Warm every model and sheet at load, so the first rocket costs no upload. */
export function preloadProjectiles(game) {
  ensureRoot(game);
  for (const kind of BY_KIND.keys()) {
    loadModel(kind);
    atlasFor(kind);
    const src = BY_KIND.get(kind)?.explosion?.sound;
    if (src && !blastAudio.has(src)) {
      const a = new Audio(src);
      a.volume = 0.35;
      a.preload = "auto";
      blastAudio.set(src, a);
    }
  }
  ensureBlasts();
}

// ---------------------------------------------------------------------------
// explosions
// ---------------------------------------------------------------------------

function atlasFor(kind) {
  if (state.atlases.has(kind)) return state.atlases.get(kind);
  const w = BY_KIND.get(kind);
  if (!w || !w.explosion) return null;
  const tex = new THREE.TextureLoader().load(w.explosion.atlas);
  tex.colorSpace = THREE.SRGBColorSpace;
  // One cell of the sheet at a time; the offset moves per frame.
  tex.repeat.set(1 / w.explosion.cols, 1 / w.explosion.rows);
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  state.atlases.set(kind, tex);
  return tex;
}

function ensureBlasts() {
  if (state.blasts.length) return;
  const geo = new THREE.PlaneGeometry(1, 1);
  for (let i = 0; i < MAX_BLASTS; i++) {
    const mat = new THREE.MeshBasicMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      // Additive already discards black; alpha test as well would punch holes in the
      // soft edge the sprite is drawn with.
      side: THREE.DoubleSide,
      toneMapped: false,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.visible = false;
    mesh.frustumCulled = false;
    mesh.renderOrder = 10;
    state.root.add(mesh);
    state.blasts.push({ mesh, mat, life: 0, lifeMs: 0, kind: null });
  }
}

// One element per explosion kind, reused. Two rockets landing together will cut each
// other off, which is what UT99 does too — it has a finite number of sound slots.
const blastAudio = new Map();

function playBlast(kind) {
  const w = BY_KIND.get(kind);
  const src = w?.explosion?.sound;
  if (!src) return;
  let a = blastAudio.get(src);
  if (!a) {
    a = new Audio(src);
    a.volume = 0.35;
    a.preload = "auto";
    blastAudio.set(src, a);
  }
  a.currentTime = 0;
  a.play().catch(() => {});
}

function spawnBlast(kind, x, y, z) {
  const w = BY_KIND.get(kind);
  if (!w || !w.explosion) return;
  ensureBlasts();
  const tex = atlasFor(kind);
  if (!tex) return;
  const slot = state.blasts[state.blastIdx % state.blasts.length];
  state.blastIdx++;
  // Each slot needs its own texture object: they share the image but not the UV offset,
  // and one shared texture would make every live blast show the same frame.
  if (!slot.tex || slot.kind !== kind) {
    slot.tex = tex.clone();
    slot.tex.needsUpdate = true;
    slot.tex.repeat.set(1 / w.explosion.cols, 1 / w.explosion.rows);
    slot.mat.map = slot.tex;
    slot.mat.needsUpdate = true;
    slot.kind = kind;
  }
  slot.mesh.position.set(x, y, z);
  slot.mesh.scale.setScalar(w.explosion.size);
  slot.mesh.visible = true;
  slot.life = 0;
  slot.lifeMs = w.explosion.lifeMs;
  slot.cols = w.explosion.cols;
  slot.rows = w.explosion.rows;
  slot.frames = w.explosion.frames;
  setFrame(slot, 0);
  playBlast(kind);
}

function setFrame(slot, i) {
  const col = i % slot.cols;
  const row = Math.floor(i / slot.cols);
  // three.js UV origin is bottom-left; the sheet is written top-down.
  slot.tex.offset.set(col / slot.cols, 1 - (row + 1) / slot.rows);
}

// ---------------------------------------------------------------------------
// the wire
// ---------------------------------------------------------------------------

/** UT99's WeaponPickup blip. Lives here because this file already owns the sound pool. */
let pickupAudio = null;
export function playPickupSound() {
  if (!PICKUP_SOUND) return;
  if (!pickupAudio) {
    pickupAudio = new Audio(PICKUP_SOUND);
    pickupAudio.volume = 0.4;
  }
  pickupAudio.currentTime = 0;
  pickupAudio.play().catch(() => {});
}

export function spawnProjectile(game, m) {
  ensureRoot(game);
  loadModel(m.kind);
  const model = state.models.get(m.kind);
  const obj = model ? model.clone(true) : new THREE.Object3D();
  obj.position.set(m.x, m.y, m.z);
  state.root.add(obj);

  if (state.live.size >= MAX_LIVE) {
    // Somebody is spamming, or a `projectile-gone` was lost. Drop the oldest rather than
    // growing without bound.
    const oldest = state.live.keys().next().value;
    removeProjectile(oldest, null);
  }
  const p = {
    obj,
    kind: m.kind,
    dx: m.dx,
    dy: m.dy,
    dz: m.dz,
    speed: m.speed,
    // The ripper blade spins about its travel axis — Razor2's SetRoll does exactly this.
    spin: m.kind === "ripper" ? 14 : m.kind === "rocket" ? 3 : 0,
    roll: 0,
  };
  aim(p);
  state.live.set(m.id, p);
}

export function bounceProjectile(m) {
  const p = state.live.get(m.id);
  if (!p) return;
  p.obj.position.set(m.x, m.y, m.z);
  p.dx = m.dx;
  p.dy = m.dy;
  p.dz = m.dz;
  aim(p);
}

export function removeProjectile(id, m) {
  const p = state.live.get(id);
  if (p) {
    state.root.remove(p.obj);
    disposeTree(p.obj);
    state.live.delete(id);
  }
  if (m && m.splash > 0) spawnBlast(m.kind, m.x, m.y, m.z);
}

/** Point the mesh along its travel. Every projectile was built nose-on +Z. */
const _aimDir = new THREE.Vector3();
const _aimFwd = new THREE.Vector3(0, 0, 1);
function aim(p) {
  _aimDir.set(p.dx, p.dy, p.dz);
  if (_aimDir.lengthSq() < 1e-9) return;
  p.obj.quaternion.setFromUnitVectors(_aimFwd, _aimDir.normalize());
}

function disposeTree(obj) {
  obj.traverse((n) => {
    if (!n.isMesh) return;
    // Geometry and materials come from a shared cloned model; the clone shares them, so
    // disposing here would blank every other projectile of the same kind.
    n.geometry = null;
    n.material = null;
  });
}

export function updateProjectiles(dt) {
  const cam = camera();
  for (const p of state.live.values()) {
    p.obj.position.x += p.dx * p.speed * dt;
    p.obj.position.y += p.dy * p.speed * dt;
    p.obj.position.z += p.dz * p.speed * dt;
    if (p.spin) {
      p.roll += p.spin * dt;
      p.obj.rotateZ(p.spin * dt);
    }
  }
  for (const slot of state.blasts) {
    if (!slot.mesh.visible) continue;
    slot.life += dt * 1000;
    const t = slot.life / slot.lifeMs;
    if (t >= 1) {
      slot.mesh.visible = false;
      continue;
    }
    setFrame(slot, Math.min(slot.frames - 1, Math.floor(t * slot.frames)));
    // WORLD quaternion, not .quaternion. A-Frame never rotated the PerspectiveCamera
    // itself, so its local quaternion was the identity and a blast "facing the camera"
    // faced +Z instead — edge-on from most angles. The entity is gone, but the camera is
    // still a child of `head` under `hop` under the rig (player/controller.js), so its
    // local quaternion carries only the view shake's roll: the world one is still what
    // "face the viewer" means. ut-effects.js says the same about its smoke puffs.
    if (cam) cam.getWorldQuaternion(slot.mesh.quaternion);
  }
}

export function clearProjectiles() {
  for (const id of [...state.live.keys()]) removeProjectile(id, null);
  for (const slot of state.blasts) slot.mesh.visible = false;
}

/**
 * The system. Registered in core/main-three.js after the weapon and ut-effects.
 *
 * THE PUBLIC SURFACE, which is what network.js (Task 13) calls — one method per server
 * message, with the same names the module functions have always had:
 *
 *   spawn(m)            `projectile`        m = { id, kind, x, y, z, dx, dy, dz, speed }
 *   bounce(m)           `projectile-bounce`
 *   remove(id, m)       `projectile-gone`   m carries the blast: { kind, x, y, z, splash }
 *   clear()             a disconnect or a match reset
 *   playPickupSound()   also exported as a free function, as before
 */
export class UtProjectiles {
  constructor(game) {
    this.game = game;
    try {
      preloadProjectiles(game);
    } catch (e) {
      console.warn("[ut-projectiles] preload failed:", e);
    }
  }

  spawn(m) {
    spawnProjectile(this.game, m);
  }

  bounce(m) {
    bounceProjectile(m);
  }

  remove(id, m) {
    removeProjectile(id, m);
  }

  clear() {
    clearProjectiles();
  }

  playPickupSound() {
    playPickupSound();
  }

  update(dt) {
    if (!state.root) return;
    updateProjectiles(Math.min(dt, 0.1));
  }

  dispose() {
    clearProjectiles();
  }
}
