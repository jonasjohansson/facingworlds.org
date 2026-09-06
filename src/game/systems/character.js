// character.js — the idle/walk/run blend for one animated body.
//
// The A-Frame `character` component drove the LOCAL player's soldier: it measured the
// rig's world speed each tick, turned that into three blend weights, eased them, scaled
// the clips' playback rate to the pace and advanced the mixer. remote-avatar.js carried a
// second, near-identical copy for other players' bodies, differing in exactly one thing:
// its target weights come off the wire (the server sends idle/walk/run per pose) instead
// of being derived from a measured speed, and it interposes UT99's *FR firing twins
// between the eased weights and the actions they are written to.
//
// So this is one class with the two paths kept apart:
//
//   update(dt, speedMps)   the old character.js tick: derive the target from the speed,
//                          blend, cadence, advance. What the local body wants.
//   setTarget(t)           the wire's own idle/walk/run, for a remote body.
//   advanceMixer / blend   the same two steps, callable separately and IN THAT ORDER,
//                          which is the order remote-avatar.js has always used (the
//                          mixer first, so the phase sync inside the fire routing reads
//                          times that are current; the blend after, so this frame's
//                          weights are routed by this frame's fire mix).
//
// It does NOT own a node. The old component pinned its entity to the rig's origin every
// tick and carried a `facingFix` that was computed, stored and then never applied (the
// rotation lines were commented out years ago: the RIG carries the heading). Neither
// survives — the caller owns the body node and its yaw.
import * as THREE from "three";
import { GAME_CONFIG } from "../config/game-config.js";

// Blend references derived from the rig's actual top speed rather than repeated as
// literals. The comments used to claim these matched GAME_CONFIG.MOVEMENT while the
// numbers were hardcoded, so raising GROUND_SPEED would have silently left the run blend
// pinned on again.
const RUN_SPEED = GAME_CONFIG.MOVEMENT.GROUND_SPEED;
const WALK_SPEED = RUN_SPEED * 0.5;
// Where the run blend takes over. server/bots.js and the remote avatars' fallback
// derivation use the same 53% — one number, one place.
const RUN_THRESHOLD = RUN_SPEED * 0.53;
// At arena pace 0.05 m/s is inside the noise floor of a single frame's position delta, so
// the walk blend used to flicker on while standing still.
const MOVE_THRESHOLD = 0.2;

// The three locomotion channels, in the one place both blend paths read them from.
// `weights`, `target`, `actions` and remote-avatars.js's FIRE_VARIANT table are all keyed
// by exactly these three, and blend() and _writeWeights() used to walk them with an
// Object.keys() each — two allocations per body per frame for a list that never changes.
export const CHANNELS = ["Idle", "Walk", "Run"];

export const BLEND = {
  WALK_SPEED,
  RUN_SPEED,
  MOVE_THRESHOLD,
  RUN_THRESHOLD,
};

/**
 * Speed (m/s) -> the three blend weights, as a hard switch. Pure, and the only place the
 * thresholds are read: character.js used to decide this in its tick and remote-avatar.js
 * in `updateAnimationFromState`'s no-animation-block fallback, with the same numbers
 * written out twice (and, before 2026-09-05, wrong in the second copy — a run started at
 * 3 m/s there, 32% of a run, where everything else agreed on 53%).
 *
 * @param {number} speedMps
 * @param {{Idle:number,Walk:number,Run:number}} [out] mutated in place; this runs per
 *   frame per body, so the caller keeps one object.
 */
export function blendTargets(speedMps, out = { Idle: 0, Walk: 0, Run: 0 }, thresholds = BLEND) {
  const s = speedMps > 0 ? speedMps : 0;
  const moving = s > thresholds.MOVE_THRESHOLD;
  const running = s > thresholds.RUN_THRESHOLD;
  out.Idle = moving ? 0 : 1;
  out.Walk = moving && !running ? 1 : 0;
  out.Run = running ? 1 : 0;
  return out;
}

