// impact-effects.js — pooled tracers, impact sparks and bullet decals
// Everything here is preallocated into fixed-size pools: geometries and textures are
// shared, each pool slot owns exactly one material, and nothing is created per shot.
// disposeImpactEffects() releases the lot (see first-person-weapon remove()).
import { GAME_CONFIG } from "../config/game-config.js";

const isMobileDevice = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);

const state = {
  root: null,
  sceneEl: null,
  tracers: null,
  tracerIdx: 0,
  sparks: null,
  sparkIdx: 0,
  decals: null,
  decalIdx: 0,
  light: null,
  lightLife: 0,
  tracerGeo: null,
  quadGeo: null,
  sparkTex: null,
  decalTex: null,
};

function caps() {
  const E = GAME_CONFIG.EFFECTS;
  const scale = isMobileDevice ? 0.5 : 1;
  return {
    tracers: Math.max(4, Math.round(E.MAX_TRACERS * scale)),
    sparks: Math.max(4, Math.round(E.MAX_SPARKS * scale)),
    decals: Math.max(4, Math.round(E.MAX_DECALS * scale)),
  };
}

// ---- generated textures (no extra files to download) ----
function makeRadialTexture(inner, outer, size) {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d");
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  for (let i = 0; i < inner.length; i++) g.addColorStop(inner[i][0], inner[i][1]);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  if (outer) {
    ctx.globalCompositeOperation = "destination-in";
    const m = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    m.addColorStop(0, "rgba(0,0,0,1)");
    m.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = m;
    ctx.fillRect(0, 0, size, size);
  }
  const tex = new AFRAME.THREE.CanvasTexture(canvas);
  tex.colorSpace = AFRAME.THREE.SRGBColorSpace;
  return tex;
}

function sparkTexture() {
  if (state.sparkTex) return state.sparkTex;
  state.sparkTex = makeRadialTexture(
    [
      [0.0, "rgba(255,255,240,1)"],
      [0.25, "rgba(255,210,120,0.9)"],
      [0.6, "rgba(255,140,40,0.35)"],
      [1.0, "rgba(255,120,0,0)"],
    ],
    true,
    64
  );
  return state.sparkTex;
}

function decalTexture() {
  if (state.decalTex) return state.decalTex;
  // Dark bullet hole with a lighter scorched rim
  state.decalTex = makeRadialTexture(
    [
      [0.0, "rgba(10,10,12,1)"],
      [0.35, "rgba(18,18,20,0.95)"],
      [0.55, "rgba(60,55,50,0.55)"],
      [1.0, "rgba(80,75,70,0)"],
    ],
    true,
    64
  );
  return state.decalTex;
}

/** Shared soft radial sprite, also used by the first-person muzzle flash. */
export function getFlashTexture() {
  return sparkTexture();
}

// ---- pool construction ----
function ensureRoot(sceneEl) {
  if (state.root && state.sceneEl === sceneEl) return state.root;
  const THREE = AFRAME.THREE;
  const root = new THREE.Group();
  root.name = "impact-effects";
  root.frustumCulled = false;
  // Attach first: if the scene has no object3D yet this throws, and committing the group
  // to `state` beforehand would leave every pooled mesh parented to a detached group.
  sceneEl.object3D.add(root);
  state.sceneEl = sceneEl;
  state.root = root;

  // Impact light is created once, up front, so the shader recompile it forces happens
  // during load rather than on the first shot.
  state.light = new THREE.PointLight(0xffbb66, 0, GAME_CONFIG.EFFECTS.IMPACT_LIGHT_RANGE, 2);
  state.light.castShadow = false;
  state.root.add(state.light);
  state.lightLife = 0;

  return state.root;
}

function tracerGeometry() {
  if (state.tracerGeo) return state.tracerGeo;
  const THREE = AFRAME.THREE;
  const r = GAME_CONFIG.EFFECTS.TRACER_RADIUS;
  const geo = new THREE.CylinderGeometry(r, r, 1, 5, 1, true);
  // Shift so the cylinder spans 0..1 along +Y, then swing +Y onto +Z so the mesh can be
  // aimed with lookAt() and stretched along its own Z.
  geo.translate(0, 0.5, 0);
  geo.rotateX(Math.PI / 2);
  state.tracerGeo = geo;
  return geo;
}

function quadGeometry() {
  if (state.quadGeo) return state.quadGeo;
  state.quadGeo = new AFRAME.THREE.PlaneGeometry(1, 1);
  return state.quadGeo;
}

function buildPool(size, factory) {
  const pool = new Array(size);
  for (let i = 0; i < size; i++) pool[i] = factory();
  return pool;
}

function newTracerSlot() {
  const THREE = AFRAME.THREE;
  const mat = new THREE.MeshBasicMaterial({
    color: 0xfff2b0,
    transparent: true,
    opacity: 0,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    fog: false,
  });
  const mesh = new THREE.Mesh(tracerGeometry(), mat);
  mesh.visible = false;
  mesh.frustumCulled = false;
  state.root.add(mesh);
  return { mesh, mat, life: 0, maxLife: 0 };
}

