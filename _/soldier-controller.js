// Minimal Idle/Walk/Run controller with fixed camera and optional bounds
AFRAME.registerComponent("minichar", {
  schema: {
    idleIdx: { type: "int", default: 0 },
    walkIdx: { type: "int", default: 3 },
    runIdx: { type: "int", default: 1 },
    fade: { type: "number", default: 0.35 },
    walkSpeed: { type: "number", default: 1.6 },
    runSpeed: { type: "number", default: 3.2 },
    yawOffsetDeg: { type: "number", default: 180 },
    // keep character within a circle around origin so static camera keeps it in frame.
    // set to -1 to disable clamping
    boundsRadius: { type: "number", default: 5 },
  },

  init() {
    const T = (this.THREE = AFRAME.THREE);
    this.clock = new T.Clock();
    this.mixer = null;
    this.actions = { Idle: null, Walk: null, Run: null };
    this.current = "Idle";

    this.key = [0, 0, 0]; // [forward/back, left/right, shift]
    this.pos = new T.Vector3();
    this.move = new T.Vector3();
    this.up = new T.Vector3(0, 1, 0);
    this.targetQuat = new T.Quaternion();
    this.yawOffset = (this.data.yawOffsetDeg * Math.PI) / 180;

    // keyboard
    window.addEventListener(
      "keydown",
      (this.onDown = (e) => {
        const k = this.key;
        switch (e.code) {
          case "ArrowUp":
          case "KeyW":
          case "KeyZ":
            k[0] = -1;
            break;
          case "ArrowDown":
          case "KeyS":
            k[0] = 1;
            break;
          case "ArrowLeft":
          case "KeyA":
          case "KeyQ":
            k[1] = -1;
            break;
          case "ArrowRight":
          case "KeyD":
            k[1] = 1;
            break;
          case "ShiftLeft":
          case "ShiftRight":
            k[2] = 1;
            break;
        }
      })
    );
    window.addEventListener(
      "keyup",
      (this.onUp = (e) => {
        const k = this.key;
        switch (e.code) {
          case "ArrowUp":
          case "KeyW":
          case "KeyZ":
            if (k[0] < 0) k[0] = 0;
            break;
          case "ArrowDown":
          case "KeyS":
            if (k[0] > 0) k[0] = 0;
            break;
          case "ArrowLeft":
          case "KeyA":
          case "KeyQ":
            if (k[1] < 0) k[1] = 0;
            break;
          case "ArrowRight":
          case "KeyD":
            if (k[1] > 0) k[1] = 0;
            break;
          case "ShiftLeft":
          case "ShiftRight":
            k[2] = 0;
            break;
        }
      })
    );

    // set up on model load
    this.el.addEventListener("model-loaded", (e) => {
      const mesh = this.el.getObject3D("mesh") || e.detail.model;
      if (!mesh) return;
      mesh.traverse((o) => {
        if (o.isMesh) {
          o.castShadow = true;
          o.receiveShadow = true;
        }
      });
      const clips = mesh.animations || [];
      if (clips.length < 4)
        console.warn(
          "Soldier clips expected; got:",
          clips.map((c) => c.name)
        );

      this.mixer = new T.AnimationMixer(mesh);
      const get = (i) => clips[i] || null;

      const idle = get(this.data.idleIdx),
        run = get(this.data.runIdx),
        walk = get(this.data.walkIdx);
      if (!idle || !walk || !run) {
        console.warn(
          "Missing clips; got:",
          clips.map((c) => c.name)
        );
        return;
      }

      this.actions.Idle = this.mixer.clipAction(animations[idle]);
      this.actions.Walk = this.mixer.clipAction(animations[walk]);
      this.actions.Run = this.mixer.clipAction(animations[run]);

      for (const k of Object.keys(this.actions)) {
        const a = this.actions[k];
        a.enabled = true;
        a.setEffectiveTimeScale(1);
        a.play();
        a.setEffectiveWeight(k === "Idle" ? 1 : 0);
      }
    });
  },

  switchTo(name) {
    if (this.current === name || !this.mixer) return;
    const fade = this.data.fade,
      next = this.actions[name],
      prev = this.actions[this.current];
    if (!next || !prev) return;

    // stride sync for Walk<->Run
    if (name !== "Idle" && this.current !== "Idle") {
      const r = next.getClip().duration / prev.getClip().duration;
      next.time = prev.time * r;
    } else {
      next.time = 0;
    }

    next.setEffectiveWeight(1);
    next.play();
    prev.crossFadeTo(next, fade, true); // warping on
    this.current = name;
  },

  tick() {
    if (!this.mixer) return;
    const dt = this.clock.getDelta();

    // state
    const active = this.key[0] !== 0 || this.key[1] !== 0;
    const running = !!this.key[2];
    const want = active ? (running ? "Run" : "Walk") : "Idle";
    if (want !== this.current) this.switchTo(want);

    // move + face
    if (this.current !== "Idle") {
      const sp = this.current === "Run" ? this.data.runSpeed : this.data.walkSpeed;
      this.move.set(this.key[1], 0, this.key[0]).multiplyScalar(sp * dt); // forward = -Z
      const angle = Math.atan2(this.move.x, this.move.z) + this.yawOffset;
      this.targetQuat.setFromAxisAngle(this.up, angle);
      this.el.object3D.quaternion.slerp(this.targetQuat, 0.08);

      // translate in world space using yaw offset only (static camera)
      this.move.applyAxisAngle(this.up, this.yawOffset);
      this.pos.add(this.move);

      // optional clamp to keep in frame
      const r = this.data.boundsRadius;
      if (r > 0) {
        const d2 = this.pos.x * this.pos.x + this.pos.z * this.pos.z;
        const r2 = r * r;
        if (d2 > r2) {
          const s = r / Math.sqrt(d2);
          this.pos.x *= s;
          this.pos.z *= s;
        }
      }

      this.el.object3D.position.copy(this.pos);
    }

    this.mixer.update(dt);
  },

  remove() {
    window.removeEventListener("keydown", this.onDown);
    window.removeEventListener("keyup", this.onUp);
    if (this.mixer) this.mixer.stopAllAction();
  },
});
