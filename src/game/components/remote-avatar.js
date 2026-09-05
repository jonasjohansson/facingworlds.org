// remote-avatar.js — Handles position updates and animations for remote players
//
// Remote poses arrive every 50–100ms over the network. Applying them raw makes other
// players teleport, so instead we buffer incoming snapshots and render the avatar a
// fixed amount of time IN THE PAST (INTERP_DELAY). At any render frame there are then
// two snapshots bracketing the render time and we interpolate between them, which
// turns a 10–20Hz packet stream into smooth 60Hz motion.
//
// The buffering/interpolation math itself lives in src/shared/net/interpolation.js so
// the AR spectator view (pure three.js, no A-Frame) renders the same players with the
// same behaviour instead of growing a second copy that re-acquires the teleporting this
// one already fixed. This component owns only the A-Frame side: the animation mixer,
// the residual visual smoothing, and writing the result onto the rig.
import { SnapshotBuffer, lerpYaw } from "../../shared/net/interpolation.js";
import { GAME_CONFIG } from "../config/game-config.js";
import { getWorldColliders } from "./hitscan.js";
import { fireState, pickFireClip } from "./remote-fire-state.js";
import { DEFAULT_WEAPON, weapon } from "../../shared/weapons.js";

// ---------------------------------------------------------------------------
// WHAT THEY ARE HOLDING, AND WHAT THEY DO WITH IT
// ---------------------------------------------------------------------------
// Two things a UT99 TournamentPlayer does that this used to skip entirely.
//
// THE WEAPON IN THE HAND. Every pawn carries its current weapon's third-person mesh —
// the Enforcer's is called AutoHand — and until now a remote player here ran around the
// map empty-handed while shooting people. weapons.js ships a `third` block per weapon:
// a glTF already in the CHARACTER's frame (forward -Z, up +Y, feet at y = 0, positioned
// where the pawn's hand is), so it goes on as a plain child of the model entity at the
// identity transform and needs no fitting. It is a child of the MODEL, not of the rig,
// because the model carries modelYaw and the rig's rotation is overwritten from the wire.
//
// THE FIRING POSE. UT99 has no additive fire animation. It has a second complete set of
// locomotion sequences authored with the weapon levelled, suffixed FR, and PlayFiring
// writes 'RunSMFR' straight over 'RunSM' at the frame it had reached; a pawn standing
// still gets PlayRecoil, an 8 frame one-shot, instead. So the FR clips here are not a
// fourth blend weight — they are ALTERNATES that the existing Walk/Run weights drive,
// swapped by a crossfade with the phase carried across so the legs do not skip a step.
// See remote-fire-state.js for when, and _routeFireVariants below for how.
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
// local player's is (ut-movement.js groundToFloor): probe straight down from a little
// above the wire height, accept a floor inside the same window, ease onto it at the same
// rate. Outside the window the wire height stands — a jump is a jump, and a shaft is a
// shaft. Applied to the RIG, so the hit capsule (hitscan.js reads the rig) follows the
// body a player is aiming at; the server tolerates half a metre of body slack on a
// claimed hit, which is more than the window can move anything.
const FLOOR_PROBE_UP = 1.2;
const FLOOR_BELOW = 0.6;
const FLOOR_ABOVE = 0.35;
const FLOOR_LERP = 25.0;
const _ray = new AFRAME.THREE.Raycaster();
const _origin = new AFRAME.THREE.Vector3();
const _down = new AFRAME.THREE.Vector3(0, -1, 0);

// One buffer per component, so it tracks exactly one entity.
const SELF = "self";

// ---- team tint ----------------------------------------------------------------
// In CTF you have to read friend from foe at Facing Worlds' distances — across the
// bridge that is 40+ metres of the same soldier model. GAME_CONFIG.TEAMS carries the
// palette; the fallbacks below keep this component standalone-safe if it is ever
// loaded without that block (it then still tints, rather than silently doing nothing).
const TEAM_CFG = GAME_CONFIG.TEAMS || {};
const TEAM_COLORS = {
  red: TEAM_CFG.RED || "#ff3a22",
  blue: TEAM_CFG.BLUE || "#2f86ff",
};
const EMISSIVE_STRENGTH = typeof TEAM_CFG.EMISSIVE_STRENGTH === "number" ? TEAM_CFG.EMISSIVE_STRENGTH : 0.45;

// ---- firing ---------------------------------------------------------------------
// Same standalone-safe pattern as the team block: the numbers live in game-config, and
// the fallbacks here are the same values so this component keeps working if it is ever
// loaded without that block rather than quietly never animating a shot.
const FIRE_CFG = GAME_CONFIG.REMOTE_FIRE || {};
const FIRE_HOLD_MS = typeof FIRE_CFG.HOLD_MS === "number" ? FIRE_CFG.HOLD_MS : 500;
const FIRE_CROSSFADE = typeof FIRE_CFG.CROSSFADE === "number" ? FIRE_CFG.CROSSFADE : 0.05;
const STANDING_IDLE_WEIGHT = typeof FIRE_CFG.STANDING_IDLE_WEIGHT === "number" ? FIRE_CFG.STANDING_IDLE_WEIGHT : 0.5;