function newSparkSlot() {
  const THREE = AFRAME.THREE;
  const mat = new THREE.MeshBasicMaterial({
    map: sparkTexture(),
    transparent: true,
    opacity: 0,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    fog: false,
  });
  const mesh = new THREE.Mesh(quadGeometry(), mat);
  mesh.visible = false;
  mesh.frustumCulled = false;
  state.root.add(mesh);
  return { mesh, mat, life: 0, maxLife: 0, size: 1 };
}

function newDecalSlot() {
  const THREE = AFRAME.THREE;
  const mat = new THREE.MeshBasicMaterial({
    map: decalTexture(),
    transparent: true,
    opacity: 0,
    depthWrite: false,
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: -4,
    polygonOffsetUnits: -4,
    fog: false,
  });
  const mesh = new THREE.Mesh(quadGeometry(), mat);
  mesh.visible = false;
  mesh.frustumCulled = false;
  state.root.add(mesh);
  return { mesh, mat, life: 0, maxLife: 0 };
}

function ensurePools(sceneEl) {
  ensureRoot(sceneEl);
  if (state.tracers) return;
  const c = caps();
  state.tracers = buildPool(c.tracers, newTracerSlot);
  state.sparks = buildPool(c.sparks, newSparkSlot);
  state.decals = buildPool(c.decals, newDecalSlot);
}

function nextSlot(pool, idxKey) {
  const i = state[idxKey] % pool.length;
  state[idxKey] = (state[idxKey] + 1) % pool.length;
  return pool[i];
}

// ---- public spawners ----
const _dir = new AFRAME.THREE.Vector3();
const _look = new AFRAME.THREE.Vector3();

/** Short-lived stretched quad/cylinder from the muzzle to wherever the shot stopped. */
export function spawnTracer(sceneEl, from, to) {
  if (!sceneEl || !sceneEl.object3D) return;
  ensurePools(sceneEl);
  const E = GAME_CONFIG.EFFECTS;

  // Degenerate-tracer guard, measured across map geometry, so x2.33552 with the world
  // scale (src/shared/map-transform.js).
  const dist = _dir.copy(to).sub(from).length();
  if (dist < 0.12) return;

  const slot = nextSlot(state.tracers, "tracerIdx");
  slot.mesh.position.copy(from);
  slot.mesh.lookAt(to); // geometry runs along +Z, and lookAt aims +Z at the target
  slot.mesh.scale.set(1, 1, dist);
  slot.mesh.visible = true;
  slot.mat.opacity = E.TRACER_OPACITY;
  slot.maxLife = E.TRACER_LIFE;
  slot.life = E.TRACER_LIFE;
}

/**
 * Spark flash plus a fading decal at an impact point, oriented to the surface normal.
 * @param {boolean} onPlayer skip the decal (and tint the spark) for flesh hits
 */
export function spawnImpact(sceneEl, point, normal, onPlayer) {
  if (!sceneEl || !sceneEl.object3D) return;
  ensurePools(sceneEl);
  const E = GAME_CONFIG.EFFECTS;

  _look.copy(point).add(normal);

  // The three surface push-offs here (spark, impact light, decal) keep flat-on-flat
  // geometry out of a z-fight with the wall it is stuck to. They are world distances and
  // the map is 2.34x further away now, so all three are x world scale: 0.02 -> 0.05,
  // 0.15 -> 0.35, 0.012 -> 0.03. The decal one is the tightest and is the first to break
  // if the scale is revised. The SIZES (spark, decal, tracer radius) are bullet-hole
  // sized — read against the player, not the map — so they stay.
  const spark = nextSlot(state.sparks, "sparkIdx");
  spark.mesh.position.copy(point).addScaledVector(normal, 0.05);
  spark.mesh.lookAt(_look);
  spark.mesh.rotateZ(Math.random() * Math.PI * 2);
  spark.size = E.SPARK_SIZE * (0.75 + Math.random() * 0.5);
  spark.mesh.scale.setScalar(spark.size * 0.4);
  spark.mesh.visible = true;
  spark.mat.color.setHex(onPlayer ? 0xff5544 : 0xffcc66);
  spark.mat.opacity = 1;
  spark.maxLife = E.SPARK_LIFE;
  spark.life = E.SPARK_LIFE;

  if (state.light) {
    state.light.position.copy(point).addScaledVector(normal, 0.35);
    state.light.color.setHex(onPlayer ? 0xff6655 : 0xffbb66);
    state.light.intensity = E.IMPACT_LIGHT_INTENSITY;
    state.lightLife = E.SPARK_LIFE;
  }

  // Flesh leaves no bullet hole
  if (onPlayer) return;

  spawnDecal(sceneEl, point, normal);
}

