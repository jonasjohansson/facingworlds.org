// space-environment.js — Creates a space environment with stars and moving asteroids
AFRAME.registerComponent("space-environment", {
  schema: {
    enabled: { type: "boolean", default: true },
    starCount: { type: "number", default: 2000 },
    asteroidCount: { type: "number", default: 15 },
    asteroidSpeed: { type: "number", default: 0.5 },
    asteroidSize: { type: "number", default: 2 },
    nebulaEnabled: { type: "boolean", default: true },
    backgroundColor: { type: "color", default: "#000011" },
  },

  init() {
    this.stars = null;
    this.asteroids = [];
    this.nebula = null;

    if (this.data.enabled) {
      this.createSpaceEnvironment();
    }
  },

  createSpaceEnvironment() {
    // Set scene background
    this.el.sceneEl.setAttribute("background", `color: ${this.data.backgroundColor}`);

    // Create stars
    this.createStars();

    // Create asteroids
    this.createAsteroids();

    // Create nebula
    if (this.data.nebulaEnabled) {
      this.createNebula();
    }
  },

  createStars() {
    const starGeometry = new THREE.BufferGeometry();
    const starPositions = new Float32Array(this.data.starCount * 3);
    const starColors = new Float32Array(this.data.starCount * 3);

    for (let i = 0; i < this.data.starCount; i++) {
      const i3 = i * 3;

      // Random positions in a large sphere
      const radius = 200 + Math.random() * 300;
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);

      starPositions[i3] = radius * Math.sin(phi) * Math.cos(theta);
      starPositions[i3 + 1] = radius * Math.sin(phi) * Math.sin(theta);
      starPositions[i3 + 2] = radius * Math.cos(phi);

      // Random star colors (white to blue-white)
      const intensity = 0.5 + Math.random() * 0.5;
      starColors[i3] = intensity;
      starColors[i3 + 1] = intensity;
      starColors[i3 + 2] = intensity + Math.random() * 0.3;
    }

    starGeometry.setAttribute("position", new THREE.BufferAttribute(starPositions, 3));
    starGeometry.setAttribute("color", new THREE.BufferAttribute(starColors, 3));

    const starMaterial = new THREE.PointsMaterial({
      size: 2,
      vertexColors: true,
      transparent: true,
      opacity: 0.8,
    });

    this.stars = new THREE.Points(starGeometry, starMaterial);
    this.el.object3D.add(this.stars);

    console.log(`[space-environment] Created ${this.data.starCount} stars`);
  },

  createAsteroids() {
    for (let i = 0; i < this.data.asteroidCount; i++) {
      const asteroid = this.createAsteroid();
      this.asteroids.push(asteroid);
      this.el.object3D.add(asteroid);
    }

    console.log(`[space-environment] Created ${this.data.asteroidCount} asteroids`);
  },

  createAsteroid() {
    // Create irregular asteroid geometry
    const geometry = new THREE.DodecahedronGeometry(this.data.asteroidSize, 0);
    const vertices = geometry.attributes.position.array;

    // Randomize vertices for irregular shape
    for (let i = 0; i < vertices.length; i += 3) {
      const noise = 0.3 + Math.random() * 0.4;
      vertices[i] *= noise;
      vertices[i + 1] *= noise;
      vertices[i + 2] *= noise;
    }

    geometry.attributes.position.needsUpdate = true;
    geometry.computeVertexNormals();

    // Create material
    const material = new THREE.MeshLambertMaterial({
      color: new THREE.Color().setHSL(0.1, 0.1, 0.2 + Math.random() * 0.3),
      transparent: true,
      opacity: 0.8,
    });

    const asteroid = new THREE.Mesh(geometry, material);

    // Random position
    const radius = 50 + Math.random() * 100;
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(2 * Math.random() - 1);

    asteroid.position.set(radius * Math.sin(phi) * Math.cos(theta), radius * Math.sin(phi) * Math.sin(theta), radius * Math.cos(phi));

    // Random rotation
    asteroid.rotation.set(Math.random() * Math.PI * 2, Math.random() * Math.PI * 2, Math.random() * Math.PI * 2);

    // Store movement data
    asteroid.userData = {
      speed: 0.1 + Math.random() * this.data.asteroidSpeed,
      direction: new THREE.Vector3((Math.random() - 0.5) * 2, (Math.random() - 0.5) * 2, (Math.random() - 0.5) * 2).normalize(),
      rotationSpeed: new THREE.Vector3((Math.random() - 0.5) * 0.02, (Math.random() - 0.5) * 0.02, (Math.random() - 0.5) * 0.02),
    };

    return asteroid;
  },

  createNebula() {
    // Create a simple nebula effect using a large sphere with gradient material
    const nebulaGeometry = new THREE.SphereGeometry(500, 32, 32);

    // Create gradient material
    const canvas = document.createElement("canvas");
    canvas.width = 256;
    canvas.height = 256;
    const ctx = canvas.getContext("2d");

    // Create radial gradient
    const gradient = ctx.createRadialGradient(128, 128, 0, 128, 128, 128);
    gradient.addColorStop(0, "rgba(100, 50, 200, 0.1)");
    gradient.addColorStop(0.5, "rgba(50, 100, 200, 0.05)");
    gradient.addColorStop(1, "rgba(0, 0, 50, 0.02)");

    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, 256, 256);

    const texture = new THREE.CanvasTexture(canvas);
    const nebulaMaterial = new THREE.MeshBasicMaterial({
      map: texture,
      transparent: true,
      opacity: 0.3,
      side: THREE.BackSide,
    });

    this.nebula = new THREE.Mesh(nebulaGeometry, nebulaMaterial);
    this.el.object3D.add(this.nebula);

    console.log("[space-environment] Created nebula");
  },

  tick() {
    if (!this.data.enabled) return;

    // Rotate stars slowly
    if (this.stars) {
      this.stars.rotation.y += 0.0005;
    }

    // Move and rotate asteroids
    this.asteroids.forEach((asteroid) => {
      const userData = asteroid.userData;

      // Move asteroid
      asteroid.position.add(userData.direction.clone().multiplyScalar(userData.speed));

      // Rotate asteroid
      asteroid.rotation.x += userData.rotationSpeed.x;
      asteroid.rotation.y += userData.rotationSpeed.y;
      asteroid.rotation.z += userData.rotationSpeed.z;

      // Reset position if too far away
      if (asteroid.position.length() > 300) {
        const radius = 50 + Math.random() * 100;
        const theta = Math.random() * Math.PI * 2;
        const phi = Math.acos(2 * Math.random() - 1);

        asteroid.position.set(radius * Math.sin(phi) * Math.cos(theta), radius * Math.sin(phi) * Math.sin(theta), radius * Math.cos(phi));
      }
    });

    // Rotate nebula
    if (this.nebula) {
      this.nebula.rotation.y += 0.0002;
      this.nebula.rotation.x += 0.0001;
    }
  },

  update() {
    if (this.data.enabled && !this.stars) {
      this.createSpaceEnvironment();
    } else if (!this.data.enabled && this.stars) {
      this.removeSpaceEnvironment();
    }
  },

  removeSpaceEnvironment() {
    if (this.stars) {
      this.el.object3D.remove(this.stars);
      this.stars = null;
    }

    this.asteroids.forEach((asteroid) => {
      this.el.object3D.remove(asteroid);
    });
    this.asteroids = [];

    if (this.nebula) {
      this.el.object3D.remove(this.nebula);
      this.nebula = null;
    }
  },
});
