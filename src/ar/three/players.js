import * as THREE from "three";
import { clone as cloneSkinned } from "../vendor/utils/SkeletonUtils.js";
import { AR_CONFIG } from "../config/ar-config.js";
import { createGLTFLoader, loadFirstAvailable, disposeModel } from "./assets.js";
import { modelUrl, skinUrls } from "../../shared/characters.js";

// The live spectator table.
//
// Every player connected to the game server gets a figure standing on the AR map, in
// real time. This is the whole reason the AR page exists as something other than a
// model viewer.
//
// COORDINATES - the part that is easy to get wrong. Player poses arrive in game world
// coordinates. The game places the Facing Worlds glTF at the identity transform (see
// #world in index.html), so game world coordinates and map-model coordinates are the
// same numbers. This class therefore parents every figure to the SAME node the map
// model hangs from - the node that carries the measured fit scale and centring offset
// from model-fit.js - and writes raw pose coordinates straight into it. No second
// transform, no hardcoded 0.05: if the map moves, scales or is re-exported, the
// figures move with it because they are in its coordinate system.
//
// FIGURES. The real Soldier model, with its Idle/Walk/Run clips driven by the
// `speed` the poses already carry, so a figure walks and runs on the rock rather
// than sliding. It was capsules first, on size arithmetic: the map is ~111 game
// units across and is fitted to 3.2 marker units, so a life-sized player stands
// only a few millimetres tall on the print and a skinned character is being asked
// to render at a handful of pixels while the phone also runs camera capture and
// image tracking. That reasoning was sound: a capsule reads as a blob, and the
// blob is what people notice. So: the model, with the cost capped.
//
// The cap is AR_CONFIG.avatar.maxSkinned. Each skinned figure costs a cloned
// skeleton and a mixer advanced every frame; past the cap, and if the model
// fails to load at all, figures fall back to the capsule build below and the
// table keeps working.
//
// Either way the figure is inflated by AR_CONFIG.avatar.scale so it reads like
// a wargaming piece. Positions are NOT inflated, so a figure always stands
// exactly where its player stands.
//
// ON-DEVICE COST IS STILL UNMEASURED. The cap and the capsule fallback exist
// because this was built without a phone to profile on. If figures stutter,
// lower maxSkinned before reaching for anything else.

// Resolved against THIS module's URL (src/ar/three/), not against the page.
const SPECTATOR_CLIENT_URL = "../../shared/net/spectator-client.js";

// TEAMS. The match is Capture the Flag and the single most important thing a
// spectator has to read off a three-millimetre figure is which side it is on, so
// team colour REPLACES the id-cycled palette for anyone the server has put on a
// team. The palette survives only for a teamless player - which, in CTF, means a
// player seen before their `hello`/`join` carried a team, or a server running a
// mode without them.
//
// Applied as diffuse AND emissive together, from ar-config. Diffuse alone loses
// the read whenever a figure is on the shadowed side of the rock; emissive alone
// flattens the soldier into a glowing silhouette. Both, at the modest emissive
// fraction in config, keeps a lit soldier that is unmistakably red or blue.
const TEAMS = ["red", "blue"];

// NAME LABELS, on or off, for the whole table.
//
// Module-level rather than per-table on purpose: this is a viewer's preference,
// and it has to survive a SpectatorTable being rebuilt underneath them - which
// happens on a scene teardown and rebuild, not just on a reload. Session-scoped by
// construction: a reload starts from `true` again, which is the right default
// because a table full of anonymous figures is not obviously readable.
//
// The toggle itself is a tap on the AR canvas, wired in scene.js - the canvas is
// the one surface with nothing else on it, so a tap there cannot mean anything
// else.
let labelsVisible = true;

/** Whether name labels are currently shown. */
export function labelsAreVisible() {
  return labelsVisible;
}

