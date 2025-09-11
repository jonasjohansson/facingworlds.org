// remote-avatar.js (patched)
AFRAME.registerComponent("remote-avatar", {
  schema: {
    idleIdx: { type: "int", default: 0 },
    walkIdx: { type: "int", default: 3 },
    runIdx: { type: "int", default: 1 },
    fadeLerp: { type: "number", default: 0.2 },
  },
  init() {
    const T = (this.THREE = AFRAME.THREE);
    this.clock = new T.Clock();
    this.mixer = null;

    // create these here, but we'll also guard in setNetPose
    this.targetPos = new T.Vector3();
    this.prevPos = new T.Vector3();
    this.speed = 0;

    this.actions = { Idle: null, Walk: null, Run: null };
    this.weights = { Idle: 1, Walk: 0, Run: 0 };
    this.target = { Idle: 1, Walk: 0, Run: 0 };

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
      const get = (i) => clips[i] || null;
      const idle = get(this.data.idleIdx),
        walk = get(this.data.walkIdx),
        run = get(this.data.runIdx);
      if (!idle || !walk || !run) return;

      this.mixer = new this.THREE.AnimationMixer(mesh);
      const prep = (a, w) => {
        a.enabled = true;
        a.setEffectiveTimeScale(1);
        a.setEffectiveWeight(w);
        a.play();
        return a;
      };
      this.actions.Idle = prep(this.mixer.clipAction(idle), 1);
      this.actions.Walk = prep(this.mixer.clipAction(walk), 0);
      this.actions.Run = prep(this.mixer.clipAction(run), 0);
    });
  },

  // <-- make this safe even if init/model not fully ready yet
  setNetPose(p) {
    const T = AFRAME.THREE;
    if (!this.targetPos) this.targetPos = new T.Vector3();
    if (!this.prevPos) this.prevPos = new T.Vector3();

    this.targetPos.set(p.x || 0, p.y || 0, p.z || 0);

    // snap yaw immediately; position will lerp in tick
    if (this.el && this.el.object3D) {
      this.el.object3D.rotation.set(0, p.ry || 0, 0);
    }
  },

  tick() {
    if (!this.mixer) return;
    const dt = this.clock.getDelta();

    // lerp toward target
    this.el.object3D.position.lerp(this.targetPos, 0.2);

    // estimate speed
    const dx = this.el.object3D.position.x - this.prevPos.x;
    const dz = this.el.object3D.position.z - this.prevPos.z;
    const inst = dt > 0 ? Math.sqrt(dx * dx + dz * dz) / dt : 0;
    this.speed += (inst - this.speed) * 0.35;
    this.prevPos.copy(this.el.object3D.position);

    // simple idle/walk blend
    const moving = this.speed > 0.15;
    this.target.Idle = moving ? 0 : 1;
    this.target.Walk = moving ? 1 : 0;
    this.target.Run = 0;

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

    this.mixer.update(dt);
  },
});
