// /js/shooter-gun.js
AFRAME.registerComponent("shooter-gun", {
  schema: {
    bulletSpeed: { type: "number", default: 18 }, // m/s
    bulletRadius: { type: "number", default: 0.08 }, // meters
    lifeSec: { type: "number", default: 2.0 }, // seconds
    fireRate: { type: "number", default: 8 }, // bullets per second
    muzzleHeight: { type: "number", default: 1.2 }, // meters above player origin
    color: { type: "color", default: "#ffcc00" },
    spawnLocal: { type: "boolean", default: true }, // let shooter-spawn act on this
  },

  init() {
    this.triggerDown = false;
    this._lastShotAtS = 0;

    this._onTrigger = (e) => {
      this.triggerDown = !!(e && e.detail && e.detail.down);
    };
    this.el.addEventListener("shooter:trigger", this._onTrigger);
  },

  remove() {
    this.el.removeEventListener("shooter:trigger", this._onTrigger);
  },

  tick(timeMs) {
    if (!this.triggerDown) return;
    const nowS = timeMs / 1000;
    const minInterval = 1 / Math.max(1, this.data.fireRate);
    if (nowS - this._lastShotAtS < minInterval) return;

    this._lastShotAtS = nowS;
    this._fireOnce();
  },

  _fireOnce() {
    const THREE = AFRAME.THREE;

    // Origin at player world pos + muzzle height
    const origin = new THREE.Vector3();
    this.el.object3D.getWorldPosition(origin);
    origin.y += this.data.muzzleHeight;

    // Forward (-Z) in world
    const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(this.el.object3D.quaternion).normalize();

    // Always tell multiplayer/system layer
    this.el.sceneEl.emit("local-fire", {
      origin: { x: origin.x, y: origin.y, z: origin.z },
      dir: { x: dir.x, y: dir.y, z: dir.z },
      gun: {
        speed: this.data.bulletSpeed,
        radius: this.data.bulletRadius,
        life: this.data.lifeSec,
        color: this.data.color,
        spawnLocal: this.data.spawnLocal,
      },
      ownerId: this.el.dataset.playerId || "",
    });
  },
});