export class SpectatorTable {
  /**
   * @param {THREE.Object3D} worldGroup node whose local space is game world space
   */
  constructor(worldGroup) {
    this.worldGroup = worldGroup;
    this.players = new Map();
    this.connection = null;
    this.buffer = null;
    this.status = "offline";
    this.onStatusChange = null;
    this.disposed = false;

    const cfg = AR_CONFIG.avatar;

    // Shared geometry. Created once, never disposed per player, disposed with the
    // table. Low segment counts on purpose - these render a few pixels tall.
    const bodyLength = Math.max(cfg.height - 2 * cfg.radius, 0.01);
    this.bodyGeometry = new THREE.CapsuleGeometry(cfg.radius, bodyLength, 3, 8);
    this.bodyGeometry.translate(0, cfg.height / 2, 0);

    // A small nose so heading is readable. Cones point +Y; rotate to -Z, which is the
    // direction an object with rotation.y = ry faces, matching the game exactly.
    this.noseGeometry = new THREE.ConeGeometry(cfg.radius * 0.55, cfg.radius * 1.6, 5);
    this.noseGeometry.rotateX(-Math.PI / 2);
    this.noseGeometry.translate(0, cfg.height * 0.62, -cfg.radius * 1.1);

    this.deadColor = new THREE.Color(cfg.deadColor);
    this.palette = cfg.colors.map((hex) => new THREE.Color(hex));
    this.nextColor = 0;

    // Parsed once. setStyle() takes CSS rgb() through three's colour management,
    // which is what every other colour on this page goes through.
    this.teamColors = {};
    for (const team of TEAMS) {
      const css = (cfg.teamColors && cfg.teamColors[team]) || "#888888";
      this.teamColors[team] = new THREE.Color().setStyle(css);
    }
    this.teamEmissive = typeof cfg.teamEmissive === "number" ? cfg.teamEmissive : 0.42;
    this.black = new THREE.Color(0x000000);

    // CTF. The table owns the socket, so the match messages land here first and
    // are relayed to whoever cares - the flags in the scene, and the HUD. Both are
    // set by scene.js; either being unset is fine and simply means nobody is
    // drawing that part.
    this.onFlagState = null; // (flag) => void, one flag's authoritative state
    this.onMatchState = null; // (match) => void, { scores, capLimit, state, winner }
    this.match = { scores: { red: 0, blue: 0 }, capLimit: 0, state: "playing", winner: null };

    // The roster line in the HUD. Coalesced rather than pushed per change - one
    // `hello` announces a whole lobby, and each of those is a name AND a team AND
    // a spawn - and NOT driven off the render loop: figures only move while the
    // marker is tracked, but the HUD is on screen either way, so a roster that
    // waited for update() would freeze the moment the print left frame.
    this.onRosterChange = null;
    this.rosterDirty = false;
    this.rosterTimer = null;

    // Muzzle flash. A camera-facing quad, additive and
    // unlit, so it reads as a light source rather than a lit surface. One
    // geometry and one material shared by every figure — the flash is
    // the same colour for everyone, so nothing here is per-player.
    //
    // A spectator is told who shot, never where it landed: hit
    // resolution is a separate message against a victim, so a tracer would
    // have to be re-traced against the map on the phone. At a few
    // millimetres long a tracer is a smear anyway; a bright pip at the
    // shooter is what reads at this scale.
    // A Sprite, so it faces the camera on its own — a quad would need
    // its orientation rewritten every frame, and seen edge-on it
    // vanishes. Shared by every figure: the flash is on or off, never
    // part-way, so nothing here is per-player and one material does.
    this.flashMaterial = new THREE.SpriteMaterial({
      color: new THREE.Color(cfg.flash.color),
      transparent: true,
      blending: THREE.AdditiveBlending,
      // Additive over the camera feed and the map, and never an
      // occluder: a flash is light, not a thing.
      depthWrite: false,
      toneMapped: false,
    });

    // The skinned model. Loaded once, cloned per player. Loading is
    // best-effort and off the critical path: figures appear as capsules the
    // moment a player joins and are upgraded in place when the model lands,
    // so a slow or failed download never delays or blocks the table.
    // ONE MODEL PER CHARACTER, not one model for everybody. The server assigns each
    // player a UT99 body (server/characters.js) and the game view draws it; a table
    // where every figure is the same soldier no longer matches what the players see.
    // Keyed by model URL, so four bots wearing the same model share one download and
    // one measurement, and only the skin textures differ between them.
    this.models = new Map(); // url -> { gltf, scale, footY } once loaded
    this.modelPending = new Map(); // url -> Promise, so two players never race a load
    this.mixers = new Set();
    this.modelLoader = null;
  }

  /**
   * A skin texture, loaded once and shared by every figure that wears it.
   *
   * Shared on purpose: the texture is immutable here — the team colour rides on the
   * material's colour and emissive, which _applyTint writes per clone — so four bots
   * in the same skin cost one upload rather than four.
   */
  _skinTexture(url) {
    if (!this._skinTextures) this._skinTextures = new Map();
    let tex = this._skinTextures.get(url);
    if (tex) return tex;
    if (!this._texLoader) this._texLoader = new THREE.TextureLoader();
    tex = this._texLoader.load(url);
    if (THREE.SRGBColorSpace) tex.colorSpace = THREE.SRGBColorSpace;
    tex.flipY = false; // matches the glTF UV origin our exporter writes
    this._skinTextures.set(url, tex);
    return tex;
  }

  /**
   * Load one character model, once, and upgrade any figure already waiting on it.
   *
   * Never throws: the table must survive a missing file or a dead network, and a
   * capsule is a complete figure, just a duller one.
   */
  _loadModelFor(url) {
    if (!url) return Promise.resolve(null);
    if (this.models.has(url)) return Promise.resolve(this.models.get(url));
    if (this.modelPending.has(url)) return this.modelPending.get(url);

    if (!this.modelLoader) this.modelLoader = createGLTFLoader();
    const p = loadFirstAvailable(this.modelLoader, [url], "avatar")
      .then((gltf) => {
        if (this.disposed) return null;
        // Measure the model ONCE, here, with its matrices forced up to date. A fresh
        // clone's bone matrices are unset, so Box3.setFromObject on a clone collapses
        // to ~0 and any per-clone fit silently does nothing. Measured on the source it
        // is honest, and every clone reuses the number for free.
        gltf.scene.updateWorldMatrix(true, true);
        const box = new THREE.Box3().setFromObject(gltf.scene);
        const h = box.max.y - box.min.y;
        const scale = h > 0.01 ? AR_CONFIG.avatar.height / h : 1;
        const rec = { gltf, scale, footY: box.min.y * scale };
        this.models.set(url, rec);
        // Anyone who joined while this was in flight is still a capsule.
        for (const entry of this.players.values()) {
          if (entry.modelUrl === url) this._upgradeToModel(entry);
        }
        return rec;
      })
      .catch((err) => {
        console.warn("[players] character model unavailable, using capsule:", url, err);
        return null;
      })
      .finally(() => this.modelPending.delete(url));
    this.modelPending.set(url, p);
    return p;
  }

