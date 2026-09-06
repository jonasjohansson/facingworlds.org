// remote-avatars.js — other players' bodies: pose, animation, the gun in the hand.
//
// Remote poses arrive every 50–100ms over the network. Applying them raw makes other
// players teleport, so instead we buffer incoming snapshots and render the avatar a
// fixed amount of time IN THE PAST (INTERP_DELAY). At any render frame there are then
// two snapshots bracketing the render time and we interpolate between them, which
// turns a 10–20Hz packet stream into smooth 60Hz motion.
//
// The buffering/interpolation math itself lives in src/shared/net/interpolation.js so
// the AR spectator view renders the same players with the same behaviour instead of
// growing a second copy that re-acquires the teleporting this one already fixed. This
// file owns the rest: the animation mixer, the residual visual smoothing, the floor
// correction, the held weapon and writing the result onto the rig.
//
// TWO CLASSES. `RemoteAvatar` is one player's body — what the `remote-avatar` component
// was, one per <a-entity>. `RemoteAvatars` is the registry that replaces
// `document.querySelectorAll(".avatar")` and `rig.querySelector("[remote-avatar]")`: it
// owns the map from player id to body, ticks them all in one loop, routes the three scene
// events that used to be filtered by every instance separately, and hands hitscan the
// list of hit volumes.
import * as THREE from "three";
import { getWorldColliders } from "./hitscan.js";
import { SnapshotBuffer, lerpYaw } from "../../shared/net/interpolation.js";
import { GAME_CONFIG } from "../config/game-config.js";
import { fireState, pickFireClip } from "./remote-fire-state.js";
import { DEFAULT_WEAPON, weapon } from "../../shared/weapons.js";
import { modelUrl, skinUrls, modelYaw, weaponOffset } from "../../shared/characters.js";
import { ASSETS, attachModel } from "../engine/assets.js";
import { blendTargets, CHANNELS, Character } from "./character.js";
import { Health } from "./health.js";
import { makeLabelSprite, updateLabelSprite, disposeLabelSprite } from "./label.js";

// ---------------------------------------------------------------------------
// WHAT THEY ARE HOLDING, AND WHAT THEY DO WITH IT
// ---------------------------------------------------------------------------
// Two things a UT99 TournamentPlayer does that this used to skip entirely.
//
// THE WEAPON IN THE HAND. Every pawn carries its current weapon's third-person mesh —
// the Enforcer's is called AutoHand — and until now a remote player here ran around the
// map empty-handed while shooting people. weapons.js ships a `third` block per weapon:
// a glTF already in the CHARACTER's frame (forward -Z, up +Y, feet at y = 0, positioned
// where the pawn's hand is), so it goes on as a plain child of the body node at the
// identity transform and needs no fitting. It is a child of the BODY, not of the rig,
// because the body carries modelYaw and the rig's rotation is overwritten from the wire.
//
// THE FIRING POSE. UT99 has no additive fire animation. It has a second complete set of
// locomotion sequences authored with the weapon levelled, suffixed FR, and PlayFiring
// writes 'RunSMFR' straight over 'RunSM' at the frame it had reached; a pawn standing
// still gets PlayRecoil, an 8 frame one-shot, instead. So the FR clips here are not a
// fourth blend weight — they are ALTERNATES that the existing Walk/Run weights drive,
// swapped by a crossfade with the phase carried across so the legs do not skip a step.
// See remote-fire-state.js for when, and _writeWeights below for how.
//
// Everything in here degrades: a character glTF with only Idle/Walk/Run animates exactly
// as it did before, a weapon with no `third` block leaves the hands empty, and a `third`
// with no `anims` simply does not animate the gun.

// ---------------------------------------------------------------------------
// FEET ON THE FLOOR YOU CAN SEE
// ---------------------------------------------------------------------------
// The height on the wire is the server's idea of the ground: the drawn floor where its
// standing surface has one, the navmesh where it does not (holes in the fan map, the
// lift shafts), and in between two 20 Hz ticks a straight line across whatever the
// ground does. Measured 2026-09-05 over 19,000 bot frames against the map the viewer
// actually sees: median 4 mm off, but 11.6% more than 5 cm above it and 5.9% more than
// 20 cm off either way — a body hanging over a ramp edge, a body waist-deep at a kerb.
//
// So the LAST word on a remote body's height is this client's own floor, exactly as the
// local player's is (player/controller.js groundToFloor): probe straight down from a
// little above the wire height, accept a floor inside the same window, ease onto it at
// the same rate. Outside the window the wire height stands — a jump is a jump, and a
// shaft is a shaft.
//
// WHERE IT IS APPLIED changed with the node graph and the behaviour did not. The A-Frame
// body was one entity under one rig and the offset went on the RIG, so the hit capsule
// (hitscan read the rig's world position as the feet) followed the body a player is
// aiming at. Here the rig is the WIRE pose, untouched, and the offset is the body node's
// own y — so `bodies()` below hands hitscan the BODY, whose world position is the same
// ground-corrected point the old rig's was. The server tolerates half a metre of body
// slack on a claimed hit, which is more than this window can move anything.
const FLOOR_PROBE_UP = 1.2;
const FLOOR_BELOW = 0.6;
const FLOOR_ABOVE = 0.35;
const FLOOR_LERP = 25.0;
const _ray = new THREE.Raycaster();
const _origin = new THREE.Vector3();
const _down = new THREE.Vector3(0, -1, 0);

// One buffer per avatar, so it tracks exactly one entity.
const SELF = "self";

// ---- team tint ----------------------------------------------------------------
// In CTF you have to read friend from foe at Facing Worlds' distances — across the
// bridge that is 40+ metres of the same soldier model. GAME_CONFIG.TEAMS carries the
// palette; the fallbacks below keep this file standalone-safe if it is ever loaded
// without that block (it then still tints, rather than silently doing nothing).
const TEAM_CFG = GAME_CONFIG.TEAMS || {};
const TEAM_COLORS = {
  red: TEAM_CFG.RED || "#ff3a22",
  blue: TEAM_CFG.BLUE || "#2f86ff",
};
const EMISSIVE_STRENGTH = typeof TEAM_CFG.EMISSIVE_STRENGTH === "number" ? TEAM_CFG.EMISSIVE_STRENGTH : 0.45;
// DISABLED in the game view. Jonas: "i dont need the player avatars character tinted".
// The team still reaches the avatar (scoreboard, name labels, future outlines) and the AR
// page keeps its own tint — spectators need to tell teams apart from across a room; a
// player reads the map instead. Kept rather than deleted because the decision is a taste
// call that has been reversed once already.
const TEAM_TINT_ENABLED = false;

