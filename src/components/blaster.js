// blaster.js — X-key shooter + bullet logic (avatars + targets collisions)
import "./bullet.js";
import { createEntity } from "../utils/dom-helpers.js";
import { createVector3 } from "../utils/three-helpers.js";

AFRAME.registerComponent("blaster", {
  schema: {
    bulletSpeed: { type: "number", default: 18 }, // m/s
    bulletRadius: { type: "number", default: 0.08 }, // m
    lifeSec: { type: "number", default: 2.0 }, // s
    fireRate: { type: "number", default: 8 }, // bullets/sec
    muzzleHeight: { type: "number", default: 1.2 }, // m above player origin
    color: { type: "color", default: "#ffcc00" },
    // If your network layer spawns local bullets too, set false
    spawnLocal: { type: "boolean", default: true },
  },

  init() {
    this.isFiring = false;
    this._lastShotAt = 0;

    // Keyboard: X to fire (KeyX)
    this._onKeyDown = (e) => {
      if (e.code === "KeyX") {
        this.isFiring = true;
        e.preventDefault();
      }
    };
    this._onKeyUp = (e) => {
      if (e.code === "KeyX") {
        this.isFiring = false;
        e.preventDefault();
      }
    };

    window.addEventListener("keydown", this._onKeyDown, { passive: false });
    window.addEventListener("keyup", this._onKeyUp);

    // optional: stop context menu interfering (not strictly needed now)
    this._onContext = (e) => e.preventDefault();
    document.addEventListener("contextmenu", this._onContext);
  },

  remove() {
    window.removeEventListener("keydown", this._onKeyDown);
    window.removeEventListener("keyup", this._onKeyUp);
    document.removeEventListener("contextmenu", this._onContext);
  },

  tick(time) {
    if (!this.isFiring) return;
    const now = time / 1000;
    const minInterval = 1 / Math.max(1, this.data.fireRate);
    if (now - this._lastShotAt < minInterval) return;
    this._lastShotAt = now;
    this._fireOne();
  },

  _fireOne() {
    const THREE = AFRAME.THREE;

    // Origin = player world pos + muzzle height
    const origin = createVector3();
    this.el.object3D.getWorldPosition(origin);
    origin.y += this.data.muzzleHeight;

    // Direction = player forward (-Z) in world
    const dir = createVector3(0, 0, -1).applyQuaternion(this.el.object3D.quaternion).normalize();

    // Notify multiplayer layer
    this.el.sceneEl.emit("local-fire", {
      origin: { x: origin.x, y: origin.y, z: origin.z },
      dir: { x: dir.x, y: dir.y, z: dir.z },
    });

    // Optionally spawn a local visual bullet
    if (this.data.spawnLocal) {
      const vx = dir.x * this.data.bulletSpeed;
      const vy = dir.y * this.data.bulletSpeed;
      const vz = dir.z * this.data.bulletSpeed;

      const ownerId = this.el.dataset.playerId || "";
      const b = createEntity("a-entity", {
        position: `${origin.x} ${origin.y} ${origin.z}`,
        geometry: `primitive: sphere; radius: ${this.data.bulletRadius}`,
        material: `color: ${this.data.color}; opacity: 0.95; metalness:0.2; roughness:0.4`,
        shadow: "cast:true",
        bullet: {
          vx,
          vy,
          vz,
          radius: this.data.bulletRadius,
          lifeSec: this.data.lifeSec,
          ownerId,
          reportHits: true,
        },
      });

      this.el.sceneEl.appendChild(b);
    }
  },
});

// bullet component is now in bullet.js