  /** Swap a placed capsule figure for a skinned one, keeping its pose. */
  _upgradeToModel(entry) {
    const rec = entry.modelUrl ? this.models.get(entry.modelUrl) : null;
    if (!rec || entry.skinned || this.mixers.size >= AR_CONFIG.avatar.maxSkinned) {
      return;
    }

    const skinned = this._buildSkinned(rec, entry.skinUrls);
    if (!skinned) {
      return;
    }

    // Drop the capsule body, keep the group/tilt/label rig intact so the
    // pose, the bob state and the name label all carry straight over.
    entry.tilt.remove(entry.capsuleBody);
    entry.tilt.remove(entry.capsuleNose);
    entry.tilt.add(skinned.root);

    entry.skinned = skinned;
    // The clone's materials are fresh and untinted; give them this player's
    // team colour before the next frame draws them white.
    this._applyTint(entry);
    // The model animates its own footfalls; the sine bob was standing in
    // for exactly that and now fights it.
    entry.tilt.position.y = 0;
  }

  /**
   * Clone the loaded model for one player and wire up its clips.
   * Returns null if anything is missing, so the caller keeps its capsule.
   */
  _buildSkinned(rec, skinUrls) {
    if (!rec) return null;

    const cfg = AR_CONFIG.avatar;
    const root = cloneSkinned(rec.gltf.scene);

    // Geometry and skeleton are per-clone; the material is shared with the
    // source until we tint it, so clone it per player and track it for
    // disposal. Lambert for the same reason as the capsules: these are a
    // few dozen pixels tall and a full PBR shade buys nothing legible.
    const materials = [];
    root.traverse((obj) => {
      if (!obj.isMesh && !obj.isSkinnedMesh) return;
      obj.castShadow = true;
      obj.receiveShadow = false;
      const src = Array.isArray(obj.material) ? obj.material[0] : obj.material;
      // A FRESH material per mesh per player. The shared glTF material is never
      // touched and never assigned: mutating it would repaint every figure on
      // the table the colour of whichever player was tinted last. The texture is
      // reused (it is immutable and shared on purpose); the colour and emissive
      // that carry the team are per-clone, and _applyTint writes them.
      // The skin. Each UT99 model has one material slot per texture, named slotN by
      // the exporter, and the variant decides which set of textures goes on them —
      // so two bots on the same model wear different faces. Falls back to whatever
      // the glTF itself referenced when no skin was assigned.
      let map = src && src.map ? src.map : null;
      if (skinUrls && skinUrls.length) {
        const slot = /slot(\d+)$/.exec((src && src.name) || "");
        const url = skinUrls[slot ? Number(slot[1]) : materials.length];
        if (url) {
          const tex = this._skinTexture(url);
          if (tex) map = tex;
        }
      }
      const mat = new THREE.MeshLambertMaterial({
        color: 0xffffff,
        emissive: 0x000000,
        map,
      });
      obj.material = mat;
      materials.push(mat);
    });

    // The clip set is on the glTF root, not on the cloned nodes.
    const mixer = new THREE.AnimationMixer(root);
    const clipsBy = {};
    for (const [key, name] of Object.entries(cfg.clips)) {
      const clip = THREE.AnimationClip.findByName(rec.gltf.animations || [], name);
      if (clip) {
        const action = mixer.clipAction(clip);
        action.play();
        action.setEffectiveWeight(key === "idle" ? 1 : 0);
        clipsBy[key] = action;
      }
    }

    this.mixers.add(mixer);

    // Scale and foot offset were measured once from the source model in
    // _loadModel(); do NOT re-measure here. A clone's bone matrices are
    // unset until it has been through a render, so Box3.setFromObject on
    // it collapses to ~0 and the fit silently does nothing.
    root.scale.setScalar(rec.scale);
    root.position.y = -rec.footY;

    return { root, mixer, clips: clipsBy, materials };
  }

  // --- connection ---------------------------------------------------------------