// ---- firing ---------------------------------------------------------------------
// Same standalone-safe pattern as the team block: the numbers live in game-config, and
// the fallbacks here are the same values so this keeps working if it is ever loaded
// without that block rather than quietly never animating a shot.
const FIRE_CFG = GAME_CONFIG.REMOTE_FIRE || {};
const FIRE_HOLD_MS = typeof FIRE_CFG.HOLD_MS === "number" ? FIRE_CFG.HOLD_MS : 500;
const FIRE_CROSSFADE = typeof FIRE_CFG.CROSSFADE === "number" ? FIRE_CFG.CROSSFADE : 0.05;
const STANDING_IDLE_WEIGHT = typeof FIRE_CFG.STANDING_IDLE_WEIGHT === "number" ? FIRE_CFG.STANDING_IDLE_WEIGHT : 0.5;

// The clip each locomotion channel swaps to while the trigger is down. Idle -> Fire is
// UT99's PlayRecoil over the standing pose; the other two are the *FR twins. A name
// missing from the glTF simply leaves that channel unswapped. Keyed by CHANNELS, which is
// what everything below iterates — the table is looked up, never walked.
const FIRE_VARIANT = { Idle: "Fire", Walk: "WalkFire", Run: "RunFire" };

const DEFAULTS = {
  enabled: true,
  // How far in the past to render, in ms. One-and-a-bit packet intervals of slack.
  delay: 100,
  // Residual visual smoothing applied on top of the interpolation (per 16.67ms frame).
  // Absorbs the small pops caused by extrapolation and by snapshots arriving late.
  smoothing: 0.35,
  // Name plates over the heads. OFF, because the A-Frame game never drew them: the only
  // world-space text over a body was health.js's number. The AR spectator view draws
  // names with its own canvas code (src/ar/three/players.js, drawLabel); this one uses
  // label.js, the sprite health.js already draws with, so turning names on here is one
  // flag rather than a second copy of that code.
  showNames: false,
  nameY: 2.6,
};

const _v = new THREE.Vector3();
const EMPTY = [];

export class RemoteAvatar {
  /**
   * @param {object} game
   * @param {object} p the server's publicPlayer payload: {id, name, hp, x, y, z, ry,
   *   speed, animation, dual, weapon, team, character}
   * @param {RemoteAvatars} owner the registry (world colliders, name visibility)
   */
  constructor(game, p, owner) {
    this.game = game;
    this.owner = owner;
    this.opts = { ...DEFAULTS, ...(owner ? owner.opts : null) };
    this.id = p.id;
    this.enabled = this.opts.enabled;

    // ---- what used to be data-* on the rig ----
    // network.js wrote these as attributes so the component could read them back off the
    // DOM. They are fields now, and the character-derived ones (model, skin, yaw, hand
    // offset) are resolved HERE from the character index rather than in network.js: the
    // index is the wire fact, everything else is a lookup in src/shared/characters.js.
    this.name = p.name || "";
    this.team = p.team || null;
    this.character = typeof p.character === "number" ? p.character : 0;
    this.weaponId = p.weapon || DEFAULT_WEAPON;
    this.dual = !!p.dual;
    this.skins = Array.isArray(p.skin) ? p.skin : skinUrls(this.character);
    // Where THIS body's gun hand is. UE1 pawn meshes carry three "special" vertices — the
    // weapon triangle — that mark where the carried weapon is drawn, and every
    // third-person weapon glTF was built at the nominal pawn origin instead;
    // characters.js ships the difference per model as a vector (the soldier's is 16 cm
    // right, 42 cm up, 43 cm forward of that origin). The STATIC fallback only:
    // _followWeaponAnchor overwrites it every frame once the body's anchor node is found.
    this.weaponOffsetM = weaponOffset(this.character) || [0, 0, 0];

    // ---- the node graph ----
    //   rig    the WIRE pose: position and yaw straight off the snapshot, nothing else.
    //   body   the drawn body: modelYaw (five of the 23 variants are authored 90 degrees
    //          off the rest) and the floor correction. The model, the weapon slots and
    //          the labels all hang here, so they all move with it.
    this.rig = new THREE.Group();
    this.rig.name = `remote-rig-${p.id}`;
    this.rig.userData.playerId = p.id;
    this.body = new THREE.Group();
    this.body.name = "body";
    const yaw = modelYaw(this.character);
    if (yaw) this.body.rotation.y = (yaw * Math.PI) / 180;
    this.rig.add(this.body);
    if (Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z)) {
      this.rig.position.set(p.x, p.y, p.z);
    }
    if (game) game.attach(this.rig, "remote-avatar", this);

    this.lastPosition = { x: this.rig.position.x, y: this.rig.position.y, z: this.rig.position.z };
    this.lastRotation = 0;
    this.currentSpeed = 0;

    // Target values produced by the interpolator, consumed by the visual smoothing
    this.targetPosition = { x: this.lastPosition.x, y: this.lastPosition.y, z: this.lastPosition.z };
    this.targetRotation = 0;
    this.targetSpeed = 0;
    this.groundOffset = 0;

    // ---- interpolation buffer ----
    // maxExtrapolationMs matches the old inline cap (delay + 20): remote players stop
    // sending poses when they stand still, so open ended extrapolation would slide an
    // idle avatar across the map.
    this.buffer = new SnapshotBuffer({
      delayMs: this.opts.delay,
      maxExtrapolationMs: this.opts.delay + 20,
    });

    // ---- team tint ----
    // Materials we swapped in, so dispose() can put the originals back and free ours.
    this._tinted = [];
    this._tintedTeam = null;
    // Materials cloned to double-side the MIRRORED gun; ours to free.
    this._mirroredMaterials = [];

    // ---- skin ----
    // Textures loaded for this body, so dispose() can free them. Each UT99 model is one
    // glTF with a material slot per skin texture; the variant the server picked decides
    // which set of textures goes onto those slots.
    this._skinTextures = [];

    // ---- animation ----
    // The Character instance appears with the model; until then the wire's own
    // idle/walk/run lands in `target` and is handed over when it does.
    this.char = null;
    this.target = { Idle: 1, Walk: 0, Run: 0 };

