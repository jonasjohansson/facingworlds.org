// first-person-weapon.js — First-person weapon view and shooting
AFRAME.registerComponent("first-person-weapon", {
  schema: {
    enabled: { type: "boolean", default: true },
    weaponModel: { type: "string", default: "#enforcer-weapon" },
    weaponScale: { type: "vec3", default: { x: 0.1, y: 0.1, z: 0.1 } },
    weaponPosition: { type: "vec3", default: { x: 0.3, y: -0.2, z: -0.5 } },
    weaponRotation: { type: "vec3", default: { x: 0, y: 0, z: 0 } },
    muzzleOffset: { type: "vec3", default: { x: 0.8, y: 0.1, z: 0 } }, // Position relative to weapon where bullets spawn
    fireRate: { type: "number", default: 10 }, // Bullets per second
    lastFireTime: { type: "number", default: 0 },
  },

  init() {
    this.weapon = null;
    this.muzzlePosition = new THREE.Vector3();
    this.isFiring = false;
    this.lastFireTime = 0;

    // Wait for camera to be ready
    this.el.addEventListener("loaded", () => {
      this.setupWeapon();
    });

    // Listen for key presses directly (X key)
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
    if (!this.data.enabled) return;

    // Find the weapon entity (should be a child of the soldier)
    const soldier = this.el.sceneEl.querySelector("#soldier");
    this.weapon = soldier ? soldier.querySelector("#player-weapon") : null;

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

    console.log("[first-person-weapon] Found weapon entity:", this.weapon);
  },

  setupMuzzlePosition() {
    // Get muzzle position from the weapon-muzzle entity
    const soldier = this.el.sceneEl.querySelector("#soldier");
    const muzzle = soldier ? soldier.querySelector("#weapon-muzzle") : null;

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

    console.log("[first-person-weapon] Firing bullet from first-person weapon");

    // Update muzzle position
    this.setupMuzzlePosition();

    // Get camera direction (this.el is the camera)
    const cameraDirection = new THREE.Vector3();
    this.el.object3D.getWorldDirection(cameraDirection);
    console.log("[first-person-weapon] Camera direction:", cameraDirection);

    // Reverse direction since getWorldDirection gives opposite of what we want
    cameraDirection.negate();

    // Don't create bullet here - let network layer handle it
    // This prevents double bullets while still notifying network

    // Emit to network layer for multiplayer (but don't create visual bullet)
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

    console.log("[first-person-weapon] Fired bullet from muzzle position:", this.muzzlePosition);
  },

  playWeaponSound() {
    // Use the same fire sound as bullets
    try {
      const audio = new Audio("assets/audio/fire.wav");
      audio.volume = 0.5;
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

  remove() {
    window.removeEventListener("keydown", this._onKeyDown);
    window.removeEventListener("keyup", this._onKeyUp);
    this.removeWeapon();
  },
});
