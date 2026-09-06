// hitscan.js — instant-hit raycasting against world geometry and player hitboxes.
//
// UT99's Enforcer is hitscan: the shot lands the frame it is fired. This module is the
// shared trace used by both the local weapon and the visual tracers spawned for remote
// players, so everyone agrees on where a shot stops.
//
// Port of src/game/components/hitscan.js. NOT a system — it registers nothing and has no
// update(); it is a library the weapon, the network layer and the effects call. What the
// A-Frame version reached for through the DOM it is handed instead:
//
//   sceneEl.querySelector("#world")   game.map, the node scene/world.js parks the map
//                                     model under. Same flat mesh list, same "don't cache
//                                     an empty answer" rule.
//   sceneEl.querySelectorAll(".avatar")
//                                     game.systems.get("remote-avatars").bodies(), which
//                                     is already a cached list invalidated on join/leave —
//                                     so the 500 ms TTL and the player-join/player-leave
//                                     listeners this file used to keep are gone with it.
//   avatarEl.dataset.playerId         body.id.
//   the ".avatar" element's world position
//                                     body.node — the BODY, not the rig. remote-avatars.js
//                                     moved the drawn-floor correction off the rig and onto
//                                     the body's own y, so the body's world position is the
//                                     same ground-corrected feet the old rig's was (see the
//                                     long comment above FLOOR_PROBE_UP there).
//   AFRAME.THREE                      import * as THREE from "three".
//
// The local player is not in bodies() at all, so the old `excludeEl: #soldier` — which
// existed to stop a shot dying inside the shooter's own chest — has nothing to exclude
// here. `excludeId` stays: network.js draws a REMOTE player's shot on this client and must
// not stop it on the shooter's own body.
import * as THREE from "three";
import { GAME_CONFIG } from "../config/game-config.js";

// ---- cached world colliders ----
// Raycasting a whole glTF every shot means re-walking the graph, so the mesh list is
// flattened once and reused.
//
// There is no invalidation hook on the event bus, and that is deliberate. The A-Frame
// version listened for `model-loaded` ON THE #world ELEMENT — the map's own reload, and
// nothing else. `game.events` carries ONE `model-loaded` for the whole scene (weapon-pickup
// emits it for every pickup that lands), so subscribing to it here would rebuild the map's
// mesh list every time a pickup model arrived, which the old code never did.
//
// The identity the cache is keyed on is THE MODEL ROOT, `game.map.userData.mesh` — not
// `game.map`. game.map is the Group scene/world.js parks the map under, and that Group is
// created once and never replaced, so keying on it would make the check unfalsifiable:
// assets.attachModel() swaps `userData.mesh` for a fresh model UNDER THE SAME GROUP, and a
// re-attach would go on being served the previous model's meshes. The model root changes
// with every attach, so it is the thing worth comparing (with the Group itself as the
// fallback for a stub or a map built by hand, which has no userData.mesh). The map is
// loaded once by buildWorld today; invalidateWorldColliders() is there for a test or a map
// reload that wants to force the rebuild anyway.
const EMPTY = [];
let worldMeshes = null;
let worldSource = null;

export function invalidateWorldColliders() {
  worldMeshes = null;
  worldSource = null;
}

/**
 * The map's meshes, flat and cached, ready to hand straight to
 * Raycaster.intersectObjects(list, false) — non-recursive, which is why the list has to be
 * flat: every mesh in the model, not the root that contains them.
 *
 * @param {object} game the engine handle; reads the model attached to `game.map` (the node
 *   named "world"), falling back to that node itself when nothing was attached to it
 * @returns {THREE.Mesh[]}
 */
export function getWorldColliders(game) {
  const root = game?.map ? game.map.userData?.mesh || game.map : null;
  if (!root) return EMPTY;
  if (worldMeshes && worldSource === root) return worldMeshes;

  const meshes = [];
  root.traverse((o) => {
    if (o.isMesh && o.geometry) meshes.push(o);
  });

  // Model not loaded yet — don't cache the empty result
  if (meshes.length === 0) return EMPTY;
  worldMeshes = meshes;
  worldSource = root;
  return worldMeshes;
}