const DEFAULTS = {
  // glTF clip indices, used only when the clip cannot be found by name. Soldier.glb's
  // layout, which is where these numbers come from and the only file they ever fitted.
  idleIdx: 0,
  walkIdx: 3,
  runIdx: 1,
  // Reference speeds for the cadence.
  walkSpeed: WALK_SPEED,
  runSpeed: RUN_SPEED,
  // Animation cadence tuning. runCycleMps is deliberately below runSpeed: the run clip is
  // not authored for a 9.4 m/s stride, so at full pace it plays about 1.55x to keep the
  // feet roughly with the ground instead of skating.
  walkCycleMps: 3.2,
  runCycleMps: 6.0,
  minTimeScale: 0.6,
  maxTimeScale: 1.7,
  // Blend responsiveness (per second; higher = snappier).
  fadeLerp: 10.0,
  // Speed smoothing (per second).
  smoothSpeedLerp: 8.0,
  // Sum the three weights back to 1 after easing. The local body did; a remote body does
  // not, because its weights are split with the firing twins and must not be rescaled
  // mid-crossfade.
  normalize: true,
  // Scale the clips to the pace. Remote bodies never did — the server's own idle/walk/run
  // is already the pose it wants, and their speed is an interpolated estimate.
  cadence: true,
  castShadow: true,
  receiveShadow: true,
};

export class Character {
  /**
   * @param {THREE.Object3D} root the loaded model root (assets.attachModel's `root`)
   * @param {THREE.AnimationClip[]} animations the glTF's clips
   * @param {object} [opts] see DEFAULTS
   */
  constructor(root, animations, opts = {}) {
    this.opts = { ...DEFAULTS, ...opts };
    this.root = root;
    this.clips = animations || [];
    this.mixer = null;
    this.actions = { Idle: null, Walk: null, Run: null };
    this.weights = { Idle: 1, Walk: 0, Run: 0 };
    this.target = { Idle: 1, Walk: 0, Run: 0 };
    this.speedMps = 0;
    this.rawSpeed = 0;
    this.isMoving = false;
    this.isRunning = false;
    // How the eased weights reach the actions. The default writes them straight through;
    // remote-avatars.js replaces it so a channel's weight can be split between its plain
    // clip and its *FR twin. Set with setWriteWeights().
    this._write = null;
    // For measureSpeed(), which is the local body's ground truth.
    this._prev = new THREE.Vector3();
    this._curr = new THREE.Vector3();
    this._seeded = false;

    if (root) {
      root.traverse((o) => {
        if (!o.isMesh) return;
        o.castShadow = this.opts.castShadow;
        o.receiveShadow = this.opts.receiveShadow;
      });
    }
    this._setupAnimations();
  }

  /** A clip by exact (case-insensitive) name, or null. Used for the *FR twins too. */
  clipByName(want) {
    const w = String(want).toLowerCase();
    return this.clips.find((c) => c && c.name && c.name.toLowerCase() === w) || null;
  }

  _setupAnimations() {
    const clips = this.clips;
    if (!clips.length) {
      console.warn("[character] No animations found in model");
      return;
    }
    this.mixer = new THREE.AnimationMixer(this.root);

    // BY NAME FIRST, then the old fixed indices as a fallback.
    //
    // Those indices are Soldier.glb's layout (0 Idle, 3 Walk, 1 Run) and only ever worked
    // for that one file. The UT99 characters in assets/3d/characters carry exactly three
    // clips, in order Idle, Walk, Run — so index 1 is Walk there, and the index-only code
    // would have given every one of them the walk cycle as its run.
    const loose = (want) => clips.find((c) => c && c.name && c.name.toLowerCase().includes(want));
    const { idleIdx, walkIdx, runIdx } = this.opts;
    const idleClip = this.clipByName("idle") || clips[idleIdx] || loose("idle");
    const walkClip = this.clipByName("walk") || clips[walkIdx] || loose("walk");
    const runClip = this.clipByName("run") || clips[runIdx] || loose("run");

    if (!idleClip || !walkClip || !runClip) {
      console.warn(
        "[character] Missing required animation clips. Found:",
        clips.map((c) => c && c.name)
      );
      // Whatever is there, aliased: a one-clip model then idles for ever rather than
      // throwing, which is what the A-Frame components both did.
      this.actions.Idle = this.mixer.clipAction(clips[0]);
      this.actions.Walk = clips[1] ? this.mixer.clipAction(clips[1]) : this.actions.Idle;
      this.actions.Run = clips[2] ? this.mixer.clipAction(clips[2]) : this.actions.Idle;
    } else {
      this.actions.Idle = this.mixer.clipAction(idleClip);
      this.actions.Walk = this.mixer.clipAction(walkClip);
      this.actions.Run = this.mixer.clipAction(runClip);
    }

    for (const action of Object.values(this.actions)) {
      action.setLoop(THREE.LoopRepeat, Infinity);
      action.enabled = true;
      action.setEffectiveTimeScale(1);
    }
    this.actions.Idle.setEffectiveWeight(1);
    this.actions.Walk.setEffectiveWeight(0);
    this.actions.Run.setEffectiveWeight(0);
    this.actions.Idle.play();
    this.actions.Walk.play();
    this.actions.Run.play();
  }

