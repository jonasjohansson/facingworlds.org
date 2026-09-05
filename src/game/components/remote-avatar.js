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

    // ---- team tint ----
    // Materials we swapped in, so remove() can put the originals back and dispose ours.
    this._tinted = [];
    this._tintedTeam = null;

    // Wait for GLTF model to load
    this._onModelLoaded = () => {
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
    if (this.mixer) {
      this.mixer.update(deltaTime / 1000);

      const fadeLerp = 1 - Math.exp((-10 * deltaTime) / 1000);
      this.blendAnimations(fadeLerp);
    }
  },

  blendAnimations: function (lerpFactor) {
    if (!this.actions.Idle) return;

    const keys = Object.keys(this.weights);
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      if (this.actions[key] && this.target[key] !== undefined) {
        this.weights[key] += (this.target[key] - this.weights[key]) * lerpFactor;
        this.actions[key].setEffectiveWeight(this.weights[key]);
      }
    }
  },

  remove: function () {
    for (let i = 0; i < this._skinTextures.length; i++) {
      this._skinTextures[i].tex.dispose();
      this._skinTextures[i].mat.dispose();
    }
    this._skinTextures.length = 0;
    this.el.removeEventListener("model-loaded", this._onModelLoaded);
    if (this._scene && this._onPlayerTeam) this._scene.removeEventListener("player-team", this._onPlayerTeam);
    this.clearTeamTint();
    this.buffer.clear();
    if (this.mixer) {
      this.mixer.stopAllAction();
      const mesh = this.el.getObject3D("mesh");
      if (mesh) this.mixer.uncacheRoot(mesh);
      this.mixer = null;
    }
    this.actions = {};
  },
});