// The three locomotion channels, and the clip each one swaps to while the trigger is
// down. Idle -> Fire is UT99's PlayRecoil over the standing pose; the other two are the
// *FR twins. A name missing from the glTF simply leaves that channel unswapped.
const FIRE_VARIANT = { Idle: "Fire", Walk: "WalkFire", Run: "RunFire" };

AFRAME.registerComponent("remote-avatar", {
  schema: {
    enabled: { type: "boolean", default: true },
    // How far in the past to render, in ms. One-and-a-bit packet intervals of slack.
    delay: { type: "number", default: 100 },
    // Residual visual smoothing applied on top of the interpolation (per 16.67ms frame).
    // Absorbs the small pops caused by extrapolation and by snapshots arriving late.
    smoothing: { type: "number", default: 0.35 },
  },

  init: function () {
    this.lastPosition = { x: 0, y: 0, z: 0 };
    this.lastRotation = 0;
    this.currentSpeed = 0;

    // Target values produced by the interpolator, consumed by the visual smoothing
    this.targetPosition = { x: 0, y: 0, z: 0 };
    this.targetRotation = 0;
    this.targetSpeed = 0;

    // ---- interpolation buffer ----
    // maxExtrapolationMs matches the old inline cap (delay + 20): remote players stop
    // sending poses when they stand still, so open ended extrapolation would slide an
    // idle avatar across the map.
    this.buffer = new SnapshotBuffer({
      delayMs: this.data.delay,
      maxExtrapolationMs: this.data.delay + 20,
    });

    // ---- skin ----
    // Textures loaded for this body, so remove() can dispose them. Each UT99 model is
    // one glTF with a material slot per skin texture; the variant the server picked
    // decides which set of textures goes onto those slots.
    this._skinTextures = [];

    // Animation system for remote players
    this.mixer = null;
    this.actions = {};
    this.weights = { Idle: 1, Walk: 0, Run: 0 };
    this.target = { Idle: 1, Walk: 0, Run: 0 };
    this.clock = new AFRAME.THREE.Clock();

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

    // ---- the weapon in the hand ----
    // Slot 0 is the weapon; slot 1 exists only while dual-wielding and is the same mesh
    // mirrored across the body's X. Entities are reused across weapon changes — a swap is
    // a new gltf-model on the same element, the way first-person-weapon.js dresses a slot.
    this._weaponSlots = [];
    this._weaponId = null;
    this._weaponDual = null;
    // True while a held mesh's fire clip is LOOPING (Shock, Ripper) rather than one-shot.
    this._weaponLooping = false;

    // ---- team tint ----
    // Materials we swapped in, so remove() can put the originals back and dispose ours.
    this._tinted = [];
    this._tintedTeam = null;

    // Wait for GLTF model to load
    this._onModelLoaded = (evt) => {
      // A-Frame events BUBBLE, and the held weapon is a child entity with its own
      // gltf-model: its model-loaded arrives here too. Acting on it rebuilt the body's
      // mixer over the same morph targets and re-ran the skin and tint — six times a
      // spawn, once per gun that loaded — and warned "no animations" when the gun landed
      // before the body did. Only this entity's own model is this handler's business.
      if (evt && evt.target && evt.target !== this.el) return;
      this._anchor = undefined; // looked up again against the new body
      this.setupAnimations();
      // Skin before tint: applyTeamTint clones whatever material is on the mesh, so
      // the texture has to be in place first or the clone carries the wrong one.
      this.applySkin();
      // The rig already carries data-team when the team was known at spawnRemote time
      // (hello/join); if it was not, the scene event below fills it in later.
      this.applyTeamTint();
    };
    this.el.addEventListener("model-loaded", this._onModelLoaded);

    // The team can arrive AFTER the model: the server assigns by headcount at connect
    // and may switch a returning player to their stashed team on setName, which it
    // announces as a `team` message. network.js relays that as `player-team`.
    this._scene = this.el.sceneEl || document.querySelector("a-scene");
    this._onPlayerTeam = (e) => {
      const d = e && e.detail;
      if (!d || !d.id || !d.team) return;
      const rig = this.el.parentElement;
      if (!rig || rig.dataset.playerId !== String(d.id)) return;
      // Mirror it onto the rig so anything reading data-team later agrees, no matter
      // whether the event or spawnRemote got here first.
      rig.dataset.team = d.team;
      this.applyTeamTint(d.team);
    };
    if (this._scene) this._scene.addEventListener("player-team", this._onPlayerTeam);

    // What this player is holding, and when it changes. network.js writes the weapon onto
    // the rig at spawn (from `hello`/`join`) and relays every later change as
    // `player-loadout`, which is the same broadcast the HUD and the fire sounds read — so
    // the gun in the hand can never disagree with the gun that made the noise.
    this._onLoadout = (e) => {
      const d = e && e.detail;
      const rig = this.el.parentElement;
      if (!d || !rig || rig.dataset.playerId !== String(d.id)) return;
      // The dual-Enforcer pickup broadcasts a loadout with NO weapon field (server.js
      // sends `{id, dual}` on its own line), so an absent weapon means "unchanged" and
      // must not be read as "back to the default".
      if (d.weapon) rig.dataset.weapon = d.weapon;
      rig.dataset.dual = d.dual ? "1" : "";
      this._dressWeapon();
    };
    if (this._scene) this._scene.addEventListener("player-loadout", this._onLoadout);

    // Somebody else's shot. network.js emits this for both the hitscan `fire` message and
    // the server-simulated `projectile` one, so a rocket raises the arms as a bullet does.
    this._onRemoteFire = (e) => {
      const d = e && e.detail;
      const rig = this.el.parentElement;
      if (!d || !rig || rig.dataset.playerId !== String(d.id)) return;
      this.onFire();
    };
    if (this._scene) this._scene.addEventListener("remote-fire", this._onRemoteFire);

    // The hands are dressed now rather than on model-loaded: the weapon is a sibling of
    // the body inside the same entity, not something hung on it, so it does not have to
    // wait for the character mesh. If the rig has no weapon yet the slots stay hidden and
    // the next `player-loadout` fills them.
    this._dressWeapon();
  },

  /** The team this avatar belongs to, or null while it is still unknown. */
  _readTeam: function () {
    const rig = this.el.parentElement;
    const team = (rig && rig.dataset && rig.dataset.team) || this.el.dataset.team || "";
    return TEAM_COLORS[team] ? team : null;
  },

  /**
   * Tint every mesh of this avatar with its team colour.
   *
   * EMISSIVE, not a diffuse multiply: each base is already lit by a saturated light of
   * its own team's colour, so a red soldier tinted on the albedo disappears against the
   * red base. Emissive adds on top of the lighting and stays readable from the far tower.
   * The albedo map is kept — this is a tint, not a repaint.
   *
   * Materials are cloned per avatar because the soldier GLTF is one shared asset; writing
   * emissive onto the loaded material would paint every player, local one included.
   */
  applyTeamTint: function (team) {
    // DISABLED in the game view. Jonas: "i dont need the player avatars
    // character tinted". The team still reaches the rig's data-team (scoreboard,
    // future outlines) and the AR page keeps its own tint — spectators need to
    // tell teams apart from across a room; a player reads the map instead.
    if (true) return;
    const t = TEAM_COLORS[team] ? team : this._readTeam();
    if (!t || t === this._tintedTeam) return;

    const mesh = this.el.getObject3D("mesh");
    if (!mesh) return; // model-loaded will call us again

    this.clearTeamTint();

    const color = new AFRAME.THREE.Color(TEAM_COLORS[t]);
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
  },

  /**
   * Put this avatar's skin on its model.
   *
   * The UT99 models are one glTF per character with one material slot per skin
   * texture, named slot0..slotN by the exporter. A variant (which model, which named
   * character) is chosen by the SERVER and broadcast, so everyone sees the same body
   * for the same player; network.js writes the resulting texture list onto the rig as
   * data-skin, and this hangs those textures on the matching slots.
   *
   * Textures are per-avatar, not shared: two bots on the same model wear different
   * faces, so they cannot share a material. Disposed in remove().
   */
  applySkin: function () {
    const rig = this.el.parentElement;
    const raw = (rig && rig.dataset && rig.dataset.skin) || "";
    if (!raw) return; // no skin assigned: the model keeps whatever its glTF referenced
    const urls = raw.split(",").filter(Boolean);
    if (!urls.length) return;

    const mesh = this.el.getObject3D("mesh");
    if (!mesh) return; // model-loaded calls us again

    const loader = new AFRAME.THREE.TextureLoader();
    mesh.traverse((o) => {
      if (!o.isMesh || !o.material || Array.isArray(o.material)) return;
      // slotN in the material name is the authority; traversal order is the fallback
      // for anything that did not come out of our exporter.
      const m = /slot(\d+)$/.exec(o.material.name || "");
      const idx = m ? Number(m[1]) : this._skinTextures.length;
      const url = urls[idx];
      if (!url) return;
      const tex = loader.load(url);
      // glTF albedo is sRGB; three r164 will otherwise treat a raw load as linear and
      // the UT99 skins come out washed out.
      if (AFRAME.THREE.SRGBColorSpace) tex.colorSpace = AFRAME.THREE.SRGBColorSpace;
      tex.flipY = false; // matches glTF's UV origin, which our exporter writes
      const mat = o.material.clone();
      mat.map = tex;
      mat.needsUpdate = true;
      o.material = mat;
      this._skinTextures.push({ tex, mat });
    });
  },

  /** Restore the asset's own materials and dispose the clones we made. */
  clearTeamTint: function () {
    for (let i = 0; i < this._tinted.length; i++) {
      const rec = this._tinted[i];
      // The originals belong to the shared GLTF asset — restore, never dispose.
      rec.mesh.material = rec.original;
      for (let j = 0; j < rec.clones.length; j++) rec.clones[j].dispose();
    }
    this._tinted.length = 0;
    this._tintedTeam = null;
  },

  update: function () {
    // Keep the buffer's timing in sync if the schema is changed at runtime
    if (!this.buffer) return;
    this.buffer.delayMs = this.data.delay;
    this.buffer.maxExtrapolationMs = this.data.delay + 20;
  },

  // Monotonic local clock — immune to wall-clock jumps mid-session
  _now: function () {
    return typeof performance !== "undefined" && performance.now ? performance.now() : Date.now();
  },

  setNetPose: function (pose) {
    if (!this.data.enabled || !pose) return;

    // The buffer validates the pose, estimates the server clock offset, carries the
    // animation block forward, and sorts late/duplicate arrivals into place. It reports
    // "snap" for the first pose and for a teleport (a respawn) — interpolating those
    // would drag the avatar across the whole map, so we place it there outright.
    if (this.buffer.push(SELF, pose, pose.t) === "snap") this._snapToLatest();
  },

  // Place the avatar exactly on the snapshot the buffer just snapped to, bypassing both
  // the interpolation and the residual smoothing.
  _snapToLatest: function () {
    const s = this.buffer.sample(SELF, this._now());
    if (!s) return;
    this.targetPosition.x = this.lastPosition.x = s.x;
    this.targetPosition.y = this.lastPosition.y = s.y;
    this.targetPosition.z = this.lastPosition.z = s.z;
    this.targetRotation = this.lastRotation = s.ry;
    this.targetSpeed = this.currentSpeed = s.speed;
    this.updateAnimationFromState(s.animation);
    this._applyToRig();
  },

  // Blend the two snapshots bracketing the render time into targetPosition et al.
  _sampleBuffer: function () {
    const s = this.buffer.sample(SELF, this._now());
    if (!s) return;
    this.targetPosition.x = s.x;
    this.targetPosition.y = s.y;
    this.targetPosition.z = s.z;
    this.targetRotation = s.ry;
    this.targetSpeed = s.speed;
    // Animation state comes from the snapshot we are leaving, so the legs match the
    // motion we are actually rendering rather than a state 100ms in the future.
    this.updateAnimationFromState(s.animation);
  },

  setupAnimations: function () {
    const mesh = this.el.getObject3D("mesh");
    if (!mesh || !mesh.animations) {
      console.warn("[remote-avatar] No animations found in model");
      return;
    }

    const clips = mesh.animations;

    // Create animation mixer
    this.mixer = new AFRAME.THREE.AnimationMixer(mesh);

    // BY NAME FIRST, then the old fixed indices as a fallback.
    //
    // Those indices are Soldier.glb's layout (0 Idle, 3 Walk, 1 Run) and only ever
    // worked for that one file. The UT99 characters in assets/3d/characters carry
    // exactly three clips, in order Idle, Walk, Run — so index 1 is Walk there, and
    // the old code would have given every one of them the walk cycle as its run.
    const byName = (want) => clips.find((c) => c.name.toLowerCase() === want);
    const idleClip = byName("idle") || clips[0] || clips.find((c) => c.name.toLowerCase().includes("idle"));
    const walkClip = byName("walk") || clips[3] || clips.find((c) => c.name.toLowerCase().includes("walk"));
    const runClip = byName("run") || clips[1] || clips.find((c) => c.name.toLowerCase().includes("run"));

    if (!idleClip || !walkClip || !runClip) {
      console.warn("[remote-avatar] Missing required animation clips");

      // Try to use any available clips as fallback
      if (clips.length > 0) {
        this.actions.Idle = this.mixer.clipAction(clips[0]);
        this.actions.Walk = clips[1] ? this.mixer.clipAction(clips[1]) : this.actions.Idle;
        this.actions.Run = clips[2] ? this.mixer.clipAction(clips[2]) : this.actions.Idle;
      } else {
        return;
      }
    } else {
      this.actions.Idle = this.mixer.clipAction(idleClip);
      this.actions.Walk = this.mixer.clipAction(walkClip);
      this.actions.Run = this.mixer.clipAction(runClip);
    }

    // Configure actions
    Object.values(this.actions).forEach((action) => {
      action.setLoop(AFRAME.THREE.LoopRepeat, Infinity);
      action.enabled = true;
      action.setEffectiveTimeScale(1);
    });

    // ---- the firing twins, all optional ----
    // Newer character exports carry three more clips: 'Fire' (UT99's PlayRecoil, 8 frames
    // at 15 fps over the standing pose) and the *FR locomotion variants the engine swaps
    // in while the trigger is down. Older files carry only Idle/Walk/Run, every lookup
    // below comes back null, and this component then does exactly what it did before.
    this.fireActions = { Idle: null, Walk: null, Run: null };
    for (const channel of Object.keys(FIRE_VARIANT)) {
      const clip = byName(FIRE_VARIANT[channel].toLowerCase());
      if (!clip) continue;
      const a = this.mixer.clipAction(clip);
      a.enabled = true;
      a.setEffectiveTimeScale(1);
      a.setEffectiveWeight(0);
      if (channel === "Idle") {
        // The recoil is a ONE-SHOT, started per shot rather than here. clampWhenFinished
        // so it holds its last frame the way UE1 holds a finished sequence, instead of
        // snapping back to frame 0 while the hold is still routing weight into it.
        a.setLoop(AFRAME.THREE.LoopOnce, 1);
        a.clampWhenFinished = true;
      } else {
        // A locomotion twin runs forever alongside its plain version, at zero weight until
        // a shot. three.js does not advance a zero-weight action's time, which is exactly
        // why _syncVariantPhase has to carry the stride across on the swap.
        a.setLoop(AFRAME.THREE.LoopRepeat, Infinity);
        a.play();
      }
      this.fireActions[channel] = a;
    }

    // The recoil finishing is what tells the Idle channel to stop routing into it.
    if (this._onMixerFinished) this.mixer.removeEventListener("finished", this._onMixerFinished);
    this._onMixerFinished = (e) => {
      if (e.action === this.fireActions.Idle) this._recoilActive = false;
    };
    this.mixer.addEventListener("finished", this._onMixerFinished);

    // Start with idle
    this.actions.Idle.setEffectiveWeight(1);
    this.actions.Walk.setEffectiveWeight(0);
    this.actions.Run.setEffectiveWeight(0);

    this.actions.Idle.play();
    this.actions.Walk.play();
    this.actions.Run.play();
  },

  updateAnimationFromState: function (animationState) {
    if (!this.mixer || !this.actions.Idle) return;

    if (!animationState) {
      // No animation block was ever sent — derive one from the interpolated speed so
      // the avatar still animates instead of standing frozen while it slides around.
      //
      // Off GROUND_SPEED, the same way server/bots.js:181-182 and character.js:14 do
      // it, because the numbers that used to sit here (0.5 and 3) were written when a
      // run was a different number of units per second. A remote player sprinting at
      // 9.4 cleared the old 3 easily, so the bug never showed — but 3 was 32% of a
      // run, and the rest of the codebase agrees a run starts at 53%.
      const s = this.targetSpeed || 0;
      const run = GAME_CONFIG.MOVEMENT.GROUND_SPEED * 0.53;
      const move = 0.2;
      this.target = { Idle: s < move ? 1 : 0, Walk: s >= move && s < run ? 1 : 0, Run: s >= run ? 1 : 0 };
      return;
    }

    this.target = {
      Idle: animationState.idle || 0,
      Walk: animationState.walk || 0,
      Run: animationState.run || 0,
    };
  },

  _applyToRig: function () {
    const rig = this.el.parentElement;
    if (!rig || !rig.object3D) return;
    rig.object3D.position.set(this.lastPosition.x, this.lastPosition.y + (this.groundOffset || 0), this.lastPosition.z);
    rig.object3D.rotation.set(0, this.lastRotation, 0);
  },

  /** See FEET ON THE FLOOR YOU CAN SEE at the top of the file. dt in seconds. */
  _groundToFloor: function (dt) {
    let want = 0;
    const meshes = getWorldColliders(this.el.sceneEl);
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
  },

  tick: function (time, deltaTime) {
    if (!this.data.enabled) return;

    const rig = this.el.parentElement;
    if (!rig || !rig.object3D) return;

    // Interpolate the network snapshots into this frame's target pose
    this._sampleBuffer();

    // Residual smoothing — set object3D directly (no setAttribute overhead)
    const lerp = Math.min(this.data.smoothing * (deltaTime / 16.67), 1);
    this.lastPosition.x += (this.targetPosition.x - this.lastPosition.x) * lerp;
    this.lastPosition.y += (this.targetPosition.y - this.lastPosition.y) * lerp;
    this.lastPosition.z += (this.targetPosition.z - this.lastPosition.z) * lerp;

    // Shortest-path yaw so the avatar never spins the long way round
    this.lastRotation = lerpYaw(this.lastRotation, this.targetRotation, lerp);
    this.currentSpeed += (this.targetSpeed - this.currentSpeed) * lerp;

    this._groundToFloor(Math.min(Math.max((deltaTime || 0) / 1000, 0), 1 / 20));
    this._applyToRig();

    // Update animations
    const dt = deltaTime / 1000;
    if (this.mixer) {
      this.mixer.update(dt);

      // AFTER the mixer, so the phase sync inside reads times that are current, and
      // BEFORE the blend, so this frame's weights are routed by this frame's mix.
      this._advanceFireMix(dt);

      const fadeLerp = 1 - Math.exp((-10 * deltaTime) / 1000);
      this.blendAnimations(fadeLerp);
    }

    this._followWeaponAnchor();

    // The held weapon animates on its own clock — a static mesh has no mixer to tick, so
    // in the common case this loop does nothing at all.
    for (let i = 0; i < this._weaponSlots.length; i++) {
      const m = this._weaponSlots[i] && this._weaponSlots[i].__thirdMixer;
      if (m) m.update(dt);
    }
  },

  blendAnimations: function (lerpFactor) {
    if (!this.actions.Idle) return;

    // Weights are SUMMED into this map before any of them is written, because two
    // channels can land on the same action: the older glTFs alias Walk and Run onto Idle
    // in the fallback branch of setupAnimations, and a channel with no FR twin routes its
    // whole weight back into its plain clip. Writing as we went would let the last channel
    // silently overwrite the first.
    const acc = this._actionWeights;
    acc.clear();

    const keys = Object.keys(this.weights);
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      const plain = this.actions[key];
      if (!plain || this.target[key] === undefined) continue;
      this.weights[key] += (this.target[key] - this.weights[key]) * lerpFactor;
      const w = this.weights[key];

      // The FR twin is an ALTERNATE of this channel, never a fourth weight: the channel's
      // own weight is split between the plain clip and its twin by the crossfade, so the
      // three channels still sum to one however far through a swap the body is.
      let twin = this.fireActions[key];
      // Idle routes into the recoil only while a recoil is actually running. A pawn that
      // fired mid-run and then stopped must not have PlayRecoil fade in underneath it half
      // a second after the shot — UE1 calls PlayRecoil at the moment of firing or not at all.
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
    const variants = Object.keys(FIRE_VARIANT);
    for (let i = 0; i < variants.length; i++) {
      const twin = this.fireActions[variants[i]];
      if (twin && !acc.has(twin)) acc.set(twin, 0);
    }

    for (const [action, w] of acc) action.setEffectiveWeight(w);
  },

  /**
   * Ease the plain <-> FR crossfade for this frame. `dt` in seconds.
   *
   * The MOVING test reads the TARGET weights rather than the eased ones: that block is
   * the server's own idle/walk/run for this pawn, and it is what the legs are heading
   * for — deciding a recoil off a weight that is still 200 ms behind the wire would give
   * a sprinting player the standing pose.
   */
  _advanceFireMix: function (dt) {
    const moving = (this.target.Idle || 0) < STANDING_IDLE_WEIGHT;
    const st = fireState(this._now(), this._lastShot, moving, FIRE_HOLD_MS);

    // Phase first, while the mix may still be parked at an end — see _syncVariantPhase.
    this._syncVariantPhase();

    // The hold lapsing is the only "trigger up" this client ever gets.
    if (!st.firing && this._weaponLooping) this._stopWeaponLoops();

    const want = st.firing ? 1 : 0;
    this.fireMix += (want - this.fireMix) * (FIRE_CROSSFADE > 0 ? Math.min(dt / FIRE_CROSSFADE, 1) : 1);
    // Snap the last sliver so the mix actually reaches an end and the phase sync below
    // can run; an exponential approach alone would leave it at 0.001 for ever.
    if (Math.abs(this.fireMix - want) < 0.002) this.fireMix = want;
  },

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
  _syncVariantPhase: function () {
    const toTwin = this.fireMix <= 0.001;
    const toPlain = this.fireMix >= 0.999;
    if (!toTwin && !toPlain) return;
    // Idle is deliberately not in here: its twin is the one-shot recoil, which owns its
    // own timeline and is restarted per shot.
    const channels = ["Walk", "Run"];
    for (let i = 0; i < channels.length; i++) {
      const plain = this.actions[channels[i]];
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
  },

  /**
   * This player pulled the trigger — from a `fire` message or a `projectile` one.
   *
   * Restarts the hold that keeps the FR locomotion swapped in, plays UT99's PlayRecoil
   * over the standing pose for a body that is not moving, and plays the held weapon's own
   * fire sequence if its mesh has one (only the Enforcer's AutoHand does).
   */
  onFire: function () {
    const now = this._now();
    const since = this._prevShot > 0 || this._lastShot > 0 ? now - this._lastShot : Infinity;
    this._prevShot = this._lastShot;
    this._lastShot = now;

    const moving = (this.target.Idle || 0) < STANDING_IDLE_WEIGHT;
    const recoil = this.fireActions.Idle;
    if (recoil && !moving) {
      // reset() re-arms a clamped one-shot, so a burst recoils once per round rather than
      // sitting on the last frame of the first. It also sets the weight to 1, which
      // blendAnimations owns — put it straight back to 0 or the pose pops for one frame.
      recoil.reset();
      recoil.setEffectiveWeight(0);
      recoil.play();
      this._recoilActive = true;
    }

    this._fireWeaponAnim(since);
  },

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
  _dressWeapon: function () {
    const rig = this.el.parentElement;
    const ds = (rig && rig.dataset) || {};
    const id = ds.weapon || DEFAULT_WEAPON;
    const dual = !!ds.dual;
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
        if (spare) spare.setAttribute("visible", false);
        continue;
      }
      const slot = this._ensureWeaponSlot(i);
      slot.setAttribute("visible", true);
      const url = `url(${model})`;
      if (slot.__thirdUrl === url) continue; // same mesh, already loaded or loading
      slot.__thirdUrl = url;
      this._disposeWeaponAnim(slot);
      slot.addEventListener("model-loaded", () => this._onWeaponLoaded(slot, url, third), { once: true });
      slot.setAttribute("gltf-model", url);
    }
  },

  /**
   * THE GUN FOLLOWS THE HAND. UE1 draws a pawn's carried weapon at its mesh's WEAPON
   * TRIANGLE — three special vertices in the gun hand that are animated with every other
   * vertex, so the gun swings with the arm through the run. The character glTFs carry
   * that triangle as an empty node "weaponAnchor" (sibling of the mesh, in the same space
   * as this entity) with translation and rotation tracks on every clip, keyed on the same
   * times as the morph weights; the mixer moves it for free. Each frame the held slot is
   * simply placed where the anchor is. The base-pose hand is 85 cm from the sprinting
   * Soldier's swung hand, so the static offset (weaponOffset, the fallback for a body
   * file without the node) is not a substitute.
   *
   * The dual pair's second gun is the mirror: X negated and the rotation reflected across
   * the body's YZ plane, on top of the slot's own scale.x = -1.
   */
  _followWeaponAnchor: function () {
    if (!this._weaponSlots.length) return;
    if (this._anchor === undefined) {
      const mesh = this.el.getObject3D("mesh");
      this._anchor = mesh ? mesh.getObjectByName("weaponAnchor") || null : undefined;
    }
    const a = this._anchor;
    if (!a) return;
    for (let i = 0; i < this._weaponSlots.length; i++) {
      const slot = this._weaponSlots[i];
      if (!slot || !slot.object3D) continue;
      const o = slot.object3D;
      o.position.copy(a.position);
      o.quaternion.copy(a.quaternion);
      if (i === 1) {
        o.position.x = -o.position.x;
        o.quaternion.set(a.quaternion.x, -a.quaternion.y, -a.quaternion.z, a.quaternion.w);
      }
    }
  },

  /** One held-weapon slot, reused for the life of the avatar. */
  _ensureWeaponSlot: function (i) {
    const existing = this._weaponSlots[i];
    if (existing) return existing;
    const slot = document.createElement("a-entity");
    slot.classList.add("held-weapon");
    // The weapon glTFs are built at the pawn's ACTOR origin, and UE1 draws the carried
    // weapon at the pawn mesh's weapon triangle — three special vertices in the gun hand.
    // characters.js ships that hand's offset per model (base pose) and network.js writes it
    // onto the rig; the slot sits there. Without it the gun hangs at the hip.
    const off = String((this.el.parentElement && this.el.parentElement.dataset.weaponOffset) || "0 0 0");
    slot.setAttribute("position", off);
    slot.setAttribute("rotation", "0 0 0");
    // A NEGATIVE x scale is the mirror, the same trick first-person-weapon.js uses for the
    // left-hand Enforcer: rotating the mesh 180 degrees instead would point the gun
    // backwards. Slot 0 is the weapon; slot 1 only ever exists while dual-wielding.
    slot.setAttribute("scale", i === 1 ? "-1 1 1" : "1 1 1");
    slot.setAttribute("shadow", "cast:true; receive:false");
    // A CHILD OF THE MODEL, not of the rig: this.el carries modelYaw, and the rig's
    // rotation is overwritten from the wire on every pose.
    this.el.appendChild(slot);
    this._weaponSlots[i] = slot;
    return slot;
  },

  /** The held mesh is in: fix the mirrored winding and build its mixer, if it has clips. */
  _onWeaponLoaded: function (slot, url, third) {
    if (slot.__thirdUrl !== url) return; // swapped again while this was loading
    const mesh = slot.getObject3D("mesh");
    if (!mesh) return;

    if (slot === this._weaponSlots[1]) {
      // A negative scale flips the handedness of the transform, so every triangle winds
      // the other way. three.js already compensates by reading matrixWorld's determinant;
      // this is belt and braces against a material that arrives with FrontSide baked in
      // some other way. A held gun is a few hundred triangles — drawing both sides is free.
      mesh.traverse((o) => {
        if (!o.isMesh || !o.material) return;
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        for (let i = 0; i < mats.length; i++) mats[i].side = AFRAME.THREE.DoubleSide;
      });
    }

    // Only the Enforcer's AutoHand carries fire sequences ('Shoot', 'shot2'); every other
    // held mesh is static and gets no mixer at all rather than an idle one to tick.
    const anims = third && third.anims;
    if (!anims || !mesh.animations || !mesh.animations.length) return;
    slot.__thirdMixer = new AFRAME.THREE.AnimationMixer(mesh);
    slot.__thirdClips = mesh.animations;
    slot.__thirdAnims = anims;
  },

  /**
   * Play the held weapon's own fire sequence, once, for this shot.
   * `sinceMs` is the gap since the previous shot — it picks 'shot2' over 'Shoot'.
   */
  _fireWeaponAnim: function (sinceMs) {
    for (let i = 0; i < this._weaponSlots.length; i++) {
      const slot = this._weaponSlots[i];
      if (!slot || !slot.__thirdMixer) continue;
      const spec = pickFireClip(slot.__thirdAnims, sinceMs);
      if (!spec || !spec.clip) continue;
      const clip = AFRAME.THREE.AnimationClip.findByName(slot.__thirdClips, spec.clip);
      if (!clip) continue;
      const action = slot.__thirdMixer.clipAction(clip);
      // The Shock Rifle and the Ripper LoopAnim their fire sequence while the trigger is
      // DOWN rather than playing it once a shot; re-triggering every round would restart
      // the swing mid-stroke, so an already-running loop is left alone. _stopWeaponLoops
      // puts it down when the hold lets go, which is this client's only signal that the
      // trigger came up.
      const loops = !!(slot.__thirdAnims && slot.__thirdAnims.fireLoops);
      if (loops && action.isRunning()) continue;
      action.reset();
      action.setLoop(loops ? AFRAME.THREE.LoopRepeat : AFRAME.THREE.LoopOnce, loops ? Infinity : 1);
      // UE1 holds the last frame of a finished sequence until something else plays.
      action.clampWhenFinished = !loops;
      // UnrealScript's PlayAnim rate IS a time scale, and the clip is authored at the
      // sequence's native fps — so nothing else has to be converted. Same mapping as
      // view-weapon-anim.js makes for the first-person meshes.
      action.timeScale = typeof spec.rate === "number" && spec.rate > 0 ? spec.rate : 1;
      action.play();
      if (loops) this._weaponLooping = true;
    }
  },

  /** The shots stopped: put down any fire sequence that was looping. */
  _stopWeaponLoops: function () {
    this._weaponLooping = false;
    for (let i = 0; i < this._weaponSlots.length; i++) {
      const slot = this._weaponSlots[i];
      if (slot && slot.__thirdMixer) slot.__thirdMixer.stopAllAction();
    }
  },

  _disposeWeaponAnim: function (slot) {
    if (!slot || !slot.__thirdMixer) return;
    slot.__thirdMixer.stopAllAction();
    const mesh = slot.getObject3D("mesh");
    if (mesh) slot.__thirdMixer.uncacheRoot(mesh);
    slot.__thirdMixer = null;
    slot.__thirdClips = null;
    slot.__thirdAnims = null;
  },

  remove: function () {
    for (let i = 0; i < this._skinTextures.length; i++) {
      this._skinTextures[i].tex.dispose();
      this._skinTextures[i].mat.dispose();
    }
    this._skinTextures.length = 0;
    for (let i = 0; i < this._weaponSlots.length; i++) this._disposeWeaponAnim(this._weaponSlots[i]);
    this._weaponSlots.length = 0;
    this.el.removeEventListener("model-loaded", this._onModelLoaded);
    if (this._scene && this._onPlayerTeam) this._scene.removeEventListener("player-team", this._onPlayerTeam);
    if (this._scene && this._onLoadout) this._scene.removeEventListener("player-loadout", this._onLoadout);
    if (this._scene && this._onRemoteFire) this._scene.removeEventListener("remote-fire", this._onRemoteFire);
    this.clearTeamTint();
    this.buffer.clear();
    if (this.mixer) {
      if (this._onMixerFinished) this.mixer.removeEventListener("finished", this._onMixerFinished);
      this.mixer.stopAllAction();
      const mesh = this.el.getObject3D("mesh");
      if (mesh) this.mixer.uncacheRoot(mesh);
      this.mixer = null;
    }
    this.actions = {};
    this.fireActions = { Idle: null, Walk: null, Run: null };
  },
});