  get ready() {
    return !!(this.mixer && this.actions.Idle);
  }

  /**
   * Replace how eased weights reach the actions.
   * @param {(actions, weights) => void} fn
   */
  setWriteWeights(fn) {
    this._write = fn;
  }

  /** The wire's own idle/walk/run for this frame (remote bodies). */
  setTarget(t) {
    this.target.Idle = t.Idle || 0;
    this.target.Walk = t.Walk || 0;
    this.target.Run = t.Run || 0;
  }

  /**
   * Horizontal world speed of `node` since the last call, in m/s — the position-based
   * ground truth the old component used. Horizontal only: walking a slope changes the
   * rig's height, and folding that into the measured speed would nudge the walk/run blend
   * on gradient rather than on pace.
   */
  measureSpeed(node, dt) {
    node.getWorldPosition(this._curr);
    if (!this._seeded) {
      this._prev.copy(this._curr);
      this._seeded = true;
      return 0;
    }
    const dx = this._curr.x - this._prev.x;
    const dz = this._curr.z - this._prev.z;
    this._prev.copy(this._curr);
    return dt > 0 ? Math.hypot(dx, dz) / dt : 0;
  }

  /** Forget the last sample — after a teleport, so a respawn is not a 200 m/s sprint. */
  resetSpeed() {
    this._seeded = false;
    this.speedMps = 0;
    this.rawSpeed = 0;
  }

  /** Ease this frame's weights toward the target and write them to the actions. */
  blend(dt) {
    if (!this.ready) return;
    const damp = 1 - Math.exp(-this.opts.fadeLerp * dt);
    for (let i = 0; i < CHANNELS.length; i++) {
      const key = CHANNELS[i];
      if (!this.actions[key] || this.target[key] === undefined) continue;
      this.weights[key] += (this.target[key] - this.weights[key]) * damp;
    }
    if (this.opts.normalize) {
      let sum = 0;
      for (let i = 0; i < CHANNELS.length; i++) sum += this.weights[CHANNELS[i]];
      if (sum > 1e-6) {
        const inv = 1 / sum;
        for (let i = 0; i < CHANNELS.length; i++) this.weights[CHANNELS[i]] *= inv;
      }
    }
    if (this._write) this._write(this.actions, this.weights);
    else {
      for (let i = 0; i < CHANNELS.length; i++) {
        this.actions[CHANNELS[i]].setEffectiveWeight(this.weights[CHANNELS[i]]);
      }
    }
  }

  /** Advance the clips. `dt` in seconds. */
  advanceMixer(dt) {
    if (this.mixer) this.mixer.update(dt);
  }

  /** Scale playback to the pace, off whichever cycle the body is heading for. */
  _updateCadence() {
    const { minTimeScale, maxTimeScale, walkCycleMps, runCycleMps } = this.opts;
    const ref = this.target.Run > this.target.Walk ? runCycleMps : walkCycleMps;
    let scale = 1.0;
    if (ref > 1e-6) scale = Math.max(0.001, this.speedMps) / ref;
    scale = Math.min(maxTimeScale, Math.max(minTimeScale, scale));
    for (const action of Object.values(this.actions)) if (action) action.setEffectiveTimeScale(scale);
  }

  /**
   * The local body's whole frame: speed in, pose out. `speedMps` is measured by the
   * caller (measureSpeed() does it the way the old tick did).
   */
  update(dt, speedMps) {
    if (!this.ready) return;
    if (!Number.isFinite(dt) || dt <= 0) return;

    if (Number.isFinite(speedMps)) {
      this.rawSpeed = speedMps;
      this.isMoving = speedMps > BLEND.MOVE_THRESHOLD;
      this.isRunning = speedMps > BLEND.RUN_THRESHOLD;
      blendTargets(speedMps, this.target);
    }

    this.blend(dt);

    // Smoothed speed for the cadence and for anything reading speedMps (weapon-sway).
    const spDamp = 1 - Math.exp(-this.opts.smoothSpeedLerp * dt);
    this.speedMps += (this.rawSpeed - this.speedMps) * spDamp;
    if (this.opts.cadence) this._updateCadence();

    this.advanceMixer(dt);
  }

  dispose() {
    if (!this.mixer) return;
    this.mixer.stopAllAction();
    if (this.root) this.mixer.uncacheRoot(this.root);
    this.mixer = null;
    this.actions = { Idle: null, Walk: null, Run: null };
  }
}