    // ---- firing ----
    // The FR twin of each channel's clip, or null where the glTF does not carry one.
    // Never a fourth weight: `fireMix` says how far each channel has crossfaded from its
    // plain clip to its twin, and both are then fed the SAME channel weight, split.
    this.fireActions = { Idle: null, Walk: null, Run: null };
    this.fireMix = 0;
    // performance.now() of this player's last two shots. The gap between them is what
    // picks the Enforcer's 'shot2' over its 'Shoot', exactly as UT99 does.
    this._lastShot = 0;
    this._prevShot = 0;
    // PlayRecoil is called at the MOMENT of a shot and only for a pawn that is standing.
    // A pawn that fired mid-run and then stopped must not have the recoil fade in under
    // it half a second later, so the routing asks this rather than re-deciding per frame.
    this._recoilActive = false;
    // Reused across frames: an action can be the target of more than one channel once a
    // missing clip makes a channel fall back to its plain twin, so the weights are summed
    // here before any of them is written. Allocated once — this runs every frame, per body.
    this._actionWeights = new Map();
    this._writeWeights = this._writeWeights.bind(this);

    // ---- the weapon in the hand ----
    // Slot 0 is the weapon; slot 1 exists only while dual-wielding and is the same mesh
    // mirrored across the body's X. Slots are reused across weapon changes — a swap is a
    // new attachModel on the same node, the way first-person-weapon.js dresses a slot.
    this._weaponSlots = [];
    this._weaponId = null;
    this._weaponDual = null;
    // True while a held mesh's fire clip is LOOPING (Shock, Ripper) rather than one-shot.
    this._weaponLooping = false;
    // undefined: not looked up yet. null: looked up, this body has no anchor node.
    this._anchor = undefined;

    // ---- overhead readouts ----
    this.health = new Health(game, this.body, {
      max: 100,
      current: Number.isFinite(p.hp) ? p.hp : 100,
      local: false,
    });
    this.nameLabel = null;
    if (this._namesVisible() && this.name) this._ensureNameLabel();

    // ---- the model ----
    // WHERE THE MODEL-LOADED GUARD WENT. The A-Frame component listened for
    // `model-loaded` and had to check `evt.target === this.el`, because A-Frame events
    // BUBBLE and the held weapon was a child entity with its own gltf-model: its
    // model-loaded arrived at the body too, rebuilt the body's mixer over the same morph
    // targets, re-ran the skin and the tint — six times a spawn, once per gun that loaded
    // — and warned "no animations" when the gun landed before the body did. There is no
    // event and no bubbling now: attachModel resolves with THIS node's root, and each
    // weapon slot's load is a separate promise that touches nothing but its own slot.
    const url = modelUrl(this.character) || ASSETS.soldierModel;
    this.ready = attachModel(this.body, url)
      .then(({ root, animations }) => {
        if (this.disposed) return;
        this._anchor = undefined; // looked up again against the new body
        this.char = new Character(root, animations, {
          // The wire carries the pose; nothing here derives it from a speed, and nothing
          // rescales the clips to a pace this client only estimates.
          normalize: false,
          cadence: false,
        });
        this.char.setWriteWeights(this._writeWeights);
        this.char.setTarget(this.target);
        this._setupFireVariants();
        // Skin before tint: applyTeamTint clones whatever material is on the mesh, so
        // the texture has to be in place first or the clone carries the wrong one.
        this.applySkin();
        this.applyTeamTint();
      })
      .catch((err) => console.warn(`[remote-avatar] model failed for ${this.id}:`, err && err.message));

