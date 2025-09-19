// animated-curtain.js — Creates an animated curtain effect
AFRAME.registerComponent("animated-curtain", {
  schema: {
    width: { type: "number", default: 12 },
    height: { type: "number", default: 8 },
    segments: { type: "number", default: 30 },
    windStrength: { type: "number", default: 1.0 },
    windSpeed: { type: "number", default: 1.0 },
    color: { type: "color", default: "#8B4513" },
    position: { type: "vec3", default: { x: 0, y: 1.5, z: -5 } },
    rotation: { type: "vec3", default: { x: 0, y: 0, z: 0 } },
    texture: { type: "string", default: "fabric" },
    opacity: { type: "number", default: 0.8 },
    roughness: { type: "number", default: 0.8 },
    metallic: { type: "number", default: 0.1 },
    emissiveIntensity: { type: "number", default: 0.0 },
  },

  init() {
    this.geometry = null;
    this.material = null;
    this.mesh = null;
    this.time = 0;
    this.vertices = [];

    this.createCurtain();
  },

  createCurtain() {
    // Create curtain geometry
    this.geometry = new THREE.PlaneGeometry(this.data.width, this.data.height, this.data.segments, this.data.segments);

    // Create texture based on type
    const texture = this.createTexture();

    // Create material with texture
    this.material = new THREE.MeshStandardMaterial({
      map: texture,
      color: this.data.color,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: this.data.opacity,
      roughness: this.data.roughness,
      metalness: this.data.metallic,
      emissiveIntensity: this.data.emissiveIntensity,
    });

    // Create mesh
    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.position.set(this.data.position.x, this.data.position.y, this.data.position.z);
    this.mesh.rotation.set(
      THREE.MathUtils.degToRad(this.data.rotation.x),
      THREE.MathUtils.degToRad(this.data.rotation.y),
      THREE.MathUtils.degToRad(this.data.rotation.z)
    );

    // Store original vertices for animation
    this.vertices = this.geometry.attributes.position.array;

    // Add to scene
    this.el.object3D.add(this.mesh);

    console.log("[animated-curtain] Curtain created");
  },

  createTexture() {
    const canvas = document.createElement("canvas");
    const size = 512;
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d");

    // Create fabric-like texture
    if (this.data.texture === "fabric") {
      this.createFabricTexture(ctx, size);
    } else if (this.data.texture === "silk") {
      this.createSilkTexture(ctx, size);
    } else if (this.data.texture === "velvet") {
      this.createVelvetTexture(ctx, size);
    } else {
      this.createFabricTexture(ctx, size);
    }

    const texture = new THREE.CanvasTexture(canvas);
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.repeat.set(4, 4); // Repeat pattern
    texture.needsUpdate = true;

    return texture;
  },

  createFabricTexture(ctx, size) {
    // Base color
    ctx.fillStyle = this.data.color;
    ctx.fillRect(0, 0, size, size);

    // Add fabric weave pattern
    ctx.strokeStyle = "rgba(0,0,0,0.1)";
    ctx.lineWidth = 1;

    for (let i = 0; i < size; i += 8) {
      ctx.beginPath();
      ctx.moveTo(i, 0);
      ctx.lineTo(i, size);
      ctx.stroke();
    }

    for (let i = 0; i < size; i += 8) {
      ctx.beginPath();
      ctx.moveTo(0, i);
      ctx.lineTo(size, i);
      ctx.stroke();
    }

    // Add some noise for texture
    const imageData = ctx.getImageData(0, 0, size, size);
    const data = imageData.data;

    for (let i = 0; i < data.length; i += 4) {
      const noise = (Math.random() - 0.5) * 20;
      data[i] = Math.max(0, Math.min(255, data[i] + noise)); // R
      data[i + 1] = Math.max(0, Math.min(255, data[i + 1] + noise)); // G
      data[i + 2] = Math.max(0, Math.min(255, data[i + 2] + noise)); // B
    }

    ctx.putImageData(imageData, 0, 0);
  },

  createSilkTexture(ctx, size) {
    // Silk-like smooth texture
    const gradient = ctx.createLinearGradient(0, 0, size, size);
    gradient.addColorStop(0, this.data.color);
    gradient.addColorStop(0.5, this.lightenColor(this.data.color, 0.2));
    gradient.addColorStop(1, this.data.color);

    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, size, size);

    // Add subtle shine lines
    ctx.strokeStyle = "rgba(255,255,255,0.1)";
    ctx.lineWidth = 2;

    for (let i = 0; i < 5; i++) {
      ctx.beginPath();
      ctx.moveTo(0, (i * size) / 5);
      ctx.lineTo(size, (i * size) / 5);
      ctx.stroke();
    }
  },

  createVelvetTexture(ctx, size) {
    // Velvet-like rich texture
    ctx.fillStyle = this.data.color;
    ctx.fillRect(0, 0, size, size);

    // Add velvet pile effect
    ctx.fillStyle = "rgba(0,0,0,0.3)";
    for (let i = 0; i < size * 2; i++) {
      const x = Math.random() * size;
      const y = Math.random() * size;
      const radius = Math.random() * 2;
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.fill();
    }
  },

  lightenColor(color, factor) {
    const hex = color.replace("#", "");
    const r = parseInt(hex.substr(0, 2), 16);
    const g = parseInt(hex.substr(2, 2), 16);
    const b = parseInt(hex.substr(4, 2), 16);

    const newR = Math.min(255, Math.floor(r + (255 - r) * factor));
    const newG = Math.min(255, Math.floor(g + (255 - g) * factor));
    const newB = Math.min(255, Math.floor(b + (255 - b) * factor));

    return `#${newR.toString(16).padStart(2, "0")}${newG.toString(16).padStart(2, "0")}${newB.toString(16).padStart(2, "0")}`;
  },

  tick() {
    if (!this.mesh || !this.vertices) return;

    this.time += 0.016 * this.data.windSpeed;

    // Animate vertices to create wind effect
    const positions = this.geometry.attributes.position.array;
    const segments = this.data.segments + 1;

    for (let i = 0; i < segments; i++) {
      for (let j = 0; j < segments; j++) {
        const index = (i * segments + j) * 3;

        // Calculate wind effect based on position and time
        const x = (j / segments) * this.data.width - this.data.width / 2;
        const y = (i / segments) * this.data.height - this.data.height / 2;

        // Wind effect - stronger at the bottom, weaker at the top
        const windFactor = (1 - i / segments) * this.data.windStrength;
        const windX = Math.sin(this.time + x * 0.5) * windFactor * 0.3;
        const windY = Math.cos(this.time * 0.7 + y * 0.3) * windFactor * 0.1;

        // Apply wind to Z position (depth)
        positions[index + 2] = windX + windY;
      }
    }

    this.geometry.attributes.position.needsUpdate = true;
  },

  update() {
    // Update material properties when schema changes
    if (this.material) {
      this.material.roughness = this.data.roughness;
      this.material.metalness = this.data.metallic;
      this.material.emissiveIntensity = this.data.emissiveIntensity;
      this.material.opacity = this.data.opacity;
      this.material.color.set(this.data.color);

      // Update texture if changed
      if (this.data.texture !== this.lastTexture) {
        const texture = this.createTexture();
        this.material.map = texture;
        this.lastTexture = this.data.texture;
      }
    }
  },

  remove() {
    if (this.mesh) {
      this.el.object3D.remove(this.mesh);
    }
    if (this.geometry) {
      this.geometry.dispose();
    }
    if (this.material) {
      this.material.dispose();
    }
  },
});
