// hitscan.js — instant-hit raycasting against world geometry and player hitboxes
// UT99's Enforcer is hitscan: the shot lands the frame it is fired. This module is the
// shared trace used by both the local weapon and the visual tracers spawned for remote
// players, so everyone agrees on where a shot stops.
import { GAME_CONFIG } from "../config/game-config.js";

// ---- cached world colliders ----
// Raycasting a whole glTF every shot means re-walking the graph, so the mesh list is
// flattened once and reused. It is dropped whenever the model reloads.
const EMPTY = [];
let worldMeshes = null;
let worldListenerEl = null;

export function invalidateWorldColliders() {
  worldMeshes = null;
}

export function getWorldColliders(sceneEl) {
  if (worldMeshes) return worldMeshes;
  const el = sceneEl && sceneEl.querySelector("#world");
  if (!el || !el.object3D) return EMPTY;

  // Rebuild the flat list whenever the glTF is (re)loaded
  if (worldListenerEl !== el) {
    if (worldListenerEl) worldListenerEl.removeEventListener("model-loaded", invalidateWorldColliders);
    el.addEventListener("model-loaded", invalidateWorldColliders);
    worldListenerEl = el;
  }

  const meshes = [];
  el.object3D.traverse((o) => {
    if (o.isMesh && o.geometry) meshes.push(o);
  });

  // Model not loaded yet — don't cache the empty result
  if (meshes.length === 0) return EMPTY;
  worldMeshes = meshes;
  return worldMeshes;
}

// ---- cached avatar list ----
// player-join / player-leave are emitted by the network layer, but a short TTL keeps the
// list honest even if a rig is attached a frame after the event.
let cachedAvatars = null;
let avatarsStamp = 0;
let avatarListenersBound = false;
const AVATAR_CACHE_MS = 500;

export function getAvatarTargets(sceneEl) {
  const now = performance.now();
  if (cachedAvatars && now - avatarsStamp < AVATAR_CACHE_MS) return cachedAvatars;

  cachedAvatars = Array.prototype.slice.call(sceneEl.querySelectorAll(".avatar"));
  avatarsStamp = now;

  if (!avatarListenersBound) {
    const refresh = () => {
      cachedAvatars = null;
    };
    sceneEl.addEventListener("player-join", refresh);
    sceneEl.addEventListener("player-leave", refresh);
    avatarListenersBound = true;
  }
  return cachedAvatars;
}

// ---- math helpers (module-level temporaries, no per-shot allocation) ----
const _ba = new AFRAME.THREE.Vector3();
const _oa = new AFRAME.THREE.Vector3();
const _oc = new AFRAME.THREE.Vector3();
const _feet = new AFRAME.THREE.Vector3();
const _capA = new AFRAME.THREE.Vector3();
const _capB = new AFRAME.THREE.Vector3();
const _head = new AFRAME.THREE.Vector3();
const _axis = new AFRAME.THREE.Vector3();
const _proj = new AFRAME.THREE.Vector3();
const _normalMatrix = new AFRAME.THREE.Matrix3();
const _raycaster = new AFRAME.THREE.Raycaster();

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

// The entity that actually carries the visible body for a given ".avatar" element.
// Local player: #soldier (already the .avatar). Remote: the rig, soldier sits at its origin.
function avatarFeet(avatarEl, out) {
  avatarEl.object3D.getWorldPosition(out);
  return out;
}

// ---- main trace ----
/**
 * Trace an instant shot through the scene.
 * @param {Element} sceneEl a-scene
 * @param {THREE.Vector3} origin ray origin in world space
 * @param {THREE.Vector3} dir normalised ray direction
 * @param {Object} [opts] { maxDistance, excludeId, excludeEl }
 * @returns {{hit:boolean, type:string, playerId:?string, el:?Element,
 *            distance:number, point:THREE.Vector3, normal:THREE.Vector3, headshot:boolean}}
 */
export function hitscan(sceneEl, origin, dir, opts) {
  const o = opts || {};
  const maxDistance = o.maxDistance || GAME_CONFIG.WEAPON.MAX_RANGE;
  const excludeId = o.excludeId || null;
  const excludeEl = o.excludeEl || null;
  const HB = GAME_CONFIG.HITBOX;

  let bestT = maxDistance;
  let type = "none";
  let playerId = null;
  let hitEl = null;
  let headshot = false;

  // --- player capsules first: cheap analytic tests, and they narrow the world ray ---
  const avatars = getAvatarTargets(sceneEl);
  for (let i = 0; i < avatars.length; i++) {
    const avatar = avatars[i];
    if (avatar === excludeEl) continue;
    const pid = avatar.dataset.playerId;
    if (!pid || pid === excludeId) continue;
    if (!avatar.object3D) continue;

    avatarFeet(avatar, _feet);
    _capA.set(_feet.x, _feet.y + HB.CAPSULE_BOTTOM, _feet.z);
    _capB.set(_feet.x, _feet.y + HB.CAPSULE_TOP, _feet.z);

    const tBody = rayCapsuleT(origin, dir, _capA, _capB, HB.RADIUS);
    if (tBody >= 0 && tBody < bestT) {
      bestT = tBody;
      type = "player";
      playerId = pid;
      hitEl = avatar;
      headshot = false;
    }

    _head.set(_feet.x, _feet.y + HB.HEAD_HEIGHT, _feet.z);
    const tHead = raySphereT(origin, dir, _head, HB.HEAD_RADIUS);
    if (tHead >= 0 && tHead < bestT) {
      bestT = tHead;
      type = "player";
      playerId = pid;
      hitEl = avatar;
      headshot = true;
    }
  }

  const point = new AFRAME.THREE.Vector3();
  const normal = new AFRAME.THREE.Vector3();

  // --- world geometry: only needs to beat the nearest player hit ---
  const meshes = getWorldColliders(sceneEl);
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
      hitEl = null;
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
    avatarFeet(hitEl, _feet);
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
    el: hitEl,
    distance: bestT,
    point,
    normal,
    headshot,
  };
}
