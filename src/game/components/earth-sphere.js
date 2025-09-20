AFRAME.registerComponent("earth-sphere", {
  schema: {
    enabled: { type: "boolean", default: true },
    radius: { type: "number", default: 15 },
    distance: { type: "number", default: 200 },
    haloIntensity: { type: "number", default: 2.0 },
    haloSize: { type: "number", default: 1.5 },
    rotationSpeed: { type: "number", default: 0.001 },
  },

  init() {
    if (!this.data.enabled) return;
    this.createEarth();
  },

  createEarth() {
    // Create Earth sphere
    const earthGeometry = new THREE.SphereGeometry(this.data.radius, 32, 32);

    // Create Earth material with blue color and some texture-like variation
    const earthMaterial = new THREE.MeshPhongMaterial({
      color: new THREE.Color(0x4a90e2),
      shininess: 100,
      transparent: true,
      opacity: 0.9,
    });

    this.earth = new THREE.Mesh(earthGeometry, earthMaterial);

    // Position Earth in the distance
    this.earth.position.set(this.data.distance, 0, -this.data.distance * 0.5);

    this.el.object3D.add(this.earth);

    // Create halo effect
    this.createHalo();
  },

  createHalo() {
    // Create a larger sphere for the halo effect
    const haloGeometry = new THREE.SphereGeometry(this.data.radius * this.data.haloSize, 32, 32);

    const haloMaterial = new THREE.MeshBasicMaterial({
      color: new THREE.Color(0x4a90e2),
      transparent: true,
      opacity: 0.1,
      side: THREE.BackSide, // Render inside of sphere
    });

    this.halo = new THREE.Mesh(haloGeometry, haloMaterial);
    this.halo.position.copy(this.earth.position);

    this.el.object3D.add(this.halo);

    // Create additional glow effect with a point light
    const glowLight = new THREE.PointLight(new THREE.Color(0x4a90e2), this.data.haloIntensity, this.data.distance * 2);
    glowLight.position.copy(this.earth.position);
    this.el.object3D.add(glowLight);

    // Create atmospheric glow ring
    const ringGeometry = new THREE.RingGeometry(this.data.radius * 1.2, this.data.radius * 1.8, 32);

    const ringMaterial = new THREE.MeshBasicMaterial({
      color: new THREE.Color(0x4a90e2),
      transparent: true,
      opacity: 0.15,
      side: THREE.DoubleSide,
    });

    this.atmosphere = new THREE.Mesh(ringGeometry, ringMaterial);
    this.atmosphere.position.copy(this.earth.position);
    this.atmosphere.lookAt(0, 0, 0); // Face the camera
    this.atmosphere.rotation.z = Math.PI / 4; // Slight rotation for effect

    this.el.object3D.add(this.atmosphere);
  },

  tick() {
    if (!this.data.enabled || !this.earth) return;

    // Rotate Earth slowly
    this.earth.rotation.y += this.data.rotationSpeed;

    // Rotate halo and atmosphere
    if (this.halo) {
      this.halo.rotation.y += this.data.rotationSpeed * 0.5;
    }

    if (this.atmosphere) {
      this.atmosphere.rotation.z += this.data.rotationSpeed * 0.3;
    }
  },

  remove() {
    if (this.earth) {
      this.el.object3D.remove(this.earth);
    }
    if (this.halo) {
      this.el.object3D.remove(this.halo);
    }
    if (this.atmosphere) {
      this.el.object3D.remove(this.atmosphere);
    }
  },
});