    // The hands are dressed now rather than after the body loads: the weapon is a sibling
    // of the body mesh, not something hung on it, so it does not have to wait. If there
    // is no weapon yet the slots stay hidden and the next setLoadout() fills them.
    this._dressWeapon();
  }

  // ---------------------------------------------------------------------------
  // WHAT NETWORK.JS CALLS
  // ---------------------------------------------------------------------------

  /** One pose off the wire. Was `component.setNetPose(pose)`. */
  setPose(pose) {
    if (!this.enabled || !pose) return;
    // The buffer validates the pose, estimates the server clock offset, carries the
    // animation block forward, and sorts late/duplicate arrivals into place. It reports
    // "snap" for the first pose and for a teleport (a respawn) — interpolating those
    // would drag the avatar across the whole map, so we place it there outright.
    if (this.buffer.push(SELF, pose, pose.t) === "snap") this._snapToLatest();
  }

  /** Server-authoritative HP. Was `entity.emit("sethp", {hp})`. */
  setHp(hp) {
    this.health.setHp(hp);
  }

  /** Was `entity.setAttribute("data-name", name)`. */
  setName(name) {
    this.name = name || "";
    if (this.nameLabel) updateLabelSprite(this.nameLabel, this.name, this._nameColor());
    else if (this._namesVisible() && this.name) this._ensureNameLabel();
  }

  /**
   * Are name plates on? THE REGISTRY OWNS THAT FLAG, and it is read live rather than off
   * `this.opts`: every avatar snapshots `{...DEFAULTS, ...owner.opts}` when it is built,
   * so setNamesVisible() — which flips the registry's own copy — would leave every body
   * that already existed believing names were still off, and the rename that arrives next
   * would silently draw nothing.
   */
  _namesVisible() {
    return !!(this.owner && this.owner.opts ? this.owner.opts.showNames : this.opts.showNames);
  }

  /**
   * The team can arrive AFTER the model: the server assigns by headcount at connect and
   * may switch a returning player to their stashed team on setName, which it announces as
   * a `team` message. network.js relays that as `player-team`.
   */
  setTeam(team) {
    if (!team) return;
    this.team = team;
    if (this.nameLabel) updateLabelSprite(this.nameLabel, this.name, this._nameColor());
    this.applyTeamTint(team);
  }

  /**
   * What this player is holding, and when it changes. The weapon rides on `hello`/`join`
   * and every later change arrives as `player-loadout`, which is the same broadcast the
   * HUD and the fire sounds read — so the gun in the hand can never disagree with the gun
   * that made the noise.
   *
   * The dual-Enforcer pickup broadcasts a loadout with NO weapon field (server.js sends
   * `{id, dual}` on its own line), so an absent weapon means "unchanged" and must not be
   * read as "back to the default".
   */
  setLoadout(weaponId, dual) {
    if (weaponId) this.weaponId = weaponId;
    this.dual = !!dual;
    this._dressWeapon();
  }

  /**
   * This player pulled the trigger — from a `fire` message or a `projectile` one.
   *
   * Restarts the hold that keeps the FR locomotion swapped in, plays UT99's PlayRecoil
   * over the standing pose for a body that is not moving, and plays the held weapon's own
   * fire sequence if its mesh has one (only the Enforcer's AutoHand does).
   */
  fire() {
    const now = this._now();
    const since = this._prevShot > 0 || this._lastShot > 0 ? now - this._lastShot : Infinity;
    this._prevShot = this._lastShot;
    this._lastShot = now;

    const moving = (this.target.Idle || 0) < STANDING_IDLE_WEIGHT;
    const recoil = this.fireActions.Idle;
    if (recoil && !moving) {
      // reset() re-arms a clamped one-shot, so a burst recoils once per round rather than
      // sitting on the last frame of the first. It also sets the weight to 1, which the
      // blend owns — put it straight back to 0 or the pose pops for one frame.
      recoil.reset();
      recoil.setEffectiveWeight(0);
      recoil.play();
      this._recoilActive = true;
    }

    this._fireWeaponAnim(since);
  }

  // ---------------------------------------------------------------------------
  // THE FRAME
  // ---------------------------------------------------------------------------

  /** `dt` in seconds, `now` performance.now() — was tick(time, deltaTime). */
  update(dt, now) {
    if (!this.enabled) return;

    // Interpolate the network snapshots into this frame's target pose
    this._sampleBuffer(now);

    // Residual smoothing. The old code wrote object3D directly to skip setAttribute; the
    // node IS the object now, so the same lerp lands in the same place.
    const lerp = Math.min((this.opts.smoothing * (dt * 1000)) / 16.67, 1);
    this.lastPosition.x += (this.targetPosition.x - this.lastPosition.x) * lerp;
    this.lastPosition.y += (this.targetPosition.y - this.lastPosition.y) * lerp;
    this.lastPosition.z += (this.targetPosition.z - this.lastPosition.z) * lerp;

    // Shortest-path yaw so the avatar never spins the long way round
    this.lastRotation = lerpYaw(this.lastRotation, this.targetRotation, lerp);
    this.currentSpeed += (this.targetSpeed - this.currentSpeed) * lerp;

    this._groundToFloor(Math.min(Math.max(dt || 0, 0), 1 / 20));
    this._applyToRig();

    if (this.char && this.char.ready) {
      this.char.advanceMixer(dt);
      // AFTER the mixer, so the phase sync inside reads times that are current, and
      // BEFORE the blend, so this frame's weights are routed by this frame's mix.
      this._advanceFireMix(dt, now);
      this.char.blend(dt);
    }

    this._followWeaponAnchor();

    // The held weapon animates on its own clock — a static mesh has no mixer to tick, so
    // in the common case this loop does nothing at all.
    for (let i = 0; i < this._weaponSlots.length; i++) {
      const m = this._weaponSlots[i] && this._weaponSlots[i].userData.thirdMixer;
      if (m) m.update(dt);
    }
  }

  // Monotonic local clock — immune to wall-clock jumps mid-session
  _now() {
    return typeof performance !== "undefined" && performance.now ? performance.now() : Date.now();
  }

  // Place the avatar exactly on the snapshot the buffer just snapped to, bypassing both
  // the interpolation and the residual smoothing.
  _snapToLatest() {
    const s = this.buffer.sample(SELF, this._now());
    if (!s) return;
    this.targetPosition.x = this.lastPosition.x = s.x;
    this.targetPosition.y = this.lastPosition.y = s.y;
    this.targetPosition.z = this.lastPosition.z = s.z;
    this.targetRotation = this.lastRotation = s.ry;
    this.targetSpeed = this.currentSpeed = s.speed;
    this.updateAnimationFromState(s.animation);
    this._applyToRig();
  }

  // Blend the two snapshots bracketing the render time into targetPosition et al.
  _sampleBuffer(now) {
    const s = this.buffer.sample(SELF, Number.isFinite(now) ? now : this._now());
    if (!s) return;
    this.targetPosition.x = s.x;
    this.targetPosition.y = s.y;
    this.targetPosition.z = s.z;
    this.targetRotation = s.ry;
    this.targetSpeed = s.speed;
    // Animation state comes from the snapshot we are leaving, so the legs match the
    // motion we are actually rendering rather than a state 100ms in the future.
    this.updateAnimationFromState(s.animation);
  }

  updateAnimationFromState(animationState) {
    if (!animationState) {
      // No animation block was ever sent — derive one from the interpolated speed so the
      // avatar still animates instead of standing frozen while it slides around. Off
      // GROUND_SPEED, the same way server/bots.js and systems/character.js do it:
      // blendTargets is that one shared decision.
      blendTargets(this.targetSpeed || 0, this.target);
    } else {
      this.target.Idle = animationState.idle || 0;
      this.target.Walk = animationState.walk || 0;
      this.target.Run = animationState.run || 0;
    }
    if (this.char) this.char.setTarget(this.target);
  }

  _applyToRig() {
    // The rig is the WIRE pose; the floor correction is the body's own y. See FEET ON THE
    // FLOOR YOU CAN SEE above for why that is the same thing it was.
    this.rig.position.set(this.lastPosition.x, this.lastPosition.y, this.lastPosition.z);
    this.rig.rotation.set(0, this.lastRotation, 0);
    this.body.position.y = this.groundOffset || 0;
  }

  /** See FEET ON THE FLOOR YOU CAN SEE at the top of the file. dt in seconds. */
  _groundToFloor(dt) {
    let want = 0;
    const meshes = this.owner ? this.owner.worldColliders() : EMPTY;
    if (meshes.length) {
      const p = this.lastPosition;
      _origin.set(p.x, p.y + FLOOR_PROBE_UP, p.z);
      _ray.set(_origin, _down);
      _ray.far = FLOOR_PROBE_UP + FLOOR_BELOW;
      const hits = _ray.intersectObjects(meshes, false);
      if (hits.length) {
        const d = hits[0].point.y - p.y;
        if (d >= -FLOOR_BELOW && d <= FLOOR_ABOVE) want = d;
      }
    }
    const g = this.groundOffset || 0;
    const next = g + (want - g) * (1 - Math.exp(-FLOOR_LERP * dt));
    this.groundOffset = Math.abs(next - want) < 0.001 ? want : next;
  }

  // ---------------------------------------------------------------------------
  // ANIMATION: THE FIRING TWINS
  // ---------------------------------------------------------------------------

  /**
   * The firing twins, all optional.
   *
   * Newer character exports carry three more clips: 'Fire' (UT99's PlayRecoil, 8 frames
   * at 15 fps over the standing pose) and the *FR locomotion variants the engine swaps in
   * while the trigger is down. Older files carry only Idle/Walk/Run, every lookup below
   * comes back null, and the body then does exactly what it did before.
   */
  _setupFireVariants() {
    const mixer = this.char.mixer;
    if (!mixer) return;
    this.fireActions = { Idle: null, Walk: null, Run: null };
    for (const channel of CHANNELS) {
      const clip = this.char.clipByName(FIRE_VARIANT[channel]);
      if (!clip) continue;
      const a = mixer.clipAction(clip);
      a.enabled = true;
      a.setEffectiveTimeScale(1);
      a.setEffectiveWeight(0);
      if (channel === "Idle") {
        // The recoil is a ONE-SHOT, started per shot rather than here. clampWhenFinished
        // so it holds its last frame the way UE1 holds a finished sequence, instead of
        // snapping back to frame 0 while the hold is still routing weight into it.
        a.setLoop(THREE.LoopOnce, 1);
        a.clampWhenFinished = true;
      } else {
        // A locomotion twin runs forever alongside its plain version, at zero weight
        // until a shot. three.js does not advance a zero-weight action's time, which is
        // exactly why _syncVariantPhase has to carry the stride across on the swap.
        a.setLoop(THREE.LoopRepeat, Infinity);
        a.play();
      }
      this.fireActions[channel] = a;
    }

    // The recoil finishing is what tells the Idle channel to stop routing into it.
    if (this._onMixerFinished) mixer.removeEventListener("finished", this._onMixerFinished);
    this._onMixerFinished = (e) => {
      if (e.action === this.fireActions.Idle) this._recoilActive = false;
    };
    mixer.addEventListener("finished", this._onMixerFinished);
  }

  /**
   * How the eased channel weights reach the actions — Character.blend calls this.
   *
   * Weights are SUMMED into this map before any of them is written, because two channels
   * can land on the same action: the older glTFs alias Walk and Run onto Idle in
   * Character's fallback branch, and a channel with no FR twin routes its whole weight
   * back into its plain clip. Writing as we went would let the last channel silently
   * overwrite the first.
   */
  _writeWeights(actions, weights) {
    const acc = this._actionWeights;
    acc.clear();

    for (let i = 0; i < CHANNELS.length; i++) {
      const key = CHANNELS[i];
      const plain = actions[key];
      if (!plain) continue;
      const w = weights[key];

      // The FR twin is an ALTERNATE of this channel, never a fourth weight: the channel's
      // own weight is split between the plain clip and its twin by the crossfade, so the
      // three channels still sum to one however far through a swap the body is.
      let twin = this.fireActions[key];
      // Idle routes into the recoil only while a recoil is actually running. A pawn that
      // fired mid-run and then stopped must not have PlayRecoil fade in underneath it
      // half a second after the shot — UE1 calls PlayRecoil at the moment of firing or
      // not at all.
      if (key === "Idle" && !this._recoilActive) twin = null;
      if (!twin || twin === plain || this.fireMix <= 0) {
        acc.set(plain, (acc.get(plain) || 0) + w);
      } else {
        acc.set(plain, (acc.get(plain) || 0) + w * (1 - this.fireMix));
        acc.set(twin, (acc.get(twin) || 0) + w * this.fireMix);
      }
    }

    // A twin nothing addressed this frame has to be told it is at zero, or the arms stay
    // up for ever after the shot that raised them.
    for (let i = 0; i < CHANNELS.length; i++) {
      const twin = this.fireActions[CHANNELS[i]];
      if (twin && !acc.has(twin)) acc.set(twin, 0);
    }

    for (const [action, w] of acc) action.setEffectiveWeight(w);
  }

  /**
   * Ease the plain <-> FR crossfade for this frame. `dt` in seconds.
   *
   * The MOVING test reads the TARGET weights rather than the eased ones: that block is
   * the server's own idle/walk/run for this pawn, and it is what the legs are heading
   * for — deciding a recoil off a weight that is still 200 ms behind the wire would give
   * a sprinting player the standing pose.
   */
  _advanceFireMix(dt, now) {
    const moving = (this.target.Idle || 0) < STANDING_IDLE_WEIGHT;
    const st = fireState(Number.isFinite(now) ? now : this._now(), this._lastShot, moving, FIRE_HOLD_MS);

    // Phase first, while the mix may still be parked at an end — see _syncVariantPhase.
    this._syncVariantPhase();

    // The hold lapsing is the only "trigger up" this client ever gets.
    if (!st.firing && this._weaponLooping) this._stopWeaponLoops();

    const want = st.firing ? 1 : 0;
    this.fireMix += (want - this.fireMix) * (FIRE_CROSSFADE > 0 ? Math.min(dt / FIRE_CROSSFADE, 1) : 1);
    // Snap the last sliver so the mix actually reaches an end and the phase sync below
    // can run; an exponential approach alone would leave it at 0.001 for ever.
    if (Math.abs(this.fireMix - want) < 0.002) this.fireMix = want;
  }

  /**
   * Carry the stride across between a locomotion clip and its FR twin.
   *
   * UT99 swaps the sequence and LEAVES AnimFrame ALONE — `AnimSequence = 'RunSMFR'` picks
   * up at the frame the run had reached, which is why a player who opens fire mid-sprint
   * does not visibly stutter. three.js cannot do that on its own: it does not advance a
   * zero-weight action's time, so the clip about to be faded in is frozen wherever it was
   * last left, sometimes a whole stride out of step.
   *
   * Only done while the crossfade is parked at one end. Writing `time` mid-fade would
   * yank the clip that is already visible.
   */
  _syncVariantPhase() {
    const toTwin = this.fireMix <= 0.001;
    const toPlain = this.fireMix >= 0.999;
    if (!toTwin && !toPlain) return;
    // Idle is deliberately not in here: its twin is the one-shot recoil, which owns its
    // own timeline and is restarted per shot.
    const channels = ["Walk", "Run"];
    for (let i = 0; i < channels.length; i++) {
      const plain = this.char.actions[channels[i]];
      const twin = this.fireActions[channels[i]];
      if (!plain || !twin || plain === twin) continue;
      const src = toTwin ? plain : twin;
      const dst = toTwin ? twin : plain;
      // Normalised, not absolute: the FR twin is authored at the same cadence but nothing
      // guarantees the same length, and a stride is a fraction of a cycle either way.
      const sd = src.getClip().duration;
      const dd = dst.getClip().duration;
      if (sd > 0 && dd > 0) dst.time = (src.time / sd) * dd;
    }
  }

  // ---------------------------------------------------------------------------
  // THE WEAPON IN THE HAND
  // ---------------------------------------------------------------------------

  /**
   * Put the weapon this player is holding into their hand.
   *
   * `weapon(id).third` is a glTF ALREADY IN THE CHARACTER'S FRAME — the same axes as the
   * body (forward -Z, up +Y), feet at y = 0, positioned where the pawn's hand is — so a
   * slot is the identity transform and there is nothing here to fit or measure. When a
   * weapon has no `third` block (the older tables, or a mesh not yet extracted) the slots
   * are hidden and the hands stay empty, which is what this drew before.
   *
   * Cheap to call: it returns immediately unless the weapon or the dual flag changed.
   */
  _dressWeapon() {
    const id = this.weaponId || DEFAULT_WEAPON;
    const dual = !!this.dual;
    if (id === this._weaponId && dual === this._weaponDual) return;
    this._weaponId = id;
    this._weaponDual = dual;

    const spec = weapon(id) || {};
    const third = spec.third;
    const model = third && third.model;

    // UT99's dual Enforcer is literally two AutoHands, one per hand — not one mesh with
    // two barrels — so the second slot is the same file mirrored across the body's X.
    const want = model ? (dual ? 2 : 1) : 0;
    const have = this._weaponSlots.length;
    for (let i = 0; i < Math.max(want, have); i++) {
      if (i >= want) {
        // Dropped back to one gun (or to none): hide the surplus rather than destroying
        // it, so picking the second Enforcer up again is not another download.
        const spare = this._weaponSlots[i];
        if (spare) spare.visible = false;
        continue;
      }
      const slot = this._ensureWeaponSlot(i);
      slot.visible = true;
      if (slot.userData.thirdUrl === model) continue; // same mesh, already loaded or loading
      slot.userData.thirdUrl = model;
      this._disposeWeaponAnim(slot);
      attachModel(slot, model)
        .then(({ root, animations }) => this._onWeaponLoaded(slot, model, third, root, animations))
        .catch((err) => console.warn(`[remote-avatar] held weapon ${id} failed:`, err && err.message));
    }
  }

  /** One held-weapon slot, reused for the life of the avatar. */
  _ensureWeaponSlot(i) {
    const existing = this._weaponSlots[i];
    if (existing) return existing;
    const slot = new THREE.Group();
    slot.name = `held-weapon-${i}`;
    // The weapon glTFs are built at the pawn's ACTOR origin, and UE1 draws the carried
    // weapon at the pawn mesh's weapon triangle — three special vertices in the gun hand.
    // characters.js ships that hand's offset per model (base pose); the slot sits there
    // until _followWeaponAnchor finds the animated node. Without it the gun hangs at the
    // hip.
    slot.position.set(this.weaponOffsetM[0] || 0, this.weaponOffsetM[1] || 0, this.weaponOffsetM[2] || 0);
    // A NEGATIVE x scale is the mirror, the same trick first-person-weapon.js uses for
    // the left-hand Enforcer: rotating the mesh 180 degrees instead would point the gun
    // backwards. Slot 0 is the weapon; slot 1 only ever exists while dual-wielding.
    slot.scale.set(i === 1 ? -1 : 1, 1, 1);
    // A CHILD OF THE BODY, not of the rig: the body carries modelYaw, and the rig's
    // rotation is overwritten from the wire on every pose.
    this.body.add(slot);
    this._weaponSlots[i] = slot;
    return slot;
  }

  /** The held mesh is in: fix the mirrored winding and build its mixer, if it has clips. */
  _onWeaponLoaded(slot, url, third, mesh, animations) {
    if (this.disposed) return;
    if (slot.userData.thirdUrl !== url) return; // swapped again while this was loading

    // shadow="cast:true; receive:false" — a held gun casts, and nothing lands on it.
    mesh.traverse((o) => {
      if (!o.isMesh) return;
      o.castShadow = true;
      o.receiveShadow = false;
    });

    if (slot === this._weaponSlots[1]) {
      // A negative scale flips the handedness of the transform, so every triangle winds
      // the other way. three.js already compensates by reading matrixWorld's determinant;
      // this is belt and braces against a material that arrives with FrontSide baked in
      // some other way. A held gun is a few hundred triangles — drawing both sides is free.
      //
      // The material is SHARED with slot 0 (assets.js clones the graph, not the
      // materials), so this is one clone per mirrored slot rather than a write that would
      // also make the right-hand gun double-sided.
      //
      // FIRST, the set from the gun this slot was wearing a moment ago. attachModel has
      // already taken that mesh off the slot, so nothing is drawing them: freed HERE
      // rather than in dispose(), or every weapon swap would leave a set of clones behind
      // for the life of the body. (Not at the top of _dressWeapon: the old mesh is still
      // on screen until this load resolves.)
      this._freeMirroredMaterials();
      mesh.traverse((o) => {
        if (!o.isMesh || !o.material) return;
        if (Array.isArray(o.material)) {
          o.material = o.material.map((m) => {
            const c = m.clone();
            c.side = THREE.DoubleSide;
            return c;
          });
          for (const m of o.material) this._mirroredMaterials.push(m);
        } else {
          const c = o.material.clone();
          c.side = THREE.DoubleSide;
          o.material = c;
          this._mirroredMaterials.push(c);
        }
      });
    }

    // Only the Enforcer's AutoHand carries fire sequences ('Shoot', 'shot2'); every other
    // held mesh is static and gets no mixer at all rather than an idle one to tick.
    const anims = third && third.anims;
    if (!anims || !animations || !animations.length) return;
    slot.userData.thirdMixer = new THREE.AnimationMixer(mesh);
    slot.userData.thirdClips = animations;
    slot.userData.thirdAnims = anims;
  }

  /**
   * THE GUN FOLLOWS THE HAND. UE1 draws a pawn's carried weapon at its mesh's WEAPON
   * TRIANGLE — three special vertices in the gun hand that are animated with every other
   * vertex, so the gun swings with the arm through the run. The character glTFs carry
   * that triangle as an empty node "weaponAnchor" (a child of the model root, in the same
   * space as the body node) with translation and rotation tracks on every clip, keyed on
   * the same times as the morph weights; the mixer moves it for free. Each frame the held
   * slot is simply placed where the anchor is. The base-pose hand is 85 cm from the
   * sprinting Soldier's swung hand, so the static offset (weaponOffset, the fallback for a
   * body file without the node) is not a substitute.
   *
   * The dual pair's second gun is the mirror: X negated and the rotation reflected across
   * the body's YZ plane, on top of the slot's own scale.x = -1.
   */
  _followWeaponAnchor() {
    if (!this._weaponSlots.length) return;
    if (this._anchor === undefined) {
      const mesh = this.body.userData.mesh;
      this._anchor = mesh ? mesh.getObjectByName("weaponAnchor") || null : undefined;
    }
    const a = this._anchor;
    if (!a) return;
    for (let i = 0; i < this._weaponSlots.length; i++) {
      const slot = this._weaponSlots[i];
      if (!slot) continue;
      slot.position.copy(a.position);
      slot.quaternion.copy(a.quaternion);
      if (i === 1) {
        slot.position.x = -slot.position.x;
        slot.quaternion.set(a.quaternion.x, -a.quaternion.y, -a.quaternion.z, a.quaternion.w);
      }
    }
  }

  /**
   * Play the held weapon's own fire sequence, once, for this shot.
   * `sinceMs` is the gap since the previous shot — it picks 'shot2' over 'Shoot'.
   */
  _fireWeaponAnim(sinceMs) {
    for (let i = 0; i < this._weaponSlots.length; i++) {
      const slot = this._weaponSlots[i];
      const ud = slot && slot.userData;
      if (!ud || !ud.thirdMixer) continue;
      const spec = pickFireClip(ud.thirdAnims, sinceMs);
      if (!spec || !spec.clip) continue;
      const clip = THREE.AnimationClip.findByName(ud.thirdClips, spec.clip);
      if (!clip) continue;
      const action = ud.thirdMixer.clipAction(clip);
      // The Shock Rifle and the Ripper LoopAnim their fire sequence while the trigger is
      // DOWN rather than playing it once a shot; re-triggering every round would restart
      // the swing mid-stroke, so an already-running loop is left alone. _stopWeaponLoops
      // puts it down when the hold lets go, which is this client's only signal that the
      // trigger came up.
      const loops = !!(ud.thirdAnims && ud.thirdAnims.fireLoops);
      if (loops && action.isRunning()) continue;
      action.reset();
      action.setLoop(loops ? THREE.LoopRepeat : THREE.LoopOnce, loops ? Infinity : 1);
      // UE1 holds the last frame of a finished sequence until something else plays.
      action.clampWhenFinished = !loops;
      // UnrealScript's PlayAnim rate IS a time scale, and the clip is authored at the
      // sequence's native fps — so nothing else has to be converted. Same mapping as
      // view-weapon-anim.js makes for the first-person meshes.
      action.timeScale = typeof spec.rate === "number" && spec.rate > 0 ? spec.rate : 1;
      action.play();
      if (loops) this._weaponLooping = true;
    }
  }

  /** The shots stopped: put down any fire sequence that was looping. */
  _stopWeaponLoops() {
    this._weaponLooping = false;
    for (let i = 0; i < this._weaponSlots.length; i++) {
      const ud = this._weaponSlots[i] && this._weaponSlots[i].userData;
      if (ud && ud.thirdMixer) ud.thirdMixer.stopAllAction();
    }
  }

  /** Free the material clones made for the mirrored (left-hand) gun. */
  _freeMirroredMaterials() {
    for (let i = 0; i < this._mirroredMaterials.length; i++) this._mirroredMaterials[i].dispose();
    this._mirroredMaterials.length = 0;
  }

  _disposeWeaponAnim(slot) {
    const ud = slot && slot.userData;
    if (!ud || !ud.thirdMixer) return;
    ud.thirdMixer.stopAllAction();
    if (ud.mesh) ud.thirdMixer.uncacheRoot(ud.mesh);
    ud.thirdMixer = null;
    ud.thirdClips = null;
    ud.thirdAnims = null;
  }

  // ---------------------------------------------------------------------------
  // SKIN, TINT, NAME
  // ---------------------------------------------------------------------------

  /**
   * Put this avatar's skin on its model.
   *
   * The UT99 models are one glTF per character with one material slot per skin texture,
   * named slot0..slotN by the exporter. A variant (which model, which named character) is
   * chosen by the SERVER and broadcast, so everyone sees the same body for the same
   * player; the character index becomes this texture list through characters.js, and this
   * hangs those textures on the matching slots.
   *
   * Textures AND materials are per-avatar, not shared: two bots on the same model wear
   * different faces, so they cannot share a material — and assets.attachModel clones the
   * node graph but not the materials, so cloning here is what keeps one bot's face off
   * another's. Disposed in dispose().
   */
  applySkin() {
    const urls = (this.skins || []).filter(Boolean);
    if (!urls.length) return; // no skin assigned: the model keeps whatever its glTF referenced
    const mesh = this.body.userData.mesh;
    if (!mesh) return;

    const loader = new THREE.TextureLoader();
    mesh.traverse((o) => {
      if (!o.isMesh || !o.material || Array.isArray(o.material)) return;
      // slotN in the material name is the authority; traversal order is the fallback for
      // anything that did not come out of our exporter.
      const m = /slot(\d+)$/.exec(o.material.name || "");
      const idx = m ? Number(m[1]) : this._skinTextures.length;
      const url = urls[idx];
      if (!url) return;
      const tex = loader.load(url);
      // glTF albedo is sRGB; a raw load would otherwise be treated as linear and the UT99
      // skins come out washed out.
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.flipY = false; // matches glTF's UV origin, which our exporter writes
      const mat = o.material.clone();
      mat.map = tex;
      mat.needsUpdate = true;
      o.material = mat;
      this._skinTextures.push({ tex, mat });
    });
  }

  /** The team this avatar belongs to, or null while it is still unknown. */
  _readTeam() {
    return TEAM_COLORS[this.team] ? this.team : null;
  }

  _nameColor() {
    const t = this._readTeam();
    return t ? TEAM_COLORS[t] : "#c8d4e6";
  }

  _ensureNameLabel() {
    if (this.nameLabel) return this.nameLabel;
    this.nameLabel = makeLabelSprite(this.name, {
      color: this._nameColor(),
      y: this.opts.nameY,
      // Behind a tower means behind the tower: on a map this open you read a player's
      // position off what hides their name as much as off the body.
      depthTest: true,
    });
    this.body.add(this.nameLabel);
    return this.nameLabel;
  }

  /**
   * Tint every mesh of this avatar with its team colour.
   *
   * EMISSIVE, not a diffuse multiply: each base is already lit by a saturated light of
   * its own team's colour, so a red soldier tinted on the albedo disappears against the
   * red base. Emissive adds on top of the lighting and stays readable from the far tower.
   * The albedo map is kept — this is a tint, not a repaint.
   *
   * Materials are cloned per avatar because the soldier glTF is one shared asset; writing
   * emissive onto the loaded material would paint every player, local one included.
   *
   * Off in the game view — see TEAM_TINT_ENABLED.
   */
  applyTeamTint(team) {
    if (!TEAM_TINT_ENABLED) return;
    const t = TEAM_COLORS[team] ? team : this._readTeam();
    if (!t || t === this._tintedTeam) return;

    const mesh = this.body.userData.mesh;
    if (!mesh) return; // the model landing calls us again

    this.clearTeamTint();

    const color = new THREE.Color(TEAM_COLORS[t]);
    mesh.traverse((o) => {
      if (!o.isMesh || !o.material) return;
      const isArray = Array.isArray(o.material);
      const originals = isArray ? o.material : [o.material];
      const clones = originals.map((m) => {
        const c = m.clone();
        // MeshBasicMaterial and friends have no emissive channel; leave those alone.
        if (c.emissive) {
          c.emissive.copy(color);
          c.emissiveIntensity = EMISSIVE_STRENGTH;
        }
        return c;
      });
      this._tinted.push({ mesh: o, original: o.material, clones });
      o.material = isArray ? clones : clones[0];
    });

    this._tintedTeam = t;
  }

  /** Restore the asset's own materials and dispose the clones we made. */
  clearTeamTint() {
    for (let i = 0; i < this._tinted.length; i++) {
      const rec = this._tinted[i];
      // The originals belong to the shared glTF asset — restore, never dispose.
      rec.mesh.material = rec.original;
      for (let j = 0; j < rec.clones.length; j++) rec.clones[j].dispose();
    }
    this._tinted.length = 0;
    this._tintedTeam = null;
  }

  // ---------------------------------------------------------------------------

  /** Every mesh of this body, for hitscan's hit volumes. */
  meshes() {
    const out = [];
    this.body.traverse((o) => {
      if (o.isMesh && o.geometry) out.push(o);
    });
    return out;
  }

  /** World position of the body's feet — the ground-corrected point, not the wire's. */
  feet(out = _v) {
    return this.body.getWorldPosition(out);
  }

  dispose() {
    this.disposed = true;
    for (let i = 0; i < this._skinTextures.length; i++) {
      this._skinTextures[i].tex.dispose();
      this._skinTextures[i].mat.dispose();
    }
    this._skinTextures.length = 0;
    this._freeMirroredMaterials();
    for (let i = 0; i < this._weaponSlots.length; i++) this._disposeWeaponAnim(this._weaponSlots[i]);
    this._weaponSlots.length = 0;
    this.clearTeamTint();
    this.buffer.clear();
    if (this.char) {
      if (this._onMixerFinished && this.char.mixer) {
        this.char.mixer.removeEventListener("finished", this._onMixerFinished);
      }
      this.char.dispose();
      this.char = null;
    }
    this.fireActions = { Idle: null, Walk: null, Run: null };
    if (this.health) {
      this.health.dispose();
      this.health = null;
    }
    if (this.nameLabel) {
      this.body.remove(this.nameLabel);
      disposeLabelSprite(this.nameLabel);
      this.nameLabel = null;
    }
    if (this.rig.parent) this.rig.parent.remove(this.rig);
  }
}

