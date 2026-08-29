import * as THREE from "three";
import { clone as cloneSkinned } from "../vendor/utils/SkeletonUtils.js";
import { AR_CONFIG } from "../config/ar-config.js";
import { createGLTFLoader, loadFirstAvailable, disposeModel } from "./assets.js";

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
    this.model = null;
    this.modelScale = 1;
    this.modelFootY = 0;
    this.mixers = new Set();
    this.modelLoader = null;
    this._loadModel();
  }

  // Loads the character once, then upgrade any figures already standing.
  // Never throws: the table must survive a missing file or a dead network.
  _loadModel() {
    const cfg = AR_CONFIG.avatar;
    if (!cfg.modelUrls || !cfg.modelUrls.length) return;

    this.modelLoader = createGLTFLoader();
    loadFirstAvailable(this.modelLoader, cfg.modelUrls, "avatar")
      .then((gltf) => {
        if (this.disposed) {
          return;
        }
        this.model = gltf;

        // Measure the model ONCE, here, with its matrices forced up to
        // date. A freshly cloned skinned mesh has unset bone matrices, so
        // Box3.setFromObject on a clone collapses to ~0 and any per-clone
        // fit silently does nothing. Measured on the source it is honest,
        // and every clone reuses the number for free.
        gltf.scene.updateWorldMatrix(true, true);
        const box = new THREE.Box3().setFromObject(gltf.scene);
        const h = box.max.y - box.min.y;
        this.modelScale = h > 0.01 ? AR_CONFIG.avatar.height / h : 1;
        // Feet to y=0, so a figure stands ON the rock rather than
        // hovering above it or sinking into it.
        this.modelFootY = box.min.y * this.modelScale;

        for (const entry of this.players.values()) {
          this._upgradeToModel(entry);
        }
      })
      .catch((err) => {
        // Not fatal. Capsules are a complete figure, just a duller one.
        console.warn("[players] soldier model unavailable, using capsules:", err);
      });
  }

  /** Swap a placed capsule figure for a skinned one, keeping its pose. */
  _upgradeToModel(entry) {
    if (!this.model || entry.skinned || this.mixers.size >= AR_CONFIG.avatar.maxSkinned) {
      return;
    }

    const skinned = this._buildSkinned(entry.aliveColor);
    if (!skinned) {
      return;
    }

    // Drop the capsule body, keep the group/tilt/label rig intact so the
    // pose, the bob state and the name label all carry straight over.
    entry.tilt.remove(entry.capsuleBody);
    entry.tilt.remove(entry.capsuleNose);
    entry.tilt.add(skinned.root);

    entry.skinned = skinned;
    // The model animates its own footfalls; the sine bob was standing in
    // for exactly that and now fights it.
    entry.tilt.position.y = 0;
  }

  /**
   * Clone the loaded model for one player and wire up its clips.
   * Returns null if anything is missing, so the caller keeps its capsule.
   */
  _buildSkinned(color) {
    if (!this.model) return null;

    const cfg = AR_CONFIG.avatar;
    const root = cloneSkinned(this.model.scene);

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
      const mat = new THREE.MeshLambertMaterial({
        color: color.clone(),
        map: src && src.map ? src.map : null,
        skinning: true,
      });
      obj.material = mat;
      materials.push(mat);
    });

    // The clip set is on the glTF root, not on the cloned nodes.
    const mixer = new THREE.AnimationMixer(root);
    const clipsBy = {};
    for (const [key, name] of Object.entries(cfg.clips)) {
      const clip = THREE.AnimationClip.findByName(this.model.animations || [], name);
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
    root.scale.setScalar(this.modelScale);
    root.position.y = -this.modelFootY;

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
      // the map's 0.0198 fit scale is under a fifth of a millimetre on the print.
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

    if (player.name) {
      this._setLabel(entry, player.name);
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

    const group = new THREE.Group();
    group.add(figure);
    // Hidden until a pose arrives, so nobody flashes at the map origin.
    group.visible = false;
    this.worldGroup.add(group);

    const entry = {
      id,
      group,
      figure,
      tilt,
      material,
      aliveColor: color,
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

    return entry;
  }

  _removePlayer(id) {
    const entry = this.players.get(id);
    if (!entry) {
      return;
    }
    this.players.delete(id);
    this._disposePlayer(entry);
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
    entry.material.color.copy(alive ? entry.aliveColor : this.deadColor);
    entry.material.transparent = !alive;
    entry.material.opacity = alive ? 1 : 0.45;
    entry.material.needsUpdate = true;

    if (entry.label) {
      entry.label.material.opacity = alive ? 1 : 0.4;
    }
    if (!alive) {
      entry.tilt.position.y = 0;
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
    drawLabel(entry.labelCanvas, name, `#${entry.aliveColor.getHexString()}`);

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
      entry.figure.add(sprite);
      entry.label = sprite;
    }
  }

  // --- teardown -----------------------------------------------------------------

  dispose() {
    this.disposed = true;
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
    if (this.model) {
      disposeModel(this.model.scene);
      this.model = null;
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
