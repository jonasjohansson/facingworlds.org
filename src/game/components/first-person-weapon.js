// first-person-weapon.js — First-person weapon view and shooting
import { GAME_CONFIG } from "../config/game-config.js";

AFRAME.registerComponent("first-person-weapon", {
  schema: {
    enabled: { type: "boolean", default: true },
    weaponModel: { type: "string", default: "#enforcer-weapon" },
    weaponScale: { type: "vec3", default: { x: 0.1, y: 0.1, z: 0.1 } },
    weaponPosition: { type: "vec3", default: { x: 0.3, y: -0.2, z: -0.5 } },
    weaponRotation: { type: "vec3", default: { x: 0, y: 0, z: 0 } },
    muzzleOffset: { type: "vec3", default: { x: 0.8, y: 0.1, z: 0 } }, // Position relative to weapon where bullets spawn
    fireRate: { type: "number", default: 4 }, // Bullets per second
    lastFireTime: { type: "number", default: 0 },
    // Hit feedback
    hitFlashColor: { type: "string", default: "#ff0000" }, // Red flash on hit
    hitFlashDuration: { type: "number", default: 200 }, // Flash duration in ms
    // Multikill tracking
    killStreak: { type: "number", default: 0 },
    lastKillTime: { type: "number", default: 0 },
    multikillTimeout: { type: "number", default: 3000 }, // 3 seconds between kills for multikill
  },

  init() {
    this.weapon = null;
    this.muzzlePosition = new THREE.Vector3();
    this.isFiring = false;
    this.lastFireTime = 0;
    this.killStreak = 0;
    this.lastKillTime = 0;

    // Wait for camera to be ready
    this.el.addEventListener("loaded", () => {
      this.setupWeapon();
    });

    // Listen for key presses directly (X key for firing, C key for camera)
    this._onKeyDown = (e) => {
      if (e.code === "KeyX") {
        this.isFiring = true;
        e.preventDefault();
      } else if (e.code === "KeyC") {
        this.swapCamera();
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

    // Create touch fire button for mobile devices
    this.createTouchFireButton();

    // Listen for hit events
    this.el.sceneEl.addEventListener("local-hit", this.onLocalHit.bind(this));
    this.el.sceneEl.addEventListener("local-kill", this.onLocalKill.bind(this));
  },

  tick(time) {
    if (!this.isFiring) return;

    const now = time / 1000;
    const minInterval = 1 / Math.max(1, this.data.fireRate);
    if (now - this.lastFireTime < minInterval) return;

    this.lastFireTime = now;
    this.fireBullet();
  },

  setupWeapon() {
    if (!this.data.enabled || this.weapon) return;

    // Find the weapon entity (should be a child of the camera)
    this.weapon = this.el.querySelector("#player-weapon");

    if (!this.weapon) {
      console.warn("[first-person-weapon] Weapon entity not found, creating fallback");
      this.createFallbackWeapon();
      return;
    }

    // Wait for model to load
    this.weapon.addEventListener("model-loaded", () => {
      this.setupMuzzlePosition();
      console.log("[first-person-weapon] Enforcer weapon loaded and ready");
    });

    // Add error handling
    this.weapon.addEventListener("error", (e) => {
      console.error("[first-person-weapon] Failed to load weapon model:", e);
      this.createFallbackWeapon();
    });

    // Timeout fallback
    setTimeout(() => {
      if (!this.weapon || !this.weapon.object3D || this.weapon.object3D.children.length === 0) {
        console.warn("[first-person-weapon] Weapon model timeout, creating fallback");
        this.createFallbackWeapon();
      }
    }, 5000);

  },

  setupMuzzlePosition() {
    // Get muzzle position from the weapon-muzzle entity
    const muzzle = this.weapon ? this.weapon.querySelector("#weapon-muzzle") : null;

    if (muzzle && muzzle.object3D) {
      // Get world position of the muzzle entity
      muzzle.object3D.getWorldPosition(this.muzzlePosition);
      console.log("[first-person-weapon] Muzzle position from entity:", this.muzzlePosition);
    } else {
      // Fallback to camera position + offset
      if (this.el.object3D) {
        const cameraWorldPos = new THREE.Vector3();
        this.el.object3D.getWorldPosition(cameraWorldPos);
        this.muzzlePosition.copy(this.data.muzzleOffset);
        this.muzzlePosition.applyQuaternion(this.el.object3D.quaternion);
        this.muzzlePosition.add(cameraWorldPos);
        console.log("[first-person-weapon] Muzzle position fallback:", this.muzzlePosition);
      }
    }
  },

  handleShoot() {
    if (!this.data.enabled || !this.weapon) return;

    const currentTime = Date.now();
    const timeSinceLastFire = currentTime - this.lastFireTime;
    const fireInterval = 1000 / this.data.fireRate; // Convert to milliseconds

    if (timeSinceLastFire >= fireInterval) {
      this.fireBullet();
      this.lastFireTime = currentTime;
    }
  },

  fireBullet() {
    if (!this.weapon || !this.weapon.object3D) return;

    // Update muzzle position
    this.setupMuzzlePosition();

    // Get camera direction (this.el is the camera)
    const cameraDirection = new THREE.Vector3();
    this.el.object3D.getWorldDirection(cameraDirection);
    // Reverse direction since getWorldDirection gives opposite of what we want
    cameraDirection.negate();

    // Create bullet entity for single-player mode
    const bullet = document.createElement("a-entity");
    bullet.setAttribute("bullet", {
      vx: cameraDirection.x * GAME_CONFIG.BULLET.SPEED,
      vy: cameraDirection.y * GAME_CONFIG.BULLET.SPEED,
      vz: cameraDirection.z * GAME_CONFIG.BULLET.SPEED,
      radius: GAME_CONFIG.BULLET.RADIUS,
      ownerId: "local-player",
      reportHits: true,
    });

    bullet.setAttribute("position", {
      x: this.muzzlePosition.x,
      y: this.muzzlePosition.y,
      z: this.muzzlePosition.z,
    });

    // Note: Visual geometry is created by the bullet component itself

    this.el.sceneEl.appendChild(bullet);

    // Also emit to network layer for multiplayer compatibility
    this.el.sceneEl.emit("local-fire", {
      origin: {
        x: this.muzzlePosition.x,
        y: this.muzzlePosition.y,
        z: this.muzzlePosition.z,
      },
      dir: {
        x: cameraDirection.x,
        y: cameraDirection.y,
        z: cameraDirection.z,
      },
    });

    // Play weapon sound
    this.playWeaponSound();

  },

  playWeaponSound() {
    // Use the same fire sound as bullets
    try {
      // Check if mobile and disable audio completely
      const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);

      if (isMobile) {
        // Disable audio completely on mobile
        return;
      }

      const audio = new Audio("assets/audio/fire.wav");
      audio.volume = 0.1; // Very quiet for desktop only
      audio.play().catch((error) => {
        console.warn("[first-person-weapon] Failed to play weapon sound:", error);
      });
    } catch (error) {
      console.warn("[first-person-weapon] Audio error:", error);
    }
  },

  update() {
    if (this.data.enabled && !this.weapon) {
      this.setupWeapon();
    } else if (!this.data.enabled && this.weapon) {
      this.removeWeapon();
    }
  },

  createFallbackWeapon() {
    console.log("[first-person-weapon] Creating weapon");

    // Remove existing weapon
    if (this.weapon) {
      this.el.removeChild(this.weapon);
    }

    // Create weapon group
    this.weapon = document.createElement("a-entity");
    this.weapon.setAttribute("position", this.data.weaponPosition);
    this.weapon.setAttribute("rotation", this.data.weaponRotation);
    this.weapon.setAttribute("scale", this.data.weaponScale);

    // Main weapon body
    const body = document.createElement("a-entity");
    body.setAttribute("geometry", "primitive: box; width: 0.2; height: 0.08; depth: 1.2");
    body.setAttribute("position", "0 0 0");
    body.setAttribute("material", "color: #444444; metalness: 0.9; roughness: 0.1");
    this.weapon.appendChild(body);

    // Barrel
    const barrel = document.createElement("a-entity");
    barrel.setAttribute("geometry", "primitive: cylinder; radius: 0.02; height: 0.8");
    barrel.setAttribute("position", "0 0 0.4");
    barrel.setAttribute("rotation", "90 0 0");
    barrel.setAttribute("material", "color: #333333; metalness: 0.9; roughness: 0.1");
    this.weapon.appendChild(barrel);

    // Handle
    const handle = document.createElement("a-entity");
    handle.setAttribute("geometry", "primitive: box; width: 0.15; height: 0.3; depth: 0.1");
    handle.setAttribute("position", "0 -0.15 -0.3");
    handle.setAttribute("material", "color: #555555; metalness: 0.7; roughness: 0.3");
    this.weapon.appendChild(handle);

    // Trigger guard
    const triggerGuard = document.createElement("a-entity");
    triggerGuard.setAttribute("geometry", "primitive: cylinder; radius: 0.08; height: 0.05");
    triggerGuard.setAttribute("position", "0 -0.05 -0.2");
    triggerGuard.setAttribute("rotation", "90 0 0");
    triggerGuard.setAttribute("material", "color: #444444; metalness: 0.9; roughness: 0.1");
    this.weapon.appendChild(triggerGuard);

    this.el.appendChild(this.weapon);
    this.setupMuzzlePosition();
    console.log("[first-person-weapon] Weapon created successfully");
  },

  removeWeapon() {
    if (this.weapon) {
      this.el.removeChild(this.weapon);
      this.weapon = null;
    }
  },

  createTouchFireButton() {
    // Only create on touch devices
    if (!("ontouchstart" in window)) {
      console.log("[first-person-weapon] Not a touch device, skipping fire button");
      return;
    }

    console.log("[first-person-weapon] Creating touch fire button...");

    const fireButton = document.createElement("div");
    fireButton.id = "touch-fire-button";
    fireButton.innerHTML = "FIRE";
    fireButton.style.cssText = `
      position: fixed;
      bottom: 20px;
      right: 20px;
      width: 80px;
      height: 80px;
      background: rgba(60, 60, 60, 0.8);
      border: 3px solid rgba(255, 255, 255, 0.9);
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 14px;
      font-weight: bold;
      color: white;
      cursor: pointer;
      pointer-events: auto;
      user-select: none;
      -webkit-user-select: none;
      -webkit-touch-callout: none;
      -webkit-tap-highlight-color: transparent;
      z-index: 1000;
      touch-action: manipulation;
      transition: all 0.1s ease;
    `;

    // Touch events
    fireButton.addEventListener(
      "touchstart",
      (e) => {
        e.preventDefault();
        this.isFiring = true;
        fireButton.style.background = "rgba(40, 40, 40, 0.9)";
        fireButton.style.transform = "scale(0.95)";
      },
      { passive: false }
    );

    fireButton.addEventListener(
      "touchend",
      (e) => {
        e.preventDefault();
        this.isFiring = false;
        fireButton.style.background = "rgba(60, 60, 60, 0.8)";
        fireButton.style.transform = "scale(1)";
      },
      { passive: false }
    );

    fireButton.addEventListener(
      "touchcancel",
      (e) => {
        e.preventDefault();
        this.isFiring = false;
        fireButton.style.background = "rgba(60, 60, 60, 0.8)";
        fireButton.style.transform = "scale(1)";
      },
      { passive: false }
    );

    // Mouse events for desktop testing
    fireButton.addEventListener("mousedown", (e) => {
      e.preventDefault();
      this.isFiring = true;
      fireButton.style.background = "rgba(40, 40, 40, 0.9)";
      fireButton.style.transform = "scale(0.95)";
    });

    fireButton.addEventListener("mouseup", (e) => {
      e.preventDefault();
      this.isFiring = false;
      fireButton.style.background = "rgba(255, 100, 100, 0.8)";
      fireButton.style.transform = "scale(1)";
    });

    document.body.appendChild(fireButton);
  },

  onLocalHit(event) {
    // Flash screen on hit
    this.flashScreen(this.data.hitFlashColor, this.data.hitFlashDuration);
  },

  onLocalKill(event) {
    const now = Date.now();

    // Check if this is part of a multikill streak
    if (now - this.lastKillTime <= this.data.multikillTimeout) {
      this.killStreak++;
    } else {
      this.killStreak = 1; // Reset streak
    }

    this.lastKillTime = now;

    // Play multikill sound based on streak
    this.playMultikillSound(this.killStreak);

    // Flash screen for kill
    this.flashScreen("#00ff00", 150); // Green flash for kill
  },

  flashScreen(color, duration) {
    // Create flash overlay
    const flash = document.createElement("div");
    flash.style.position = "fixed";
    flash.style.top = "0";
    flash.style.left = "0";
    flash.style.width = "100%";
    flash.style.height = "100%";
    flash.style.backgroundColor = color;
    flash.style.pointerEvents = "none";
    flash.style.zIndex = "9999";
    flash.style.opacity = "0.3";
    flash.style.transition = `opacity ${duration}ms ease-out`;

    document.body.appendChild(flash);

    // Fade out and remove
    setTimeout(() => {
      flash.style.opacity = "0";
      setTimeout(() => {
        if (flash.parentNode) {
          flash.parentNode.removeChild(flash);
        }
      }, duration);
    }, 50);
  },

  playMultikillSound(streak) {
    let soundFile = "";

    switch (streak) {
      case 1:
        soundFile = "assets/audio/fire.wav"; // Default kill sound
        break;
      case 2:
        soundFile = "assets/audio/fire.wav"; // Double kill (reuse fire sound)
        break;
      case 3:
        soundFile = "assets/audio/fire.wav"; // Triple kill
        break;
      case 4:
        soundFile = "assets/audio/fire.wav"; // Quad kill
        break;
      case 5:
        soundFile = "assets/audio/fire.wav"; // Penta kill
        break;
      default:
        if (streak >= 6) {
          soundFile = "assets/audio/fire.wav"; // Mega kill
        }
        break;
    }

    if (soundFile) {
      try {
        // Check if mobile and disable audio completely
        const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);

        if (isMobile) {
          // Disable audio completely on mobile
          return;
        }

        const audio = new Audio(soundFile);
        audio.volume = 0.01; // Very quiet for desktop only
        audio.play().catch((error) => {
          console.warn("[first-person-weapon] Failed to play multikill sound:", error);
        });
      } catch (error) {
        console.warn("[first-person-weapon] Audio error:", error);
      }
    }
  },

  remove() {
    window.removeEventListener("keydown", this._onKeyDown);
    window.removeEventListener("keyup", this._onKeyUp);
    this.removeWeapon();

    // Remove touch fire button
    const fireButton = document.getElementById("touch-fire-button");
    if (fireButton) {
      fireButton.remove();
    }
  },
});
