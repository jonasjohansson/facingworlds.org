// advanced-material-animation.js — Advanced material animation with opacity, metallic, roughness changes
AFRAME.registerComponent("advanced-material-animation", {
  schema: {
    enabled: { type: "boolean", default: true },
    animationType: { type: "string", default: "opacity" }, // opacity, metallic, roughness, emissive, color
    speed: { type: "number", default: 1.0 },
    intensity: { type: "number", default: 1.0 },
    minValue: { type: "number", default: 0.0 },
    maxValue: { type: "number", default: 1.0 },
    colorShift: { type: "boolean", default: false },
    emissiveGlow: { type: "boolean", default: false },
  },

  init() {
    this.materials = [];
    this.time = 0;
    this.originalProperties = new Map();

    // Wait for model to load
    this.el.addEventListener("model-loaded", () => {
      this.setupAdvancedMaterials();
    });
  },

  setupAdvancedMaterials() {
    const model = this.el.getObject3D("mesh");
    if (!model) return;

    // Find all materials in the model
    model.traverse((child) => {
      if (child.isMesh && child.material) {
        // Clone material to avoid affecting other instances
        const material = child.material.clone();

        // Ensure it's a PBR material for best results
        if (!material.isMeshStandardMaterial && !material.isMeshPhysicalMaterial) {
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
          if (material.metallic !== undefined) newMaterial.metallic = material.metallic;
          if (material.emissive) newMaterial.emissive.copy(material.emissive);
          if (material.emissiveIntensity !== undefined) newMaterial.emissiveIntensity = material.emissiveIntensity;

          child.material = newMaterial;
        }

        // Store original properties
        this.originalProperties.set(material, {
          opacity: material.opacity,
          metallic: material.metallic,
          roughness: material.roughness,
          emissiveIntensity: material.emissiveIntensity,
          color: material.color.clone(),
          emissive: material.emissive.clone(),
        });

        child.material = material;
        this.materials.push(material);
      }
    });

    console.log(`[advanced-material-animation] Set up ${this.materials.length} materials for ${this.data.animationType} animation`);
  },

  tick() {
    if (!this.data.enabled || this.materials.length === 0) return;

    this.time += 0.016 * this.data.speed;

    this.materials.forEach((material) => {
      const original = this.originalProperties.get(material);
      if (!original) return;

      // Calculate animation value based on type
      let animatedValue = this.calculateAnimatedValue(original);

      switch (this.data.animationType) {
        case "opacity":
          material.opacity = animatedValue;
          material.transparent = animatedValue < 1.0;
          break;

        case "metallic":
          material.metallic = animatedValue;
          break;

        case "roughness":
          material.roughness = animatedValue;
          break;

        case "emissive":
          material.emissiveIntensity = animatedValue;
          break;

        case "color":
          if (this.data.colorShift) {
            const hue = (this.time * 0.1) % 1;
            const color = new THREE.Color().setHSL(hue, 0.8, 0.6);
            material.color.lerp(color, 0.1);
          }
          break;
      }

      // Add emissive glow effect
      if (this.data.emissiveGlow) {
        const glowIntensity = (Math.sin(this.time * 2) + 1) * 0.5 * this.data.intensity;
        material.emissiveIntensity = glowIntensity;
        material.emissive.setRGB(glowIntensity * 0.3, glowIntensity * 0.2, glowIntensity * 0.1);
      }
    });
  },

  calculateAnimatedValue(original) {
    const range = this.data.maxValue - this.data.minValue;
    const baseValue = original[this.data.animationType] || this.data.minValue;

    // Different animation patterns
    const patterns = {
      sine: Math.sin(this.time * 2) * 0.5 + 0.5,
      cosine: Math.cos(this.time * 1.5) * 0.5 + 0.5,
      triangle: Math.abs(((this.time * 2) % 2) - 1),
      square: Math.sin(this.time * 3) > 0 ? 1 : 0,
      sawtooth: (this.time * 1.5) % 1,
    };

    const pattern = patterns.sine; // Default to sine wave
    const animatedValue = this.data.minValue + range * pattern * this.data.intensity;

    return Math.max(this.data.minValue, Math.min(this.data.maxValue, animatedValue));
  },

  update() {
    // Update when schema changes
    if (this.materials.length > 0) {
      this.materials.forEach((material) => {
        const original = this.originalProperties.get(material);
        if (original) {
          // Reset to original values
          material.opacity = original.opacity;
          material.metallic = original.metallic;
          material.roughness = original.roughness;
          material.emissiveIntensity = original.emissiveIntensity;
          material.color.copy(original.color);
          material.emissive.copy(original.emissive);
        }
      });
    }
  },
});