  /**
   * Connect to the game server as a read-only spectator.
   *
   * Everything here is best-effort. A missing module, an unreachable server or a
   * server that never speaks must leave the AR page working as a static model viewer -
   * tracking is the thing users came for and it does not depend on the network at all.
   *
   * @param {string} url ws:// or wss:// URL of the game server
   */
  async connect(url) {
    if (!AR_CONFIG.spectator.enabled || this.disposed) {
      return;
    }

    let connectSpectator;
    try {
      ({ connectSpectator } = await import(SPECTATOR_CLIENT_URL));
    } catch (error) {
      console.warn("[ar-spectator] client module unavailable, staying offline:", error && error.message);
      this._setStatus("offline");
      return;
    }

    // The dynamic import above is a network round trip, and the AR session can end
    // inside it. Opening a socket after dispose() would leak one that reconnects for
    // the rest of the page's life, because nothing holds a handle to close it.
    if (this.disposed) {
      return;
    }

    try {
      this.connection = connectSpectator(url, {
        onStatus: (state) => this._setStatus(state),
        onHello: (players) => {
          this._clearPlayers();
          for (const player of players || []) {
            this._addPlayer(player);
          }
        },
        onJoin: (player) => this._addPlayer(player),
        onSpawn: (player) => this._addPlayer(player),
        onRespawn: (player) => {
          const entry = this._addPlayer(player);
          if (entry) {
            this._setAlive(entry, true);
          }
        },
        onLeave: (id) => this._removePlayer(id),
        onName: (id, name) => {
          const entry = this.players.get(id);
          if (entry) {
            this._setLabel(entry, name);
          }
        },
        // --- capture the flag ---
        // The socket lives here, so the match arrives here and is handed on. The
        // table itself only uses `team`; the flags and the HUD are the consumers,
        // and both are optional.
        onCtf: (ctf) => this._applyCtf(ctf),
        onFlag: (flag) => this._applyFlag(flag),
        onScore: (scores) => {
          this.match.scores = { red: scores.red || 0, blue: scores.blue || 0 };
          this._emitMatch();
        },
        onTeam: (id, team) => {
          const entry = this.players.get(id);
          if (entry) {
            this._setTeam(entry, team);
          }
        },
        onMatchEnd: (m) => {
          this.match.state = "ended";
          this.match.winner = m.winner || null;
          if (m.scores) this.match.scores = { red: m.scores.red || 0, blue: m.scores.blue || 0 };
          this._emitMatch();
        },
        onFire: (id) => {
          const entry = this.players.get(id);
          if (entry) entry.flashUntil = AR_CONFIG.avatar.flash.fadeMs;
        },
        onDeath: (id) => {
          const entry = this.players.get(id);
          if (entry) {
            this._setAlive(entry, false);
          }
        },
        // Poses are pushed into the snapshot buffer by the client itself; this hook
        // exists only so a player who was never announced still gets a figure.
        onPose: (id) => {
          if (!this.players.has(id)) {
            this._addPlayer({ id });
          }
        },
      });
      this.buffer = this.connection ? this.connection.buffer : null;
      if (this.buffer) {
        // connectSpectator constructs the buffer with its own defaults; the AR page
        // wants a slightly longer render delay than the game does, because a phone
        // holding a marker is far more sensitive to a hitch than to 20 ms of lag.
        this.buffer.delayMs = AR_CONFIG.spectator.delayMs;
        this.buffer.maxExtrapolationMs = AR_CONFIG.spectator.maxExtrapolationMs;
      }
    } catch (error) {
      console.warn("[ar-spectator] connection failed, staying offline:", error && error.message);
      this._setStatus("offline");
    }
  }

  _setStatus(state) {
    this.status = state;
    if (this.onStatusChange) {
      this.onStatusChange(state, this.players.size);
    }
  }

  // --- capture the flag ---------------------------------------------------------

  /**
   * A wholesale replacement of the match: `hello` on connect, `match-reset` after
   * a decided one. Both carry a full publicCtf(), so nothing has to be reconciled
   * against what was on screen a moment ago - which is the point, because after a
   * reconnect the player ids are new and after a reset the scores are not.
   */
  _applyCtf(ctf) {
    if (!ctf) return;
    this.match = {
      scores: { red: (ctf.scores && ctf.scores.red) || 0, blue: (ctf.scores && ctf.scores.blue) || 0 },
      capLimit: ctf.capLimit || 0,
      state: ctf.state || "playing",
      winner: ctf.winner || null,
    };
    for (const flag of ctf.flags || []) {
      this._applyFlag(flag);
    }
    this._emitMatch();
  }

  /**
   * One flag's authoritative state, from `hello.ctf.flags` or from a `flag`
   * broadcast - the same shape either way (publicFlag), which is why there is one
   * code path.
   *
   * `carrier` is also mirrored onto the player entries, because the figure and the
   * flag are two halves of the same fact and a roster row wants to say who has it.
   */
  _applyFlag(flag) {
    if (!flag || !flag.team) return;

    const carrier = flag.state === "carried" ? flag.carrier || null : null;
    let changed = false;
    for (const entry of this.players.values()) {
      const holds = entry.id === carrier ? flag.team : entry.flag === flag.team ? null : entry.flag;
      if (holds !== entry.flag) {
        entry.flag = holds;
        changed = true;
      }
    }
    if (changed) this._touchRoster();

    if (this.onFlagState) {
      this.onFlagState(flag);
    }
  }

  _emitMatch() {
    this._touchRoster();
    if (this.onMatchState) {
      this.onMatchState(this.match);
    }
  }

