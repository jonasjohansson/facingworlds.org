// controller.js — the local player: look, UT99 movement, the navmesh clamp, the jump,
// the drawn-floor correction and the view shake, in one update() with one scene graph.
//
// It replaces six A-Frame behaviours that used to be spread across #rig, #soldier, #cam
// and #view-shake: look-controls, movement-controls (+ nav-mesh), ut-controls, ut-jump,
// invisible-to-player and the view-shake writer that lived inside first-person-weapon.
//
// ---------------------------------------------------------------------------
// THE SCENE GRAPH, AND WHAT OWNS EACH TRANSFORM
// ---------------------------------------------------------------------------
//   rig      Group   position = the WIRE position: navmesh xz AND navmesh y.
//                    rotation.y = yaw (mouse, touch drag, and spawns).
//     hop    Group   position.y = the jump arc + the drawn-floor correction. Nothing
//                    else ever writes it; visualOffset() reports it on the wire.
//       soldier Group  the local body. Its meshes draw with colorWrite and depthWrite
//                      off, so they leave no trace in the frame but still cast their
//                      shadow — this is what invisible-to-player did. See
//                      hideFromCamera() for why it is not a layer.
//       head   Group   position.y = eye height 1.4 m (index.html had it on #cam).
//                      rotation.x = pitch.
//         camera        rotation.z = the shake's roll, position.y = the shake's eye lift.
//         gunRoot Group the SAME roll and lift, so the gun stays nailed to the screen
//                       while the world tilts. Task 9 hangs the weapon here.
//
// Yaw on the RIG and pitch on the HEAD is the same composition A-Frame produced with one
// node: it set every entity's object3D.rotation.order to "YXZ" (a-entity.js), so #cam's
// pitch/yaw pair already meant "yaw, then pitch". Two single-axis nodes cannot be read
// any other way, so the Euler order of neither node matters here.
//
// On the wire the old code sent `rig.rotation.y + cam.rotation.y` because look-controls
// put the mouse yaw on the camera and the rig's own yaw only moved on Q/E and spawns.
// The sum is now simply rig.rotation.y. network.js is ported in Task 13; until then this
// file is what defines the contract: rig.position is the wire position, the hop is a
// separate visualOffset(), and the yaw sent is the rig's.
//
// ---------------------------------------------------------------------------
// WHY THE HOP IS NOT ON THE RIG
// ---------------------------------------------------------------------------
// The obvious implementation — add the hop height to the rig's own position.y — is still
// wrong here, but the reason has changed and the old explanation (ut-movement.js) was
// only half right. It said clampStep "assumes the start point lies ON the navmesh". It
// does not: three-pathfinding's clampStep never reads its `start` argument at all. What
// broke was the CALLER. aframe-extras asked for the containing polygon with
// `checkPolygon: true`, which returns null the moment the rig is more than half a metre
// off the surface, and when it got null it SKIPPED the clamp for that frame
// (`out.copy(end)`) and tried to re-acquire at the end point. So a lifted rig got a
// mixture of unclamped frames and clamps against whatever polygon was picked up next.
// Measured in the running scene, holding the rig at a fixed height above the navmesh and
// walking forward at a steady 9.4 m/s:
//     lift 0.0 m -> 5.0 m/s      lift 1.0 m ->  4.4 m/s (peak  6.2)
//     lift 0.5 m -> 1.4 m/s      lift 1.5 m -> 12.4 m/s (peak 43.5)
//                                lift 2.0 m -> 13.6 m/s (peak 55.2)
// A 1.5 m UT99 jump therefore teleported the player across the rock.
//
// player/navclamp.js closed that hole: it always falls back to the nearest polygon, so
// the rig is never unclamped and a lift can no longer slingshot it. The hop stays off the
// rig anyway, for the reason that outlives the bug: the rig's y IS the navmesh y, and the
// wire, the server and every remote avatar are built on that. Lifting the rig would send
// a jumping player's feet through the floor of everyone else's map. So the hop is applied
// to the rig's CHILDREN — the camera and the body, which is what anyone actually sees —
// and reported separately as visualOffset().
//
// WHAT THAT COSTS, PLAINLY. This is a hop in place, not a traversal move. You cannot jump
// ACROSS a gap in the navmesh: your feet are still clamped to the walkable surface, so
// you rise, drift to the edge, and come back down inside it. Clearing a hole would mean
// leaving the navmesh constraint mid-air and running a real collision query against the
// world geometry to land again — the custom controller with its own capsule sweep that is
// out of scope. What is here is honest for its purpose: the jump's timing, height and
// committed low-air-control arc, which is what dodging fire in UT99 feels like.
//
// ---------------------------------------------------------------------------
// EVERY TELEPORT MUST CALL navClamp.reset()
// ---------------------------------------------------------------------------
// The clamp caches which polygon the rig is standing on and searches only three hops out
// from it. Move the rig without resetting and the next step is clamped from where the
// player used to be, dragging them back across the map. spawnAt() does the reset, so
// SPAWN, RESPAWN AND EVERY SERVER-DRIVEN TELEPORT GO THROUGH spawnAt() — player/spawn.js
// does, and network.js's applyLocalSpawn must when it is ported (Task 13).
//
// ---------------------------------------------------------------------------
// #view-shake IS GONE
// ---------------------------------------------------------------------------
// index.html needed an extra empty entity under #cam to hold the gun, because
// look-controls rewrote #cam's rotation every frame and ut-jump owned its position.y, so
// a shake written there would have been eaten or baked in. Both of those writers are this
// file now, and it writes the shake to the camera's own local transform and to gunRoot —
// two nodes nothing else touches. There is no third node and no conflict left to avoid.
import * as THREE from "three";
import { GAME_CONFIG } from "../config/game-config.js";
import { ASSETS, attachModel } from "../engine/assets.js";
import { createUtMovement } from "./ut-movement-model.js";
import { createViewShake, DEFAULT_SHAKE } from "./view-shake.js";
import { getWorldColliders } from "../systems/hitscan.js";
import { createPointerLockPrompt } from "./pointer-lock-prompt.js";
import { handleError } from "../utils/error-handler.js";

