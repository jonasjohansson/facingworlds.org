// frame-map.js — place a camera to see the whole map, once.
AFRAME.registerComponent("frame-map", {
  schema: {
    target: { type: "selector", default: "#world" }, // what to frame (#world or #navmesh)
    pad: { default: 1.2 }, // expand the view a bit
    topDown: { default: true }, // true = straight-down; false = tilted
    tiltDeg: { default: 55 }, // only used if topDown = false
  },
  async init() {
    const target = this.data.target;
    if (!target) return;

    // wait for model
    const ensureMesh = (el) =>
      new Promise((res) => {
        const m = el.getObject3D("mesh");
        if (m) return res(m);
        el.addEventListener("model-loaded", () => res(el.getObject3D("mesh")), { once: true });
      });
    const mesh = await ensureMesh(target);

    // compute bounds
    const box = new THREE.Box3().setFromObject(mesh);
    const size = new THREE.Vector3();
    box.getSize(size);
    const center = new THREE.Vector3();
    box.getCenter(center);

    const radius = Math.max(size.x, size.z) * 0.5 * this.data.pad;

    const camObj = this.el.object3D;
    if (this.data.topDown) {
      // straight down from above; tiny Z to avoid lookAt singularity
      camObj.position.set(center.x, center.y + radius * 2.0, center.z + 0.01);
    } else {
      // tilted isometric-style view
      const tilt = THREE.MathUtils.degToRad(this.data.tiltDeg);
      const y = Math.sin(tilt) * radius * 2.0;
      const z = Math.cos(tilt) * radius * 2.0;
      camObj.position.set(center.x, center.y + y, center.z + z);
    }
    camObj.lookAt(center);
    // sensible clipping planes for big scenes
    this.el.setAttribute("camera", { near: 0.5, far: 5000 });
    console.log("[frame-map] placed camera. size=", size.toArray(), "center=", center.toArray());
  },
});
