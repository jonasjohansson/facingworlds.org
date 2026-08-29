// ut-movement.js — UT99-flavoured ground movement and jump layered onto the
// aframe-extras rig. Nothing here replaces movement-controls; it plugs into it.
//
// HOW IT HOOKS IN
// movement-controls walks its `controls` list every frame and keeps the first component
// whose isVelocityActive() returns true. When that component exposes getVelocity() (rather
// than getVelocityDelta()) it copies the returned vector straight into its own velocity and
// returns early — before the per-control `speed` multiplier and before the `fly:false`
// clamp. Registering "ut" as the first entry in that list therefore hands us ownership of
// acceleration, top speed, diagonal handling and air control, while the rig keeps
// constrainToNavMesh for collision. See assets/libraries/aframe-extras.min.js,
// movement-controls updateVelocityCtrl/updateVelocity.
//
// SCALE
// Measured in the running scene: the soldier model is 1.83 m tall. A UT99 pawn is 78 UU
// tall, so 1 UU ≈ 0.0235 m and the UT99 Pawn defaults convert as:
//   GroundSpeed 400 UU/s -> 9.4 m/s   AccelRate 2048 UU/s^2 -> 48 m/s^2
//   JumpZ       350 UU/s -> 8.2 m/s   ZoneGravity -950 UU/s^2 -> -22.3 m/s^2
//   AirControl  0.18 — deliberately NOT a converted constant. UT99 ships 0.05 and
//               UT2004 ~0.35; 0.18 was picked by sweeping it in the running scene.
//               See GAME_CONFIG.MOVEMENT.AIR_CONTROL for the measurements.
import { GAME_CONFIG } from "../../config/game-config.js";

const MOVEMENT = GAME_CONFIG.MOVEMENT;

// A single-frame vertical shift larger than this is a respawn, not terrain: at the UT99
// ground speed the steepest walkable slope moves the rig well under a metre per frame.
const TELEPORT_THRESHOLD = 3.0;