const MOVEMENT = GAME_CONFIG.MOVEMENT;

// index.html put the camera at "0 1.4 0" under the rig, and GAME_CONFIG.MOVEMENT's scale
// note records the same figure as measured in the running scene.
const EYE_HEIGHT = 1.4;

// A-Frame look-controls' own rate, radians per pixel of movementX/movementY, and its own
// sign (`yawObject.rotation.y += movementX * 0.002 * -1`): the mouse moving right turns
// right, the mouse moving down looks down.
const LOOK_RAD_PER_PX = 0.002;
const PITCH_LIMIT = Math.PI / 2;

// A single-frame vertical shift larger than this is a respawn, not terrain: at the UT99
// ground speed the steepest walkable slope moves the rig well under a metre per frame.
const TELEPORT_THRESHOLD = 3.0;
// groundToFloor(): how far above the navmesh height the floor probe starts (over the
// head of a kerb, under the belly of a bridge), and the window of drawn-floor heights it
// will accept relative to the navmesh. Below: the navmesh's worst measured hang over the
// drawn floor is ~0.5 m on the ramps. Above: a kerb, not a wall.
const FLOOR_PROBE_UP = 1.2;
const FLOOR_BELOW = 0.6;
const FLOOR_ABOVE = 0.35;
const FLOOR_LERP = 25.0;

// character.js's definitions, kept here because weapon-sway (Task 9) reads isMoving and
// speedMps off the player and the character component is only about animation clips.
// The speed is the rig's ACTUAL horizontal movement, not the model's commanded velocity,
// so walking into a wall reads as standing still — which is what the sway wants.
const MOVE_THRESHOLD = 0.2; // m/s; below this a frame's position delta is noise
const SPEED_SMOOTH_LERP = 8.0; // per second

// The material every mesh of the local body wears: it draws, and writes nothing. See
// hideFromCamera(). One instance for all of them — it carries no per-mesh state, and
// skinning comes from `isSkinnedMesh`, not from the material.
const INVISIBLE_BODY_MATERIAL = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false });

const DEFAULTS = {
  enabled: true,
  groundSpeed: MOVEMENT.GROUND_SPEED,
  accel: MOVEMENT.ACCEL,
  decel: MOVEMENT.DECEL,
  airControl: MOVEMENT.AIR_CONTROL,
  jumpVelocity: MOVEMENT.JUMP_VELOCITY,
  gravity: MOVEMENT.GRAVITY,
  // UT99 lets you hold jump and keep hopping rather than demanding a fresh press.
  holdToRepeat: true,
  eyeHeight: EYE_HEIGHT,
  lockPrompt: true,
};