/**
 * The registry. Replaces `remotes` (id -> rig element) plus every
 * `rig.querySelector("[remote-avatar]")` in network.js, and hitscan's
 * `sceneEl.querySelectorAll(".avatar")`.
 */
export class RemoteAvatars {
  constructor(game, opts = {}) {
    this.game = game;
    this.opts = { ...DEFAULTS, ...opts };
    this.avatars = new Map(); // id -> RemoteAvatar
    this._bodies = [];
    this._bodiesDirty = true;

    // The three scene events every instance used to listen to and filter by id. One
    // subscription each, routed by the map — network.js emits exactly what it always did.
    this._offs = [];
    if (game && game.events) {
      this._offs.push(
        game.events.on("player-team", (e) => {
          const d = e && e.detail;
          if (!d || d.id == null || !d.team) return;
          const a = this.avatars.get(d.id);
          if (a) a.setTeam(d.team);
        })
      );
      this._offs.push(
        game.events.on("player-loadout", (e) => {
          const d = e && e.detail;
          if (!d || d.id == null) return;
          const a = this.avatars.get(d.id);
          if (a) a.setLoadout(d.weapon, d.dual);
        })
      );
      // Somebody else's shot. network.js emits this for both the hitscan `fire` message
      // and the server-simulated `projectile` one, so a rocket raises the arms as a
      // bullet does.
      this._offs.push(
        game.events.on("remote-fire", (e) => {
          const d = e && e.detail;
          if (!d || d.id == null) return;
          const a = this.avatars.get(d.id);
          if (a) a.fire();
        })
      );
    }
  }