  /**
   * The node a carried flag rides on: the figure's own group, INSIDE the avatar
   * scale, so a flag parented here is inflated by exactly as much as the soldier
   * holding it and its carry offset is quoted in the same game-units-before-scale
   * everything else on the figure is. Returns null for a player who has no figure
   * yet, and the caller retries - a `flag` naming a carrier can beat that
   * carrier's own `join` onto the wire.
   *
   * @param {string} id
   * @returns {THREE.Object3D|null}
   */
  carrierNode(id) {
    const entry = this.players.get(id);
    return entry ? entry.carry : null;
  }

  /**
   * Something in the roster changed. Coalesced onto a timeout rather than pushed
   * immediately: a single `hello` adds every player and names and teams each of
   * them, and every one of those would otherwise be its own DOM rebuild.
   */
  _touchRoster() {
    this.rosterDirty = true;
    if (this.rosterTimer || !this.onRosterChange) {
      return;
    }
    this.rosterTimer = setTimeout(() => {
      this.rosterTimer = null;
      if (this.disposed || !this.rosterDirty || !this.onRosterChange) {
        return;
      }
      this.rosterDirty = false;
      this.onRosterChange(this.roster());
    }, 0);
  }

  /** Whether name labels are currently shown. */
  get labelsVisible() {
    return labelsVisible;
  }

  /**
   * Show or hide every name label at once.
   *
   * Sprite `visible`, not a material swap and not a removal: it takes the sprite
   * out of the render list and nothing else, so toggling costs nothing, keeps
   * every canvas and texture alive, and a figure that joins while labels are off
   * comes up hidden (see _setLabel).
   */
  setLabelsVisible(visible) {
    labelsVisible = !!visible;
    for (const entry of this.players.values()) {
      if (entry.label) {
        entry.label.visible = labelsVisible;
      }
    }
    return labelsVisible;
  }

  /** @returns {boolean} the new state */
  toggleLabels() {
    return this.setLabelsVisible(!labelsVisible);
  }

  /** The HUD's roster line. Newest state, cheapest possible shape. */
  roster() {
    const rows = [];
    for (const entry of this.players.values()) {
      rows.push({
        id: entry.id,
        name: entry.name || "player",
        team: entry.team,
        alive: entry.alive,
        flag: entry.flag,
      });
    }
    // Teams together, then by name, so the list does not reshuffle every join.
    rows.sort((a, b) => {
      const ta = TEAMS.indexOf(a.team);
      const tb = TEAMS.indexOf(b.team);
      if (ta !== tb) return ta - tb;
      return a.name.localeCompare(b.name);
    });
    return rows;
  }

  // --- per-frame ----------------------------------------------------------------

  /**
   * Sample the snapshot buffer and move every figure. Called once per rendered frame.
   *
   * Sampling (rather than applying raw poses) is what makes this smooth: the server
   * sends poses at roughly 10-20 Hz and the buffer interpolates between the two
   * snapshots straddling `now - delayMs`.
   *
   * @param {number} deltaMs
   */
  update(deltaMs) {
    if (!this.buffer) {
      return;
    }

    // SnapshotBuffer's internal clock is performance.now(), and sample() expects a
    // timestamp in that same base - Date.now() here would put the render time ~55
    // years in the future and pin every figure to its newest snapshot.
    const nowMs = performance.now();

    for (const entry of this.players.values()) {
      const pose = this.buffer.sample(entry.id, nowMs);
      if (!pose) {
        continue;
      }

      entry.group.position.set(pose.x, pose.y, pose.z);
      entry.group.rotation.y = pose.ry || 0;

      // A bob while moving. At this size limbs would be invisible, but vertical motion
      // is legible and costs one sine.
      //
      // It goes on `tilt`, INSIDE the figure's scale, not on `figure` itself. On
      // `figure` the amplitude would be in raw game units - 0.12 of them, which after
      // the map's 0.0123 fit scale (3.2 marker units over a 259-unit footprint) is well
      // under a millimetre on the print.
      // Inside the scale it is 0.12 against a 1.75-unit body: ~7% of the figure's own
      // height, which is what "a bob" is supposed to mean.
      const speed = pose.speed || 0;

      if (entry.skinned) {
        // The model has its own footfalls. Blend idle/walk/run by the
        // speed the pose already carries, so a figure on the table walks
        // when its player walks and runs when they run.
        this._blend(entry, entry.alive ? speed : 0);
      } else if (speed > 0.05 && entry.alive) {
        entry.phase += deltaMs * 0.012 * Math.min(speed, 2);
        entry.tilt.position.y = Math.sin(entry.phase) * AR_CONFIG.avatar.bob * Math.min(speed, 1);
      } else if (entry.tilt.position.y !== 0) {
        entry.tilt.position.y *= 0.85;
        if (Math.abs(entry.tilt.position.y) < 0.001) {
          entry.tilt.position.y = 0;
        }
      }

      // Muzzle flash: a bright pip for a few frames after a shot, then
      // out. A Sprite, so it faces the camera on its own — a quad would
      // need re-orienting here every frame, and seen edge-on it
      // vanishes.
      if (entry.flashUntil > 0) {
        entry.flashUntil -= deltaMs;
        entry.flash.visible = entry.flashUntil > 0;
      }

      if (!entry.placed) {
        entry.placed = true;
        entry.group.visible = true;
      }
    }

    // One tick for every mixer. Advanced after the blend weights above are
    // set, so a weight change lands on the same frame it was decided.
    const dt = deltaMs / 1000;
    for (const mixer of this.mixers) {
      mixer.update(dt);
    }
  }