export class PlayerController {
  constructor(game, opts = {}) {
    this.game = game;
    this.data = { ...DEFAULTS, ...opts };

    this.rig = new THREE.Group();
    this.rig.name = "rig";
    this.hop = new THREE.Group();
    this.hop.name = "hop";
    this.soldier = new THREE.Group();
    this.soldier.name = "soldier";
    this.head = new THREE.Group();
    this.head.name = "head";
    this.head.position.y = this.data.eyeHeight;
    this.gunRoot = new THREE.Group();
    this.gunRoot.name = "gun-root";

    this.rig.add(this.hop);
    this.hop.add(this.soldier);
    this.hop.add(this.head);
    this.head.add(game.camera);
    this.head.add(this.gunRoot);

    // The body. Resolves to the loaded root; Task 12's character system attaches to
    // `soldier` and drives the mixer, so nothing here touches animation.
    this.ready = attachModel(this.soldier, ASSETS.soldierModel)
      .then(({ root }) => {
        this.hideFromCamera(root);
        return root;
      })
      // A body that fails to load is a player with no shadow and no third-person mesh,
      // not a player who cannot move — so it is reported and swallowed rather than left
      // as an unhandled rejection with the game running behind it.
      .catch((e) => {
        handleError(e, "player body");
        return null;
      });

    this.model = createUtMovement(this.data);
    this.viewShake = createViewShake();
    this._shakeSettled = true;

    this.yaw = 0;
    this.pitch = 0;

    // ut-jump's state, verbatim.
    this.airborne = false;
    this.verticalSpeed = 0;
    this.offset = 0;
    /** Drawn-floor correction, metres, added beside the hop. See groundToFloor(). */
    this.groundOffset = 0;
    this.lastGroundY = 0;

    // character.js's speed tracking.
    this.speedMps = 0;
    this.rawSpeed = 0;
    this.isMoving = false;
    this.isRunning = false;
    this._prevX = 0;
    this._prevZ = 0;

    // Scratch, allocated once: this all runs every frame.
    this._look = { x: 0, y: 0 };
    this._desired = { x: 0, y: 0, z: 0 };
    this._ray = new THREE.Raycaster();
    this._rayOrigin = new THREE.Vector3();
    this._down = new THREE.Vector3(0, -1, 0);

    this.prompt = this.data.lockPrompt ? createPointerLockPrompt(game) : null;
  }

  /**
   * invisible-to-player: the body draws, and writes nothing.
   *
   * Every mesh of the local body gets one shared material with `colorWrite: false` and
   * `depthWrite: false`. It stays in the opaque pass and is rasterised as usual, but
   * puts nothing in the colour buffer and nothing in the depth buffer, so there is
   * simply no trace of it in the rendered frame.
   *
   * WHY NOT A LAYER. `camera.layers.disable(1)` with the body on layer 1 is the obvious
   * three answer and it is wrong here, because it also removes the body's SHADOW: the
   * shadow pass tests every object against the RENDER camera's layers, not the shadow
   * camera's (WebGLShadowMap.js: `const visible = object.layers.test( camera.layers )`,
   * where `camera` is the one handed to renderer.render), and nothing downstream of that
   * gate — onBeforeShadow, customDepthMaterial — ever runs for an object it rejects. The
   * A-Frame build DID cast the local body's shadow, so a layer would have been a visible
   * regression. `getDepthMaterial` copies only alphaMap/alphaTest/map/side/displacement
   * off the material, none of which this one sets, so the shadow is untouched by the
   * swap. castShadow on, receiveShadow off: nothing can be seen falling on a body that
   * is not drawn.
   *
   * WHY A NEW MATERIAL RATHER THAN EDITING THE MODEL'S. The glTF is loaded once and
   * cloned per instance, and SkeletonUtils.clone/Object3D.clone SHARE materials — every
   * remote avatar wears the same MeshStandardMaterial objects as this body. Editing them
   * in place would make every player on the map invisible.
   *
   * VERIFIED IN THE BROWSER, both pages, by toggling this body's castShadow and
   * diffing the frames: the same shadow appears and disappears on the ground on
   * play.html and on index.html. It takes a probe to see, because the key light as
   * shipped throws no visible shadow ANYWHERE on this map — 330x330 units of ortho
   * frustum over a 933-unit depth range with bias -0.0007 washes out the tower's shadow
   * as thoroughly as the player's. That is scene/lights.js's number, copied from
   * index.html, and identical in both builds; it is not this file's to change.
   *
   * The old component's `depthWrite: false` line (invisible-to-player.js:62-67) was there
   * because opacity 0 still leaves a DEPTH-WRITING mesh wrapped around the camera,
   * stamping near depth over a large moving part of the screen and depth-rejecting every
   * transparent thing sorted behind it — the stars, the atmosphere limb, the coronas.
   * That artefact cannot return here: this material writes nothing at all.
   */
  hideFromCamera(root) {
    root.traverse((o) => {
      if (!o.isMesh) return;
      o.material = INVISIBLE_BODY_MATERIAL;
      o.castShadow = true;
      o.receiveShadow = false;
    });
  }

