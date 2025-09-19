// Portal Shader Component - Modern approach to portal effects
AFRAME.registerComponent("portal-shader", {
  schema: {
    portalTexture: { type: "string", default: "#sky" },
    maskTexture: { type: "string", default: "" },
    portalRadius: { type: "number", default: 1.0 },
    portalCenter: { type: "vec2", default: { x: 0, y: 0 } },
    edgeSoftness: { type: "number", default: 0.1 },
  },

  init: function () {
    this.setupPortalShader();
  },

  setupPortalShader: function () {
    const el = this.el;
    const data = this.data;

    // Vertex Shader - positions vertices
    const vertexShader = `
      varying vec2 vUv;
      varying vec3 vPosition;
      varying vec3 vNormal;
      
      void main() {
        vUv = uv;
        vPosition = position;
        vNormal = normal;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `;

    // Fragment Shader - colors each pixel
    const fragmentShader = `
      uniform sampler2D portalTexture;
      uniform sampler2D maskTexture;
      uniform vec2 portalCenter;
      uniform float portalRadius;
      uniform float edgeSoftness;
      uniform float time;
      
      varying vec2 vUv;
      varying vec3 vPosition;
      varying vec3 vNormal;
      
      void main() {
        // Calculate distance from portal center
        vec2 center = portalCenter;
        float distance = length(vUv - center);
        
        // Create circular mask with soft edges
        float mask = 1.0 - smoothstep(portalRadius - edgeSoftness, portalRadius + edgeSoftness, distance);
        
        // Sample the portal texture
        vec4 portalColor = texture2D(portalTexture, vUv);
        
        // Add some distortion effect (optional)
        vec2 distortedUV = vUv + sin(vUv.y * 10.0 + time) * 0.01;
        vec4 distortedColor = texture2D(portalTexture, distortedUV);
        
        // Mix original and distorted
        vec4 finalColor = mix(portalColor, distortedColor, 0.3);
        
        // Apply the circular mask
        finalColor.a *= mask;
        
        gl_FragColor = finalColor;
      }
    `;

    // Create the shader material
    const material = new THREE.ShaderMaterial({
      vertexShader: vertexShader,
      fragmentShader: fragmentShader,
      uniforms: {
        portalTexture: { value: null },
        maskTexture: { value: null },
        portalCenter: { value: new THREE.Vector2(data.portalCenter.x, data.portalCenter.y) },
        portalRadius: { value: data.portalRadius },
        edgeSoftness: { value: data.edgeSoftness },
        time: { value: 0.0 },
      },
      transparent: true,
      side: THREE.DoubleSide,
    });

    // Load textures
    this.loadTextures(material);

    // Apply material to the entity
    el.setAttribute("material", "shader", "portal");

    // Wait for the mesh to be created
    el.addEventListener("model-loaded", () => {
      el.object3D.traverse((child) => {
        if (child.isMesh) {
          child.material = material;
        }
      });
    });

    // Also try to apply immediately
    setTimeout(() => {
      el.object3D.traverse((child) => {
        if (child.isMesh) {
          child.material = material;
        }
      });
    }, 100);

    // Animation loop
    this.tick = this.tick.bind(this);
  },

  loadTextures: function (material) {
    const loader = new THREE.TextureLoader();

    // Load portal texture
    const portalTexture = loader.load(this.data.portalTexture, (texture) => {
      material.uniforms.portalTexture.value = texture;
    });

    // Load mask texture if provided
    if (this.data.maskTexture) {
      const maskTexture = loader.load(this.data.maskTexture, (texture) => {
        material.uniforms.maskTexture.value = texture;
      });
    }
  },

  tick: function (time, timeDelta) {
    // Update time uniform for animation
    const material = this.el.object3D.children[0]?.material;
    if (material && material.uniforms) {
      material.uniforms.time.value = time * 0.001; // Convert to seconds
    }
  },
});

// Alternative: Simple Portal Effect using A-Frame's built-in shader system
AFRAME.registerComponent("simple-portal", {
  init: function () {
    const el = this.el;

    // Create a plane with portal effect
    el.setAttribute("geometry", "primitive", "plane");
    el.setAttribute("material", {
      shader: "flat",
      src: "#sky",
      transparent: true,
      opacity: 0.8,
    });

    // Add circular mask using CSS or custom shader
    this.addCircularMask();
  },

  addCircularMask: function () {
    // This would create a circular mask effect
    // Could use CSS clip-path or custom shader
    const style = document.createElement("style");
    style.textContent = `
      .portal-mask {
        clip-path: circle(50%);
        border-radius: 50%;
      }
    `;
    document.head.appendChild(style);
    this.el.classList.add("portal-mask");
  },
});