  /**
   * Crossfade idle -> walk -> run for one figure.
   *
   * Weights are set directly rather than through crossFadeTo: the target
   * speed can jump either way between frames (a teleport, a respawn, a
   * dropped packet) and a fade queued against the wrong current action
   * leaves an arm frozen mid-swing. An exponential approach to the target
   * weight cannot get stuck like that and settles in ~100 ms.
   */
  _blend(entry, speed) {
    const clips = entry.skinned.clips;
    const cfg = AR_CONFIG.avatar;

    let idle = 0;
    let walk = 0;
    let run = 0;

    if (speed <= 0.05) {
      idle = 1;
    } else if (speed <= cfg.walkSpeed) {
      // Idle -> walk. Below walkSpeed a figure is easing into a stride.
      walk = speed / cfg.walkSpeed;
      idle = 1 - walk;
    } else if (speed <= cfg.runSpeed) {
      const t = (speed - cfg.walkSpeed) / Math.max(cfg.runSpeed - cfg.walkSpeed, 0.001);
      walk = 1 - t;
      run = t;
    } else {
      run = 1;
    }

    const targets = { idle, walk, run };
    for (const key of Object.keys(targets)) {
      const action = clips[key];
      if (!action) continue;
      const current = action.getEffectiveWeight();
      const next = current + (targets[key] - current) * 0.25;
      action.setEffectiveWeight(next);
      // Keep the clip's own playback rate honest: a walk cycle authored at
      // one speed looks like skating if the figure is moving faster.
      if (key === "walk" && speed > 0.01) {
        action.setEffectiveTimeScale(
          Math.min(Math.max(speed / cfg.walkSpeed, 0.6), 1.6)
        );
      } else if (key === "run" && speed > 0.01) {
        action.setEffectiveTimeScale(
          Math.min(Math.max(speed / cfg.runSpeed, 0.7), 1.4)
        );
      }
    }
  }

  // --- roster -------------------------------------------------------------------

  _addPlayer(player) {
    if (!player || player.id == null) {
      return null;
    }

    let entry = this.players.get(player.id);
    if (!entry) {
      entry = this._createPlayer(player.id);
      this.players.set(player.id, entry);
      this._setStatus(this.status);
    }

    // The body this player wears. The server picks it so the table and the game view
    // agree on who is who; a player object without one keeps its capsule.
    if (typeof player.character === "number" && entry.modelUrl === null) {
      // "../" because the AR page is served from /ar/ while the paths in the roster
      // are relative to the site root, the same reason ar-config.js prefixes its own.
      entry.modelUrl = modelUrl(player.character, "../");
      entry.skinUrls = skinUrls(player.character, "../");
      if (entry.modelUrl) {
        this._loadModelFor(entry.modelUrl).then(() => {
          if (!this.disposed) this._upgradeToModel(entry);
        });
      }
    }

    if (player.name) {
      this._setLabel(entry, player.name);
    }
    // Team before anything else that paints: a figure must never be seen in the
    // palette colour for a frame and then flip sides.
    if (player.team !== undefined) {
      this._setTeam(entry, player.team);
    }
    if (player.flag !== undefined && player.flag !== entry.flag) {
      entry.flag = player.flag || null;
      this._touchRoster();
    }
    if (typeof player.hp === "number") {
      this._setAlive(entry, player.hp > 0);
    }
    // A player object carries an authoritative pose. Use it so a figure that has not
    // been sampled yet still appears in the right place instead of at the origin.
    if (typeof player.x === "number") {
      entry.group.position.set(player.x, player.y || 0, player.z || 0);
      entry.group.rotation.y = player.ry || 0;
      entry.placed = true;
      entry.group.visible = true;
    }

    return entry;
  }

