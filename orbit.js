// orbit.js — orbit around a target with mouse drag + wheel, only when camera is active
AFRAME.registerComponent("orbit-camera", {
  schema: {
    target: { type: "selector" }, // e.g. #rig
    radius: { default: 10 },
    minRadius: { default: 4 },
    maxRadius: { default: 30 },
    height: { default: 0 }, // extra Y offset
    azimuth: { default: 30 }, // deg around Y
    polar: { default: 65 }, // deg above horizon (top-down if large)
    rotateSpeed: { default: 0.25 }, // deg/px
    zoomSpeed: { default: 1.0 },
    drag: { default: true },
  },
  init() {
    this.az = this.data.azimuth;
    this.pol = this.data.polar;
    this.rad = this.data.radius;
    this.center = new THREE.Vector3();
    this.active = false;
    this.dragging = false;
    this.lastX = 0;
    this.lastY = 0;

    this.onDown = (e) => {
      this.dragging = true;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
    };
    this.onUp = () => {
      this.dragging = false;
    };
    this.onMove = (e) => {
      if (!this.dragging || !this.active) return;
      const dx = e.clientX - this.lastX;
      const dy = e.clientY - this.lastY;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
      this.az -= dx * this.data.rotateSpeed;
      this.pol -= dy * this.data.rotateSpeed;
      this.pol = Math.max(5, Math.min(85, this.pol));
    };
    this.onWheel = (e) => {
      if (!this.active) return;
      e.preventDefault();
      const step = (this.data.maxRadius - this.data.minRadius) / 20;
      this.rad += (e.deltaY > 0 ? step : -step) * this.data.zoomSpeed;
      this.rad = Math.max(this.data.minRadius, Math.min(this.data.maxRadius, this.rad));
    };

    const scene = this.el.sceneEl;
    const setup = () => {
      this.canvas = scene.canvas;
    };
    scene.hasLoaded ? setup() : scene.addEventListener("loaded", setup);
  },
  updateActiveHandlers() {
    if (!this.canvas) return;
    const camActive = (this.el.getAttribute("camera") || {}).active !== false;
    if (camActive === this.active) return;
    this.active = camActive;
    if (this.active) {
      // enable
      this.canvas.addEventListener("mousedown", this.onDown);
      window.addEventListener("mousemove", this.onMove);
      window.addEventListener("mouseup", this.onUp);
      this.canvas.addEventListener("wheel", this.onWheel, { passive: false });
    } else {
      // disable
      this.canvas.removeEventListener("mousedown", this.onDown);
      window.removeEventListener("mousemove", this.onMove);
      window.removeEventListener("mouseup", this.onUp);
      this.canvas.removeEventListener("wheel", this.onWheel);
      this.dragging = false;
    }
  },
  tick() {
    // Manage active/inactive listeners
    this.updateActiveHandlers();

    const t = this.data.target;
    if (!t) return;
    t.object3D.getWorldPosition(this.center);

    const azRad = THREE.MathUtils.degToRad(this.az);
    const polRad = THREE.MathUtils.degToRad(this.pol);
    const horiz = Math.cos(polRad) * this.rad;
    const y = Math.sin(polRad) * this.rad + this.data.height;

    const x = Math.sin(azRad) * horiz;
    const z = Math.cos(azRad) * horiz;

    this.el.object3D.position.set(this.center.x + x, this.center.y + y, this.center.z + z);
    this.el.object3D.lookAt(this.center);
  },
  remove() {
    if (!this.canvas) return;
    this.canvas.removeEventListener("mousedown", this.onDown);
    window.removeEventListener("mousemove", this.onMove);
    window.removeEventListener("mouseup", this.onUp);
    this.canvas.removeEventListener("wheel", this.onWheel);
  },
});
