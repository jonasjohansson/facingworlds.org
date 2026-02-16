// bullet.js — Bullet physics and collision detection
import { createSphere, createBox3, createVector3 } from "../utils/three-helpers.js";

// ---- shared audio pool (module-level, shared across all bullet instances) ----
const AUDIO_POOL_SIZE = 4;
let audioPool = null;
let audioPoolIndex = 0;
const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);

function getAudioPool() {
  if (audioPool) return audioPool;
  if (isMobile) return null;
  audioPool = [];
  for (let i = 0; i < AUDIO_POOL_SIZE; i++) {
    const a = new Audio("assets/audio/fire.wav");
    a.volume = 0.01;
    a.preload = "auto";
    audioPool.push(a);
  }
  return audioPool;
}

function playPooledAudio() {
  const pool = getAudioPool();
  if (!pool) return;
  const a = pool[audioPoolIndex % AUDIO_POOL_SIZE];
  audioPoolIndex++;
  a.currentTime = 0;
  a.play().catch(() => {});
}

// ---- cached avatar list (refreshed on join/leave) ----
let cachedAvatars = null;

function getAvatars(sceneEl) {
  if (cachedAvatars) return cachedAvatars;
  cachedAvatars = sceneEl.querySelectorAll(".avatar");
  // Refresh on join/leave
  const refresh = () => { cachedAvatars = sceneEl.querySelectorAll(".avatar"); };
  sceneEl.addEventListener("player-join", refresh);
  sceneEl.addEventListener("player-leave", refresh);
  return cachedAvatars;
}

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

    // Create bullet visual with tracer trail
    this.createBulletVisual();

    // Play bullet sound from shared pool
    playPooledAudio();

    // Emit bullet-fired event for background music
    this.el.sceneEl.emit("bullet-fired");
  },

  createBulletVisual() {
    const THREE = AFRAME.THREE;

    // Bright bullet head
    const bulletGeometry = new THREE.SphereGeometry(this.data.radius * 0.4, 8, 6);
    const bulletMaterial = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      emissive: 0xffffff,
      emissiveIntensity: 0.3,
    });
    const bullet = new THREE.Mesh(bulletGeometry, bulletMaterial);
    this.el.object3D.add(bullet);
    this.bullet = bullet;

    // Tracer trail — stretched cylinder behind the bullet
    const trailLength = 0.6;
    const trailGeo = new THREE.CylinderGeometry(0.01, 0.005, trailLength, 4, 1);
    // Shift geometry so the front end sits at origin
    trailGeo.translate(0, -trailLength / 2, 0);
    // Rotate so Y-axis aligns with Z (forward)
    trailGeo.rotateX(Math.PI / 2);
    const trailMat = new THREE.MeshBasicMaterial({
      color: 0xffffaa,
      transparent: true,
      opacity: 0.7,
    });
    const trail = new THREE.Mesh(trailGeo, trailMat);
    this.el.object3D.add(trail);
    this.trail = trail;
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

    // hit players (both local and remote) — uses cached NodeList
    const avatars = getAvatars(this.el.sceneEl);
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
    // Dispose Three.js resources to prevent GPU memory leak
    if (this.bullet) {
      this.bullet.geometry.dispose();
      this.bullet.material.dispose();
    }
    if (this.trail) {
      this.trail.geometry.dispose();
      this.trail.material.dispose();
    }
    if (this.el.parentNode) this.el.parentNode.removeChild(this.el);
  },
});