  _createPlayer(id) {
    const cfg = AR_CONFIG.avatar;
    const color = this.palette[this.nextColor % this.palette.length];
    this.nextColor++;

    // MeshLambertMaterial, not Standard: these figures are a handful of pixels tall
    // and a full metallic-roughness BRDF per pixel buys nothing legible. Lambert
    // still takes the key, the fill and the environment.
    const material = new THREE.MeshLambertMaterial({ color: color.clone() });

    const capsuleBody = new THREE.Mesh(this.bodyGeometry, material);
    capsuleBody.castShadow = true;
    const capsuleNose = new THREE.Mesh(this.noseGeometry, material);
    capsuleNose.castShadow = true;

    // Muzzle flash. Shared geometry and material, so it is one extra
    // object per player and hidden almost always. It goes on `tilt`,
    // inside the figure's scale, so its size and height are in game
    // units like everything else on the figure.
    const flash = new THREE.Sprite(this.flashMaterial);
    flash.scale.setScalar(AR_CONFIG.avatar.flash.size);
    flash.position.y = AR_CONFIG.avatar.flash.height;
    flash.visible = false;

    // tilt exists so death can lay a figure down without disturbing its yaw.
    const tilt = new THREE.Group();
    tilt.add(capsuleBody);
    tilt.add(capsuleNose);
    tilt.add(flash);

    const figure = new THREE.Group();
    figure.scale.setScalar(cfg.scale);
    figure.add(tilt);

    // Where a carried flag hangs. On `figure`, not on `tilt`: `tilt` is what death
    // rotates flat, and a flag is taken off a body the instant it falls (the server
    // broadcasts the drop BEFORE the death), so a flag must never be along for that
    // rotation. Inside `figure` it is inside the avatar scale, so the offset below
    // is in the same game-units-before-scale as every other prop on the figure and
    // the flag is inflated by exactly as much as the soldier carrying it.
    const carryCfg = (AR_CONFIG.ctf && AR_CONFIG.ctf.carryOffset) || { x: 0, y: 1.15, z: 0.32 };
    const carry = new THREE.Group();
    carry.position.set(carryCfg.x, carryCfg.y, carryCfg.z);
    figure.add(carry);

    const group = new THREE.Group();
    group.add(figure);
    // Hidden until a pose arrives, so nobody flashes at the map origin.
    group.visible = false;
    this.worldGroup.add(group);

    const entry = {
      // Which character this player wears, filled in from the server's pick.
      modelUrl: null,
      skinUrls: [],
      id,
      group,
      figure,
      tilt,
      carry,
      material,
      aliveColor: color,
      // null until the server says otherwise, which is one message away: `hello`
      // and `join` both carry it.
      team: null,
      // The team COLOUR of the flag this player is carrying, or null.
      flag: null,
      label: null,
      labelTexture: null,
      labelCanvas: null,
      name: "",
      alive: true,
      placed: false,
      phase: 0,
      // Kept so the capsule can be swapped out for the real model the
      // moment it finishes loading, without disturbing pose or label.
      capsuleBody,
      capsuleNose,
      skinned: null,
      flash,
      // Counts down from AR_CONFIG.avatar.flash.fadeMs; 0 means not firing.
      flashUntil: 0,
    };

    this._upgradeToModel(entry);
    this._touchRoster();

    return entry;
  }

  _removePlayer(id) {
    const entry = this.players.get(id);
    if (!entry) {
      return;
    }
    this.players.delete(id);
    this._disposePlayer(entry);
    this._touchRoster();
    this._setStatus(this.status);
  }

  _clearPlayers() {
    for (const entry of this.players.values()) {
      this._disposePlayer(entry);
    }
    this.players.clear();
  }

  // Every THREE resource a player owns, released. Shared geometry is not touched.
  _disposePlayer(entry) {
    this.worldGroup.remove(entry.group);
    entry.material.dispose();

    // The skinned clone owns its materials and its mixer. Geometry and
    // skeleton come from SkeletonUtils.clone and are shared with the
    // source glTF, so they are NOT disposed here — that would tear the
    // model out from under every other figure.
    if (entry.skinned) {
      entry.skinned.mixer.stopAllAction();
      entry.skinned.mixer.uncacheRoot(entry.skinned.root);
      this.mixers.delete(entry.skinned.mixer);
      for (const mat of entry.skinned.materials) {
        mat.dispose();
      }
      entry.skinned = null;
    }
    if (entry.label) {
      entry.figure.remove(entry.label);
      entry.label.material.dispose();
    }
    if (entry.labelTexture) {
      entry.labelTexture.dispose();
    }
    entry.label = null;
    entry.labelTexture = null;
    entry.labelCanvas = null;
    // A flag parented to `carry` is NOT ours to dispose - the flags module owns
    // it, and the server drops a leaver's flag (a `flag` broadcast) before it
    // announces the leave, so by now it has already been re-parented to the world.
    // Detaching anything still here keeps a stale figure from taking a live flag
    // out of the scene with it; flags.js re-attaches on its next frame.
    for (const child of [...entry.carry.children]) {
      this.worldGroup.add(child);
    }
    entry.group.clear();
    entry.tilt.clear();
    entry.figure.clear();
  }

  // --- appearance ---------------------------------------------------------------

  _setAlive(entry, alive) {
    if (entry.alive === alive) {
      return;
    }
    entry.alive = alive;

    // Dead reads three ways at once, because one cue is not enough at this size:
    // the figure lies down, goes dark red, and turns translucent.
    entry.tilt.rotation.x = alive ? 0 : -Math.PI / 2;
    this._applyTint(entry);

    if (entry.label) {
      entry.label.material.opacity = alive ? 1 : 0.4;
    }
    if (!alive) {
      entry.tilt.position.y = 0;
    }
    this._touchRoster();
  }

  /**
   * Which side this figure is on. `null` clears it back to the id-cycled palette,
   * which is what network.js does to a client on disconnect and what a non-team
   * server would send.
   */
  _setTeam(entry, team) {
    const next = team === "red" || team === "blue" ? team : null;
    if (entry.team === next) {
      return;
    }
    entry.team = next;
    this._applyTint(entry);

    // The name plate is outlined in the figure's own colour, so it is now wrong.
    // Clearing the cached name is what makes _setLabel redraw rather than
    // early-return on "same name".
    if (entry.name) {
      const name = entry.name;
      entry.name = "";
      this._setLabel(entry, name);
    }
    this._touchRoster();
  }