// Velocity provider. Registered as "ut-controls" so movement-controls can find it from the
// bare name "ut" in its controls list.
AFRAME.registerComponent("ut-controls", {
  schema: {
    enabled: { type: "boolean", default: true },
    // Top ground speed, metres per second.
    groundSpeed: { type: "number", default: MOVEMENT.GROUND_SPEED },
    // How hard we chase the commanded velocity, m/s^2. Also governs how fast a turn or a
    // reversal bites, since we accelerate toward the target vector rather than along input.
    accel: { type: "number", default: MOVEMENT.ACCEL },
    // Ground deceleration once input stops, m/s^2.
    decel: { type: "number", default: MOVEMENT.DECEL },
    // Fraction of `accel` available while airborne. Well under 1 on purpose: it is what
    // keeps a jump a committed decision rather than a second steering mode. See header.
    airControl: { type: "number", default: MOVEMENT.AIR_CONTROL },
  },

  init() {
    const T = AFRAME.THREE;
    this.velocity = new T.Vector3();
    this.input = new T.Vector3();
    this.dir = new T.Vector3();
    this.desired = new T.Vector3();
    this.delta = new T.Vector3();
    this.headingQuat = new T.Quaternion();
    this.lastTime = 0;
  },

  // Reads every input source we own into a unit-or-shorter vector in rig-local space.
  // Diagonals are normalised: UT99 has one ground speed, whereas the stock controls scale
  // by the raw key vector length and so run 1.41x faster on a diagonal.
  readInput() {
    const input = this.input.set(0, 0, 0);

    const keyboard = this.el.components["keyboard-controls"];
    if (keyboard && keyboard.data.enabled) {
      const keys = keyboard.getKeys();
      if (keys.KeyW || keys.ArrowUp) input.z -= 1;
      if (keys.KeyS || keys.ArrowDown) input.z += 1;
      if (keys.KeyA || keys.ArrowLeft) input.x -= 1;
      if (keys.KeyD || keys.ArrowRight) input.x += 1;
    }

    // aframe-extras touch-controls is the single owner of touch movement: one finger walks
    // forward (direction -1), two fingers back (direction +1), which is what the on-screen
    // credit text promises. We fold its state in here so touch and keyboard share this
    // acceleration model instead of running on movement-controls' own speed multiplier.
    const touch = this.el.components["touch-controls"];
    if (touch && touch.data.enabled && touch.direction) input.z += touch.direction;

    if (input.lengthSq() > 1) input.normalize();
    return input;
  },

  isVelocityActive() {
    const active = this.data.enabled && (this.readInput().lengthSq() > 0 || this.velocity.lengthSq() > 1e-4);
    // Drop the clock whenever we are not the active controller. movement-controls only
    // calls getVelocity() while we ARE, so otherwise lastTime keeps the timestamp of the
    // last frame we moved: stand still for a second, press W, and the first step is the
    // whole idle gap clamped to 1/20 s — 48 m/s^2 * 0.05 s put the rig at 2.4 m/s in one
    // frame instead of 0.8. Zeroing it here makes the next getVelocity() fall back to the
    // 1/60 default and start the ramp from rest, where it belongs.
    if (!active) this.lastTime = 0;
    // Stay the active controller while we still have speed to bleed off, otherwise
    // movement-controls would hand back to keyboard-controls mid-stop and snap us dead.
    return active;
  },

  // movement-controls calls this once per frame from its own tick and passes no delta, so
  // we keep our own clock. The clamp covers tab-throttled frames.
  getVelocity() {
    const now = performance.now();
    const raw = this.lastTime ? (now - this.lastTime) / 1000 : 1 / 60;
    this.lastTime = now;
    this.step(Math.min(Math.max(raw, 1 / 240), 1 / 20));
    return this.velocity;
  },

  step(dt) {
    const data = this.data;
    const velocity = this.velocity;
    const input = this.readInput();
    const jump = this.el.components["ut-jump"];
    const airborne = !!(jump && jump.airborne);

    if (input.lengthSq() > 0) {
      // Same heading maths movement-controls uses: camera orientation, then the rig's.
      const camera = this.camera();
      if (camera) {
        this.headingQuat.copy(camera.object3D.quaternion).premultiply(this.el.object3D.quaternion);
        this.dir.copy(input).applyQuaternion(this.headingQuat);
      } else {
        this.dir.copy(input).applyQuaternion(this.el.object3D.quaternion);
      }
      this.dir.y = 0;
      if (this.dir.lengthSq() > 1e-8) this.dir.normalize();
      this.desired.copy(this.dir).multiplyScalar(data.groundSpeed);
      this.approach(velocity, this.desired, (airborne ? data.accel * data.airControl : data.accel) * dt);
    } else if (!airborne) {
      this.desired.set(0, 0, 0);
      this.approach(velocity, this.desired, data.decel * dt);
    }
    // Airborne with no input keeps its momentum untouched — that is the committed arc.

    // Horizontal only. fly:false makes movement-controls zero this anyway, and the hop
    // is not a velocity at all — ut-jump raises the rig's children, never the rig.
    velocity.y = 0;
  },

  // Move `velocity` toward `target` by at most `maxStep` metres per second.
  approach(velocity, target, maxStep) {
    const delta = this.delta.subVectors(target, velocity);
    const distance = delta.length();
    if (distance <= maxStep || distance < 1e-6) velocity.copy(target);
    else velocity.addScaledVector(delta, maxStep / distance);
  },

  camera() {
    const movement = this.el.components["movement-controls"];
    if (movement && movement.data.camera) return movement.data.camera;
    return this.el.querySelector("[camera]");
  },
});

