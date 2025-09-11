// blaster.js — left-click shooter + bullet logic (avatars + targets collisions)

AFRAME.registerComponent("blaster", {
  schema: {
    bulletSpeed: { type: "number", default: 18 }, // m/s
    bulletRadius: { type: "number", default: 0.08 }, // meters
    lifeSec: { type: "number", default: 2.0 }, // seconds
    fireRate: { type: "number", default: 8 }, // bullets per second
    muzzleHeight: { type: "number", default: 1.2 }, // meters above player origin
    color: { type: "color", default: "#ffcc00" },
    // If you're using network.js to spawn the local bullet (and send to server), set this to false.
    spawnLocal: { type: "boolean", default: true },
  },

  init() {
    this.isMouseDown = false;
    this._lastShotAt = 0;

    this._onDown = (e) => {
      if (e.button === 0) {
        console.log("🔫 mouse down");
        this.isMouseDown = true;
      }
    };
    this._onUp = (e) => {
      if (e.button === 0) {
        this.isMouseDown = false;
      }
    };
    this._onContext = (e) => e.preventDefault();

    const attach = (canvas) => {
      if (!canvas) return;
      canvas.addEventListener("mousedown", this._onDown);
      canvas.addEventListener("mouseup", this._onUp);
      canvas.addEventListener("contextmenu", this._onContext);
      console.log("✅ Blaster mouse listeners attached");
    };

    const scene = this.el.sceneEl;
    if (scene.hasLoaded && scene.canvas) {
      attach(scene.canvas);
    } else {
      scene.addEventListener("loaded", () => attach(scene.canvas), { once: true });
    }
  },
  remove() {
    const canvas = this.el.sceneEl && this.el.sceneEl.canvas;
    if (canvas) {
      canvas.removeEventListener("mousedown", this._onDown);
      canvas.removeEventListener("mouseup", this._onUp);
      canvas.removeEventListener("contextmenu", this._onContext);
    }
  },

  tick(time, dtMs) {
    if (!this.isMouseDown) return;
    const now = time / 1000;
    const minInterval = 1 / Math.max(1, this.data.fireRate);
    if (now - this._lastShotAt < minInterval) return;
    this._lastShotAt = now;
    this._fireOne();
  },

  _fireOne() {
    const THREE = AFRAME.THREE;

    // World-space origin = player position + muzzleHeight
    const origin = new THREE.Vector3();
    this.el.object3D.getWorldPosition(origin);
    origin.y += this.data.muzzleHeight;

    // Direction = player forward (-Z) in world
    const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(this.el.object3D.quaternion).normalize();

    // Always notify multiplayer layer (it can forward to server)
    this.el.sceneEl.emit("local-fire", { origin: { x: origin.x, y: origin.y, z: origin.z }, dir: { x: dir.x, y: dir.y, z: dir.z } });

    // Optionally spawn our own local bullet (single-player OR if your net layer doesn’t spawn)
    if (this.data.spawnLocal) {
      const b = document.createElement("a-entity");
      b.setAttribute("position", `${origin.x} ${origin.y} ${origin.z}`);
      b.setAttribute("geometry", `primitive: sphere; radius: ${this.data.bulletRadius}`);
      b.setAttribute("material", `color: ${this.data.color}; opacity: 0.95; metalness:0.2; roughness:0.4`);
      b.setAttribute("shadow", "cast:true");

      const vx = dir.x * this.data.bulletSpeed;
      const vy = dir.y * this.data.bulletSpeed;
      const vz = dir.z * this.data.bulletSpeed;

      // Owner id (if present) so we don’t hit ourselves; reportHits:true so we can emit local-hit
      const ownerId = this.el.dataset.playerId || "";
      b.setAttribute("bullet", {
        vx,
        vy,
        vz,
        radius: this.data.bulletRadius,
        lifeSec: this.data.lifeSec,
        ownerId,
        reportHits: true,
      });

      this.el.sceneEl.appendChild(b);
    }
    console.log("🔫 local-fire emitted", origin, dir, "spawnLocal=", this.data.spawnLocal);
  },
});

AFRAME.registerComponent("bullet", {
  schema: {
    vx: { type: "number", default: 0 },
    vy: { type: "number", default: 0 },
    vz: { type: "number", default: 0 },
    radius: { type: "number", default: 0.08 },
    lifeSec: { type: "number", default: 2.0 },
    ownerId: { type: "string", default: "" },
    reportHits: { type: "boolean", default: false },
  },

  init() {
    const THREE = AFRAME.THREE;
    this.vel = new THREE.Vector3(this.data.vx, this.data.vy, this.data.vz);
    this.aliveFor = 0;

    this._sphere = new THREE.Sphere(new THREE.Vector3(), this.data.radius);
    this._tmp = new THREE.Vector3();
    this._box = new THREE.Box3();
  },

  tick(time, dtMs) {
    const dt = dtMs / 1000;
    this.aliveFor += dt;

    if (this.aliveFor > this.data.lifeSec) {
      this._despawn();
      return;
    }

    // Integrate
    const o = this.el.object3D;
    o.position.x += this.vel.x * dt;
    o.position.y += this.vel.y * dt;
    o.position.z += this.vel.z * dt;

    // Update world-space sphere
    this._sphere.center.copy(o.getWorldPosition(this._tmp));
    this._sphere.radius = this.data.radius;

    // 1) Hit players (entities with class 'avatar' + data-player-id)
    const avatars = this.el.sceneEl.querySelectorAll(".avatar");
    for (let i = 0; i < avatars.length; i++) {
      const a = avatars[i];
      const pid = a.dataset.playerId;
      if (!pid || pid === this.data.ownerId) continue; // ignore self

      // Sphere-vs-sphere around chest
      const chest = a.object3D.getWorldPosition(this._tmp);
      const chestY = chest.y + 1.0; // tweak to your model chest height

      const dx = this._sphere.center.x - chest.x;
      const dy = this._sphere.center.y - chestY;
      const dz = this._sphere.center.z - chest.z;

      const rr = this.data.radius + 0.35; // player radius ~0.35m
      if (dx * dx + dy * dy + dz * dz <= rr * rr) {
        if (this.data.reportHits) {
          // Don’t emit damage here!
          this.el.sceneEl.emit("local-hit", { victimId: pid, dmg: 0 });
        }
        this._despawn();
        return;
      }
    }

    // 2) Hit targets (your cube targets with component 'target')
    const targets = this.el.sceneEl.querySelectorAll(".target");
    for (let i = 0; i < targets.length; i++) {
      const tEl = targets[i];
      const tComp = tEl.components.target;

      // Prefer component API if available
      if (tComp && tComp.intersectsSphere) {
        if (tComp.intersectsSphere(this._sphere)) {
          tComp.takeHit && tComp.takeHit();
          this._despawn();
          return;
        }
      } else {
        // Fallback AABB test if no component API
        const obj = tEl.object3D;
        if (!obj) continue;
        this._box.setFromObject(obj);
        if (this._box.intersectsSphere(this._sphere)) {
          // crude feedback
          tEl.setAttribute("material", "color", "#ff4444");
          this._despawn();
          return;
        }
      }
    }
  },

  _despawn() {
    if (this.el.parentNode) this.el.parentNode.removeChild(this.el);
  },
});