  /** The one place a figure's colour is decided. Team first, palette as fallback. */
  teamColor(entry) {
    return (entry.team && this.teamColors[entry.team]) || entry.aliveColor;
  }

  /**
   * Paint one figure: capsule and, if it has been upgraded, every material on its
   * skinned clone. Those materials were built fresh per player in _buildSkinned -
   * the glTF's own materials are never assigned and never mutated, so tinting one
   * figure cannot repaint the table.
   *
   * Colour and emissive are plain uniforms, so none of this needs a shader
   * recompile. `transparent` DOES, which is why it is written only when it
   * actually flips, and only on the capsule - a dying skinned figure reads from
   * lying down and going dark red without paying a recompile on a phone.
   */
  _applyTint(entry) {
    const alive = entry.alive;
    const base = this.teamColor(entry);

    if (!this._emissiveScratch) {
      this._emissiveScratch = new THREE.Color();
    }
    const emissive = this._emissiveScratch;
    if (alive && entry.team) {
      emissive.copy(base).multiplyScalar(this.teamEmissive);
    } else {
      emissive.copy(this.black);
    }

    const capsule = entry.material;
    capsule.color.copy(alive ? base : this.deadColor);
    if (capsule.emissive) {
      capsule.emissive.copy(emissive);
    }
    capsule.opacity = alive ? 1 : 0.45;
    if (capsule.transparent !== !alive) {
      capsule.transparent = !alive;
      capsule.needsUpdate = true;
    }

    if (entry.skinned) {
      for (const mat of entry.skinned.materials) {
        mat.color.copy(alive ? base : this.deadColor);
        if (mat.emissive) {
          mat.emissive.copy(emissive);
        }
      }
    }
  }

  _setLabel(entry, name) {
    if (entry.name === name) {
      return;
    }
    entry.name = name;

    const cfg = AR_CONFIG.avatar;

    if (!entry.labelCanvas) {
      entry.labelCanvas = document.createElement("canvas");
      entry.labelCanvas.width = 256;
      entry.labelCanvas.height = 64;
    }
    drawLabel(entry.labelCanvas, name, `#${this.teamColor(entry).getHexString()}`);

    if (!entry.labelTexture) {
      entry.labelTexture = new THREE.CanvasTexture(entry.labelCanvas);
      entry.labelTexture.colorSpace = THREE.SRGBColorSpace;
      entry.labelTexture.minFilter = THREE.LinearFilter;
      entry.labelTexture.generateMipmaps = false;
    } else {
      entry.labelTexture.needsUpdate = true;
    }

    if (!entry.label) {
      const material = new THREE.SpriteMaterial({
        map: entry.labelTexture,
        transparent: true,
        depthWrite: false,
        // depthTest on purpose: a name behind a tower should be hidden by the tower.
        // On a table you read position from occlusion as much as from the figure.
        depthTest: true,
      });
      const sprite = new THREE.Sprite(material);
      sprite.scale.set(cfg.labelWidth, cfg.labelWidth / 4, 1);
      sprite.position.y = cfg.labelHeight;
      sprite.material.opacity = entry.alive ? 1 : 0.4;
      // A figure created while labels are off must not flash its name for a frame.
      sprite.visible = labelsVisible;
      entry.figure.add(sprite);
      entry.label = sprite;
    }
  }

  // --- teardown -----------------------------------------------------------------

  dispose() {
    this.disposed = true;
    if (this.rosterTimer) {
      clearTimeout(this.rosterTimer);
      this.rosterTimer = null;
    }
    if (this.connection) {
      try {
        this.connection.close();
      } catch (error) {
        console.warn("[ar-spectator] close failed:", error && error.message);
      }
      this.connection = null;
    }
    this.buffer = null;
    this._clearPlayers();
    this.bodyGeometry.dispose();
    this.noseGeometry.dispose();
    this.flashMaterial.dispose();

    // The source model's own geometries and textures, disposed once here
    // rather than per player.
    for (const rec of this.models.values()) {
      disposeModel(rec.gltf.scene);
    }
    this.models.clear();
    this.modelPending.clear();
    if (this._skinTextures) {
      for (const tex of this._skinTextures.values()) tex.dispose();
      this._skinTextures.clear();
    }
    this.mixers.clear();
  }
}

// One 256x64 canvas per player, redrawn only when the name changes.
function drawLabel(canvas, name, color) {
  const ctx = canvas.getContext("2d");
  const text = (name || "player").slice(0, 16);

  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // Dark plate, so a light name stays readable over the bright map textures.
  ctx.fillStyle = "rgba(6, 10, 16, 0.72)";
  roundedRect(ctx, 4, 10, canvas.width - 8, 44, 10);
  ctx.fill();
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.stroke();

  ctx.font = "600 28px system-ui, -apple-system, Segoe UI, Roboto, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = "#ffffff";
  ctx.fillText(text, canvas.width / 2, 33, canvas.width - 24);
}

function roundedRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