  /** @param {object} p the publicPlayer payload. Idempotent per id. */
  spawn(p) {
    if (!p || p.id == null) return null;
    const existing = this.avatars.get(p.id);
    if (existing) return existing;
    const avatar = new RemoteAvatar(this.game, p, this);
    this.avatars.set(p.id, avatar);
    (this.game && this.game.world ? this.game.world : this.game.scene).add(avatar.rig);
    this._bodiesDirty = true;
    return avatar;
  }

  get(id) {
    return this.avatars.get(id) || null;
  }

  remove(id) {
    const a = this.avatars.get(id);
    if (!a) return;
    a.dispose();
    this.avatars.delete(id);
    this._bodiesDirty = true;
  }

  /**
   * Tear down every remote avatar — on reconnect the server hands out fresh ids, so
   * anything left over would be a permanent ghost standing in the map.
   */
  clear() {
    for (const a of this.avatars.values()) a.dispose();
    this.avatars.clear();
    this._bodiesDirty = true;
  }

  /** Show or hide every name plate at once. */
  setNamesVisible(visible) {
    this.opts.showNames = !!visible;
    for (const a of this.avatars.values()) {
      if (this.opts.showNames) a._ensureNameLabel();
      if (a.nameLabel) a.nameLabel.visible = this.opts.showNames;
    }
    return this.opts.showNames;
  }

  /**
   * The hit volumes, for hitscan (Task 10). `node` is the BODY, whose world position is
   * the ground-corrected feet the capsule is built from — the same point the A-Frame
   * rig's was, since the floor correction used to be written there. `rig` is the wire
   * pose, and `meshes` the drawn triangles for anything that wants a real intersection.
   */
  bodies() {
    if (this._bodiesDirty) {
      this._bodies = [...this.avatars.values()].map((a) => ({
        id: a.id,
        node: a.body,
        rig: a.rig,
        avatar: a,
        get meshes() {
          return a.meshes();
        },
      }));
      this._bodiesDirty = false;
    }
    return this._bodies;
  }

  /** Alias, for callers that think in volumes rather than bodies. */
  hitVolumes() {
    return this.bodies();
  }

  /**
   * The map's meshes, for the floor probe: hitscan.js's list, which is cached on the map
   * root's identity and shared with the local floor probe and every shot's world ray.
   */
  worldColliders() {
    return getWorldColliders(this.game);
  }

  update(dt, now) {
    for (const a of this.avatars.values()) a.update(dt, now);
  }

  dispose() {
    for (const off of this._offs) off();
    this._offs.length = 0;
    this.clear();
  }
}
