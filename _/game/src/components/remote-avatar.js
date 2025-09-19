// remote-avatar.js (patched)
import { createVector3, createClock } from "../utils/three-helpers.js";
import { setupAnimationMixer, blendAnimations } from "../utils/animation-helpers.js";
AFRAME.registerComponent("remote-avatar", {
  schema: {
    idleIdx: { type: "int", default: 0 },
    walkIdx: { type: "int", default: 3 },
    runIdx: { type: "int", default: 1 },
    fadeLerp: { type: "number", default: 0.2 },
  },
  init() {
    const T = (this.THREE = AFRAME.THREE);
    this.clock = createClock();
    this.mixer = null;

    // create these here, but we'll also guard in setNetPose
    this.targetPos = createVector3();
    this.prevPos = createVector3();
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

      const { mixer, actions } = setupAnimationMixer(mesh, [idle, walk, run]);
      this.mixer = mixer;
      this.actions.Idle = actions[idle.name] || actions.clip_0;
      this.actions.Walk = actions[walk.name] || actions.clip_1;
      this.actions.Run = actions[run.name] || actions.clip_2;
    });
  },

  // <-- make this safe even if init/model not fully ready yet
  setNetPose(p) {
    if (!this.targetPos) this.targetPos = createVector3();
    if (!this.prevPos) this.prevPos = createVector3();

    this.targetPos.set(p.x || 0, p.y || 0, p.z || 0);

    // Set rotation on the parent rig, not the soldier entity
    const rig = this.el.parentNode;
    if (rig && rig.object3D) {
      // Use quaternion for smoother rotation
      const quaternion = new AFRAME.THREE.Quaternion();
      quaternion.setFromAxisAngle(new AFRAME.THREE.Vector3(0, 1, 0), p.ry || 0);
      rig.object3D.quaternion.copy(quaternion);
    }
  },

  tick() {
    if (!this.mixer) return;
    const dt = this.clock.getDelta();

    // Get the rig (parent) position for movement tracking
    const rig = this.el.parentNode;
    if (!rig || !rig.object3D) return;

    // lerp rig toward target position
    rig.object3D.position.lerp(this.targetPos, 0.2);

    // estimate speed based on rig movement
    const dx = rig.object3D.position.x - this.prevPos.x;
    const dz = rig.object3D.position.z - this.prevPos.z;
    const inst = dt > 0 ? Math.sqrt(dx * dx + dz * dz) / dt : 0;
    this.speed += (inst - this.speed) * 0.35;
    this.prevPos.copy(rig.object3D.position);

    // Enhanced animation logic to match local character
    const moving = this.speed > 0.05; // lower threshold like local character
    const running = this.speed > 2.4; // match local character run threshold

    this.target.Idle = moving ? 0 : 1;
    this.target.Walk = moving && !running ? 1 : 0;
    this.target.Run = running ? 1 : 0;

    // Use frame-rate independent blending like local character
    const damp = 1 - Math.exp(-this.data.fadeLerp * dt);
    blendAnimations(this.actions, this.weights, this.target, damp);

    this.mixer.update(dt);
  },
});
