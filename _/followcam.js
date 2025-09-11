// followcam.js
AFRAME.registerComponent("follow-lookat", {
  schema: {
    target: { type: "selector" }, // e.g. #rig
    offset: { type: "vec3", default: { x: 0, y: 18, z: 12 } }, // camera offset relative to target
    lerp: { default: 0.2 },
    mode: { default: "followForward" }, // 'lookAt' | 'followForward'
    lookAhead: { default: 10 }, // how far ahead to look in followForward mode
    rotateOffsetWithRig: { default: true }, // keep offset behind/around the rig as it turns
  },
  async init() {
    this.tmpPos = new THREE.Vector3();
    this.tmpDir = new THREE.Vector3(0, 0, -1);
    this.offsetV = new THREE.Vector3();
    this.goalPos = new THREE.Vector3();
    this.yAxis = new THREE.Vector3(0, 1, 0);

    await new Promise((res) => {
      if (this.el.sceneEl.hasLoaded) res();
      else this.el.sceneEl.addEventListener("loaded", res, { once: true });
    });

    // Place once so we don't start inside geometry
    const t = this.data.target;
    if (t && t.object3D) {
      t.object3D.getWorldPosition(this.tmpPos);
      this._computeGoal(t);
      this.el.object3D.position.copy(this.goalPos);
      this._applyLook(t);
    }
  },
  _computeGoal(t) {
    // world yaw from target
    const q = new THREE.Quaternion();
    const e = new THREE.Euler();
    t.object3D.getWorldQuaternion(q);
    e.setFromQuaternion(q, "YXZ"); // we only care about Y

    // offset (optionally rotated by target yaw)
    this.offsetV.set(this.data.offset.x, this.data.offset.y, this.data.offset.z);
    if (this.data.rotateOffsetWithRig) {
      this.offsetV.applyAxisAngle(this.yAxis, e.y);
    }

    // desired camera world position
    t.object3D.getWorldPosition(this.tmpPos);
    this.goalPos.copy(this.tmpPos).add(this.offsetV);
  },
  _applyLook(t) {
    if (this.data.mode === "lookAt") {
      // simply look at the target position
      this.el.object3D.lookAt(this.tmpPos);
      return;
    }
    // followForward: look in the same direction as the target’s forward
    t.object3D.getWorldDirection(this.tmpDir); // points along -Z
    // tmpDir is already forward (in three.js sense). Look some distance ahead:
    const lookPoint = this.tmpPos.clone().addScaledVector(this.tmpDir, this.data.lookAhead);
    this.el.object3D.lookAt(lookPoint);
  },
  tick() {
    const t = this.data.target;
    if (!t) return;

    this._computeGoal(t);
    // smooth move toward goal
    this.el.object3D.position.lerp(this.goalPos, this.data.lerp);
    // face target direction
    this._applyLook(t);
  },
});
