// Three.js Portal - Pure Three.js geometry and shader approach
AFRAME.registerComponent("three-portal", {
  schema: {
    radius: { type: "number", default: 0.5 },
    animated: { type: "boolean", default: false },
    texture: { type: "string", default: "#sky" },
  },

  init: function () {
    console.log("Three.js Portal initialized with radius:", this.data.radius);
    this.setupPortal();
  },

  setupPortal: function () {
    const el = this.el;
    const data = this.data;

    // Wait for the element to be ready
    el.addEventListener("loaded", () => {
      this.createPortalGeometry();
    });

    // If already loaded, set up immediately
    if (el.object3D) {
      this.createPortalGeometry();
    }
  },

  createPortalGeometry: function () {
    const el = this.el;
    const data = this.data;

    // Create circular geometry
    const geometry = new THREE.CircleGeometry(data.radius, 32);

    // Get the texture from A-Frame's asset system
    const textureLoader = new THREE.TextureLoader();
    const texture = textureLoader.load(data.texture);

    // Create a custom shader material for the portal effect
    const material = new THREE.ShaderMaterial({
      uniforms: {
        uTexture: { value: texture },
        uTime: { value: 0.0 },
        uRadius: { value: data.radius },
        uAnimated: { value: data.animated ? 1.0 : 0.0 },
      },
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform sampler2D uTexture;
        uniform float uTime;
        uniform float uRadius;
        uniform float uAnimated;
        varying vec2 vUv;
        
        void main() {
          vec2 center = vec2(0.5, 0.5);
          float dist = distance(vUv, center);
          
          // Create circular mask
          float alpha = 1.0 - smoothstep(uRadius - 0.1, uRadius + 0.1, dist);
          
          // Add animated edge effect
          float edgeGlow = 0.0;
          if (uAnimated > 0.5) {
            edgeGlow = sin(uTime * 2.0 + dist * 10.0) * 0.3 + 0.7;
          }
          
          vec4 textureColor = texture2D(uTexture, vUv);
          vec3 finalColor = textureColor.rgb + vec3(0.0, 0.5, 0.5) * edgeGlow * (1.0 - alpha);
          
          gl_FragColor = vec4(finalColor, alpha);
        }
      `,
      transparent: true,
      side: THREE.DoubleSide,
    });

    // Create mesh
    const mesh = new THREE.Mesh(geometry, material);

    // Replace the existing mesh
    el.setObject3D("mesh", mesh);

    // Store reference for animation
    this.material = material;
    this.mesh = mesh;

    console.log("Three.js Portal geometry created with radius:", data.radius);
  },

  update: function () {
    console.log("Three.js Portal updating with new data:", this.data);

    // Update material uniforms
    if (this.material) {
      this.material.uniforms.uRadius.value = this.data.radius;
      this.material.uniforms.uAnimated.value = this.data.animated ? 1.0 : 0.0;
    }

    // Recreate geometry if radius changed significantly
    this.createPortalGeometry();
  },

  tick: function (time) {
    // Update time uniform for animation
    if (this.material && this.data.animated) {
      this.material.uniforms.uTime.value = time / 1000.0;
    }
  },
});
