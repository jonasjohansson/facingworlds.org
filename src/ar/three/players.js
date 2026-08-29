import * as THREE from "three";
import { AR_CONFIG } from "../config/ar-config.js";

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
// WHY CAPSULES AND NOT THE SOLDIER MODEL. Not a guess, arithmetic: the map is ~111
// game units across and is fitted to 2.2 marker units, so one game unit is ~0.02
// marker units. On a print ~15 cm wide (2 marker units) a life-sized player stands
// under 3 mm tall. A rigged, skinned, four-clip character is being asked to render at
// a handful of pixels while the phone also runs camera capture and image tracking.
// Figures are drawn instead from two shared buffer geometries and one material each -
// no skinning, no animation mixer, no second 900 KB download - and inflated by
// AR_CONFIG.avatar.scale so they read like wargaming pieces. Positions are NOT
// inflated, so a figure always stands exactly where its player stands.
//
// I could not measure the Soldier path: this was built without a camera, so nothing
// about tracking or on-device framerate has been observed. The choice above rests on
// the size arithmetic, not on a measurement.

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
      if (speed > 0.05 && entry.alive) {
        entry.phase += deltaMs * 0.012 * Math.min(speed, 2);
        entry.tilt.position.y = Math.sin(entry.phase) * AR_CONFIG.avatar.bob * Math.min(speed, 1);
      } else if (entry.tilt.position.y !== 0) {
        entry.tilt.position.y *= 0.85;
        if (Math.abs(entry.tilt.position.y) < 0.001) {
          entry.tilt.position.y = 0;
        }
      }

      if (!entry.placed) {
        entry.placed = true;
        entry.group.visible = true;
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

    const body = new THREE.Mesh(this.bodyGeometry, material);
    body.castShadow = true;
    const nose = new THREE.Mesh(this.noseGeometry, material);
    nose.castShadow = true;

    // tilt exists so death can lay a figure down without disturbing its yaw.
    const tilt = new THREE.Group();
    tilt.add(body);
    tilt.add(nose);

    const figure = new THREE.Group();
    figure.scale.setScalar(cfg.scale);
    figure.add(tilt);

    const group = new THREE.Group();
    group.add(figure);
    // Hidden until a pose arrives, so nobody flashes at the map origin.
    group.visible = false;
    this.worldGroup.add(group);

    return {
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
    };
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
