// ut-effects.js — UT99's own hit effects, drawn from Epic's own meshes and sprites.
//
// ---------------------------------------------------------------------------
// WHAT THIS REPLACES, AND WHY
// ---------------------------------------------------------------------------
// impact-effects.js draws a shot the way this project invented it in 2026-08: a stretched
// additive cylinder for the tracer, one radial-gradient canvas sprite for the spark, and a
// second one for the hole. Nothing in UT99 looks like that. Botpack is explicit about what
// each weapon does when its trace lands, and all of it is meshes and 8-frame sprite sheets
// out of the packages:
//
//   ShockRifle.SpawnEffect  — NO tracer and NO spark. A chain of `ShockBeam` segments is
//     laid from the muzzle to the hit, one every 135 UU, and each one SPAWNS THE NEXT 0.05 s
//     later, so the beam visibly grows toward the target. At the far end, a
//     `ut_RingExplosion5` plays its 'Explo' sequence once, facing back along the surface
//     normal, plus a `shockexplo` light actor.
//
//     A ShockBeam segment IS NOT A MESH. `bParticles` is true on the actor, and a UE1
//     particle actor never draws its triangles: the renderer draws each of the mesh's 40
//     VERTICES as a camera-facing `jenergy2` sprite. Shockbm's faces exist only to hold
//     those forty points in place. Drawing the triangles gives a solid metal-looking rod;
//     drawing the points gives the fizzing streak of light the Shock Rifle actually has.
//     So the beam here is a THREE.Points over `shockBeam.particles.pointsM`, and the
//     sprite is the glTF's own texture — which IS jenergy2, 64 px, 0.66 m at DrawScale
//     0.44.
//   UT_WallHit / UT_HeavyWallHitEffect — the Enforcer's and Sniper Rifle's wall hit: a
//     `BulletImpact` mesh flat against the surface, one `UT_SpriteSmokePuff` (a camera-
//     facing quad playing one of four random 8-frame sheets at 0.05 s/frame, drifting
//     upward), and Rand(N) `UT_Spark` billboards thrown out under gravity. The sound is a
//     four-way roll: ricochet at a random pitch, impact1, impact2, or nothing at all.
//   Both guns eject a `UT_ShellCase` from the muzzle.
//
// THE BLEND, again. Every one of these is UE1 Style STY_TRANSLUCENT, where a sprite's
// BRIGHTNESS IS ITS OPACITY and black is invisible — see the same note at the top of
// ut-projectiles.js. They are all drawn with THREE.AdditiveBlending, depthWrite false,
// unlit, and their `ScaleGlow` (UE1's per-actor brightness multiplier) becomes the
// material opacity. Alpha-blending any of them would hang black rectangles in the air.
//
// THE ONE DELIBERATE NON-UT CONCESSION: the Enforcer and Sniper Rifle KEEP their tracer.
// UT99 draws none — the shot is instant and there is nothing to see between muzzle and
// wall — but UT99 also has a 2D muzzle flash filling a third of the screen and a room-sized
// weapon model, and in this build a missed Enforcer shot at 40 m is otherwise completely
// invisible. The tracer is the readability tax. The Shock Rifle has none, because its beam
// IS the tracer and Epic's is better than ours.
//
// ---------------------------------------------------------------------------
// THE CONTRACT, AND WHY EVERY FIELD IS READ THROUGH A FALLBACK
// ---------------------------------------------------------------------------
// The numbers and asset paths live in src/shared/effects.js, which is GENERATED from the
// retail install by the asset pipeline. That file may be absent (a fresh clone that has not
// run the extraction), stale (an older field set), or half-written while it is regenerated.
// None of those may cost a player a shot. So:
//
//   * the module is pulled in with a DYNAMIC import inside a try. A missing file is a
//     console warning, not a module-resolution error that takes main.js down with it;
//   * every field is read through pickNum/pickStr/pickObj, which accept a LIST of candidate
//     names and a fallback, so a renamed field degrades to Epic's own default rather than
//     to NaN;
//   * every spawner returns false when its asset has not loaded, and drawHitscanShot()
//     falls back to the procedural spawnTracer/spawnImpact for that shot. The effects
//     upgrade themselves the moment the glTF arrives, mid-firefight, without a reload.
//
// ---------------------------------------------------------------------------
// WHAT THE PORT OFF A-FRAME CHANGED (from the A-Frame build's ut-effects.js)
// ---------------------------------------------------------------------------
//   sceneEl.object3D        game.scene.
//   sceneEl.camera          game.camera — and the sprites still face it through
//                           getWorldQuaternion, NOT `camera.quaternion`; see
//                           cameraQuaternion() for why that is still true here.
//   new THREE.GLTFLoader()  engine/assets.js `loadGltf`, the one loader and one cache the
//                           whole client shares. THE ONE OWNERSHIP CHANGE IN THIS FILE:
//                           the source models belong to that cache now, so
//                           disposeUtEffects() releases this file's CLONES and leaves the
//                           originals alone (it used to dispose them, which would now blank
//                           a cache entry another page load reuses).
//   tick(t, dtMs)           update(dt, now) in seconds. Every lifespan, interval and
//                           gravity constant below was already in seconds — they are UE1's,
//                           straight out of the contract — so the only /1000 in the file
//                           was the tick's own, and it is gone rather than converted.
//   registerSystem          `export class UtEffects`, registered in core/main.js
//                           after first-person-weapon: it draws the shots that frame.
//
// The pools stay module-level, for the reason impact-effects.js gives at its own head:
// network.js draws every REMOTE player's shot through the same entry points the local
// weapon uses, and a per-instance pool would be a second set of GPU buffers.
//
// SOUND. There is no THREE.AudioListener here and there must not be one: every sound in
// this file is a pooled HTMLAudioElement with the distance falloff computed by hand in
// attenuate(), exactly as first-person-weapon.js plays the weapon report. The scene's one
// AudioListener belongs to systems/background-music.js and hangs off game.camera; adding a
// second would double every WebAudio-routed sound in the scene.
//
// The pure helpers at the top are exported for server/test/ut-effects.test.mjs, which
// imports THIS file — the ported one, not the retired component — and needs no renderer
// stub to do it: `three` resolves to the devDependency under Node, and nothing here or in
// what it imports touches `window`, `document` or a GL context at module scope.
import * as THREE from "three";
import { GAME_CONFIG } from "../config/game-config.js";
import { loadGltf } from "../engine/assets.js";
import { spawnTracer, spawnImpact, spawnDecal, registerEffectDisposer } from "./impact-effects.js";
import { getWorldColliders } from "./hitscan.js";

// ---------------------------------------------------------------------------
// pure helpers (no THREE, no DOM — see server/test/ut-effects.test.mjs)
// ---------------------------------------------------------------------------

