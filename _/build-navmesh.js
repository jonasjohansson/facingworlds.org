AFRAME.registerComponent("build-navmesh", {
  schema: {
    slopeMax: { default: 35 }, // max walkable slope in degrees (0 = flat only)
    minArea: { default: 0.001 }, // drop tiny sliver triangles (m²)
    debug: { default: true }, // show the generated navmesh wireframe
  },
  init() {
    this.el.addEventListener("model-loaded", () => this._build());
  },
  _build() {
    const root = this.el.getObject3D("mesh");
    if (!root) return;

    const cosMax = Math.cos(THREE.MathUtils.degToRad(this.data.slopeMax));
    const posOut = [];
    const geomTmp = new THREE.BufferGeometry();
    const a = new THREE.Vector3(),
      b = new THREE.Vector3(),
      c = new THREE.Vector3();
    const n = new THREE.Vector3();

    root.traverse((node) => {
      if (!node.isMesh || !node.geometry) return;
      const geom = node.geometry;
      const pos = geom.attributes.position;
      if (!pos) return;

      const index = geom.index ? geom.index.array : null;
      const triCount = index ? index.length / 3 : pos.count / 3;

      for (let i = 0; i < triCount; i++) {
        const ia = index ? index[i * 3 + 0] : i * 3 + 0;
        const ib = index ? index[i * 3 + 1] : i * 3 + 1;
        const ic = index ? index[i * 3 + 2] : i * 3 + 2;

        a.fromBufferAttribute(pos, ia).applyMatrix4(node.matrixWorld);
        b.fromBufferAttribute(pos, ib).applyMatrix4(node.matrixWorld);
        c.fromBufferAttribute(pos, ic).applyMatrix4(node.matrixWorld);

        // face normal (upward = good)
        n.copy(c).sub(a).cross(b.clone().sub(a)).normalize();
        if (n.y <= 0 || n.y < cosMax) continue;

        // cull tiny triangles
        const area = 0.5 * n.length(); // since n is normalized, compute true area instead:
        // Better: recompute non-normalized cross for area
        const cross = c.clone().sub(a).cross(b.clone().sub(a));
        const triArea = 0.5 * cross.length();
        if (triArea < this.data.minArea) continue;

        posOut.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
      }
    });

    if (posOut.length === 0) {
      console.warn("[build-navmesh] No walkable faces found. Increase slopeMax or check transforms.");
      return;
    }

    const outGeom = new THREE.BufferGeometry();
    outGeom.setAttribute("position", new THREE.Float32BufferAttribute(posOut, 3));
    outGeom.computeVertexNormals();

    // Replace children with a single mesh (local space)
    const group = this.el.object3D;
    group.clear();

    const mat = new THREE.MeshBasicMaterial({
      color: 0x00ff88,
      wireframe: true,
      transparent: true,
      opacity: this.data.debug ? 0.35 : 0.0,
    });
    const mesh = new THREE.Mesh(outGeom, mat);
    group.add(mesh);

    // (Re)attach nav-mesh AFTER we’ve built the geometry
    if (this.el.hasAttribute("nav-mesh")) this.el.removeAttribute("nav-mesh");
    this.el.setAttribute("nav-mesh", "");

    console.log(`[build-navmesh] Triangles: ${posOut.length / 9}, slopeMax: ${this.data.slopeMax}°`);
  },
});
