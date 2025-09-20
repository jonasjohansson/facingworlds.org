// blaster.js — X-key shooter + bullet logic (avatars + targets collisions)
import "./bullet.js";
import { createEntity } from "../utils/dom-helpers.js";
import { createVector3 } from "../utils/three-helpers.js";

AFRAME.registerComponent("blaster", {
  schema: {
    enabled: { type: "boolean", default: true },
    bulletSpeed: { type: "number", default: 8 }, // m/s
    bulletRadius: { type: "number", default: 0.4 }, // m
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
    this.recoilIntensity = 0;
    this.recoilRecovery = 0.15; // How fast recoil recovers
    this.maxRecoil = 0.3; // Maximum recoil angle in radians

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

  tick(time, dtMs) {
    const dt = dtMs / 1000;

    // Handle recoil recovery
    if (this.recoilIntensity > 0) {
      this.recoilIntensity = Math.max(0, this.recoilIntensity - this.recoilRecovery * dt);
      this.applyRecoil();
    }

    if (!this.data.enabled || !this.isFiring) return;
    const now = time / 1000;
    const minInterval = 1 / Math.max(1, this.data.fireRate);
    if (now - this._lastShotAt < minInterval) return;
    this._lastShotAt = now;
    this._fireOne();
  },

  _fireOne() {
    if (!this.data.enabled) {
      console.log("[blaster] Ignoring fire - component disabled");
      return;
    }

    console.log("[blaster] Firing bullet from blaster component");
    const THREE = AFRAME.THREE;

    // Add recoil
    this.recoilIntensity = Math.min(this.maxRecoil, this.recoilIntensity + 0.05);

    // Origin = player world pos + muzzle height
    const origin = createVector3();
    this.el.object3D.getWorldPosition(origin);
    origin.y += this.data.muzzleHeight;

    // Direction = player forward (-Z) in world
    const dir = createVector3(0, 0, -1).applyQuaternion(this.el.object3D.quaternion).normalize();

    // Create muzzle flash effect
    this.createMuzzleFlash(origin, dir);

    // Emit shoot event for first-person weapon
    this.el.emit("shoot", {
      origin: { x: origin.x, y: origin.y, z: origin.z },
      dir: { x: dir.x, y: dir.y, z: dir.z },
      bulletSpeed: this.data.bulletSpeed,
      bulletRadius: this.data.bulletRadius,
      lifeSec: this.data.lifeSec,
      color: this.data.color,
    });

    // Notify multiplayer layer
    this.el.sceneEl.emit("local-fire", {
      origin: { x: origin.x, y: origin.y, z: origin.z },
      dir: { x: dir.x, y: dir.y, z: dir.z },
    });

    // Spawn local visual bullet (optimized)
    if (this.data.spawnLocal) {
      const vx = dir.x * this.data.bulletSpeed;
      const vy = dir.y * this.data.bulletSpeed;
      const vz = dir.z * this.data.bulletSpeed;

      const ownerId = this.el.dataset.playerId || "";
      const b = createEntity("a-entity", {
        position: `${origin.x} ${origin.y} ${origin.z}`,
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

  applyRecoil() {
    // Apply recoil to camera rotation - optimized
    const camera = this.el.sceneEl.querySelector("#camera");
    if (camera && this.recoilIntensity > 0.001) {
      // Skip tiny values
      const currentRotation = camera.getAttribute("rotation");
      const recoilX = Math.sin(this.recoilIntensity * 10) * this.recoilIntensity * 3; // Reduced multiplier
      const recoilY = this.recoilIntensity * 5; // Reduced upward recoil

      camera.setAttribute("rotation", {
        x: currentRotation.x - recoilY,
        y: currentRotation.y + recoilX,
        z: currentRotation.z,
      });
    }
  },

  createMuzzleFlash(origin, direction) {
    const THREE = AFRAME.THREE;

    // Create muzzle flash entity
    const flash = document.createElement("a-entity");
    flash.setAttribute("position", `${origin.x} ${origin.y} ${origin.z}`);

    // Create flash geometry (small sphere that expands) - reduced complexity
    const flashGeometry = new THREE.SphereGeometry(0.1, 6, 4);
    const flashMaterial = new THREE.MeshBasicMaterial({
      color: 0xffaa00,
      transparent: true,
      opacity: 0.8,
    });
    const flashMesh = new THREE.Mesh(flashGeometry, flashMaterial);
    flash.object3D.add(flashMesh);

    // No light for better performance

    // Add to scene
    this.el.sceneEl.appendChild(flash);

    // Optimized animation - fewer frames, faster execution
    let scale = 0.1;
    let opacity = 0.8;
    const animateFlash = () => {
      scale += 0.5; // Faster scaling
      opacity -= 0.2; // Faster fade

      flashMesh.scale.setScalar(scale);
      flashMaterial.opacity = Math.max(0, opacity);

      if (opacity > 0) {
        requestAnimationFrame(animateFlash);
      } else {
        // Remove flash after animation
        if (flash.parentNode) {
          flash.parentNode.removeChild(flash);
        }
      }
    };

    // Start animation
    requestAnimationFrame(animateFlash);
  },
});

// bullet component is now in bullet.js