// ---- math helpers (module-level temporaries, no per-shot allocation) ----
const _ba = new THREE.Vector3();
const _oa = new THREE.Vector3();
const _oc = new THREE.Vector3();
const _feet = new THREE.Vector3();
const _capA = new THREE.Vector3();
const _capB = new THREE.Vector3();
const _head = new THREE.Vector3();
const _axis = new THREE.Vector3();
const _proj = new THREE.Vector3();
const _normalMatrix = new THREE.Matrix3();
const _raycaster = new THREE.Raycaster();

// Nearest non-negative intersection of a unit ray with a sphere. Returns 0 when the ray
// starts inside (point blank still counts as a hit), -1 when it misses.
function raySphereT(ro, rd, center, radius) {
  _oc.copy(ro).sub(center);
  const b = _oc.dot(rd);
  const c = _oc.dot(_oc) - radius * radius;
  const h = b * b - c;
  if (h < 0) return -1;
  const s = Math.sqrt(h);
  const near = -b - s;
  if (near >= 0) return near;
  return -b + s >= 0 ? 0 : -1;
}

// Nearest non-negative intersection of a unit ray with a capsule (segment pa->pb, radius).
// Returns 0 when the ray starts inside, matching raySphereT — point blank still counts.
function rayCapsuleT(ro, rd, pa, pb, radius) {
  _ba.copy(pb).sub(pa);
  _oa.copy(ro).sub(pa);
  const baba = _ba.dot(_ba);
  const bard = _ba.dot(rd);
  const baoa = _ba.dot(_oa);
  const rdoa = rd.dot(_oa);
  const oaoa = _oa.dot(_oa);

  // Origin inside the capsule: the quadratic below only has a positive root at the far
  // wall, which would report the exit distance instead of a zero-range hit.
  if (baba > 1e-8) {
    const seg = Math.min(Math.max(baoa / baba, 0), 1);
    if (oaoa - 2 * seg * baoa + seg * seg * baba <= radius * radius) return 0;
  }

  let best = Infinity;

  // Cylindrical body, clipped to the segment
  const a = baba - bard * bard;
  if (Math.abs(a) > 1e-8) {
    const b = baba * rdoa - baoa * bard;
    const c = baba * oaoa - baoa * baoa - radius * radius * baba;
    const h = b * b - a * c;
    if (h >= 0) {
      const s = Math.sqrt(h);
      const t0 = (-b - s) / a;
      const t1 = (-b + s) / a;
      if (t0 >= 0) {
        const y = baoa + t0 * bard;
        if (y > 0 && y < baba) best = t0;
      }
      if (t1 >= 0 && t1 < best) {
        const y = baoa + t1 * bard;
        if (y > 0 && y < baba) best = t1;
      }
    }
  }

  // Rounded caps
  let t = raySphereT(ro, rd, pa, radius);
  if (t >= 0 && t < best) best = t;
  t = raySphereT(ro, rd, pb, radius);
  if (t >= 0 && t < best) best = t;

  return best === Infinity ? -1 : best;
}

/** The world point the hit capsule is built from: the BODY's feet — see the header. */
function bodyFeet(body, out) {
  body.node.getWorldPosition(out);
  return out;
}

/** The remote bodies to test, or an empty list on a page that has no network layer. */
function targets(game) {
  const avatars = game.systems && game.systems.get ? game.systems.get("remote-avatars") : null;
  const list = avatars && avatars.bodies ? avatars.bodies() : null;
  return list || EMPTY;
}

