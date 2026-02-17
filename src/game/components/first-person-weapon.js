// first-person-weapon.js — First-person weapon view and shooting
import { GAME_CONFIG } from "../config/game-config.js";

// Shared audio pool for weapon sounds
const WEAPON_POOL_SIZE = 4;
let weaponAudioPool = null;
let weaponAudioIndex = 0;
const isMobileDevice = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);

function getWeaponAudioPool() {
  if (weaponAudioPool) return weaponAudioPool;
  if (isMobileDevice) return null;
  weaponAudioPool = [];
  for (let i = 0; i < WEAPON_POOL_SIZE; i++) {
    const a = new Audio("assets/audio/fire.wav");
    a.volume = 0.1;
    a.preload = "auto";
    weaponAudioPool.push(a);
  }
  return weaponAudioPool;
}

function playPooledWeaponSound(volume) {
  const pool = getWeaponAudioPool();
  if (!pool) return;
  const a = pool[weaponAudioIndex % WEAPON_POOL_SIZE];
  weaponAudioIndex++;
  a.volume = volume;
  a.currentTime = 0;
  a.play().catch(() => {});
}

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
    this.spreeCount = 0;

    // Create reusable flash overlay (for kill flash)
    this.flashOverlay = document.createElement("div");
    Object.assign(this.flashOverlay.style, {
      position: "fixed",
      top: "0",
      left: "0",
      width: "100%",
      height: "100%",
      pointerEvents: "none",
      zIndex: "9999",
      opacity: "0",
      transition: "opacity 150ms ease-out",
    });
    document.body.appendChild(this.flashOverlay);

    // Create crosshair
    this.crosshair = document.createElement("div");
    Object.assign(this.crosshair.style, {
      position: "fixed",
      top: "50%",
      left: "50%",
      transform: "translate(-50%, -50%)",
      width: "4px",
      height: "4px",
      borderRadius: "50%",
      background: "rgba(255,255,255,0.7)",
      pointerEvents: "none",
      zIndex: "9998",
    });
    document.body.appendChild(this.crosshair);

    // Create hitmarker element (white X, hidden by default)
    this.hitmarker = document.createElement("div");
    Object.assign(this.hitmarker.style, {
      position: "fixed",
      top: "50%",
      left: "50%",
      transform: "translate(-50%, -50%)",
      width: "20px",
      height: "20px",
      pointerEvents: "none",
      zIndex: "9999",
      opacity: "0",
      transition: "opacity 150ms ease-out",
    });
    // Draw an X using two rotated bars
    const bar1 = document.createElement("div");
    Object.assign(bar1.style, {
      position: "absolute",
      top: "50%",
      left: "50%",
      width: "14px",
      height: "2px",
      background: "white",
      transform: "translate(-50%, -50%) rotate(45deg)",
    });
    const bar2 = document.createElement("div");
    Object.assign(bar2.style, {
      position: "absolute",
      top: "50%",
      left: "50%",
      width: "14px",
      height: "2px",
      background: "white",
      transform: "translate(-50%, -50%) rotate(-45deg)",
    });
    this.hitmarker.appendChild(bar1);
    this.hitmarker.appendChild(bar2);
    document.body.appendChild(this.hitmarker);

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

    // Multi-kill announcement element (center screen)
    this.announceEl = document.createElement("div");
    Object.assign(this.announceEl.style, {
      position: "fixed",
      top: "30%",
      left: "50%",
      transform: "translate(-50%, -50%)",
      color: "#ffcc00",
      fontSize: "42px",
      fontWeight: "bold",
      fontFamily: "Arial, sans-serif",
      textShadow: "0 0 20px rgba(255, 204, 0, 0.8), 0 0 40px rgba(255, 204, 0, 0.4)",
      pointerEvents: "none",
      zIndex: "10001",
      opacity: "0",
      transition: "opacity 0.5s ease-out",
      textAlign: "center",
      letterSpacing: "3px",
    });
    document.body.appendChild(this.announceEl);

    // Spree announcement element (below multi-kill)
    this.spreeEl = document.createElement("div");
    Object.assign(this.spreeEl.style, {
      position: "fixed",
      top: "37%",
      left: "50%",
      transform: "translate(-50%, -50%)",
      color: "#ff4444",
      fontSize: "32px",
      fontWeight: "bold",
      fontFamily: "Arial, sans-serif",
      textShadow: "0 0 20px rgba(255, 68, 68, 0.8), 0 0 40px rgba(255, 68, 68, 0.4)",
      pointerEvents: "none",
      zIndex: "10001",
      opacity: "0",
      transition: "opacity 0.5s ease-out",
      textAlign: "center",
      letterSpacing: "3px",
    });
    document.body.appendChild(this.spreeEl);

    // Listen for hit events
    this.el.sceneEl.addEventListener("local-hit", this.onLocalHit.bind(this));
    this.el.sceneEl.addEventListener("local-kill", this.onLocalKill.bind(this));

    // Listen for death to reset spree
    this._onLocalDeath = () => { this.spreeCount = 0; };
    this.el.sceneEl.addEventListener("local-death", this._onLocalDeath);
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
    playPooledWeaponSound(0.1);
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
    // Show hitmarker (white X) instead of red flash — only the victim should flash red
    this.showHitmarker();
  },

  showHitmarker() {
    if (!this.hitmarker) return;
    clearTimeout(this._hitmarkerTimer);
    this.hitmarker.style.transition = "none";
    this.hitmarker.style.opacity = "1";
    // Force reflow so the transition kicks in
    void this.hitmarker.offsetWidth;
    this.hitmarker.style.transition = "opacity 150ms ease-out";
    this._hitmarkerTimer = setTimeout(() => {
      this.hitmarker.style.opacity = "0";
    }, 80);
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
    this.spreeCount++;

    // Show multi-kill announcement
    if (this.killStreak >= 2) {
      const labels = {
        2: "DOUBLE KILL",
        3: "MULTI KILL",
        4: "ULTRA KILL",
        5: "MEGA KILL",
      };
      const text = labels[this.killStreak] || "MONSTER KILL";
      this.showAnnouncement(this.announceEl, text);
    }

    // Show spree announcement at thresholds
    const spreeLabels = { 5: "KILLING SPREE", 10: "RAMPAGE", 15: "DOMINATING", 20: "UNSTOPPABLE", 25: "GODLIKE" };
    if (spreeLabels[this.spreeCount]) {
      this.showAnnouncement(this.spreeEl, spreeLabels[this.spreeCount]);
    }

    // Play multikill sound based on streak
    this.playMultikillSound(this.killStreak);

    // Flash screen for kill (green)
    this.flashScreen("#00ff00", 150);
  },

  showAnnouncement(el, text) {
    if (!el) return;
    clearTimeout(el._hideTimer);
    el.textContent = text;
    el.style.transition = "none";
    el.style.opacity = "1";
    void el.offsetWidth;
    el.style.transition = "opacity 0.5s ease-out";
    el._hideTimer = setTimeout(() => {
      el.style.opacity = "0";
    }, 2000);
  },

  flashScreen(color, duration) {
    if (!this.flashOverlay) return;
    clearTimeout(this._flashTimer);
    this.flashOverlay.style.backgroundColor = color;
    this.flashOverlay.style.transition = "none";
    this.flashOverlay.style.opacity = "0.3";
    void this.flashOverlay.offsetWidth;
    this.flashOverlay.style.transition = `opacity ${duration}ms ease-out`;
    this._flashTimer = setTimeout(() => {
      this.flashOverlay.style.opacity = "0";
    }, 50);
  },

  playMultikillSound(streak) {
    // All streaks currently use the same sound — volume increases with streak
    const volume = Math.min(0.05, 0.01 * streak);
    playPooledWeaponSound(volume);
  },

  remove() {
    window.removeEventListener("keydown", this._onKeyDown);
    window.removeEventListener("keyup", this._onKeyUp);
    this.removeWeapon();

    // Remove touch fire button
    const fireButton = document.getElementById("touch-fire-button");
    if (fireButton) fireButton.remove();

    // Remove HUD overlays
    if (this.flashOverlay && this.flashOverlay.parentNode) this.flashOverlay.remove();
    if (this.crosshair && this.crosshair.parentNode) this.crosshair.remove();
    if (this.hitmarker && this.hitmarker.parentNode) this.hitmarker.remove();
    if (this.announceEl && this.announceEl.parentNode) this.announceEl.remove();
    if (this.spreeEl && this.spreeEl.parentNode) this.spreeEl.remove();

    // Remove death listener
    if (this._onLocalDeath) {
      this.el.sceneEl.removeEventListener("local-death", this._onLocalDeath);
    }
  },
});
