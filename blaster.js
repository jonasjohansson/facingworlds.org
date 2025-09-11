// blaster.js — simple left-click shooter with sphere bullets & target collisions

AFRAME.registerComponent("blaster", {
  schema: {
    bulletSpeed: { type: "number", default: 18 }, // m/s
    bulletRadius: { type: "number", default: 0.08 }, // meters (visual + collision)
    lifeSec: { type: "number", default: 2.0 }, // seconds before auto-despawn
    fireRate: { type: "number", default: 8 }, // bullets per second
    muzzleHeight: { type: "number", default: 1.2 }, // offset from character origin
    color: { type: "color", default: "#ffcc00" },
  },

  init() {
    this.isMouseDown = false;
    this._lastShotAt = 0;
    this._onDown = (e) => {
      if (e.button === 0) {
        this.isMouseDown = true;
      }
    };
    this._onUp = (e) => {
      if (e.button === 0) {
        this.isMouseDown = false;
      }
    };
    this._onContext = (e) => e.preventDefault();

    // capture on canvas so UI clicks outside don't fire
    const canvas = this.el.sceneEl.canvas;
    if (canvas) {
      canvas.addEventListener("mousedown", this._onDown);
      canvas.addEventListener("mouseup", this._onUp);
      canvas.addEventListener("contextmenu", this._onContext);
    } else {
      this.el.sceneEl.addEventListener("render-target-loaded", () => {
        const cv = this.el.sceneEl.canvas;
        cv.addEventListener("mousedown", this._onDown);
        cv.addEventListener("mouseup", this._onUp);
        cv.addEventListener("contextmenu", this._onContext);
      });
    }
  },

  remove() {
    const canvas = this.el.sceneEl.canvas;
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
    if (now - this._lastShotAt >= minInterval) {
      this._lastShotAt = now;
      this._fireOne();
    }
  },

  _fireOne() {
    const THREE = AFRAME.THREE;
    const b = document.createElement("a-entity");

    // Start position = character position + up offset
    const origin = new THREE.Vector3();
    this.el.object3D.getWorldPosition(origin);
    origin.y += this.data.muzzleHeight;

    // Direction = character forward (-Z) in world space
    const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(this.el.object3D.quaternion).normalize();

    b.setAttribute("position", `${origin.x} ${origin.y} ${origin.z}`);
    b.setAttribute("geometry", `primitive: sphere; radius: ${this.data.bulletRadius}`);
    b.setAttribute("material", `color: ${this.data.color}; metalness: 0.2; roughness: 0.4; opacity: 0.95`);
    b.setAttribute("shadow", "cast:true");

    // bullet behavior
    b.setAttribute("bullet", {
      vx: dir.x * this.data.bulletSpeed,
      vy: dir.y * this.data.bulletSpeed,
      vz: dir.z * this.data.bulletSpeed,
      radius: this.data.bulletRadius,
      lifeSec: this.data.lifeSec,
    });

    this.el.sceneEl.appendChild(b);
  },
});

// Bullet moves straight, checks collisions vs .target AABBs, and despawns on hit or timeout
AFRAME.registerComponent("bullet", {
  schema: {
    vx: { type: "number" },
    vy: { type: "number" },
    vz: { type: "number" },
    radius: { type: "number", default: 0.08 },
    lifeSec: { type: "number", default: 2.0 },
  },
  init() {
    const THREE = AFRAME.THREE;
    this.vel = new THREE.Vector3(this.data.vx || 0, this.data.vy || 0, this.data.vz || 0);
    this.aliveFor = 0;
    this._sphere = new THREE.Sphere(new THREE.Vector3(), this.data.radius);
    this._tmp = new THREE.Vector3();
  },
  tick(time, dtMs) {
    const dt = dtMs / 1000;
    this.aliveFor += dt;
    if (this.aliveFor > this.data.lifeSec) {
      this._despawn();
      return;
    }

    // Integrate position
    const obj = this.el.object3D;
    obj.position.x += this.vel.x * dt;
    obj.position.y += this.vel.y * dt;
    obj.position.z += this.vel.z * dt;

    // Update world-space sphere for collision
    this._sphere.center.copy(obj.getWorldPosition(this._tmp));
    this._sphere.radius = this.data.radius;

    // Test against all targets (cheap for dozens)
    const targets = this.el.sceneEl.querySelectorAll(".target");
    for (let i = 0; i < targets.length; i++) {
      const tc = targets[i].components.target;
      if (!tc) continue;
      if (tc.intersectsSphere(this._sphere)) {
        tc.takeHit();
        this._despawn();
        break;
      }
    }
  },
  _despawn() {
    // tiny pop / fade optional
    this.el.parentNode && this.el.parentNode.removeChild(this.el);
  },
});
