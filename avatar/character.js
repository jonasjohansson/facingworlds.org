// character.js — weight-blending + correct facing + jump with momentum carry + speed + cadence
AFRAME.registerComponent("minichar", {
  schema: {
    // clips
    idleIdx: { type: "int", default: 0 },
    walkIdx: { type: "int", default: 3 },
    runIdx: { type: "int", default: 1 },
    // locomotion speeds (m/s)
    walkSpeed: { type: "number", default: 1.6 },
    runSpeed: { type: "number", default: 3.2 },
    // animation cadence reference
    walkCycleMps: { type: "number", default: 1.6 },
    runCycleMps: { type: "number", default: 3.2 },
    minTimeScale: { type: "number", default: 0.6 },
    maxTimeScale: { type: "number", default: 1.8 },
    // facing trim (extra manual deg; usually leave 0)
    yawOffsetDeg: { type: "number", default: 0 },
    // blending responsiveness (0..1)
    fadeLerp: { type: "number", default: 0.2 },
    jumpTimeScale: { type: "number", default: 1.0 }, // >1.0 = faster up/down, same height

    // Jump (procedural) + momentum
    jumpHeight: { type: "number", default: 1.5 }, // meters
    gravity: { type: "number", default: 9.8 }, // m/s^2
    groundY: { type: "number", default: 0 }, // floor height
    conserveMomentum: { type: "boolean", default: true },
    takeoffBoost: { type: "number", default: 1.0 }, // multiply takeoff ground speed
    airDrag: { type: "number", default: 0.1 }, // per-second drag on air velocity (0=no drag)
    airAccel: { type: "number", default: 4.0 }, // m/s^2 steering acceleration toward desired

    // reporting
    smoothSpeedLerp: { type: "number", default: 0.35 },
  },

  init() {
    const T = (this.THREE = AFRAME.THREE);
    this.clock = new T.Clock();
    this.mixer = null;

    // anims always playing; blend weights
    this.actions = { Idle: null, Walk: null, Run: null };
    this.weights = { Idle: 1, Walk: 0, Run: 0 };
    this.target = { Idle: 1, Walk: 0, Run: 0 };

    // input & motion
    this.keys = { f: false, b: false, l: false, r: false, shift: false, space: false };
    this.pos = new T.Vector3();
    this.prevPos = new T.Vector3();
    this.move = new T.Vector3(); // ground step for this frame (xz)
    this.airVel = new T.Vector3(); // horizontal momentum while airborne (m/s)
    this.lastDir = new T.Vector3(0, 0, -1); // fallback jump direction if not moving
    this.up = new T.Vector3(0, 1, 0);
    this.targetQuat = new T.Quaternion();

    // facing correction
    this.facingFix = 0;

    // jump state
    this.isJumping = false;
    this.vy = 0;

    // speed reporting
    this.speedMps = 0;
    this._rawSpeed = 0;

    // key listeners
    const down = (c) => {
      switch (c) {
        case "ArrowUp":
        case "KeyW":
        case "KeyZ":
          this.keys.f = true;
          break;
        case "ArrowDown":
        case "KeyS":
          this.keys.b = true;
          break;
        case "ArrowLeft":
        case "KeyA":
        case "KeyQ":
          this.keys.l = true;
          break;
        case "ArrowRight":
        case "KeyD":
          this.keys.r = true;
          break;
        case "ShiftLeft":
        case "ShiftRight":
          this.keys.shift = true;
          break;
        case "Space":
          this.keys.space = true;
          break;
      }
    };
    const up = (c) => {
      switch (c) {
        case "ArrowUp":
        case "KeyW":
        case "KeyZ":
          this.keys.f = false;
          break;
        case "ArrowDown":
        case "KeyS":
          this.keys.b = false;
          break;
        case "ArrowLeft":
        case "KeyA":
        case "KeyQ":
          this.keys.l = false;
          break;
        case "ArrowRight":
        case "KeyD":
          this.keys.r = false;
          break;
        case "ShiftLeft":
        case "ShiftRight":
          this.keys.shift = false;
          break;
        case "Space":
          this.keys.space = false;
          break;
      }
    };
    this._onDown = (e) => {
      down(e.code);
    };
    this._onUp = (e) => {
      up(e.code);
    };
    window.addEventListener("keydown", this._onDown);
    window.addEventListener("keyup", this._onUp);
    window.addEventListener(
      "blur",
      (this._onBlur = () => {
        this.keys = { f: false, b: false, l: false, r: false, shift: false, space: false };
      })
    );

    // model
    this.el.addEventListener("model-loaded", (e) => {
      const mesh = this.el.getObject3D("mesh") || e.detail.model;
      if (!mesh) return;

      // auto-face world -Z (movement forward)
      const qWorld = new this.THREE.Quaternion();
      this.el.object3D.getWorldQuaternion(qWorld);
      const fwd = new this.THREE.Vector3(0, 0, -1).applyQuaternion(qWorld);
      const autoAngle = -Math.atan2(fwd.x, fwd.z);
      const manualTrim = (this.data.yawOffsetDeg * Math.PI) / 180;
      this.facingFix = autoAngle + manualTrim;

      mesh.traverse((o) => {
        if (o.isMesh) {
          o.castShadow = true;
          o.receiveShadow = true;
        }
      });
      const clips = mesh.animations || [];
      const get = (i) => clips[i] || null;
      const idle = get(this.data.idleIdx),
        walk = get(this.data.walkIdx),
        run = get(this.data.runIdx);
      if (!idle || !walk || !run) {
        console.warn(
          "Missing clips:",
          clips.map((c) => c.name)
        );
        return;
      }

      this.mixer = new this.THREE.AnimationMixer(mesh);
      this.actions.Idle = this._prep(this.mixer.clipAction(idle), 1);
      this.actions.Walk = this._prep(this.mixer.clipAction(walk), 0);
      this.actions.Run = this._prep(this.mixer.clipAction(run), 0);

      this.prevPos.copy(this.el.object3D.position);
    });
  },

  _prep(action, w) {
    action.setLoop(this.THREE.LoopRepeat, Infinity);
    action.enabled = true;
    action.setEffectiveTimeScale(1);
    action.setEffectiveWeight(w);
    action.play();
    return action;
  },

  _onGround() {
    return this.pos.y <= this.data.groundY + 1e-4;
  },

  _maybeStartJump(moving, running, x, z) {
    if (this.isJumping || !this._onGround() || !this.keys.space) return;

    // Vertical launch for desired apex
    this.vy = Math.sqrt(2 * this.data.gravity * Math.max(0.01, this.data.jumpHeight));
    this.vy *= this.data.jumpTimeScale; // NEW

    this.isJumping = true;

    // Horizontal momentum at takeoff (based on current ground speed & direction)
    if (this.data.conserveMomentum) {
      const groundSpeed = (running ? this.data.runSpeed : this.data.walkSpeed) * this.data.takeoffBoost;
      let dir = this.lastDir.clone();
      if (moving) {
        dir.set(x, 0, z).normalize(); // world xz
        this.lastDir.copy(dir); // remember last ground heading
      }
      this.airVel.copy(dir).multiplyScalar(groundSpeed); // m/s
    } else {
      this.airVel.set(0, 0, 0);
    }

    // While airborne, bias animation to Idle (min foot sliding)
    this.target.Idle = 1;
    this.target.Walk = 0;
    this.target.Run = 0;
  },

  _updateCadence() {
    const w = this.weights,
      { minTimeScale, maxTimeScale, walkCycleMps, runCycleMps } = this.data;
    const v = this._rawSpeed;
    let walkScale = v / Math.max(0.001, walkCycleMps);
    let runScale = v / Math.max(0.001, runCycleMps);
    let blended = w.Idle * 1.0 + w.Walk * walkScale + w.Run * runScale;
    blended = Math.min(maxTimeScale, Math.max(minTimeScale, blended));
    this.actions.Idle.setEffectiveTimeScale(1.0);
    this.actions.Walk.setEffectiveTimeScale(blended);
    this.actions.Run.setEffectiveTimeScale(blended);
  },

  tick() {
    if (!this.mixer) return;
    const dt = this.clock.getDelta();

    // Inputs (world space; forward = -Z)
    const z = (this.keys.b ? 1 : 0) + (this.keys.f ? -1 : 0);
    const x = (this.keys.r ? 1 : 0) + (this.keys.l ? -1 : 0);
    const moving = x !== 0 || z !== 0;
    const running = this.keys.shift && moving;

    // Try to start jump (captures takeoff momentum)
    this._maybeStartJump(moving, running, x, z);

    // Animation target weights (frozen in air; normal on ground)
    if (!this.isJumping) {
      this.target.Idle = moving ? 0 : 1;
      this.target.Walk = moving && !running ? 1 : 0;
      this.target.Run = running ? 1 : 0;
    }

    // Smooth blend
    const a = this.actions,
      w = this.weights,
      t = this.target,
      lerp = this.data.fadeLerp;
    w.Idle += (t.Idle - w.Idle) * lerp;
    w.Walk += (t.Walk - w.Walk) * lerp;
    w.Run += (t.Run - w.Run) * lerp;
    a.Idle.setEffectiveWeight(w.Idle);
    a.Walk.setEffectiveWeight(w.Walk);
    a.Run.setEffectiveWeight(w.Run);

    // --- HORIZONTAL MOTION ---
    // Ground motion from input
    this.move.set(0, 0, 0);
    if (!this.isJumping && moving) {
      const speed = running ? this.data.runSpeed : this.data.walkSpeed;
      this.move
        .set(x, 0, z)
        .normalize()
        .multiplyScalar(speed * dt);
      this.pos.add(this.move);
      // remember last grounded heading
      this.lastDir.copy(new this.THREE.Vector3(x, 0, z).normalize());
    }

    // Airborne momentum + steering
    if (this.isJumping) {
      // Air drag (exponential decay per second)
      const drag = Math.max(0, 1 - this.data.airDrag * dt);
      this.airVel.multiplyScalar(drag);

      // Steering toward desired horizontal velocity
      if (moving) {
        const desired = new this.THREE.Vector3(x, 0, z)
          .normalize()
          .multiplyScalar(this.keys.shift ? this.data.runSpeed : this.data.walkSpeed);
        // Accelerate airVel toward desired at airAccel (m/s^2)
        const t = Math.min(1, (this.data.airAccel * dt) / Math.max(0.001, desired.length()));
        this.airVel.lerp(desired, t);
      }
      // Apply horizontal momentum
      this.pos.addScaledVector(this.airVel, dt);
    }

    // --- VERTICAL MOTION ---
    if (this.isJumping || !this._onGround()) {
      const gEff = this.data.gravity * this.data.jumpTimeScale * this.data.jumpTimeScale; // NEW
      this.vy -= gEff * dt; // replace old gravity line
      this.pos.y += this.vy * dt;

      if (this.pos.y <= this.data.groundY) {
        // Land
        this.pos.y = this.data.groundY;
        this.vy = 0;
        this.isJumping = false;
        // restore ground targets based on current inputs
        this.target.Idle = moving ? 0 : 1;
        this.target.Walk = moving && !running ? 1 : 0;
        this.target.Run = running ? 1 : 0;
        // reset air vel
        this.airVel.set(0, 0, 0);
      }
    }

    // Apply position
    this.el.object3D.position.copy(this.pos);

    // Facing: ground uses move vector; air uses airVel
    const faceVec = !this.isJumping ? this.move : this.airVel;
    if (faceVec.lengthSq() > 1e-6) {
      const angle = Math.atan2(faceVec.x, faceVec.z) + this.facingFix;
      this.targetQuat.setFromAxisAngle(this.up, angle);
      this.el.object3D.quaternion.slerp(this.targetQuat, 0.14);
    }

    // Speed (ground horizontal)
    const dx = this.pos.x - this.prevPos.x;
    const dz = this.pos.z - this.prevPos.z;
    this._rawSpeed = dt > 0 ? Math.sqrt(dx * dx + dz * dz) / dt : 0;

    // Cadence sync + event
    this._updateCadence();
    this.speedMps += (this._rawSpeed - this.speedMps) * this.data.smoothSpeedLerp;
    this.el.emit("speed", {
      mps: this.speedMps,
      normalized: Math.min(1, this.speedMps / Math.max(this.data.runSpeed, 0.001)),
      running,
    });

    this.prevPos.copy(this.pos);
    this.mixer.update(dt);
  },

  remove() {
    window.removeEventListener("keydown", this._onDown);
    window.removeEventListener("keyup", this._onUp);
    window.removeEventListener("blur", this._onBlur);
    if (this.mixer) this.mixer.stopAllAction();
  },
});