/** First finite number among `names` on `obj`, else `fallback`. */
export function pickNum(obj, names, fallback) {
  if (!obj) return fallback;
  for (let i = 0; i < names.length; i++) {
    const v = obj[names[i]];
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  return fallback;
}

/** First non-empty string among `names` on `obj`, else `fallback`. */
export function pickStr(obj, names, fallback) {
  if (!obj) return fallback;
  for (let i = 0; i < names.length; i++) {
    const v = obj[names[i]];
    if (typeof v === "string" && v.length) return v;
  }
  return fallback;
}

/** First object-valued field among `names` on `obj`, else null. */
export function pickObj(obj, names) {
  if (!obj) return null;
  for (let i = 0; i < names.length; i++) {
    const v = obj[names[i]];
    if (v && typeof v === "object") return v;
  }
  return null;
}

/** First non-empty array among `names` on `obj`, else null. */
export function pickArr(obj, names) {
  if (!obj) return null;
  for (let i = 0; i < names.length; i++) {
    const v = obj[names[i]];
    if (Array.isArray(v) && v.length) return v;
  }
  return null;
}

/**
 * ShockRifle.SpawnEffect's segment count: NumPoints = VSize(HitLocation - HitStart) / 135,
 * and each segment sits MoveAmount = delta / NumPoints further along than the last.
 *
 * Capped, because the pool is finite and 400 m of max range at 3.17 m spacing is 126
 * segments — more than a beam needs and more than one shot may take from the pool. Over the
 * cap the spacing stretches instead, which is invisible: the segments overlap heavily at
 * Epic's own spacing anyway.
 *
 * @returns {{count:number, step:number}} segment count and metres between segments
 */
export function beamChain(distance, spacingM, maxSegments) {
  const spacing = spacingM > 0.05 ? spacingM : 3.17;
  const cap = maxSegments > 0 ? maxSegments : 1;
  const count = Math.max(1, Math.min(cap, Math.round(distance / spacing)));
  return { count, step: distance / count };
}

/**
 * Distance falloff for the pooled HTMLAudioElements. The repo has no positional audio
 * graph — every sound is a plain pooled `new Audio()` — so this is the cheapest honest
 * approximation of one: inverse distance against a reference radius, which is flat inside
 * `refM` and halves every time the distance doubles beyond it.
 */
export function attenuate(distance, refM) {
  const ref = refM > 0 ? refM : 8;
  const d = distance > 0 ? distance : 0;
  return ref / (ref + d);
}

/**
 * UT_WallHit's sound. Epic rolls `s = Rand(4)` — ricochet at Pitch 0.5 + FRand(), impact1,
 * impact2, or, one time in four, NOTHING. The silent quarter is Epic's and is what keeps a
 * held Enforcer trigger from turning into a machine-gun of identical ricochets; it looks
 * exactly like a bug and is not one. UT_HeavyWallHitEffect (the Sniper Rifle) rolls a
 * different table with no silence in it at all, which is why the odds come in as an
 * argument rather than being written here.
 *
 * @param {Object} sounds the contract's `sounds` block
 * @param {Object} odds   `wallHit.soundOdds` or `wallHit.heavySoundOdds`
 * @param {Array}  pitch  `wallHit.ricochetPitch`, [lo, hi]
 * @param {number} r  [0,1) — picks the bucket
 * @param {number} r2 [0,1) — the ricochet's pitch within that range
 * @returns {{src:string, rate:number}|null} null for the silent bucket
 */
export function wallHitSound(sounds, odds, pitch, r, r2) {
  if (!sounds) return null;
  const keys = ["ricochet", "impact1", "impact2"];
  let acc = 0;
  for (let i = 0; i < keys.length; i++) {
    acc += pickNum(odds, [keys[i]], 0.25);
    if (r >= acc) continue;
    const src = pickStr(sounds, [keys[i]], "");
    if (!src) return null; // the extraction did not ship this one
    if (keys[i] !== "ricochet") return { src, rate: 1 };
    const lo = pitch && Number.isFinite(pitch[0]) ? pitch[0] : 0.5;
    const hi = pitch && Number.isFinite(pitch[1]) ? pitch[1] : 1.5;
    return { src, rate: lo + r2 * (hi - lo) };
  }
  return null; // whatever is left over is the silence
}

// ---------------------------------------------------------------------------
// the contract
// ---------------------------------------------------------------------------

let FX = null;
let FX_FORWARD = "+x";
let fxLoaded = false;

/**
 * Pull in the generated table. Dynamic, and inside a try, on purpose: a static import of a
 * file the asset pipeline has not produced yet is a hard module-resolution failure that
 * takes every other import in main.js down with it.
 */
async function loadContract() {
  if (fxLoaded) return FX;
  fxLoaded = true;
  try {
    const mod = await import("../../shared/effects.js");
    FX = mod && mod.EFFECTS && typeof mod.EFFECTS === "object" ? mod.EFFECTS : null;
    // Every model is emitted in the SCENE's axes with UT99's forward baked onto one of
    // them, and the generator says which. Pointing that axis along the hit normal (or the
    // shot direction) is the whole of the placement — there is no frame conversion to do.
    if (mod && typeof mod.FORWARD_AXIS === "string" && mod.FORWARD_AXIS) FX_FORWARD = mod.FORWARD_AXIS;
    if (!FX) console.warn("[ut-effects] src/shared/effects.js has no EFFECTS export — using the procedural effects");
  } catch (e) {
    console.warn("[ut-effects] no src/shared/effects.js yet — using the procedural effects:", e && e.message);
    FX = null;
  }
  return FX;
}

// ---------------------------------------------------------------------------
// pools
// ---------------------------------------------------------------------------

const isMobileDevice = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(
  typeof navigator !== "undefined" ? navigator.userAgent : ""
);

// Fixed budgets, halved on mobile — the same rule impact-effects.js uses. A beam is the
// only effect that spends many slots at once, so it gets most of the budget; MAX_BEAM_SHOT
// keeps one long shot from claiming the whole pool and blanking the shot before it.
const BUDGET = {
  beams: GAME_CONFIG.EFFECTS.UT_MAX_BEAM_SEGMENTS,
  rings: GAME_CONFIG.EFFECTS.UT_MAX_RINGS,
  impacts: GAME_CONFIG.EFFECTS.UT_MAX_IMPACTS,
  smokes: GAME_CONFIG.EFFECTS.UT_MAX_SMOKE,
  sparks: GAME_CONFIG.EFFECTS.UT_MAX_SPARKS,
  shells: GAME_CONFIG.EFFECTS.UT_MAX_SHELLS,
  pocks: GAME_CONFIG.EFFECTS.UT_MAX_POCKS,
};
const MAX_BEAM_SHOT = GAME_CONFIG.EFFECTS.UT_BEAM_MAX_PER_SHOT;

/** Weapons that eject a shell. Epic's list: the two that fire cartridges. */
const SHELL_WEAPONS = new Set(["enforcer", "sniper"]);

const state = {
  game: null,
  root: null,
  models: new Map(), // key -> { obj, animations, long, size }
  loading: new Map(),
  sheets: null, // smoke puff: array of THREE.Texture
  sparkTex: null,
  beamGeo: null,
  beams: null,
  beamIdx: 0,
  rings: null,
  ringIdx: 0,
  impacts: null,
  impactIdx: 0,
  smokes: null,
  smokeIdx: 0,
  sparks: null,
  sparkIdx: 0,
  shells: null,
  shellIdx: 0,
  pocks: null,
  pockIdx: 0,
  pockTex: null,
  light: null,
  lightLife: 0,
  lightMax: 0,
  lightPeak: 0,
  quadGeo: null,
  // scratch, created with the root so the module stays importable outside a browser
  v: null,
};

function cap(n) {
  return Math.max(2, Math.round(n * (isMobileDevice ? 0.5 : 1)));
}

function ensureRoot(game) {
  if (state.root && state.game === game) return state.root;
  const root = new THREE.Group();
  root.name = "ut-effects";
  root.frustumCulled = false;
  // Attach before committing to `state`, for the same reason impact-effects.js does: a
  // committed-but-detached group would leave every pooled mesh parented to nothing.
  game.scene.add(root);
  state.game = game;
  state.root = root;

  state.v = {
    a: new THREE.Vector3(),
    b: new THREE.Vector3(),
    c: new THREE.Vector3(),
    dir: new THREE.Vector3(),
    step: new THREE.Vector3(),
    cam: new THREE.Vector3(),
    camQ: new THREE.Quaternion(),
    down: new THREE.Vector3(0, -1, 0),
    q: new THREE.Quaternion(),
    qr: new THREE.Quaternion(),
    ray: new THREE.Raycaster(),
  };

  // One light for the shock ring's `shockexplo`. Created up front so the shader recompile
  // that adding a light forces is paid at load rather than on the first shot.
  state.light = new THREE.PointLight(0x99bbff, 0, GAME_CONFIG.EFFECTS.SHOCK_LIGHT_RANGE, 2);
  state.light.castShadow = false;
  root.add(state.light);

  return root;
}

function camera() {
  return state.game ? state.game.camera : null;
}

/**
 * The camera's WORLD orientation, for the sprites that face it.
 *
 * STILL NOT `camera.quaternion`, and for a different reason than it used to be. A-Frame
 * never rotated the PerspectiveCamera itself (look-controls wrote pitch to the camera
 * ENTITY and yaw to the rig), so the camera's local quaternion was the identity and every
 * sprite drew edge-on. That entity is gone — but the camera is still not at the top of the
 * graph: player/controller.js parents it under `head`, under `hop`, under the rig, and
 * writes the pitch to `head` and the yaw to the rig exactly as before. Its LOCAL
 * quaternion therefore carries only the view shake's roll. The world quaternion is the one
 * that means "face the viewer".
 */
function cameraQuaternion() {
  const cam = camera();
  if (!cam || !state.v) return null;
  cam.getWorldQuaternion(state.v.camQ);
  return state.v.camQ;
}

function quadGeometry() {
  if (state.quadGeo) return state.quadGeo;
  state.quadGeo = new THREE.PlaneGeometry(1, 1);
  return state.quadGeo;
}

// ---- model loading -------------------------------------------------------

/**
 * Load one glTF once, measure its bounding box, and keep the result to clone from.
 *
 * The contract STATES the forward axis and the models are emitted to match, but the
 * extraction's frame has been revised twice in this project's history and a beam laid along
 * the wrong local axis is a very quiet failure — it still draws, just as a fence of short
 * bars across the shot instead of a line down it. So the bbox is measured and checked
 * against what the contract claims; see the warning below.
 *
 * The load itself goes through engine/assets.js, which is the client's one GLTFLoader and
 * one cache; the parsed scene it hands back is shared, and every pool slot takes its own
 * clone with its own material (cloneForPool).
 *
 * NOTHING IS WRITTEN TO THAT SHARED SCENE HERE. It is the cache's object, not this file's:
 * anything else that loads the same url — another system, another page's preload — gets the
 * very same Object3D back, so a `castShadow = false` set here would be set for them too.
 * The per-mesh flags this file wants (no frustum culling, no shadows) are applied to the
 * CLONES in cloneForPool instead; all this function does is measure the source and keep it.
 */
function loadModel(key, url, expectLongForward) {
  if (!url) return null;
  if (state.models.has(key)) return state.models.get(key);
  if (state.loading.has(key)) return null;
  state.loading.set(key, true);
  loadGltf(url)
    .then((gltf) => {
      const obj = gltf.scene;
      const box = new THREE.Box3().setFromObject(obj);
      const size = box.getSize(new THREE.Vector3());
      const long = longestAxis(size);
      state.models.set(key, { obj, animations: gltf.animations || [], long, size });
      // The contract SAYS forward is +X for every model. For the ones that are longer
      // along their forward axis than across it — a beam segment, an impact flash, a shell
      // — that is checkable, and a mismatch means the extraction's frame moved under us:
      // the beam would draw as a fence of bars across the shot rather than a line down it.
      // The ring is deliberately exempt: it is FLAT along its forward axis.
      if (expectLongForward && Math.abs(long.dot(forwardAxis())) < 0.99) {
        console.warn(
          `[ut-effects] ${key}: the contract says forward is ${FX_FORWARD} but the mesh is ` +
            `longest along (${long.x}, ${long.y}, ${long.z}). The extraction's axes have moved.`
        );
      }
      state.loading.delete(key);
      buildPools();
    })
    .catch((err) => {
      console.warn(`[ut-effects] could not load ${key} (${url}):`, err && err.message);
      state.loading.delete(key);
    });
  return null;
}

/** Unit vector along the largest component of a bbox size. */
function longestAxis(size) {
  const i = size.x >= size.y && size.x >= size.z ? 0 : size.y >= size.z ? 1 : 2;
  return new THREE.Vector3(i === 0 ? 1 : 0, i === 1 ? 1 : 0, i === 2 ? 1 : 0);
}

/**
 * The contract's `blend` for one effect, as a three.js blending constant.
 *
 * "additive" is UE1's STY_Translucent — brightness for opacity, black invisible.
 * "modulate" is STY_Modulated, which is how a decal darkens the wall it is projected on.
 * Anything else is an ordinary opaque surface.
 */
function blendOf(cfg, fallback) {
  const b = pickStr(cfg, ["blend"], fallback || "additive");
  if (b === "modulate") return THREE.MultiplyBlending;
  if (b === "normal") return THREE.NormalBlending;
  return THREE.AdditiveBlending;
}

/**
 * THE ONE r164 -> r180 DIFFERENCE THIS FILE HAD TO ABSORB, and it is not cosmetic.
 *
 * A-Frame's r164 implemented MultiplyBlending on a plain material as
 * `blendFunc(ZERO, SRC_COLOR)`. r180 removed that branch: with premultipliedAlpha false it
 * logs "MultiplyBlending requires material.premultipliedAlpha = true" and sets NO blend
 * function at all, so the Pock decal draws with whatever the last object left in the GL
 * state — a bullet hole rendered additively, i.e. a bright smudge. Every modulated
 * material here therefore declares premultipliedAlpha.
 *
 * What that changes on screen: the shader multiplies rgb by alpha and the blend becomes
 * `dst * (src * a + 1 - a)`, so a fully opaque texel darkens the wall exactly as before
 * and a transparent one leaves it alone. r164's version darkened by `src` regardless of
 * alpha, which put a faint dark square around each hole. This is the correct modulate;
 * the decal's soft rim now really is soft.
 */
function isModulate(blending) {
  return blending === THREE.MultiplyBlending;
}

/**
 * Clone a loaded model for one pool slot, giving each slot its own material.
 *
 * three.js's clone() SHARES materials with the original, and every one of these effects
 * fades by writing its own opacity — one shared material would make every live segment fade
 * with the youngest. Each slot therefore gets its own MeshBasicMaterial carrying the source
 * map. Basic, not Standard, and not a guess: every one of these glTFs ships
 * KHR_materials_unlit, because UE1 draws them all with bUnlit.
 *
 * A normal-blended clone is an ordinary opaque object and keeps its depth write; a
 * translucent or modulated one does not, or it would punch a hole in everything behind it.
 *
 * The per-mesh flags are set HERE rather than on the loaded source, which belongs to the
 * shared cache (see loadModel): frustumCulled off because these are pooled objects that are
 * teleported to a hit point without their bounding spheres ever being recomputed, and both
 * shadow flags off because a 67 ms flash has no business in the shadow map.
 */
function cloneForPool(model, blending) {
  const opaque = blending === THREE.NormalBlending;
  const obj = model.obj.clone(true);
  const mats = [];
  obj.traverse((n) => {
    if (!n.isMesh) return;
    const src = Array.isArray(n.material) ? n.material[0] : n.material;
    const mat = new THREE.MeshBasicMaterial({
      map: src && src.map ? src.map : null,
      color: 0xffffff,
      transparent: !opaque,
      opacity: 1,
      blending,
      premultipliedAlpha: isModulate(blending),
      depthWrite: opaque,
      side: THREE.DoubleSide,
      toneMapped: false,
      fog: false,
    });
    n.material = mat;
    n.frustumCulled = false;
    n.castShadow = false;
    n.receiveShadow = false;
    mats.push(mat);
  });
  obj.visible = false;
  if (!opaque) obj.renderOrder = 10;
  return { obj, mats };
}

/** One camera-facing sprite slot: a smoke puff or a spark. */
function newQuadSlot(map, blending) {
  const mat = new THREE.MeshBasicMaterial({
    map: map || null,
    color: 0xffffff,
    transparent: true,
    opacity: 0,
    depthWrite: false,
    blending: blending || THREE.AdditiveBlending,
    premultipliedAlpha: isModulate(blending),
    side: THREE.DoubleSide,
    toneMapped: false,
    fog: false,
  });
  const mesh = new THREE.Mesh(quadGeometry(), mat);
  mesh.visible = false;
  mesh.frustumCulled = false;
  mesh.renderOrder = 10;
  state.root.add(mesh);
  return { mesh, mat, life: 0, maxLife: 0 };
}

/**
 * Build whatever can be built with what has arrived. Called after every model and texture
 * load, and cheap to re-enter: each pool is built once and skipped thereafter, so the
 * effects light up one at a time as the assets land.
 */
function buildPools() {
  if (!state.root || !FX) return;

  const beamCfg = pickObj(FX, ["shockBeam"]);
  const beamModel = state.models.get("shockBeam");
  const beamPts = pickArr(pickObj(beamCfg, ["particles"]), ["pointsM"]);
  if (beamCfg && beamModel && beamPts && !state.beams) {
    // One geometry for every slot: the forty vertices Shockbm holds, in the model's own
    // frame (forward +X), which is what UE1 draws a sprite at. The sprite texture is the
    // model's own map — jenergy2 — rather than a second download.
    const pos = new Float32Array(beamPts.length * 3);
    for (let i = 0; i < beamPts.length; i++) {
      pos[i * 3] = +beamPts[i][0] || 0;
      pos[i * 3 + 1] = +beamPts[i][1] || 0;
      pos[i * 3 + 2] = +beamPts[i][2] || 0;
    }
    state.beamGeo = new THREE.BufferGeometry();
    state.beamGeo.setAttribute("position", new THREE.BufferAttribute(pos, 3));

    let map = null;
    beamModel.obj.traverse((n) => {
      if (!map && n.isMesh) {
        const m = Array.isArray(n.material) ? n.material[0] : n.material;
        if (m && m.map) map = m.map;
      }
    });
    const size = pickNum(pickObj(beamCfg, ["particles"]), ["sizeM"], 0.6618);
    const blending = blendOf(beamCfg);

    state.beams = [];
    for (let i = 0; i < cap(BUDGET.beams); i++) {
      // PointsMaterial's `size` is a WORLD size with sizeAttenuation on, which is what a
      // UE1 sprite is. gl_PointSize is clipped on the point's centre rather than its quad,
      // so a sprite whose middle leaves the screen pops out early — visible only if you
      // walk into the beam, and the price of one draw call for forty sprites.
      const mat = new THREE.PointsMaterial({
        map,
        color: 0xffffff,
        size,
        sizeAttenuation: true,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        blending,
        // Additive in every contract shipped so far, but blendOf() reads the contract and a
        // flip to "modulate" would otherwise hand r180 a MultiplyBlending material with no
        // premultipliedAlpha — the exact silent breakage isModulate() exists to prevent.
        premultipliedAlpha: isModulate(blending),
        toneMapped: false,
        fog: false,
      });
      const obj = new THREE.Points(state.beamGeo, mat);
      obj.visible = false;
      obj.frustumCulled = false;
      obj.renderOrder = 10;
      state.root.add(obj);
      state.beams.push({
        obj,
        mats: [mat],
        life: 0,
        maxLife: 0,
        delay: 0,
        roll: 0,
        rollRate: 0,
        glow: 1,
        base: new THREE.Quaternion(),
        axis: new THREE.Vector3(1, 0, 0),
      });
    }
  }

  const ringCfg = pickObj(FX, ["shockRing"]);
  const ringModel = state.models.get("shockRing");
  if (ringCfg && ringModel && !state.rings) {
    state.rings = [];
    const clipName = pickStr(ringCfg, ["clip"], "Explo");
    for (let i = 0; i < cap(BUDGET.rings); i++) {
      const { obj, mats } = cloneForPool(ringModel, blendOf(ringCfg));
      state.root.add(obj);
      const slot = { obj, mats, life: 0, maxLife: 0, glow: 1, mixer: null, action: null };
      if (ringModel.animations.length) {
        const clip = ringModel.animations.find((c) => c.name === clipName) || ringModel.animations[0];
        if (clip) {
          slot.mixer = new THREE.AnimationMixer(obj);
          slot.action = slot.mixer.clipAction(clip);
          slot.action.setLoop(THREE.LoopOnce, 1);
          slot.action.clampWhenFinished = true;
        }
      }
      state.rings.push(slot);
    }
  }

  const impCfg = pickObj(FX, ["bulletImpact"]);
  const impModel = state.models.get("bulletImpact");
  if (impCfg && impModel && !state.impacts) {
    state.impacts = [];
    for (let i = 0; i < cap(BUDGET.impacts); i++) {
      const { obj, mats } = cloneForPool(impModel, blendOf(impCfg));
      state.root.add(obj);
      state.impacts.push({ obj, mats, life: 0, maxLife: 0, glow: 1 });
    }
  }

  const shellModel = state.models.get("shellCase");
  if (shellModel && !state.shells) {
    state.shells = [];
    for (let i = 0; i < cap(BUDGET.shells); i++) {
      // THE ONE PLACE THE CONTRACT IS OVERRULED. It says `blend: "additive"` for the shell
      // case, but that comes from gen-effects.mjs's `d.style === 3 || d.unlitMaterials`
      // rule, and the shell is only the second of those: UT_ShellCase extends Debris, whose
      // Style is STY_Normal, and its Style is not even carried in the extraction (`style:
      // null` in the build's dump). Unlit is not translucent. Drawn additively a brass case
      // is a glowing smear with no depth; drawn normally it is a spent cartridge.
      const { obj, mats } = cloneForPool(shellModel, THREE.NormalBlending);
      state.root.add(obj);
      state.shells.push({
        obj,
        mats,
        life: 0,
        maxLife: 0,
        vel: new THREE.Vector3(),
        spin: new THREE.Vector3(),
        floorY: null,
        launchY: 0,
      });
    }
  }

  const smokeCfg = pickObj(FX, ["smokePuff"]);
  if (state.sheets && !state.smokes) {
    state.smokes = [];
    for (let i = 0; i < cap(BUDGET.smokes); i++) {
      const slot = newQuadSlot(null, blendOf(smokeCfg));
      slot.tex = null;
      slot.sheet = -1;
      slot.frames = 8;
      slot.pause = 0.05;
      slot.rise = 0;
      state.smokes.push(slot);
    }
  }

  const pockCfg = pickObj(FX, ["pock"]);
  if (state.pockTex && !state.pocks) {
    state.pocks = [];
    const pockBlend = blendOf(pockCfg, "modulate");
    for (let i = 0; i < cap(BUDGET.pocks); i++) {
      // MODULATED, not additive: UE1 projects a decal so it DARKENS the wall, which is the
      // one exception to the additive rule at the top of this file.
      const mat = new THREE.MeshBasicMaterial({
        map: state.pockTex[0],
        transparent: true,
        opacity: 1,
        depthWrite: false,
        blending: pockBlend,
        // See isModulate(): r180 draws nothing sane for MultiplyBlending without this.
        premultipliedAlpha: isModulate(pockBlend),
        side: THREE.DoubleSide,
        toneMapped: false,
        fog: false,
        polygonOffset: true,
        polygonOffsetFactor: -4,
        polygonOffsetUnits: -4,
      });
      const mesh = new THREE.Mesh(quadGeometry(), mat);
      mesh.visible = false;
      mesh.frustumCulled = false;
      state.root.add(mesh);
      state.pocks.push({ mesh, mat, life: 0, maxLife: 0 });
    }
  }

  if (state.sparkTex && !state.sparks) {
    state.sparks = [];
    for (let i = 0; i < cap(BUDGET.sparks); i++) {
      const slot = newQuadSlot(state.sparkTex, blendOf(pickObj(FX, ["spark"])));
      slot.vel = new THREE.Vector3();
      slot.gravity = 0;
      state.sparks.push(slot);
    }
  }
}

function nextSlot(pool, idxKey) {
  const i = state[idxKey] % pool.length;
  state[idxKey] = (state[idxKey] + 1) % pool.length;
  return pool[i];
}

// ---------------------------------------------------------------------------
// sound — pooled HTMLAudioElements with a distance falloff
// ---------------------------------------------------------------------------
//
// The same shape as first-person-weapon.js's pool (four elements per source, round-robin),
// with two additions the wall hit needs: a per-play `playbackRate`, which is how UT99's
// `Pitch` argument on the ricochet is reproduced, and a volume that falls off with the
// distance from the camera, so somebody else's Enforcer across the map is not as loud as
// your own.
const AUDIO_POOL_SIZE = 4;
const audioPools = new Map();
let audioIdx = 0;
const AUDIO_REF_M = GAME_CONFIG.EFFECTS.SOUND_REF_M; // flat inside this radius, falling off beyond it
const AUDIO_CULL_M = GAME_CONFIG.EFFECTS.SOUND_CULL_M; // beyond this a shot is silent, not inaudibly quiet

function poolFor(src) {
  if (isMobileDevice || !src) return null;
  let pool = audioPools.get(src);
  if (pool) return pool;
  pool = [];
  for (let i = 0; i < AUDIO_POOL_SIZE; i++) {
    const a = new Audio(src);
    a.volume = 0.01;
    a.preload = "auto";
    pool.push(a);
  }
  audioPools.set(src, pool);
  return pool;
}

/** Play `src` as if it came from `point`. `point` may be null for a non-positional play. */
export function playAt(src, point, baseVolume, rate) {
  const pool = poolFor(src);
  if (!pool) return;
  let vol = baseVolume;
  const cam = camera();
  if (cam && point && state.v) {
    cam.getWorldPosition(state.v.cam);
    const d = state.v.cam.distanceTo(point);
    if (d > AUDIO_CULL_M) return;
    vol = baseVolume * attenuate(d, AUDIO_REF_M);
  }
  if (!(vol > 0.002)) return;
  const a = pool[audioIdx % AUDIO_POOL_SIZE];
  audioIdx++;
  a.volume = Math.min(1, vol);
  a.playbackRate = rate && rate > 0 ? rate : 1;
  a.currentTime = 0;
  a.play().catch(() => {});
}

/**
 * A remote player's weapon report, at a volume that falls off with distance.
 * network.js used to hand the sound to the bullet entity, which played it flat.
 */
export function playWeaponSoundAt(src, point) {
  playAt(src, point, 0.14, 1);
}

// ---------------------------------------------------------------------------
// spawners
// ---------------------------------------------------------------------------

/**
 * ShockRifle.SpawnEffect's beam: a chain of `ShockBeam` segments from the muzzle to the hit.
 *
 * Each segment is spawned already positioned but INVISIBLE, and shows itself once its own
 * `delay` has run out. That is the growth: UT99 chains real actors, each spawning the next
 * MoveAmount further along on a 0.05 s timer, and this is the same thing with the
 * allocations taken out. Nothing here is created per shot.
 *
 * Each segment is FORTY SPRITES, not a mesh — see the header. And the segments deliberately
 * do NOT touch: a segment's forty points span 1.73 m and Epic spaces the segments 3.17 m
 * apart, so the beam is a dashed streak of fizzing light rather than a rod. That is what
 * the Shock Rifle looks like.
 *
 * The whole effect degrades to the procedural tracer if the contract carries no
 * `particles.pointsM` — there is no second way to draw a particle actor.
 *
 * @returns {boolean} false if the asset has not arrived and the caller must fall back
 */
export function spawnShockBeam(from, to) {
  const cfg = pickObj(FX, ["shockBeam"]);
  if (!cfg || !state.beams || !state.v) return false;

  const life = pickNum(cfg, ["lifeSpan"], 0.27);
  const pause = pickNum(cfg, ["segmentIntervalS", "pause"], 0.05);
  const rollRate = pickNum(cfg, ["rollRateRadPerSec"], 0);
  const glow = pickNum(cfg, ["glowMax"], 1);
  const spacing = pickNum(cfg, ["spacingM"], 3.173);
  // ShockRifle offsets the beam's start ahead of the muzzle so the first segment is not
  // drawn inside the player's own view model.
  const bonus = pickNum(cfg, ["muzzleForwardBonusM"], 0);
  const randomRoll = cfg.randomStartRoll !== false;

  const v = state.v;
  v.dir.copy(to).sub(from);
  const dist = v.dir.length();
  if (dist < 0.05) return true; // point blank: the ring alone reads it
  v.dir.multiplyScalar(1 / dist);
  v.a.copy(from).addScaledVector(v.dir, Math.min(bonus, dist * 0.5));

  const span = dist - v.a.distanceTo(from);
  const chain = beamChain(span, spacing, Math.min(MAX_BEAM_SHOT, state.beams.length));
  v.step.copy(v.dir).multiplyScalar(chain.step);
  // The points are emitted in the scene's axes with UT99's forward on one of them; pointing
  // that axis down the shot is the whole of the placement. NO drawScale anywhere: the
  // points and the sprite size already have DrawScale 0.44 multiplied in.
  v.q.setFromUnitVectors(forwardAxis(), v.dir);

  for (let i = 0; i < chain.count; i++) {
    const slot = nextSlot(state.beams, "beamIdx");
    slot.obj.position.copy(v.a).addScaledVector(v.step, i);
    slot.base.copy(v.q);
    slot.axis.copy(forwardAxis());
    slot.roll = randomRoll ? Math.random() * Math.PI * 2 : 0;
    slot.rollRate = rollRate;
    slot.glow = glow;
    slot.delay = i * pause;
    slot.maxLife = life;
    slot.life = life;
    slot.obj.visible = false;
    applyBeamPose(slot);
  }
  return true;
}

function applyBeamPose(slot) {
  const v = state.v;
  v.qr.setFromAxisAngle(slot.axis, slot.roll);
  slot.obj.quaternion.copy(slot.base).multiply(v.qr);
}

/**
 * `ut_RingExplosion5` at the far end of a shock beam: the model's forward axis laid along
 * the surface normal, its 'Explo' sequence played once at Epic's AnimRate — a morph
 * animation that expands the ring from 0.37 m to 4.7 m across in 0.86 s — fading with
 * ScaleGlow over its 0.8 s lifespan.
 *
 * TWO THINGS UT99 SPAWNS HERE AND THIS DOES NOT. The contract lists them under
 * `shockRing.notDrawn`: `ShockExplo`, a 15-frame `asmdex` sprite with a blue light on it,
 * and `EnergyImpact`, a scorch decal. Neither sprite is extracted, so neither is drawn —
 * but ShockExplo's LIGHT is half of what it does, and that half is here: a pooled
 * PointLight for a tenth of a second.
 */
export function spawnShockRing(point, normal) {
  const cfg = pickObj(FX, ["shockRing"]);
  const model = state.models.get("shockRing");
  if (!cfg || !model || !state.rings || !state.v) return false;

  const life = pickNum(cfg, ["lifeSpan"], 0.8);
  const glow = pickNum(cfg, ["glowMax"], 0.7);
  const rate = pickNum(cfg, ["animRate"], 0.35);
  const off = pickNum(cfg, ["offsetAlongNormalM"], 0.188);

  const slot = nextSlot(state.rings, "ringIdx");
  const v = state.v;
  slot.obj.position.copy(point).addScaledVector(normal, off);
  v.q.setFromUnitVectors(forwardAxis(), normal);
  slot.obj.quaternion.copy(v.q);
  slot.obj.visible = true;
  slot.glow = glow;
  slot.maxLife = life;
  slot.life = life;
  for (const m of slot.mats) m.opacity = glow;
  if (slot.action) {
    slot.action.reset();
    slot.action.timeScale = rate;
    slot.action.play();
  }

  flashLight(point, normal, 0x99bbff, GAME_CONFIG.EFFECTS.SHOCK_LIGHT_INTENSITY, GAME_CONFIG.EFFECTS.SHOCK_LIGHT_LIFE);
  return true;
}

/**
 * The axis the generated models carry UT99's forward on. The contract states it
 * (`FORWARD_AXIS`, "+x"); the fallback is the same, because that is what the extraction has
 * always emitted, and it is checked against each model's own bbox at load — see loadModel.
 */
let _forward = null;
function forwardAxis() {
  if (_forward) return _forward;
  const map = {
    "+x": [1, 0, 0],
    "-x": [-1, 0, 0],
    "+y": [0, 1, 0],
    "-y": [0, -1, 0],
    "+z": [0, 0, 1],
    "-z": [0, 0, -1],
  };
  const a = map[String(FX_FORWARD).toLowerCase()] || map["+x"];
  _forward = new THREE.Vector3(a[0], a[1], a[2]);
  return _forward;
}

function flashLight(point, normal, hex, intensity, life) {
  if (!state.light) return;
  state.light.position.copy(point).addScaledVector(normal, 0.35);
  state.light.color.setHex(hex);
  state.light.intensity = intensity;
  state.lightPeak = intensity;
  state.lightMax = life;
  state.lightLife = life;
}

/**
 * UT_WallHit (Enforcer) / UT_HeavyWallHitEffect (Sniper Rifle): the BulletImpact mesh, one
 * smoke puff, Rand(N) sparks, a Pock decal, and the sound roll — each weapon with its own
 * budget out of the contract's `wallHit` table, including the dual Enforcer's, which drops
 * to a single spark because it fires twice as often.
 *
 * Returns false only if NOTHING could be drawn: a partly loaded contract draws what it has,
 * because a wall hit with sparks but no smoke is still much closer to UT99 than a
 * radial-gradient blob.
 */
export function spawnWallHit(game, weaponId, point, normal, dual) {
  if (!FX || !state.v) return false;
  const table = pickObj(FX, ["wallHit"]);
  const heavy = weaponId === "sniper";
  const key = heavy ? "sniper" : dual ? "enforcerDual" : "enforcer";
  const budget = pickObj(table, [key, "enforcer"]);
  let drew = false;

  drew = spawnBulletImpact(point, normal) || drew;
  drew = spawnSmokePuff(point, normal, heavy) || drew;

  // Rand(N) debris, and each one is EITHER a chip OR a spark — a chip spawned is a spark
  // not spawned. Epic's budgets are small: three for the Enforcer, one for a dual Enforcer
  // (it fires twice as often), four for the Sniper Rifle, and zero is a possible roll.
  //
  // The chips are NOT DRAWN. The contract's `chip` block carries UT99's physics for them
  // but names a mesh (`ChipM`) the extraction does not ship, and there is no texture
  // either — so a chip is a debris slot that draws nothing. The count is still spent on
  // it, because taking the chip roll out would be inventing a livelier wall hit than UT99
  // has, and this project has spent a fortnight taking exactly that kind of thing back out.
  const debris = Math.floor(Math.random() * (pickNum(budget, ["maxSparks"], 3) + 1));
  let chips = Math.round(pickNum(budget, ["maxChips"], 0));
  const chipOdds = pickNum(budget, ["chipOdds"], 0.2);
  let sparks = 0;
  for (let i = 0; i < debris; i++) {
    if (chips > 0 && Math.random() < chipOdds) chips--;
    else sparks++;
  }
  drew = spawnSparks(point, normal, sparks) || drew;

  // The bullet hole. UT99 leaves one on every wall hit — the odds above are the chips', not
  // the decal's — and recycles them out of a fixed pool exactly as this does.
  if (!spawnPock(point, normal)) spawnDecal(game, point, normal);

  const odds = pickObj(table, [heavy ? "heavySoundOdds" : "soundOdds"]);
  const pitch = pickArr(table, ["ricochetPitch"]);
  const s = wallHitSound(pickObj(FX, ["sounds"]), odds, pitch, Math.random(), Math.random());
  if (s) playAt(s.src, point, 0.3, s.rate);

  return drew;
}

/** `BulletImpact`: one frame of a flash mesh flat against the wall, for 67 ms. */
function spawnBulletImpact(point, normal) {
  const cfg = pickObj(FX, ["bulletImpact"]);
  const model = state.models.get("bulletImpact");
  if (!cfg || !model || !state.impacts) return false;
  const life = pickNum(cfg, ["lifeSpan"], 0.066667);
  const glow = pickNum(cfg, ["glowMax"], 1);
  const off = pickNum(cfg, ["offsetAlongNormalM"], 0.024);

  const slot = nextSlot(state.impacts, "impactIdx");
  const v = state.v;
  slot.obj.position.copy(point).addScaledVector(normal, off);
  v.q.setFromUnitVectors(forwardAxis(), normal);
  slot.obj.quaternion.copy(v.q);
  slot.obj.visible = true;
  slot.glow = glow;
  slot.maxLife = life;
  slot.life = life;
  for (const m of slot.mats) m.opacity = glow;
  return true;
}

/**
 * `UT_SpriteSmokePuff`: one of four random 8-frame sheets, played left to right at 0.05 s a
 * frame, camera-facing, additive at ScaleGlow 0.4, drifting upward for its 1.5 s.
 *
 * `sizeM` is already the world size — a UE1 sprite is its texture's pixel size times
 * DrawScale in Unreal Units, and the generator has done that multiplication (32 px at
 * DrawScale 2 is 64 UU is 1.50 m). Multiplying by drawScale again here would double it.
 */
function spawnSmokePuff(point, normal, heavy) {
  const cfg = pickObj(FX, ["smokePuff"]);
  if (!cfg || !state.smokes || !state.sheets || !state.sheets.length) return false;
  const life = pickNum(cfg, ["lifeSpan"], 1.5);
  const frames = Math.max(1, Math.round(pickNum(cfg, ["frames"], 8)));
  const pause = pickNum(cfg, ["pause"], 0.05);
  const glow = pickNum(cfg, ["scaleGlow"], 0.4);
  const rise = pickNum(cfg, ["risingRateMPerSec"], 1.175);
  const size = pickNum(cfg, ["sizeM"], 1.504);
  // The two wall hits push the puff off the surface by different amounts — the Enforcer's
  // sits ON the wall, the Sniper Rifle's stands off it.
  const by = pickObj(cfg, ["offsetAlongNormalMBy"]);
  const off = by ? pickNum(by, [heavy ? "heavyWallHit" : "wallHit"], 0) : pickNum(cfg, ["offsetAlongNormalM"], 0);

  const slot = nextSlot(state.smokes, "smokeIdx");
  const sheet = Math.floor(Math.random() * state.sheets.length);
  // A slot needs its OWN texture object: the image is shared but the UV offset is not, and
  // one shared texture would show every live puff the same frame — the same trap
  // ut-projectiles.js documents for its blast quads.
  if (slot.sheet !== sheet) {
    if (slot.tex) slot.tex.dispose();
    slot.tex = state.sheets[sheet].clone();
    slot.tex.needsUpdate = true;
    slot.tex.repeat.set(1 / frames, 1);
    slot.mat.map = slot.tex;
    slot.mat.needsUpdate = true;
    slot.sheet = sheet;
  }
  slot.frames = frames;
  slot.pause = pause;
  slot.rise = rise;
  slot.mesh.position.copy(point).addScaledVector(normal, off);
  slot.mesh.scale.setScalar(size);
  // Face the viewer on the frame it appears, not on the next update: the system's update
  // may already have run for this frame, and one frame of an edge-on sprite is a flicker.
  const camQ = cameraQuaternion();
  if (camQ) slot.mesh.quaternion.copy(camQ);
  slot.mesh.visible = true;
  slot.mat.opacity = glow;
  slot.glow = glow;
  slot.maxLife = life;
  slot.life = life;
  setSmokeFrame(slot, 0);
  return true;
}

function setSmokeFrame(slot, i) {
  if (slot.tex) slot.tex.offset.set(i / slot.frames, 0);
}

/**
 * Rand(N) `UT_Spark` billboards thrown out of the surface. `gravityMPerSec2` is SIGNED and
 * negative — it is UE1's acceleration, not a magnitude — so it is added, not subtracted.
 * Getting that wrong sends every spark up into the ceiling, which is not a subtle failure
 * but is a silent one until somebody looks.
 */
function spawnSparks(point, normal, count) {
  const cfg = pickObj(FX, ["spark"]);
  if (!cfg || !state.sparks || count <= 0) return false;
  const life = pickNum(cfg, ["lifeSpan"], 1);
  const size = pickNum(cfg, ["sizeM"], 0.0752); // already DrawScale'd — see the smoke note
  const speed = pickNum(cfg, ["speedMaxMPerSec"], 4.7);
  const gravity = pickNum(cfg, ["gravityMPerSec2"], -22.325);
  const off = pickNum(cfg, ["offsetAlongNormalM"], 0.188);
  const glow = pickNum(cfg, ["glowMax"], 1);

  const v = state.v;
  const camQ = cameraQuaternion();
  for (let i = 0; i < count; i++) {
    const slot = nextSlot(state.sparks, "sparkIdx");
    slot.mesh.position.copy(point).addScaledVector(normal, off);
    slot.mesh.scale.setScalar(size);
    if (camQ) slot.mesh.quaternion.copy(camQ);
    slot.mesh.visible = true;
    slot.mat.opacity = glow;
    slot.glow = glow;
    slot.gravity = gravity;
    slot.maxLife = life;
    slot.life = life;
    // VRand() biased out of the wall: in practice most of a hemisphere about the normal.
    v.a.set(Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 2 - 1);
    if (v.a.lengthSq() < 1e-6) v.a.copy(normal);
    v.a.normalize();
    if (v.a.dot(normal) < 0) v.a.negate();
    slot.vel.copy(v.a).multiplyScalar(speed * Math.random());
  }
  return true;
}

/**
 * UT99's `Pock` decal — the real one, three 32-px textures out of the package, at
 * DrawScale 0.19, alive for 18 to 23 seconds.
 *
 * IT DOES NOT FADE — Epic's behaviour, not a limitation of the blend. UE1 projects a decal
 * MODULATED, so the texture darkens the wall it is stuck to, and three.js's MultiplyBlending
 * draws the same way. Under r180's premultiplied path (see isModulate) the result is
 * `dst * (src * a + 1 - a)`, in which alpha IS a working fade knob: a -> 0 leaves `dst`
 * untouched, so lerping opacity down would dissolve a hole cleanly to nothing in one pass.
 * It is not done because UE1 does not do it: a decal has a lifespan and is destroyed. So
 * this one pops, exactly as Epic's does, and the procedural bullet hole in
 * impact-effects.js (which DOES fade) stays as the fallback for a build with no pock
 * textures.
 */
function spawnPock(point, normal) {
  const cfg = pickObj(FX, ["pock"]);
  if (!cfg || !state.pocks || !state.pockTex || !state.pockTex.length) return false;
  const size = pickNum(cfg, ["sizeM"], 0.1429); // already DrawScale'd
  const span = pickArr(cfg, ["lifeSeconds"]) || [18, 23];
  const lo = Number.isFinite(span[0]) ? span[0] : 18;
  const hi = Number.isFinite(span[1]) ? span[1] : 23;

  const slot = nextSlot(state.pocks, "pockIdx");
  const tex = state.pockTex[Math.floor(Math.random() * state.pockTex.length)];
  if (slot.mat.map !== tex) {
    slot.mat.map = tex;
    slot.mat.needsUpdate = true;
  }
  const v = state.v;
  v.a.copy(point).add(normal);
  slot.mesh.position.copy(point).addScaledVector(normal, 0.03);
  slot.mesh.lookAt(v.a);
  slot.mesh.rotateZ(Math.random() * Math.PI * 2);
  slot.mesh.scale.setScalar(size);
  slot.mesh.visible = true;
  slot.mat.opacity = 1;
  slot.maxLife = lo + Math.random() * (hi - lo);
  slot.life = slot.maxLife;
  return true;
}

/**
 * `UT_ShellCase` out of the muzzle. Thrown forward, right and up at Epic's own ranges,
 * spinning, under gravity, bouncing up to three times for its 3 s lifespan. The Sniper
 * Rifle sets `s.DrawScale = 2.0` before ejecting, which is the one place a drawScale is
 * applied to a committed model rather than already baked into it.
 *
 * THE FLOOR IS APPROXIMATED. A shell that tested the world every frame would be six
 * raycasts a second against the whole map for something the player sees for a moment out of
 * the corner of their eye. Instead ONE downward ray is fired the first time the shell has
 * fallen 2 m below where it left the gun, the floor height that comes back is remembered,
 * and the shell bounces on that plane. A shell thrown over a ledge therefore lands on the
 * plane of whatever was under it at that moment rather than following the geometry down —
 * which on Face means the tower floor rather than the sea. Accepted: it is a spent case.
 */
export function ejectShell(weaponId, muzzle, dir) {
  if (!SHELL_WEAPONS.has(weaponId)) return false;
  const cfg = pickObj(FX, ["shellCase"]);
  const model = state.models.get("shellCase");
  if (!cfg || !model || !state.shells || !state.v) return false;

  const life = pickNum(cfg, ["lifeSpan"], 3);
  const scale = weaponId === "sniper" ? pickNum(cfg, ["sniperDrawScale"], 2) : 1;
  const gravity = pickNum(cfg, ["gravityMPerSec2"], -22.325);
  const spin = pickNum(cfg, ["spinMaxRadPerSec"], 9.5874);
  const rest = pickNum(cfg, ["bounceRestitution"], 0.5);
  const maxBounces = Math.round(pickNum(cfg, ["maxBounces"], 3));
  const stopChance = pickNum(cfg, ["bounceStopChance"], 0.85);
  const eject = pickObj(cfg, ["ejectMPerSec"]);
  const spawnOff = pickNum(pickObj(cfg, ["spawnOffsetM"]), [weaponId], 0);

  const v = state.v;
  // The shooter's own aim axes, which is the frame UT99 throws the case in: forward down
  // the shot, right across it, up out of it.
  v.a.set(0, 1, 0);
  v.b.copy(dir).cross(v.a);
  if (v.b.lengthSq() < 1e-6) v.b.set(1, 0, 0);
  v.b.normalize();
  v.c.copy(v.b).cross(dir).normalize();

  const slot = nextSlot(state.shells, "shellIdx");
  slot.obj.position.copy(muzzle).addScaledVector(dir, spawnOff);
  slot.obj.scale.setScalar(scale);
  slot.obj.visible = true;
  slot.obj.rotation.set(Math.random() * 6.28, Math.random() * 6.28, Math.random() * 6.28);
  slot.vel
    .copy(dir)
    .multiplyScalar(range(eject, "forward", 1.5, 2.6))
    .addScaledVector(v.b, range(eject, "right", 0.75, 1.5))
    .addScaledVector(v.c, range(eject, "up", 3.76, 4.89));
  slot.spin.set(rand1() * spin, rand1() * spin, rand1() * spin);
  slot.gravity = gravity;
  slot.rest = rest;
  slot.bounces = maxBounces;
  slot.stopChance = stopChance;
  slot.floorY = null;
  slot.launchY = slot.obj.position.y;
  slot.maxLife = life;
  slot.life = life;
  return true;
}

/** A uniform draw from a [lo, hi] pair on the contract, with a fallback pair. */
function range(obj, key, lo, hi) {
  const a = pickArr(obj, [key]);
  const l = a && Number.isFinite(a[0]) ? a[0] : lo;
  const h = a && Number.isFinite(a[1]) ? a[1] : hi;
  return l + Math.random() * (h - l);
}

const rand1 = () => Math.random() * 2 - 1;

// ---------------------------------------------------------------------------
// the one entry point a shot uses
// ---------------------------------------------------------------------------

/**
 * Draw one resolved hitscan shot, for the local player and for a remote one alike.
 *
 * @param {object} game the engine handle
 * @param {string} weaponId the SHOOTER's weapon
 * @param {THREE.Vector3} muzzle where the visible shot starts (the barrel tip)
 * @param {Object} result whatever traceShot() returned
 * @param {boolean} [dual] two Enforcers: half the sparks, because it fires twice as often
 */
export function drawHitscanShot(game, weaponId, muzzle, result, dual) {
  if (!game || !result) return;
  try {
    ensureRoot(game);
  } catch (e) {
    return;
  }
  const onPlayer = result.type === "player";

  // ---- the Shock Rifle: a beam and a ring, no tracer and no spark ----
  if (weaponId === "shock") {
    if (spawnShockBeam(muzzle, result.point)) {
      spawnShockRing(result.point, result.normal);
      if (onPlayer) playAt(pickStr(pickObj(FX, ["sounds"]), ["chunkHit"], ""), result.point, 0.35, 1);
      return;
    }
    // The glTF has not arrived (or there is no contract): draw the old shot rather than
    // nothing at all.
    spawnTracer(game, muzzle, result.point);
    if (result.type !== "none") spawnImpact(game, result.point, result.normal, onPlayer);
    return;
  }

  // ---- Enforcer and Sniper Rifle ----
  // The tracer is kept on purpose; see the header. Everything past it is Epic's.
  spawnTracer(game, muzzle, result.point);

  if (onPlayer) {
    // UT99 spawns blood here, which this build has no asset for; the existing flesh spark
    // stays and the flesh sound is Epic's own.
    spawnImpact(game, result.point, result.normal, true);
    playAt(pickStr(pickObj(FX, ["sounds"]), ["chunkHit"], ""), result.point, 0.35, 1);
    return;
  }
  if (result.type !== "world") return;

  if (!spawnWallHit(game, weaponId, result.point, result.normal, dual)) {
    spawnImpact(game, result.point, result.normal, false);
  }
}

// ---------------------------------------------------------------------------
// per-frame decay
// ---------------------------------------------------------------------------

function stepBeams(dt) {
  const pool = state.beams;
  if (!pool) return;
  for (let i = 0; i < pool.length; i++) {
    const s = pool[i];
    if (s.life <= 0) continue;
    if (s.delay > 0) {
      s.delay -= dt;
      if (s.delay > 0) continue;
      s.obj.visible = true;
    }
    s.life -= dt;
    if (s.life <= 0) {
      s.life = 0;
      s.obj.visible = false;
      continue;
    }
    // ShockBeam.Tick: ScaleGlow = LifeSpan-remaining / 0.27, and it rolls about its length.
    const k = s.glow * (s.life / s.maxLife);
    for (let m = 0; m < s.mats.length; m++) s.mats[m].opacity = k;
    if (s.rollRate) {
      s.roll += s.rollRate * dt;
      applyBeamPose(s);
    }
  }
}

function stepRings(dt) {
  const pool = state.rings;
  if (!pool) return;
  for (let i = 0; i < pool.length; i++) {
    const s = pool[i];
    if (s.life <= 0) continue;
    s.life -= dt;
    if (s.mixer) s.mixer.update(dt);
    if (s.life <= 0) {
      s.life = 0;
      s.obj.visible = false;
      if (s.action) s.action.stop();
      continue;
    }
    const k = s.glow * (s.life / s.maxLife);
    for (let m = 0; m < s.mats.length; m++) s.mats[m].opacity = k;
  }
}

function stepMeshFades(dt, pool) {
  if (!pool) return;
  for (let i = 0; i < pool.length; i++) {
    const s = pool[i];
    if (s.life <= 0) continue;
    s.life -= dt;
    if (s.life <= 0) {
      s.life = 0;
      s.obj.visible = false;
      continue;
    }
    const k = s.glow * (s.life / s.maxLife);
    for (let m = 0; m < s.mats.length; m++) s.mats[m].opacity = k;
  }
}

function stepSmokes(dt, camQ) {
  const pool = state.smokes;
  if (!pool) return;
  for (let i = 0; i < pool.length; i++) {
    const s = pool[i];
    if (s.life <= 0) continue;
    s.life -= dt;
    if (s.life <= 0) {
      s.life = 0;
      s.mesh.visible = false;
      continue;
    }
    const age = s.maxLife - s.life;
    setSmokeFrame(s, Math.min(s.frames - 1, Math.floor(age / s.pause)));
    s.mesh.position.y += s.rise * dt;
    if (camQ) s.mesh.quaternion.copy(camQ);
    // UE1 holds ScaleGlow flat and lets the sheet's own last frame do the fading. The
    // sheets here end on a frame that is dim but not black, so the last fifth is faded out
    // by hand — without it the puff pops off screen.
    const k = s.life / s.maxLife;
    s.mat.opacity = s.glow * (k < 0.2 ? k / 0.2 : 1);
  }
}

function stepSparks(dt, camQ) {
  const pool = state.sparks;
  if (!pool) return;
  for (let i = 0; i < pool.length; i++) {
    const s = pool[i];
    if (s.life <= 0) continue;
    s.life -= dt;
    if (s.life <= 0) {
      s.life = 0;
      s.mesh.visible = false;
      continue;
    }
    // gravityMPerSec2 is UE1's SIGNED acceleration (negative), so it is added.
    s.vel.y += s.gravity * dt;
    s.mesh.position.addScaledVector(s.vel, dt);
    if (camQ) s.mesh.quaternion.copy(camQ);
    const k = s.life / s.maxLife;
    s.mat.opacity = s.glow * k * k;
  }
}

function stepShells(dt) {
  const pool = state.shells;
  if (!pool || !state.v) return;
  for (let i = 0; i < pool.length; i++) {
    const s = pool[i];
    if (s.life <= 0) continue;
    s.life -= dt;
    if (s.life <= 0) {
      s.life = 0;
      s.obj.visible = false;
      continue;
    }
    s.vel.y += s.gravity * dt;
    s.obj.position.addScaledVector(s.vel, dt);
    s.obj.rotation.x += s.spin.x * dt;
    s.obj.rotation.y += s.spin.y * dt;
    s.obj.rotation.z += s.spin.z * dt;

    // One ray, once, when the shell has fallen far enough to be near a floor.
    if (s.floorY === null && s.obj.position.y < s.launchY - 2) {
      s.floorY = floorUnder(s.obj.position);
    }
    if (s.floorY !== null && s.obj.position.y <= s.floorY) {
      s.obj.position.y = s.floorY;
      // UT_ShellCase bounces at most three times, and each landing has a high chance of
      // simply stopping it — Epic's `bounceStopChance`. A shell that keeps rolling reads as
      // a bug; one that clatters once and lies still reads as a spent case.
      if (s.bounces <= 0 || Math.abs(s.vel.y) < 0.4 || Math.random() < s.stopChance) {
        s.vel.set(0, 0, 0);
        s.spin.set(0, 0, 0);
        s.bounces = 0;
      } else {
        s.bounces--;
        s.vel.y = -s.vel.y * s.rest;
        s.vel.x *= 0.6;
        s.vel.z *= 0.6;
        s.spin.multiplyScalar(0.5);
      }
    }
  }
}

function floorUnder(pos) {
  const meshes = getWorldColliders(state.game);
  if (!meshes || !meshes.length) return null;
  const v = state.v;
  v.a.copy(pos);
  v.a.y += 0.5;
  v.ray.set(v.a, v.down);
  v.ray.near = 0;
  v.ray.far = 40;
  const hits = v.ray.intersectObjects(meshes, false);
  return hits.length ? hits[0].point.y : null;
}

function stepPocks(dt) {
  const pool = state.pocks;
  if (!pool) return;
  for (let i = 0; i < pool.length; i++) {
    const s = pool[i];
    if (s.life <= 0) continue;
    s.life -= dt;
    // No fade, and not because the blend cannot: r180's premultiplied multiply would take
    // opacity to zero as a clean no-op. UE1's decals are destroyed at their lifespan rather
    // than faded, so this one pops when its time is up. See spawnPock.
    if (s.life <= 0) {
      s.life = 0;
      s.mesh.visible = false;
    }
  }
}

export function updateUtEffects(dt) {
  const camQ = cameraQuaternion();
  stepBeams(dt);
  stepRings(dt);
  stepMeshFades(dt, state.impacts);
  stepSmokes(dt, camQ);
  stepSparks(dt, camQ);
  stepShells(dt);
  stepPocks(dt);
  if (state.lightLife > 0 && state.light) {
    state.lightLife -= dt;
    if (state.lightLife <= 0) {
      state.lightLife = 0;
      state.light.intensity = 0;
    } else {
      state.light.intensity = state.lightPeak * (state.lightLife / state.lightMax);
    }
  }
}

// ---------------------------------------------------------------------------
// teardown
// ---------------------------------------------------------------------------

function disposeMeshPool(pool) {
  if (!pool) return;
  for (const s of pool) {
    const obj = s.obj || s.mesh;
    if (obj && obj.parent) obj.parent.remove(obj);
    if (s.mats) for (const m of s.mats) m.dispose();
    if (s.mat) s.mat.dispose();
    if (s.tex) s.tex.dispose();
    if (s.mixer) s.mixer.stopAllAction();
  }
}

export function disposeUtEffects() {
  disposeMeshPool(state.beams);
  disposeMeshPool(state.rings);
  disposeMeshPool(state.impacts);
  disposeMeshPool(state.smokes);
  disposeMeshPool(state.sparks);
  disposeMeshPool(state.shells);
  disposeMeshPool(state.pocks);
  state.beams = state.rings = state.impacts = state.smokes = state.sparks = null;
  state.shells = state.pocks = null;

  if (state.sheets) for (const t of state.sheets) t.dispose();
  state.sheets = null;
  if (state.sparkTex) state.sparkTex.dispose();
  state.sparkTex = null;
  if (state.pockTex) for (const t of state.pockTex) t.dispose();
  state.pockTex = null;
  if (state.quadGeo) state.quadGeo.dispose();
  state.quadGeo = null;
  if (state.beamGeo) state.beamGeo.dispose();
  state.beamGeo = null;

  // THE ONE DIFFERENCE FROM THE A-FRAME VERSION, and it is an ownership change rather than
  // a behaviour one: that file created its own GLTFLoader, so the source models were its
  // property and it disposed their geometry and textures here. These come from
  // engine/assets.js's shared cache, which hands the same parsed glTF to anything else that
  // asks for the URL — disposing them would blank a later reader's meshes. The clones above
  // (each with its own material) are this file's and are released; the originals stay with
  // the cache, whose lifetime is the page's.
  state.models.clear();

  if (state.light && state.light.parent) state.light.parent.remove(state.light);
  state.light = null;
  if (state.root && state.root.parent) state.root.parent.remove(state.root);
  state.root = null;
  state.game = null;
  state.v = null;
  _forward = null;
}

// ---------------------------------------------------------------------------
// system
// ---------------------------------------------------------------------------

async function preload(game) {
  ensureRoot(game);
  await loadContract();
  if (!FX) return;

  // The last argument says whether the mesh should be LONGEST along the contract's forward
  // axis — true for a beam segment, an impact flash and a shell case, false for the ring,
  // which is flat along it.
  loadModel("shockBeam", pickStr(pickObj(FX, ["shockBeam"]), ["model"], ""), true);
  loadModel("shockRing", pickStr(pickObj(FX, ["shockRing"]), ["model"], ""), false);
  loadModel("bulletImpact", pickStr(pickObj(FX, ["bulletImpact"]), ["model"], ""), true);
  loadModel("shellCase", pickStr(pickObj(FX, ["shellCase"]), ["model"], ""), true);

  const sheetPaths = pickArr(pickObj(FX, ["smokePuff"]), ["sheets"]);
  if (sheetPaths && !state.sheets) {
    const loader = new THREE.TextureLoader();
    state.sheets = sheetPaths.map((p) => {
      const t = loader.load(p);
      t.colorSpace = THREE.SRGBColorSpace;
      t.wrapS = THREE.ClampToEdgeWrapping;
      t.wrapT = THREE.ClampToEdgeWrapping;
      return t;
    });
  }

  const sparkPath = pickStr(pickObj(FX, ["spark"]), ["texture"], "");
  if (sparkPath && !state.sparkTex) {
    state.sparkTex = new THREE.TextureLoader().load(sparkPath);
    state.sparkTex.colorSpace = THREE.SRGBColorSpace;
  }

  const pockPaths = pickArr(pickObj(FX, ["pock"]), ["textures"]);
  if (pockPaths && !state.pockTex) {
    const loader = new THREE.TextureLoader();
    state.pockTex = pockPaths.map((p) => {
      const t = loader.load(p);
      t.colorSpace = THREE.SRGBColorSpace;
      return t;
    });
  }

  // Warm the four wall-hit sounds so the first shot is not silent while they load.
  const sounds = pickObj(FX, ["sounds"]);
  if (sounds) for (const k of ["chunkHit", "impact1", "impact2", "ricochet"]) poolFor(sounds[k]);

  buildPools();
}

/**
 * The system. Registered in core/main.js AFTER first-person-weapon, because it draws
 * the shots that were fired THIS frame.
 *
 * THE PUBLIC SURFACE, which is what network.js (Task 13) calls for a remote player's shot
 * and what first-person-weapon.js calls for your own:
 *
 *   drawHitscanShot(weaponId, muzzleWorld, result, dual)  the whole visible shot
 *   ejectShell(weaponId, muzzleWorld, dir)                the spent cartridge, if any
 *   playWeaponSoundAt(src, point)                         somebody else's weapon report
 *   playAt(src, point, volume, rate)                      any positional one-shot
 *
 * They are methods here and free functions above (with `game` as the first argument), and
 * both spellings hit the same pools; the methods are the ones to use, since a caller that
 * has the system already has the game.
 */
export class UtEffects {
  constructor(game) {
    this.game = game;
    // The pools live as long as the scene; impact-effects.js owns the single teardown path
    // both files are torn down through, and ImpactEffects.dispose() runs it. There is
    // deliberately no dispose() here: game.dispose() walks the systems in reverse
    // registration order, so impact-effects (registered after this) would tear these pools
    // down through the disposer below and then this one would run over freed state.
    try {
      registerEffectDisposer(disposeUtEffects);
      preload(game).catch((e) => console.warn("[ut-effects] preload failed:", e));
    } catch (e) {
      console.warn("[ut-effects] init failed:", e);
    }
  }

  /** @see drawHitscanShot */
  drawHitscanShot(weaponId, muzzle, result, dual) {
    drawHitscanShot(this.game, weaponId, muzzle, result, dual);
  }

  /** @see ejectShell — returns false for a weapon that ejects nothing. */
  ejectShell(weaponId, muzzle, dir) {
    return ejectShell(weaponId, muzzle, dir);
  }

  /** @see playWeaponSoundAt */
  playWeaponSoundAt(src, point) {
    playWeaponSoundAt(src, point);
  }

  /** @see playAt */
  playAt(src, point, volume, rate) {
    playAt(src, point, volume, rate);
  }

  /**
   * A read-only snapshot of the pools, for scripts/pw/effects.mjs and the console.
   *
   * The pools are module-private and there is no other way to see, from the page, that a
   * shot spent an impact slot rather than falling back to the procedural blob — which is a
   * difference nothing on screen states plainly. Allocates only the object it returns, and
   * is never called by the game itself.
   */
  stats() {
    const live = (pool) => (pool ? pool.reduce((n, s) => n + (s.life > 0 ? 1 : 0), 0) : 0);
    const size = (pool) => (pool ? pool.length : 0);
    const ringAction = state.rings && state.rings[0] ? state.rings[0].action : null;
    const ringClip = ringAction ? ringAction.getClip() : null;
    return {
      models: [...state.models.keys()],
      sheets: state.sheets ? state.sheets.length : 0,
      sparkTex: !!state.sparkTex,
      pockTex: state.pockTex ? state.pockTex.length : 0,
      size: {
        beams: size(state.beams),
        rings: size(state.rings),
        impacts: size(state.impacts),
        smokes: size(state.smokes),
        sparks: size(state.sparks),
        shells: size(state.shells),
        pocks: size(state.pocks),
      },
      live: {
        beams: live(state.beams),
        rings: live(state.rings),
        impacts: live(state.impacts),
        smokes: live(state.smokes),
        sparks: live(state.sparks),
        shells: live(state.shells),
        pocks: live(state.pocks),
      },
      // The forty vertices of Shockbm that UE1 draws as sprites — see spawnShockBeam.
      beamParticles: state.beamGeo ? state.beamGeo.getAttribute("position").count : 0,
      // UTRingex's 'Explo' is a 9-frame vertex animation (8 morph targets plus the base
      // pose); server/test/effects.test.mjs pins the same number on the glTF.
      ringFrames: ringClip && ringClip.tracks.length ? ringClip.tracks[0].times.length : 0,
      // Every live shell's height, so a probe can watch one fall under UE1's gravity.
      shellY: state.shells ? state.shells.filter((s) => s.life > 0).map((s) => s.obj.position.y) : [],
      lightIntensity: state.light ? state.light.intensity : 0,
    };
  }

  update(dt) {
    if (!state.root) return;
    // tick(time, dtMs) clamped a throttled frame at 100 ms before dividing by 1000; the
    // loop in engine/game.js already clamps at 50 ms, and this keeps the old ceiling. Every
    // other time constant in this file was already in seconds — they are UE1's — so this
    // is the only conversion the port had to make.
    updateUtEffects(Math.min(dt, 0.1));
  }
}