/**
 * The bullet hole on its own, without the spark or the light.
 *
 * ut-effects.js draws Epic's own wall hit — the BulletImpact mesh, a smoke puff and a
 * spray of UT_Sparks — and needs the hole WITHOUT this file's spark on top of it. The
 * decal is the one part of UT_WallHit the extraction ships no texture for (UT99's is a
 * `Pock` decal actor), so this procedural one stays and is shared rather than duplicated.
 */
export function spawnDecal(sceneEl, point, normal) {
  if (!sceneEl || !sceneEl.object3D) return;
  ensurePools(sceneEl);
  const E = GAME_CONFIG.EFFECTS;
  _look.copy(point).add(normal);

  const decal = nextSlot(state.decals, "decalIdx");
  decal.mesh.position.copy(point).addScaledVector(normal, 0.03);
  decal.mesh.lookAt(_look);
  decal.mesh.rotateZ(Math.random() * Math.PI * 2);
  decal.mesh.scale.setScalar(E.DECAL_SIZE * (0.8 + Math.random() * 0.4));
  decal.mesh.visible = true;
  decal.mat.opacity = E.DECAL_OPACITY;
  decal.maxLife = E.DECAL_LIFE;
  decal.life = E.DECAL_LIFE;
}

// ---- per-frame decay ----
function stepPool(pool, dt, apply) {
  if (!pool) return;
  for (let i = 0; i < pool.length; i++) {
    const s = pool[i];
    if (s.life <= 0) continue;
    s.life -= dt;
    if (s.life <= 0) {
      s.life = 0;
      s.mesh.visible = false;
      s.mat.opacity = 0;
      continue;
    }
    apply(s, s.life / s.maxLife);
  }
}

export function updateImpactEffects(dt) {
  const E = GAME_CONFIG.EFFECTS;

  stepPool(state.tracers, dt, (s, k) => {
    s.mat.opacity = E.TRACER_OPACITY * k;
  });

  stepPool(state.sparks, dt, (s, k) => {
    // Punch outward fast, fade fast
    s.mesh.scale.setScalar(s.size * (0.4 + (1 - k) * 1.1));
    s.mat.opacity = k * k;
  });

  stepPool(state.decals, dt, (s, k) => {
    // Hold, then fade over the last third of its life
    s.mat.opacity = E.DECAL_OPACITY * Math.min(1, k * 3);
  });

  if (state.light && state.lightLife > 0) {
    state.lightLife -= dt;
    if (state.lightLife <= 0) {
      state.lightLife = 0;
      state.light.intensity = 0;
    } else {
      state.light.intensity = E.IMPACT_LIGHT_INTENSITY * (state.lightLife / E.SPARK_LIFE);
    }
  }
}

// ---- teardown ----
// Other effect modules hang their own teardown here rather than being reached into from
// this file: ut-effects.js already imports THIS module for the tracer, the decal and the
// flesh spark, and a matching import back would be a cycle for no gain.
const extraDisposers = [];

/** Register a teardown to run as part of disposeImpactEffects(). */
export function registerEffectDisposer(fn) {
  if (typeof fn === "function" && !extraDisposers.includes(fn)) extraDisposers.push(fn);
}

function disposePool(pool) {
  if (!pool) return;
  for (let i = 0; i < pool.length; i++) {
    const s = pool[i];
    if (s.mesh.parent) s.mesh.parent.remove(s.mesh);
    s.mat.dispose();
  }
}

export function disposeImpactEffects() {
  for (const fn of extraDisposers) {
    try {
      fn();
    } catch (e) {
      console.warn("[impact-effects] disposer failed:", e);
    }
  }
  extraDisposers.length = 0;

  disposePool(state.tracers);
  disposePool(state.sparks);
  disposePool(state.decals);
  state.tracers = state.sparks = state.decals = null;

  if (state.tracerGeo) state.tracerGeo.dispose();
  if (state.quadGeo) state.quadGeo.dispose();
  if (state.sparkTex) state.sparkTex.dispose();
  if (state.decalTex) state.decalTex.dispose();
  state.tracerGeo = state.quadGeo = state.sparkTex = state.decalTex = null;

  if (state.light && state.light.parent) state.light.parent.remove(state.light);
  state.light = null;
  if (state.root && state.root.parent) state.root.parent.remove(state.root);
  state.root = null;
  state.sceneEl = null;
}

// Systems are instantiated for every scene without needing an HTML attribute, which keeps
// the decay loop running no matter which component spawned the effect.
AFRAME.registerSystem("impact-effects", {
  init() {
    // Warm the pools at load so the first shot doesn't pay for buffer uploads or the
    // shader recompile that adding the impact light forces.
    try {
      ensurePools(this.sceneEl);
    } catch (e) {
      console.warn("[impact-effects] Could not pre-warm effect pools:", e);
    }
  },

  tick(time, dtMs) {
    if (!state.tracers) return;
    updateImpactEffects(Math.min(dtMs, 100) / 1000);
  },
});