  // -------------------------------------------------------------------------
  // 1. LOOK
  // -------------------------------------------------------------------------
  /**
   * look-controls' onMouseMove, without the drag path: engine/input.js only accumulates
   * mouse deltas while the pointer is locked, so there is no "hold the button to turn"
   * mode left to support.
   *
   * TOUCH USES THE SAME FACTOR, which is a deliberate small change. A-Frame's touch path
   * (onTouchMove) turned `2 * PI * dx / canvas.clientWidth` and halved it — i.e.
   * PI/clientWidth rad/px, which is exactly 0.002 on a 1571 px wide canvas but 0.0079 on
   * a 400 px phone — it moved YAW ONLY, and it moved it the OTHER WAY (drag right turned
   * left, "drag the world"). engine/input.js already folds touch drag into the same
   * delta accumulator as the mouse, so all three of those differences are gone: a drag
   * turns and pitches at 0.002 rad/px in the mouse's direction, on every screen size.
   */
  updateLook() {
    const look = this.game.input.look(this._look);
    if (look.x !== 0) this.yaw -= look.x * LOOK_RAD_PER_PX;
    if (look.y !== 0) {
      this.pitch -= look.y * LOOK_RAD_PER_PX;
      this.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, this.pitch));
    }
    this.rig.rotation.y = this.yaw;
    this.head.rotation.x = this.pitch;
  }

  // -------------------------------------------------------------------------
  // 2. MOVE, THEN CLAMP
  // -------------------------------------------------------------------------
  updateMove(dt, now) {
    const input = this.game.input.move();
    // The heading, in world xz. movement-controls built this from the camera's full
    // quaternion and then flattened it; with yaw on its own node it is one rotation
    // about Y, which also means looking straight up no longer degenerates the heading
    // to nothing (the flatten-and-renormalise did, at exactly +/-90 degrees of pitch).
    const sin = Math.sin(this.yaw);
    const cos = Math.cos(this.yaw);
    const dirX = input.x * cos + input.z * sin;
    const dirZ = -input.x * sin + input.z * cos;

    const v = this.model.step(dirX, dirZ, this.airborne, dt);

    const position = this.rig.position;
    const desired = this._desired;
    desired.x = position.x + v.x * dt;
    desired.y = position.y;
    desired.z = position.z + v.z * dt;

    const clamp = this.game.navClamp;
    if (clamp) {
      // `out` aliases `from` on purpose and navclamp.js documents why that is safe.
      // Run every frame, not only while moving: the clamp is what keeps the rig's y ON
      // the polygon, which is the y the wire carries.
      clamp.step(position, desired, position, now);
    } else {
      position.x = desired.x;
      position.z = desired.z;
    }
  }

  // -------------------------------------------------------------------------
  // 3. JUMP AND FLOOR
  // -------------------------------------------------------------------------
  jump() {
    if (this.airborne || !this.data.enabled) return;
    this.airborne = true;
    this.verticalSpeed = this.data.jumpVelocity;
    this.game.events.emit("jump", null);
  }

  cancelJump() {
    this.airborne = false;
    this.verticalSpeed = 0;
    this.offset = 0;
  }

  /**
   * STANDING ON THE FLOOR YOU CAN SEE.
   *
   * The rig is clamped to the NAVMESH, and the navmesh is not the floor: it is a coarser
   * surface that sits above the drawn map by 15-21 cm at the spawns and by up to half a
   * metre on the ramps, and below it in places. Bots were moved onto the drawn floor
   * (server/navmesh-surface.js) and the difference showed at once — measured 2026-09-05,
   * the local rig stood 0.209 m above the visible floor while every bot stood on it —
   * which is what "the avatars don't follow the ground the way I do" was.
   *
   * The rig itself cannot be lowered: its y is the wire's y (see the header). So the
   * correction goes where the hop goes — onto the rig's children, eye and body alike —
   * and out on the wire beside it (visualOffset()), so everyone else draws this player
   * standing where they see the floor too.
   *
   * A floor is sought straight down from a little above the navmesh height, and only one
   * within a window is accepted: below by at most FLOOR_BELOW (the navmesh hanging over
   * a dip), above by at most FLOOR_ABOVE (a kerb the navmesh smooths under). Beyond that
   * the map has no floor where the navmesh has one — a shaft, a lift, a hole in the fan
   * model — and the navmesh height stands. Eased at the same rate the server eases bots
   * (GROUND_LERP 25/s) so a step does not pop.
   */
  groundToFloor(dt) {
    const want = this.probeFloor();
    this.groundOffset += (want - this.groundOffset) * (1 - Math.exp(-FLOOR_LERP * dt));
    if (Math.abs(this.groundOffset - want) < 0.001) this.groundOffset = want;
  }

  /**
   * The correction groundToFloor() is easing toward: how far the drawn floor is from the
   * navmesh height under the rig, or 0 where there is no floor in the window (and 0
   * before the map's meshes exist, which is the first few frames after boot).
   *
   * Separate from the easing because a TELEPORT must not ease. spawnAt() snaps the offset
   * to this value: the standing correction is a fifth to half a metre on this map, so
   * easing into it from zero would drop the camera through the floor and climb back over
   * a fifth of a second, on every respawn.
   */
  probeFloor() {
    const meshes = getWorldColliders(this.game);
    if (!meshes.length) return 0;
    const p = this.rig.position;
    this._rayOrigin.set(p.x, p.y + FLOOR_PROBE_UP, p.z);
    this._ray.set(this._rayOrigin, this._down);
    this._ray.far = FLOOR_PROBE_UP + FLOOR_BELOW;
    const hits = this._ray.intersectObjects(meshes, false);
    if (!hits.length) return 0;
    const d = hits[0].point.y - p.y;
    return d >= -FLOOR_BELOW && d <= FLOOR_ABOVE ? d : 0;
  }

  updateJump(dt) {
    // A change larger than any slope could produce in one frame is a respawn or a
    // teleport. Drop the hop rather than letting the camera finish an arc that belongs
    // to where the player used to be.
    const groundY = this.rig.position.y;
    if (Math.abs(groundY - this.lastGroundY) > TELEPORT_THRESHOLD) this.cancelJump();
    this.lastGroundY = groundY;

    // Drained every frame, airborne or not, exactly as ut-jump cleared its `queued` flag
    // at the end of every tick: a press made in mid-air is spent, not banked for landing.
    const pressed = this.game.input.consumeJump();
    if (!this.airborne && (pressed || (this.data.holdToRepeat && this.game.input.jumpHeld))) this.jump();

    this.groundToFloor(dt);

    if (this.airborne) {
      this.verticalSpeed -= this.data.gravity * dt;
      this.offset += this.verticalSpeed * dt;
      if (this.offset <= 0) {
        this.cancelJump();
        this.game.events.emit("land", null);
      }
    }

    this.hop.position.y = this.offset + this.groundOffset;
  }

  /** The hop and the floor correction together: what the eye and the body actually got. */
  visualOffset() {
    return (this.airborne ? this.offset : 0) + this.groundOffset;
  }

  // -------------------------------------------------------------------------
  // 4. VIEW SHAKE
  // -------------------------------------------------------------------------
  /**
   * PlayerPawn.ShakeView, armed by the weapon.
   *
   * @param {{time:number, mag:number, vert:number}} [spec] a weapon manifest's
   *   `view.shake` block; a weapon with none gets Botpack.TournamentWeapon's, which is
   *   what every stock weapon that does not override ShakeView actually uses.
   */
  shake(spec) {
    const s = spec || DEFAULT_SHAKE;
    this.viewShake.shakeView(s.time, s.mag, s.vert);
    this._shakeSettled = false;
  }

  /** Death, respawn, weapon reset: level the view at once. */
  resetShake() {
    this.viewShake.reset();
    this._shakeSettled = false;
  }

  /**
   * The ROLL goes on the camera (so the world tilts) and on gunRoot (so the gun, which
   * hangs off it, tilts by the same amount in world space and therefore does not appear
   * to move on screen at all). The VERTICAL offset goes on the same pair for the same
   * reason. That mirroring is what UE1 gets for free by drawing the view weapon with the
   * player's own ViewRotation applied to it. The aim is NOT touched — that is the entire
   * point; UT99's crosshair does not move when you fire.
   */
  updateShake(dt) {
    this.viewShake.tick(dt);
    const roll = this.viewShake.rollRad();
    const vert = this.viewShake.vertM();

    if (roll === 0 && vert === 0) {
      if (this._shakeSettled) return; // already level; nothing to write
      this._shakeSettled = true;
    } else {
      this._shakeSettled = false;
    }

    const camera = this.game.camera;
    camera.rotation.z = roll;
    camera.position.y = vert;
    this.gunRoot.rotation.z = roll;
    this.gunRoot.position.y = vert;
  }

  // -------------------------------------------------------------------------
  // 5. SPEED, for weapon-sway and the character animation blend
  // -------------------------------------------------------------------------
  updateSpeed(dt) {
    const p = this.rig.position; // the rig is a direct child of the scene: local IS world
    const dx = p.x - this._prevX;
    const dz = p.z - this._prevZ;
    this._prevX = p.x;
    this._prevZ = p.z;

    // Horizontal only. Walking a slope changes the rig's height, and folding that into
    // the measured speed would nudge the walk/run blend on gradient rather than on pace.
    this.rawSpeed = dt > 0 ? Math.hypot(dx, dz) / dt : 0;
    // Position-based, always: an input-based flag stays stuck on when input stops.
    this.isMoving = this.rawSpeed > MOVE_THRESHOLD;
    this.isRunning = this.rawSpeed > MOVEMENT.GROUND_SPEED * 0.53;
    this.speedMps += (this.rawSpeed - this.speedMps) * (1 - Math.exp(-SPEED_SMOOTH_LERP * dt));
  }

  // -------------------------------------------------------------------------
  update(dt, now) {
    if (!this.data.enabled) return;
    this.updateLook();
    this.updateMove(dt, now);
    this.updateJump(dt);
    this.updateShake(dt);
    this.updateSpeed(dt);
  }

  // -------------------------------------------------------------------------
  // SPAWN / TELEPORT
  // -------------------------------------------------------------------------
  /**
   * Put the player somewhere and forget everything about where they were. THE ONLY
   * SUPPORTED WAY to move the rig from outside: it is what resets the navmesh clamp's
   * polygon cache (see the header), the velocity, the hop and the speed tracker, any one
   * of which would otherwise carry a teleport into the next frame as a slingshot, a
   * half-finished jump arc or a 900 m/s reading in the sway.
   *
   * @param {number} x @param {number} y @param {number} z
   * @param {number} [yawRad] leave undefined to keep the current facing
   */
  spawnAt(x, y, z, yawRad) {
    this.rig.position.set(x, y, z);
    if (typeof yawRad === "number") {
      this.yaw = yawRad;
      this.rig.rotation.y = yawRad;
    }
    this.model.reset();
    this.cancelJump();
    // SNAP, do not ease. The old teleport path (network.js applyLocalSpawn -> ut-jump's
    // cancel()) left groundOffset alone entirely, so a respawn kept whatever correction
    // was already applied; zeroing it here dropped the camera by the standing offset
    // (about half a metre in the middle of this map) and eased it back over ~0.2 s on
    // every single respawn. The rig has just been moved, so the probe is taken here,
    // after the position is set.
    this.groundOffset = this.probeFloor();
    this.hop.position.y = this.groundOffset;
    this.lastGroundY = y;
    this._prevX = x;
    this._prevZ = z;
    this.rawSpeed = 0;
    this.speedMps = 0;
    this.isMoving = false;
    this.isRunning = false;
    if (this.game.navClamp) this.game.navClamp.reset();
  }

  /** For probes and for the network layer's spawn yaw. */
  setYaw(yawRad) {
    this.yaw = yawRad;
    this.rig.rotation.y = yawRad;
  }

  setPitch(pitchRad) {
    this.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, pitchRad));
    this.head.rotation.x = this.pitch;
  }

  dispose() {
    if (this.prompt) this.prompt.dispose();
    this.prompt = null;
    // Hand the camera back to the scene, level and centred: the shake's roll and eye
    // lift live on the camera's own local transform (see updateShake), and leaving a
    // half-decayed excursion baked into it would tilt whatever renders next. Its layers
    // are untouched — nothing here has ever changed them, see hideFromCamera.
    const camera = this.game.camera;
    camera.rotation.z = 0;
    camera.position.y = 0;
    if (camera.parent === this.head) this.game.scene.add(camera);
    if (this.rig.parent) this.rig.parent.remove(this.rig);
  }
}
