AFRAME.registerComponent("space-environment", {
  schema: {
    enabled: { type: "boolean", default: true },
    starCount: { type: "number", default: 1000 },
    asteroidCount: { type: "number", default: 8 },
    asteroidSpeed: { type: "number", default: 0.3 },
    backgroundColor: { type: "color", default: "#000011" },
  },

  init() {
    this.stars = null;
    this.asteroids = [];
    if (this.data.enabled) {
      this.createSpaceEnvironment();
    }
  },

  createSpaceEnvironment() {
    this.el.sceneEl.setAttribute("background", `color: ${this.data.backgroundColor}`);
    this.createStars();
    this.createAsteroids();
  },

  createStars() {
    const starGeometry = new THREE.BufferGeometry();
    const starPositions = new Float32Array(this.data.starCount * 3);
    const starColors = new Float32Array(this.data.starCount * 3);

    for (let i = 0; i < this.data.starCount; i++) {
      const i3 = i * 3;
      const radius = 100 + Math.random() * 200;
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);

      starPositions[i3] = radius * Math.sin(phi) * Math.cos(theta);
      starPositions[i3 + 1] = radius * Math.sin(phi) * Math.sin(theta);
      starPositions[i3 + 2] = radius * Math.cos(phi);

      const intensity = 0.5 + Math.random() * 0.5;
      starColors[i3] = intensity;
      starColors[i3 + 1] = intensity;
      starColors[i3 + 2] = intensity + Math.random() * 0.3;
    }

    starGeometry.setAttribute("position", new THREE.BufferAttribute(starPositions, 3));
    starGeometry.setAttribute("color", new THREE.BufferAttribute(starColors, 3));

    const starMaterial = new THREE.PointsMaterial({
      size: 1.5,
      vertexColors: true,
      transparent: true,
      opacity: 0.8,
    });

    this.stars = new THREE.Points(starGeometry, starMaterial);
    this.el.object3D.add(this.stars);
  },

  createAsteroids() {
    for (let i = 0; i < this.data.asteroidCount; i++) {
      const asteroid = this.createAsteroid();
      this.asteroids.push(asteroid);
      this.el.object3D.add(asteroid);
    }
  },

  createAsteroid() {
    const geometry = new THREE.DodecahedronGeometry(1.5, 0);
    const vertices = geometry.attributes.position.array;

    for (let i = 0; i < vertices.length; i += 3) {
      const noise = 0.3 + Math.random() * 0.4;
      vertices[i] *= noise;
      vertices[i + 1] *= noise;
      vertices[i + 2] *= noise;
    }

    geometry.attributes.position.needsUpdate = true;
    geometry.computeVertexNormals();

    const material = new THREE.MeshLambertMaterial({
      color: new THREE.Color().setHSL(0.1, 0.1, 0.2 + Math.random() * 0.3),
      transparent: true,
      opacity: 0.8,
    });

    const asteroid = new THREE.Mesh(geometry, material);

    const radius = 30 + Math.random() * 50;
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(2 * Math.random() - 1);

    asteroid.position.set(radius * Math.sin(phi) * Math.cos(theta), radius * Math.sin(phi) * Math.sin(theta), radius * Math.cos(phi));

    asteroid.rotation.set(Math.random() * Math.PI * 2, Math.random() * Math.PI * 2, Math.random() * Math.PI * 2);

    asteroid.userData = {
      speed: 0.05 + Math.random() * this.data.asteroidSpeed,
      direction: new THREE.Vector3((Math.random() - 0.5) * 2, (Math.random() - 0.5) * 2, (Math.random() - 0.5) * 2).normalize(),
      rotationSpeed: new THREE.Vector3((Math.random() - 0.5) * 0.01, (Math.random() - 0.5) * 0.01, (Math.random() - 0.5) * 0.01),
    };

    return asteroid;
  },

  tick() {
    if (!this.data.enabled) return;

    if (this.stars) {
      this.stars.rotation.y += 0.0005;
    }

    this.asteroids.forEach((asteroid) => {
      const userData = asteroid.userData;
      asteroid.position.add(userData.direction.clone().multiplyScalar(userData.speed));
      asteroid.rotation.x += userData.rotationSpeed.x;
      asteroid.rotation.y += userData.rotationSpeed.y;
      asteroid.rotation.z += userData.rotationSpeed.z;

      if (asteroid.position.length() > 150) {
        const radius = 30 + Math.random() * 50;
        const theta = Math.random() * Math.PI * 2;
        const phi = Math.acos(2 * Math.random() - 1);
        asteroid.position.set(radius * Math.sin(phi) * Math.cos(theta), radius * Math.sin(phi) * Math.sin(theta), radius * Math.cos(phi));
      }
    });
  },
});
