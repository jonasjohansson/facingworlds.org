// animated-materials.js — Adds animated material effects to the map
AFRAME.registerComponent("animated-materials", {
  schema: {
    enableGlow: { type: "boolean", default: true },
    enablePulse: { type: "boolean", default: true },
    enableColorShift: { type: "boolean", default: true },
    speed: { type: "number", default: 1.0 },
    roughness: { type: "number", default: 0.8 },
    metallic: { type: "number", default: 0.0 },
    emissiveIntensity: { type: "number", default: 0.0 },
  },

  init() {
    this.materials = [];
    this.time = 0;

    // Wait for model to load
    this.el.addEventListener("model-loaded", () => {
      this.setupAnimatedMaterials();
    });
  },

  setupAnimatedMaterials() {
    const model = this.el.getObject3D("mesh");
    if (!model) return;

    // Find all materials in the model
    model.traverse((child) => {
      if (child.isMesh && child.material) {
        // Clone material to avoid affecting other instances
        const material = child.material.clone();

        // Ensure it's a PBR material for best results
        if (!material.isMeshStandardMaterial && !material.isMeshPhysicalMaterial) {
          // Convert to StandardMaterial if it's not already PBR
          const newMaterial = new THREE.MeshStandardMaterial({
            color: material.color || 0xffffff,
            map: material.map,
            normalMap: material.normalMap,
            roughnessMap: material.roughnessMap,
            metalnessMap: material.metalnessMap,
            emissiveMap: material.emissiveMap,
            transparent: material.transparent,
            opacity: material.opacity,
            side: material.side,
          });

          // Copy over any existing properties
          if (material.roughness !== undefined) newMaterial.roughness = material.roughness;
          if (material.metalness !== undefined) newMaterial.metalness = material.metalness;
          if (material.emissive) newMaterial.emissive.copy(material.emissive);
          if (material.emissiveIntensity !== undefined) newMaterial.emissiveIntensity = material.emissiveIntensity;

          child.material = newMaterial;
        }

        // Apply material properties
        material.roughness = this.data.roughness;
        material.metallic = this.data.metallic;
        material.emissiveIntensity = this.data.emissiveIntensity;

        // Add animated properties
        if (this.data.enableGlow) {
          material.emissive = new THREE.Color(0x000000);
          material.emissiveIntensity = 0;
        }

        if (this.data.enablePulse) {
          material.opacity = 1.0;
          material.transparent = true;
        }

        if (this.data.enableColorShift) {
          material.color = new THREE.Color(0xffffff);
        }

        child.material = material;
        this.materials.push({
          material: material,
          originalEmissive: material.emissive.clone(),
          originalColor: material.color.clone(),
          originalOpacity: material.opacity,
        });
      }
    });

    console.log(`[animated-materials] Set up ${this.materials.length} animated materials`);

    // Debug: log material properties
    this.materials.forEach((matData, index) => {
      console.log(`[animated-materials] Material ${index}:`, {
        type: matData.material.type,
        roughness: matData.material.roughness,
        metallic: matData.material.metallic,
        emissiveIntensity: matData.material.emissiveIntensity,
      });
    });
  },

  tick() {
    if (this.materials.length === 0) return;

    this.time += 0.016 * this.data.speed; // ~60fps

    this.materials.forEach((matData) => {
      const { material, originalEmissive, originalColor, originalOpacity } = matData;

      // Update static material properties
      material.roughness = this.data.roughness;
      material.metallic = this.data.metallic;
      material.emissiveIntensity = this.data.emissiveIntensity;

      if (this.data.enableGlow) {
        // Pulsing glow effect
        const glowIntensity = (Math.sin(this.time * 2) + 1) * 0.1;
        material.emissiveIntensity = this.data.emissiveIntensity + glowIntensity;
        material.emissive.setRGB(
          originalEmissive.r + glowIntensity * 0.2,
          originalEmissive.g + glowIntensity * 0.3,
          originalEmissive.b + glowIntensity * 0.1
        );
      }

      if (this.data.enablePulse) {
        // Subtle opacity pulse
        const pulse = (Math.sin(this.time * 1.5) + 1) * 0.05;
        material.opacity = originalOpacity + pulse;
      }

      if (this.data.enableColorShift) {
        // Color shifting effect
        const hue = (this.time * 0.1) % 1;
        const color = new THREE.Color().setHSL(hue, 0.3, 0.8);
        material.color.lerp(color, 0.1);
      }
    });
  },

  update() {
    // Update material properties when schema changes
    if (this.materials.length > 0) {
      this.materials.forEach((matData) => {
        const { material } = matData;
        material.roughness = this.data.roughness;
        material.metallic = this.data.metallic;
        material.emissiveIntensity = this.data.emissiveIntensity;
      });
    }
  },
});