// ---- main trace ----
/**
 * Trace an instant shot through the scene.
 *
 * @param {object} game the engine handle
 * @param {THREE.Vector3} origin ray origin in world space
 * @param {THREE.Vector3} dir normalised ray direction
 * @param {Object} [opts] { maxDist, excludeId }
 * @returns {{hit:boolean, type:string, playerId:?string, el:?object,
 *            distance:number, point:THREE.Vector3, normal:THREE.Vector3, headshot:boolean}}
 *   `el` keeps the key the A-Frame result carried, so every existing reader of a trace
 *   result still type-checks; it is the RemoteAvatar INSTANCE now, not a DOM element.
 */
export function traceShot(game, origin, dir, opts) {
  const o = opts || {};
  const maxDistance = o.maxDist || o.maxDistance || GAME_CONFIG.WEAPON.MAX_RANGE;
  const excludeId = o.excludeId || null;
  const HB = GAME_CONFIG.HITBOX;

  let bestT = maxDistance;
  let type = "none";
  let playerId = null;
  let hitBody = null;
  let headshot = false;

  // --- player capsules first: cheap analytic tests, and they narrow the world ray ---
  const bodies = targets(game);
  for (let i = 0; i < bodies.length; i++) {
    const body = bodies[i];
    const pid = body.id;
    if (!pid || pid === excludeId) continue;
    if (!body.node) continue;

    bodyFeet(body, _feet);
    _capA.set(_feet.x, _feet.y + HB.CAPSULE_BOTTOM, _feet.z);
    _capB.set(_feet.x, _feet.y + HB.CAPSULE_TOP, _feet.z);

    const tBody = rayCapsuleT(origin, dir, _capA, _capB, HB.RADIUS);
    if (tBody >= 0 && tBody < bestT) {
      bestT = tBody;
      type = "player";
      playerId = pid;
      hitBody = body;
      headshot = false;
    }

    _head.set(_feet.x, _feet.y + HB.HEAD_HEIGHT, _feet.z);
    const tHead = raySphereT(origin, dir, _head, HB.HEAD_RADIUS);
    if (tHead >= 0 && tHead < bestT) {
      bestT = tHead;
      type = "player";
      playerId = pid;
      hitBody = body;
      headshot = true;
    }
  }

  const point = new THREE.Vector3();
  const normal = new THREE.Vector3();

  // --- world geometry: only needs to beat the nearest player hit ---
  const meshes = getWorldColliders(game);
  if (meshes.length > 0) {
    _raycaster.set(origin, dir);
    _raycaster.near = 0;
    _raycaster.far = bestT;
    const hits = _raycaster.intersectObjects(meshes, false);
    if (hits.length > 0 && hits[0].distance < bestT) {
      const h = hits[0];
      bestT = h.distance;
      type = "world";
      playerId = null;
      hitBody = null;
      headshot = false;
      point.copy(h.point);
      if (h.face) {
        _normalMatrix.getNormalMatrix(h.object.matrixWorld);
        normal.copy(h.face.normal).applyMatrix3(_normalMatrix).normalize();
        // Faces pointing away from the shooter (back faces) would bury the decal
        if (normal.dot(dir) > 0) normal.negate();
      } else {
        normal.copy(dir).negate();
      }
    }
  }

  if (type === "player") {
    point.copy(dir).multiplyScalar(bestT).add(origin);
    // Radial normal off the body axis so sparks spray away from the target
    bodyFeet(hitBody, _feet);
    _capA.set(_feet.x, _feet.y + HB.CAPSULE_BOTTOM, _feet.z);
    _axis.set(0, 1, 0);
    _proj.copy(point).sub(_capA);
    _proj.addScaledVector(_axis, -_proj.dot(_axis));
    if (_proj.lengthSq() > 1e-6) normal.copy(_proj).normalize();
    else normal.copy(dir).negate();
  } else if (type === "none") {
    point.copy(dir).multiplyScalar(maxDistance).add(origin);
    normal.copy(dir).negate();
  }

  return {
    hit: type !== "none",
    type,
    playerId,
    el: hitBody ? hitBody.avatar || null : null,
    distance: bestT,
    point,
    normal,
    headshot,
  };
}
