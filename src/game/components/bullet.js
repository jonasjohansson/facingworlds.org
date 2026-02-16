// bullet.js — Bullet physics and collision detection
import { createSphere, createBox3, createVector3 } from "../utils/three-helpers.js";
AFRAME.registerComponent("bullet", {
  schema: {
    vx: { type: "number", default: 0 },
    vy: { type: "number", default: 0 },
    vz: { type: "number", default: 0 },
    radius: { type: "number", default: 0.05 },
    lifeSec: { type: "number", default: 2.0 },
    ownerId: { type: "string", default: "" },
    reportHits: { type: "boolean", default: false },
  },

  init() {
    const THREE = AFRAME.THREE;
    this.vel = createVector3(this.data.vx, this.data.vy, this.data.vz);
    this.aliveFor = 0;

    this._sphere = createSphere(this.data.radius);
    this._tmp = createVector3();
    this._box = createBox3();
    this._direction = createVector3();
    this._unitZ = createVector3(0, 0, 1);
    this._quat = new AFRAME.THREE.Quaternion();

    // Create bullet visual with white core and light streak
    this.createBulletVisual();

    // Play bullet sound when created
    this.playBulletSound();

    // Emit bullet-fired event for background music
    this.el.sceneEl.emit("bullet-fired");
  },

  createBulletVisual() {
    const THREE = AFRAME.THREE;

    // Create enhanced bullet sphere with emissive glow
    const bulletGeometry = new THREE.SphereGeometry(this.data.radius * 0.4, 8, 6);
    const bulletMaterial = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      emissive: 0xffffff,
      emissiveIntensity: 0.3,
      transparent: false,
    });
    const bullet = new THREE.Mesh(bulletGeometry, bulletMaterial);
    this.el.object3D.add(bullet);

    // Store reference
    this.bullet = bullet;
  },

  // Trail effect removed for cleaner bullet appearance

  playBulletSound() {
    // Check if mobile and disable audio completely
    const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);

    if (isMobile) {
      // Disable audio completely on mobile
      return;
    }

    // Prevent multiple audio instances from playing simultaneously
    if (this.audioPlaying) {
      return;
    }

    this.audioPlaying = true;

    // Use HTML5 audio for simpler, more reliable sound playback
    try {
      const audio = new Audio("assets/audio/fire.wav");
      audio.volume = 0.01; // Very quiet for desktop only
      audio.preload = "auto";

      // Reset audio playing flag when audio ends
      audio.addEventListener("ended", () => {
        this.audioPlaying = false;
      });

      audio.play().catch((error) => {
        console.warn("[bullet] Failed to play fire.wav, using fallback:", error);
        this.audioPlaying = false;
        this.createFallbackSound();
      });
    } catch (error) {
      console.warn("[bullet] Audio error, using fallback:", error);
      this.audioPlaying = false;
      this.createFallbackSound();
    }
  },

  createFallbackSound() {
    // Create a simple bullet sound effect as fallback
    try {
      const audioContext = new (window.AudioContext || window.webkitAudioContext)();

      if (audioContext.state === "suspended") {
        audioContext.resume();
      }

      const oscillator = audioContext.createOscillator();
      const gainNode = audioContext.createGain();

      oscillator.connect(gainNode);
      gainNode.connect(audioContext.destination);

      // High frequency sound for bullet
      oscillator.frequency.setValueAtTime(1200, audioContext.currentTime);
      oscillator.frequency.exponentialRampToValueAtTime(200, audioContext.currentTime + 0.1);
      oscillator.type = "square";

      gainNode.gain.setValueAtTime(0.1, audioContext.currentTime);
      gainNode.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + 0.1);

      oscillator.start(audioContext.currentTime);
      oscillator.stop(audioContext.currentTime + 0.1);
    } catch (error) {
      console.warn("[bullet] Fallback sound failed:", error);
    }
  },

  tick(time, dtMs) {
    const dt = dtMs / 1000;
    this.aliveFor += dt;

    if (this.aliveFor > this.data.lifeSec) return this._despawn();

    // integrate motion
    const o = this.el.object3D;
    o.position.x += this.vel.x * dt;
    o.position.y += this.vel.y * dt;
    o.position.z += this.vel.z * dt;

    // Orient bullet in direction of movement
    if (this.vel.lengthSq() > 0) {
      this._direction.copy(this.vel).normalize();
      this._quat.setFromUnitVectors(this._unitZ, this._direction);
      o.quaternion.copy(this._quat);
    }

    // update world-sphere
    this._sphere.center.copy(o.getWorldPosition(this._tmp));
    this._sphere.radius = this.data.radius;

    // hit players (both local and remote)
    const avatars = this.el.sceneEl.querySelectorAll(".avatar");
    for (let i = 0; i < avatars.length; i++) {
      const avatar = avatars[i];
      const pid = avatar.dataset.playerId;
      if (!pid || pid === this.data.ownerId) continue;

      // For local player, check the soldier entity inside rig
      // For remote players, check the soldier entity inside their rig
      let targetEntity = avatar;
      if (avatar.id === "rig") {
        // Local player - check the soldier inside the rig
        targetEntity = avatar.querySelector("#soldier");
      } else if (avatar.id.startsWith("remote-rig-")) {
        // Remote player - check the soldier inside the remote rig
        targetEntity = avatar.querySelector("[remote-avatar]");
      }

      if (!targetEntity) continue;

      const chest = targetEntity.object3D.getWorldPosition(this._tmp);
      const chestY = chest.y + 1.0; // tweak for model
      const dx = this._sphere.center.x - chest.x;
      const dy = this._sphere.center.y - chestY;
      const dz = this._sphere.center.z - chest.z;
      const rr = this.data.radius + 0.35;

      if (dx * dx + dy * dy + dz * dz <= rr * rr) {
        if (this.data.reportHits) {
          // Only report victim; server decides damage (e.g., 20)
          this.el.sceneEl.emit("local-hit", { victimId: pid });
        }
        return this._despawn();
      }
    }

    // hit targets (optional)
    const targets = this.el.sceneEl.querySelectorAll(".target");
    for (let i = 0; i < targets.length; i++) {
      const tEl = targets[i];
      const tComp = tEl.components.target;
      if (tComp && tComp.intersectsSphere) {
        if (tComp.intersectsSphere(this._sphere)) {
          tComp.takeHit && tComp.takeHit();
          return this._despawn();
        }
      } else {
        const obj = tEl.object3D;
        if (!obj) continue;
        this._box.setFromObject(obj);
        if (this._box.intersectsSphere(this._sphere)) {
          tEl.setAttribute("material", "color", "#ff4444");
          return this._despawn();
        }
      }
    }
  },

  _despawn() {
    if (this.el.parentNode) this.el.parentNode.removeChild(this.el);
  },
});