// Vertical layer.
//
// WHY THE HOP IS NOT ON THE RIG
// The obvious implementation — add the hop height to the rig's own position.y — is wrong
// here, and measurably so. movement-controls with constrainToNavMesh feeds the rig's
// current position to three-pathfinding's clampStep as the start of every step. clampStep
// assumes that point lies ON the navmesh; lift it and the containing polygon lookup fails,
// so the step gets clamped against an arbitrary neighbouring polygon and the rig is flung
// sideways. Measured in the running scene, holding the rig at a fixed height above the
// navmesh and walking forward at a steady 9.4 m/s:
//     lift 0.0 m -> 5.0 m/s      lift 1.0 m ->  4.4 m/s (peak  6.2)
//     lift 0.5 m -> 1.4 m/s      lift 1.5 m -> 12.4 m/s (peak 43.5)
//                                lift 2.0 m -> 13.6 m/s (peak 55.2)
// A 1.5 m UT99 jump therefore teleported the player across the rock. So the rig stays on
// the navmesh where clampStep needs it, and the hop is applied to the rig's CHILDREN — the
// camera and the soldier body — which is what anyone actually sees. Collision, pathing and
// the navmesh clamp are untouched by a jump, and the first-person view and the third-person
// model both rise together.
//
// WHAT THAT COSTS, PLAINLY
// This is a hop in place, not a traversal move. You cannot jump ACROSS a gap in the
// navmesh: your feet are still clamped to the walkable surface, so you rise, drift to the
// edge, and come back down inside it. Clearing a hole would mean leaving the navmesh
// constraint mid-air and running a real collision query against the world geometry to land
// again — i.e. the custom controller with its own capsule sweep that is explicitly out of
// scope this round. What is here is honest for its purpose: it gives the jump's timing,
// height and committed low-air-control arc, which is what dodging fire in UT99 feels like,
// without pretending to a collision model it does not have.
//
// Attaching this component after the scene has loaded puts its tick behind
// movement-controls' in the behaviour list, so the ground height it reads each frame is
// already the navmesh-clamped one.
AFRAME.registerComponent("ut-jump", {
  schema: {
    enabled: { type: "boolean", default: true },
    jumpVelocity: { type: "number", default: MOVEMENT.JUMP_VELOCITY },
    gravity: { type: "number", default: MOVEMENT.GRAVITY },
    // UT99 lets you hold jump and keep hopping rather than demanding a fresh press.
    holdToRepeat: { type: "boolean", default: true },
  },

  init() {
    this.airborne = false;
    this.verticalSpeed = 0;
    this.offset = 0;
    this.keyHeld = false;
    this.queued = false;
    // { object3D, baseY } for each direct child of the rig, so a hop can be added to and
    // removed from their authored local heights without accumulating drift.
    this.hopTargets = [];
    this.childCount = -1;
    this.lastGroundY = this.el.object3D.position.y;

    this.onKeyDown = (event) => {
      if (event.code !== "Space" || event.repeat) return;
      if (!AFRAME.utils.shouldCaptureKeyEvent(event)) return;
      event.preventDefault(); // Space scrolls the page otherwise.
      this.keyHeld = true;
      this.queued = true;
    };
    this.onKeyUp = (event) => {
      if (event.code === "Space") this.keyHeld = false;
    };
    this.onBlur = () => {
      this.keyHeld = false;
      this.queued = false;
    };
  },

  play() {
    window.addEventListener("keydown", this.onKeyDown, false);
    window.addEventListener("keyup", this.onKeyUp, false);
    window.addEventListener("blur", this.onBlur, false);
  },

  pause() {
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
    window.removeEventListener("blur", this.onBlur);
    this.onBlur();
  },

  remove() {
    this.pause();
    this.cancel();
    this.restoreTargets();
  },

  // Re-reads the rig's children and their rest heights. Existing targets are put back on
  // the ground first so a refresh mid-hop cannot bake the current offset into a baseY.
  refreshTargets() {
    this.restoreTargets();
    this.hopTargets.length = 0;
    const children = this.el.children;
    for (let i = 0; i < children.length; i++) {
      const object3D = children[i].object3D;
      if (object3D) this.hopTargets.push({ object3D, baseY: object3D.position.y });
    }
    this.childCount = children.length;
  },

  restoreTargets() {
    for (let i = 0; i < this.hopTargets.length; i++) {
      const target = this.hopTargets[i];
      target.object3D.position.y = target.baseY;
    }
  },

  applyTargets() {
    for (let i = 0; i < this.hopTargets.length; i++) {
      const target = this.hopTargets[i];
      target.object3D.position.y = target.baseY + this.offset;
    }
  },

  cancel() {
    this.airborne = false;
    this.verticalSpeed = 0;
    this.offset = 0;
  },

  jump() {
    if (this.airborne || !this.data.enabled) return;
    this.airborne = true;
    this.verticalSpeed = this.data.jumpVelocity;
    this.el.emit("jump", null, false);
  },

  tick(time, timeDelta) {
    if (!this.data.enabled) return;
    if (this.el.children.length !== this.childCount) this.refreshTargets();

    // The rig's height is entirely movement-controls' business now, so a change larger than
    // any slope could produce in one frame is a respawn or a teleport. Drop the hop rather
    // than letting the camera finish an arc that belongs to where the player used to be.
    const groundY = this.el.object3D.position.y;
    if (Math.abs(groundY - this.lastGroundY) > TELEPORT_THRESHOLD) this.cancel();
    this.lastGroundY = groundY;

    if (!this.airborne && (this.queued || (this.data.holdToRepeat && this.keyHeld))) this.jump();
    this.queued = false;

    if (this.airborne) {
      const dt = Math.min(Math.max((timeDelta || 0) / 1000, 0), 1 / 20);
      this.verticalSpeed -= this.data.gravity * dt;
      this.offset += this.verticalSpeed * dt;
      if (this.offset <= 0) {
        this.cancel();
        this.el.emit("land", null, false);
      }
    }

    this.applyTargets();
  },
});
